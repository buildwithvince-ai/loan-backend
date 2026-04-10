const axios = require('axios')

let cachedToken = null
let tokenExpiry = null

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken
  }

  const credentials = Buffer.from(
    `${process.env.FINSCORE_CLIENT_ID}:${process.env.FINSCORE_CLIENT_SECRET}`
  ).toString('base64')

  const response = await axios.post(
    process.env.FINSCORE_AUTH_URL,
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    }
  )

  cachedToken = response.data.access_token
  tokenExpiry = Date.now() + (3500 * 1000)
  console.log('FinScore token acquired')
  return cachedToken
}

function convertMobile(mobile) {
  // Convert 09XXXXXXXXX to 63XXXXXXXXX
  if (mobile.startsWith('09')) {
    return '63' + mobile.slice(1)
  }
  return mobile
}

function detectProductId(mobile) {
  // Detect telco from prefix
  // Source: https://github.com/0xbitx/PH_Mobile_Number_Prefixes
  const converted = mobile.startsWith('09') ? '63' + mobile.slice(1) : mobile
  const prefix = converted.slice(2, 5) // get 3-digit prefix after 63

  // DITO checked first — some prefixes overlap with Smart
  const ditoPrefixes = ['895','896','897','898','991','992','993','994']

  // Globe Telecom (including TM)
  const globePrefixes = ['817','905','906','915','916','917','926','927',
    '935','936','945','955','956','965','966','967','975','976','977',
    '995','997']

  // Smart (including TNT) + Sun Cellular — all use Q1
  // Smart: 811-813, 907-914, 918-921, 928-930, 938-940, 946-951, 961, 963, 968-970, 981, 989, 998-999
  // Sun: 922-925, 931-934, 941-944

  if (ditoPrefixes.some(p => prefix === p)) return 'DT1;'
  if (globePrefixes.some(p => prefix === p)) return 'GL1;'
  return 'Q1;' // default to Smart/Sun
}

async function getScore(mobileNumber) {
  try {
    const token = await getAccessToken()
    const converted = convertMobile(mobileNumber)
    const productId = detectProductId(mobileNumber)
    const requestId = Date.now().toString()

    console.log(`FinScore request — mobile: ${converted}, product: ${productId}`)

    const response = await axios.post(
      process.env.FINSCORE_SCORE_URL,
      {
        mobilenumber: converted,
        productids: productId,
        requestid: requestId
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    )

    console.log('FinScore full response:', JSON.stringify(response.data, null, 2))

    const data = response.data

    // Handle no score available
    if (data.code === '1000') {
      console.log('FinScore: no score available for this number')
      return { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
    }

    // Extract score and band from response
    const productKey = productId.replace(';', '')
    const scoreData = data.scores?.[productKey]
    const score = scoreData?.[0]?.[1] ?? 0
    const band = scoreData?.[1]?.[1] ?? 0

    return {
      score,
      riskBand: band.toString(),
      fraudFlag: 'false',
      noScore: false
    }

  } catch (error) {
    const status = error.response?.status
    const errData = error.response?.data

    // 4xx from FinScore = invalid or non-existent phone number
    if (status >= 400 && status < 500) {
      console.error('FinScore: phone not found or invalid —', status, errData)
      return { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true, phoneNotFound: true }
    }

    console.error('FinScore error:', errData || error.message)
    // Return safe fallback for network/server errors — do not block application
    return { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
  }
}

module.exports = { getScore }
