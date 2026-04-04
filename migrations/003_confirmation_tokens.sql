-- Migration: 003_confirmation_tokens
-- Creates the confirmation_tokens table used for SO email confirmation flows.
--
-- Each application that reaches the confirmation stage gets two tokens:
--   action = 'confirm' — SO confirms the client wants to proceed
--   action = 'decline' — SO indicates the client has declined
--
-- Tokens are single-use (used = true after click) and expire after 48 hours.

create table if not exists confirmation_tokens (
  id             uuid        primary key default gen_random_uuid(),
  token          text        unique not null,
  application_id uuid        references applications(id),
  action         text        not null check (action in ('confirm', 'decline')),
  used           boolean     default false,
  expires_at     timestamptz not null,
  created_at     timestamptz default now()
);

create index if not exists idx_confirmation_tokens_token on confirmation_tokens (token);
