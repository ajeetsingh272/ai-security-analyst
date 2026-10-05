package sentinelconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ArchiveWriter persists overflow events — the ones a RateLimiter declined
// to grant a token for — so AC3's "never discarded" is literally true.
// Replay from this archive is P1-09's job ("Replay tooling"), currently
// blocked on P1-08 (itself blocked on real OAuth credentials, P1-02); this
// is the write side only, same "build the seam now, the consumer of it
// later" sequencing P1-01's Publisher and P1-05's real producer already
// established.
type ArchiveWriter interface {
	Archive(ctx context.Context, tenantID, connectorRowID string, events []RawEvent) error
}

// S3ArchiveWriter writes overflow batches as one object per call to the
// `sentinel-archive` bucket (provisioned by P0-03's s3-init) — never
// per-event objects, for the same batching-matters reason P1-07's
// ClickHouse writer never does per-row inserts: a storage backend's own
// request overhead dominates at per-event granularity.
type S3ArchiveWriter struct {
	client *s3.Client
	bucket string
}

func NewS3ArchiveWriter(client *s3.Client, bucket string) *S3ArchiveWriter {
	return &S3ArchiveWriter{client: client, bucket: bucket}
}

// archiveObject is the on-disk shape of one archived overflow batch — kept
// deliberately simple (raw bytes, not re-parsed) so replay tooling later
// can feed these payloads straight back through Connector.Normalise
// without this writer needing to know anything about event structure.
type archiveObject struct {
	TenantID       string     `json:"tenant_id"`
	ConnectorRowID string     `json:"connector_row_id"`
	ArchivedAt     time.Time  `json:"archived_at"`
	Events         []RawEvent `json:"events"`
}

func (w *S3ArchiveWriter) Archive(ctx context.Context, tenantID, connectorRowID string, events []RawEvent) error {
	if len(events) == 0 {
		return nil
	}

	obj := archiveObject{TenantID: tenantID, ConnectorRowID: connectorRowID, ArchivedAt: time.Now().UTC(), Events: events}
	payload, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("sentinelconnector: marshalling archive object: %w", err)
	}

	// tenant_id/connector_row_id/timestamp prefix — the shape P1-09's
	// replay tooling will eventually list/filter by, matching how the rest
	// of this system keys storage by tenant first (ADR-0008).
	key := fmt.Sprintf("overflow/%s/%s/%s.json", tenantID, connectorRowID, obj.ArchivedAt.Format("20060102T150405.000000000Z"))

	_, err = w.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(w.bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(payload),
	})
	if err != nil {
		return fmt.Errorf("sentinelconnector: archiving %d overflow events to s3://%s/%s: %w", len(events), w.bucket, key, err)
	}
	return nil
}
