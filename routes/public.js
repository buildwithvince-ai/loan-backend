const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')

// GET /api/public/sales-officers
// Returns active sales officers for form assignment — no auth required
router.get('/sales-officers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, full_name')
      .contains('roles', ['sales_officer'])
      .eq('is_active', true)
      .order('full_name', { ascending: true })

    if (error) throw error

    return res.status(200).json({ status: 'success', data })
  } catch (error) {
    console.error('Public sales-officers error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: 'Unable to fetch sales officers. Please try again.'
    })
  }
})

module.exports = router
