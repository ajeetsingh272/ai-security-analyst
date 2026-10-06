//go:build integration

package m365

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

// This is the first thing in Go to decrypt something TS encrypted against
// REAL Postgres, through real RLS (envelope_test.go already proved the raw
// bytes decrypt correctly against a Node-produced fixture; this proves the
// whole path — reading connectors/tenant_deks through
// sentineldb.WithTenantContext, unwrapping, decrypting, and the reverse for
// Save — works against a live database). Mirrors
// packages/db/src/__tests__/tenant-credential-vault.integration.test.ts.
//
// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./go/sentinelconnector/m365/...
const testMasterKeyBase64 = "TUFTVEVSX0tFWV8zMl9CWVRFU19GT1JfRklYVFVSRSE=" // same 32-byte fixture key as envelope_test.go

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

// seedTenantDEK writes a wrapped DEK directly (test-only AES-GCM wrap using
// this package's own internal helpers) — simulating what P1-02's TS vault
// does on a tenant's first OAuth connect, without needing to invoke TS
// itself for a Go-side integration test.
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

func seedM365Connector(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, status string, encryptedCreds []byte) string {
	t.Helper()
	id, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id) VALUES ($1, 'm365', $2, $3, $4) RETURNING id`,
			tenantID, status, encryptedCreds, localKMSKeyID,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("seeding connectors row: %v", err)
	}
	return id
}

func TestCredentialStore_LoadAndSave_AgainstRealPostgres(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)

	os.Setenv("KMS_LOCAL_MASTER_KEY", testMasterKeyBase64)
	t.Cleanup(func() { os.Unsetenv("KMS_LOCAL_MASTER_KEY") })

	tenantID, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO tenants (name, plan) VALUES ('P1-03 go credential store probe', 'trial') RETURNING id`).Scan(&id)
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

	masterKey, err := base64.StdEncoding.DecodeString(testMasterKeyBase64)
	if err != nil {
		t.Fatalf("decoding master key: %v", err)
	}
	dek := make([]byte, dekBytes)
	for i := range dek {
		dek[i] = byte(i + 1)
	}
	seedTenantDEK(t, ctx, pool, tenantID, masterKey, dek)

	original := Credentials{AccessToken: "access-1", RefreshToken: "refresh-1", ExpiresAt: 1999999999, Scope: "https://manage.office.com/ActivityFeed.Read"}
	plaintext := mustJSON(t, original)
	encrypted, err := encryptWithDEK(dek, plaintext, randomIV)
	if err != nil {
		t.Fatalf("encrypting seed credentials: %v", err)
	}
	connectorRowID := seedM365Connector(t, ctx, pool, tenantID, "healthy", encrypted)

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

	refreshed := Credentials{AccessToken: "access-2", RefreshToken: "refresh-2", ExpiresAt: 2999999999, Scope: original.Scope}
	if err := store.Save(ctx, tenantID, connectorRowID, refreshed); err != nil {
		t.Fatalf("Save: %v", err)
	}

	store2, err := NewCredentialStore(pool) // a fresh instance — proves persistence, not an in-memory cache
	if err != nil {
		t.Fatalf("NewCredentialStore (second instance): %v", err)
	}
	_, gotAfterSave, err := store2.Load(ctx, tenantID)
	if err != nil {
		t.Fatalf("Load after Save: %v", err)
	}
	if gotAfterSave != refreshed {
		t.Fatalf("credentials after Save mismatch: got %+v want %+v", gotAfterSave, refreshed)
	}
}

func TestCredentialStore_Load_RevokedConnectorReturnsErrNotConnected(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	os.Setenv("KMS_LOCAL_MASTER_KEY", testMasterKeyBase64)
	t.Cleanup(func() { os.Unsetenv("KMS_LOCAL_MASTER_KEY") })

	tenantID, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO tenants (name, plan) VALUES ('P1-03 go revoked probe', 'trial') RETURNING id`).Scan(&id)
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
	seedM365Connector(t, ctx, pool, tenantID, "revoked", nil)

	store, err := NewCredentialStore(pool)
	if err != nil {
		t.Fatalf("NewCredentialStore: %v", err)
	}
	if _, _, err := store.Load(ctx, tenantID); err != ErrNotConnected {
		t.Fatalf("expected ErrNotConnected for a revoked connector, got %v", err)
	}
}

func TestCredentialStore_Load_NoConnectorAtAllReturnsErrNotConnected(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	os.Setenv("KMS_LOCAL_MASTER_KEY", testMasterKeyBase64)
	t.Cleanup(func() { os.Unsetenv("KMS_LOCAL_MASTER_KEY") })

	tenantID, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO tenants (name, plan) VALUES ('P1-03 go never-connected probe', 'trial') RETURNING id`).Scan(&id)
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

	store, err := NewCredentialStore(pool)
	if err != nil {
		t.Fatalf("NewCredentialStore: %v", err)
	}
	if _, _, err := store.Load(ctx, tenantID); err != ErrNotConnected {
		t.Fatalf("expected ErrNotConnected for a tenant with no m365 connector row, got %v", err)
	}
}

func mustJSON(t *testing.T, v Credentials) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	return b
}
