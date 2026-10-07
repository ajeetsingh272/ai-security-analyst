/**
 * P4-08: 50 golden cases with known-correct outcomes — "how a model or
 * prompt change is proven safe before it ships." Generated from a
 * small set of real attack/benign TEMPLATES, each instantiated across
 * several entities/countries/scores — a standard eval-suite authoring
 * technique (parameterised golden sets), not 50 one-off narratives,
 * so the suite stays maintainable as templates themselves evolve.
 *
 * Each case seeds exactly what the real pipeline needs to produce a
 * verdict for real: a `cases`/`case_signals` row (Postgres, the
 * severity/title correlation would already have assigned) and a
 * handful of `sentinel.events` rows (ClickHouse) the investigation
 * model's own tools can discover and cite as evidence — this suite
 * evaluates the ANALYST stage (P4-01..07), not re-testing P2/P3's own
 * correlation/scoring pipeline, which already has its own test suites.
 */
import type { Severity } from '@sentinel/schema';

export type CaseCategory = 'true_positive' | 'false_positive' | 'ambiguous';
export type ExpectedTriageDisposition = 'dismiss' | 'escalate' | 'bypass_critical';

export interface GoldenEventSeed {
  entityId: string;
  message: string;
  srcCountry?: string;
}

export interface GoldenCase {
  id: string;
  category: CaseCategory;
  scenario: string;
  /** The severity correlation would already have assigned this case —
   * drives AC5's own "critical bypasses triage" bypass check. */
  seedSeverity: Severity;
  entityId: string;
  events: GoldenEventSeed[];
  /** When true, a baseline is ALSO seeded showing this entity's
   * activity as habitual — the mechanism real false positives use
   * (P3-05's own baseline) to let the model correctly recognise
   * "this is normal for this entity," not merely "severity happens to
   * be low." */
  seedBaseline: boolean;
  expectedTriageDisposition: ExpectedTriageDisposition;
  /** Only meaningful when the case is NOT dismissed at triage. */
  expectedMinSeverity?: Severity;
  /** At least one of these playbooks is expected among
   * recommendedActions when the case escalates — "action
   * appropriateness" (AC2), not an exact-match requirement, since a
   * real model may reasonably choose between equally valid playbooks. */
  expectedPlaybooksAnyOf?: string[];
}

interface Template {
  category: CaseCategory;
  scenario: string;
  seedSeverity: Severity;
  seedBaseline: boolean;
  expectedTriageDisposition: ExpectedTriageDisposition;
  expectedMinSeverity?: Severity;
  expectedPlaybooksAnyOf?: string[];
  events: (entityId: string, country: string) => GoldenEventSeed[];
}

const TEMPLATES: Template[] = [
  {
    category: 'true_positive',
    scenario: 'sign-in from a new country followed by an inbox-forwarding rule (BEC)',
    seedSeverity: 'critical',
    seedBaseline: false,
    expectedTriageDisposition: 'bypass_critical',
    expectedMinSeverity: 'high',
    expectedPlaybooksAnyOf: ['revoke_sessions', 'delete_inbox_rule', 'force_password_reset'],
    events: (entityId, country) => [
      { entityId, message: `Sign-in from ${country}, a country never seen for this user`, srcCountry: country },
      { entityId, message: 'Inbox rule created: forward all mail to an external address' },
    ],
  },
  {
    category: 'true_positive',
    scenario: 'repeated failed sign-ins followed by a success from a new ASN',
    seedSeverity: 'high',
    seedBaseline: false,
    expectedTriageDisposition: 'escalate',
    expectedMinSeverity: 'medium',
    expectedPlaybooksAnyOf: ['revoke_sessions', 'force_password_reset', 'block_ip'],
    events: (entityId, country) => [
      { entityId, message: 'Five failed sign-in attempts within two minutes' },
      { entityId, message: `Successful sign-in from ${country} immediately after`, srcCountry: country },
    ],
  },
  {
    category: 'true_positive',
    scenario: 'MFA disabled, then a sign-in from a Tor exit node',
    seedSeverity: 'critical',
    seedBaseline: false,
    expectedTriageDisposition: 'bypass_critical',
    expectedMinSeverity: 'high',
    expectedPlaybooksAnyOf: ['revoke_sessions', 'disable_user', 'force_password_reset'],
    events: (entityId) => [
      { entityId, message: 'Multi-factor authentication was disabled for this account' },
      { entityId, message: 'Sign-in from a known anonymising proxy exit node' },
    ],
  },
  {
    category: 'true_positive',
    scenario: 'a new admin role granted to an account outside change-management hours',
    seedSeverity: 'high',
    seedBaseline: false,
    expectedTriageDisposition: 'escalate',
    expectedMinSeverity: 'medium',
    expectedPlaybooksAnyOf: ['disable_user', 'revoke_sessions'],
    events: (entityId) => [
      { entityId, message: 'Account granted global administrator role' },
      { entityId, message: 'Grant occurred outside the published change-management window' },
    ],
  },
  {
    category: 'false_positive',
    scenario: "a known service account's expected nightly batch job",
    seedSeverity: 'medium',
    seedBaseline: true,
    expectedTriageDisposition: 'dismiss',
    events: (entityId) => [{ entityId, message: 'Service account signed in and processed its scheduled nightly batch job' }],
  },
  {
    category: 'false_positive',
    scenario: "a frequent business traveller's recurring trip to a familiar country",
    seedSeverity: 'low',
    seedBaseline: true,
    expectedTriageDisposition: 'dismiss',
    events: (entityId, country) => [{ entityId, message: `Sign-in from ${country}, a country this user visits monthly for work`, srcCountry: country }],
  },
  {
    category: 'false_positive',
    scenario: 'a password reset initiated through the verified help-desk process',
    seedSeverity: 'low',
    seedBaseline: true,
    expectedTriageDisposition: 'dismiss',
    events: (entityId) => [{ entityId, message: 'Password reset completed after verified identity confirmation with the help desk' }],
  },
  {
    category: 'false_positive',
    scenario: "a new hire's first week of sign-ins from a personal device",
    seedSeverity: 'low',
    seedBaseline: true,
    expectedTriageDisposition: 'dismiss',
    events: (entityId) => [{ entityId, message: 'First sign-in from a new device during the first week of employment, device enrolled through onboarding' }],
  },
  {
    category: 'ambiguous',
    scenario: 'a sign-in from a new device, same country, no other anomaly',
    seedSeverity: 'medium',
    seedBaseline: false,
    expectedTriageDisposition: 'escalate',
    expectedMinSeverity: 'low',
    expectedPlaybooksAnyOf: ['force_password_reset', 'revoke_sessions'],
    events: (entityId) => [{ entityId, message: 'Sign-in from a device not previously seen for this user, same country as usual' }],
  },
  {
    category: 'ambiguous',
    scenario: 'an admin account used for an unusual but plausible manual task at an odd hour',
    seedSeverity: 'medium',
    seedBaseline: false,
    expectedTriageDisposition: 'escalate',
    expectedMinSeverity: 'low',
    expectedPlaybooksAnyOf: ['revoke_sessions', 'disable_user'],
    events: (entityId) => [{ entityId, message: 'Administrator account performed a one-off configuration change at 23:40 local time' }],
  },
];

function entityIdFor(templateIndex: number, variant: number): string {
  return `golden-entity-${templateIndex}-${variant}`;
}

const COUNTRIES = ['Russia', 'North Korea', 'Nigeria', 'Brazil', 'Vietnam'];

/** 50 cases: 10 templates x 5 parameter variations each. */
export function buildGoldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  TEMPLATES.forEach((template, templateIndex) => {
    for (let variant = 0; variant < 5; variant++) {
      const entityId = entityIdFor(templateIndex, variant);
      const country = COUNTRIES[variant % COUNTRIES.length]!;
      cases.push({
        id: `golden-${templateIndex}-${variant}`,
        category: template.category,
        scenario: template.scenario,
        seedSeverity: template.seedSeverity,
        entityId,
        events: template.events(entityId, country),
        seedBaseline: template.seedBaseline,
        expectedTriageDisposition: template.expectedTriageDisposition,
        ...(template.expectedMinSeverity ? { expectedMinSeverity: template.expectedMinSeverity } : {}),
        ...(template.expectedPlaybooksAnyOf ? { expectedPlaybooksAnyOf: template.expectedPlaybooksAnyOf } : {}),
      });
    }
  });
  return cases;
}

export const GOLDEN_CASES: GoldenCase[] = buildGoldenCases();
