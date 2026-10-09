package aws

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

// Credentials is this connector's version of m365.Credentials/google.Credentials
// — but holds no secret at all, deliberately: cross-account role
// assumption (AC1) means Sentinel only ever stores a role ARN, the
// external id its own IAM trust policy must match, and the region to
// call SQS in. Every ACTUAL credential (a temporary session key/token) is
// obtained from AWS's own STS AssumeRole call at use time and is never
// persisted — a stronger security posture than a long-lived static
// access key, which this connector never asks the customer for at all.
type Credentials struct {
	RoleArn    string `json:"roleArn"`
	ExternalID string `json:"externalId"`
	Region     string `json:"region"`
	// QueueURL is the customer's own SQS queue (the one their EventBridge
	// rule target delivers CloudTrail events into) — unlike M365/Google,
	// where the vendor API's own base URL is always the same for every
	// tenant, each AWS tenant's queue is a distinct resource in THEIR
	// account, so its URL has to be supplied and stored per tenant, same
	// as RoleArn.
	QueueURL string `json:"queueUrl"`
}

var ErrNotConnected = errors.New("aws: tenant has no active aws connector")

type connectorRow struct {
	ID          string
	Credentials []byte
	DekID       string
}

type tenantDekRow struct {
	WrappedDek []byte
	KmsKeyID   string
}

// CredentialStore mirrors m365.CredentialStore/google.CredentialStore
// exactly — same KMS_LOCAL_MASTER_KEY env var, same tenant_deks row
// (shared across every connector kind for one tenant, keyed only by
// tenant). Save has no counterpart here (unlike M365/Google, which
// re-encrypt a refreshed OAuth token): AC1's role ARN/external id never
// change on their own, only on an explicit reconnect, which the HTTP
// route handles the same way as a first connect (an upsert), not a
// background refresh this package would need to perform.
type CredentialStore struct {
	pool *pgxpool.Pool
	kms  *localKMS
}

func NewCredentialStore(pool *pgxpool.Pool) (*CredentialStore, error) {
	raw := os.Getenv("KMS_LOCAL_MASTER_KEY")
	if raw == "" {
		return nil, errors.New("aws: KMS_LOCAL_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("aws: KMS_LOCAL_MASTER_KEY is not valid base64: %w", err)
	}
	kms, err := newLocalKMS(key)
	if err != nil {
		return nil, err
	}
	return &CredentialStore{pool: pool, kms: kms}, nil
}

// Load returns the connector row id and decrypted credentials for
// tenantID's aws connector. Returns ErrNotConnected if there is none, or
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
			`SELECT id, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = 'aws' AND status != 'revoked'`,
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
		return "", Credentials{}, fmt.Errorf("aws: loading credentials: %w", err)
	}
	if !res.ok {
		return "", Credentials{}, ErrNotConnected
	}

	plainDek, err := s.kms.unwrapDEK(res.dek.WrappedDek, res.dek.KmsKeyID)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("aws: unwrapping tenant DEK: %w", err)
	}
	plaintext, err := decryptWithDEK(plainDek, res.conn.Credentials)
	if err != nil {
		return "", Credentials{}, fmt.Errorf("aws: decrypting stored credentials: %w", err)
	}
	if err := json.Unmarshal(plaintext, &creds); err != nil {
		return "", Credentials{}, fmt.Errorf("aws: parsing decrypted credentials: %w", err)
	}
	return res.conn.ID, creds, nil
}
