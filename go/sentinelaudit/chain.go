package sentinelaudit

import (
	"bytes"
	"crypto/sha256"
	"fmt"
)

// GenesisHash is the root of every tenant's chain — 32 zero bytes,
// ported literally from chain-verifier.mjs's own GENESIS_HASH. The
// first entry in a tenant's chain stores this as its own prev_hash.
var GenesisHash = make([]byte, 32)

// AuditEntryContent is the exact 8-field shape chain-verifier.mjs's
// own auditEntryContent picks — the SET of fields must match exactly
// across both languages, not just the hashing algorithm, or a chain
// written by one and read by the other becomes unverifiable.
type AuditEntryContent struct {
	TenantID    string
	OccurredAt  string
	ActorType   string
	ActorID     string
	Action      string
	SubjectType string
	SubjectID   string
	Payload     any
}

func (c AuditEntryContent) asMap() map[string]any {
	return map[string]any{
		"tenantId":    c.TenantID,
		"occurredAt":  c.OccurredAt,
		"actorType":   c.ActorType,
		"actorId":     c.ActorID,
		"action":      c.Action,
		"subjectType": c.SubjectType,
		"subjectId":   c.SubjectID,
		"payload":     c.Payload,
	}
}

// ComputeEntryHash ports chain-verifier.mjs's own computeEntryHash:
// SHA256(prevHash || canonicalJSON(content)) — the raw prev-hash
// bytes concatenated with the UTF-8 bytes of the canonical JSON
// string, hashed as one buffer.
func ComputeEntryHash(prevHash []byte, content AuditEntryContent) ([]byte, error) {
	canon, err := CanonicalJSON(content.asMap())
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write(prevHash)
	h.Write([]byte(canon))
	return h.Sum(nil), nil
}

// Entry is one audit_log row, as VerifyChain needs it — the Go
// counterpart to chain-verifier.mjs's own entries parameter shape.
type Entry struct {
	ID        any // kept opaque (string or int64) — only ever echoed back in a verdict, never compared
	PrevHash  []byte
	EntryHash []byte
	AuditEntryContent
}

// VerifyChainResult mirrors chain-verifier.mjs's own return shape.
type VerifyChainResult struct {
	OK         bool
	BrokenAtID any
	Reason     string
}

// VerifyChain ports chain-verifier.mjs's own verifyChain exactly —
// two independent checks per entry (prevHash continuity, and hash
// recomputation), walked in the given order, which must be ascending
// id order (the order rows were actually written) for the result to
// mean anything.
func VerifyChain(entries []Entry) (VerifyChainResult, error) {
	expectedPrev := GenesisHash

	for _, entry := range entries {
		if !bytes.Equal(entry.PrevHash, expectedPrev) {
			return VerifyChainResult{
				OK: false, BrokenAtID: entry.ID,
				Reason: "prev_hash does not match the preceding entry in the chain. An entry " +
					"before this one may have been deleted, altered, or the rows were " +
					"returned out of order.",
			}, nil
		}

		recomputed, err := ComputeEntryHash(entry.PrevHash, entry.AuditEntryContent)
		if err != nil {
			return VerifyChainResult{}, fmt.Errorf("sentinelaudit: recomputing hash for entry %v: %w", entry.ID, err)
		}
		if !bytes.Equal(recomputed, entry.EntryHash) {
			return VerifyChainResult{
				OK: false, BrokenAtID: entry.ID,
				Reason: "entry_hash does not match its recomputed value. One of this " +
					"entry's own fields was altered after it was written.",
			}, nil
		}

		expectedPrev = entry.EntryHash
	}

	return VerifyChainResult{OK: true}, nil
}
