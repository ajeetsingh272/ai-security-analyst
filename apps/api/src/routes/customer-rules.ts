/**
 * P7-10 / ADR-0012: tenant-self-service detection rules. Unlike
 * hotfix-rules.ts's platform-ops-only gate, this is ordinary
 * tenant-scoped CRUD — any admin+ of the CALLER's own tenant, no
 * elevated-tenant check, because a customer rule only ever affects the
 * authoring tenant's own detection (ADR-0012 §4/§5).
 *
 * Deliberately NOT the authoritative parse of rule_yaml — exactly the
 * same boundary hotfix-rules.ts's own extractDisplayFields draws:
 * services/detect/internal/customerrules.Validate (Go) is the one
 * parser, run asynchronously by the Activator (ADR-0012 §3). A
 * submission here always starts as 'pending_validation'; GET
 * /customer-rules is how a tenant later sees whether it became
 * 'active' or 'rejected' (with why).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditLogWriter, CustomerRuleCapExceededError, CustomerRulesRepository } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface CustomerRulesRoutesOptions {
  pool: Pool;
}

/** Mirrors hotfix-rules.ts's own extractDisplayFields exactly — a
 * best-effort, display-only read of id/title, never the authoritative
 * parse (that is Go's own job, at activation time). */
function extractDisplayFields(ruleYaml: string): { ruleId: string; ruleTitle: string } {
  const idMatch = /^id:\s*(.+)$/m.exec(ruleYaml);
  const titleMatch = /^title:\s*(.+)$/m.exec(ruleYaml);
  return {
    ruleId: idMatch?.[1]?.trim() ?? '',
    ruleTitle: titleMatch?.[1]?.trim() ?? '',
  };
}

function isFlatStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

async function customerRulesRoutesImpl(fastify: FastifyInstance, options: CustomerRulesRoutesOptions): Promise<void> {
  const { pool } = options;

  // AC4: fixtures are mandatory at submission — the activator (Go)
  // refuses to activate anything without both, but requiring them here
  // too means a submission missing one is rejected immediately, not
  // silently stuck in pending_validation forever.
  fastify.post('/customer-rules', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const body = request.body as { ruleYaml?: unknown; positiveFixture?: unknown; negativeFixture?: unknown };

    if (typeof body.ruleYaml !== 'string' || body.ruleYaml.trim().length === 0) {
      return reply.code(400).send({ error: 'rule_yaml_required' });
    }
    if (!isFlatStringRecord(body.positiveFixture)) {
      return reply.code(400).send({ error: 'positive_fixture_required' });
    }
    if (!isFlatStringRecord(body.negativeFixture)) {
      return reply.code(400).send({ error: 'negative_fixture_required' });
    }

    const { ruleId, ruleTitle } = extractDisplayFields(body.ruleYaml);
    if (ruleId === '' || ruleTitle === '') {
      return reply.code(400).send({ error: 'rule_yaml_missing_id_or_title' });
    }

    const repo = new CustomerRulesRepository(pool);
    try {
      const rule = await repo.create({
        ruleId,
        ruleTitle,
        ruleYaml: body.ruleYaml,
        positiveFixture: body.positiveFixture,
        negativeFixture: body.negativeFixture,
        createdBy: session.userId,
      });

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'customer_rule.create',
        subjectType: 'customer_rule',
        subjectId: rule.id,
        payload: { ruleId: rule.ruleId, ruleTitle: rule.ruleTitle },
      });

      return reply.code(201).send({ customerRule: rule });
    } catch (err) {
      if (err instanceof CustomerRuleCapExceededError) {
        await new AuditLogWriter(pool).insert({
          actorType: 'human',
          actorId: session.userId,
          action: 'customer_rule.create_rejected_cap_exceeded',
          subjectType: 'customer_rule',
          subjectId: ruleId,
        });
        return reply.code(409).send({ error: 'customer_rule_cap_exceeded' });
      }
      throw err;
    }
  });

  // Any status, including rejected/suspended — a tenant needs to see
  // WHY something isn't active, not just the ones that are.
  fastify.get('/customer-rules', { preHandler: requireRole('read_only') }, async (_request, reply) => {
    const repo = new CustomerRulesRepository(pool);
    const customerRules = await repo.list();
    return reply.code(200).send({ customerRules });
  });

  fastify.post('/customer-rules/:id/disable', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };

    const repo = new CustomerRulesRepository(pool);
    const disabled = await repo.disable(id);
    if (!disabled) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'customer_rule.disable',
      subjectType: 'customer_rule',
      subjectId: id,
    });

    return reply.code(200).send({ customerRule: disabled });
  });

  fastify.delete('/customer-rules/:id', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };

    const repo = new CustomerRulesRepository(pool);
    const deleted = await repo.delete(id);
    if (!deleted) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'customer_rule.delete',
      subjectType: 'customer_rule',
      subjectId: id,
    });

    return reply.code(200).send({ deleted: true });
  });
}

export const customerRulesRoutes = fp(customerRulesRoutesImpl, { name: 'sentinel-customer-rules-routes' });
