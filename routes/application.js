const express = require('express')
const multer = require('multer')
const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })
const { createBorrower, uploadAllFiles } = require('../services/loandisk')
const { supabase } = require('../services/supabase')
const { compressFiles } = require('../services/compress')

// Pre-qualification check
function preQualify(formData) {
  const reasons = []

  // Age check (21-65)
  if (formData.dob) {
    const dob = new Date(formData.dob)
    const today = new Date()
    let age = today.getFullYear() - dob.getFullYear()
    const m = today.getMonth() - dob.getMonth()
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
    if (age < 21 || age > 65) {
      reasons.push('Applicant must be between 21 and 65 years old')
    }
  }

  // Income check per loan type
  const income = parseFloat(formData.monthlyIncome) || 0
  const minIncome = {
    personal: 15000,
    sme: 30000,
    akap: 10000
  }
  const required = minIncome[formData.loanType] || 0
  if (income < required) {
    reasons.push(`Minimum monthly income for this loan is ₱${required.toLocaleString()}`)
  }

  // Loan amount check
  const amount = parseFloat(formData.loanAmount) || 0
  const limits = {
    personal: { min: 10000, max: 30000 },
    sme:      { min: 50000, max: 300000 },
    akap:     { min: 5000,  max: 40000 }
  }
  const limit = limits[formData.loanType]
  if (limit && (amount < limit.min || amount > limit.max)) {
    reasons.push(`Loan amount must be between ₱${limit.min.toLocaleString()} and ₱${limit.max.toLocaleString()}`)
  }

  // Mobile format check (09XXXXXXXXX)
  if (formData.mobile && !/^09\d{9}$/.test(formData.mobile)) {
    reasons.push('Invalid mobile number format')
  }

  return reasons
}

// Test routes (keep for debugging)
router.post('/test-loandisk', async (req, res) => {
  try {
    const testFormData = {
      firstName: 'Test',
      lastName: 'Borrower',
      mobile: '09171234567',
      email: 'test@email.com',
      dob: '01/15/1990',
      address: '123 Test Street',
      barangay: 'Poblacion',
      city: 'Malolos',
      province: 'Bulacan',
      zipcode: '3000',
      employmentStatus: 'Employee'
    }
    const testFinScore = { score: 750, riskBand: '21', fraudFlag: 'false' }
    const borrowerId = await createBorrower(testFormData, testFinScore)
    return res.status(200).json({ status: 'success', borrowerId })
  } catch (error) {
    console.error('Loandisk test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

router.post('/test-upload', upload.single('file'), async (req, res) => {
  try {
    const borrowerId = '7527769'
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file uploaded' })
    }
    const fileIds = await uploadAllFiles(borrowerId, [req.file])
    return res.status(200).json({ status: 'success', fileIds })
  } catch (error) {
    console.error('Upload test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

// Main submit route — saves to Supabase, no Loandisk until admin approval
router.post('/submit', upload.any(), async (req, res) => {
  try {
    const formData = req.body
    const files = req.files || []

    // Step 1 — Check for existing pending application with same phone
    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('phone', formData.mobile)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return res.status(200).json({
        status: 'error',
        message: 'An application for this mobile number is already under review. Please wait for our team to contact you.'
      })
    }

    // Step 1b — Prior decline detection
    let prior_decline_flag = false
    let prior_decline_reference = null
    const { data: priorDeclined } = await supabase
      .from('applications')
      .select('reference_id')
      .eq('phone', formData.mobile)
      .eq('status', 'declined')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (priorDeclined) {
      prior_decline_flag = true
      prior_decline_reference = priorDeclined.reference_id
    }

    // Step 2 — Pre-qualification
    const reasons = preQualify(formData)
    if (reasons.length > 0) {
      return res.status(200).json({ status: 'declined', reasons })
    }

    // Step 3 — FinScore
    const { getScore } = require('../services/finscore')
    const finScore = await getScore(formData.mobile)
    console.log('FinScore result:', JSON.stringify(finScore))

    // Step 4 — Normalize FinScore
    const finscore_raw = finScore.score || 0
    const finscore_normalized = finscore_raw === 0 ? 0 :
      Math.round(((finscore_raw - 300) / (999 - 300)) * 100)

    // Step 5 — Compress and upload files to Supabase Storage
    const reference_id = 'GR8-' + Date.now()
    const folderName = `${reference_id}_${formData.firstName}-${formData.lastName}`
    const file_metadata = []
    const compressedFiles = await compressFiles(files)

    for (const file of compressedFiles) {
      const storagePath = `${folderName}/${file.fieldname}_${file.originalname}`
      const { error: uploadError } = await supabase.storage
        .from('application-files')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        })

      if (uploadError) {
        console.error('File upload error:', uploadError.message)
        continue
      }

      file_metadata.push({
        field_name: file.fieldname,
        original_name: file.originalname,
        original_size: file.originalSize || file.size,
        size: file.size,
        storage_path: storagePath
      })
    }

    // Step 6 — Extract consent
    const consent_agreed = formData.consentAgreed === 'true' || formData.consentAgreed === true
    const consent_agreed_at = new Date().toISOString()

    // Step 7 — Save to Supabase

    const { error } = await supabase
      .from('applications')
      .insert({
        reference_id,
        phone: formData.mobile,
        loan_type: formData.loanType,
        full_name: formData.firstName + ' ' + formData.lastName,
        email: formData.email,
        loan_amount: formData.loanAmount,
        loan_term: formData.loanTerm,
        form_data: formData,
        finscore_raw,
        finscore_normalized,
        status: 'pending',
        stage: 'sales_officer',
        file_metadata,
        consent_agreed,
        consent_agreed_at,
        prior_decline_flag,
        prior_decline_reference
      })

    if (error) throw error

    return res.status(200).json({
      status: 'success',
      referenceId: reference_id
    })

  } catch (error) {
    console.error('Submit error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong. Please try again.'
    })
  }
})

// Group / SBL multi-member submit route
router.post('/submit-group', upload.any(), async (req, res) => {
  try {
    const { loanType, totalLoanAmount, loanTerm, groupName } = req.body
    const members = JSON.parse(req.body.members)
    const files = req.files || []

    // Check for existing pending application with leader's phone
    const leader = members[0]
    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('phone', leader.mobile)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return res.status(200).json({
        status: 'error',
        message: 'An application for this mobile number is already under review. Please wait for our team to contact you.'
      })
    }

    // Prior decline detection for group leader
    let prior_decline_flag = false
    let prior_decline_reference = null
    const { data: priorDeclinedGroup } = await supabase
      .from('applications')
      .select('reference_id')
      .eq('phone', leader.mobile)
      .eq('status', 'declined')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (priorDeclinedGroup) {
      prior_decline_flag = true
      prior_decline_reference = priorDeclinedGroup.reference_id
    }

    // Validate member count
    if (loanType === 'group' && members.length < 5) {
      return res.status(200).json({ status: 'declined', reasons: ['Group Loan requires at least 5 members'] })
    }
    if (loanType === 'sbl' && members.length < 1) {
      return res.status(200).json({ status: 'declined', reasons: ['SBL requires at least 1 member'] })
    }

    // Validate total loan amount
    const amount = parseFloat(totalLoanAmount) || 0
    const limits = {
      group: { min: 10000, max: 50000 },
      sbl: { min: 5000, max: 100000 }
    }
    const limit = limits[loanType]
    if (limit && (amount < limit.min || amount > limit.max)) {
      return res.status(200).json({
        status: 'declined',
        reasons: [`Loan amount must be between ₱${limit.min.toLocaleString()} and ₱${limit.max.toLocaleString()}`]
      })
    }

    // Validate each member
    const memberErrors = []
    members.forEach((member, i) => {
      // Age check
      if (member.dob) {
        const dob = new Date(member.dob)
        const today = new Date()
        let age = today.getFullYear() - dob.getFullYear()
        const m = today.getMonth() - dob.getMonth()
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
        if (age < 21 || age > 65) {
          memberErrors.push(`Member ${i + 1}: Must be between 21 and 65 years old`)
        }
      }
      // Mobile check
      if (member.mobile && !/^09\d{9}$/.test(member.mobile)) {
        memberErrors.push(`Member ${i + 1}: Invalid mobile number format`)
      }
    })
    if (memberErrors.length > 0) {
      return res.status(200).json({ status: 'declined', reasons: memberErrors })
    }

    // FinScore for leader (first member)
    const { getScore } = require('../services/finscore')
    let finScore = { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
    try {
      finScore = await getScore(leader.mobile)
      console.log('[Group] Leader FinScore:', JSON.stringify(finScore))
    } catch (err) {
      console.error('[Group] Leader FinScore failed:', err.message)
    }

    const finscore_raw = finScore.score || 0
    const finscore_normalized = finscore_raw === 0 ? 0 :
      Math.round(((finscore_raw - 300) / (999 - 300)) * 100)

    const reference_id = 'GR8-' + Date.now()
    const folderName = `${reference_id}_${leader.firstName}-${leader.lastName}`

    const file_metadata = []
    const compressedFiles = await compressFiles(files)

    for (const file of compressedFiles) {
      const storagePath = `${folderName}/${file.fieldname}_${file.originalname}`
      const { error: uploadError } = await supabase.storage
        .from('application-files')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        })

      if (uploadError) {
        console.error('File upload error:', uploadError.message)
        continue
      }

      file_metadata.push({
        field_name: file.fieldname,
        original_name: file.originalname,
        original_size: file.originalSize || file.size,
        size: file.size,
        storage_path: storagePath
      })
    }

    const consent_agreed = req.body.consentAgreed === 'true' || req.body.consentAgreed === true
    const consent_agreed_at = new Date().toISOString()

    const { error } = await supabase
      .from('applications')
      .insert({
        reference_id,
        phone: leader.mobile,
        loan_type: loanType,
        full_name: leader.firstName + ' ' + leader.lastName,
        email: leader.email || '',
        loan_amount: totalLoanAmount,
        loan_term: loanTerm,
        form_data: { loanType, totalLoanAmount, loanTerm, groupName },
        finscore_raw,
        finscore_normalized,
        status: 'pending',
        stage: 'sales_officer',
        file_metadata,
        group_members: members,
        consent_agreed,
        consent_agreed_at,
        prior_decline_flag,
        prior_decline_reference
      })

    if (error) throw error

    return res.status(200).json({
      status: 'success',
      referenceId: reference_id,
      totalMembers: members.length
    })

  } catch (error) {
    console.error('Group submit error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong. Please try again.'
    })
  }
})

router.post('/test-finscore', async (req, res) => {
  try {
    const { getScore } = require('../services/finscore')
    const { mobile } = req.body
    if (!mobile) {
      return res.status(400).json({ status: 'error', message: 'mobile is required' })
    }
    const result = await getScore(mobile)
    return res.status(200).json({ status: 'success', result })
  } catch (error) {
    console.error('FinScore test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

module.exports = router