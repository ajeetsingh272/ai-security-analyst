package sentinelconnector

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ArchiveWriter persists overflow events — the ones a RateLimiter declined
// to grant a token for — so AC3's "never discarded" is literally true.
// Replay from this archive is P1-09's job ("Replay tooling"); this is the
// write side only, same "build the seam now, the consumer of it later"
// sequencing P1-01's Publisher and P1-05's real producer already
// established.
//
// Distinct from RawArchiveWriter below: this one only ever sees the
// events a RateLimiter declined (a small minority, hopefully), and a
// write failure here does not retroactively un-publish whatever was
// already granted. RawArchiveWriter archives EVERY fetched event,
// unconditionally, and a failure there must fail the whole cycle (P1-08
// AC5) — the two have different enough failure semantics that collapsing
// them into one interface would blur a distinction that matters.
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

// RawArchiveWriter persists EVERY raw payload a connector fetches, before
// normalisation ever runs (P1-08 AC1: "Raw payloads are written before
// normalisation, never after"). This is the recovery mechanism for a
// normalisation mapping bug: the original vendor payload survives
// regardless of what Normalise later does with it, so a bad mapping is
// fixed by correcting the code and replaying (P1-09), not by telling a
// tenant their data from that window is gone.
type RawArchiveWriter interface {
	ArchiveRaw(ctx context.Context, tenantID, connectorRowID string, archivedAt time.Time, events []RawEvent) error
}

// S3RawArchiveWriter writes one compressed, server-side-encrypted object
// per fetched batch, keyed by tenant_id then date (P1-08 AC2: "partitioned
// by tenant_id and date for efficient selective replay") — a replay job
// for one tenant's one week lists a handful of date prefixes, never scans
// the whole bucket.
type S3RawArchiveWriter struct {
	client *s3.Client
	bucket string
}

func NewS3RawArchiveWriter(client *s3.Client, bucket string) *S3RawArchiveWriter {
	return &S3RawArchiveWriter{client: client, bucket: bucket}
}

// RawArchiveObject mirrors archiveObject deliberately: both are "raw
// RawEvents plus who/when", and P1-09's replay tooling reads this same
// shape regardless of whether a given object came from the overflow path
// or this one.
type RawArchiveObject struct {
	TenantID       string     `json:"tenant_id"`
	ConnectorRowID string     `json:"connector_row_id"`
	ArchivedAt     time.Time  `json:"archived_at"`
	Events         []RawEvent `json:"events"`
}

func (w *S3RawArchiveWriter) ArchiveRaw(ctx context.Context, tenantID, connectorRowID string, archivedAt time.Time, events []RawEvent) error {
	if len(events) == 0 {
		return nil
	}

	obj := RawArchiveObject{TenantID: tenantID, ConnectorRowID: connectorRowID, ArchivedAt: archivedAt, Events: events}
	payload, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("sentinelconnector: marshalling raw archive object: %w", err)
	}

	// Compressed (P1-08 AC3's "compressed" half) — raw vendor payloads
	// (JSON/XML text, typically) compress well, and this archive is
	// write-once/read-rarely, so paying gzip's CPU cost at write time to
	// save storage (and transfer time on an eventual replay) is the right
	// trade for this access pattern.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(payload); err != nil {
		return fmt.Errorf("sentinelconnector: compressing raw archive object: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("sentinelconnector: finishing raw archive compression: %w", err)
	}

	// raw/{tenant}/{date}/{connector}/{time}.json.gz — date as its own
	// path segment (not folded into the filename) so a replay job can
	// target a date RANGE with a set of prefix list calls, one per day,
	// rather than listing the whole tenant prefix and filtering client-side.
	key := fmt.Sprintf("raw/%s/%s/%s/%s.json.gz",
		tenantID, archivedAt.Format("2006-01-02"), connectorRowID, archivedAt.Format("150405.000000000"))

	_, err = w.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(w.bucket),
		Key:    aws.String(key),
		// bytes.NewReader, not &buf directly: the SDK needs to SEEK the
		// body back to the start to compute the payload hash (and again on
		// any retry) — *bytes.Buffer doesn't implement io.Seeker, which
		// failed with "failed to seek body to start, request stream is not
		// seekable" against the real S3 (SeaweedFS) server the first time
		// this ran. bytes.Reader does implement it.
		Body: bytes.NewReader(buf.Bytes()),
		// P1-08 AC4: "server-side encrypted at rest." SSE-S3 (AES256), not
		// SSE-KMS — this archive has no per-tenant key-management
		// requirement of its own (unlike connectors.credentials in
		// Postgres, which IS envelope-encrypted with a per-tenant DEK); a
		// server-managed key is the correct, simplest choice here.
		ServerSideEncryption: types.ServerSideEncryptionAes256,
		ContentEncoding:      aws.String("gzip"),
	})
	if err != nil {
		return fmt.Errorf("sentinelconnector: archiving %d raw events to s3://%s/%s: %w", len(events), w.bucket, key, err)
	}
	return nil
}

// RawArchiveReader is the read side of RawArchiveWriter — P1-09's replay
// tooling (go/sentinelreplay) lists and reads archived raw batches back,
// scoped to one tenant and date range at a time, never another tenant's
// prefix (P1-09 AC1).
type RawArchiveReader interface {
	// ListObjectKeys returns every archived object's key for tenantID
	// whose date partition falls within [from, to] (inclusive, UTC
	// calendar days) — one ListObjectsV2 call per day in range, under
	// raw/{tenantID}/{date}/, never a scan of the whole bucket or another
	// tenant's prefix.
	ListObjectKeys(ctx context.Context, tenantID string, from, to time.Time) ([]string, error)
	// GetObject reads one archived object (by the key ListObjectKeys
	// returned) back into its original RawEvents.
	GetObject(ctx context.Context, key string) (RawArchiveObject, error)
}

// S3RawArchiveReader is S3RawArchiveWriter's read-side counterpart,
// against the same bucket and key scheme.
type S3RawArchiveReader struct {
	client *s3.Client
	bucket string
}

func NewS3RawArchiveReader(client *s3.Client, bucket string) *S3RawArchiveReader {
	return &S3RawArchiveReader{client: client, bucket: bucket}
}

func (r *S3RawArchiveReader) ListObjectKeys(ctx context.Context, tenantID string, from, to time.Time) ([]string, error) {
	var keys []string
	// One prefix list per calendar day in [from, to] — matching exactly
	// how S3RawArchiveWriter partitions keys, so a multi-day replay never
	// has to list the tenant's ENTIRE history to find the days it wants.
	for d := from.Truncate(24 * time.Hour); !d.After(to); d = d.Add(24 * time.Hour) {
		prefix := fmt.Sprintf("raw/%s/%s/", tenantID, d.Format("2006-01-02"))
		var continuationToken *string
		for {
			out, err := r.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
				Bucket:            aws.String(r.bucket),
				Prefix:            aws.String(prefix),
				ContinuationToken: continuationToken,
			})
			if err != nil {
				return nil, fmt.Errorf("sentinelconnector: listing %s: %w", prefix, err)
			}
			for _, obj := range out.Contents {
				keys = append(keys, aws.ToString(obj.Key))
			}
			if out.IsTruncated == nil || !*out.IsTruncated {
				break
			}
			continuationToken = out.NextContinuationToken
		}
	}
	return keys, nil
}

func (r *S3RawArchiveReader) GetObject(ctx context.Context, key string) (RawArchiveObject, error) {
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(key)})
	if err != nil {
		return RawArchiveObject{}, fmt.Errorf("sentinelconnector: fetching s3://%s/%s: %w", r.bucket, key, err)
	}
	defer out.Body.Close()

	gz, err := gzip.NewReader(out.Body)
	if err != nil {
		return RawArchiveObject{}, fmt.Errorf("sentinelconnector: decompressing s3://%s/%s: %w", r.bucket, key, err)
	}
	defer gz.Close()

	raw, err := io.ReadAll(gz)
	if err != nil {
		return RawArchiveObject{}, fmt.Errorf("sentinelconnector: reading s3://%s/%s: %w", r.bucket, key, err)
	}

	var obj RawArchiveObject
	if err := json.Unmarshal(raw, &obj); err != nil {
		return RawArchiveObject{}, fmt.Errorf("sentinelconnector: unmarshalling s3://%s/%s: %w", r.bucket, key, err)
	}
	return obj, nil
}
