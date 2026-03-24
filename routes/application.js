const express = require('express')
const multer = require('multer')
const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })
const { createBorrower, uploadAllFiles } = require('../services/loandisk')
const { supabase } = require('../services/supabase')

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

    // Step 1 — Pre-qualification
    const reasons = preQualify(formData)
    if (reasons.length > 0) {
      return res.status(200).json({ status: 'declined', reasons })
    }

    // Step 2 — FinScore
    const { getScore } = require('../services/finscore')
    const finScore = await getScore(formData.mobile)
    console.log('FinScore result:', JSON.stringify(finScore))

    // Step 3 — Normalize FinScore
    const finscore_raw = finScore.score || 0
    const finscore_normalized = finscore_raw === 0 ? 0 :
      Math.round(((finscore_raw - 300) / (999 - 300)) * 100)

    // Step 4 — Save to Supabase
    const reference_id = 'GR8-' + Date.now()

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
        file_ids: []
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
    const leader = members[0]
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
        file_ids: [],
        group_members: members
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