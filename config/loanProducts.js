'use strict';

// ---------------------------------------------------------------------------
// Loandisk loan product + scheme configuration.
// Source of truth: BLOCKER.md (resolved with ops 2026-04). Update here when
// Loandisk admin values change — do NOT inline these elsewhere.
// ---------------------------------------------------------------------------

const PAYMENT_SCHEME_IDS = {
  monthly: 3,
  semi_monthly_15_30: 3413,
  weekly: 4,
};

// Loan product key (lowercased) -> Loandisk config.
// Keep keys aligned with frontend `loanType` values.
// min_amount / max_amount are the per-product principal bands (H4). The
// approver's adjusted_amount used to flow to Loandisk with only a `> 0` check,
// so e.g. a 999,999 AKAP loan (40k cap) could be created. validateLoanInputs
// enforces these. Group/SBL bands are per-member.
const PRODUCT_CONFIG = {
  personal: {
    loandisk_product_id: 244322,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
    min_amount: 10000,
    max_amount: 200000,
  },
  sme: {
    loandisk_product_id: 244323,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
    min_amount: 50000,
    max_amount: 300000,
  },
  // Verified against live Loandisk 2026-06-03: product 244329 IS named
  // "SANGGUNIANG BARANGAY LOAN (SBL)"; 245685 is Group. The ops reference table
  // had these two reversed — Loandisk's system of record is authoritative.
  sbl: {
    loandisk_product_id: 244329,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
    min_amount: 5000,
    max_amount: 100000,
  },
  group: {
    loandisk_product_id: 245685,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
    min_amount: 10000,
    max_amount: 50000,
  },
  akap: {
    loandisk_product_id: 310445,
    allowed_payment_schemes: [4],
    default_payment_scheme: 4,
    min_amount: 5000,
    max_amount: 40000,
  },
};

// Per-loan-type default interest rates (% / month). Authoritative source for
// the approval flow when an approver does not override the rate. All values
// stay within LOAN_DEFAULTS.min_interest_rate..max_interest_rate.
const DEFAULT_INTEREST_RATES = {
  personal: 3.5,
  sme: 3.0,
  akap: 4.0,
  group: 5.0,
  sbl: 5.0,
};

const LOAN_DEFAULTS = {
  // Legacy fallback rate; per-type defaults in DEFAULT_INTEREST_RATES are
  // authoritative. Kept as a safety net for unrecognised loan types.
  interest_rate: 5,
  interest_method: 'flat_rate',
  interest_type: 'percentage',
  interest_period: 'Month',
  decimal_places: 'round_off_to_two_decimal',
  duration_period: 'Months',
  min_interest_rate: 3,
  max_interest_rate: 5,
  min_duration_months: 3,
  max_duration_months: 24,
  weekly_repayment_cap: 24,
};

// Loandisk fee IDs from the API doc (Add Loan form):
//   loan_fee_id_13777 = SERVICE PROCESSING %
//   loan_fee_id_14282 = INSURANCE CHARGE
const FEE_CONFIG = {
  service_processing_fee_rate: 0.05,
  insurance_fee_rate: 0.01,
  fees_deductible: true,
  loandisk_fee_ids: {
    service_processing: 13777,
    insurance: 14282,
  },
  // Charge the full fee amount on the released date (deductible from disbursement).
  loandisk_fee_schedule: 'charge_fees_on_released_date',
};

// Disbursement: out of scope per BLOCKER.md, but Loandisk marks
// `loan_disbursed_by_id` as Required. Send Cash (188405) as placeholder so
// first staging call doesn't fail; ops can override via env.
//   188405=Cash 188406=Cheque 188407=Wire Transfer 188408=Online Transfer
const DISBURSEMENT = {
  default_disbursed_by_id: 188405,
  env_override_key: 'LOANDISK_DISBURSED_BY_ID',
};

function normalizeLoanType(loanType) {
  return String(loanType || '').trim().toLowerCase();
}

function getProductConfig(loanType) {
  const key = normalizeLoanType(loanType);
  return PRODUCT_CONFIG[key] || null;
}

function getDefaultInterestRate(loanType) {
  const key = normalizeLoanType(loanType);
  const rate = DEFAULT_INTEREST_RATES[key];
  return Number.isFinite(rate) ? rate : LOAN_DEFAULTS.interest_rate;
}

module.exports = {
  PAYMENT_SCHEME_IDS,
  PRODUCT_CONFIG,
  LOAN_DEFAULTS,
  DEFAULT_INTEREST_RATES,
  FEE_CONFIG,
  DISBURSEMENT,
  normalizeLoanType,
  getProductConfig,
  getDefaultInterestRate,
};
