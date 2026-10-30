import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as format from '../public/dashboard/format.js';
import { buildDashboardView } from '../lib/dashboard-view.mjs';
import { prepareDashboardControlUpdate, resolveDashboardConfig } from '../lib/dashboard-controls.mjs';
import { initialState } from '../lib/engine.mjs';
import { monthlyFixture } from './monthly-fixture.mjs';

// Exercise the actual page renderers with actual API projection objects. This
// deliberately does not claim browser layout or authenticated provider testing.
const source = readFileSync(new URL('../public/dashboard/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '').replace(/\nawait refresh\(\{initial:true\}\);\s*$/, '\n');
function renderer() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', hidden: false,
      addEventListener() {}, setAttribute() {}, toggleAttribute() {}, querySelectorAll: () => [] });
    return elements.get(selector);
  }
  const context = { ...format, esc: format.escapeHtml, document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {}, scrollTo() {} }, location: { hash: '#overview' } };
  runInNewContext(`${source}\nglobalThis.page = (snapshot, view) => { app.snapshot = snapshot; location.hash = '#' + view; render(); return root.innerHTML; };`, context);
  return context.page;
}
function snapshot({ state = initialState(), now = Date.parse('2030-01-02T15:00:00.000Z'), sectionErrors = {} } = {}) {
  const s = monthlyFixture({ mode: 'observe' });
  const config = resolveDashboardConfig(s.config, state, { now });
  return buildDashboardView({ config, state, now, sectionErrors,
    rothSummary: { annualLimitCents: null, previewAnnualLimitCents: 750000, monthlyAmountCents: 62500,
      remainingAnnualCents: null, blockers: ['ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED'] } });
}

test('current routes keep current percentages while the settings form shows pending future edits', () => {
  const s = monthlyFixture({ mode: 'observe' }), now = Date.parse('2030-01-02T15:00:00.000Z');
  const update = prepareDashboardControlUpdate({ config: s.config, state: initialState(), expectedRevision: 0,
    changes: { emergencyRateBasisPoints: 1200, projectRateBasisPoints: 900 }, now });
  const view = snapshot({ state: update.state, now }), page = renderer();
  const map = page(view, 'map');
  assert.match(map, /7\.5% of regular income, capped/);
  assert.match(map, /5% target after higher priorities/);
  assert.doesNotMatch(map, /12% of regular income/);
  assert.doesNotMatch(map, /9% target after/);
  const settings = page(view, 'settings');
  assert.match(settings, /Changes scheduled for February 2030/);
  assert.match(settings, /name="projectRateBasisPoints"[^>]+value="9\.00"/);
});

test('unknown ledger and balances remain explicitly unavailable rather than manufactured zero totals', () => {
  const view = snapshot({ sectionErrors: { ledger: 'STORE_READ_FAILED' } }), page = renderer();
  const overview = page(view, 'overview');
  assert.match(overview, /Transfers needing attention<\/div><div class="value ">—<\/div>/);
  assert.match(overview, /Saved cycle is unavailable/);
  assert.match(overview, /Activity is unavailable/);
  assert.match(overview, /Progress is unavailable until/);
  assert.doesNotMatch(overview, /class="w-0"/);
  assert.doesNotMatch(overview, /null in transit|No plan has been created/);
  const activity = page(view, 'activity');
  assert.match(activity, /Coordinator log is unavailable/);
  assert.match(activity, /Alert history is unavailable/);
  assert.doesNotMatch(activity, /No alerts recorded/);
});

test('Roth policy previews are identified as unverified and missing settings do not become a zero target', () => {
  const view = snapshot(), page = renderer();
  assert.match(page(view, 'overview'), /Annual policy preview · eligibility unverified: \$7,500\.00/);
  assert.match(page(view, 'overview'), /Monthly preview \$625\.00/);
  assert.doesNotMatch(page(view, 'overview'), /Annual contribution limit: \$7,500\.00/);
  view.settings.current.settings.generalMonthlyBudgetCents = null;
  view.settings.current.settings.generalReserveMonths = null;
  assert.match(page(view, 'settings'), /id="general-target-preview">—<\/strong>/);
});

test('coordinator activity displays retained real outcomes and states its coverage limit', () => {
  const state = initialState();
  state.monthly = { runHistory: [
    { at: '2030-01-01T15:00:00.000Z', mode: 'observe', status: 'blocked', code: 'INCOME_OPENING_UNVERIFIED',
      monthKey: '2030-01', submittedCount: 0, settledCount: 0 },
    { at: '2030-01-02T15:00:00.000Z', mode: 'live', status: 'pending', code: 'MONTHLY_TRANSFERS_PENDING',
      monthKey: '2030-01', submittedCount: 1, settledCount: 2 },
  ] };
  const html = renderer()(snapshot({ state }), 'activity');
  assert.match(html, /Coordinator checks/);
  assert.match(html, /2 retained/);
  assert.match(html, /INCOME_OPENING_UNVERIFIED/);
  assert.match(html, /MONTHLY_TRANSFERS_PENDING/);
  assert.match(html, /<td class="align-right amount">1<\/td><td class="align-right amount">2<\/td>/);
  assert.match(html, /bounded coordinator log/);
  assert.match(html, /Rejected requests before a ledger write/);
});
