/**
 * P2-12 — ADR-0004's own named escape hatch: a small interpreted
 * "hotfix rule" path for urgent detections, capped at 10 active rules
 * platform-wide and expiring automatically after 7 days (enforced in
 * the schema itself, 0008_hotfix_rules.sql).
 *
 * "Creating one requires an elevated role" (AC3) resolves a real gap:
 * hotfix_rules is platform-wide, but every role this codebase has
 * (owner/admin/analyst/read_only) is a TENANT-scoped membership role —
 * there is no "platform staff" concept yet. Letting any customer
 * tenant's own `admin` create a rule that affects EVERY tenant's
 * detection would be a serious cross-tenant boundary violation, not a
 * convenience. The fix reuses 100% of the existing tenant+membership+
 * RBAC machinery rather than inventing a new access-control axis: a
 * SINGLE designated tenant (PLATFORM_OPS_TENANT_ID — Sentinel's own
 * operations tenant, not a customer's) is configured, and a caller must
 * be `admin`+ WITHIN THAT SPECIFIC tenant to call any of these routes.
 * `requireRole('admin')` alone would NOT be enough on its own — it only
 * proves the caller is an admin of WHATEVER tenant their own session
 * belongs to, which could be any customer. The explicit opsTenantId
 * check is what actually makes this "elevated" in the way AC3 means.
 *
 * Flagged for two-reviewer sign-off like every other trust-boundary
 * change this phase (P2-08/TG4, P2-10/TG3) — not self-merged.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditLogWriter, HotfixRuleCapExceededError, HotfixRuleEmptyReasonError, HotfixRulesRepository } from '@sentinel/db';
import { requireRole, roleAtLeast } from '../auth/rbac.js';

export interface HotfixRulesRoutesOptions {
  pool: Pool;
  /** See this file's own doc comment — undefined (not a crash) means
   * every request here is refused with 503, the same pattern
   * m365-connector.ts uses for its own missing OAuth config. */
  opsTenantId?: string | undefined;
}

/** rule_id/rule_title are extracted for display only (the dashboard
 * listing, AC4) — a best-effort line-based read, not a Sigma parser.
 * services/detect's own sigmac.Parse is the AUTHORITATIVE parse of
 * rule_yaml; a value this extraction gets wrong or misses only affects
 * what's SHOWN here, never whether the rule actually loads and
 * evaluates, which is Go's own job entirely. */
function extractDisplayFields(ruleYaml: string): { ruleId: string; ruleTitle: string } {
  const idMatch = /^id:\s*(.+)$/m.exec(ruleYaml);
  const titleMatch = /^title:\s*(.+)$/m.exec(ruleYaml);
  return {
    ruleId: idMatch?.[1]?.trim() ?? '',
    ruleTitle: titleMatch?.[1]?.trim() ?? '',
  };
}

async function hotfixRulesRoutesImpl(
  fastify: FastifyInstance,
  options: HotfixRulesRoutesOptions,
): Promise<void> {
  const { pool, opsTenantId } = options;

  function requireOpsTenant(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, sessionTenantId: string): boolean {
    if (!opsTenantId) {
      reply.code(503).send({ error: 'hotfix_rules_not_configured' });
      return false;
    }
    if (sessionTenantId !== opsTenantId) {
      reply.code(403).send({ error: 'not_platform_operations_tenant' });
      return false;
    }
    return true;
  }

  // T3: "Creation by a non-elevated role is denied and audited" — a
  // plain `requireRole` preHandler would deny correctly but has no way
  // to also write the audit entry this AC requires, so the check (role
  // rank AND ops-tenant membership — see this file's own doc comment
  // for why both matter) is done by hand here, with every denial
  // audited before returning, not only every success.
  fastify.post('/hotfix-rules', async (request, reply) => {
    const session = request.session!; // tenantContextPlugin's onRequest hook already guarantees this

    const elevated = roleAtLeast(session.role, 'admin') && session.tenantId === opsTenantId;
    if (!elevated) {
      if (opsTenantId) {
        // Audited regardless of WHICH half failed (role rank, or the
        // right role in the wrong tenant) — both are "not elevated" for
        // this platform-wide action, and AC3 asks for the attempt to be
        // on record either way.
        await new AuditLogWriter(pool).insert({
          actorType: 'human',
          actorId: session.userId,
          action: 'hotfix_rule.create_denied',
          subjectType: 'hotfix_rule',
          subjectId: 'n/a',
          payload: { role: session.role },
        });
      }
      if (!opsTenantId) {
        return reply.code(503).send({ error: 'hotfix_rules_not_configured' });
      }
      return reply.code(403).send({ error: 'insufficient_role' });
    }

    const body = request.body as { ruleYaml?: unknown; reason?: unknown };
    if (typeof body.ruleYaml !== 'string' || body.ruleYaml.trim().length === 0) {
      return reply.code(400).send({ error: 'rule_yaml_required' });
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    const { ruleId, ruleTitle } = extractDisplayFields(body.ruleYaml);
    if (ruleId === '' || ruleTitle === '') {
      return reply.code(400).send({ error: 'rule_yaml_missing_id_or_title' });
    }

    const repo = new HotfixRulesRepository(pool);
    try {
      const rule = await repo.create({
        ruleId,
        ruleTitle,
        ruleYaml: body.ruleYaml,
        reason: body.reason,
        createdBy: session.userId,
      });

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'hotfix_rule.create',
        subjectType: 'hotfix_rule',
        subjectId: rule.id,
        payload: { ruleId: rule.ruleId, ruleTitle: rule.ruleTitle, reason: rule.reason },
      });

      return reply.code(201).send({ hotfixRule: rule });
    } catch (err) {
      if (err instanceof HotfixRuleEmptyReasonError) {
        return reply.code(400).send({ error: 'reason_required' });
      }
      if (err instanceof HotfixRuleCapExceededError) {
        // AC3's own audit requirement is about every CREATE action, not
        // only successful ones — a rejected attempt at the cap is still
        // something an operations team should see happened.
        await new AuditLogWriter(pool).insert({
          actorType: 'human',
          actorId: session.userId,
          action: 'hotfix_rule.create_rejected_cap_exceeded',
          subjectType: 'hotfix_rule',
          subjectId: ruleId,
        });
        return reply.code(409).send({ error: 'hotfix_rule_cap_exceeded' });
      }
      throw err;
    }
  });

  // AC4: "Active hotfix rules are listed on the operations dashboard
  // with their expiry" — exposed via the API; apps/dashboard has no
  // real UI framework yet (P6-01/P6-08's own scope).
  fastify.get('/hotfix-rules', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const session = request.session!;
    if (!requireOpsTenant(reply, session.tenantId)) return;

    const repo = new HotfixRulesRepository(pool);
    const hotfixRules = await repo.listActive();
    return reply.code(200).send({ hotfixRules });
  });

  fastify.post('/hotfix-rules/:id/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    if (!requireOpsTenant(reply, session.tenantId)) return;

    const { id } = request.params as { id: string };
    const repo = new HotfixRulesRepository(pool);
    const revoked = await repo.revoke(id, session.userId);
    if (!revoked) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'hotfix_rule.revoke',
      subjectType: 'hotfix_rule',
      subjectId: id,
    });

    return reply.code(200).send({ hotfixRule: revoked });
  });
}

/** Reads PLATFORM_OPS_TENANT_ID from the environment — undefined (not a
 * crash) if unset, the same pattern m365OAuthConfigFromEnv uses. */
export function opsTenantIdFromEnv(): string | undefined {
  return process.env['PLATFORM_OPS_TENANT_ID'];
}

export const hotfixRulesRoutes = fp(hotfixRulesRoutesImpl, { name: 'sentinel-hotfix-rules-routes' });
