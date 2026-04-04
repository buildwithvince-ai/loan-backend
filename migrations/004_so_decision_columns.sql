-- Migration: 004_so_decision_columns
-- Adds Sales Officer confirmation decision tracking to the applications table.
--
-- so_decision     : value is 'confirm' or 'decline', set when the SO clicks the email link
-- so_decision_at  : timestamp of when the SO responded

alter table applications add column if not exists so_decision    text;
alter table applications add column if not exists so_decision_at timestamptz;
