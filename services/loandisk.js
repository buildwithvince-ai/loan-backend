const axios = require('axios')

async function createBorrower(formData, finScore) {
  const BASE_URL = `https://api-main.loandisk.com/${process.env.LOANDISK_PUBLIC_KEY}/${process.env.LOANDISK_BRANCH_ID}`

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Basic ${process.env.LOANDISK_AUTH_CODE}`
  }

  const workingStatusMap = {
    'Employed': 'Employee',
    'Self-Employed': 'Self Employed',
    'Self Employed': 'Self Employed',
    'Business Owner': 'Business Owner',
    'OFW': 'OFW',
    'Employee': 'Employee'
  }

  const payload = {
    borrower_country: 'PH',
    borrower_firstname: formData.firstName,
    borrower_lastname: formData.lastName,
    borrower_mobile: formData.mobile,
    borrower_email: formData.email,
    borrower_dob: formData.dob,
    borrower_address: formData.address,
    borrower_city: formData.city,
    borrower_province: formData.province,
    borrower_zipcode: formData.zipcode,
    borrower_working_status: workingStatusMap[formData.employmentStatus] || 'Employee',
    borrower_credit_score: finScore.score,
        custom_field_26904: formData.barangay,
    borrower_business_name: formData.businessName || '',
    borrower_description: formData.refAName ? `
PERSONAL REFERENCES:
A. Name: ${formData.refAName} | Relationship: ${formData.refARelationship} | Contact: ${formData.refAContact}
B. Name: ${formData.refBName} | Relationship: ${formData.refBRelationship} | Contact: ${formData.refBContact}
C. Name: ${formData.refCName} | Relationship: ${formData.refCRelationship} | Contact: ${formData.refCContact}
`.trim() : ''
  }

  console.log('=== LOANDISK PAYLOAD ===')
  console.log(JSON.stringify(payload, null, 2))
  console.log('========================')

  const response = await axios.post(
    `${BASE_URL}/borrower`,
    payload,
    { headers }
  )

  console.log('FULL RESPONSE:', JSON.stringify(response.data))

  const borrowerId = response.data.response.borrower_id
  console.log('Borrower ID:', borrowerId)
  return borrowerId
}

async function uploadFile(borrowerId, fileName, fileBuffer) {
  const BASE_URL = `https://api-main.loandisk.com/${process.env.LOANDISK_PUBLIC_KEY}/${process.env.LOANDISK_BRANCH_ID}`

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Basic ${process.env.LOANDISK_AUTH_CODE}`
  }

  console.log(`Getting presigned URL for: ${fileName}`)

  const presignedResponse = await axios.get(
    `${BASE_URL}/borrower/${borrowerId}/upload_file_extension/${fileName}`,
    { headers }
  )

  console.log('Presigned response:', JSON.stringify(presignedResponse.data))

  // Fix: URL is nested in Results[0]
  const presigned_url = presignedResponse.data.response.Results[0].presigned_url
  const file_id = presignedResponse.data.response.Results[0].file_id

  console.log('Presigned URL:', presigned_url)
  console.log('File ID:', file_id)
  console.log('Uploading to S3...')

  await axios.put(presigned_url, fileBuffer, {
    headers: { 'Content-Type': 'application/octet-stream' }
  })

  console.log(`File uploaded successfully: ${fileName}`)
  return file_id
}

async function uploadAllFiles(borrowerId, files) {
  const fileIds = []

  for (const file of files) {
    const fileId = await uploadFile(
      borrowerId,
      file.originalname,
      file.buffer
    )
    fileIds.push(fileId)
  }

  console.log(`All files uploaded. Total: ${files.length}`)
  return fileIds
}

module.exports = { createBorrower, uploadAllFiles }
