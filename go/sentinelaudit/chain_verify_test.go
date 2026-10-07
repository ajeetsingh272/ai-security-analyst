package sentinelaudit

import "testing"

func buildTestChain(t *testing.T, n int) []Entry {
	t.Helper()
	entries := make([]Entry, 0, n)
	prev := GenesisHash
	for i := 0; i < n; i++ {
		content := AuditEntryContent{
			TenantID: "tenant-1", OccurredAt: "2026-01-01T00:00:00.000Z",
			ActorType: "system", ActorID: "test-writer",
			Action: "action", SubjectType: "test", SubjectID: "subject",
			Payload: map[string]any{"i": float64(i)},
		}
		hash, err := ComputeEntryHash(prev, content)
		if err != nil {
			t.Fatalf("ComputeEntryHash: %v", err)
		}
		entries = append(entries, Entry{ID: i, PrevHash: prev, EntryHash: hash, AuditEntryContent: content})
		prev = hash
	}
	return entries
}

func TestVerifyChain_ValidChainPasses(t *testing.T) {
	entries := buildTestChain(t, 5)
	result, err := VerifyChain(entries)
	if err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	if !result.OK {
		t.Fatalf("got %+v, want OK", result)
	}
}

func TestVerifyChain_EmptyChainPasses(t *testing.T) {
	result, err := VerifyChain(nil)
	if err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	if !result.OK {
		t.Fatalf("got %+v, want OK for an empty chain", result)
	}
}

func TestVerifyChain_MutatedPayloadBreaksTheChain(t *testing.T) {
	entries := buildTestChain(t, 3)
	entries[1].Payload = map[string]any{"i": float64(999)} // tampered after the hash was computed
	result, err := VerifyChain(entries)
	if err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	if result.OK || result.BrokenAtID != 1 {
		t.Fatalf("got %+v, want broken at entry 1", result)
	}
}

func TestVerifyChain_DeletedEntryBreaksTheChain(t *testing.T) {
	entries := buildTestChain(t, 3)
	entries = append(entries[:1], entries[2:]...) // remove entry 1
	result, err := VerifyChain(entries)
	if err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	if result.OK {
		t.Fatal("got OK, want the chain broken — entry 1 was deleted")
	}
}

func TestVerifyChain_FirstEntryMustChainFromGenesis(t *testing.T) {
	entries := buildTestChain(t, 1)
	entries[0].PrevHash = make([]byte, 32)
	entries[0].PrevHash[0] = 1 // not genesis
	result, err := VerifyChain(entries)
	if err != nil {
		t.Fatalf("VerifyChain: %v", err)
	}
	if result.OK {
		t.Fatal("got OK, want broken — the first entry must chain from GenesisHash")
	}
}
