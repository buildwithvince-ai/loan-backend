'use strict';

// Unit tests for services/reporting.js (pure; no DB, no network).
// Run: node tests/reporting.test.js

const assert = require('node:assert/strict');
const {
  resolveRange,
  repaymentSchedule,
  projectCollections,
  decisionAt,
  buildOverview,
  buildDashboard,
  phWeekStart,
  phDay,
} = require('../services/reporting');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

// Wed 2026-09-30 10:00 PH (02:00Z)
const NOW = new Date('2026-09-30T02:00:00Z');

test('PH day/week: 23:30Z Sunday is Monday in Manila', () => {
  // 2026-09-27 is a Sunday; 23:30Z = 07:30 Monday 09-28 in PH
  assert.equal(phDay('2026-09-27T23:30:00Z'), '2026-09-28');
  assert.equal(phWeekStart('2026-09-27T23:30:00Z'), '2026-09-28');
  assert.equal(phWeekStart(NOW), '2026-09-28');
});

test('resolveRange 90d: weekly buckets from a Monday, ending this week', () => {
  const r = resolveRange('90d', NOW);
  assert.equal(r.granularity, 'week');
  assert.equal(r.buckets[r.buckets.length - 1], '2026-09-28');
  assert.equal(new Date(r.buckets[0] + 'T00:00:00Z').getUTCDay(), 1);
  assert.ok(r.buckets.length >= 13 && r.buckets.length <= 14);
});

test('resolveRange 12m: 12 monthly buckets ending this month', () => {
  const r = resolveRange('12m', NOW);
  assert.equal(r.buckets.length, 12);
  assert.equal(r.buckets[0], '2025-10');
  assert.equal(r.buckets[11], '2026-09');
});

test('resolveRange rejects unknown periods', () => {
  assert.throws(() => resolveRange('7d', NOW));
});

test('repaymentSchedule monthly: flat interest split evenly, month steps', () => {
  const s = repaymentSchedule({
    loan_amount: 30000,
    total_interest_amount: 9000,
    num_of_repayments: 6,
    payment_scheme_id: 3,
    first_repayment_date: '2026-01-31',
  });
  assert.equal(s.amount, 6500);
  assert.deepEqual(s.dates.slice(0, 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(s.dates.length, 6);
});

test('repaymentSchedule weekly: 7-day steps', () => {
  const s = repaymentSchedule({
    loan_amount: 10000,
    total_interest_amount: 2000,
    num_of_repayments: 12,
    payment_scheme_id: 4,
    first_repayment_date: '2026-10-05',
  });
  assert.equal(s.amount, 1000);
  assert.equal(s.dates[1], '2026-10-12');
});

test('repaymentSchedule returns null when terms are missing', () => {
  assert.equal(repaymentSchedule({ loan_amount: 20000 }), null);
});

test('projectCollections counts only approved loans with terms', () => {
  const rows = [
    {
      status: 'approved',
      loan_amount: 12000,
      total_interest_amount: 0,
      num_of_repayments: 3,
      payment_scheme_id: 3,
      first_repayment_date: '2026-09-15',
    },
    { status: 'approved', loan_amount: 5000 },
    {
      status: 'pending',
      loan_amount: 9999,
      total_interest_amount: 0,
      num_of_repayments: 1,
      payment_scheme_id: 3,
      first_repayment_date: '2026-09-15',
    },
  ];
  const c = projectCollections(rows);
  assert.equal(c.counted, 1);
  assert.equal(c.missingTerms, 1);
  assert.equal(c.byMonth['2026-09'], 4000);
  assert.equal(c.byMonth['2026-11'], 4000);
});

test('decisionAt uses the stage_history move to loan_processing_officer', () => {
  const at = decisionAt({
    status: 'approved',
    stage_history: [
      { to: 'approver', at: '2026-09-01T00:00:00Z' },
      { to: 'loan_processing_officer', at: '2026-09-03T00:00:00Z' },
    ],
  });
  assert.equal(at, '2026-09-03T00:00:00Z');
  assert.equal(decisionAt({ status: 'pending' }), null);
});

const STAFF = [
  { id: 'so1', full_name: 'Troy', roles: ['sales_officer'], is_active: true, created_at: '2026-04-04T00:00:00Z' },
  { id: 'so2', full_name: 'Dennis', roles: ['sales_officer'], is_active: false, created_at: '2026-04-04T00:00:00Z' },
  { id: 'ci1', full_name: 'Villy', roles: ['ci_officer'], is_active: true, created_at: '2026-08-13T00:00:00Z' },
];
const APPS = [
  {
    id: 'a1',
    reference_id: 'GR8-1',
    full_name: 'Maria Santos',
    loan_type: 'Personal',
    loan_amount: 30000,
    status: 'approved',
    stage: 'loan_processing_officer',
    submitted_at: '2026-09-29T01:00:00Z',
    final_score: 88,
    tier: 'approved',
    ci_score: 40,
    assigned_sales_officer: 'so1',
    stage_history: [{ to: 'loan_processing_officer', at: '2026-09-30T01:00:00Z' }],
    loan_release_date: '2026-09-30',
    first_repayment_date: '2026-10-30',
    num_of_repayments: 3,
    payment_scheme_id: 3,
    total_interest_amount: 4500,
  },
  {
    id: 'a2',
    reference_id: 'GR8-2',
    full_name: 'Jose Reyes',
    loan_type: 'sme',
    loan_amount: 100000,
    status: 'pending',
    stage: 'ci_officer',
    submitted_at: '2026-09-28T03:00:00Z',
    ci_score: null,
    assigned_sales_officer: 'so1',
    stage_history: [],
  },
  {
    id: 'a3',
    reference_id: 'GR8-3',
    full_name: 'Old Timer',
    loan_type: 'akap',
    loan_amount: 20000,
    status: 'pending_sa_confirmation',
    stage: 'approver',
    submitted_at: '2026-05-01T00:00:00Z',
    final_score: 72,
    tier: 'tier_b',
    ci_score: 30,
    assigned_sales_officer: null,
    stage_history: [],
  },
];

test('buildOverview 30d: KPIs, mix, pipeline, SO performance', () => {
  const o = buildOverview({ applications: APPS, staff: STAFF, period: '30d', now: NOW });
  assert.equal(o.kpis.applications, 2);
  assert.equal(o.kpis.approved, 1);
  assert.equal(o.kpis.declined, 0);
  assert.equal(o.kpis.approval_rate, 100);
  assert.equal(o.kpis.avg_final_score, 88);
  assert.equal(o.kpis.disbursed, 30000);
  assert.deepEqual(
    o.loan_type_mix.map(t => t.type).sort(),
    ['personal', 'sme'],
  );
  const ci = o.pipeline_by_stage.find(p => p.stage === 'ci_officer');
  assert.equal(ci.count, 1);
  const approver = o.pipeline_by_stage.find(p => p.stage === 'approver');
  assert.equal(approver.count, 1, 'pending_sa_confirmation counts as open');
  assert.equal(o.so_performance[0].officer, 'Troy');
  assert.equal(o.so_performance[0].approved + o.so_performance[0].pending, 2);
  const lastWeek = o.applications_over_time[o.applications_over_time.length - 1];
  assert.deepEqual(lastWeek, { bucket: '2026-09-28', approved: 1, pending: 1, declined: 0 });
  assert.equal(o.kpis.avg_turnaround_days, 1);
});

test('buildOverview approval_rate is null with no decisions in range', () => {
  const o = buildOverview({ applications: [APPS[1]], staff: STAFF, period: '30d', now: NOW });
  assert.equal(o.kpis.approval_rate, null);
});

test('buildDashboard: this PH week, awaiting CI, staff, collections', () => {
  const d = buildDashboard({ applications: APPS, staff: STAFF, now: NOW });
  assert.deepEqual(d.week, { start: '2026-09-28', end: '2026-10-04' });
  assert.equal(d.kpis.applied, 2);
  assert.equal(d.kpis.approved, 1);
  assert.equal(d.kpis.awaiting_ci, 1);
  assert.deepEqual(d.applicants.map(a => a.reference_id), ['GR8-1', 'GR8-2']);
  assert.equal(d.applicants[0].loan_type, 'personal');
  assert.deepEqual(d.staff_changes.map(s => s.name), ['Villy']);
  assert.deepEqual(d.inactive_staff.map(s => s.name), ['Dennis']);
  assert.equal(d.projected_collections.month, '2026-09');
  assert.equal(d.projected_collections.total, 0);
  assert.equal(d.projected_collections.loans_projected, 1);
});

test('buildDashboard weekly collections sum to the month total', () => {
  const loan = {
    status: 'approved',
    loan_amount: 7000,
    total_interest_amount: 0,
    num_of_repayments: 7,
    payment_scheme_id: 4,
    first_repayment_date: '2026-08-31', // Monday; Aug 31 must not count toward September
  };
  const d = buildDashboard({ applications: [loan], staff: [], now: NOW });
  const weekSum = d.projected_collections.by_week.reduce((s, w) => s + w.amount, 0);
  assert.equal(d.projected_collections.total, 4000); // Sep 7, 14, 21, 28
  assert.equal(weekSum, d.projected_collections.total);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
