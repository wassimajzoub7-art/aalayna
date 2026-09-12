-- Website funnel events (analytics.js). Run once in the Supabase SQL editor.
-- Anyone with the public key may append; only a venue owner key may read.
-- Rows carry no contact data, no bill amounts, no query strings, no visitor id.
create table if not exists site_events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (name in ('demo_start','demo_open','demo_complete','demo_cash_requested',
                                            'whatsapp_click','booking_click','booking_page_view','booking_calendar_click','numbers_click')),
  placement   text not null default 'unspecified' check (placement ~ '^[a-z_]{1,40}$'),
  path        text not null default '' check (length(path) <= 120),
  at          timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists site_events_at on site_events (received_at);
alter table site_events enable row level security;
drop policy if exists site_events_insert on site_events;
create policy site_events_insert on site_events for insert with check (true);
drop policy if exists site_events_read on site_events;
create policy site_events_read on site_events for select
  using (aal_key() <> '' and exists (select 1 from venue_keys v where v.owner_key = aal_key()));
grant insert, select on site_events to anon;
