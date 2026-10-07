/**
 * lookup_threat_intel (P4-02 AC1) — honestly scoped: a repo-wide search
 * (threat_intel|threatintel|ioc|indicator, case-insensitive) turned up no
 * external threat-intel API client, no Postgres/ClickHouse table, no
 * service anywhere in this codebase. There is nothing real to call yet.
 *
 * This mirrors the same precedent docs/architecture's own
 * verify-audit-chain.yml comment sets for a GitHub Actions notification:
 * "a real, working alert... not a placeholder... honestly scoped...
 * because no such integration exists yet." The tool is real — it has the
 * right shape, is logged and timed the same as the other three, and the
 * model gets back a clear, structured "not configured" answer it can act
 * on (e.g. degrade to rule-only evidence) — rather than either a fake IOC
 * match or a thrown error that looks like a bug. Wiring in a real feed is
 * separate, future work, not this ticket's.
 */
import { runTool, ToolInvalidArgumentError, type ToolOutcome, type Logger } from './types.js';

export const DEFAULT_TIMEOUT_MS = 5_000;

export interface LookupThreatIntelArgs {
  indicator: string;
  indicatorType: 'ip' | 'domain' | 'hash' | 'email';
}

export interface ThreatIntelResult {
  indicator: string;
  configured: false;
  message: string;
}

const INDICATOR_TYPES = ['ip', 'domain', 'hash', 'email'] as const;

function validate(args: LookupThreatIntelArgs): void {
  if (!args.indicator || typeof args.indicator !== 'string') {
    throw new ToolInvalidArgumentError('lookup_threat_intel: indicator is required');
  }
  if (!(INDICATOR_TYPES as readonly string[]).includes(args.indicatorType)) {
    throw new ToolInvalidArgumentError(`lookup_threat_intel: indicatorType must be one of ${INDICATOR_TYPES.join(', ')}`);
  }
}

export async function lookupThreatIntel(
  tenantId: string,
  args: LookupThreatIntelArgs,
  logger: Logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutcome<ThreatIntelResult>> {
  return runTool({
    name: 'lookup_threat_intel',
    tenantId,
    args,
    timeoutMs,
    logger,
    fn: async () => {
      validate(args);
      return {
        indicator: args.indicator,
        configured: false,
        message: 'No threat-intel data source is configured in this deployment. This is not a lookup failure — treat the indicator as unknown, not as benign or malicious.',
      };
    },
  });
}
