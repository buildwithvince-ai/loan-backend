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

module.exports = { verifyToken, requireRole };
