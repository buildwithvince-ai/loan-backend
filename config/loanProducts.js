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
const PRODUCT_CONFIG = {
  personal: {
    loandisk_product_id: 244322,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
  },
  sme: {
    loandisk_product_id: 244323,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
  },
  sbl: {
    loandisk_product_id: 244329,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
  },
  group: {
    loandisk_product_id: 245685,
    allowed_payment_schemes: [3, 3413],
    default_payment_scheme: 3,
  },
  akap: {
    loandisk_product_id: 310445,
    allowed_payment_schemes: [4],
    default_payment_scheme: 4,
  },
};

const LOAN_DEFAULTS = {
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

module.exports = {
  PAYMENT_SCHEME_IDS,
  PRODUCT_CONFIG,
  LOAN_DEFAULTS,
  FEE_CONFIG,
  DISBURSEMENT,
  normalizeLoanType,
  getProductConfig,
};
