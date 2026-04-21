require('dotenv').config()

const express = require('express')
const cors = require('cors')

const app = express()

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
app.use('/api/application', applicationRouter)

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
})