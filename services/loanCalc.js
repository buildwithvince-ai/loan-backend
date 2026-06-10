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
  } else if (product && (product.min_amount != null || product.max_amount != null)) {
    // Per-product amount band (H4) — blocks an approver adjusted_amount outside
    // the product's allowed range (e.g. a 999,999 AKAP loan vs the 40k cap).
    if (p < product.min_amount || p > product.max_amount) {
      errors.push(`principal for ${normalizeLoanType(loan_type)} must be between ${product.min_amount} and ${product.max_amount}`);
    }
  }

  const d = Number(duration_months);
  if (!Number.isFinite(d) || d < LOAN_DEFAULTS.min_duration_months || d > LOAN_DEFAULTS.max_duration_months) {
    errors.push(`duration must be between ${LOAN_DEFAULTS.min_duration_months} and ${LOAN_DEFAULTS.max_duration_months} months`);
  } else if (Number(payment_scheme_id) === PAYMENT_SCHEME_IDS.weekly && d * 4 > LOAN_DEFAULTS.weekly_repayment_cap) {
    // Weekly (AKAP) clamp mismatch (H6): calculateRepayments clamps weekly
    // num_of_repayments at weekly_repayment_cap (24 = 6 months) while
    // loan_duration would still send the full months, producing an inconsistent
    // Loandisk record. Cap weekly-scheme duration at 6 months here instead.
    const maxWeeklyMonths = Math.floor(LOAN_DEFAULTS.weekly_repayment_cap / 4);
    errors.push(`weekly-scheme loans (e.g. AKAP) must not exceed ${maxWeeklyMonths} months`);
  }

  const r = Number(interest_rate);
  if (!Number.isFinite(r) || r < LOAN_DEFAULTS.min_interest_rate || r > LOAN_DEFAULTS.max_interest_rate) {
    errors.push(`interest_rate must be between ${LOAN_DEFAULTS.min_interest_rate} and ${LOAN_DEFAULTS.max_interest_rate}`);
  }

  // Discount reason required when rate is below the per-loan-type default
  // (5.0 for all products since the 2026-06-09 hard-lock; unreachable while
  // min==max). Falls back to LOAN_DEFAULTS.interest_rate for unrecognised types.
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

// calculateFirstRepaymentDate moved to services/repayment.js (per-product rules).

// ---------------------------------------------------------------------------
// validateCiRepaymentFields
// Validates the CI-stage repayment inputs. Returns { valid, errors }.
//   - AKAP / SME: no salary payout dates required (their first repayment is
//     release+7 / release+1mo respectively). Salary/cycle validation is skipped.
//   - payment_frequency must be 'one_time' | 'two_times'
//   - salary_payout_dates: integers 1-31; exactly 1 for one_time,
//     exactly 2 distinct for two_times
//   - repayment_cycle present and non-empty
//   - honorarium_date: day-of-month integer (1-31), REQUIRED for SBL only.
//     The SBL first repayment follows this date. Ignored for other products.
//     Pass loan_type so the per-type rules can be enforced.
// ---------------------------------------------------------------------------
function validateCiRepaymentFields(input) {
  const errors = [];
  const { payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date, loan_type } = input || {};
  const type = normalizeLoanType(loan_type);

  // AKAP and SME do not use salary payout dates — their first repayment is
  // release+7 (weekly) / release+1mo respectively. Skip salary/cycle validation.
  if (type === 'akap' || type === 'sme') {
    return { valid: true, errors };
  }

  // SBL uses ONLY the honorarium date (it drives the first repayment). Salary
  // payout dates / payment frequency / cycle are not used for SBL.
  if (type === 'sbl') {
    const hd = Number(honorarium_date);
    if (!Number.isInteger(hd) || hd < 1 || hd > 31) {
      errors.push('honorarium_date is required for SBL and must be a day-of-month integer between 1 and 31');
    }
    return { valid: errors.length === 0, errors };
  }

  // Personal / Group: salary payout dates + repayment cycle required.
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  calculateRepayments,
  calculateLoanFees,
  calculateTotalInterest,
  validateLoanInputs,
  validateCiRepaymentFields,
};
