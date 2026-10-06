package sentinelstream

import "fmt"

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
