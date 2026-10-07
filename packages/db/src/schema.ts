// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by `pnpm --filter @sentinel/db pull`, which introspects the live
// database and then runs scripts/postprocess.mjs over the result.
//
// The source of truth for this schema is the SQL under db/postgres/migrations.
// To change the schema, write a migration, apply it, and re-run the pull. Edits
// made here are silently discarded on the next pull, and they cannot change the
// database — which means an edit here that looks correct is strictly worse than
// no edit at all.

import { pgTable, index, pgPolicy, check, bigserial, uuid, timestamp, text, jsonb, smallint, integer, foreignKey, unique, numeric, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { bytea, citext } from "./types";



export const auditLog = pgTable("audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	actorType: text("actor_type").notNull(),
	actorId: text("actor_id").notNull(),
	action: text().notNull(),
	subjectType: text("subject_type").notNull(),
	subjectId: text("subject_id").notNull(),
	payload: jsonb().default({}).notNull(),
	prevHash: bytea("prev_hash").notNull(),
	entryHash: bytea("entry_hash").notNull(),
}, (table) => [
	index("audit_tenant_time_idx").using("btree", table.tenantId.asc().nullsLast().op("timestamptz_ops"), table.occurredAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("audit_log_actor_type_check", sql`actor_type = ANY (ARRAY['human'::text, 'ai'::text, 'system'::text, 'connector'::text])`),
]);

export const tenants = pgTable("tenants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	plan: text().notNull(),
	shardCount: smallint("shard_count").default(1).notNull(),
	epsQuota: integer("eps_quota").default(500).notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("tenants_plan_check", sql`plan = ANY (ARRAY['msp'::text, 'startup'::text, 'small_business'::text, 'trial'::text])`),
	check("tenants_shard_count_check", sql`(shard_count >= 1) AND (shard_count <= 64)`),
	check("tenants_status_check", sql`status = ANY (ARRAY['active'::text, 'suspended'::text, 'degraded'::text, 'churned'::text])`),
]);

export const memberships = pgTable("memberships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "memberships_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "memberships_user_id_fkey"
		}).onDelete("cascade"),
	unique("memberships_tenant_id_user_id_key").on(table.tenantId, table.userId),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("memberships_role_check", sql`role = ANY (ARRAY['owner'::text, 'admin'::text, 'analyst'::text, 'read_only'::text])`),
]);

export const connectors = pgTable("connectors", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	kind: text().notNull(),
	status: text().default('pending').notNull(),
	credentials: bytea("credentials"),
	dekId: text("dek_id"),
	lastError: text("last_error"),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "connectors_tenant_id_fkey"
		}).onDelete("cascade"),
	unique("connectors_id_tenant_key").on(table.id, table.tenantId),
	unique("connectors_tenant_id_kind_key").on(table.tenantId, table.kind),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("connectors_kind_check", sql`kind = ANY (ARRAY['m365'::text, 'google_workspace'::text, 'aws'::text, 'azure'::text, 'syslog'::text])`),
	check("connectors_status_check", sql`status = ANY (ARRAY['pending'::text, 'healthy'::text, 'degraded'::text, 'revoked'::text, 'error'::text])`),
]);

export const cases = pgTable("cases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	severity: text(),
	score: numeric({ precision: 6, scale:  2 }),
	scoreComponents: jsonb("score_components"),
	title: text(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	windowEnd: timestamp("window_end", { withTimezone: true, mode: 'string' }),
	entityIds: text("entity_ids").array().default([""]).notNull(),
	signalCount: integer("signal_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("cases_entities_idx").using("gin", table.entityIds.asc().nullsLast().op("array_ops")),
	index("cases_tenant_created_idx").using("btree", table.tenantId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "cases_tenant_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("cases_severity_check", sql`severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text, 'info'::text])`),
]);

export const caseTransitions = pgTable("case_transitions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	caseId: uuid("case_id").notNull(),
	fromState: text("from_state"),
	toState: text("to_state").notNull(),
	actorType: text("actor_type").notNull(),
	actorId: text("actor_id").notNull(),
	reason: text().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("case_transitions_case_idx").using("btree", table.caseId.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "case_transitions_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.caseId],
			foreignColumns: [cases.id],
			name: "case_transitions_case_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("case_transitions_to_state_check", sql`to_state = ANY (ARRAY['open'::text, 'triaging'::text, 'investigating'::text, 'awaiting_approval'::text, 'actioned'::text, 'closed'::text, 'dismissed'::text])`),
	check("case_transitions_actor_type_check", sql`actor_type = ANY (ARRAY['human'::text, 'ai'::text, 'system'::text])`),
]);

export const actions = pgTable("actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	caseId: uuid("case_id").notNull(),
	playbook: text().notNull(),
	target: jsonb().notNull(),
	blastRadius: text("blast_radius").notNull(),
	status: text().default('proposed').notNull(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	executedAt: timestamp("executed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "actions_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.caseId],
			foreignColumns: [cases.id],
			name: "actions_case_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("actions_status_check", sql`status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text, 'succeeded'::text, 'failed'::text, 'reversed'::text])`),
]);

export const approvalNonces = pgTable("approval_nonces", {
	nonce: text().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	actionId: uuid("action_id").notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.actionId],
			foreignColumns: [actions.id],
			name: "approval_nonces_action_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "approval_nonces_tenant_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
]);

export const mspLinks = pgTable("msp_links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	mspTenantId: uuid("msp_tenant_id").notNull(),
	clientTenantId: uuid("client_tenant_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.mspTenantId],
			foreignColumns: [tenants.id],
			name: "msp_links_msp_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.clientTenantId],
			foreignColumns: [tenants.id],
			name: "msp_links_client_tenant_id_fkey"
		}).onDelete("cascade"),
	unique("msp_links_msp_tenant_id_client_tenant_id_key").on(table.mspTenantId, table.clientTenantId),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`((msp_tenant_id = (current_setting('app.tenant_id'::text, true))::uuid) OR (client_tenant_id = (current_setting('app.tenant_id'::text, true))::uuid))` }),
	check("msp_links_check", sql`msp_tenant_id <> client_tenant_id`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: citext("email"),
	displayName: text("display_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	passwordHash: text("password_hash"),
});

export const suppressions = pgTable("suppressions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	ruleId: text("rule_id").notNull(),
	entityId: text("entity_id"),
	reason: text().notNull(),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedBy: uuid("revoked_by"),
	suppressedCount: integer("suppressed_count").default(0).notNull(),
}, (table) => [
	index("idx_suppressions_lookup").using("btree", table.tenantId.asc().nullsLast().op("uuid_ops"), table.ruleId.asc().nullsLast().op("text_ops"), table.entityId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "suppressions_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "suppressions_created_by_fkey"
		}),
	foreignKey({
			columns: [table.revokedBy],
			foreignColumns: [users.id],
			name: "suppressions_revoked_by_fkey"
		}),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("suppressions_reason_check", sql`length(TRIM(BOTH FROM reason)) > 0`),
	check("suppressions_check", sql`expires_at > created_at`),
]);

export const tenantDeks = pgTable("tenant_deks", {
	tenantId: uuid("tenant_id").primaryKey().notNull(),
	wrappedDek: bytea("wrapped_dek").notNull(),
	kmsKeyId: text("kms_key_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "tenant_deks_tenant_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
]);

export const hotfixRules = pgTable("hotfix_rules", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ruleId: text("rule_id").notNull(),
	ruleTitle: text("rule_title").notNull(),
	ruleYaml: text("rule_yaml").notNull(),
	reason: text().notNull(),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedBy: uuid("revoked_by"),
}, (table) => [
	index("idx_hotfix_rules_active").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(revoked_at IS NULL)`),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "hotfix_rules_created_by_fkey"
		}),
	foreignKey({
			columns: [table.revokedBy],
			foreignColumns: [users.id],
			name: "hotfix_rules_revoked_by_fkey"
		}),
	check("hotfix_rules_reason_check", sql`length(TRIM(BOTH FROM reason)) > 0`),
]);

export const entities = pgTable("entities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	entityType: text("entity_type").notNull(),
	status: text().default('provisional').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_entities_tenant_type").using("btree", table.tenantId.asc().nullsLast().op("text_ops"), table.entityType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "entities_tenant_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("entities_status_check", sql`status = ANY (ARRAY['provisional'::text, 'resolved'::text])`),
]);

export const caseSignals = pgTable("case_signals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	caseId: uuid("case_id").notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	signalId: text("signal_id").notNull(),
	ruleId: text("rule_id").notNull(),
	entityType: text("entity_type").notNull(),
	entityId: text("entity_id").notNull(),
	severity: text().notNull(),
	eventIds: text("event_ids").array().default([""]).notNull(),
	detectedAt: timestamp("detected_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_case_signals_case").using("btree", table.caseId.asc().nullsLast().op("uuid_ops")),
	index("idx_case_signals_tenant_entity_detected").using("btree", table.tenantId.asc().nullsLast().op("text_ops"), table.entityType.asc().nullsLast().op("text_ops"), table.entityId.asc().nullsLast().op("timestamptz_ops"), table.detectedAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "case_signals_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.caseId],
			foreignColumns: [cases.id],
			name: "case_signals_case_id_fkey"
		}).onDelete("cascade"),
	unique("case_signals_tenant_id_dedupe_key_key").on(table.tenantId, table.dedupeKey),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
]);

export const entityAliases = pgTable("entity_aliases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	entityId: uuid("entity_id").notNull(),
	aliasType: text("alias_type").notNull(),
	aliasValue: text("alias_value").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_entity_aliases_entity").using("btree", table.entityId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "entity_aliases_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.entityId],
			foreignColumns: [entities.id],
			name: "entity_aliases_entity_id_fkey"
		}),
	unique("entity_aliases_tenant_id_alias_type_alias_value_key").on(table.tenantId, table.aliasType, table.aliasValue),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
]);

export const entityMerges = pgTable("entity_merges", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tenantId: uuid("tenant_id").notNull(),
	fromEntityId: uuid("from_entity_id").notNull(),
	intoEntityId: uuid("into_entity_id").notNull(),
	movedAliasIds: uuid("moved_alias_ids").array().notNull(),
	reason: text().notNull(),
	actorType: text("actor_type").notNull(),
	actorId: text("actor_id").notNull(),
	mergedAt: timestamp("merged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reversedAt: timestamp("reversed_at", { withTimezone: true, mode: 'string' }),
	reversedBy: text("reversed_by"),
}, (table) => [
	index("idx_entity_merges_tenant").using("btree", table.tenantId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.tenantId],
			foreignColumns: [tenants.id],
			name: "entity_merges_tenant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.fromEntityId],
			foreignColumns: [entities.id],
			name: "entity_merges_from_entity_id_fkey"
		}),
	foreignKey({
			columns: [table.intoEntityId],
			foreignColumns: [entities.id],
			name: "entity_merges_into_entity_id_fkey"
		}),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
	check("entity_merges_reason_check", sql`length(TRIM(BOTH FROM reason)) > 0`),
	check("entity_merges_actor_type_check", sql`actor_type = ANY (ARRAY['human'::text, 'system'::text])`),
]);

export const connectorCursors = pgTable("connector_cursors", {
	connectorId: uuid("connector_id").notNull(),
	stream: text().notNull(),
	cursor: jsonb().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	tenantId: uuid("tenant_id").notNull(),
}, (table) => [
	index("connector_cursors_tenant_idx").using("btree", table.tenantId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.connectorId, table.tenantId],
			foreignColumns: [connectors.id, connectors.tenantId],
			name: "connector_cursors_connector_tenant_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.connectorId, table.stream], name: "connector_cursors_pkey"}),
	pgPolicy("tenant_isolation", { as: "permissive", for: "all", to: ["public"], using: sql`(tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)` }),
]);
