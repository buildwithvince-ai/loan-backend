require('dotenv').config()

const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')

const app = express()

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

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'x-ci-secret']
}))
app.use(express.json())

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