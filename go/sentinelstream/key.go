package sentinelstream

import (
	"fmt"
	"strconv"
	"strings"
)

// defaultShard is what every tenant-keyed message uses until the Phase 7
// hot-tenant splitter assigns something else (overview.md §3.3) — carried
// in the key format from day one specifically so that future change is
// non-breaking, per ADR-0003's own stated mitigation.
const defaultShard = 0

// TenantKey builds the partition key for a KeyTenant topic (events.raw,
// events.normalized): "tenant_id:shard_n", shard 0 by default (P1-05 AC2).
func TenantKey(tenantID string) string {
	return TenantShardKey(tenantID, defaultShard)
}

// TenantShardKey is TenantKey with an explicit shard — the seam the Phase 7
// hot-tenant splitter uses; nothing in P1-05 calls this with shard != 0 yet.
func TenantShardKey(tenantID string, shard int) string {
	return fmt.Sprintf("%s:%d", tenantID, shard)
}

// ParseTenantShardKey is TenantShardKey's own inverse (P3-10 AC1) — given
// an events.raw/events.normalized message key, returns the real tenant_id
// and its shard number. A key with no ":shard_n" suffix at all parses as
// shard 0 (defaultShard), the identical value TenantKey itself would have
// produced — so a caller never needs to special-case "this tenant isn't
// sharded yet" versus "this tenant's shard happens to be 0".
//
// Nothing in the live pipeline calls this today: neither
// services/detect's worker nor services/correlate's own consumer loop
// reads a Kafka message's KEY at all (only its JSON value) — Kafka's own
// partitioner is the only thing that currently cares what the key
// contains. This function exists so that claim stays true on PURPOSE,
// not by accident: should Phase 7 ever need code that DOES read the key
// (a sharding-aware metric or router, say), this is the one place that
// parsing is defined, rather than every caller inventing its own.
func ParseTenantShardKey(key string) (tenantID string, shard int, err error) {
	idx := strings.LastIndex(key, ":")
	if idx < 0 {
		return key, defaultShard, nil
	}
	shard, err = strconv.Atoi(key[idx+1:])
	if err != nil {
		return "", 0, fmt.Errorf("sentinelstream: key %q has a non-numeric shard suffix: %w", key, err)
	}
	return key[:idx], shard, nil
}

// TenantEntityKey builds the `signals` topic's key: tenant_id:entity_id —
// the literal format in overview.md §3.3's table, no shard suffix (that
// column is a compound tenant+entity key already, not a shardable single
// tenant key).
func TenantEntityKey(tenantID, entityID string) string {
	return tenantID + ":" + entityID
}

// TenantCaseKey builds the `cases` and `actions` topics' key:
// tenant_id:case_id, same reasoning as TenantEntityKey.
func TenantCaseKey(tenantID, caseID string) string {
	return tenantID + ":" + caseID
}
