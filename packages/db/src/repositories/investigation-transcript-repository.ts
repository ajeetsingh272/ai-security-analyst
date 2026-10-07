/**
 * P4-11: full prompt/tool-call/response capture for a real
 * investigation — `messages` alone already carries every tool call in
 * its natural order (Anthropic's own format interleaves `tool_use`/
 * `tool_result` directly into the conversation), so there is no
 * separate tool-call log to keep in sync with it.
 */
import type { Pool } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';

export interface TranscriptInput {
  model: string;
  system: unknown;
  messages: unknown;
  finalResponse: unknown;
  verdict: unknown;
}

export interface TranscriptRow {
  id: string;
  caseId: string;
  model: string;
  system: unknown;
  messages: unknown;
  finalResponse: unknown;
  verdict: unknown;
  recordedAt: string;
}

function mapRow(row: Record<string, unknown>): TranscriptRow {
  return {
    id: String(row['id']),
    caseId: String(row['case_id']),
    model: String(row['model']),
    system: row['system'],
    messages: row['messages'],
    finalResponse: row['final_response'],
    verdict: row['verdict'],
    recordedAt: String(row['recorded_at']),
  };
}

export class InvestigationTranscriptRepository extends TenantScopedRepository {
  async record(caseId: string, input: TranscriptInput): Promise<string> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO investigation_transcripts (tenant_id, case_id, model, system, messages, final_response, verdict)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [this.tenantId, caseId, input.model, JSON.stringify(input.system), JSON.stringify(input.messages), JSON.stringify(input.finalResponse), JSON.stringify(input.verdict)],
      );
      return rows[0]!.id;
    });
  }

  async findById(id: string): Promise<TranscriptRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, case_id, model, system, messages, final_response, verdict, recorded_at FROM investigation_transcripts WHERE id = $1',
        [id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async listForCase(caseId: string): Promise<TranscriptRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, case_id, model, system, messages, final_response, verdict, recorded_at FROM investigation_transcripts WHERE case_id = $1 ORDER BY recorded_at DESC',
        [caseId],
      );
      return rows.map(mapRow);
    });
  }
}

/**
 * AC3's own retention policy — cross-tenant by construction (mirrors
 * `DegradedQueueRepository`'s own `listTenantsWithPendingDegradedCases`
 * and `services/correlate/cmd/correlate/main.go`'s `runQuietPeriodSweep`:
 * a platform-wide maintenance sweep goes through the pool's own
 * default connection, since retention applies identically to every
 * tenant, not one tenant's own request). Returns the number of rows
 * purged, so a caller can log it.
 */
export async function purgeExpiredTranscripts(pool: Pool, retentionDays: number): Promise<number> {
  const result = await pool.query(`DELETE FROM investigation_transcripts WHERE recorded_at < now() - ($1 || ' days')::interval`, [retentionDays]);
  return result.rowCount ?? 0;
}
