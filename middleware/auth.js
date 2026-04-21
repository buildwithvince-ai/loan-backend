'use strict';

const { supabase } = require('../services/supabase');

/**
 * verifyToken
 *
 * Validates the Bearer JWT from the Authorization header using Supabase Auth,
 * then hydrates req.user with the matching admin_users row.
 *
 * Fails with 401 if:
 *   - Authorization header is absent or malformed
 *   - Token is invalid / expired (Supabase rejects it)
 *   - No matching admin_users row exists for the auth user id
 *   - The admin_users row has is_active = false
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
      return res.status(401).json({ error: 'Invalid or missing authentication token' });
    }

    const token = parts[1];

    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData || !authData.user) {
      return res.status(401).json({ error: 'Invalid or missing authentication token' });
    }

    const authUserId = authData.user.id;

    const { data: adminUser, error: dbError } = await supabase
      .from('admin_users')
      .select('id, email, roles, full_name, is_active')
      .eq('id', authUserId)
      .single();

    if (dbError || !adminUser) {
      return res.status(401).json({ error: 'User account not found or inactive' });
    }

    if (!adminUser.is_active) {
      return res.status(401).json({ error: 'User account not found or inactive' });
    }

    req.user = {
      id: adminUser.id,
      email: adminUser.email,
      roles: adminUser.roles || [],
      full_name: adminUser.full_name,
    };

    return next();
  } catch (err) {
    console.error('[auth] verifyToken unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * requireRole(...roles)
 *
 * Factory that returns middleware enforcing role-based access control.
 * Must be used AFTER verifyToken (depends on req.user being set).
 *
 * Usage:
 *   router.get('/sensitive', verifyToken, requireRole('super_admin', 'admin'), handler)
 */
/**
 * verifyAdminSecret
 *
 * Validates the `x-admin-secret` header against process.env.ADMIN_SECRET.
 * On success, sets req.user to a synthetic admin principal so downstream
 * code (incl. requireRole) works unchanged.
 */
const verifyAdminSecret = (req, res, next) => {
  const provided = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    console.error('[auth] ADMIN_SECRET env var not set');
    return res.status(500).json({ error: 'Server auth not configured' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid or missing admin secret' });
  }
  req.user = {
    id: 'admin-secret',
    email: null,
    roles: ['admin', 'super_admin'],
    full_name: 'Admin Secret Auth',
  };
  return next();
};

/**
 * verifyAdminSecretOrToken
 *
 * Hybrid: accept `x-admin-secret` (matched against ADMIN_SECRET) OR
 * fall through to Bearer JWT via verifyToken. Lets the admin dashboard
 * call with either credential.
 */
const verifyAdminSecretOrToken = async (req, res, next) => {
  const provided = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET;
  if (expected && provided && provided === expected) {
    req.user = {
      id: 'admin-secret',
      email: null,
      roles: ['admin', 'super_admin'],
      full_name: 'Admin Secret Auth',
    };
    return next();
  }
  return verifyToken(req, res, next);
};

const requireRole = (...requiredRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const userRoles = req.user.roles || [];
    const hasRole = requiredRoles.some((r) => userRoles.includes(r));
    if (!hasRole) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    return next();
  };
};

module.exports = { verifyToken, verifyAdminSecret, verifyAdminSecretOrToken, requireRole };
