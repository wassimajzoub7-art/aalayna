-- Aalayna shared store on Supabase (pilot backend, phase 1).
-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- Shape: the prototype's localStorage keys become rows here, one venue per
-- restaurant_id. Collections (payments, checks, events, guests, ...) are one row
-- per record in kv_rows; single documents (menu draft/live, rate, floor, tips)
-- are one row per key in kv_docs. The normalised schema in schema/ is the phase-2
-- target; this table pair is what lets several phones share one venue today.
--
-- Access: no user accounts. Each venue has two keys. The GUEST key rides in the
-- QR link and may only add payments, checks, events and receipt sign-ups and read
-- the menu and bill state. The OWNER key is typed once into the dashboard and
-- editor and may do everything for that venue. Keys travel in the request header
-- x-aalayna-key and are checked by row-level security below.

create extension if not exists pgcrypto;

create table if not exists venue_keys (
  restaurant_id text primary key,
  owner_key     text not null unique,
  guest_key     text not null unique,
  name          text,
  created_at    timestamptz not null default now()
);

create table if not exists kv_docs (
  restaurant_id text not null,
  key           text not null,
  body          jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (restaurant_id, key)
);

create table if not exists kv_rows (
  restaurant_id text not null,
  collection    text not null,
  id            text not null,
  body          jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (restaurant_id, collection, id)
);
create index if not exists kv_rows_updated on kv_rows (restaurant_id, collection, updated_at);

create or replace function aal_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists kv_docs_touch on kv_docs;
create trigger kv_docs_touch before update on kv_docs for each row execute function aal_touch();
drop trigger if exists kv_rows_touch on kv_rows;
create trigger kv_rows_touch before update on kv_rows for each row execute function aal_touch();

-- The key from the request header, and the role it grants for a venue.
create or replace function aal_key() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-aalayna-key', '')
$$;
create or replace function aal_role(rid text) returns text language sql stable security definer as $$
  select case
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.owner_key = aal_key() and aal_key() <> '') then 'owner'
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.guest_key = aal_key() and aal_key() <> '') then 'guest'
    else null end
$$;
revoke all on venue_keys from anon, authenticated;

alter table kv_docs enable row level security;
alter table kv_rows enable row level security;

drop policy if exists docs_read on kv_docs;
create policy docs_read on kv_docs for select
  using (aal_role(restaurant_id) in ('owner','guest'));
drop policy if exists docs_write on kv_docs;
create policy docs_write on kv_docs for all
  using (aal_role(restaurant_id) = 'owner') with check (aal_role(restaurant_id) = 'owner');

-- Guests: read bill state, never the guest list or the event stream.
drop policy if exists rows_read on kv_rows;
create policy rows_read on kv_rows for select
  using (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle')));
drop policy if exists rows_insert on kv_rows;
create policy rows_insert on kv_rows for insert
  with check (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle','aal.events','aal.guests')));
drop policy if exists rows_update on kv_rows;
create policy rows_update on kv_rows for update
  using (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle','aal.guests')))
  with check (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle','aal.guests')));
drop policy if exists rows_delete on kv_rows;
create policy rows_delete on kv_rows for delete
  using (aal_role(restaurant_id) = 'owner');

grant select, insert, update, delete on kv_docs, kv_rows to anon;

-- Register a venue: restaurant_id is the store's venueId(), which is the JSON
-- string of [lower-cased name, lower-cased place]. Keep the keys; the owner key
-- is typed into the dashboard once, the guest key goes into the QR links.
create or replace function aal_register_venue(p_name text, p_place text)
returns table (restaurant_id text, owner_key text, guest_key text) language plpgsql security definer as $$
#variable_conflict use_column
declare rid text := '["' || lower(trim(p_name)) || '","' || lower(trim(coalesce(p_place,''))) || '"]';
begin
  insert into venue_keys as v (restaurant_id, owner_key, guest_key, name)
  values (rid, 'own_' || encode(gen_random_bytes(18), 'hex'), 'gst_' || encode(gen_random_bytes(9), 'hex'), p_name)
  on conflict (restaurant_id) do nothing;
  return query select v.restaurant_id, v.owner_key, v.guest_key from venue_keys v where v.restaurant_id = rid;
end $$;
revoke all on function aal_register_venue(text, text) from anon, authenticated;

-- Example (edit the names, run, copy the two keys it prints):
-- select * from aal_register_venue('Kababji', 'Lebanese Grill');
