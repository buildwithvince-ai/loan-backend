-- Migration: 001_admin_users
-- Creates the admin_users table for role-based access control.
--
-- NOTE: admin_users.id is intentionally set to match auth.users.id when a user
-- is created via Supabase Auth (supabase.auth.admin.createUser). There is no
-- foreign key constraint because auth.users is managed internally by Supabase
-- Auth and direct FK references across schemas are not supported in this setup.
-- The linkage is enforced in application code: always insert into admin_users
-- using the UUID returned by supabase.auth.admin.createUser as the primary key.

create table if not exists admin_users (
  id          uuid        primary key default gen_random_uuid(),
  email       text        unique not null,
  role        text        not null check (role in (
                'super_admin',
                'admin',
                'sales_officer',
                'verifier',
                'ci_officer',
                'loan_processing_officer'
              )),
  full_name   text,
  is_active   boolean     default true,
  created_at  timestamptz default now()
);

-- Index: fast lookup by email during login
create index if not exists idx_admin_users_email on admin_users (email);

-- Index: fast filter for active users
create index if not exists idx_admin_users_is_active on admin_users (is_active);
