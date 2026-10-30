import { escapeHtml as esc, money, decimalToInteger, integerToDecimal, percentage, count, countTotal, dateTime, monthName, titleCase } from './format.js';

const root = document.querySelector('#app');
const app = { snapshot: null, view: 'overview', csrf: null, refreshing: false, testingScheduler: false, simulation: null, activity: null, preview: null };
const LABELS = { income: 'Income Account', bills: 'Bills & Subscriptions', general: 'General Spending', emergency: 'Emergency Fund', roth: 'Roth IRA', project: 'Project Savings', personalInvestment: 'Personal Investments' };
const ALLOCATIONS = { bills: 'Bills & Subscriptions', 'general-spending': 'General Spending', 'emergency-fund': 'Emergency Fund', 'roth-ira': 'Roth IRA', 'project-savings': 'Project Savings', 'personal-investment': 'Personal Investments', 'emergency-excess': 'Emergency excess return' };
const VIEWS = { overview: 'Overview', map: 'Money map', activity: 'Activity & health', simulator: 'Simulator', settings: 'Settings' };
const PURPOSES = { bills: 'Keep your recurring costs covered.', general: 'Gas, groceries, and everyday life.', emergency: 'Your financial breathing room.', roth: 'Build your retirement, month by month.', project: 'Make room for your next project.', personalInvestment: 'Put your remaining surplus to work.' };
const ICONS = {
  income: '<path d="M4 7h16v13H4zM3 7l9-4 9 4M8 11v5m4-5v5m4-5v5"/>',
  bills: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
  general: '<path d="M4 7h16v13H4zM8 7V5a4 4 0 018 0v2M8 11v2m8-2v2"/>',
  emergency: '<path d="M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM8 12l3 3 5-6"/>',
  roth: '<path d="M4 20h16M6 16V9m6 7V5m6 11v-6M4 6l8-3 8 3"/>',
  project: '<path d="M3 7h7l2 3h9v11H3zM3 7V4h7l2 3h7v3"/>',
  personalInvestment: '<path d="M4 19V5m0 14h16M7 14l4-4 4 2 5-7m-5 0h5v5"/>'
};
const accountIcon = role => `<span class="account-icon role-${role}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[role] ?? ICONS.income}</svg></span>`;
const STATES = { not_planned: ['Not planned', 'neutral'], planned: ['Planned', 'neutral'], estimate: ['Estimate', 'neutral'], submission_unknown: ['Submission uncertain', 'bad'], approval_required: ['Approval required', 'warn'], pending: ['In transit', 'warn'], complete: ['Settled', 'good'], not_needed: ['No transfer needed', 'neutral'], skipped: ['Skipped', 'warn'], failed: ['Failed', 'bad'], review_required: ['Needs review', 'bad'] };
const CODES = {
  INCOME_OPENING_UNVERIFIED: ['Verify opening funds', 'Confirm the opening Income balance and which funds are ordinary income, windfalls, or held for review.'],
  INCOME_PAYROLL_RULE_UNVERIFIED: ['Verify Navy pay classification', 'Review the exact payroll matching rule so bonuses are not classified as ordinary pay.'],
  INCOME_PAYROLL_CLASSIFICATION_AMBIGUOUS: ['Resolve payroll overlap', 'Two income classification rules could match the same payment.'],
  INCOME_CLASSIFICATION_REQUIRED: ['Review an unclassified deposit', 'The funds are held until their source and treatment are confirmed.'],
  ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED: ['Confirm Roth eligibility', 'The contribution plan needs verified personal eligibility for the tax year.'],
  ROTH_OUTSIDE_CONTRIBUTIONS_UNVERIFIED: ['Confirm outside IRA contributions', 'Contributions made elsewhere must be included in the annual limit.'],
  ROTH_EXCLUSIVE_COORDINATOR_UNCONFIRMED: ['Confirm contribution ownership', 'Confirm which system is responsible for contributions to avoid duplicates.'],
  ROTH_OTHER_SCHEDULE_UNVERIFIED: ['Review existing Roth schedules', 'Other scheduled contributions need to be reconciled with this coordinator.'],
  ROTH_CONTRIBUTION_BASELINE_UNVERIFIED: ['Verify Roth contributions to date', 'The investment account balance is not the amount contributed this year.'],
  SEQUENCE_RULE_VISIBILITY_UNVERIFIED: ['Verify Sequence rule visibility', 'Activation needs a recorded check that the API key can inspect all relevant rules.'],
  SEQUENCE_AUTHORITY_UNVERIFIED: ['Verify unattended transfer authority', 'Review Sequence API permissions, approval requirements, and transfer limits.'],
  SEQUENCE_AUTOMATIC_APPROVAL_REQUIRED: ['Sequence requires transfer approval', 'The current key requires approval before transfers can execute unattended.'],
  SEQUENCE_UNATTENDED_APPROVAL_UNVERIFIED: ['Verify unattended approval', 'The current evidence does not yet confirm automatic approval for this coordinator.'],
  MONTHLY_ALERT_DELIVERY_REQUIRED: ['Complete email alert setup', 'Configure the email provider, send the setup test, and confirm receipt.'],
  MONTHLY_EXECUTION_DAY_ONLY: ['Outside the execution day', 'New transfers wait for the configured monthly execution window.'],
  MONTHLY_FIRST_DAY_ONLY: ['Outside the execution day', 'New transfers wait for the configured monthly execution window.'],
  BILLS_MONITOR_STALE: ['Refresh bill monitoring', 'The bill review must be current before a new plan can execute.'],
  DASHBOARD_SESSION_INVALID: ['Session expired', 'Reload this page to open a new protected dashboard session.'],
  DASHBOARD_SETTINGS_CONFLICT: ['Settings changed elsewhere', 'Reload the current revision before reviewing your changes again.'],
  DASHBOARD_SETTINGS_PREVIEW_EXPIRED: ['The reviewed execution month changed', 'Review the settings again to confirm their new effective month. Nothing was saved.'],
  SCHEDULER_PROBE_COOLDOWN: ['A scheduler test was recently started', 'Wait ten minutes between tests. Refresh to check the existing result.'],
  SCHEDULER_PROBE_PENDING: ['Scheduler test is waiting', 'The queued health check has not completed yet.'],
  DASHBOARD_WORKER_ACTIVE: ['A financial run is in progress', 'Wait for the current operation to finish, then review the settings again.'],
  DASHBOARD_ACTIVITY_CHANGED: ['The activity record changed', 'Reload activity to continue from the latest saved record.']
};
const controlFields = [
  { key: 'generalMonthlyBudgetCents', label: 'Monthly spending budget', type: 'money', help: 'Gas, groceries, and everyday spending.' },
  { key: 'generalReserveMonths', label: 'Months of spending to hold', type: 'integer', min: 1, help: 'Budget × reserve months = General Spending target.' },
  { key: 'emergencyTargetCents', label: 'Emergency Fund cap', type: 'money', help: 'Excess is returned directly to Income.' },
  { key: 'incomeReserveCents', label: 'Minimum cash kept in Income', type: 'money', help: 'Reserved cash is unavailable to allocations.' },
  { key: 'emergencyRateBasisPoints', label: 'Emergency Fund contribution', type: 'percent', max: 100, help: 'Percentage of the opening regular-income pool.' },
  { key: 'projectRateBasisPoints', label: 'Project Savings contribution', type: 'percent', max: 100, help: 'Same opening pool; funded after Roth IRA.' },
  { key: 'executionDay', label: 'Monthly execution day', type: 'integer', min: 1, max: 28, help: 'January–November. Runs begin at 15:00 UTC.' },
  { key: 'decemberDay', label: 'December execution day', type: 'integer', min: 1, max: 15, help: 'Annual shortfall recovery and windfall distribution.' }
];
const list = value => Array.isArray(value) ? value : [];
const badge = (text, tone = 'neutral') => `<span class="pill ${esc(tone)}">${esc(text)}</span>`;
const status = value => badge(...(STATES[value] ?? [titleCase(value), 'neutral']));
const codeInfo = code => CODES[code] ?? [titleCase(code), 'This check needs attention before the next eligible transfer.'];
const account = role => app.snapshot?.accounts?.find(row => row.role === role) ?? { role, label: LABELS[role] };
const settings = () => app.snapshot?.settings?.pending?.at(-1)?.settings ?? app.snapshot?.settings?.current?.settings ?? {};
const currentSettings = () => app.snapshot?.settings?.current?.settings ?? {};
const knownAmount = value => Number.isSafeInteger(value) && value >= 0;
const rothLimitLabel = data => knownAmount(data.annualLimitCents) ? 'Verified personal annual limit' : 'Annual policy preview · eligibility unverified';
const rothMonthlyLabel = data => knownAmount(data.annualLimitCents) ? 'Monthly' : 'Monthly preview';
function generalTarget(values) {
  if (!knownAmount(values.generalMonthlyBudgetCents) || !Number.isSafeInteger(values.generalReserveMonths) || values.generalReserveMonths < 1) return null;
  const product = BigInt(values.generalMonthlyBudgetCents) * BigInt(values.generalReserveMonths);
  return product <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(product) : null;
}
const codeItem = code => { const [title, detail] = codeInfo(code); return `<li><span class="check-dot">!</span><div><strong>${esc(title)}</strong><p>${esc(detail)}</p><code>${esc(code)}</code></div></li>`; };
const empty = (title, description, icon = '○') => `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><strong>${esc(title)}</strong><p>${esc(description)}</p></div>`;
const metric = (label, value, detail, extra = '') => `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${extra}">${esc(value)}</div><div class="detail">${esc(detail)}</div></article>`;
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(app.toastTimer); app.toastTimer = setTimeout(() => { el.hidden = true; }, 6000); }
function notice(message) { const el = document.querySelector('#notice'); el.textContent = message ?? ''; el.hidden = !message; }
function errorText(error) { return CODES[error.code]?.join('. ') ?? `${error.message || 'The request could not be completed.'}${error.code ? ` (${error.code})` : ''}`; }
async function request(path, body) {
  const options = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(90000) };
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.headers['X-CSRF-Token'] = app.csrf ?? ''; options.body = JSON.stringify(body); }
  const response = await fetch(path, options);
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('Your private session needs to be reopened. Reload this page and sign in with your Vercel account.'), { code: 'DASHBOARD_SIGN_IN_REQUIRED' });
  const data = await response.json();
  if (!response.ok || data.error) throw Object.assign(new Error('The request could not be completed.'), { code: data.code ?? data.error?.code ?? data.error, status: response.status });
  if (data.csrfToken) app.csrf = data.csrfToken;
  return data;
}
function header(title, subtitle, buttons = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(monthName(app.snapshot?.schedule?.currentMonthKey))}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${buttons ? `<div class="button-row">${buttons}</div>` : ''}</div>`;
}
function personalGreeting() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, Jeff.`;
}
function personalPlan() {
  const v = currentSettings();
  return `<section class="panel personal-plan" aria-labelledby="personal-plan-title"><div class="panel-head"><div><div class="eyebrow">YOUR MONTHLY ROUTINE</div><h2 id="personal-plan-title">The plan you’ve chosen</h2><p>Your current settings, before any future changes take effect.</p></div><a class="button quiet" href="#settings">Adjust my plan <span aria-hidden="true">→</span></a></div><div class="personal-priorities"><div><span class="personal-step">01 / EVERYDAY LIFE</span><h3>Bills first. Life covered.</h3><p>${money(v.generalMonthlyBudgetCents)} monthly spending budget, with ${money(generalTarget(v))} as your General Spending target.</p></div><div><span class="personal-step">02 / PEACE OF MIND</span><h3>Keep building your buffer.</h3><p>${percentage(v.emergencyRateBasisPoints)} of regular income goes toward Emergency, up to your ${money(v.emergencyTargetCents)} cap, after Bills and General.</p></div><div><span class="personal-step">03 / WHAT’S NEXT</span><h3>Make steady room for the future.</h3><p>Eligible Roth funding comes next, then your ${percentage(v.projectRateBasisPoints)} Project Savings target and remaining investment surplus.</p></div></div><p class="personal-plan-note">These are your allocation priorities. A saved target doesn’t mean a transfer has settled.</p></section>`;
}
function modeBanner() {
  const s = app.snapshot;
  if (s.system.executionEnabled) return `<div class="banner"><span class="banner-icon" aria-hidden="true">✓</span><div><strong>Automation is enabled</strong><p>New transfers remain subject to the saved schedule, verified inputs, and priority checks.</p></div></div>`;
  return `<div class="banner"><span class="banner-icon" aria-hidden="true">Ⅱ</span><div><strong>${s.system.mode === 'observe' ? 'Observe mode · live transfers are off' : 'Live transfers are off'}</strong><p>Your dashboard can inspect, simulate, and save settings. Activation is a separate deliberate step after the remaining checks pass.</p></div></div>`;
}
function readinessPanel(full = false) {
  const r = app.snapshot.readiness, blockers = list(r.blockers), shown = full ? blockers : blockers.slice(0, 4);
  const heading = r.status === 'not_checked' ? 'Readiness not checked' : blockers.length ? `${blockers.length} checks need attention` : r.readyForActivation ? 'Ready for your activation decision' : 'Activation readiness';
  return `<section class="panel"><div class="panel-head"><div><h2>${heading}</h2><p>Evidence required before unattended transfers.</p></div>${badge(blockers.length ? 'Blocked' : r.readyForActivation ? 'Ready' : 'Not checked', blockers.length ? 'warn' : r.readyForActivation ? 'good' : 'neutral')}</div>${shown.length ? `<ul class="check-list">${shown.map(codeItem).join('')}</ul>` : empty('Readiness is evidence-based', r.status === 'not_checked' ? 'Run diagnostics to inspect the current setup without moving money.' : 'The most recent check did not report a remaining blocker. Activation will recheck the evidence.')}${!full && blockers.length > 4 ? `<a class="button quiet" href="#activity">View all ${blockers.length} checks →</a>` : ''}<p class="subtle">Checked ${esc(dateTime(r.checkedAt))}</p></section>`;
}
function annualItem(label, data) {
  const target = data.targetThroughRecordedMonthsCents;
  const progressKnown = knownAmount(target) && knownAmount(data.settledCents);
  const pct = progressKnown && target > 0 ? Math.min(100, Math.max(0, data.settledCents / target * 100)) : 0;
  const progress = progressKnown ? `<div class="progress" role="img" aria-label="${esc(label)} settled ${money(data.settledCents)} of ${money(target)} recorded obligation"><span class="w-${Math.round(pct)}"></span></div>` : '<p class="subtle check-section">Progress is unavailable until the recorded target and settlement totals are known.</p>';
  return `<div class="annual-item"><div class="row"><h3>${esc(label)}</h3><span class="annual-meta">${esc(data.year)}</span></div><div class="row"><span class="annual-value">${money(data.settledCents)}</span><span class="subtle">settled by coordinator</span></div>${progress}<div class="row annual-meta"><span>Recorded target ${money(target)}</span><span>Shortfall ${money(data.outstandingCents)}</span></div><div class="row annual-meta"><span>In transit ${money(data.pendingCents)}</span><span>Review ${money(data.reviewCents)}</span></div>${label === 'Roth IRA' ? `<p class="subtle">${esc(rothLimitLabel(data))}: ${money(data.annualLimitCents ?? data.previewAnnualLimitCents)}. Outside contributions require separate verification.</p>` : ''}</div>`;
}
function overview() {
  const s = app.snapshot, income = account('income'), next = s.schedule;
  return header(personalGreeting(), 'Your bills, everyday spending, savings, and investments. One plan, built around you.', `<button class="button" data-action="refresh">${app.refreshing ? '<span class="spinner-inline"></span> Checking…' : '↻ Refresh & check'}</button><a class="button primary" href="#simulator">Run a simulation <span aria-hidden="true">↗</span></a>`) + modeBanner() +
    `<div class="overview-hero"><section class="liquidity-card" aria-labelledby="income-title"><div class="hero-kicker">${accountIcon('income')}<span id="income-title">Available in Income</span><span class="hero-currency">USD</span></div><div class="hero-balance">${money(income.availableBalanceCents)}</div><p class="hero-caption">${income.balanceStatus === 'unavailable' ? 'Balance unavailable · refresh to check your account' : `${income.balanceStatus === 'stale' ? 'Older snapshot · ' : ''}Posted balance ${money(income.balanceCents)} · ${esc(dateTime(income.balanceAsOf, { dateOnly: true }))}`}</p><div class="hero-pools"><div><span>Regular funds available</span><strong>${money(s.income.availableRegularCents)}</strong></div><div><span>Windfalls held for December</span><strong>${money(s.income.windfallHeldCents)}</strong></div></div><a class="hero-link" href="#map">Explore your money map <span aria-hidden="true">↗</span></a></section><section class="schedule-card" aria-labelledby="next-window-title"><div class="schedule-kicker"><span class="calendar-icon" aria-hidden="true">◷</span> MONTHLY SCHEDULE</div><h2 id="next-window-title">Next monthly window</h2><div class="schedule-date">${next.dueAt ? esc(dateTime(next.dueAt, { dateOnly: true })) : 'Not available'}</div><p>${next.dueAt ? esc(dateTime(next.dueAt)) + ' · New York' : 'Schedule requires a valid configuration'}</p><div class="schedule-foot"><span>${s.system.executionEnabled ? 'Subject to readiness checks' : 'Transfers remain off'}</span><a href="#settings" class="button quiet">Review schedule <span aria-hidden="true">→</span></a></div></section></div>` +
    `<div class="metrics overview-metrics">${metric('Current cycle · planned', money(s.cycle.totalPlannedCents), s.cycle.kind === 'frozen' ? `${monthName(s.cycle.monthKey)} · frozen plan` : s.cycle.kind === 'unavailable' ? 'Saved cycle is unavailable' : 'No plan has been created for this month')}${metric('Income · protected reserve', money(s.income.incomeReserveCents), 'Kept in Income, outside allocations')}${metric('Transfers needing attention', countTotal([s.system.reviewCount,s.system.uncertainCount]), `${count(s.system.pendingCount)} in transit · ${count(s.system.uncertainCount)} uncertain`)}</div>` +
    `${personalPlan()}<section class="panel accounts-panel"><div class="panel-head"><div><div class="eyebrow">YOUR MONEY, WITH A PURPOSE</div><h2>Your accounts. Your priorities.</h2><p>Posted cash balances and current funding targets.</p></div><a href="#map" class="button quiet">Open money map <span aria-hidden="true">↗</span></a></div><div class="account-summary">${['bills','general','emergency','roth','project','personalInvestment'].map((role,index) => { const a = account(role); return `<article class="mini-account role-${role}"><div class="account-card-head">${accountIcon(role)}<span class="account-order">${String(index+1).padStart(2,'0')}</span></div><div class="label">${esc(LABELS[role])}</div><p class="account-purpose">${esc(PURPOSES[role])}</p><div class="amount">${money(a.balanceCents)}</div><p class="subtle">${a.balanceStatus === 'unavailable' ? 'Balance unavailable' : `${a.balanceStatus === 'stale' ? 'Older snapshot · ' : ''}${dateTime(a.balanceAsOf, { dateOnly: true })}`}</p><div class="target-line">${a.targetCents !== null && a.targetCents !== undefined ? `Target ${money(a.targetCents)}` : role === 'roth' ? `${rothMonthlyLabel(s.annual.roth)} ${money(s.annual.roth.monthlyAmountCents)}` : role === 'project' ? `${percentage(currentSettings().projectRateBasisPoints)} of regular income` : 'Receives eligible surplus'}</div></article>`; }).join('')}</div></section>` +
    `<div class="two-col">${readinessPanel()}<section class="panel"><div class="panel-head"><div><h2>Annual progress</h2><p>Recorded obligations, settlement, and shortfalls.</p></div></div>${annualItem('Roth IRA', s.annual.roth)}${annualItem('Project Savings', s.annual.project)}</section></div>` +
    `<section class="panel"><div class="panel-head"><div><h2>Latest recorded activity</h2><p>Saved cycle and transfer milestones.</p></div><a href="#activity" class="button quiet">View activity →</a></div>${activityTable(s.activity.items.slice(0, 5), s.activity.code)}</section>`;
}
function mapView() {
  const s = app.snapshot, income = account('income'), v = s.income, flows = s.flows;
  const descriptions = { bills: 'Top up to the annual peak-month cap', general: 'Top up the everyday spending reserve', emergency: `${percentage(currentSettings().emergencyRateBasisPoints)} of regular income, capped`, roth: 'Monthly installment + eligible unpaid carry', project: `${percentage(currentSettings().projectRateBasisPoints)} target after higher priorities`, personalInvestment: 'Eligible surplus after all priorities' };
  return header('How your money finds its place', 'Follow your income from the essentials to your safety net, retirement, and what’s next.') + modeBanner() +
    `<section class="panel"><div class="panel-head"><div><h2>Income → priorities</h2><p>${s.cycle.kind === 'frozen' ? `Showing the saved ${monthName(s.cycle.monthKey)} plan.` : s.cycle.kind === 'unavailable' ? 'Showing the configured routes. The saved cycle could not be read.' : 'Showing the configured routes. No cycle has been planned yet.'}</p></div>${badge(s.cycle.kind === 'frozen' ? 'Saved plan' : 'Configured routes')}</div><div class="legend"><span><i class="dash"></i> Configured route</span><span><i class="green"></i> Settlement is shown separately</span><span>Priority 1 receives funds first</span></div><div class="map-layout"><article class="income-node"><div class="node-kicker">Funding source</div><h3>Income Account</h3><div class="balance">${money(income.availableBalanceCents)}</div><p class="subtle">Available · posted ${money(income.balanceCents)}</p><div class="pool-list"><div><span>Regular funds</span><span class="amount">${money(v.availableRegularCents)}</span></div><div><span>Current-year windfalls</span><span class="amount">${money(v.windfallHeldCents)}</span></div><div><span>Prior-year funds held</span><span class="amount">${money(v.priorYearWindfallHeldCents)}</span></div><div><span>Needs classification</span><span class="amount">${money(v.unknownHeldCents)}</span></div><div><span>Income reserve</span><span class="amount">${money(v.incomeReserveCents)}</span></div></div></article><svg class="map-lines" viewBox="0 0 100 600" preserveAspectRatio="none" aria-label="Income funds six accounts in priority order; Emergency excess returns to Income" role="img"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8fae98" stroke="none"/></marker></defs>${[45,147,249,351,453,555].map(y=>`<path d="M0 300 C50 300,45 ${y},98 ${y}" marker-end="url(#arrow)"/>`).join('')}<path class="return" d="M100 265 C30 265,60 323,2 323" marker-end="url(#arrow)"/></svg>${['bills','general','emergency','roth','project','personalInvestment'].map((role,index) => { const a = account(role), flow = flows.find(f=>f.destinationRole === role); return `<article class="map-node"><span class="priority">${index+1}</span><div><h3>${esc(LABELS[role])}</h3><p>${esc(descriptions[role])}</p><div class="flow-detail">${flow?.plannedCents !== null && flow?.plannedCents !== undefined ? `Planned ${money(flow.plannedCents)} · settled ${money(flow.settledCents)}` : a.targetCents !== null ? `Target ${money(a.targetCents)}` : 'Waiting for an eligible cycle'}</div></div><div class="node-right"><div class="amount">${money(a.balanceCents)}</div><small>${a.balanceStatus === 'unavailable' ? 'Balance unavailable' : a.balanceStatus === 'stale' ? 'Older posted balance' : 'Posted balance'}</small></div></article>`; }).join('')}</div><div class="map-note"><strong>Emergency excess flows back to Income.</strong> The coordinator caps Emergency savings using posted cash plus incoming commitments. Windfalls and unclassified funds are ledger categories inside Income; they do not require buffer accounts. December windfalls cover eligible Roth and Project shortfalls before Personal Investments.</div></section>` +
    `<section class="panel"><div class="panel-head"><div><h2>Transfer status by route</h2><p>A plan is not a submitted transfer. A submitted transfer is not yet settled.</p></div></div>${flowTable(flows)}</section>`;
}
function flowTable(flows, simulation = false) {
  if (!flows?.length) return empty('No transfer plan yet', 'The configured routes will receive amounts when an eligible cycle is planned.');
  return `<div class="table-wrap"><table><thead><tr><th>Priority / destination</th><th>${simulation ? 'Result' : 'Status'}</th><th class="align-right">${simulation ? 'Estimate' : 'Planned'}</th>${simulation ? '<th class="align-right">From windfalls</th>' : '<th class="align-right">Submitted</th><th class="align-right">Settled</th>'}</tr></thead><tbody>${flows.map(f=>`<tr><td><strong>${f.priority ? `${f.priority}. ` : '↩ '}${esc(LABELS[f.destinationRole] ?? ALLOCATIONS[f.allocationId] ?? 'Allocation')}</strong><p class="subtle">${esc(f.allocationId === 'emergency-excess' ? 'Emergency excess return' : titleCase(f.planReason ?? 'Awaiting plan'))}</p></td><td>${status(f.executionStatus)}</td><td class="align-right amount">${money(f.plannedCents)}</td>${simulation ? `<td class="align-right amount">${money(f.windfallCents)}</td>` : `<td class="align-right amount">${money(f.submittedCents)}</td><td class="align-right amount">${money(f.settledCents)}</td>`}</tr>`).join('')}</tbody></table></div>`;
}
function activityTable(rows, unavailableCode = null) {
  if (unavailableCode) return empty('Activity is unavailable', 'The saved ledger could not be read. Refresh to check it again; no zero activity total is assumed.');
  if (!rows?.length) return empty('No financial runs recorded yet', 'Saved cycle and transfer milestones will appear here when the coordinator creates a cycle. Refresh and diagnostics checks do not create fake financial runs.', '≡');
  return `<div class="table-wrap"><table><thead><tr><th>Event</th><th>When</th><th>Status</th><th class="align-right">Amount</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${esc(row.kind === 'cycle' ? `${monthName(row.monthKey)} cycle` : ALLOCATIONS[row.allocationId] ?? 'Transfer')}</strong><p class="subtle">${esc(row.code ?? row.planReason ?? (row.kind === 'cycle' ? `${row.skippedCount ?? 0} skipped · ${row.noTransferCount ?? 0} no transfer needed` : 'Recorded allocation'))}</p></td><td>${esc(dateTime(row.at))}</td><td>${row.kind === 'cycle' ? badge(titleCase(row.status ?? 'Unknown'), row.status === 'REVIEW' ? 'warn' : 'neutral') : status(row.executionStatus)}</td><td class="align-right amount">${money(row.plannedCents)}</td></tr>`).join('')}</tbody></table></div>`;
}
function runsPanel(runs) {
  const unavailable = !runs || runs.status === 'unavailable' || runs.code;
  const rows = list(runs?.items);
  const content = unavailable ? empty('Coordinator log is unavailable', 'Refresh to read the retained coordinator checks. No missing checks are counted as successful.') : !rows.length
    ? empty('No coordinator checks retained yet', 'Scheduled reconciliation checks will appear here as they are durably recorded. Read-only dashboard diagnostics do not create financial runs.')
    : `<div class="table-wrap"><table><thead><tr><th>When / month</th><th>Mode / result</th><th>Outcome</th><th class="align-right">Newly accepted</th><th class="align-right">Newly settled</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${esc(dateTime(row.at))}</strong><p class="subtle">${esc(monthName(row.monthKey))}</p></td><td>${badge(titleCase(row.status), ['blocked','review','uncertain'].includes(row.status) ? 'warn' : row.status === 'complete' ? 'good' : 'neutral')}<p class="subtle">${esc(titleCase(row.mode))}</p></td><td><code class="muted-code">${esc(row.code ?? 'Not recorded')}</code></td><td class="align-right amount">${count(row.submittedCount)}</td><td class="align-right amount">${count(row.settledCount)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<section class="panel"><div class="panel-head"><div><h2>Coordinator checks</h2><p>Up to the latest ${count(runs?.limit ?? 100)} retained checks. Counts describe transfers newly accepted or settled during that check.</p></div><span class="subtle">${count(runs?.storedCount)} retained</span></div>${content}<p class="subtle check-section">${runs?.retentionReached ? 'The retention limit has been reached; older checks may have been removed. ' : ''}This is a bounded coordinator log. Rejected requests before a ledger write and all server invocations are not represented here.</p></section>`;
}
function schedulerPanel() {
  const probe=app.snapshot.tests.scheduler ?? {status:'not_run'}, completed=probe.status==='completed';
  const labels={not_run:'Not tested',pending:'Preparing',queued:'Queued',unknown:'Awaiting confirmation',completed:'Delivery verified',expired:'Test expired',unverified:'Needs a fresh test'};
  return `<section class="panel"><div class="panel-head"><div><h2>Scheduler delivery test</h2><p>Verify that a queued check reaches this protected deployment.</p></div>${badge(labels[probe.status]??titleCase(probe.status),completed?'good':['expired','unknown','unverified'].includes(probe.status)?'warn':'neutral')}</div><div class="key-values"><div class="row"><span>Test target</span><strong>Health endpoint only</strong></div><div class="row"><span>Requested</span><strong>${esc(dateTime(probe.queuedAt))}</strong></div><div class="row"><span>Verified delivery</span><strong>${esc(dateTime(probe.completedAt))}</strong></div></div>${probe.code?`<p class="muted-code check-section">${esc(probe.code)}</p>`:''}<div class="button-row check-section"><button class="button" data-action="scheduler-test" ${app.testingScheduler||app.snapshot.system.executionEnabled?'disabled':''}>${app.testingScheduler?'<span class="spinner-inline"></span> Waiting for delivery…':'Test scheduler'}</button><span class="subtle">${app.snapshot.system.executionEnabled?'Setup tests are available while live transfers are off.':'Usually takes about a minute.'}</span></div><p class="subtle check-section">This test cannot request transfers or send email. Delivery verification is separate from financial readiness. A new deployment needs a fresh test.</p></section>`;
}
function testsPanel() {
  const s = app.snapshot, offline = s.tests.offline, provider = s.tests.provider;
  return `<section class="panel"><div class="panel-head"><div><h2>Testing & diagnostics</h2><p>Read-only checks and recorded test results.</p></div></div>${s.diagnosticSummary ? `<div class="diagnostic-summary"><strong>Last diagnostic:</strong> ${esc(dateTime(s.diagnosticSummary.checkedAt))}. ${esc(titleCase(s.diagnosticSummary.status))}. No transfers or financial ledger writes.</div>` : ''}<div class="key-values"><div class="row"><span>Offline financial rehearsal</span>${badge(offline.status === 'not_run' ? 'No receipt loaded' : titleCase(offline.status), offline.status === 'passed' ? 'good' : 'neutral')}</div>${offline.status !== 'not_run' ? `<div class="row"><span>Scenarios / software version</span><strong>${esc(offline.scenarioCount)} / ${esc(offline.softwareVersion)}</strong></div>` : ''}<div class="row"><span>Provider route simulation</span>${badge(provider.status === 'not_run' ? 'No receipt loaded' : titleCase(provider.status), provider.status === 'passed' ? 'good' : 'neutral')}</div><div class="row"><span>Unattended approval</span><strong>Separate verification required</strong></div><div class="row"><span>Last recorded coordinator check</span><strong>${esc(dateTime(s.system.lastRun?.at))}</strong></div></div><div class="button-row check-section"><button class="button primary" data-action="refresh">${app.refreshing ? 'Checking…' : 'Run read-only diagnostics'}</button><button class="button" data-action="debug">Download debug report</button></div><details><summary>What these tests establish</summary><p>Offline tests check priority math, timing, carry, and failure handling using synthetic data. Provider simulations check supported routes without moving money. Neither proves a real transfer will be automatically approved or settled.</p><p>The debug download removes credentials, provider IDs, and private evidence. It still contains financial settings and amounts; review it before sharing.</p></details></section>`;
}
function activityView() {
  const s = app.snapshot, activity = app.activity ?? s.activity;
  return header('What’s happening with your plan', 'Your transfers, recent checks, and anything that needs your attention.', '<button class="button" data-action="refresh">↻ Refresh & check</button>') +
    `<div class="two-col">${readinessPanel(true)}<div>${testsPanel()}${schedulerPanel()}</div></div>` + runsPanel(s.runs) +
    `<section class="panel"><div class="panel-head"><div><h2>Cycle & transfer activity</h2><p>Recorded milestones across saved cycles. A complete server invocation log is available in Vercel.</p></div><span class="subtle">${count(activity.totalCount)} recorded items</span></div>${activityTable(activity.items, activity.code)}${activity.hasMore ? '<button class="button" data-action="more-activity">Load more activity</button>' : ''}</section>` +
    `<section class="panel"><div class="panel-head"><div><h2>Alerts</h2><p>Email provider acceptance and inbox receipt are separate.</p></div><span class="subtle">${count(s.alerts.totalCount)} alerts</span></div>${s.alerts.code ? empty('Alert history is unavailable', 'Refresh to read the saved alert ledger. Missing history is not a confirmation that no alerts exist.') : s.alerts.items.length ? `<ul class="check-list">${s.alerts.items.map(a=>`<li><span class="check-dot">!</span><div><strong>${esc(codeInfo(a.code)[0])}</strong><p>${esc(dateTime(a.createdAt))} · ${esc(titleCase(a.severity))} · ${esc(titleCase(a.deliveryStatus))} · inbox receipt unverified</p><code>${esc(a.code)}</code>${a.shortfallCents !== null ? `<p>Shortfall ${money(a.shortfallCents)}</p>` : ''}</div></li>`).join('')}</ul>` : empty('No alerts recorded', 'Any recorded shortage, classification issue, or failed transfer alert will appear here.')}</section>`;
}
function inputField({key,label,type='money',help='',value='',min=0,max,required=true}) {
  const step = ['money','percent'].includes(type) ? '0.01' : '1';
  const prefix = type === 'money' ? '$' : type === 'percent' ? '%' : null;
  const formatted = Number.isSafeInteger(value) && ['money','percent'].includes(type) ? integerToDecimal(value) : value ?? '';
  return `<div class="field"><label for="field-${esc(key)}">${esc(label)}</label><div class="${prefix ? 'input-shell' : ''}">${prefix ? `<span aria-hidden="true">${prefix}</span>` : ''}<input id="field-${esc(key)}" name="${esc(key)}" type="${type === 'month' ? 'month' : 'number'}" ${type !== 'month' ? `min="${min}" ${max !== undefined ? `max="${max}"` : ''} step="${step}"` : ''} value="${esc(formatted)}" ${required ? 'required' : ''} inputmode="${type === 'integer' ? 'numeric' : 'decimal'}" aria-describedby="hint-${esc(key)}"></div><p class="hint" id="hint-${esc(key)}">${esc(help)}</p></div>`;
}
function simulatorView() {
  const monthKey = app.snapshot.schedule.monthKey ?? new Date().toISOString().slice(0,7);
  return header('What if your month looks different?', 'Try a different month of Navy pay, a bonus, or a change in spending. See how your plan responds.') +
    `<div class="banner"><span class="banner-icon">◇</span><div><strong>Simulation only · no money moves</strong><p>Uses the saved settings for the selected month. Inputs are hypothetical; pending transfers, eligibility, and live contribution history are not assumed.</p></div></div><section class="panel"><div class="panel-head"><div><h2>Build a scenario</h2><p>Enter opening regular funds, held windfalls, and destination balances.</p></div></div><form id="simulator-form"><div class="form-grid">${inputField({key:'monthKey',label:'Scenario month',type:'month',value:monthKey,help:'December includes annual windfall recovery.'})}${inputField({key:'regularIncomeCents',label:'Opening regular income',value:500000,help:'Ordinary Navy pay and verified regular funds.'})}${inputField({key:'windfallCents',label:'Held windfalls',value:0,help:'Current-year bonus or refund funds. Held until December.'})}${inputField({key:'billsBalanceCents',label:'Bills & Subscriptions balance',value:0,help:'Hypothetical balance before this top-up.'})}${inputField({key:'generalBalanceCents',label:'General Spending balance',value:0,help:'Hypothetical balance before this top-up.'})}${inputField({key:'emergencyBalanceCents',label:'Emergency Fund balance',value:1000000,help:'Excess return is shown separately; not assumed settled.'})}${inputField({key:'rothRemainingCents',label:'Remaining annual Roth room',value:'',required:false,help:'Optional scenario value. Blank assumes only the due amount.'})}${inputField({key:'rothCarryCents',label:'Unpaid Roth amount this year',value:0,help:'Same-year shortage. Prior-year carry is not accepted.'})}${inputField({key:'projectCarryCents',label:'Unpaid Project Savings this year',value:0,help:'Eligible shortfalls can be recovered from December windfalls.'})}</div><div class="form-actions"><span class="subtle">Current Bills and Roth policy is checked for the selected month.</span><button class="button primary" type="submit">Calculate scenario →</button></div><p class="form-error" id="simulator-error" role="alert"></p></form></section><div id="simulation-result" class="sim-results">${app.simulation ? simulationResult(app.simulation) : ''}</div>`;
}
function simulationResult(result) {
  const p = result.plan;
  return `<section class="panel"><div class="panel-head"><div><h2>${esc(monthName(result.inputs.monthKey))} · scenario result</h2><p>Estimated allocation with saved settings. No financial state changed.</p></div>${badge('Hypothetical')}</div><div class="sim-summary">${metric('Planned outgoing funds',money(p.totalPlannedCents),'Allocated by priority')}${metric('Regular funds held',money(p.heldRegularCents),'Unallocated or reserved')}${metric('Windfalls still held',money(p.heldWindfallCents),'Waiting for eligible use')}</div>${flowTable(result.flows,true)}${result.emergencyExcessEstimateCents > 0 ? `<div class="map-note">Estimated Emergency return: <strong>${money(result.emergencyExcessEstimateCents)}</strong>. It is not counted as spendable Income until settlement is verified.</div>` : ''}${list(p.blockers).length ? `<ul class="check-list">${p.blockers.map(codeItem).join('')}</ul>` : ''}<p class="schedule-line">Scenario window begins ${esc(dateTime(result.schedule.dueAt))}. This is an estimate, not a transfer instruction.</p><details><summary>Assumptions and limits</summary><p>Balances and shortfalls are the amounts you entered. Pending transfers are excluded. Roth eligibility is hypothetical, and outside contributions are not inferred. Unknown future annual limits remain unavailable. This calculation does not predict provider approval or settlement timing.</p></details></section>`;
}
function settingsView() {
  const s = app.snapshot, values = settings(), pending = s.settings.pending.at(-1), bills=s.bills;
  const peak = Math.max(1,...bills.months.map(m=>m.totalCents??0));
  return header('Make your plan fit your life', 'Adjust your spending room, safety net, savings split, or funding day. Review each change before it takes effect.') +
    `${pending ? `<div class="banner warning"><span class="banner-icon">◷</span><div><strong>Changes scheduled for ${esc(monthName(pending.effectiveMonth))}</strong><p>The form shows the latest saved future settings. Current and already-started cycles keep their own version.</p></div></div>` : ''}` +
    `<div class="two-col"><section class="panel"><div class="panel-head"><div><h2>Funding & schedule</h2><p>Revision ${esc(s.settings.revision)} · changes are reviewed before saving.</p></div></div><form id="settings-form"><div class="form-grid">${controlFields.map(f=>inputField({...f,value:values[f.key]})).join('')}</div><div class="computed"><div class="row"><span class="subtle">General Spending target</span><strong id="general-target-preview">${money(generalTarget(values))}</strong></div><div class="row"><span class="subtle">Monthly timing</span><strong>15:00 UTC · New York calendar</strong></div></div><div class="form-actions"><span class="subtle">Saving settings does not activate transfers.</span><button class="button primary" type="submit">Review changes →</button></div><p class="form-error" id="settings-error" role="alert"></p></form></section><div><section class="panel"><div class="panel-head"><div><h2>Automatically maintained</h2><p>Computed policies, with evidence checks.</p></div></div><div class="key-values"><div class="row"><span>Bills top-up cap</span><strong>${money(bills.targetCents)}</strong></div><div class="row"><span>Peak forecast month</span><strong>${money(bills.peakMonthCents)}</strong></div><div class="row"><span>Round up in increments of</span><strong>$500</strong></div><div class="row"><span>${esc(rothLimitLabel(s.annual.roth))}</span><strong>${money(s.annual.roth.annualLimitCents ?? s.annual.roth.previewAnnualLimitCents)}</strong></div><div class="row"><span>${esc(rothMonthlyLabel(s.annual.roth))} installment</span><strong>${money(s.annual.roth.monthlyAmountCents)}</strong></div></div>${bills.months.length && bills.months.every(m=>knownAmount(m.totalCents)) ? `<div class="bar-chart" role="img" aria-label="Monthly bills forecast">${bills.months.map(m=>`<div class="bar-column" title="${esc(monthName(m.month))}: ${money(m.totalCents)}"><div class="bar h-${Math.round(Math.max(2,(m.totalCents??0)/peak*100))} ${m.totalCents===peak?'peak':''}" data-bar-height="${Math.round(Math.max(2,(m.totalCents??0)/peak*100))}"></div><small>${esc(m.month?.slice(5))}</small></div>`).join('')}</div>` : ''}<details><summary>Why these are not manual sliders</summary><p>The Bills cap follows the reviewed annual bill forecast. The Roth limit follows the verified tax-year policy and personal eligibility. A dashboard edit cannot manufacture eligibility, contribution room, or a future IRS limit.</p></details></section><section class="panel"><h2>How changes take effect</h2><ul class="check-list"><li><span class="check-dot good">1</span><div><strong>Review the exact changes</strong><p>Preview the new targets and the server-selected effective month.</p></div></li><li><span class="check-dot good">2</span><div><strong>Keep active cycles consistent</strong><p>Once active, changes take effect from the next month. Frozen cycles retain their original settings.</p></div></li><li><span class="check-dot good">3</span><div><strong>Keep a permanent record</strong><p>Conflicting edits are rejected. Saved revisions record the previous and new values.</p></div></li></ul></section></div></div><section class="panel"><div class="panel-head"><div><h2>Settings history</h2><p>Recent saved revisions.</p></div></div>${s.settings.history.length ? `<div class="table-wrap"><table><thead><tr><th>Revision</th><th>Saved</th><th>Effective month</th><th>Changed fields</th></tr></thead><tbody>${s.settings.history.map(h=>`<tr><td>${esc(h.revision)}</td><td>${esc(dateTime(h.at))}</td><td>${esc(monthName(h.effectiveMonth))}</td><td>${controlFields.filter(f=>h.before[f.key]!==h.after[f.key]).map(f=>esc(f.label)).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : empty('Using the original settings', 'Your first saved change will create revision 1. No financial history is reset.')}</section>`;
}
function render() {
  app.view = Object.hasOwn(VIEWS,location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('[data-nav]').forEach(a=>a.toggleAttribute('aria-current',false));
  document.querySelector(`[data-nav="${app.view}"]`)?.setAttribute('aria-current','page');
  document.querySelector('#current-section').textContent = VIEWS[app.view];
  if (!app.snapshot) return;
  document.querySelector('#software-version').textContent = `v${app.snapshot.system.softwareVersion}`;
  const pill = document.querySelector('#mode-pill'); pill.className = `pill ${app.snapshot.system.executionEnabled ? 'good' : 'neutral'}`; pill.textContent = app.snapshot.system.executionEnabled ? 'Automation enabled' : app.snapshot.system.mode === 'observe' ? 'Observe mode · transfers off' : 'Live transfers are off';
  root.innerHTML = ({ overview, map:mapView, activity:activityView, simulator:simulatorView, settings:settingsView })[app.view]();
  document.querySelector('#snapshot-time').textContent = `Updated ${dateTime(app.snapshot.asOf)}`;
  root.querySelectorAll('[data-action="refresh"]').forEach(button=>button.disabled=app.refreshing);
}
async function refresh({ diagnostics = true, initial = false } = {}) {
  if (app.refreshing) return;
  app.refreshing = true; if (!initial) render();
  try {
    if (!app.snapshot || !app.csrf || !diagnostics) {
      app.snapshot = await request('/api/dashboard'); app.activity = null; render();
    }
    if (diagnostics) { app.snapshot = await request('/api/dashboard/diagnostics',{}); app.activity = null; }
    notice(null);
  } catch (error) {
    if (app.snapshot) notice(`The saved ledger remains visible. ${errorText(error)}`);
    else root.innerHTML = `<section class="panel"><div class="eyebrow">Private workspace</div><h1>We could not open the dashboard yet.</h1><p class="check-section">${esc(errorText(error))}</p><div class="button-row check-section"><button class="button primary" data-action="reload">Reload dashboard</button><a class="button" href="https://vercel.com/jeff-1465/finance-coordinator" rel="noreferrer">Open Vercel project</a></div><p class="subtle check-section">No transfer was requested by this page.</p></section>`;
  } finally { app.refreshing = false; if (app.snapshot) render(); }
}
async function testScheduler() {
  if(app.testingScheduler) return;
  app.testingScheduler=true;
  if(app.view==='activity') render();
  try {
    const result=await request('/api/dashboard/scheduler-test',{});
    app.snapshot.tests.scheduler=result.scheduler;
    if(app.view==='activity') render();
    toast('Scheduler test queued. It will visit only the health endpoint; no money moves.');
    for(let attempt=0;attempt<7;attempt+=1) {
      await new Promise(resolve=>setTimeout(resolve,15000));
      const snapshot=await request('/api/dashboard');
      app.snapshot.tests.scheduler=snapshot.tests.scheduler;
      if(app.view==='activity') render();
      if(snapshot.tests.scheduler.status==='completed') { toast('Scheduler delivery verified on this deployment. No transfer or email was requested.'); return; }
      if(['expired','unverified'].includes(snapshot.tests.scheduler.status)) { notice('The scheduler test needs review. Its recorded status is shown in Activity & Health.'); return; }
    }
    toast('Delivery has not been confirmed yet. Refresh Activity & Health to check the recorded result.');
  } catch(error) { notice(errorText(error)); }
  finally { app.testingScheduler=false; if(app.view==='activity') render(); }
}
function formValues(form, fields) {
  const data = new FormData(form), values = {};
  for (const field of fields) { const raw = data.get(field.key); if (!String(raw??'').trim() && field.required===false) continue; values[field.key] = field.type==='month' ? String(raw) : decimalToInteger(raw,field.type==='integer'?0:2); }
  return values;
}
function controlValue(key,value) { const field = controlFields.find(f=>f.key===key); return field?.type==='money' ? money(value) : field?.type==='percent' ? percentage(value) : count(value); }
async function reviewSettings(form) {
  const button=form.querySelector('button[type=submit]'), errorEl=document.querySelector('#settings-error'); button.disabled=true; errorEl.textContent='';
  try {
    const entered=formValues(form,controlFields), previous=settings(), changes=Object.fromEntries(Object.entries(entered).filter(([key,value])=>value!==previous[key]));
    if (!Object.keys(changes).length) { toast('There are no changes to save.'); return; }
    const body={ expectedRevision:app.snapshot.settings.revision, changes }, preview=await request('/api/dashboard/settings/preview',body);
    const view=preview.settings, selected=[...view.pending,view.current].find(v=>v.revision===view.revision);
    if (!selected) throw new Error('The server did not return a reviewable settings revision.');
    app.preview={body,settings:view,selected};
    const dialog=document.querySelector('#review-dialog'); dialog.innerHTML=`<div class="eyebrow">Review before saving</div><h2 id="review-title">Your updated plan</h2><p>These settings take effect in <strong>${esc(monthName(selected.effectiveMonth))}</strong>. Saving will not activate automation or change a frozen cycle.</p><div class="diff-row"><strong>Setting</strong><span>Previous</span><span>New</span></div>${controlFields.filter(f=>Object.hasOwn(changes,f.key)).map(f=>`<div class="diff-row"><strong>${esc(f.label)}</strong><span>${esc(controlValue(f.key,previous[f.key]))}</span><span>${esc(controlValue(f.key,changes[f.key]))}</span></div>`).join('')}<div class="computed"><div class="row"><span class="subtle">General Spending target</span><strong>${money(generalTarget(selected.settings))}</strong></div><div class="row"><span class="subtle">Saved revision</span><strong>${esc(view.revision)}</strong></div></div><p id="save-error" class="form-error" role="alert"></p><div class="form-actions"><button class="button" data-action="cancel-settings">Keep editing</button><button class="button primary" data-action="save-settings">Save reviewed changes</button></div>`; dialog.showModal();
  } catch(error) { errorEl.textContent=errorText(error); } finally { button.disabled=false; }
}
root.addEventListener('submit', async event => {
  event.preventDefault(); const form=event.target;
  if (form.id==='settings-form') { await reviewSettings(form); return; }
  if (form.id!=='simulator-form') return;
  const button=form.querySelector('button[type=submit]'), errorEl=document.querySelector('#simulator-error'); button.disabled=true; errorEl.textContent='';
  try {
    const fields=[...form.querySelectorAll('input')].map(input=>({key:input.name,type:input.type==='month'?'month':'money',required:input.required}));
    app.simulation=await request('/api/dashboard/simulate',{input:formValues(form,fields)});
    const result=document.querySelector('#simulation-result'); result.innerHTML=simulationResult(app.simulation); result.scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) { errorEl.textContent=errorText(error); } finally { button.disabled=false; }
});
root.addEventListener('input',event=>{
  if (!event.target.closest('#settings-form')) return;
  try { const form=document.querySelector('#settings-form'); const budget=decimalToInteger(form.elements.generalMonthlyBudgetCents.value); const months=decimalToInteger(form.elements.generalReserveMonths.value,0); document.querySelector('#general-target-preview').textContent=money(generalTarget({generalMonthlyBudgetCents:budget,generalReserveMonths:months})); } catch { document.querySelector('#general-target-preview').textContent='Enter valid amounts'; }
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action=button.dataset.action;
  if(action==='refresh') { await refresh(); return; }
  if(action==='scheduler-test') { await testScheduler(); return; }
  if(action==='reload') { location.reload(); return; }
  if(action==='cancel-settings') { document.querySelector('#review-dialog').close(); app.preview=null; return; }
  button.disabled=true;
  try {
    if(action==='save-settings' && app.preview) {
      const result=await request('/api/dashboard/settings',{...app.preview.body,expectedEffectiveMonth:app.preview.selected.effectiveMonth});
      const saved=result.settings, selected=[...list(saved?.pending),saved?.current].find(row=>row?.revision===saved?.revision);
      if (!saved || !selected) throw new Error('The save result is incomplete. Reload the current settings before trying another change.');
      const effectiveMonth=selected.effectiveMonth; app.snapshot.settings=saved; app.preview=null; document.querySelector('#review-dialog').close();
      await refresh({diagnostics:false}); toast(`Settings saved for ${monthName(effectiveMonth)}. Automation remains in its current mode.`);
    } else if(action==='debug') {
      const report=await request('/api/dashboard/debug'), blob=new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}), url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=`finance-debug-${new Date().toISOString().slice(0,10)}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Redacted debug report downloaded. Review financial amounts before sharing.');
    } else if(action==='more-activity') {
      const previous=app.activity??app.snapshot.activity, next=await request(`/api/dashboard/activity?limit=25&cursor=${encodeURIComponent(previous.nextCursor)}`); app.activity={...next,items:[...previous.items,...next.items]}; render();
    }
  } catch(error) { if(action==='save-settings') document.querySelector('#save-error').textContent=errorText(error); else notice(errorText(error)); }
  finally { button.disabled=false; }
});
window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
render();
await refresh({initial:true});
