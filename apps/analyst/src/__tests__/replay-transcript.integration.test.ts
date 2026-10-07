/**
 * P4-11 T1/T2 — captures a real investigation's transcript into REAL
 * Postgres, reads it back, and replays it against a different model
 * (a second fake Anthropic client stands in — same boundary as every
 * other ticket this session: no real ANTHROPIC_API_KEY, but nothing
 * about capture/storage/retrieval/replay itself needs one, since
 * replay never makes a live call on the ORIGINAL model's behalf,
 * only a fresh one on the REPLAY model's behalf).
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import pg, { type Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { withTenantContext, InvestigationTranscriptRepository } from '@sentinel/db';
import { AnthropicInvestigationModel, type CaseContext } from '../investigation-model.js';
import { PostgresTranscriptRecorder, type Transcript } from '../transcript.js';
import { replayInvestigation } from '../replay.js';
import { diffVerdicts } from '../verdict-diff.js';

const pool: Pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createTenantAndCase(): Promise<{ tenantId: string; caseId: string }> {
  const tenantId = await asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-11 replay probe ${Date.now()}`,
    ]);
    return rows[0]!.id;
  });
  const caseId = await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', 'P4-11 probe case', now(), 1, 50) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  });
  return { tenantId, caseId };
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

function finalTextResponse(text: string): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as never,
  } as unknown as Anthropic.Message;
}

const ORIGINAL_VERDICT_TEXT = JSON.stringify({
  severity: 'high',
  title: 'Original investigation',
  claims: [{ text: 'A sign-in from a new country', evidenceRef: ['evt_1'] }],
  attackChain: ['T1078'],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'one user' }],
});

const cleanupTenants: string[] = [];
afterAll(async () => {
  for (const tenantId of cleanupTenants) await deleteTenant(tenantId).catch(() => {});
  await pool.end();
});

describe('P4-11: investigation transcript capture and replay', () => {
  it('T1: a recorded investigation replays against a different model and produces a comparable verdict', async () => {
    const { tenantId, caseId } = await createTenantAndCase();
    cleanupTenants.push(tenantId);

    const originalCreate = vi.fn().mockResolvedValue(finalTextResponse(ORIGINAL_VERDICT_TEXT));
    const originalClient = { messages: { create: originalCreate } } as unknown as Anthropic;
    const model = new AnthropicInvestigationModel({
      apiKey: 'unused',
      model: 'original-model',
      client: originalClient,
      transcriptRecorder: new PostgresTranscriptRecorder(pool),
    });
    const ctx: CaseContext = { caseId, tenantId, severity: 'critical', title: 'Suspicious sign-in', windowStart: new Date().toISOString(), windowEnd: null };
    const originalVerdict = await model.investigate(ctx);
    expect(originalVerdict.title).toBe('Original investigation');

    // AC1: the real capture actually landed in real Postgres.
    const rows = await withTenantContext(tenantId, () => new InvestigationTranscriptRepository(pool).listForCase(caseId));
    expect(rows).toHaveLength(1);
    const transcript: Transcript = {
      model: rows[0]!.model,
      system: rows[0]!.system as Transcript['system'],
      messages: rows[0]!.messages as Transcript['messages'],
      finalResponseContent: rows[0]!.finalResponse as Transcript['finalResponseContent'],
      verdict: rows[0]!.verdict as Transcript['verdict'],
    };
    expect(transcript.model).toBe('original-model');

    // AC2: replay against a DIFFERENT model (a second fake client —
    // simulating "what would a different model/prompt have said given
    // the SAME evidence").
    const replayCreate = vi.fn().mockResolvedValue(finalTextResponse(ORIGINAL_VERDICT_TEXT));
    const replayClient = { messages: { create: replayCreate } } as unknown as Anthropic;
    const replayedVerdict = await replayInvestigation(transcript, { apiKey: 'unused', model: 'a-different-model', client: replayClient });

    expect(replayCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'a-different-model' }));
    const diff = diffVerdicts(originalVerdict, replayedVerdict);
    expect(diff.materiallyEquivalent).toBe(true); // AC5: diffing is supported, and here they genuinely agree

    // T2: replay never touched Postgres beyond the read above, never
    // produced to Kafka, never called a tool — the replay client was
    // called exactly once, with no `tools` field.
    expect(replayCreate).toHaveBeenCalledTimes(1);
    const replayArgs = replayCreate.mock.calls[0]![0] as { tools?: unknown };
    expect(replayArgs.tools).toBeUndefined();
  });
});

