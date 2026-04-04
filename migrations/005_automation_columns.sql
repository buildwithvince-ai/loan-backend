alter table applications add column if not exists so_confirmation_sent_at timestamptz;
alter table applications add column if not exists returned_count int default 0;
