const express = require('express')
const multer = require('multer')
const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })
const { createBorrower, uploadAllFiles } = require('../services/loandisk')

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

// Main submit route
router.post('/submit', upload.any(), async (req, res) => {
  try {
    const formData = req.body
    const files = req.files || []

    // Step 1 — Pre-qualification
    const reasons = preQualify(formData)
    if (reasons.length > 0) {
      return res.status(200).json({ status: 'declined', reasons })
    }

    // Step 2 — FinScore
    const { getScore } = require('../services/finscore')
    const finScore = await getScore(formData.mobile)
    console.log('FinScore result:', JSON.stringify(finScore))

    // Step 3 — Create borrower in Loandisk
    const borrowerId = await createBorrower(formData, finScore)

    // Step 4 — Upload files to S3
    let fileIds = []
    if (files.length > 0) {
      fileIds = await uploadAllFiles(borrowerId, files)
    }

    // Step 5 — Return success
    return res.status(200).json({
      status: 'success',
      referenceId: borrowerId
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

    // Split loan equally
    const perMemberAmount = amount / members.length
    const { getScore } = require('../services/finscore')
    const borrowerIds = []
    const results = []

    // Process each member sequentially
    for (let index = 0; index < members.length; index++) {
      const member = members[index]

      // FinScore
      let finScore = { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
      try {
        finScore = await getScore(member.mobile)
        console.log(`[Group] Member ${index} FinScore:`, JSON.stringify(finScore))
      } catch (err) {
        console.error(`[Group] Member ${index} FinScore failed:`, err.message)
      }

      // Build form data
      const memberFormData = {
        firstName: member.firstName,
        lastName: member.lastName,
        mobile: member.mobile,
        email: member.email || '',
        dob: member.dob,
        address: member.address,
        barangay: member.barangay,
        city: member.city,
        province: member.province,
        zipcode: member.zipcode,
        employmentStatus: member.employmentStatus,
        monthlyIncome: member.monthlyIncome,
        businessName: groupName,
        loanAmount: perMemberAmount,
        loanType: loanType
      }

      // Create borrower
      let borrowerId
      try {
        borrowerId = await createBorrower(memberFormData, finScore)
        console.log(`[Group] Member ${index} borrower created:`, borrowerId)
      } catch (err) {
        console.error(`[Group] Member ${index} Loandisk creation failed:`, err.message)
        return res.status(500).json({
          status: 'error',
          message: `Failed at member ${index + 1}. Please try again.`
        })
      }

      // Upload member files
      const memberFiles = files.filter(f => f.fieldname.startsWith(`member_${index}_`))
      if (memberFiles.length > 0) {
        await uploadAllFiles(borrowerId, memberFiles)
      }

      borrowerIds.push(borrowerId)
      results.push({ memberId: index, borrowerId, score: finScore.score })
    }

    return res.status(200).json({
      status: 'success',
      referenceId: borrowerIds[0],
      totalMembers: members.length,
      borrowerIds
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