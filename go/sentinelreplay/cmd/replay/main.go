// Command replay is P1-09's operator-facing entrypoint: re-run one
// tenant's archived raw events (P1-08) through normalisation and publish
// them to a separate output topic.
//
// No real per-vendor Connector exists yet (P1-02/P1-03 are blocked on
// real M365 OAuth credentials), so -connector only offers "echo" today —
// a pass-through that preserves the archived raw payload verbatim as
// OCSF RawData with a deterministic event_id derived from its own
// content. A real connector's Normalise would extract the vendor's own
// event ID/timestamp instead; registering one here (connectorRegistry
// below) is the only change a future ticket needs to make to reuse this
// tool, not a rewrite of it.
//
// Usage:
//
//	go run ./cmd/replay -job=fix-2026-01-mapping-bug -tenant=<uuid> \
//	  -from=2026-01-01 -to=2026-01-07 -output-topic=events.raw.replay
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelreplay"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

// connectorRegistry maps a -connector flag value to the Connector whose
// Normalise should run during replay. Adding a real one (P1-03's M365
// connector, once it exists) is a one-line addition here — the rest of
// this tool is already generic over sentinelconnector.Connector.
var connectorRegistry = map[string]sentinelconnector.Connector{
	"echo": echoConnector{},
}

func main() {
	jobID := flag.String("job", "", "replay job id — reusing the same id resumes an interrupted run")
	tenantID := flag.String("tenant", "", "tenant UUID to replay (never touches another tenant's archive)")
	fromStr := flag.String("from", "", "replay window start, YYYY-MM-DD (UTC, inclusive)")
	toStr := flag.String("to", "", "replay window end, YYYY-MM-DD (UTC, inclusive)")
	connectorName := flag.String("connector", "echo", "which Connector's Normalise to replay through — see connectorRegistry")
	outputTopic := flag.String("output-topic", "events.raw.replay", "AC3: a separate topic so production state is not disturbed")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if *jobID == "" || *tenantID == "" || *fromStr == "" || *toStr == "" {
		log.Error("usage: -job, -tenant, -from and -to are all required")
		os.Exit(2)
	}
	connector, ok := connectorRegistry[*connectorName]
	if !ok {
		log.Error("unknown connector", "connector", *connectorName)
		os.Exit(2)
	}
	from, err := time.Parse("2006-01-02", *fromStr)
	if err != nil {
		log.Error("parsing -from", "err", err)
		os.Exit(2)
	}
	to, err := time.Parse("2006-01-02", *toStr)
	if err != nil {
		log.Error("parsing -to", "err", err)
		os.Exit(2)
	}

	ctx := context.Background()

	s3Client := s3.New(s3.Options{
		Region:       envOr("S3_REGION", "ap-south-1"),
		Credentials:  credentials.NewStaticCredentialsProvider(envOr("S3_ACCESS_KEY", "sentineldev"), envOr("S3_SECRET_KEY", "sentineldev"), ""),
		BaseEndpoint: aws.String(envOr("S3_ENDPOINT", "http://localhost:8333")),
		UsePathStyle: true,
	})
	bucket := envOr("S3_ARCHIVE_BUCKET", "sentinel-archive")
	reader := sentinelconnector.NewS3RawArchiveReader(s3Client, bucket)
	checkpoints := sentinelreplay.NewS3CheckpointStore(s3Client, bucket)

	kafkaClient, err := kgo.NewClient(kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")))
	if err != nil {
		log.Error("creating kafka client", "err", err)
		os.Exit(1)
	}
	defer kafkaClient.Close()
	// Provisioning MainTopics (P1-05's fixed list) does NOT create
	// -output-topic — that flag is deliberately an arbitrary, often
	// per-job name (AC3), never one of the pre-provisioned main topics.
	// Found the direct way: a real run against a freshly named topic
	// failed with UNKNOWN_TOPIC_OR_PARTITION until this was added.
	admin := kadm.NewClient(kafkaClient)
	if _, err := admin.CreateTopic(ctx, 4, 1, nil, *outputTopic); err != nil && !errors.Is(err, kerr.TopicAlreadyExists) {
		log.Error("provisioning output topic", "topic", *outputTopic, "err", err)
		os.Exit(1)
	}
	publisher := sentinelstream.NewRedpandaPublisher(kafkaClient, *outputTopic)

	replayer := sentinelreplay.NewReplayer(reader, publisher, checkpoints, log)

	log.Info("replay starting", "job_id", *jobID, "tenant_id", *tenantID, "from", *fromStr, "to", *toStr,
		"connector", *connectorName, "output_topic", *outputTopic)
	progress, err := replayer.Replay(ctx, *jobID, *tenantID, from, to, connector)
	if err != nil {
		log.Error("replay stopped", "err", err, "processed_objects", progress.ProcessedObjects, "total_objects", progress.TotalObjects)
		os.Exit(1)
	}
	log.Info("replay finished", "processed_objects", progress.ProcessedObjects, "total_objects", progress.TotalObjects, "total_events", progress.TotalEvents)
}

// echoConnector's ID()/Fetch() are never called by replay (Replayer only
// calls Normalise) — HealthCheck/Fetch exist only to satisfy the
// Connector interface.
type echoConnector struct{}

func (echoConnector) ID() sentinelconnector.ConnectorID { return "echo" }

func (echoConnector) Fetch(context.Context, sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	return sentinelconnector.Batch{}, nil, fmt.Errorf("echoConnector: Fetch is not used by replay")
}

// Normalise preserves the raw payload verbatim, with a deterministic
// event_id derived from a hash of the payload itself (not time.Now(), not
// anything that varies between replay attempts) — this determinism is
// exactly what AC2's idempotency property depends on; see Replayer's own
// doc comment for why.
func (echoConnector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	sum := sha256.Sum256(raw.Payload)
	return []ocsf.Event{{
		TenantID: raw.TenantID,
		// FetchedAt, not time.Now(): the archived event's own original
		// fetch time, so a replay of the same archived data produces the
		// same TimeUnixMillis every time it runs.
		TimeUnixMillis: raw.FetchedAt * 1000,
		Metadata:       map[string]string{"event_id": "echo-" + hex.EncodeToString(sum[:])},
		RawData:        raw.Payload,
	}}, nil
}

func (echoConnector) HealthCheck(context.Context) error { return nil }

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
