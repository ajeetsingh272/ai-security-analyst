package sentinelreplay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3CheckpointStore persists replay progress as a small JSON object in
// the same S3-compatible store the archive itself lives in — a real
// replay job needs no database of its own, and this is the one piece of
// infra it's already guaranteed to have access to (it's reading archived
// objects from there anyway).
type S3CheckpointStore struct {
	client *s3.Client
	bucket string
}

func NewS3CheckpointStore(client *s3.Client, bucket string) *S3CheckpointStore {
	return &S3CheckpointStore{client: client, bucket: bucket}
}

func (s *S3CheckpointStore) key(jobID string) string {
	return fmt.Sprintf("replay-checkpoints/%s.json", jobID)
}

func (s *S3CheckpointStore) Load(ctx context.Context, jobID string) (map[string]bool, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(s.key(jobID))})
	if err != nil {
		var nsk *types.NoSuchKey
		if errors.As(err, &nsk) {
			// No checkpoint yet — a brand new job, not a failure.
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("sentinelreplay: loading checkpoint s3://%s/%s: %w", s.bucket, s.key(jobID), err)
	}
	defer out.Body.Close()

	var done map[string]bool
	if err := json.NewDecoder(out.Body).Decode(&done); err != nil {
		return nil, fmt.Errorf("sentinelreplay: decoding checkpoint s3://%s/%s: %w", s.bucket, s.key(jobID), err)
	}
	return done, nil
}

func (s *S3CheckpointStore) Save(ctx context.Context, jobID string, done map[string]bool) error {
	payload, err := json.Marshal(done)
	if err != nil {
		return fmt.Errorf("sentinelreplay: marshalling checkpoint: %w", err)
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.key(jobID)),
		Body:   bytes.NewReader(payload),
	})
	if err != nil {
		return fmt.Errorf("sentinelreplay: saving checkpoint s3://%s/%s: %w", s.bucket, s.key(jobID), err)
	}
	return nil
}

// InMemoryCheckpointStore is a CheckpointStore test double — lets unit
// tests exercise Replayer's resume logic without a running S3-compatible
// store, same role every other InMemory* type in this codebase plays.
type InMemoryCheckpointStore struct {
	mu   sync.Mutex
	jobs map[string]map[string]bool
}

func NewInMemoryCheckpointStore() *InMemoryCheckpointStore {
	return &InMemoryCheckpointStore{jobs: make(map[string]map[string]bool)}
}

func (s *InMemoryCheckpointStore) Load(_ context.Context, jobID string) (map[string]bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	done, ok := s.jobs[jobID]
	if !ok {
		return map[string]bool{}, nil
	}
	// A copy, not the live map — Replayer mutates what Load returns
	// in-process before calling Save; handing back the store's own
	// backing map would let that mutation bypass Save entirely.
	copied := make(map[string]bool, len(done))
	for k, v := range done {
		copied[k] = v
	}
	return copied, nil
}

func (s *InMemoryCheckpointStore) Save(_ context.Context, jobID string, done map[string]bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copied := make(map[string]bool, len(done))
	for k, v := range done {
		copied[k] = v
	}
	s.jobs[jobID] = copied
	return nil
}
