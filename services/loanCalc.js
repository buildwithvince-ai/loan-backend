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

module.exports = {
  calculateRepayments,
  calculateLoanFees,
  calculateTotalInterest,
  validateLoanInputs,
};
