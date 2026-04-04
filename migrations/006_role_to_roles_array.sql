-- Migration: 006_role_to_roles_array
-- Converts single `role` text column to `roles` text[] array column
-- to support assigning multiple roles per user.
-- Also adds 'approver' as a new valid role.

-- Step 1: Add the new roles array column
alter table admin_users add column if not exists roles text[] default '{}';

-- Step 2: Migrate existing role values into the array
update admin_users set roles = array[role] where role is not null and (roles is null or roles = '{}');

-- Step 3: Drop the old role column
alter table admin_users drop column if exists role;

-- Step 4: Index for contains queries
create index if not exists idx_admin_users_roles on admin_users using gin (roles);
