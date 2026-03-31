-- Migration: 002_pipeline_columns
-- Adds pipeline stage tracking columns to the applications table.
--
-- stage            : current pipeline stage for the application
-- stage_history    : append-only jsonb array of stage transition events
-- assigned_sales_officer : FK to admin_users; set before advancing past sales_officer
-- prior_decline_flag     : true when the submitting phone has a prior declined record
-- prior_decline_reference: reference_id of the prior declined application

alter table applications
  add column if not exists stage text default 'sales_officer';

alter table applications
  add column if not exists stage_history jsonb default '[]';

alter table applications
  add column if not exists assigned_sales_officer uuid references admin_users(id);

alter table applications
  add column if not exists prior_decline_flag boolean default false;

alter table applications
  add column if not exists prior_decline_reference text;

-- Index: fast filtering of applications by pipeline stage
create index if not exists idx_applications_stage on applications (stage);
