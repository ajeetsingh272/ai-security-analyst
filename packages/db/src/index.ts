/**
 * @sentinel/db — typed access to the control plane.
 *
 * What this package is: the generated Drizzle schema (src/schema.ts), the column
 * types introspection cannot express (src/types.ts), the tenant context boundary
 * (src/tenant-context.ts, P0-05), and a low-level pool factory.
 *
 * `createControlPlanePool` below is NOT tenant-scoped — nothing it returns sets
 * `app.tenant_id`, and nothing refuses to run outside a tenant context. Reaching
 * for it directly in application code is a design smell with a visible symptom:
 * row-level security is FORCED on every tenant-scoped table, so a query issued
 * without `app.tenant_id` set does not leak another tenant's rows — it returns
 * none. The failure mode is an empty result, not a breach. Still a bug worth
 * catching at construction time, which is what `TenantScopedRepository` does.
 */
import { Pool, type PoolConfig } from 'pg';

export * as schema from './schema.js';
export * as relations from './relations.js';
export { bytea, citext } from './types.js';
export {
  withTenantContext,
  enterTenantContext,
  exitTenantContext,
  getTenantContext,
  hasTenantContext,
  TenantScopedRepository,
  TenantContextError,
  type TenantContext,
} from './tenant-context.js';
export {
  CasesRepository,
  DismissalChallengeEmptyReasonError,
  AiDismissalEmptyReasonError,
  type CaseRow,
  type DismissalDigestRow,
  type CaseHistory,
  type CaseSignalRow,
  type CaseTransitionRow,
  type CaseListItem,
  type CaseListFilters,
  type CaseListPage,
  type CaseFilterOptions,
  type FilterOption,
} from './repositories/cases-repository.js';
export { LlmUsageRepository, type UsageRecord } from './repositories/llm-usage-repository.js';
export { DegradedQueueRepository, listTenantsWithPendingDegradedCases, type DegradedQueueRow } from './repositories/degraded-queue-repository.js';
export {
  InvestigationTranscriptRepository,
  purgeExpiredTranscripts,
  type TranscriptInput,
  type TranscriptRow,
} from './repositories/investigation-transcript-repository.js';
export {
  ConnectorsRepository,
  type ConnectorHealth,
  type ConnectorApiStatus,
  type ConnectorDbStatus,
} from './repositories/connectors-repository.js';
export {
  SuppressionsRepository,
  SuppressionEmptyReasonError,
  type SuppressionRow,
  type CreateSuppressionInput,
  type RenewSuppressionInput,
} from './repositories/suppressions-repository.js';
export {
  HotfixRulesRepository,
  HotfixRuleEmptyReasonError,
  HotfixRuleCapExceededError,
  type HotfixRuleRow,
  type CreateHotfixRuleInput,
} from './repositories/hotfix-rules-repository.js';
export {
  AuditLogWriter,
  writeAuditEntryTx,
  type ActorType,
  type AuditEntryInput,
  type WrittenAuditEntry,
} from './audit/audit-log-writer.js';
export { AuditExportRepository, type AuditExportEntry } from './audit/audit-export-repository.js';
export {
  NotificationDeliveryRepository,
  type NotificationChannelId,
  type DeliveryStatus,
  type RecordDeliveryAttemptInput,
  type DeliveryAttemptRow,
} from './repositories/notification-delivery-repository.js';
export {
  NotificationPreferencesRepository,
  DEFAULT_CHANNEL_ORDER,
} from './repositories/notification-preferences-repository.js';
export { NotificationOptoutRepository } from './repositories/notification-optout-repository.js';
export { ActionsRepository, type ActionRow } from './repositories/actions-repository.js';
export { ApprovalNonceRepository } from './repositories/approval-nonce-repository.js';
export { PreApprovalRepository, DestructivePlaybookCannotBePreApprovedError } from './repositories/pre-approval-repository.js';
export { generateDEK, encryptWithDEK, decryptWithDEK } from './crypto/envelope.js';
export { LocalKMS, type KeyManagementService, type WrappedDEK } from './crypto/kms.js';
export {
  TenantCredentialVault,
  type EncryptedCredentials,
} from './crypto/tenant-credential-vault.js';
export {
  GENESIS_HASH,
  auditEntryContent,
  computeEntryHash,
  verifyChain,
  type AuditEntryContent,
  type AuditEntryRow,
  type VerifyChainResult,
} from '../scripts/chain-verifier.mjs';
export { canonicalJSON } from '../scripts/canonical-json.mjs';

/** Where the control plane lives, when nothing says otherwise. */
const DEFAULT_URL = 'postgres://sentinel:sentinel@localhost:5434/sentinel';

/**
 * Opens a connection pool to the control plane.
 *
 * Not tenant-scoped — see the note above. Intended to be called once per
 * process, by the tenant-context layer, and not by feature code.
 *
 * The pool is capped low on purpose. Postgres here holds control-plane data
 * only: tenants, cases, actions, audit entries. Per-event volume lives in
 * ClickHouse (ADR-0005), so a process needing a large Postgres pool is usually
 * a process doing something per-event that it should not be doing here.
 */
export function createControlPlanePool(config: PoolConfig = {}): Pool {
  const { connectionString, ...rest } = config;
  return new Pool({
    connectionString:
      connectionString ?? process.env['POSTGRES_URL'] ?? DEFAULT_URL,
    max: 10,
    // Fail fast rather than queue forever. A control-plane query that cannot
    // get a connection in five seconds is already past the point where the
    // request it serves is useful.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...rest,
  });
}
