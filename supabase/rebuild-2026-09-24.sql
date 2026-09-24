-- ============================================================================
-- Aalayna: full rebuild of the shared store, 2026-09-24
-- The project was paused on the free tier and restored empty. This file recreates
-- everything in order: migration (tables, keys, policies), website events,
-- the 2026-09-15 hardening (aal_mutate, aal_snapshot, per-bill keys), with one
-- correction: functions that generate keys need the `extensions` schema on their
-- search path, where Supabase installs pgcrypto. Safe to re-run.
-- After it finishes, register venues again (their keys were lost with the data):
--   select * from aal_register_venue('Kababji', 'Lebanese Grill');
-- ============================================================================

-- ---------- 1. migration.sql ----------
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
-- The phone's device id (a weak identifier): a guest may read back only the rows
-- their own device wrote, which is what an upsert needs to check for conflicts.
create or replace function aal_device() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-aalayna-device', '')
$$;
create or replace function aal_role(rid text) returns text language sql stable security definer as $$
  select case
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.owner_key = aal_key() and aal_key() <> '') then 'owner'
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.guest_key = aal_key() and aal_key() <> '') then 'guest'
    else null end
$$;
revoke all on venue_keys from public, anon, authenticated;

alter table kv_docs enable row level security;
alter table kv_rows enable row level security;

drop policy if exists docs_read on kv_docs;
create policy docs_read on kv_docs for select
  using (aal_role(restaurant_id)='owner' or (aal_role(restaurant_id)='guest' and key in ('aal.live','aal.rate','aal.rate_meta')));
drop policy if exists docs_write on kv_docs;
create policy docs_write on kv_docs for all
  using (aal_role(restaurant_id) = 'owner') with check (aal_role(restaurant_id) = 'owner');

-- Fresh installations start closed; hardening-2026-09-15.sql installs the
-- supported bill RPCs and fine-grained owner write policies.
drop policy if exists rows_read on kv_rows;
create policy rows_read on kv_rows for select using (aal_role(restaurant_id)='owner');
drop policy if exists rows_insert on kv_rows;
create policy rows_insert on kv_rows for insert with check (false);
drop policy if exists rows_update on kv_rows;
create policy rows_update on kv_rows for update using (false) with check (false);
drop policy if exists rows_delete on kv_rows;
create policy rows_delete on kv_rows for delete using (false);

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
revoke all on function aal_register_venue(text, text) from public, anon, authenticated;

-- Example (edit the names, run, copy the two keys it prints):
-- select * from aal_register_venue('Kababji', 'Lebanese Grill');


-- ---------- 2. site-events.sql ----------
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


-- ---------- 3. hardening-2026-09-15.sql (search_path corrected) ----------
-- Apply after migration.sql. Atomic rollout; old guest keys cease granting bill access.
-- Existing keys must be rotated if the earlier registration function was exposed.
begin;
create table if not exists public.check_keys (
  key text primary key, restaurant_id text not null, check_id text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.payment_secrets (
  restaurant_id text not null, payment_id text not null, token_hash text not null,
  primary key (restaurant_id,payment_id)
);
revoke all on public.venue_keys, public.check_keys, public.payment_secrets from public, anon, authenticated;
alter table public.venue_keys enable row level security;
alter table public.check_keys enable row level security;
alter table public.payment_secrets enable row level security;
revoke all on function public.aal_register_venue(text,text) from public, anon, authenticated;
-- Pin search paths on privileged functions from the initial migration.
alter function public.aal_role(text) set search_path = public, extensions, pg_temp;
alter function public.aal_register_venue(text,text) set search_path = public, extensions, pg_temp;

create or replace function public.aal_check_scope(rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select c.check_id from public.check_keys c where c.restaurant_id=rid and c.key=public.aal_key()
$$;
revoke all on function public.aal_check_scope(text) from public;
grant execute on function public.aal_check_scope(text) to anon;

-- No guest may read raw payment/device/contact rows. Guest reads use a projection.
drop policy if exists rows_read on public.kv_rows;
create policy rows_read on public.kv_rows for select using (public.aal_role(restaurant_id)='owner' and coalesce(body->>'venueId',body->>'restaurantId')=restaurant_id);
drop policy if exists rows_insert on public.kv_rows;
drop policy if exists rows_update on public.kv_rows;
drop policy if exists rows_delete on public.kv_rows;
create policy rows_insert on public.kv_rows for insert with check (
 public.aal_role(restaurant_id)='owner' and collection in
 ('aal.campaigns','aal.edit_log','aal.admin_notifications','aal.health_reports','aal.identity_merges')
 and coalesce(body->>'venueId',body->>'restaurantId')=restaurant_id);
create policy rows_update on public.kv_rows for update using (
 public.aal_role(restaurant_id)='owner' and collection in
 ('aal.guests','aal.campaigns','aal.edit_log','aal.admin_notifications','aal.health_reports','aal.identity_merges'))
 with check (public.aal_role(restaurant_id)='owner' and collection in ('aal.guests','aal.campaigns','aal.edit_log','aal.admin_notifications','aal.health_reports','aal.identity_merges') and coalesce(body->>'venueId',body->>'restaurantId')=restaurant_id);
create policy rows_delete on public.kv_rows for delete using (false);
drop policy if exists docs_read on public.kv_docs;
create policy docs_read on public.kv_docs for select using (
 public.aal_role(restaurant_id)='owner' or
 ((public.aal_role(restaurant_id)='guest' or public.aal_check_scope(restaurant_id) is not null)
 and key in ('aal.live','aal.rate','aal.rate_meta')));
-- docs_write remains owner-only. Initial guest keys now permit menu reads only.

create or replace function public.aal_snapshot(p_rid text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare owner boolean := coalesce(public.aal_role(p_rid)='owner',false);
 cid text := public.aal_check_scope(p_rid); rs jsonb; ds jsonb;
begin
 if not owner and cid is null then raise exception 'Open a current bill link or sign in with this restaurant owner key.'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('collection',collection,'id',id,'body',
 case when owner or collection='aal.checks' then body else body - array['deviceId','sessionId','customerId','identityId','payerRef','externalRef'] end,'updated_at',updated_at)), '[]') into rs
 from public.kv_rows where restaurant_id=p_rid and coalesce(body->>'venueId',body->>'restaurantId')=restaurant_id and (owner or
 (collection='aal.checks' and id=cid) or (collection='aal.settle' and body->>'checkId'=cid));
 select coalesce(jsonb_agg(jsonb_build_object('key',key,'body',body,'updated_at',updated_at)),'[]') into ds
 from public.kv_docs where restaurant_id=p_rid and (owner or key in ('aal.live','aal.rate','aal.rate_meta'));
 return jsonb_build_object('version',2,'role',case when owner then 'owner' else 'guest' end,'checkId',cid,'rows',rs,'docs',ds);
end $$;
revoke all on function public.aal_snapshot(text) from public;
grant execute on function public.aal_snapshot(text) to anon;

-- Every protected operation locks the same venue/check (and receipt identity) transaction.
-- Client-generated UUIDs are idempotency keys, never proof of payment.
create or replace function public.aal_mutate(p_rid text,p_op text,p_body jsonb,p_token text default '') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
 owner boolean := coalesce(public.aal_role(p_rid)='owner',false);
 provider boolean := coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')='service_role';
 scope text := public.aal_check_scope(p_rid); cid text; pid text; rid text;
 c jsonb; p jsonb; previous jsonb; g jsonb; result jsonb;
 amount bigint; tip bigint; used bigint; qty numeric; claim record; line jsonb;
 contact text; channel text; gid text; stamp text := to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 event_type text; ev jsonb; event_id text; token_ok boolean;
begin
 if not owner and not provider and scope is null then raise exception 'Access denied'; end if;
 -- Serialise the venue's state, including contact deduplication and check creation.
 perform pg_advisory_xact_lock(hashtextextended(p_rid,0));
 if p_op='open_check' then
  if not owner then raise exception 'Only staff may open a bill'; end if;
  if coalesce((p_body->>'totalCents')::bigint,0)<=0 or coalesce((p_body->>'table')::int,0)<1 then raise exception 'Invalid bill'; end if;
  select body into result from public.kv_rows where restaurant_id=p_rid and collection='aal.checks'
    and body->>'table'=p_body->>'table' and body->>'closedAt' is null limit 1;
  if result is null then
   result=p_body || jsonb_build_object('venueId',p_rid,'source','staff','openedAt',stamp);
   insert into public.kv_rows values(p_rid,'aal.checks',result->>'id',result,now());
  end if;
  return result;
 end if;
 if p_op='issue_key' then
  if not owner then raise exception 'Only staff may issue a bill link'; end if;
  cid=p_body->>'checkId';
  if not exists(select 1 from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid and body->>'closedAt' is null) then raise exception 'Bill unavailable'; end if;
  rid='chk_'||encode(gen_random_bytes(24),'hex');
  insert into public.check_keys(key,restaurant_id,check_id) values(rid,p_rid,cid);
  return jsonb_build_object('key',rid,'checkId',cid);
 end if;
 if p_op='event' then
  event_type=p_body->>'eventType';
  if event_type not in ('qr_scan','item_view','bill_requested','ui_action','review_submitted') then raise exception 'This event requires a server operation'; end if;
  ev=p_body || jsonb_build_object('restaurantId',p_rid,'createdAt',stamp,'customerId',null);
  if not owner then ev=ev||jsonb_build_object('tableId',(select body->>'table' from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=scope)); end if;
  insert into public.kv_rows values(p_rid,'aal.events',ev->>'eventId',ev,now()) on conflict do nothing;
  return ev;
 end if;
 pid=p_body->>'id';
 if p_op='reserve' then
  cid=p_body->>'checkId';
  if not owner and cid is distinct from scope then raise exception 'Wrong bill'; end if;
  if length(p_token)<32 then raise exception 'Missing payer token'; end if;
  select body into previous from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and id=pid;
  if previous is not null then
   if not exists(select 1 from public.payment_secrets where restaurant_id=p_rid and payment_id=pid and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')) then raise exception 'Wrong payer token'; end if;
   if previous->>'checkId' is distinct from cid or previous->'amount' is distinct from p_body->'amount' or previous->'tip' is distinct from p_body->'tip' or previous->'rail' is distinct from p_body->'rail' or previous->'items' is distinct from p_body->'items' then raise exception 'Payment request changed'; end if;
   return previous;
  end if;
  amount=round((p_body->>'amount')::numeric*100); tip=round(coalesce((p_body->>'tip')::numeric,0)*100);
  if coalesce(amount,0)<=0 or tip<0 or tip>=amount or coalesce(p_body->>'rail','') not in ('cash','card','whish') then raise exception 'Invalid amount'; end if;
  select body into c from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  if c is null or c->>'closedAt' is not null then raise exception 'Bill closed or unavailable'; end if;
  select coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)),0) into used
  from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid
   and body->>'refunded' is null and body->>'cancelled' is null
   and (body->>'status' in ('pending','confirmed') or (body->>'status'='initiated' and (body->>'expiresAt')::timestamptz>now()));
  if used+amount-tip>(c->>'totalCents')::bigint then raise exception 'Another payment already covers this balance. Refresh your bill.'; end if;
  used=0;
  for claim in select key,value from jsonb_each_text(coalesce(p_body->'items','{}')) loop
   qty=claim.value::numeric;
   select value into line from jsonb_array_elements(c->'lines') where value->>'id'=claim.key;
   if line is null or qty<=0 or qty<>trunc(qty) then raise exception 'Invalid item selection'; end if;
   if qty+coalesce((select sum(coalesce((body->'items'->>claim.key)::numeric,0)) from public.kv_rows
     where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid and body->>'refunded' is null and body->>'cancelled' is null
      and (body->>'status' in ('pending','confirmed') or (body->>'status'='initiated' and (body->>'expiresAt')::timestamptz>now()))),0)>(line->>'q')::numeric then raise exception 'Item already reserved'; end if;
   used=used+round((line->>'p')::numeric*100/(line->>'q')::numeric*qty);
  end loop;
  if coalesce(p_body->'items','{}')<>'{}'::jsonb and used<>amount-tip then raise exception 'Items do not match the amount'; end if;
  if p_body->>'rail'='cash' and coalesce((p_body->>'note')::numeric,0)>0 and (p_body->>'note')::numeric*100<amount then raise exception 'Not enough cash'; end if;
  p=jsonb_build_object('id',pid,'requestId',p_body->>'requestId','venueId',p_rid,'checkId',cid,'table',c->'table',
    'rail',p_body->>'rail','amount',amount/100.0,'tip',tip/100.0,'items',coalesce(p_body->'items','{}'),
    'deviceId',p_body->>'deviceId','sessionId',p_body->>'sessionId','server',p_body->>'server','currency','USD','amountUsd',amount/100.0,
    'fxRateUsed',c->'fxRateUsed','note',coalesce((p_body->>'note')::numeric,0),'change',case when p_body->>'rail'='cash' then greatest(0,coalesce((p_body->>'note')::numeric,0)-amount/100.0) else 0 end,
    'status',case when p_body->>'rail'='cash' then 'pending' else 'initiated' end,'ts',stamp,
    'expiresAt',case when p_body->>'rail'<>'cash' then to_jsonb(now()+interval '10 minutes') else 'null'::jsonb end);
  insert into public.kv_rows values(p_rid,'aal.settle',pid,p,now());
  insert into public.payment_secrets values(p_rid,pid,encode(sha256(convert_to(p_token,'UTF8')),'hex'));
  return p;
 end if;
 if p_op='close_check' then
  if not owner then raise exception 'Only staff may close a bill'; end if;
  cid=p_body->>'checkId';
  select body into c from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  select coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)),0) into used from public.kv_rows
    where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid and body->>'status'='confirmed' and body->>'refunded' is null;
  if c is null or used<>(c->>'totalCents')::bigint then raise exception 'Bill is not fully settled'; end if;
  c=c||jsonb_build_object('closedAt',stamp); update public.kv_rows set body=c where restaurant_id=p_rid and collection='aal.checks' and id=cid; return c;
 end if;
 select body into p from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and id=pid;
 if p is null or (not owner and not provider and p->>'checkId' is distinct from scope) then raise exception 'Payment unavailable'; end if;
 token_ok=exists(select 1 from public.payment_secrets where restaurant_id=p_rid and payment_id=pid and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex'));
 if p_op='receipt' then
  if not owner and not token_ok then raise exception 'Wrong payer token'; end if;
  if p->>'status'<>'confirmed' or p->>'refunded' is not null then raise exception 'Payment must be confirmed'; end if;
  if jsonb_typeof(p_body->'receipt') is distinct from 'boolean' or jsonb_typeof(p_body->'marketing') is distinct from 'boolean' then raise exception 'Separate permissions required'; end if;
  contact=trim(p_body->>'contact'); channel=p_body->>'channel';
  if channel='email' then contact=lower(contact); if contact !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  elsif channel='whatsapp' then if contact !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'International number required'; end if;
  else raise exception 'Invalid channel'; end if;
  select body into g from public.kv_rows where restaurant_id=p_rid and collection='aal.guests' and body->>'contact'=contact limit 1;
  if g is null then g=jsonb_build_object('id',gen_random_uuid()::text,'venueId',p_rid,'contact',contact,'channel',channel,'createdAt',stamp,'consentHistory','[]'::jsonb); end if;
  gid=g->>'id';
  if p->>'customerId' is not null and p->>'customerId'<>gid then raise exception 'Payment already linked'; end if;
  -- Repeated transport delivery is idempotent; later explicit choices remain audited.
  if not exists(select 1 from jsonb_array_elements(g->'consentHistory') h where h->>'requestId'=p_body->>'requestId') then
   g=g||jsonb_build_object('receipt',p_body->'receipt','marketing',p_body->'marketing','consentHistory',(g->'consentHistory')||jsonb_build_array(jsonb_build_object('at',stamp,'source','receipt','version','restaurant-offers-v1','settlementId',pid,'requestId',p_body->>'requestId','receipt',p_body->'receipt','marketing',p_body->'marketing')));
   insert into public.kv_rows values(p_rid,'aal.guests',gid,g,now()) on conflict(restaurant_id,collection,id) do update set body=excluded.body;
   p=p||jsonb_build_object('customerId',gid);update public.kv_rows set body=p where restaurant_id=p_rid and collection='aal.settle' and id=pid;
  end if;
  return jsonb_build_object('saved',true); -- Never return an existing contact's history to a guest.
 elsif p_op='confirm_cash' then
  if not owner or p->>'rail'<>'cash' then raise exception 'Cash confirmation requires staff'; end if;
  if p->>'status'='confirmed' then return p; end if;
  if p->>'status'<>'pending' or p->>'cancelled' is not null then raise exception 'Cash request changed'; end if;
  p=p||jsonb_build_object('status','confirmed','confirmedAt',stamp); event_type='payment_completed';
 elsif p_op='confirm_digital' then
  if not provider then raise exception 'Verified provider callback required'; end if;
  if p->>'externalRef'=p_body->>'externalRef' and p->>'status'='confirmed' then return p; end if;
  if p->>'status'<>'initiated' or (p->>'expiresAt')::timestamptz<=now() then raise exception 'Reservation expired or changed; reconcile received funds'; end if;
  if coalesce(p_body->>'externalRef','')='' or p_body->>'currency' is distinct from p->>'currency' or (p_body->>'amountCents')::bigint is distinct from round((p->>'amount')::numeric*100)::bigint then raise exception 'Callback amount, currency or reference mismatch'; end if;
  if exists(select 1 from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and body->>'externalRef'=p_body->>'externalRef') then raise exception 'Duplicate provider reference'; end if;
  p=p||jsonb_build_object('status','confirmed','confirmedAt',stamp,'externalRef',p_body->>'externalRef'); event_type='payment_completed';
 elsif p_op='cancel' then
  if not owner and not token_ok then raise exception 'Wrong payer token'; end if;
  if p->>'status' in ('cancelled','expired','failed') then return p; end if;
  if p->>'status' not in ('pending','initiated') then raise exception 'Payment already completed'; end if;
  p=p||jsonb_build_object('status','cancelled','cancelled',stamp); event_type='payment_cancelled';
 elsif p_op='refund' then
  if not owner or p->>'rail'<>'cash' then raise exception 'Digital refunds require the payment provider integration'; end if;
  if p->>'refunded' is not null then return p; end if;
  if p->>'status'<>'confirmed' then raise exception 'Only confirmed cash can be refunded'; end if;
  p=p||jsonb_build_object('refunded',stamp); event_type='payment_refunded';
 else raise exception 'Unknown operation'; end if;
 update public.kv_rows set body=p where restaurant_id=p_rid and collection='aal.settle' and id=pid;
 event_id=gen_random_uuid()::text;
 ev=jsonb_build_object('eventId',event_id,'eventType',event_type,'restaurantId',p_rid,'tableId',p->'table','deviceId',p->'deviceId','sessionId',p->'sessionId','createdAt',stamp,'customerId',p->'customerId','payload',jsonb_build_object('paymentId',pid,'orderId',p->>'checkId','amount',p->'amount','tip',p->'tip','rail',p->'rail','currency',p->'currency','amountUsd',p->'amountUsd'));
 insert into public.kv_rows values(p_rid,'aal.events',event_id,ev,now());
 return p;
end $$;
revoke all on function public.aal_mutate(text,text,jsonb,text) from public;
grant execute on function public.aal_mutate(text,text,jsonb,text) to anon, service_role;
create or replace function public.aal_has_owner_key() returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select exists(select 1 from public.venue_keys v where v.owner_key=public.aal_key() and public.aal_key()<>'')
$$;
revoke all on function public.aal_has_owner_key() from public;
grant execute on function public.aal_has_owner_key() to anon;
do $$ begin
 if to_regclass('public.site_events') is not null then
  execute 'drop policy if exists site_events_read on public.site_events';
  execute 'create policy site_events_read on public.site_events for select using (public.aal_has_owner_key())';
 end if;
end $$;
commit;


-- ---------- 4. the same correction for functions the migration created ----------
alter function public.aal_register_venue(text, text) set search_path = public, extensions, pg_temp;
alter function public.aal_role(text) set search_path = public, extensions, pg_temp;

-- ---------- 5. make the API see the new tables at once ----------
notify pgrst, 'reload schema';
