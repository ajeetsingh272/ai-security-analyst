//go:build integration

package azure

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mirrors go/sentinelconnector/m365, .../google and .../aws's own
// credentials_integration_test.go — same CredentialStore machinery,
// proven here for kind = 'azure'.
//
// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./go/sentinelconnector/azure/...
const testMasterKeyBase64 = "TUFTVEVSX0tFWV8zMl9CWVRFU19GT1JfRklYVFVSRSE=" // same 32-byte fixture key as m365/google/aws's own

func withIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := sentineldb.NewPool(ctx)
	if err != nil {
		t.Fatalf("opening pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("Postgres not reachable (pnpm dev:stack running?): %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func asAdmin[T any](ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE sentinel_app"); err != nil {
		return zero, err
	}
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

func seedTenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
	t.Helper()
	tenantID, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, name).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("creating tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = asAdmin(ctx, pool, func(tx pgx.Tx) (struct{}, error) {
			_, err := tx.Exec(ctx, "DELETE FROM tenants WHERE id = $1", tenantID)
			return struct{}{}, err
		})
	})
	return tenantID
}

func seedTenantDEK(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string, masterKey, dek []byte) {
	t.Helper()
	iv, err := randomIV()
	if err != nil {
		t.Fatalf("generating IV: %v", err)
	}
	ciphertext, tag, err := aesGCMSeal(masterKey, iv, dek)
	if err != nil {
		t.Fatalf("wrapping test DEK: %v", err)
	}
	wrapped := append(append(append([]byte{}, iv...), tag...), ciphertext...)

	_, err = sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`INSERT INTO tenant_deks (tenant_id, wrapped_dek, kms_key_id) VALUES ($1, $2, $3)`,
			tenantID, wrapped, localKMSKeyID,
		)
		return struct{}{}, execErr
	})
	if err != nil {
		t.Fatalf("seeding tenant_deks: %v", err)
	}
}

func seedAzureConnector(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, status string, encryptedCreds []byte) string {
	t.Helper()
	id, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id) VALUES ($1, 'azure', $2, $3, $4) RETURNING id`,
			tenantID, status, encryptedCreds, localKMSKeyID,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("seeding connectors row: %v", err)
	}
	return id
}

func TestCredentialStore_Load_AgainstRealPostgres(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)

	os.Setenv("KMS_LOCAL_MASTER_KEY", testMasterKeyBase64)
	t.Cleanup(func() { os.Unsetenv("KMS_LOCAL_MASTER_KEY") })

	tenantID := seedTenant(t, ctx, pool, "P7-03 go credential store probe")

	masterKey, err := base64.StdEncoding.DecodeString(testMasterKeyBase64)
	if err != nil {
		t.Fatalf("decoding master key: %v", err)
	}
	dek := make([]byte, dekBytes)
	for i := range dek {
		dek[i] = byte(i + 1)
	}
	seedTenantDEK(t, ctx, pool, tenantID, masterKey, dek)

	original := Credentials{ConnectionString: emulatorConnectionString, EventHubName: "entra-diagnostics", ConsumerGroup: ""}
	plaintext, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshalling seed credentials: %v", err)
	}
	encrypted, err := encryptWithDEK(dek, plaintext, randomIV)
	if err != nil {
		t.Fatalf("encrypting seed credentials: %v", err)
	}
	connectorRowID := seedAzureConnector(t, ctx, pool, tenantID, "healthy", encrypted)

	store, err := NewCredentialStore(pool)
	if err != nil {
		t.Fatalf("NewCredentialStore: %v", err)
	}

	gotRowID, gotCreds, err := store.Load(ctx, tenantID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if gotRowID != connectorRowID {
		t.Fatalf("connector row id mismatch: got %q want %q", gotRowID, connectorRowID)
	}
	if gotCreds != original {
		t.Fatalf("loaded credentials mismatch: got %+v want %+v", gotCreds, original)
	}
}

func TestCredentialStore_Load_RevokedConnectorReturnsErrNotConnected(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	os.Setenv("KMS_LOCAL_MASTER_KEY", testMasterKeyBase64)
	t.Cleanup(func() { os.Unsetenv("KMS_LOCAL_MASTER_KEY") })

	tenantID := seedTenant(t, ctx, pool, "P7-03 go revoked probe")
	seedAzureConnector(t, ctx, pool, tenantID, "revoked", nil)

	store, err := NewCredentialStore(pool)
	if err != nil {
		t.Fatalf("NewCredentialStore: %v", err)
	}
	if _, _, err := store.Load(ctx, tenantID); err != ErrNotConnected {
		t.Fatalf("expected ErrNotConnected for a revoked connector, got %v", err)
	}
}
