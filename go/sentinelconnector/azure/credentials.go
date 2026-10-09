package azure

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

// Credentials holds the Event Hub namespace's own SAS connection string
// — Microsoft's documented primitive for third-party consumers of a
// diagnostic-settings export (see docs/connectors/azure-entra-setup.md),
// scoped to a single Listen claim. Deliberately NOT an Entra app
// registration/OAuth token: that path exists too (RBAC-based,
// "Azure Event Hubs Data Receiver"), but it requires the customer to
// create an app registration for a connector that otherwise needs none
// at all, and Entra-ID integration specifically isn't something the
// local emulator this package's own integration tests run against can
// exercise — see connector.go's own doc comment.
type Credentials struct {
	ConnectionString string `json:"connectionString"`
	EventHubName     string `json:"eventHubName"`
	ConsumerGroup    string `json:"consumerGroup"`
}

var ErrNotConnected = errors.New("azure: tenant has no active azure connector")

type connectorRow struct {
	ID          string
	Credentials []byte
	DekID       string
}

type tenantDekRow struct {
	WrappedDek []byte
	KmsKeyID   string
}

// CredentialStore mirrors m365/google/aws's own CredentialStore exactly
// — same KMS_LOCAL_MASTER_KEY env var, same shared tenant_deks row.
type CredentialStore struct {
	pool *pgxpool.Pool
	kms  *localKMS
}

func NewCredentialStore(pool *pgxpool.Pool) (*CredentialStore, error) {
	raw := os.Getenv("KMS_LOCAL_MASTER_KEY")
	if raw == "" {
		return nil, errors.New("azure: KMS_LOCAL_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("azure: KMS_LOCAL_MASTER_KEY is not valid base64: %w", err)
	}
	kms, err := newLocalKMS(key)
	if err != nil {
		return nil, err
	}
	return &CredentialStore{pool: pool, kms: kms}, nil
}

func (s *CredentialStore) Load(ctx context.Context, tenantID string) (connectorRowID string, creds Credentials, err error) {
	type loadResult struct {
		conn connectorRow
		dek  tenantDekRow
		ok   bool
	}
	res, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (loadResult, error) {
		var conn connectorRow
		err := tx.QueryRow(ctx,
			`SELECT id, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = 'azure' AND status != 'revoked'`,
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
		return "", Credentials{}, fmt.Errorf("azure: loading credentials: %w", err)
	}
	if !res.ok {
		return "", Credentials{}, ErrNotConnected
	}

	plainDek, err := s.kms.unwrapDEK(res.dek.WrappedDek, res.dek.KmsKeyID)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("azure: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := decryptWithDEK(plainDek, res.conn.Credentials)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("azure: decrypting stored credentials: %w", err)
	}
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		return "", Credentials{}, fmt.Errorf("azure: parsing decrypted credentials: %w", err)
	}
	return res.conn.ID, creds, nil
}
