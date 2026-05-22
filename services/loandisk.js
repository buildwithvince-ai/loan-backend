const axios = require('axios')
const {
  PAYMENT_SCHEME_IDS,
  LOAN_DEFAULTS,
  FEE_CONFIG,
  DISBURSEMENT,
  getProductConfig,
  getDefaultInterestRate,
  normalizeLoanType
} = require('../config/loanProducts')

// Loan-type -> Loandisk payment_scheme_id. Authoritative resolver when the
// caller does not pass an explicit payment_scheme_id. Keys are the lowercased
// loan_type values used by the frontend.
//   3    = Monthly
//   3413 = Semi-monthly (15/30)
//   4    = Weekly
// AKAP=4 needs verification against Loandisk's allowed scheme list for the
// AKAP product (config/loanProducts.js PRODUCT_CONFIG.akap.allowed_payment_schemes).
// Confirm with ops before relying on AKAP weekly billing in prod.
const PAYMENT_SCHEME_IDS_BY_LOAN_TYPE = {
  personal: PAYMENT_SCHEME_IDS.monthly,
  sme: PAYMENT_SCHEME_IDS.monthly,
  group: PAYMENT_SCHEME_IDS.monthly,
  sbl: PAYMENT_SCHEME_IDS.monthly,
  akap: PAYMENT_SCHEME_IDS.weekly // TODO(ops): verify AKAP scheme id
}
const {
  calculateRepayments,
  calculateLoanFees,
  calculateTotalInterest,
  validateLoanInputs
} = require('./loanCalc')

// ---------------------------------------------------------------------------
// Loandisk borrower payload mapping
//
// Frontend form_data shape evolved over time. Mapper accepts both legacy keys
// (dob, address, city, ...) and current keys (dateOfBirth, presentHouseStreet,
// presentCity, ...). Falls back gracefully when fields are absent.
//
// Open question (block on ops): where to store middleName.
//   - 'firstname_pack'   → "{firstName} {middleName}" into borrower_firstname (default)
//   - 'lastname_pack'    → "{middleName} {lastName}" into borrower_lastname
//   - 'description_only' → leave names alone, only in borrower_description
//   - 'custom_field'     → would require new Loandisk custom field + ops setup
// One-line flip below once ops decides.
// ---------------------------------------------------------------------------
const MIDDLE_NAME_STRATEGY = 'firstname_pack'

const WORKING_STATUS_MAP = {
  Employed: 'Employee',
  'Government Employee': 'Government Employee',
  'Private Sector Employee': 'Private Sector Employee',
  'Self-Employed': 'Owner',
  'Business Owner': 'Owner',
  OFW: 'Overseas Worker',
  Student: 'Student',
  Pensioner: 'Pensioner',
  Unemployed: 'Unemployed',
  Employee: 'Employee'
}

function baseUrl() {
  return `https://api-main.loandisk.com/${process.env.LOANDISK_PUBLIC_KEY}/${process.env.LOANDISK_BRANCH_ID}`
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${process.env.LOANDISK_AUTH_CODE}`
  }
}

function formatDOB(dob) {
  if (!dob) return ''
  const s = String(dob).trim()
  if (s.includes('-')) {
    // yyyy-mm-dd
    const [year, month, day] = s.split('-')
    if (year && month && day) return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`
  }
  // already mm/dd/yyyy or unknown — pass through
  return s
}

function pickAddress(fd) {
  return {
    street:   fd.presentHouseStreet || fd.address || fd.permanentHouseStreet || '',
    barangay: fd.barangay || fd.presentBarangay || fd.permanentBarangay || '',
    city:     fd.presentCity || fd.city || fd.permanentCity || '',
    province: fd.presentProvince || fd.province || fd.permanentProvince || '',
    zip:      fd.presentZip || fd.zipcode || fd.permanentZip || ''
  }
}

function buildBorrowerName(fd) {
  const first = (fd.firstName || '').trim()
  const middle = (fd.middleName || fd.middleInitial || '').trim()
  const last = (fd.lastName || '').trim()

  if (!middle || MIDDLE_NAME_STRATEGY === 'description_only' || MIDDLE_NAME_STRATEGY === 'custom_field') {
    return { firstname: first, lastname: last }
  }
  if (MIDDLE_NAME_STRATEGY === 'lastname_pack') {
    return { firstname: first, lastname: [middle, last].filter(Boolean).join(' ') }
  }
  // firstname_pack (default)
  return { firstname: [first, middle].filter(Boolean).join(' '), lastname: last }
}

function buildDescription(fd) {
  const parts = []

  if (fd.middleName || fd.middleInitial) parts.push(`MIDDLE NAME: ${fd.middleName || fd.middleInitial}`)
  if (fd.civilStatus) parts.push(`CIVIL STATUS: ${fd.civilStatus}`)
  if (fd.tin) parts.push(`TIN: ${fd.tin}`)
  if (fd.purpose) parts.push(`PURPOSE: ${fd.purpose}`)

  // Permanent address (if present and likely different from current)
  if (fd.permanentHouseStreet || fd.permanentBarangay || fd.permanentCity) {
    const perm = [
      fd.permanentHouseStreet,
      fd.permanentBarangay,
      fd.permanentCity,
      fd.permanentProvince,
      fd.permanentZip
    ].filter(Boolean).join(', ')
    if (perm) parts.push(`PERMANENT ADDRESS: ${perm}`)
    if (fd.permanentLengthOfStay) parts.push(`PERMANENT LENGTH OF STAY: ${fd.permanentLengthOfStay}`)
  }
  if (fd.presentLengthOfStay) parts.push(`PRESENT LENGTH OF STAY: ${fd.presentLengthOfStay}`)

  // Business
  if (fd.businessName || fd.businessType || fd.dtiNumber) {
    const biz = [fd.businessStreet, fd.businessBarangay, fd.businessCity, fd.businessProvince, fd.businessZip].filter(Boolean).join(', ')
    if (fd.businessName || fd.businessType) parts.push(`BUSINESS: ${fd.businessName || ''} (${fd.businessType || 'N/A'})`)
    if (biz) parts.push(`BUSINESS ADDRESS: ${biz}`)
    if (fd.dtiNumber) parts.push(`DTI NUMBER: ${fd.dtiNumber}`)
    if (fd.dateEstablished) parts.push(`DATE ESTABLISHED: ${fd.dateEstablished}`)
  }

  // Co-borrower
  if (fd.coBorrowerFirstName || fd.coBorrowerLastName || fd.coBorrowerMobile) {
    const cbName = `${fd.coBorrowerFirstName || ''} ${fd.coBorrowerLastName || ''}`.trim()
    parts.push(`CO-BORROWER: ${cbName} | ${fd.coBorrowerRelationship || ''} | ${fd.coBorrowerMobile || ''}`)
    if (fd.coBorrowerEmployer) parts.push(`CO-BORROWER EMPLOYER: ${fd.coBorrowerEmployer}`)
    if (fd.coBorrowerIncome) parts.push(`CO-BORROWER INCOME: ${fd.coBorrowerIncome}`)
  }

  // Personal references (legacy single-form schema)
  if (fd.refAName || fd.refBName || fd.refCName) {
    parts.push('PERSONAL REFERENCES:')
    if (fd.refAName) parts.push(`A. ${fd.refAName} | ${fd.refARelationship || ''} | ${fd.refAContact || ''}`)
    if (fd.refBName) parts.push(`B. ${fd.refBName} | ${fd.refBRelationship || ''} | ${fd.refBContact || ''}`)
    if (fd.refCName) parts.push(`C. ${fd.refCName} | ${fd.refCRelationship || ''} | ${fd.refCContact || ''}`)
  }

  return parts.join('\n').trim()
}

// Keys consumed by the mapper. Used for drift detection so future frontend
// additions get logged as unmapped.
const CONSUMED_KEYS = new Set([
  'firstName', 'middleName', 'middleInitial', 'lastName',
  'mobile', 'email', 'dob', 'dateOfBirth',
  'address', 'city', 'province', 'zipcode', 'barangay',
  'presentHouseStreet', 'presentBarangay', 'presentCity', 'presentProvince', 'presentZip', 'presentLengthOfStay',
  'permanentHouseStreet', 'permanentBarangay', 'permanentCity', 'permanentProvince', 'permanentZip', 'permanentLengthOfStay',
  'employmentStatus', 'monthlyIncome',
  'businessName', 'businessType', 'businessStreet', 'businessBarangay', 'businessCity', 'businessProvince', 'businessZip',
  'dtiNumber', 'dateEstablished',
  'coBorrowerFirstName', 'coBorrowerLastName', 'coBorrowerMobile', 'coBorrowerRelationship', 'coBorrowerEmployer', 'coBorrowerIncome',
  'civilStatus', 'tin', 'purpose', 'landline',
  'refAName', 'refARelationship', 'refAContact',
  'refBName', 'refBRelationship', 'refBContact',
  'refCName', 'refCRelationship', 'refCContact',
  // form-control fields not borrower-related
  'loanType', 'loanAmount', 'loanTerm', 'paymentTerm', 'consentAgreed', 'sales_officer_id'
])

// Required-non-empty keys we expect in every outgoing borrower payload.
const REQUIRED_NON_EMPTY = [
  'borrower_firstname',
  'borrower_lastname',
  'borrower_mobile',
  'borrower_dob',
  'borrower_address',
  'borrower_city',
  'borrower_province'
]

function buildBorrowerPayload(formData, finScore) {
  const fd = formData || {}
  const fs = finScore || {}

  const { firstname, lastname } = buildBorrowerName(fd)
  const addr = pickAddress(fd)
  const dob = fd.dateOfBirth || fd.dob

  return {
    borrower_country: 'PH',
    borrower_firstname: firstname,
    borrower_lastname: lastname,
    borrower_mobile: fd.mobile || '',
    borrower_email: fd.email || '',
    borrower_dob: formatDOB(dob),
    borrower_address: addr.street,
    borrower_city: addr.city,
    borrower_province: addr.province,
    borrower_zipcode: addr.zip,
    borrower_landline: fd.landline || '',
    borrower_working_status: WORKING_STATUS_MAP[fd.employmentStatus] || 'Employee',
    borrower_credit_score: fs.score ?? '',
    borrower_unique_number: fd.tin || '',
    borrower_business_name: fd.businessName || '',
    borrower_description: buildDescription(fd),
    custom_field_26904: addr.barangay,
    custom_field_27065: fs.score != null ? String(fs.score) : '',
    custom_field_27066: fs.riskBand != null ? String(fs.riskBand) : '',
    custom_field_27067: fs.fraudFlag != null ? String(fs.fraudFlag) : ''
  }
}

function checkPayload(formData, payload) {
  // Required-field warning
  const missing = REQUIRED_NON_EMPTY.filter((k) => !payload[k])
  if (missing.length > 0) {
    console.warn('[loandisk] payload missing required-non-empty fields:', missing.join(', '))
  }
  // Drift detector — keys present in formData but not consumed by mapper
  const fdKeys = Object.keys(formData || {})
  const unmapped = fdKeys.filter((k) => !CONSUMED_KEYS.has(k))
  if (unmapped.length > 0) {
    console.warn('[loandisk] unmapped form keys (mapper skipped):', unmapped.join(', '))
  }
}

function logCall({ op, method, url, payload, response, error, elapsedMs }) {
  if (error) {
    console.error(`[loandisk:${op}] FAILED ${method} ${url} elapsed=${elapsedMs}ms status=${error.response?.status || 'n/a'}`)
    if (payload) console.error(`[loandisk:${op}] payload=${truncate(JSON.stringify(payload))}`)
    if (error.response?.data) console.error(`[loandisk:${op}] response=${truncate(JSON.stringify(error.response.data))}`)
    if (!error.response) console.error(`[loandisk:${op}] error=${error.message}`)
    return
  }
  console.log(`[loandisk:${op}] OK ${method} ${url} elapsed=${elapsedMs}ms`)
  if (response) console.log(`[loandisk:${op}] response=${truncate(JSON.stringify(response))}`)
}

function truncate(s, max = 4000) {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max}b]` : s
}

// We don't yet have a captured real Loandisk "TIN already exists" error
// string, so the auto-retry path is intentionally disabled — too easy to
// false-positive on benign messages that just mention the field by name.
// When a real collision is observed, capture the response, encode the exact
// signature here, and flip ENABLE_TIN_RETRY to true.
const ENABLE_TIN_RETRY = false
function isUniqueNumberConflict(_err) {
  return false
}

async function createBorrower(formData, finScore) {
  const payload = buildBorrowerPayload(formData, finScore)
  checkPayload(formData, payload)

  const url = `${baseUrl()}/borrower`
  const headers = authHeaders()
  const start = Date.now()

  console.log('[loandisk:createBorrower] payload=', truncate(JSON.stringify(payload)))

  try {
    const response = await axios.post(url, payload, { headers })
    logCall({ op: 'createBorrower', method: 'POST', url, response: response.data, elapsedMs: Date.now() - start })
    const borrowerId = response.data?.response?.borrower_id
    if (!borrowerId) throw new Error('Loandisk createBorrower returned no borrower_id')
    return borrowerId
  } catch (err) {
    logCall({ op: 'createBorrower', method: 'POST', url, payload, error: err, elapsedMs: Date.now() - start })

    // Unique-number collision (TIN already in Loandisk for another borrower).
    // Retry once without borrower_unique_number — TIN preserved in description.
    if (ENABLE_TIN_RETRY && payload.borrower_unique_number && isUniqueNumberConflict(err)) {
      console.warn('[loandisk:createBorrower] unique_number conflict — retrying without TIN')
      const retryStart = Date.now()
      const retryPayload = { ...payload, borrower_unique_number: '' }
      try {
        const retry = await axios.post(url, retryPayload, { headers })
        logCall({ op: 'createBorrower:retry', method: 'POST', url, response: retry.data, elapsedMs: Date.now() - retryStart })
        const borrowerId = retry.data?.response?.borrower_id
        if (!borrowerId) throw new Error('Loandisk createBorrower retry returned no borrower_id')
        return borrowerId
      } catch (retryErr) {
        logCall({ op: 'createBorrower:retry', method: 'POST', url, payload: retryPayload, error: retryErr, elapsedMs: Date.now() - retryStart })
        throw retryErr
      }
    }
    throw err
  }
}

// Loandisk PUT semantics (per their API docs):
//   "For PUT requests, you must specify all of the data that should exist
//    including those fields that you do not want to update. If you specify
//    only the fields you want to update, other optional fields will be
//    updated with empty values."
// So we GET first, merge our new fields over current values (only when
// non-empty), then PUT. This preserves anything ops set in the Loandisk UI
// (photos, access_ids, custom fields) that we don't track on our side.
async function updateBorrower(borrowerId, formData, finScore, opts = {}) {
  if (!borrowerId) throw new Error('updateBorrower: borrowerId required')

  const newFields = buildBorrowerPayload(formData, finScore)
  checkPayload(formData, newFields)

  const current = opts.currentBorrower || (await getBorrower(borrowerId))
  if (!current) throw new Error(`updateBorrower: borrower ${borrowerId} not found in Loandisk`)

  // Start from current, overlay any non-empty new fields.
  const merged = { ...current }
  for (const [k, v] of Object.entries(newFields)) {
    if (v !== '' && v !== null && v !== undefined) {
      merged[k] = v
    }
  }
  // Required fields must always be present even if blank-current and blank-new.
  if (!merged.borrower_country) merged.borrower_country = 'PH'

  const url = `${baseUrl()}/borrower/${borrowerId}`
  const headers = authHeaders()
  const start = Date.now()

  try {
    const response = await axios.put(url, merged, { headers })
    logCall({ op: 'updateBorrower', method: 'PUT', url, response: response.data, elapsedMs: Date.now() - start })
    return response.data
  } catch (err) {
    logCall({ op: 'updateBorrower', method: 'PUT', url, payload: merged, error: err, elapsedMs: Date.now() - start })
    throw err
  }
}

async function getBorrower(borrowerId) {
  if (!borrowerId) throw new Error('getBorrower: borrowerId required')
  const url = `${baseUrl()}/borrower/${borrowerId}`
  const headers = authHeaders()
  const start = Date.now()
  try {
    const response = await axios.get(url, { headers })
    logCall({ op: 'getBorrower', method: 'GET', url, elapsedMs: Date.now() - start })
    return response.data?.response || null
  } catch (err) {
    logCall({ op: 'getBorrower', method: 'GET', url, error: err, elapsedMs: Date.now() - start })
    throw err
  }
}

async function uploadFile(borrowerId, fileName, fileBuffer) {
  const headers = authHeaders()
  const presignUrl = `${baseUrl()}/borrower/${borrowerId}/upload_file_extension/${fileName}`
  const presignStart = Date.now()

  try {
    const presignedResponse = await axios.get(presignUrl, { headers })
    logCall({ op: 'uploadFile:presign', method: 'GET', url: presignUrl, elapsedMs: Date.now() - presignStart })

    const presigned_url = presignedResponse.data?.response?.Results?.[0]?.presigned_url
    const file_id = presignedResponse.data?.response?.Results?.[0]?.file_id
    if (!presigned_url || !file_id) {
      throw new Error('Loandisk presign returned no url/file_id')
    }

    const putStart = Date.now()
    await axios.put(presigned_url, fileBuffer, {
      headers: { 'Content-Type': 'application/octet-stream' }
    })
    console.log(`[loandisk:uploadFile] OK ${fileName} -> file_id=${file_id} elapsed=${Date.now() - putStart}ms`)
    return file_id
  } catch (err) {
    console.error(`[loandisk:uploadFile] FAILED ${fileName} status=${err.response?.status || 'n/a'} msg=${err.message}`)
    throw err
  }
}

async function uploadAllFiles(borrowerId, files) {
  const fileIds = []
  for (const file of files) {
    const fileId = await uploadFile(borrowerId, file.originalname, file.buffer)
    fileIds.push(fileId)
  }
  console.log(`[loandisk:uploadAllFiles] uploaded ${files.length} file(s) for borrower ${borrowerId}`)
  return fileIds
}

// ---------------------------------------------------------------------------
// Loandisk loan creation
//
// add_loan field reference: docs/loandisk-api-documentation.pdf p.18-20.
// Required fields handled here: loan_product_id, loan_principal_amount,
// loan_released_date, loan_interest_method, loan_interest_type,
// loan_interest_period, loan_duration_period, loan_duration,
// loan_payment_scheme_id, loan_num_of_repayments, loan_decimal_places,
// loan_application_id, loan_disbursed_by_id (placeholder — see below).
//
// Disbursement: out of scope per ops, but the API marks loan_disbursed_by_id
// Required. We send Cash (188405) by default; override via env if ops picks
// a different placeholder.
//
// Fees: included as loan_fee_id_<id> percentage + loan_fee_schedule_<id>
// strategy. Both fees are deductible on release date.
// ---------------------------------------------------------------------------

function formatMMDDYYYY(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function disbursedById() {
  const fromEnv = process.env[DISBURSEMENT.env_override_key]
  return fromEnv ? Number(fromEnv) : DISBURSEMENT.default_disbursed_by_id
}

// Build the full add_loan payload from approved-application inputs.
// Pure: takes already-validated values and returns a flat object.
function buildLoanPayload(input) {
  const {
    borrower_id,
    loan_type,
    principal,
    duration_months,
    interest_rate,
    payment_scheme_id,
    loan_application_id,
    released_date
  } = input

  const product = getProductConfig(loan_type)
  if (!product) throw new Error(`buildLoanPayload: unknown loan_type ${loan_type}`)

  // Resolve payment_scheme_id: explicit input wins; otherwise look up by loan_type.
  // Throw early with a descriptive error if loan_type has no mapping.
  let resolved_scheme_id = payment_scheme_id != null
    ? Number(payment_scheme_id)
    : PAYMENT_SCHEME_IDS_BY_LOAN_TYPE[normalizeLoanType(loan_type)]
  if (resolved_scheme_id == null || !Number.isFinite(resolved_scheme_id)) {
    throw new Error(
      `buildLoanPayload: no payment_scheme_id resolvable for loan_type "${loan_type}". ` +
      `Provide payment_scheme_id explicitly or add a mapping in PAYMENT_SCHEME_IDS_BY_LOAN_TYPE.`
    )
  }

  const num_of_repayments = calculateRepayments(duration_months, resolved_scheme_id)
  const fees = calculateLoanFees(principal)
  const totalInterest = calculateTotalInterest(principal, interest_rate, duration_months)

  // Sanity check: principal × rate × duration === total_interest
  const sanity = (principal * (interest_rate / 100) * duration_months).toFixed(2)
  console.log(`[loandisk:buildLoanPayload] interest sanity: principal=${principal} rate=${interest_rate} months=${duration_months} -> total=${sanity} (matches=${Number(sanity) === totalInterest})`)
  console.log(`[loandisk:buildLoanPayload] fees: service=${fees.service_fee} insurance=${fees.insurance_fee} total=${fees.total_fees} net=${fees.net_disbursement}`)

  const serviceFeeId = FEE_CONFIG.loandisk_fee_ids.service_processing
  const insuranceFeeId = FEE_CONFIG.loandisk_fee_ids.insurance
  const feeSchedule = FEE_CONFIG.loandisk_fee_schedule

  const payload = {
    loan_product_id: product.loandisk_product_id,
    borrower_id,
    loan_application_id: loan_application_id || `GR8-${Date.now()}`,
    loan_disbursed_by_id: disbursedById(),
    loan_principal_amount: Number(principal).toFixed(2),
    // INTENTIONAL (confirmed by ops 2026-05): loan_released_date defaults to
    // the approval date when no release_date is supplied. Loandisk auto-
    // populates release-date = approval-date on its end; we mirror that here
    // so the value is explicit in the payload. Do not change without ops sign-off.
    loan_released_date: released_date || formatMMDDYYYY(new Date()),
    loan_interest_method: LOAN_DEFAULTS.interest_method,
    loan_interest_type: LOAN_DEFAULTS.interest_type,
    loan_interest_period: LOAN_DEFAULTS.interest_period,
    loan_interest: Number(interest_rate),
    loan_duration_period: LOAN_DEFAULTS.duration_period,
    loan_duration: Number(duration_months),
    loan_payment_scheme_id: resolved_scheme_id,
    loan_num_of_repayments: num_of_repayments,
    loan_decimal_places: LOAN_DEFAULTS.decimal_places,
    // Fees: send rate as a percentage (Loandisk's `loan_fee_id_<id>` accepts
    // numbers/decimals — the form treats this as the percentage value when
    // the fee is configured as %).
    [`loan_fee_id_${serviceFeeId}`]: (FEE_CONFIG.service_processing_fee_rate * 100).toFixed(2),
    [`loan_fee_schedule_${serviceFeeId}`]: feeSchedule,
    [`loan_fee_id_${insuranceFeeId}`]: (FEE_CONFIG.insurance_fee_rate * 100).toFixed(2),
    [`loan_fee_schedule_${insuranceFeeId}`]: feeSchedule
  }

  return { payload, fees, num_of_repayments, total_interest: totalInterest }
}

async function createLoan(input) {
  const { valid, errors } = validateLoanInputs(input)
  if (!valid) {
    const msg = `Loandisk createLoan validation failed: ${errors.join('; ')}`
    console.error(`[loandisk:createLoan] ${msg}`, { input: { ...input, discount_reason: input.discount_reason ? '<set>' : '<unset>' } })
    throw new Error(msg)
  }

  if (!input.borrower_id) {
    throw new Error('createLoan: borrower_id required')
  }

  const { payload, fees, num_of_repayments, total_interest } = buildLoanPayload(input)

  // Discount audit log — compare against the per-loan-type default, not the
  // global LOAN_DEFAULTS.interest_rate, so loans approved at their type default
  // (e.g. Personal=3.5) don't get falsely flagged as discounted.
  const defaultRateForType = getDefaultInterestRate(input.loan_type)
  if (Number.isFinite(defaultRateForType) && Number(input.interest_rate) < defaultRateForType) {
    console.log('[loandisk:createLoan] discount applied', {
      borrower_id: input.borrower_id,
      loan_application_id: payload.loan_application_id,
      approved_rate: input.interest_rate,
      default_rate: defaultRateForType,
      reason: input.discount_reason,
      approver_id: input.approver_id || null
    })
  }

  const url = `${baseUrl()}/loan`
  const headers = authHeaders()
  const start = Date.now()

  console.log('[loandisk:createLoan] payload=', truncate(JSON.stringify(payload)))

  try {
    const response = await axios.post(url, payload, { headers })
    logCall({ op: 'createLoan', method: 'POST', url, response: response.data, elapsedMs: Date.now() - start })
    const loanId = response.data?.response?.loan_id || response.data?.response?.Results?.[0]?.loan_id
    if (!loanId) {
      console.warn('[loandisk:createLoan] response did not contain loan_id; full response logged above')
    }
    return { loan_id: loanId || null, fees, num_of_repayments, total_interest, payload }
  } catch (err) {
    logCall({ op: 'createLoan', method: 'POST', url, payload, error: err, elapsedMs: Date.now() - start })
    throw err
  }
}

module.exports = {
  createBorrower,
  updateBorrower,
  getBorrower,
  uploadAllFiles,
  uploadFile,
  buildBorrowerPayload,
  buildLoanPayload,
  createLoan,
  MIDDLE_NAME_STRATEGY
}
