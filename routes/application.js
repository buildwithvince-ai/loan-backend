const express = require('express')
const multer = require('multer')
const router = express.Router()

const upload = multer({ storage: multer.memoryStorage() })

router.post('/test-loandisk', async (req, res) => {
  try {
    const { createBorrower } = require('../services/loandisk')

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

    const testFinScore = {
      score: 750,
      riskBand: '21',
      fraudFlag: 'false'
    }

    const borrowerId = await createBorrower(testFormData, testFinScore)

    return res.status(200).json({
      status: 'success',
      borrowerId: borrowerId
    })

  } catch (error) {
    console.error('Loandisk test error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message
    })
  }
})

router.post('/test-upload', upload.single('file'), async (req, res) => {
  try {
    const { uploadAllFiles } = require('../services/loandisk')

    const borrowerId = '7527769'

    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'No file uploaded'
      })
    }

    console.log('File received:', req.file.originalname)
    console.log('File size:', req.file.size, 'bytes')

    const fileIds = await uploadAllFiles(borrowerId, [req.file])

    return res.status(200).json({
      status: 'success',
      fileIds: fileIds
    })

  } catch (error) {
    console.error('Upload test error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: error.message
    })
  }
})

router.post('/submit', (req, res) => {
  res.json({ status: 'route working' })
})

module.exports = router
