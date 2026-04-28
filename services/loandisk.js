const axios = require('axios')

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

module.exports = {
  createBorrower,
  updateBorrower,
  getBorrower,
  uploadAllFiles,
  uploadFile,
  buildBorrowerPayload,
  MIDDLE_NAME_STRATEGY
}
