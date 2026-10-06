// Package sentinelreplay is P1-09: re-run archived raw events (P1-08's
// RawArchiveWriter output) through normalisation and publish them to a
// separate output topic, scoped to one tenant and time range, resumable
// after an interruption. This is how a normalisation mapping bug gets
// fixed after the fact — correct the Connector.Normalise code, then
// replay the affected window — and it is the engine behind the planned
// free 7-day security scan (P6-05), neither of which exist yet; this
// package is the mechanism both will eventually call.
package sentinelreplay

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// Progress is reported periodically during a replay (AC4: "progress is
// reported") and returned at the end.
type Progress struct {
	TotalObjects     int
	ProcessedObjects int
	TotalEvents      int64
}

// CheckpointStore persists which archived object keys a replay job has
// already processed, so Replay can resume after an interruption (AC4:
// "the job is resumable after interruption") without re-publishing
// anything it already published. Load must return an empty, non-nil map
// (never an error) for a job that has never run — "no checkpoint yet" is
// the normal starting state, not a failure.
type CheckpointStore interface {
	Load(ctx context.Context, jobID string) (map[string]bool, error)
	Save(ctx context.Context, jobID string, done map[string]bool) error
}

// Replayer re-runs archived raw events through a Connector's own
// Normalise and publishes the result to a separate output topic (AC3:
// "replay can target a separate output topic so production state is not
// disturbed") — the caller constructs `publisher` pointed at whatever
// topic that should be (e.g. a per-job replay topic), never assumed by
// this package.
//
// Idempotency (AC2: "re-running produces no observable duplication") is
// NOT enforced here — it falls out of Connector.Normalise being
// deterministic given the same RawEvent (the same contract ADR-0010
// already requires of Fetch), which means a real connector's Normalise
// must derive both the event's own ID and timestamp from the vendor
// payload itself, never from time.Now() or anything else that varies
// between replay attempts. Downstream ClickHouse's ReplacingMergeTree
// then collapses re-published duplicates by (tenant_id, time, event_id)
// on merge, same mechanism normal at-least-once ingest already relies on
// (ADR-0010) — replay doesn't need a SEPARATE idempotency mechanism, it
// needs Normalise to uphold the one that already exists.
type Replayer struct {
	reader      sentinelconnector.RawArchiveReader
	publisher   sentinelconnector.Publisher
	checkpoints CheckpointStore
	log         *slog.Logger
}

func NewReplayer(reader sentinelconnector.RawArchiveReader, publisher sentinelconnector.Publisher, checkpoints CheckpointStore, log *slog.Logger) *Replayer {
	if log == nil {
		log = slog.Default()
	}
	return &Replayer{reader: reader, publisher: publisher, checkpoints: checkpoints, log: log}
}

// Replay re-runs every archived event for tenantID in [from, to] through
// connector.Normalise and publishes the result. jobID identifies this
// replay run's checkpoint — reusing the same jobID resumes a previous,
// interrupted run; a new jobID starts fresh even over the same tenant and
// range.
//
// Checkpointed after every archived OBJECT (not every event, and not only
// at the very end) — the unit a real replay job can safely resume at,
// since ListObjectKeys/GetObject operate at that granularity too.
func (r *Replayer) Replay(ctx context.Context, jobID, tenantID string, from, to time.Time, connector sentinelconnector.Connector) (Progress, error) {
	keys, err := r.reader.ListObjectKeys(ctx, tenantID, from, to)
	if err != nil {
		return Progress{}, fmt.Errorf("sentinelreplay: listing archived objects: %w", err)
	}

	done, err := r.checkpoints.Load(ctx, jobID)
	if err != nil {
		return Progress{}, fmt.Errorf("sentinelreplay: loading checkpoint for job %s: %w", jobID, err)
	}

	progress := Progress{TotalObjects: len(keys)}
	for _, k := range keys {
		if done[k] {
			// Already processed in a prior attempt at this same jobID —
			// this is the resume path (AC4/T3): skip straight past it
			// without re-reading or re-publishing anything.
			progress.ProcessedObjects++
			continue
		}

		if err := ctx.Err(); err != nil {
			// An interruption mid-replay: return whatever progress was
			// made (and already checkpointed) rather than a bare error —
			// the caller's own context carries the real reason, and a
			// NEW Replayer.Replay call with the same jobID picks up
			// exactly where this one stopped, via the checkpoint just
			// saved for every key completed so far.
			return progress, ctx.Err()
		}

		obj, err := r.reader.GetObject(ctx, k)
		if err != nil {
			return progress, fmt.Errorf("sentinelreplay: reading archived object %s: %w", k, err)
		}

		envelopes := make([]sentinelconnector.EventEnvelope, 0, len(obj.Events))
		for _, raw := range obj.Events {
			events, err := connector.Normalise(raw)
			if err != nil {
				return progress, fmt.Errorf("sentinelreplay: normalising an event from %s: %w", k, err)
			}
			for _, ev := range events {
				payload, err := json.Marshal(ev)
				if err != nil {
					return progress, fmt.Errorf("sentinelreplay: marshalling a normalised event from %s: %w", k, err)
				}
				envelopes = append(envelopes, sentinelconnector.EventEnvelope{TenantID: tenantID, Payload: payload})
			}
		}

		if len(envelopes) > 0 {
			if err := r.publisher.Publish(ctx, tenantID, envelopes); err != nil {
				return progress, fmt.Errorf("sentinelreplay: publishing replayed events from %s: %w", k, err)
			}
		}

		done[k] = true
		if err := r.checkpoints.Save(ctx, jobID, done); err != nil {
			return progress, fmt.Errorf("sentinelreplay: saving checkpoint for job %s: %w", jobID, err)
		}

		progress.ProcessedObjects++
		progress.TotalEvents += int64(len(obj.Events))
		r.log.Info("replay progress", "job_id", jobID, "tenant_id", tenantID,
			"processed_objects", progress.ProcessedObjects, "total_objects", progress.TotalObjects,
			"total_events", progress.TotalEvents)
	}

	return progress, nil
}
