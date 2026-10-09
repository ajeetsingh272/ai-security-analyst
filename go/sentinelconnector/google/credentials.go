package google

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

// Credentials is the exact JSON shape apps/api/src/routes/google-connector.ts's
// callback route encrypts into connectors.credentials — same field
// names/casing m365's own Credentials type uses, since both connectors
// share the identical cross-language wire contract (packages/db/src/crypto's
// TenantCredentialVault doesn't know or care which connector kind it's
// encrypting for).
type Credentials struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"expiresAt"` // absolute Unix seconds
	Scope        string `json:"scope"`
}

// ErrNotConnected is returned by CredentialStore.Load when a tenant has no
// google_workspace connector row at all, or its status is 'revoked'.
var ErrNotConnected = errors.New("google: tenant has no active google_workspace connector")

type connectorRow struct {
	ID          string
	Credentials []byte
	DekID       string
}

type tenantDekRow struct {
	WrappedDek []byte
	KmsKeyID   string
}

// CredentialStore mirrors m365.CredentialStore exactly — same
// sentineldb.WithTenantContext RLS-enforcing path, same KMS_LOCAL_MASTER_KEY
// env var and wrapped-DEK format (a tenant's m365 and google_workspace
// credentials share the same tenant_deks row, keyed only by tenant, not by
// connector kind — see packages/db/src/crypto/tenant-credential-vault.ts's
// getOrCreateDEK).
type CredentialStore struct {
	pool *pgxpool.Pool
	kms  *localKMS
}

func NewCredentialStore(pool *pgxpool.Pool) (*CredentialStore, error) {
	raw := os.Getenv("KMS_LOCAL_MASTER_KEY")
	if raw == "" {
		return nil, errors.New("google: KMS_LOCAL_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("google: KMS_LOCAL_MASTER_KEY is not valid base64: %w", err)
	}
	kms, err := newLocalKMS(key)
	if err != nil {
		return nil, err
	}
	return &CredentialStore{pool: pool, kms: kms}, nil
}

// Load returns the connector row id and decrypted credentials for tenantID's
// google_workspace connector. Returns ErrNotConnected if there is none, or
// its status is 'revoked'.
func (s *CredentialStore) Load(ctx context.Context, tenantID string) (connectorRowID string, creds Credentials, err error) {
	type loadResult struct {
		conn connectorRow
		dek  tenantDekRow
		ok   bool
	}
	res, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (loadResult, error) {
		var conn connectorRow
		err := tx.QueryRow(ctx,
			`SELECT id, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = 'google_workspace' AND status != 'revoked'`,
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
		return "", Credentials{}, fmt.Errorf("google: loading credentials: %w", err)
	}
	if !res.ok {
		return "", Credentials{}, ErrNotConnected
	}

	plainDek, err := s.kms.unwrapDEK(res.dek.WrappedDek, res.dek.KmsKeyID)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("google: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := decryptWithDEK(plainDek, res.conn.Credentials)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("google: decrypting stored credentials: %w", err)
	}
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		return "", Credentials{}, fmt.Errorf("google: parsing decrypted credentials: %w", err)
	}
	return res.conn.ID, creds, nil
}

// Save re-encrypts creds with the tenant's existing DEK and writes it back
// to connectors.credentials — called after a successful token refresh.
func (s *CredentialStore) Save(ctx context.Context, tenantID, connectorRowID string, creds Credentials) error {
	var dek tenantDekRow
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx,
			`SELECT wrapped_dek, kms_key_id FROM tenant_deks WHERE tenant_id = $1`,
			tenantID,
		).Scan(&dek.WrappedDek, &dek.KmsKeyID)
	})
	if err != nil {
		return fmt.Errorf("google: reading tenant DEK before save: %w", err)
	}

	plainDek, err := s.kms.unwrapDEK(dek.WrappedDek, dek.KmsKeyID)
	if err != nil {
		return fmt.Errorf("google: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := json.Marshal(creds)
	if err != nil {
		return fmt.Errorf("google: marshalling credentials: %w", err)
	}
	encrypted, err := encryptWithDEK(plainDek, plaintext, randomIV)
	if err != nil {
		return fmt.Errorf("google: encrypting refreshed credentials: %w", err)
	}

	_, err = sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`UPDATE connectors SET credentials = $1 WHERE id = $2 AND tenant_id = $3`,
			encrypted, connectorRowID, tenantID,
		)
		return struct{}{}, execErr
	})
	if err != nil {
		return fmt.Errorf("google: saving refreshed credentials: %w", err)
	}
	return nil
}
