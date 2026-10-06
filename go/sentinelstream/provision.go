package sentinelstream

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Provisioner creates every topic in MainTopics (plus each one's DLQ)
// declaratively — P1-05 AC1, "topics are created declaratively and are
// idempotent to re-apply."
type Provisioner struct {
	admin *kadm.Client
	// ReplicationFactor defaults to 1 — correct for the single-broker dev
	// Redpanda (infra/docker/docker-compose.dev.yml runs one node), and
	// deliberately NOT hardcoded so a production deployment with a real
	// cluster can set it higher without touching this package.
	ReplicationFactor int16
}

func NewProvisioner(client *kgo.Client) *Provisioner {
	return &Provisioner{admin: kadm.NewClient(client), ReplicationFactor: 1}
}

// Apply creates every main topic and its DLQ. Re-running it is a no-op for
// anything that already exists — TOPIC_ALREADY_EXISTS from a prior Apply is
// swallowed, not treated as a failure; that is the entire meaning of
// "idempotent to re-apply" (T1). A genuinely different error (the broker
// unreachable, a permissions problem) is still returned.
func (p *Provisioner) Apply(ctx context.Context) error {
	for _, spec := range MainTopics {
		if err := p.applyOne(ctx, spec.Name, spec.Partitions, spec.Retention); err != nil {
			return fmt.Errorf("sentinelstream: provisioning %s: %w", spec.Name, err)
		}
		if err := p.applyOne(ctx, spec.DLQ, dlqPartitions, dlqRetention); err != nil {
			return fmt.Errorf("sentinelstream: provisioning %s: %w", spec.DLQ, err)
		}
	}
	return nil
}

func (p *Provisioner) applyOne(ctx context.Context, name string, partitions int32, retention time.Duration) error {
	retentionMs := strconv.FormatInt(retention.Milliseconds(), 10)
	configs := map[string]*string{"retention.ms": &retentionMs}

	resp, err := p.admin.CreateTopics(ctx, partitions, p.ReplicationFactor, configs, name)
	if err != nil {
		return err
	}
	result, ok := resp[name]
	if !ok {
		return fmt.Errorf("no response for topic %q", name)
	}
	if result.Err != nil && !kerrIsTopicExists(result.Err) {
		return result.Err
	}
	return nil
}

func kerrIsTopicExists(err error) bool {
	var ke *kerr.Error
	if e, ok := err.(*kerr.Error); ok {
		ke = e
	}
	return ke != nil && ke.Code == kerr.TopicAlreadyExists.Code
}
