'use strict';

// Pure, side-effect-free loan math + validation. Unit-testable.
// Source rules: BLOCKER.md (resolved values from ops 2026-04).

const {
  PAYMENT_SCHEME_IDS,
  LOAN_DEFAULTS,
  FEE_CONFIG,
  getProductConfig,
  getDefaultInterestRate,
  normalizeLoanType,
} = require('../config/loanProducts');

// ---------------------------------------------------------------------------
// calculateRepayments
// Loandisk auto-derives loan_num_of_repayments from duration + scheme. We must
// match its setNumofRep() logic exactly:
//   Monthly (3)             -> duration_in_months
//   15-30 semi-monthly (3413) -> duration_in_months * 2
//   Weekly (4)              -> duration_in_months * 4, capped at 24
// ---------------------------------------------------------------------------
function calculateRepayments(durationMonths, paymentSchemeId) {
  const months = Number(durationMonths);
  const scheme = Number(paymentSchemeId);

  if (!Number.isFinite(months) || months <= 0) {
    throw new Error('calculateRepayments: durationMonths must be a positive number');
  }

  if (scheme === PAYMENT_SCHEME_IDS.monthly) {
    return months;
  }
  if (scheme === PAYMENT_SCHEME_IDS.semi_monthly_15_30) {
    return months * 2;
  }
  if (scheme === PAYMENT_SCHEME_IDS.weekly) {
    const raw = months * 4;
    const cap = LOAN_DEFAULTS.weekly_repayment_cap;
    if (raw > cap) {
      console.warn(`[loanCalc] weekly repayments ${raw} > cap ${cap} for ${months}-month loan; clamping`);
      return cap;
    }
    return raw;
  }

  throw new Error(`calculateRepayments: unsupported payment scheme id ${paymentSchemeId}`);
}

// ---------------------------------------------------------------------------
// calculateLoanFees
// 5% service processing + 1% insurance, both deductible from disbursement.
// Fixed percentages — no per-loan override in this iteration.
// ---------------------------------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}

function calculateLoanFees(principal) {
  const p = Number(principal);
  if (!Number.isFinite(p) || p <= 0) {
    throw new Error('calculateLoanFees: principal must be a positive number');
  }

  const service_fee = round2(p * FEE_CONFIG.service_processing_fee_rate);
  const insurance_fee = round2(p * FEE_CONFIG.insurance_fee_rate);
  const total_fees = round2(service_fee + insurance_fee);
  const net_disbursement = round2(p - total_fees);

  return { service_fee, insurance_fee, total_fees, net_disbursement };
}

// ---------------------------------------------------------------------------
// calculateTotalInterest
// principal × (rate/100) × duration_in_months. Used as a sanity-check log.
// ---------------------------------------------------------------------------
function calculateTotalInterest(principal, rate, durationMonths) {
  const p = Number(principal);
  const r = Number(rate);
  const d = Number(durationMonths);
  if (!Number.isFinite(p) || !Number.isFinite(r) || !Number.isFinite(d)) {
    throw new Error('calculateTotalInterest: numeric inputs required');
  }
  return round2(p * (r / 100) * d);
}

// ---------------------------------------------------------------------------
// validateLoanInputs
// Returns { valid, errors }. Validates:
//   - loanType maps to a known product
//   - principal positive
//   - duration in [3, 24]
//   - interest rate in [3, 5]
//   - discount_reason present when interest_rate < default
//   - payment scheme allowed for the product
// ---------------------------------------------------------------------------
function validateLoanInputs(input) {
  const errors = [];
  const {
    loan_type,
    principal,
    duration_months,
    interest_rate,
    payment_scheme_id,
    discount_reason,
  } = input || {};

  const product = getProductConfig(loan_type);
  if (!product) {
    errors.push(`Unknown loan_type: ${loan_type}`);
  }

  const p = Number(principal);
  if (!Number.isFinite(p) || p <= 0) {
    errors.push('principal must be a positive number');
  }

  const d = Number(duration_months);
  if (!Number.isFinite(d) || d < LOAN_DEFAULTS.min_duration_months || d > LOAN_DEFAULTS.max_duration_months) {
    errors.push(`duration must be between ${LOAN_DEFAULTS.min_duration_months} and ${LOAN_DEFAULTS.max_duration_months} months`);
  }

  const r = Number(interest_rate);
  if (!Number.isFinite(r) || r < LOAN_DEFAULTS.min_interest_rate || r > LOAN_DEFAULTS.max_interest_rate) {
    errors.push(`interest_rate must be between ${LOAN_DEFAULTS.min_interest_rate} and ${LOAN_DEFAULTS.max_interest_rate}`);
  }

  // Discount reason required when rate is below the per-loan-type default
  // (Personal 3.5, SME 3.0, AKAP 4.0, Group/SBL 5.0). Falls back to
  // LOAN_DEFAULTS.interest_rate for unrecognised loan types.
  const typeDefault = getDefaultInterestRate(loan_type);
  if (Number.isFinite(r) && r < typeDefault) {
    if (!discount_reason || !String(discount_reason).trim()) {
      errors.push(`discount_reason is required when interest_rate is below the ${normalizeLoanType(loan_type)} default (${typeDefault}%)`);
    }
  }

  if (product) {
    const scheme = Number(payment_scheme_id);
    if (!product.allowed_payment_schemes.includes(scheme)) {
      errors.push(`payment_scheme_id ${payment_scheme_id} not allowed for ${normalizeLoanType(loan_type)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// calculateFirstRepaymentDate
// Given a loan release date and a repayment cycle string, return the first
// repayment date as an ISO 'YYYY-MM-DD' string.
//
//   loanReleaseDate : Date | 'YYYY-MM-DD' (Postgres `date` reads back as ISO)
//   repaymentCycle  : '15' (single payout) or '15-30' (two payouts)
//
// Algorithm (per spec):
//   1. thresholdDate = releaseDate + 15 days.
//   2. Walk months forward from the release month; for each month iterate the
//      payout days ascending, snapping each to the month's last valid day
//      (EOM rule: Math.min(payoutDay, lastDayOfMonth) — payout 31 in Feb = 28/29).
//   3. Return the first snapped date STRICTLY AFTER the threshold.
//
// All date math uses UTC parts so the result is deterministic regardless of
// host timezone (Railway runs UTC; this stays correct off-UTC too).
// ---------------------------------------------------------------------------
function calculateFirstRepaymentDate(loanReleaseDate, repaymentCycle) {
  let y;
  let m; // 0-based month
  let d;
  if (loanReleaseDate instanceof Date) {
    if (Number.isNaN(loanReleaseDate.getTime())) {
      throw new Error('calculateFirstRepaymentDate: invalid loanReleaseDate');
    }
    y = loanReleaseDate.getUTCFullYear();
    m = loanReleaseDate.getUTCMonth();
    d = loanReleaseDate.getUTCDate();
  } else {
    const parts = String(loanReleaseDate || '').slice(0, 10).split('-').map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`calculateFirstRepaymentDate: invalid loanReleaseDate "${loanReleaseDate}"`);
    }
    [y, m, d] = [parts[0], parts[1] - 1, parts[2]];
  }

  const payoutDates = String(repaymentCycle || '')
    .split('-')
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
    .sort((a, b) => a - b);
  if (payoutDates.length === 0) {
    throw new Error(`calculateFirstRepaymentDate: invalid repaymentCycle "${repaymentCycle}"`);
  }

  const threshold = new Date(Date.UTC(y, m, d + 15)); // release + 15 days

  let cy = y;
  let cm = m;
  for (let i = 0; i < 24; i += 1) {
    const lastDayOfMonth = new Date(Date.UTC(cy, cm + 1, 0)).getUTCDate();
    for (const payoutDate of payoutDates) {
      const snapped = Math.min(payoutDate, lastDayOfMonth);
      const candidate = new Date(Date.UTC(cy, cm, snapped));
      if (candidate.getTime() > threshold.getTime()) {
        return candidate.toISOString().slice(0, 10);
      }
    }
    cm += 1;
    if (cm > 11) { cm = 0; cy += 1; }
  }

  throw new Error('calculateFirstRepaymentDate: no valid repayment date found within 24 months');
}

// ---------------------------------------------------------------------------
// validateCiRepaymentFields
// Validates the CI-stage repayment inputs. Returns { valid, errors }.
//   - payment_frequency must be 'one_time' | 'two_times'
//   - salary_payout_dates: integers 1-31; exactly 1 for one_time,
//     exactly 2 distinct for two_times
//   - repayment_cycle present and non-empty
//   - honorarium_date: day-of-month integer (1-31), REQUIRED for SBL only.
//     The SBL first repayment follows this date. Ignored for other products.
//     Pass loan_type so the SBL-only requirement can be enforced.
// ---------------------------------------------------------------------------
function validateCiRepaymentFields(input) {
  const errors = [];
  const { payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date, loan_type } = input || {};

  if (!['one_time', 'two_times'].includes(payment_frequency)) {
    errors.push('payment_frequency must be "one_time" or "two_times"');
  }

  const dates = Array.isArray(salary_payout_dates) ? salary_payout_dates.map(Number) : null;
  if (!dates || dates.some((n) => !Number.isInteger(n) || n < 1 || n > 31)) {
    errors.push('salary_payout_dates must be an array of integers between 1 and 31');
  } else if (payment_frequency === 'one_time' && dates.length !== 1) {
    errors.push('payment_frequency "one_time" requires exactly 1 salary_payout_date');
  } else if (payment_frequency === 'two_times') {
    if (dates.length !== 2) {
      errors.push('payment_frequency "two_times" requires exactly 2 salary_payout_dates');
    } else if (dates[0] === dates[1]) {
      errors.push('payment_frequency "two_times" requires 2 distinct salary_payout_dates');
    }
  }

  if (!repayment_cycle || !String(repayment_cycle).trim()) {
    errors.push('repayment_cycle is required');
  }

  // honorarium_date is required for SBL (the SBL first repayment follows it).
  if (normalizeLoanType(loan_type) === 'sbl') {
    const hd = Number(honorarium_date);
    if (!Number.isInteger(hd) || hd < 1 || hd > 31) {
      errors.push('honorarium_date is required for SBL and must be a day-of-month integer between 1 and 31');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  calculateRepayments,
  calculateLoanFees,
  calculateTotalInterest,
  validateLoanInputs,
  calculateFirstRepaymentDate,
  validateCiRepaymentFields,
};
