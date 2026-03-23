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
  const converted = mobile.startsWith('09') ? '63' + mobile.slice(1) : mobile
  const prefix = converted.slice(2, 5) // get 3-digit prefix after 63

  const smartPrefixes = ['908','911','912','913','914','915','916','917',
    '918','919','920','921','928','929','930','938','939','940','946',
    '947','948','949','950','951','961','963','964','965','967','973',
    '974','975','989','992','993','994','995','996','997','998','999']

  const globePrefixes = ['905','906','915','916','917','926','927','935',
    '936','937','955','956','965','966','967','975','976','977','978',
    '979','995','996','997']

  const ditoPrefixes = ['895','896','897','898','991']

  if (ditoPrefixes.some(p => prefix.startsWith(p.slice(0,3)))) return 'DT1;'
  if (globePrefixes.some(p => prefix === p)) return 'GL1;'
  return 'G;' // default to SMART
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
    console.error('FinScore error:', error.response?.data || error.message)
    // Return safe fallback — do not block application on FinScore failure
    return { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
  }
}

module.exports = { getScore }
