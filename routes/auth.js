'use strict';

const express = require('express');
const { supabase } = require('../services/supabase');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /login
 *
 * Authenticates an admin user via Supabase Auth and returns a JWT + user profile.
 * The caller must pass the returned token as `Authorization: Bearer <token>` on
 * all subsequent requests.
 *
 * Body: { email: string, password: string }
 *
 * Responses:
 *   200 { token, user: { id, email, role, full_name } }
 *   401 { error: 'Invalid credentials' }
 *   403 { error: 'Account not authorized' }
 *   500 { error: 'Internal server error' }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData || !authData.session) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const authUserId = authData.user.id;

    const { data: adminUser, error: dbError } = await supabase
      .from('admin_users')
      .select('id, email, role, full_name, is_active')
      .eq('id', authUserId)
      .single();

    if (dbError || !adminUser) {
      // Auth account exists but not registered in admin_users — not authorized
      return res.status(403).json({ error: 'Account not authorized' });
    }

    if (!adminUser.is_active) {
      return res.status(403).json({ error: 'Account not authorized' });
    }

    return res.status(200).json({
      token: authData.session.access_token,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        full_name: adminUser.full_name,
      },
    });
  } catch (err) {
    console.error('[auth] POST /login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /logout
 *
 * Invalidates the user's session server-side using the Supabase Admin API.
 * Requires a valid Bearer token.
 *
 * Responses:
 *   200 { message: 'Logged out successfully' }
 *   401 — from verifyToken if token is missing/invalid
 *   500 { error: 'Internal server error' }
 */
router.post('/logout', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase.auth.admin.signOut(req.user.id);

    if (error) {
      console.error('[auth] POST /logout signOut error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('[auth] POST /logout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /me
 *
 * Returns the authenticated user's profile from req.user (set by verifyToken).
 *
 * Responses:
 *   200 { id, email, role, full_name }
 *   401 — from verifyToken if token is missing/invalid
 */
router.get('/me', verifyToken, (req, res) => {
  return res.status(200).json(req.user);
});

module.exports = router;
