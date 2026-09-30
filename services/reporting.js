'use strict';

// Pure aggregation for /api/reporting. No I/O: routes fetch rows and pass them in,
// so every function here is unit-testable with fixtures (tests/reporting.test.js).
//
// Time: all bucketing is in Philippine time (UTC+8, no DST). Weeks start Monday.
// [ASSUMPTION] Rows are aggregated in memory. Fine at current volume (~200 rows);
// move to SQL views/RPCs past ~10k applications.

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PIPELINE_STAGES = [
  'sales_officer',
  'verifier',
  'ci_officer',
  'approver',
  'loan_processing_officer',
];
const OPEN_STATUSES = ['pending', 'pending_sa_confirmation'];
const TIERS = ['approved', 'tier_b', 'declined'];
const PERIODS = { '30d': 30, '90d': 90, '12m': 365 };
const MONTHLY_SCHEME = 3;
const SEMI_MONTHLY_SCHEME = 3413;
const WEEKLY_SCHEME = 4;

// ── Time helpers (PH calendar) ────────────────────────────────────────────────

// Shifted Date whose UTC fields read as PH wall-clock fields.
function toPh(date) {
  return new Date(new Date(date).getTime() + PH_OFFSET_MS);
}

// PH calendar day as 'YYYY-MM-DD'.
function phDay(date) {
  return toPh(date).toISOString().slice(0, 10);
}

// PH calendar month as 'YYYY-MM'.
function phMonth(date) {
  return phDay(date).slice(0, 7);
}

// Monday (PH) of the week containing `date`, as 'YYYY-MM-DD'.
function phWeekStart(date) {
  const d = toPh(date);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

// UTC instant of PH midnight for a 'YYYY-MM-DD' day.
function phMidnight(day) {
  return new Date(`${day}T00:00:00.000Z`).getTime() - PH_OFFSET_MS;
}

// Business dates ('YYYY-MM-DD') are PH calendar dates already; timestamps get shifted.
function dayOf(value) {
  if (!value) return null;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : phDay(s);
}

function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(day, n) {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

// ── Row helpers ───────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function applicantName(row) {
  if (row.full_name) return String(row.full_name).trim();
  const fd = row.form_data || {};
  return `${fd.firstName || fd.first_name || ''} ${fd.lastName || fd.last_name || ''}`.trim();
}

function loanType(row) {
  return String(row.loan_type || 'unknown').toLowerCase();
}

// Outcome bucket for a row: approved | declined | pending.
function outcomeOf(row) {
  if (row.status === 'approved') return 'approved';
  if (row.status === 'declined' || row.stage === 'declined') return 'declined';
  return 'pending';
}

// When the approve/decline decision happened. Approval = first stage_history move to
// loan_processing_officer; decline = move to 'declined', else reviewed_at (the decline
// path reuses reviewed_at as declined_at, services/pipeline.js).
function decisionAt(row) {
  const outcome = outcomeOf(row);
  if (outcome === 'pending') return null;
  const target = outcome === 'approved' ? 'loan_processing_officer' : 'declined';
  const hit = (row.stage_history || []).find(h => h && h.to === target && h.at);
  if (hit) return hit.at;
  return outcome === 'declined' ? row.reviewed_at || null : row.loan_released_at || null;
}

// ── Range + buckets ───────────────────────────────────────────────────────────

/**
 * Resolves a reporting period into a PH-calendar range and bucket keys.
 * @param {'30d'|'90d'|'12m'} period
 * @param {Date} now
 * @returns {{ period, days, fromMs, toMs, granularity: 'week'|'month', buckets: string[], months: string[] }}
 */
function resolveRange(period, now) {
  const days = PERIODS[period];
  if (!days) throw new Error(`resolveRange: unsupported period ${period}`);
  const today = phDay(now);
  const toMs = phMidnight(addDays(today, 1));
  let fromDay;
  let granularity;
  if (period === '12m') {
    fromDay = `${addMonths(`${today.slice(0, 7)}-01`, -11)}`;
    granularity = 'month';
  } else {
    fromDay = phWeekStart(phMidnight(addDays(today, -(days - 1))));
    granularity = 'week';
  }
  const fromMs = phMidnight(fromDay);

  const buckets = [];
  if (granularity === 'week') {
    for (let d = fromDay; phMidnight(d) < toMs; d = addDays(d, 7)) buckets.push(d);
  } else {
    for (let d = fromDay; phMidnight(d) < toMs; d = addMonths(d, 1)) buckets.push(d.slice(0, 7));
  }
  const months = [];
  for (let d = `${fromDay.slice(0, 7)}-01`; phMidnight(d) < toMs; d = addMonths(d, 1)) {
    months.push(d.slice(0, 7));
  }
  return { period, days, fromMs, toMs, granularity, buckets, months };
}

function inRange(value, range) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= range.fromMs && t < range.toMs;
}

function bucketOf(value, granularity) {
  return granularity === 'week' ? phWeekStart(value) : phMonth(value);
}

// ── Repayment schedule (projected collections) ───────────────────────────────

/**
 * Installment dates + amount for one approved loan, from the terms stored at
 * approval (same inputs Loandisk used). Flat interest: total = principal + total_interest.
 * Returns null when the loan predates the stored-terms columns.
 * [ASSUMPTION] Estimate only: ignores payments made, arrears, and restructures,
 * which live in Loandisk.
 * @returns {{ amount: number, dates: string[] } | null}
 */
function repaymentSchedule(row) {
  const n = Number(row.num_of_repayments);
  const principal = Number(row.loan_amount);
  const interest = Number(row.total_interest_amount);
  const first = dayOf(row.first_repayment_date);
  if (!first || !Number.isFinite(n) || n <= 0 || !Number.isFinite(principal)) return null;
  if (!Number.isFinite(interest)) return null;

  const scheme = Number(row.payment_scheme_id);
  const dates = [];
  for (let i = 0; i < n; i++) {
    if (scheme === WEEKLY_SCHEME) dates.push(addDays(first, i * 7));
    else if (scheme === SEMI_MONTHLY_SCHEME) {
      // 15th/30th cycle: every second installment advances a month.
      dates.push(addMonths(i % 2 === 0 ? first : addDays(first, 15), Math.floor(i / 2)));
    } else if (scheme === MONTHLY_SCHEME) dates.push(addMonths(first, i));
    else return null;
  }
  return { amount: round2((principal + interest) / n), dates };
}

/**
 * Sums scheduled installments of approved loans falling in each PH month.
 * @returns {{ byMonth: Record<string, number>, byDay: Record<string, number>, counted: number, missingTerms: number }}
 */
function projectCollections(rows) {
  const byMonth = {};
  const byDay = {};
  let counted = 0;
  let missingTerms = 0;
  for (const row of rows) {
    if (outcomeOf(row) !== 'approved') continue;
    const schedule = repaymentSchedule(row);
    if (!schedule) {
      missingTerms += 1;
      continue;
    }
    counted += 1;
    for (const day of schedule.dates) {
      byMonth[day.slice(0, 7)] = round2((byMonth[day.slice(0, 7)] || 0) + schedule.amount);
      byDay[day] = round2((byDay[day] || 0) + schedule.amount);
    }
  }
  return { byMonth, byDay, counted, missingTerms };
}

// ── Overview (Reporting page) ─────────────────────────────────────────────────

/**
 * Every metric on the Reporting page for one period.
 * @param {{ applications: object[], staff: object[], period: string, now?: Date }} input
 * @returns {object} see docs/CONTRACT.md → GET /api/reporting/overview
 */
function buildOverview({ applications, staff, period, now = new Date() }) {
  const range = resolveRange(period, now);
  const submitted = applications.filter(r => inRange(r.submitted_at, range));
  const decided = applications
    .map(r => ({ row: r, at: decisionAt(r) }))
    .filter(d => d.at && inRange(d.at, range));

  // Applications over time, split by current outcome.
  const overTime = Object.fromEntries(
    range.buckets.map(b => [b, { bucket: b, approved: 0, pending: 0, declined: 0 }]),
  );
  for (const r of submitted) {
    const b = overTime[bucketOf(r.submitted_at, range.granularity)];
    if (b) b[outcomeOf(r)] += 1;
  }

  // Open pipeline right now (not period-bound).
  const pipeline = PIPELINE_STAGES.map(stage => ({
    stage,
    count: applications.filter(r => OPEN_STATUSES.includes(r.status) && r.stage === stage).length,
  }));

  const typeCounts = {};
  for (const r of submitted) typeCounts[loanType(r)] = (typeCounts[loanType(r)] || 0) + 1;

  const approved = decided.filter(d => outcomeOf(d.row) === 'approved').length;
  const declined = decided.filter(d => outcomeOf(d.row) === 'declined').length;

  const scored = submitted.filter(r => r.final_score != null && TIERS.includes(r.tier));
  const tierCounts = TIERS.map(tier => ({ tier, count: scored.filter(r => r.tier === tier).length }));
  const avgScore = scored.length
    ? round1(scored.reduce((s, r) => s + Number(r.final_score), 0) / scored.length)
    : null;

  // Sales officer performance (by current assignment).
  const names = Object.fromEntries(staff.map(u => [u.id, u.full_name]));
  const so = {};
  for (const r of submitted) {
    const key = r.assigned_sales_officer || 'unassigned';
    so[key] = so[key] || {
      officer: names[key] || (key === 'unassigned' ? 'Unassigned' : 'Unknown officer'),
      approved: 0,
      declined: 0,
      pending: 0,
    };
    so[key][outcomeOf(r)] += 1;
  }
  const soPerformance = Object.values(so)
    .sort((a, b) => b.approved + b.declined + b.pending - (a.approved + a.declined + a.pending))
    .slice(0, 10);

  // Turnaround: submission → decision, averaged per bucket of the decision date.
  const tt = {};
  const allDays = [];
  for (const { row, at } of decided) {
    const days = (new Date(at) - new Date(row.submitted_at)) / DAY_MS;
    if (!Number.isFinite(days) || days < 0) continue;
    allDays.push(days);
    const b = bucketOf(at, range.granularity);
    tt[b] = tt[b] || [];
    tt[b].push(days);
  }
  const turnaround = range.buckets.map(b => ({
    bucket: b,
    days: tt[b] ? round1(tt[b].reduce((s, d) => s + d, 0) / tt[b].length) : null,
  }));

  // Money: principal released per month vs scheduled collections per month.
  const collections = projectCollections(applications);
  const disbursedByMonth = {};
  let disbursedInRange = 0;
  for (const r of applications) {
    if (outcomeOf(r) !== 'approved') continue;
    const released = r.loan_release_date || r.loan_released_at;
    if (!released) continue;
    const month = dayOf(released).slice(0, 7);
    disbursedByMonth[month] = round2((disbursedByMonth[month] || 0) + Number(r.loan_amount || 0));
    if (inRange(phMidnight(dayOf(released)), range)) disbursedInRange += Number(r.loan_amount || 0);
  }
  const currentMonth = phMonth(now);

  return {
    period,
    granularity: range.granularity,
    range: { from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString() },
    generated_at: new Date(now).toISOString(),
    kpis: {
      applications: submitted.length,
      approval_rate: approved + declined ? round1((approved / (approved + declined)) * 100) : null,
      approved,
      declined,
      avg_final_score: avgScore,
      disbursed: round2(disbursedInRange),
      projected_collections: collections.byMonth[currentMonth] || 0,
      avg_turnaround_days: allDays.length
        ? round1(allDays.reduce((s, d) => s + d, 0) / allDays.length)
        : null,
    },
    applications_over_time: Object.values(overTime),
    pipeline_by_stage: pipeline,
    loan_type_mix: Object.entries(typeCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    score_distribution: tierCounts,
    so_performance: soPerformance,
    money_by_month: range.months.map(month => ({
      month,
      disbursed: disbursedByMonth[month] || 0,
      projected: collections.byMonth[month] || 0,
    })),
    turnaround,
    notes: {
      collections_basis: 'estimate_from_approved_terms',
      loans_projected: collections.counted,
      loans_missing_terms: collections.missingTerms,
    },
  };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/**
 * "Right now" view: this PH week's applicants and totals, staff changes, and this
 * month's projected collections.
 * @param {{ applications: object[], staff: object[], now?: Date }} input
 * @returns {object} see docs/CONTRACT.md → GET /api/reporting/dashboard
 */
function buildDashboard({ applications, staff, now = new Date() }) {
  const weekStart = phWeekStart(now);
  const week = { fromMs: phMidnight(weekStart), toMs: phMidnight(addDays(weekStart, 7)) };
  const thisWeek = applications.filter(r => inRange(r.submitted_at, week));
  const decidedThisWeek = applications.filter(r => inRange(decisionAt(r), week));

  const applicants = thisWeek
    .slice()
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, 50)
    .map(r => ({
      id: r.id,
      reference_id: r.reference_id,
      name: applicantName(r),
      loan_type: loanType(r),
      loan_amount: Number(r.loan_amount) || 0,
      status: r.status,
      stage: r.stage,
      submitted_at: r.submitted_at,
    }));

  const since = now.getTime() - 90 * DAY_MS;
  const staffChanges = staff
    .filter(u => u.created_at && new Date(u.created_at).getTime() >= since)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(u => ({ type: 'account_created', name: u.full_name, roles: u.roles || [], at: u.created_at }));

  const collections = projectCollections(applications);
  const month = phMonth(now);
  // Weekly split of this month only: days outside the month are excluded, so the
  // weeks always sum to the month total.
  const weeks = {};
  for (const [day, amount] of Object.entries(collections.byDay)) {
    if (day.slice(0, 7) !== month) continue;
    const w = phWeekStart(phMidnight(day));
    weeks[w] = round2((weeks[w] || 0) + amount);
  }
  const byWeek = Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week_start, amount]) => ({ week_start, amount }));

  return {
    generated_at: new Date(now).toISOString(),
    week: { start: weekStart, end: addDays(weekStart, 6) },
    kpis: {
      applied: thisWeek.length,
      approved: decidedThisWeek.filter(r => outcomeOf(r) === 'approved').length,
      declined: decidedThisWeek.filter(r => outcomeOf(r) === 'declined').length,
      // Same definition as the Applications list "Awaiting CI" tile.
      awaiting_ci: applications.filter(r => r.status === 'pending' && r.ci_score == null).length,
    },
    applicants,
    staff_changes: staffChanges,
    inactive_staff: staff
      .filter(u => u.is_active === false)
      .map(u => ({ name: u.full_name, roles: u.roles || [] })),
    projected_collections: {
      month,
      total: collections.byMonth[month] || 0,
      by_week: byWeek,
      basis: 'estimate_from_approved_terms',
      loans_projected: collections.counted,
      loans_missing_terms: collections.missingTerms,
    },
    limitations: ['role_changes_and_deactivation_dates_not_recorded'],
  };
}

module.exports = {
  PERIODS,
  resolveRange,
  repaymentSchedule,
  projectCollections,
  decisionAt,
  buildOverview,
  buildDashboard,
  phWeekStart,
  phDay,
};
