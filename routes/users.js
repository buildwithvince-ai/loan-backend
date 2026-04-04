'use strict';

const express = require('express');
const { supabase } = require('../services/supabase');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// All user management endpoints are restricted to super_admin only.
router.use(verifyToken, requireRole('super_admin'));

/**
 * GET /
 *
 * Returns all admin_users rows ordered by created_at descending.
 *
 * Responses:
 *   200 { users: [...] }
 *   500 { error: 'Internal server error' }
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, email, roles, full_name, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[users] GET / db error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(200).json({ users: data });
  } catch (err) {
    console.error('[users] GET / error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /
 *
 * Creates a new admin user.
 * Step 1: Creates a Supabase Auth account (email confirmed immediately).
 * Step 2: Inserts into admin_users using the auth user's UUID as the primary key,
 *         ensuring admin_users.id == auth.users.id at all times.
 *
 * Body: { email: string, password: string, role: string, full_name?: string }
 *
 * Responses:
 *   201 { user: { id, email, role, full_name, is_active, created_at } }
 *   400 { error: '...' }         — missing/invalid fields
 *   409 { error: 'A user with that email already exists' }
 *   500 { error: 'Internal server error' }
 */
router.post('/', async (req, res) => {
  try {
    const { email, password, roles, full_name } = req.body;

    if (!email || !password || !roles) {
      return res.status(400).json({ error: 'email, password, and roles are required' });
    }

    const validRoles = [
      'super_admin',
      'admin',
      'approver',
      'sales_officer',
      'verifier',
      'ci_officer',
      'loan_processing_officer',
    ];

    const rolesArray = Array.isArray(roles) ? roles : [roles];

    const invalid = rolesArray.filter((r) => !validRoles.includes(r));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid roles: ${invalid.join(', ')}. Must be one of: ${validRoles.join(', ')}`,
      });
    }

    // Step 1 — Create the Supabase Auth account
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      // Supabase surfaces duplicate email as a specific message
      if (authError.message && authError.message.toLowerCase().includes('already been registered')) {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }
      console.error('[users] POST / createUser error:', authError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const authUserId = authData.user.id;

    // Step 2 — Insert into admin_users, linking id to the auth user
    const { data: adminUser, error: dbError } = await supabase
      .from('admin_users')
      .insert({
        id: authUserId,
        email,
        roles: rolesArray,
        full_name: full_name || null,
        is_active: true,
      })
      .select('id, email, roles, full_name, is_active, created_at')
      .single();

    if (dbError) {
      // Auth user was created but DB insert failed — attempt cleanup to avoid orphaned auth accounts
      console.error('[users] POST / db insert error (attempting auth cleanup):', dbError);
      await supabase.auth.admin.deleteUser(authUserId).catch((cleanupErr) => {
        console.error('[users] POST / auth cleanup failed:', cleanupErr);
      });
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(201).json({ user: adminUser });
  } catch (err) {
    console.error('[users] POST / error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /:id
 *
 * Partial update of an admin_users row.
 * Only `role` and `is_active` may be updated.
 *
 * Body: { role?: string, is_active?: boolean }
 *
 * Responses:
 *   200 { user: { id, email, role, full_name, is_active, created_at } }
 *   400 { error: '...' }
 *   404 { error: 'User not found' }
 *   500 { error: 'Internal server error' }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { roles, is_active, full_name } = req.body;

    const updates = {};

    if (full_name !== undefined) {
      updates.full_name = full_name || null;
    }

    if (roles !== undefined) {
      const validRoles = [
        'super_admin',
        'admin',
        'approver',
        'sales_officer',
        'verifier',
        'ci_officer',
        'loan_processing_officer',
      ];
      const rolesArray = Array.isArray(roles) ? roles : [roles];
      const invalid = rolesArray.filter((r) => !validRoles.includes(r));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `Invalid roles: ${invalid.join(', ')}. Must be one of: ${validRoles.join(', ')}`,
        });
      }
      updates.roles = rolesArray;
    }

    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') {
        return res.status(400).json({ error: 'is_active must be a boolean' });
      }
      updates.is_active = is_active;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    const { data: updatedUser, error: dbError } = await supabase
      .from('admin_users')
      .update(updates)
      .eq('id', id)
      .select('id, email, roles, full_name, is_active, created_at')
      .single();

    if (dbError) {
      // PGRST116 = row not found
      if (dbError.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      console.error('[users] PATCH /:id db error:', dbError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({ user: updatedUser });
  } catch (err) {
    console.error('[users] PATCH /:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /:id
 *
 * Soft-deletes an admin user by setting is_active = false.
 * The record and the Supabase Auth account are intentionally preserved.
 *
 * Responses:
 *   200 { message: 'User deactivated' }
 *   404 { error: 'User not found' }
 *   500 { error: 'Internal server error' }
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: deactivated, error: dbError } = await supabase
      .from('admin_users')
      .update({ is_active: false })
      .eq('id', id)
      .select('id')
      .single();

    if (dbError) {
      if (dbError.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      console.error('[users] DELETE /:id db error:', dbError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!deactivated) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({ message: 'User deactivated' });
  } catch (err) {
    console.error('[users] DELETE /:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
