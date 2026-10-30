// Synthetic policy only. These figures do not establish any user's eligibility.
export const ROTH_TEST_NOW = Date.parse('2026-10-29T20:00:00Z');
export function rothEnvelopeFixture() {
  return {
    schemaVersion: 1,
    policy: { schemaVersion: 1, id: 'roth-ira', timeZone: 'America/New_York', updatedAt: '2026-10-28T12:00:00.000Z',
      statutoryLimits: [{ year: 2026, baseLimitCents: 750000, catchUpLimitCents: 110000,
        verifiedAt: '2026-10-28T12:00:00.000Z', sourceUrls: ['https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits'] }],
      years: [{ year: 2026, catchUpEligible: null, eligibility: { status: 'unverified' },
        outsideContributions: { status: 'unverified' }, exclusiveCoordinator: { confirmed: false },
        otherSchedule: { status: 'unverified' } }],
    },
    evidence: { schemaVersion: 1, updatedAt: '2026-10-28T12:00:00.000Z', route: { status: 'unverified' }, upstream: { status: 'unverified' } },
  };
}
