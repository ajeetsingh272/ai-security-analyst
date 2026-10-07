package suppression

import (
	"context"
	"testing"
)

func TestInMemoryChecker_WildcardSuppressionMatchesAnyEntity(t *testing.T) {
	c := NewInMemoryChecker()
	c.Suppress("tenant-a", "rule-1", "", "sup-1")

	suppressed, id, err := c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "user-42")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !suppressed || id != "sup-1" {
		t.Fatalf("got suppressed=%v id=%q, want true/sup-1", suppressed, id)
	}

	// An in-stream signal with no entity at all must also match a wildcard.
	suppressed, _, err = c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !suppressed {
		t.Fatal("wildcard suppression must match an entity-less signal too")
	}
}

func TestInMemoryChecker_ScopedSuppressionOnlyMatchesItsEntity(t *testing.T) {
	c := NewInMemoryChecker()
	c.Suppress("tenant-a", "rule-1", "user-42", "sup-1")

	suppressed, _, err := c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "user-42")
	if err != nil || !suppressed {
		t.Fatalf("expected suppressed for user-42, got suppressed=%v err=%v", suppressed, err)
	}

	suppressed, _, err = c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "user-99")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suppressed {
		t.Fatal("a suppression scoped to one entity must not match a different entity")
	}

	// An entity-less signal must not accidentally match an entity-scoped
	// suppression either.
	suppressed, _, err = c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suppressed {
		t.Fatal("an entity-scoped suppression must not match an entity-less signal")
	}
}

func TestInMemoryChecker_DifferentTenantIsolated(t *testing.T) {
	c := NewInMemoryChecker()
	c.Suppress("tenant-a", "rule-1", "", "sup-1")

	suppressed, _, err := c.IsSuppressed(context.Background(), "tenant-b", "rule-1", "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suppressed {
		t.Fatal("tenant B must never see tenant A's suppression")
	}
}

func TestInMemoryChecker_NoSuppression(t *testing.T) {
	c := NewInMemoryChecker()
	suppressed, id, err := c.IsSuppressed(context.Background(), "tenant-a", "rule-1", "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suppressed || id != "" {
		t.Fatalf("got suppressed=%v id=%q, want false/\"\"", suppressed, id)
	}
}
