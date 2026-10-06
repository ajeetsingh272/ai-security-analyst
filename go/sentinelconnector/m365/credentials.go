package m365

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Credentials is the exact JSON shape P1-02's callback route
// (apps/api/src/routes/m365-connector.ts) encrypts into connectors.credentials.
// Field names/casing must match that TS object literal verbatim — this is
// cross-language wire compatibility, not a type this package is free to
// redesign.
type Credentials struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"expiresAt"` // absolute Unix seconds
	Scope        string `json:"scope"`
}

// ErrNotConnected is returned by CredentialStore.Load when a tenant has no
// m365 connector row at all, or its status is 'revoked' — both mean "there
// is nothing to authenticate with," which the connector maps to
// sentinelconnector.ErrConsentRevoked rather than treating as a transient
// fetch failure.
var ErrNotConnected = errors.New("m365: tenant has no active m365 connector")

type connectorRow struct {
	ID          string
	Credentials []byte
	DekID       string
}

type tenantDekRow struct {
	WrappedDek []byte
	KmsKeyID   string
}

// CredentialStore reads and re-writes a tenant's M365 OAuth credentials
// through sentineldb.WithTenantContext — the same RLS-enforcing path every
// other tenant-scoped Go query in this system uses (ADR-0008). This is the
// first thing in the Go half of this codebase to decrypt something TS
// encrypted (P1-02); see envelope.go/kms.go for the byte-for-byte mirrored
// format that makes that possible.
type CredentialStore struct {
	pool *pgxpool.Pool
	kms  *localKMS
}

// NewCredentialStore reads KMS_LOCAL_MASTER_KEY from the environment —
// the exact same variable packages/db/src/crypto/kms.ts's LocalKMS reads,
// because it must unwrap the exact same wrapped DEKs that env var's value
// already wrapped in TS. There is no separate Go-side master key.
func NewCredentialStore(pool *pgxpool.Pool) (*CredentialStore, error) {
	raw := os.Getenv("KMS_LOCAL_MASTER_KEY")
	if raw == "" {
		return nil, errors.New("m365: KMS_LOCAL_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("m365: KMS_LOCAL_MASTER_KEY is not valid base64: %w", err)
	}
	kms, err := newLocalKMS(key)
	if err != nil {
		return nil, err
	}
	return &CredentialStore{pool: pool, kms: kms}, nil
}

// Load returns the connector row id and decrypted credentials for tenantID's
// m365 connector. Returns ErrNotConnected if there is none, or its status
// is 'revoked'.
func (s *CredentialStore) Load(ctx context.Context, tenantID string) (connectorRowID string, creds Credentials, err error) {
	type loadResult struct {
		conn connectorRow
		dek  tenantDekRow
		ok   bool
	}
	res, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (loadResult, error) {
		var conn connectorRow
		err := tx.QueryRow(ctx,
			`SELECT id, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = 'm365' AND status != 'revoked'`,
			tenantID,
		).Scan(&conn.ID, &conn.Credentials, &conn.DekID)
		if errors.Is(err, pgx.ErrNoRows) {
			return loadResult{}, nil
		}
		if err != nil {
			return loadResult{}, err
		}
		if conn.Credentials == nil {
			return loadResult{}, nil
		}

		var dek tenantDekRow
		err = tx.QueryRow(ctx,
			`SELECT wrapped_dek, kms_key_id FROM tenant_deks WHERE tenant_id = $1`,
			tenantID,
		).Scan(&dek.WrappedDek, &dek.KmsKeyID)
		if err != nil {
			return loadResult{}, fmt.Errorf("reading tenant_deks: %w", err)
		}
		return loadResult{conn: conn, dek: dek, ok: true}, nil
	})
	if err != nil {
		return "", Credentials{}, fmt.Errorf("m365: loading credentials: %w", err)
	}
	if !res.ok {
		return "", Credentials{}, ErrNotConnected
	}

	plainDek, err := s.kms.unwrapDEK(res.dek.WrappedDek, res.dek.KmsKeyID)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("m365: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := decryptWithDEK(plainDek, res.conn.Credentials)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("m365: decrypting stored credentials: %w", err)
	}
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		return "", Credentials{}, fmt.Errorf("m365: parsing decrypted credentials: %w", err)
	}
	return res.conn.ID, creds, nil
}

// Save re-encrypts creds with the tenant's existing DEK (never a new one —
// see envelope.go's doc comment) and writes it back to connectors.credentials.
// Called after a successful token refresh (tokenprovider.go) so the NEXT
// cycle, possibly after a restart, resumes with the refreshed token rather
// than the one that is about to expire.
func (s *CredentialStore) Save(ctx context.Context, tenantID, connectorRowID string, creds Credentials) error {
	var dek tenantDekRow
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx,
			`SELECT wrapped_dek, kms_key_id FROM tenant_deks WHERE tenant_id = $1`,
			tenantID,
		).Scan(&dek.WrappedDek, &dek.KmsKeyID)
	})
	if err != nil {
		return fmt.Errorf("m365: reading tenant DEK before save: %w", err)
	}

	plainDek, err := s.kms.unwrapDEK(dek.WrappedDek, dek.KmsKeyID)
	if err != nil {
		return fmt.Errorf("m365: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := json.Marshal(creds)
	if err != nil {
		return fmt.Errorf("m365: marshalling credentials: %w", err)
	}
	encrypted, err := encryptWithDEK(plainDek, plaintext, randomIV)
	if err != nil {
		return fmt.Errorf("m365: encrypting refreshed credentials: %w", err)
	}

	_, err = sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`UPDATE connectors SET credentials = $1 WHERE id = $2 AND tenant_id = $3`,
			encrypted, connectorRowID, tenantID,
		)
		return struct{}{}, execErr
	})
	if err != nil {
		return fmt.Errorf("m365: saving refreshed credentials: %w", err)
	}
	return nil
}
