//go:build integration

package worker

import (
	"context"
	"time"

	"testing"
)

// T3 (P7-03): "Risk detections surface as signals." A real Entra ID
// risk-detection event (go/sentinelconnector/azure's own riskDetections
// mapping, OCSF Detection Finding, class_uid 2004) flows through the
// REAL dispatch tree (parsed from the real detections/rules corpus,
// including entra-risk-detection.yml) and the real in-stream worker,
// over real Kafka, and produces exactly one real signal — mirrors this
// package's own TestWorker_KnownMaliciousSequenceProducesExpectedSignals
// (T1), substituting entra-risk-detection.yml's own fixture shape for
// new-inbox-forwarding-rule.yml's.
func TestWorker_RiskDetectionSurfacesAsSignal(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-entra-risk-" + tenantID

	w, consumer, producer := newWorker(t, group)
	defer consumer.Close()
	defer producer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 2004, CategoryUID: 2, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "azure", "operation": "unfamiliarFeatures"},
	})

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != "8f1a2b3c-0002-4a00-9000-00000000000a" {
		t.Errorf("RuleID = %q, want the entra-risk-detection rule id", sig.RuleID)
	}
	if len(sig.EventIDs) != 1 || sig.EventIDs[0] != eventID {
		t.Errorf("EventIDs = %v, want [%q]", sig.EventIDs, eventID)
	}
	if sig.Severity != "high" {
		t.Errorf("Severity = %q, want high", sig.Severity)
	}
}

// A sign-in event (class_uid 3002 — what a DEDUPLICATED, M365-shaped
// Azure sign-in event looks like per ocsf_mapping.go's own design) must
// NOT trigger this rule — proving the selector is genuinely class_uid-
// scoped, not accidentally matching on product=azure alone (an earlier
// draft of this rule risked exactly that before settling on class_uid).
func TestWorker_DeduplicatedSignInEventDoesNotTriggerRiskDetectionRule(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-entra-risk-negative-" + tenantID

	w, consumer, producer := newWorker(t, group)
	defer consumer.Close()
	defer producer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3002, CategoryUID: 3, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "UserLoggedIn"},
	})

	got := collectSignals(t, tenantID, 1, 5*time.Second)
	if len(got) != 0 {
		t.Fatalf("expected no signals for a plain sign-in event, got %d: %+v", len(got), got)
	}
}
