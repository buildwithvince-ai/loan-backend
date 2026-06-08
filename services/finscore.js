const axios = require('axios')

let cachedToken = null
let tokenExpiry = null

// Mask a mobile to its last 4 digits for logs (M7) — full numbers used to be
// logged unconditionally, a standing PII sink in Railway logs.
function maskMobile(mobile) {
  const s = String(mobile || '')
  return s.length <= 4 ? '****' : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`
}

// Verbose FinScore response logging (full credit payload) is off unless
// FINSCORE_DEBUG=1 — see M7.
const FINSCORE_DEBUG = process.env.FINSCORE_DEBUG === '1'

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
      },
      // Token POST had no timeout (M9): a hung auth endpoint hangs the public
      // /submit request — the 25s score-call timeout doesn't cover this call.
      timeout: 10000
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
  // Source: PH_prefixes_Feb_2023.xlsx
  const converted = mobile.startsWith('09') ? '63' + mobile.slice(1) : mobile
  const prefix = converted.slice(2, 5) // get 3-digit prefix after 63

  // DITO checked first — some prefixes overlap with Smart
  const ditoPrefixes = ['895','896','897','898','991','992','993','994']

  // Globe Telecom (including TM) — full list from PH_prefixes_Feb_2023.xlsx
  const globePrefixes = [
    '817','900','901','902','904','905','906','915','916','917',
    '926','927','935','936','937','945','953','954','955','956',
    '965','966','967','975','976','977','978','979','986','987',
    '988','995','996','997'
  ]

  // Smart (including TNT) + Sun Cellular — all use Q1 (default fallthrough)

  if (ditoPrefixes.some(p => prefix === p)) return 'DT1;'
  if (globePrefixes.some(p => prefix === p)) return 'GL1;'
  return 'Q1;' // default to Smart/Sun
}

/**
 * Normalize a FinScore raw score to 0–100.
 *
 * Prepaid scores: continuous 300–600 range (all products GL1/Q1/DT1)
 * Postpaid scores: discrete 880/920/960 (band 21/22/23)
 * Q1 special values: 91/92/93 (Sun Prepaid), -8 (Smart broadband)
 */
function normalizeScore(raw) {
  if (!raw || raw === 0) return 0

  // Q1 special values — Sun Cellular Prepaid risk buckets
  if (raw === 93) return 75  // Sun Prepaid LOW risk
  if (raw === 92) return 50  // Sun Prepaid MID risk
  if (raw === 91) return 25  // Sun Prepaid HIGH risk
  if (raw === -8) return 10  // Smart broadband HIGH risk

  // Postpaid discrete scores (bands 21/22/23) — all products
  if (raw === 960) return 90  // Low risk
  if (raw === 920) return 60  // Medium risk
  if (raw === 880) return 30  // High risk

  // Q1 Sun Cellular Postpaid (921/922/923)
  if (raw === 923) return 90  // Low risk
  if (raw === 922) return 60  // Medium risk
  if (raw === 921) return 30  // High risk

  // Prepaid continuous range: 300–600
  if (raw >= 300 && raw <= 600) {
    return Math.round(((raw - 300) / 300) * 100)
  }

  // Fallback for unexpected values
  console.error(`FinScore: unexpected raw score ${raw}, returning 0`)
  return 0
}

async function getScore(mobileNumber) {
  try {
    const token = await getAccessToken()
    const converted = convertMobile(mobileNumber)
    const productId = detectProductId(mobileNumber)
    const requestId = Date.now().toString()

    console.log(`FinScore request — mobile: ${maskMobile(converted)}, product: ${productId}`)

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

    if (FINSCORE_DEBUG) {
      console.log('FinScore full response:', JSON.stringify(response.data, null, 2))
    }

    const data = response.data

    // Handle no score available
    if (data.code === '1000') {
      console.log('FinScore: no score available for this number')
      return { score: 0, normalized: 0, riskBand: 'N/A', noScore: true }
    }

    // Extract score and band from response
    const productKey = productId.replace(';', '')
    const scoreData = data.scores?.[productKey]
    const score = scoreData?.[0]?.[1] ?? 0
    const band = scoreData?.[1]?.[1] ?? 0

    return {
      score,
      normalized: normalizeScore(score),
      riskBand: band.toString(),
      noScore: false
    }

  } catch (error) {
    const status = error.response?.status
    const errData = error.response?.data

    // 4xx from FinScore = invalid or non-existent phone number
    if (status >= 400 && status < 500) {
      console.error('FinScore: phone not found or invalid —', status, errData)
      return { score: 0, normalized: 0, riskBand: 'N/A', noScore: true, phoneNotFound: true }
    }

    console.error('FinScore error:', errData || error.message)
    // Return safe fallback for network/server errors — do not block application
    return { score: 0, normalized: 0, riskBand: 'N/A', noScore: true }
  }
}

module.exports = { getScore, normalizeScore }
