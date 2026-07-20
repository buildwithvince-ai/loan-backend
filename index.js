require('dotenv').config()

const express = require('express')
const cors = require('cors')
const compression = require('compression')
const rateLimit = require('express-rate-limit')

const app = express()

// Gzip JSON responses. The admin list payload is the main win — sizeable JSON
// rows compress ~85%. Content-negotiated via Accept-Encoding, so non-gzip
// clients are unaffected.
app.use(compression())

// Trust the Railway / proxy `X-Forwarded-For` so rate limiters key on the
// real client IP rather than the proxy.
app.set('trust proxy', 1)

// Public, unauthenticated routes need rate limits. Tuned for low-volume
// lending traffic — generous enough not to bite real users, tight enough
// to slow scrapers/credential-stuffing.
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many submissions. Please wait a minute and try again.' }
})

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests. Please slow down.' }
})

// Disable automatic ETag on JSON responses. Admin files route returns
// time-limited signed URLs — ETag + conditional GET causes browsers to
// reuse expired payloads via 304. Other routes don't rely on ETags.
app.set('etag', false)

// Explicit origin allowlist (L2). Reflecting any origin with credentials let a
// malicious site make credentialed cross-origin calls. Allow the public form +
// admin dashboard origins, plus localhost in non-production for dev. Override
// via CORS_ORIGINS (comma-separated) on Railway.
const DEFAULT_ORIGINS = [
  'https://gr8lendingcorporation.com',
  'https://www.gr8lendingcorporation.com'
]
const allowedOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS)
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:5173', 'http://localhost:3000')
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients (curl, server-to-server) that send no Origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    // Disallowed origin: signal "no CORS grant" rather than throwing. Throwing
    // routes to Express's error handler and returns a 500 — which reads as a
    // server crash, pollutes error monitoring, and masked a real config gap
    // (a legitimate frontend origin missing from the allowlist surfaced as an
    // outage of 500s). With (null, false) cors simply omits the
    // Access-Control-Allow-Origin header: the browser blocks the response and
    // the request completes cleanly, no 500. Log the rejected origin so a
    // missing allowlist entry is diagnosable — add it via CORS_ORIGINS.
    console.warn(`[cors] blocked disallowed origin: ${origin}`)
    return callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-ci-secret']
}))
app.use(express.json())

// Per-request timing — answers "which endpoint is slow in production" from
// Railway logs without redeploying instrumentation.
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api/')) {
      console.log(`[timing] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`)
    }
  })
  next()
})

app.get('/', (req, res) => {
  res.json({ status: 'alive' })
})

const applicationRouter = require('./routes/application')
// Apply submit limiter only to the public submit endpoints. Test/admin
// helpers under /api/application/test-* stay unthrottled.
app.use('/api/application/submit', submitLimiter)
app.use('/api/application/submit-group', submitLimiter)
app.use('/api/application', applicationRouter)

const borrowersRouter = require('./routes/borrowers')
app.use('/api/borrowers', searchLimiter, borrowersRouter)

const adminRouter = require('./routes/admin')
app.use('/api/admin', adminRouter)

const ciRouter = require('./routes/ci')
app.use('/api/ci', ciRouter)

const authRouter = require('./routes/auth')
app.use('/api/auth', authRouter)

const usersRouter = require('./routes/users')
app.use('/api/users', usersRouter)

const pipelineRouter = require('./routes/pipeline')
app.use('/api/pipeline', pipelineRouter)

const confirmRouter = require('./routes/confirm')
app.use('/api/confirm', confirmRouter)

const publicRouter = require('./routes/public')
app.use('/api/public', publicRouter)

const reportsRouter = require('./routes/reports')
app.use('/api/reports', reportsRouter)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  // Surface which Loandisk branch this instance writes to — confirm prod locks
  // onto the live branch and dev/staging onto the test branch.
  const { branchId } = require('./services/loandisk')
  console.log(`[loandisk] branch=${branchId()} (NODE_ENV=${process.env.NODE_ENV})`)
})