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
    sme:      { min: 50000, max: 100000 },
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

    // Step 2 — FinScore (mocked until credentials arrive)
    // TODO: replace with real FinScore call once sandbox credentials received
    // const finScore = await getScore(formData.mobile)
    const finScore = {
      score: 700,
      riskBand: '21',
      fraudFlag: 'false'
    }

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