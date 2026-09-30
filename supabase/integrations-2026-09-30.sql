-- The POS bridge (T13), 2026-09-30.
--
-- Run after theme-2026-09-28.sql, in the Supabase SQL editor. Needs auth-2026-09-24.sql
-- (aal_mutate with staff roles) and followups-2026-09-24.sql; it stops without changing
-- anything if they have not been applied.
-- UNTESTED against the live project. tests/pos-bridge.test.cjs runs it in PGlite
-- (PostgreSQL 16, no pgcrypto, pg_net, pg_cron or vault) when PGLITE_MODULE is set.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or replace
-- function", "drop trigger if exists" + "create trigger", grant/revoke, an insert "on
-- conflict do nothing" for the default settings row, and a pg_cron schedule by job name
-- (scheduling the same name again replaces the job). No existing row, table, policy or
-- function of the earlier files is changed. aal_mutate is NOT replaced and is called as is.
--
-- Extensions
--   pgcrypto        REQUIRED (already installed on Supabase, schema extensions):
--                   gen_random_bytes for keys, webhook secrets and check ids.
--   pg_net          OPTIONAL. Created here if the project allows it. Without it nothing is
--                   pushed to the delivery function from the database; see below.
--   pg_cron         OPTIONAL. Created here if the project allows it; the job
--                   'aalayna-pos-webhooks' runs aal_pos_kick() every minute. Without it the
--                   migration still succeeds and the delivery function must be called some
--                   other way (supabase/README.md, "POS bridge").
--   supabase_vault  OPTIONAL, installed on Supabase. The shared cron secret is read from
--                   vault secret 'aalayna_cron_secret' (the one daily-close and
--                   receipt-email use; the functions' AALAYNA_CRON_SECRET), and the
--                   functions' base URL from vault secret 'aalayna_functions_url' when it
--                   exists (payments-2026-09-30.sql). Without vault: integration_settings
--                   keys 'cron_secret' and 'deliver_url'.
--
-- What it adds
--   integration_keys       one row per POS key: the sha256 of the key (never the key),
--                          a hint (first 8 hex digits after pos_), scopes {bills}, label,
--                          created_at, last_used_at, revoked_at.
--   integration_key_usage  calls per key per clock minute, for the 600 a minute limit.
--                          Rows older than an hour are deleted by the next minute's first
--                          call. A shared table, because Edge Function isolates do not
--                          share memory.
--   webhook_endpoints      a venue's HTTPS endpoints: url, secret (plain: it signs every
--                          delivery), events {bill.paid,bill.closed}, active.
--   webhook_deliveries     one row per (endpoint, event_id); event_id is the check id and
--                          the event type, so an event is never queued twice. attempts,
--                          next_attempt_at (null: nothing more to do), delivered_at,
--                          last_status, last_error.
--   integration_settings   deliver_url (the pos-webhook-deliver function, used when vault
--                          has no aalayna_functions_url) and, only on a database without
--                          vault, cron_secret.
--   All five: RLS on with no policies, and no privilege for anon or authenticated.
--   Two indexes on kv_rows: bills by posRef (system, externalId) and payments by checkId.
--
--   aal_pos_resolve(hash)        service_role only. The Edge Function passes the sha256 of
--                                the key it received (the plain key never reaches the
--                                database). A live key gives {restaurant_id, key_id,
--                                calls, limit, resetAt} and counts the call; else null.
--   aal_pos_bill(hash, bill)     service_role only. The whole bill request, atomic, under
--                                the venue lock aal_mutate uses (see "How the bridge opens
--                                a bill"). Refusals are raised with hint 'pos:<http>:<code>'
--                                and a JSON detail; the Edge Function turns them into its
--                                answer. In order: supersede the table's unpaid open bill
--                                (a new externalId only), open or update the lines, record
--                                the till's tenders, close.
--                                * Superseded: a new externalId for a table whose open bill
--                                  has no aal.settle row at all gets that bill closed
--                                  (closedAt, posRef.superseded = the new externalId, event
--                                  bill_superseded); with any settlement row it is 409
--                                  table_busy with the open bill's id.
--                                * After a payment (confirmed or pending) the lines Aalayna
--                                  has never change (aal_pos_append_lines): new units and
--                                  a grown service charge become added lines; a discount
--                                  change, a smaller service charge, a removed, reduced or
--                                  repriced line are refused (409 rule).
--                                * Tenders (aal_pos_record_tenders): each new POS tender
--                                  becomes an aal.settle row {id 'tnd_...', venueId,
--                                  checkId, table, rail 'pos', source 'pos', method,
--                                  posRef {externalId, method}, amount, tip (units, bill
--                                  currency, tip included in amount), items {}, currency,
--                                  amountUsd (= amount, as reserve writes it), fxRateUsed,
--                                  status 'confirmed', ts, confirmedAt (takenAt kept between
--                                  the opening and now), recordedAt} plus a
--                                  payment_completed event. Idempotent by the tender's
--                                  externalId on the bill (409 tender_changed if it
--                                  differs); 409 overpaid if paid + pending + the tender's
--                                  principal would pass the total.
--   aal_pos_claim_deliveries(n)  service_role only. Up to 50 due deliveries, leased for
--   aal_pos_delivery_result(...) five minutes; the result marks one delivered, or failed
--                                with its next attempt (null gives up).
--   aal_pos_kick()               postgres only (cron, the trigger). Calls the delivery
--                                function through pg_net when a delivery is due.
--   aal_integration(rid, body)   the owner's keys: list, issue (the plain key is returned
--                                once), revoke.
--   aal_webhooks(rid, body)      the owner's endpoints: list, add (the secret is returned
--                                once), remove, test (queues a ping), deliveries (last 50).
--                                Both: the venue's owner key (x-aalayna-key) or a signed-in
--                                owner, as aal_staff; a manager may not.
--   Trigger kv_rows_pos_webhooks queues bill.closed when a bill gains closedAt and
--   bill.paid when its confirmed payments first cover its total (on a payment's
--   confirmation or on a bill change). Both carry origin ('pos' when the bill has a POS
--   externalId, else 'aalayna'); bill.closed carries closedBy ('pos' inside aal_pos_bill,
--   which sets the transaction-local setting aalayna.actor, else 'aalayna') and
--   supersededBy. It does nothing for a venue without an active
--   endpoint, and a failure in it is a warning, never a failed payment or bill write.
--
-- How the bridge opens a bill
--   aal_mutate treats a service_role JWT as a payment provider, not as staff: it may
--   confirm_digital and nothing else, so it cannot open, change or close a bill. Rather
--   than a fourth copy of aal_mutate, aal_pos_bill verifies the integration key, takes the
--   venue lock, and for the length of its own transaction sets request.headers to carry
--   the venue's owner key (set_config(..., true)), the header aal_role() already reads. It
--   then calls aal_mutate open_check, update_check and close_check exactly as the owner
--   dashboard does, so every bill rule (paid lines, totals, closing only when settled)
--   applies unchanged, and it restores the headers before it returns. The owner key never
--   leaves the database; guests gain nothing: aal_pos_bill is executable by service_role
--   only and runs only those three operations.

begin;
do $$ begin
 if to_regprocedure('public.aal_mutate(text,text,jsonb,text)') is null or to_regprocedure('public.aal_bill_lines(jsonb)') is null
    or to_regclass('public.staff_members') is null or to_regprocedure('public.aal_staff_role(text)') is null then
  raise exception 'Run auth-2026-09-24.sql before integrations-2026-09-30.sql';
 end if;
 if to_regclass('public.check_keys') is null or to_regprocedure('public.aal_check_scope(text)') is null then
  raise exception 'Run followups-2026-09-24.sql before integrations-2026-09-30.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Optional extensions: a project that cannot create them still gets the rest
-- ---------------------------------------------------------------------------
do $$ begin
 begin
  create extension if not exists pg_net with schema extensions;
 exception when others then raise notice 'pg_net not available (%): webhooks are sent only when something calls pos-webhook-deliver.', sqlerrm;
 end;
 begin
  create extension if not exists pg_cron;
 exception when others then raise notice 'pg_cron not available (%): schedule pos-webhook-deliver another way.', sqlerrm;
 end;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables, closed to anon and authenticated
-- ---------------------------------------------------------------------------
create table if not exists public.integration_keys (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  label         text not null default '' check (length(label) <= 80),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint      text not null default '',
  scopes        text[] not null default '{bills}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists integration_keys_venue on public.integration_keys (restaurant_id);

create table if not exists public.integration_key_usage (
  key_id  uuid not null references public.integration_keys (id) on delete cascade,
  minute  timestamptz not null,
  calls   int not null default 0,
  primary key (key_id, minute)
);

create table if not exists public.webhook_endpoints (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  url           text not null check (url ~ '^https://' and length(url) <= 2000),
  secret        text not null,
  events        text[] not null default '{bill.paid,bill.closed}',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists webhook_endpoints_venue on public.webhook_endpoints (restaurant_id) where active;

create table if not exists public.webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  endpoint_id     uuid not null references public.webhook_endpoints (id) on delete cascade,
  event_type      text not null,
  event_id        text not null,
  payload         jsonb not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz default now(),
  delivered_at    timestamptz,
  last_status     int,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
-- the retry scan: undelivered rows with a next attempt, oldest due first
create index if not exists webhook_deliveries_due on public.webhook_deliveries (next_attempt_at)
  where delivered_at is null and next_attempt_at is not null;
create index if not exists webhook_deliveries_recent on public.webhook_deliveries (endpoint_id, created_at desc);

create table if not exists public.integration_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into public.integration_settings (key, value)
values ('deliver_url', 'https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/pos-webhook-deliver')
on conflict (key) do nothing;

alter table public.integration_keys enable row level security;       -- no policies: closed
alter table public.integration_key_usage enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.integration_settings enable row level security;
revoke all on public.integration_keys, public.integration_key_usage, public.webhook_endpoints,
              public.webhook_deliveries, public.integration_settings from public, anon, authenticated;
grant select, insert, update, delete on public.integration_keys, public.integration_key_usage, public.webhook_endpoints,
              public.webhook_deliveries, public.integration_settings to service_role;

-- bills by their POS reference, and a bill's payments (aal_mutate scans these too)
create index if not exists kv_rows_pos_ref on public.kv_rows
  (restaurant_id, (body->'posRef'->>'system'), (body->'posRef'->>'externalId')) where collection = 'aal.checks';
create index if not exists kv_rows_settle_check on public.kv_rows (restaurant_id, (body->>'checkId')) where collection = 'aal.settle';

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- A refusal the Edge Function turns into an HTTP answer: hint 'pos:<status>:<code>'.
create or replace function public.aal_pos_fail(p_status int, p_code text, p_message text, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql set search_path = public, extensions, pg_temp as $$
begin
 raise exception using message = p_message, hint = 'pos:' || p_status || ':' || p_code, detail = coalesce(p_detail, '{}'::jsonb)::text;
end $$;

-- What a bill owes, with aal_mutate's own sums: paid = confirmed, not refunded (tips
-- excluded); pending = cash awaiting staff and digital reservations still in progress.
create or replace function public.aal_pos_balance(p_rid text, p_cid text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
 with c as (select coalesce((body->>'totalCents')::bigint, 0) as t from public.kv_rows
             where restaurant_id = p_rid and collection = 'aal.checks' and id = p_cid),
      s as (select
        coalesce(sum(round((body->>'amount')::numeric*100) - round(coalesce((body->>'tip')::numeric, 0)*100))
                 filter (where body->>'status' = 'confirmed'), 0)::bigint as paid,
        coalesce(sum(round((body->>'amount')::numeric*100) - round(coalesce((body->>'tip')::numeric, 0)*100))
                 filter (where body->>'status' = 'pending'
                            or (body->>'status' = 'initiated' and (body->>'expiresAt')::timestamptz > now())), 0)::bigint as pending
        from public.kv_rows
       where restaurant_id = p_rid and collection = 'aal.settle' and body->>'checkId' = p_cid
         and body->>'refunded' is null and body->>'cancelled' is null)
 select jsonb_build_object('totalCents', c.t, 'paidCents', s.paid, 'pendingCents', s.pending,
                           'remainingCents', greatest(c.t - s.paid, 0))
   from c, s
$$;

-- aal_mutate as the venue owner (the headers were set by aal_pos_bill). Its refusals keep
-- their sentence and become 409 (a bill rule) or 400 (a malformed bill).
create or replace function public.aal_pos_call(p_rid text, p_op text, p_body jsonb) returns jsonb
language plpgsql set search_path = public, extensions, pg_temp as $$
begin
 return public.aal_mutate(p_rid, p_op, p_body, '');
exception when others then
 if sqlerrm = 'Invalid bill' or sqlerrm like 'Each bill item needs%' or sqlerrm like 'A bill needs%' then
  raise exception using message = sqlerrm, hint = 'pos:400:bad_bill', detail = '{}';
 end if;
 raise exception using message = sqlerrm, hint = 'pos:409:rule', detail = '{}';
end $$;

-- ---------------------------------------------------------------------------
-- 3. The key: resolve and count
-- ---------------------------------------------------------------------------
create or replace function public.aal_pos_resolve(p_key_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare k public.integration_keys; n int; m timestamptz := date_trunc('minute', now());
begin
 if coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$' then return null; end if;
 select * into k from public.integration_keys where key_hash = p_key_hash and revoked_at is null;
 if not found then return null; end if;
 insert into public.integration_key_usage as u (key_id, minute, calls) values (k.id, m, 1)
 on conflict (key_id, minute) do update set calls = u.calls + 1
 returning u.calls into n;
 if n = 1 then
  delete from public.integration_key_usage where key_id = k.id and minute < now() - interval '1 hour';
  update public.integration_keys set last_used_at = now() where id = k.id;   -- once a minute is enough
 end if;
 return jsonb_build_object('restaurant_id', k.restaurant_id, 'key_id', k.id, 'scopes', to_jsonb(k.scopes),
                           'calls', n, 'limit', 600, 'resetAt', m + interval '1 minute');
end $$;

-- ---------------------------------------------------------------------------
-- 4. A POS bill: open, update, tenders, close, all or nothing
-- ---------------------------------------------------------------------------
-- Which POS line an Aalayna line belongs to: its own id, the POS id inside a growth line
-- 'aalayna:+<version>:<id>', or null for the service lines.
create or replace function public.aal_pos_line_owner(p_id text) returns text
language sql immutable set search_path = public, extensions, pg_temp as $$
 select case when p_id = 'aalayna:service' or p_id like 'aalayna:service:%' then null
             when p_id ~ '^aalayna:\+[0-9]+:' then regexp_replace(p_id, '^aalayna:\+[0-9]+:', '')
             else p_id end
$$;

-- Once a payment is recorded (confirmed, or pending as aal_mutate counts it), the lines
-- Aalayna already has never change: the POS bill is followed by adding lines only.
--   * the discount must stay what it was (it is already spread over the existing lines);
--   * a new POS line is added at its full price;
--   * a POS line whose quantity grows grows in place when it carries no share of the
--     discount, else the extra units become 'aalayna:+<version>:<id>' at full price;
--   * a service charge that grows adds 'aalayna:service:<version>' for the difference;
--   * a smaller service charge, a repriced line or a changed discount is refused here;
--   * a POS line that disappears or shrinks gives null: the caller sends the POS lines as
--     they are and aal_mutate refuses them with its own sentence (which names a paid item).
create or replace function public.aal_pos_append_lines(p_old jsonb, p_ref jsonb, p_bill jsonb, p_ver bigint) returns jsonb
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare
 v_out jsonb := case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end;
 v_units jsonb := case when jsonb_typeof(p_ref->'units') = 'object' then p_ref->'units' else '{}'::jsonb end;
 v_items jsonb := case when jsonb_typeof(p_bill->'items') = 'array' then p_bill->'items' else '[]'::jsonb end;
 it jsonb; l jsonb; base jsonb; bi int; aq numeric; d bigint; unit bigint; owner_id text;
 svc_old bigint; svc_new bigint := coalesce((p_bill->>'serviceCents')::bigint, 0);
 reduce_msg text := 'A payment is recorded on this bill. Items can be added, not removed or reduced.';
begin
 if coalesce((p_bill->>'discountCents')::bigint, 0) <> coalesce((p_ref->>'discountCents')::bigint, 0) then
  perform public.aal_pos_fail(409, 'rule', 'A payment is recorded on this bill. The discount cannot change.');
 end if;
 for l in select value from jsonb_array_elements(v_out) loop
  owner_id := public.aal_pos_line_owner(l->>'id');
  if owner_id is not null and not exists (select 1 from jsonb_array_elements(v_items) i where i->>'id' = owner_id) then
   return null;   -- removed: aal_mutate refuses it in its own words (naming a paid item)
  end if;
 end loop;
 for it in select value from jsonb_array_elements(v_items) loop
  unit := (it->>'unitCents')::bigint;
  if v_units ? (it->>'id') and (v_units->>(it->>'id'))::bigint <> unit then
   perform public.aal_pos_fail(409, 'rule', 'A payment is recorded on this bill. Prices of existing items cannot change.');
  end if;
  select coalesce(sum((x->>'q')::numeric), 0) into aq from jsonb_array_elements(v_out) x where public.aal_pos_line_owner(x->>'id') = it->>'id';
  if (it->>'q')::numeric < aq then return null; end if;   -- reduced: likewise
  d := ((it->>'q')::numeric - aq)::bigint;
  if d > 0 then
   base := null;
   select e.value, (e.k - 1)::int into base, bi from jsonb_array_elements(v_out) with ordinality e(value, k) where e.value->>'id' = it->>'id';
   if base is not null and round((base->>'p')::numeric*100) = (base->>'q')::numeric*unit then
    v_out := jsonb_set(v_out, array[bi::text], base || jsonb_build_object('q', (base->>'q')::int + d,
               'p', trim_scale(round((round((base->>'p')::numeric*100) + d*unit)/100.0, 2))));
   else
    v_out := v_out || jsonb_build_array(jsonb_build_object(
               'id', case when base is null and aq = 0 then it->>'id' else 'aalayna:+' || p_ver || ':' || (it->>'id') end,
               'q', d, 'p', trim_scale(round(d*unit/100.0, 2)), 'name', it->>'name'));
   end if;
  end if;
 end loop;
 select coalesce(sum(round((x->>'p')::numeric*100)), 0)::bigint into svc_old from jsonb_array_elements(v_out) x
  where x->>'id' = 'aalayna:service' or x->>'id' like 'aalayna:service:%';
 if svc_new < svc_old then perform public.aal_pos_fail(409, 'rule', reduce_msg);
 elsif svc_new > svc_old then
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', 'aalayna:service:' || p_ver, 'q', 1,
             'p', trim_scale(round((svc_new - svc_old)/100.0, 2)), 'name', 'Service'));
 end if;
 if (select coalesce(sum(round((x->>'p')::numeric*100)), 0) from jsonb_array_elements(v_out) x) <> (p_bill->>'totalCents')::bigint then
  perform public.aal_pos_fail(409, 'rule', 'A payment is recorded on this bill. Its lines can only be added to, and this total does not match them.');
 end if;
 return v_out;
end $$;

-- Tenders taken at the till: each new one (by its POS externalId on this bill) becomes a
-- confirmed settlement, rail 'pos', with the payment_completed event aal_mutate writes for
-- a confirmation. A tender already recorded is skipped if identical, refused if changed.
-- A tender may never take paid + pending past the total. Returns how many were recorded.
create or replace function public.aal_pos_record_tenders(p_rid text, p_cid text, p_tenders jsonb, p_stamp text) returns int
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare
 t jsonb; c jsonb; prev jsonb; bal jsonb; n int := 0; a bigint; tip bigint; pid text; at timestamptz; at_text text; row jsonb; event_id text;
begin
 for t in select value from jsonb_array_elements(case when jsonb_typeof(p_tenders) = 'array' then p_tenders else '[]'::jsonb end) loop
  a := (t->>'amountCents')::bigint; tip := coalesce((t->>'tipCents')::bigint, 0);
  select r.body into prev from public.kv_rows r
   where r.restaurant_id = p_rid and r.collection = 'aal.settle' and r.body->>'checkId' = p_cid
     and r.body->>'source' = 'pos' and r.body->'posRef'->>'externalId' = t->>'externalId' limit 1;
  if prev is not null then
   if round((prev->>'amount')::numeric*100) <> a or round(coalesce((prev->>'tip')::numeric, 0)*100) <> tip or prev->>'method' is distinct from t->>'method' then
    perform public.aal_pos_fail(409, 'tender_changed', format('Tender %s was already recorded with a different amount or method.', t->>'externalId'),
      jsonb_build_object('tenderExternalId', t->>'externalId', 'paymentId', prev->>'id'));
   end if;
   continue;
  end if;
  select body into c from public.kv_rows where restaurant_id = p_rid and collection = 'aal.checks' and id = p_cid;
  bal := public.aal_pos_balance(p_rid, p_cid);
  if (bal->>'paidCents')::bigint + (bal->>'pendingCents')::bigint + (a - tip) > (bal->>'totalCents')::bigint then
   perform public.aal_pos_fail(409, 'overpaid',
     format('Tender %s would overpay this bill: %s cents are left to pay in Aalayna.', t->>'externalId',
            greatest((bal->>'totalCents')::bigint - (bal->>'paidCents')::bigint - (bal->>'pendingCents')::bigint, 0)),
     bal || jsonb_build_object('checkId', p_cid, 'tenderExternalId', t->>'externalId', 'amountCents', a, 'tipCents', tip,
       'leftToPayCents', greatest((bal->>'totalCents')::bigint - (bal->>'paidCents')::bigint - (bal->>'pendingCents')::bigint, 0)));
  end if;
  -- when the money was taken, kept between the bill's opening and now
  at := clock_timestamp();
  if coalesce(t->>'takenAt', '') <> '' then
   at := least(clock_timestamp(), greatest((t->>'takenAt')::timestamptz, coalesce((c->>'openedAt')::timestamptz, (t->>'takenAt')::timestamptz)));
  end if;
  at_text := to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  pid := 'tnd_' || encode(gen_random_bytes(12), 'hex');
  row := jsonb_build_object('id', pid, 'venueId', p_rid, 'checkId', p_cid, 'table', c->'table',
    'rail', 'pos', 'source', 'pos', 'method', t->>'method',
    'posRef', jsonb_build_object('externalId', t->>'externalId', 'method', t->>'method'),
    'amount', trim_scale(round(a/100.0, 2)), 'tip', trim_scale(round(tip/100.0, 2)), 'items', '{}'::jsonb,
    'currency', coalesce(c->>'currency', 'USD'), 'amountUsd', trim_scale(round(a/100.0, 2)), 'fxRateUsed', c->'fxRateUsed',
    'status', 'confirmed', 'ts', at_text, 'confirmedAt', at_text, 'recordedAt', p_stamp);
  insert into public.kv_rows values (p_rid, 'aal.settle', pid, row, now());
  event_id := gen_random_uuid()::text;
  insert into public.kv_rows values (p_rid, 'aal.events', event_id, jsonb_build_object('eventId', event_id, 'eventType', 'payment_completed',
    'restaurantId', p_rid, 'tableId', c->'table', 'deviceId', null, 'sessionId', null, 'createdAt', p_stamp, 'customerId', null,
    'payload', jsonb_build_object('paymentId', pid, 'orderId', p_cid, 'amount', row->'amount', 'tip', row->'tip', 'rail', 'pos',
      'currency', row->'currency', 'amountUsd', row->'amountUsd')), now());
  n := n + 1;
 end loop;
 return n;
end $$;

-- p_bill as the Edge Function sends it (already validated there; checked again here):
--   {system, externalId, table, currency, totalCents, discountCents, serviceCents, version,
--    closed, items: [{id, q, unitCents, name}], lines: [{id, q, p, name}], tenders: [...]}
-- lines are aal_mutate's format (p the line total in units, the discount spread over the
-- items, the service charge as 'aalayna:service'); they are used as they are while no
-- payment exists. items are the POS lines at full price, for aal_pos_append_lines.
create or replace function public.aal_pos_bill(p_key_hash text, p_bill jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
 k public.integration_keys; rid text; okey text; hdr text;
 sys text; ext text; ver bigint; tbl int; cur_code text; closing boolean; digest text; ref jsonb;
 c jsonb; cid text; prev bigint; new_lines jsonb; status text := 'unchanged'; bal jsonb; other text; oc jsonb; tn int := 0;
 event_id text; created boolean := false;
 stamp text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 select * into k from public.integration_keys
  where key_hash = p_key_hash and revoked_at is null and 'bills' = any (scopes);
 if not found then perform public.aal_pos_fail(401, 'unknown_key', 'Unknown or revoked integration key.'); end if;
 rid := k.restaurant_id;

 -- the backstop for the Edge Function's validation
 if jsonb_typeof(p_bill) is distinct from 'object' or jsonb_typeof(p_bill->'lines') is distinct from 'array'
    or jsonb_typeof(p_bill->'items') is distinct from 'array'
    or coalesce(jsonb_typeof(p_bill->'tenders'), 'array') <> 'array'
    or jsonb_typeof(p_bill->'externalId') is distinct from 'string' or length(p_bill->>'externalId') not between 1 and 100
    or jsonb_typeof(p_bill->'version') is distinct from 'number' or (p_bill->>'version') !~ '^[0-9]{1,16}$'
    or jsonb_typeof(p_bill->'table') is distinct from 'number' or (p_bill->>'table') !~ '^[0-9]{1,4}$'
    or coalesce(p_bill->>'currency', '') not in ('USD', 'LBP')
    or jsonb_typeof(p_bill->'totalCents') is distinct from 'number' or (p_bill->>'totalCents') !~ '^[0-9]{1,16}$'
    or coalesce(p_bill->>'discountCents', '0') !~ '^[0-9]{1,16}$' or coalesce(p_bill->>'serviceCents', '0') !~ '^[0-9]{1,16}$'
    or exists (select 1 from jsonb_array_elements(coalesce(p_bill->'tenders', '[]'::jsonb)) t
                where coalesce(t->>'externalId', '') = '' or coalesce(t->>'method', '') not in ('cash', 'card', 'other')
                   or coalesce(t->>'amountCents', '') !~ '^[0-9]{1,16}$' or coalesce(t->>'tipCents', '0') !~ '^[0-9]{1,16}$'
                   or (t->>'amountCents')::bigint <= coalesce((t->>'tipCents')::bigint, 0)) then
  perform public.aal_pos_fail(400, 'bad_body', 'The bill is malformed.');
 end if;
 sys := coalesce(nullif(p_bill->>'system', ''), 'pos'); ext := p_bill->>'externalId';
 ver := (p_bill->>'version')::bigint; tbl := (p_bill->>'table')::int; cur_code := p_bill->>'currency';
 closing := coalesce(p_bill->>'closed', 'false') = 'true';
 if ver < 1 or tbl < 1 then perform public.aal_pos_fail(400, 'bad_body', 'The bill is malformed.'); end if;
 new_lines := public.aal_bill_lines(p_bill->'lines');
 if (select coalesce(sum(round((l->>'p')::numeric*100)), 0) from jsonb_array_elements(new_lines) l) <> (p_bill->>'totalCents')::bigint
    or (select coalesce(sum((i->>'q')::bigint * (i->>'unitCents')::bigint), 0) from jsonb_array_elements(p_bill->'items') i)
       - coalesce((p_bill->>'discountCents')::bigint, 0) + coalesce((p_bill->>'serviceCents')::bigint, 0) <> (p_bill->>'totalCents')::bigint then
  perform public.aal_pos_fail(400, 'total_mismatch', 'totalCents is not the sum of the lines.');
 end if;
 -- what the POS said about the bill, apart from its version, whether it is closed and the tenders
 digest := encode(sha256(convert_to((p_bill - 'version' - 'closed' - 'tenders')::text, 'UTF8')), 'hex');
 ref := jsonb_build_object('system', sys, 'externalId', ext, 'version', ver, 'digest', digest,
   'units', coalesce((select jsonb_object_agg(i->>'id', (i->>'unitCents')::bigint) from jsonb_array_elements(p_bill->'items') i), '{}'::jsonb),
   'discountCents', coalesce((p_bill->>'discountCents')::bigint, 0), 'serviceCents', coalesce((p_bill->>'serviceCents')::bigint, 0));

 -- one POS request at a time per venue, and never interleaved with staff or guests
 perform pg_advisory_xact_lock(hashtextextended(rid, 0));
 select v.owner_key into okey from public.venue_keys v where v.restaurant_id = rid;
 hdr := current_setting('request.headers', true);
 perform set_config('request.headers', jsonb_build_object('x-aalayna-key', okey)::text, true);
 perform set_config('aalayna.actor', 'pos', true);   -- the webhook trigger's closedBy

 select r.body into c from public.kv_rows r
  where r.restaurant_id = rid and r.collection = 'aal.checks'
    and r.body->'posRef'->>'system' = sys and r.body->'posRef'->>'externalId' = ext
  order by r.body->>'openedAt' desc nulls last limit 1;

 if c is null then
  -- a new bill
  if jsonb_array_length(new_lines) = 0 then
   perform public.aal_pos_fail(400, 'empty_bill', 'Send the bill once it has at least one item.');
  end if;
  -- the table's open bill: superseded if nobody has paid or asked to pay anything on it
  for oc in select r.body from public.kv_rows r
             where r.restaurant_id = rid and r.collection = 'aal.checks' and r.body->>'table' = tbl::text and r.body->>'closedAt' is null loop
   if exists (select 1 from public.kv_rows s where s.restaurant_id = rid and s.collection = 'aal.settle' and s.body->>'checkId' = oc->>'id') then
    perform public.aal_pos_fail(409, 'table_busy', format('Table %s already has an open bill in Aalayna with a payment on it. Staff must settle and close it first.', tbl),
      jsonb_build_object('table', tbl, 'openCheckId', oc->>'id', 'openExternalId', oc->'posRef'->>'externalId'));
   end if;
   oc := oc || jsonb_build_object('closedAt', stamp, 'updatedAt', stamp,
           'posRef', coalesce(oc->'posRef', '{}'::jsonb) || jsonb_build_object('superseded', ext));
   update public.kv_rows set body = oc where restaurant_id = rid and collection = 'aal.checks' and id = oc->>'id';
   event_id := gen_random_uuid()::text;
   insert into public.kv_rows values (rid, 'aal.events', event_id, jsonb_build_object('eventId', event_id, 'eventType', 'bill_superseded',
     'restaurantId', rid, 'tableId', oc->>'table', 'deviceId', null, 'sessionId', null, 'createdAt', stamp, 'customerId', null,
     'payload', jsonb_build_object('orderId', oc->>'id', 'externalId', oc->'posRef'->>'externalId', 'supersededBy', ext, 'system', sys,
       'totalCents', oc->'totalCents')), now());
  end loop;
  cid := 'pos_' || encode(gen_random_bytes(12), 'hex');
  c := public.aal_pos_call(rid, 'open_check', jsonb_build_object('id', cid, 'table', tbl, 'lines', new_lines, 'currency', cur_code, 'posRef', ref));
  if c->>'id' is distinct from cid then
   perform public.aal_pos_fail(409, 'table_busy', format('Table %s already has an open bill in Aalayna. Staff must settle and close it first.', tbl),
     jsonb_build_object('table', tbl, 'openCheckId', c->>'id', 'openExternalId', c->'posRef'->>'externalId'));
  end if;
  status := 'opened'; created := true;
 else
  cid := c->>'id';
  prev := coalesce((c->'posRef'->>'version')::bigint, 0);
  if ver < prev then
   perform public.aal_pos_fail(409, 'stale_version', format('Version %s is older than the version Aalayna has (%s).', ver, prev),
     jsonb_build_object('currentVersion', prev, 'checkId', cid));
  elsif ver = prev and digest is distinct from c->'posRef'->>'digest' then
   perform public.aal_pos_fail(409, 'version_reused', format('Version %s was already sent with different contents. Send changes with a higher version.', ver),
     jsonb_build_object('currentVersion', prev, 'checkId', cid));
  elsif ver > prev then
   if digest is distinct from c->'posRef'->>'digest' then
    if c->>'closedAt' is not null then
     perform public.aal_pos_fail(409, 'bill_closed', 'This bill is closed in Aalayna and cannot change.', jsonb_build_object('checkId', cid, 'closedAt', c->>'closedAt'));
    end if;
    if coalesce(c->>'currency', 'USD') <> cur_code then
     perform public.aal_pos_fail(409, 'currency_changed', format('This bill is in %s; its currency cannot change.', coalesce(c->>'currency', 'USD')),
       jsonb_build_object('checkId', cid, 'currency', coalesce(c->>'currency', 'USD')));
    end if;
    bal := public.aal_pos_balance(rid, cid);
    if (bal->>'paidCents')::bigint + (bal->>'pendingCents')::bigint > 0 then
     new_lines := coalesce(public.aal_pos_append_lines(c->'lines', c->'posRef', p_bill, ver), new_lines);
    end if;
    if new_lines is distinct from c->'lines' then
     -- the paid-line rules, the closed-bill rule and the total rule are aal_mutate's
     c := public.aal_pos_call(rid, 'update_check', jsonb_build_object('checkId', cid, 'lines', new_lines, 'requestId', 'pos:' || ext || ':' || ver));
     status := 'updated';
    end if;
    if (c->>'table')::int is distinct from tbl then
     -- a table transfer: the new table must be free
     select r.id into other from public.kv_rows r
      where r.restaurant_id = rid and r.collection = 'aal.checks' and r.id <> cid
        and r.body->>'table' = tbl::text and r.body->>'closedAt' is null limit 1;
     if other is not null then
      perform public.aal_pos_fail(409, 'table_busy', format('Table %s already has an open bill in Aalayna. Staff must settle and close it first.', tbl),
        jsonb_build_object('table', tbl, 'openCheckId', other));
     end if;
     c := c || jsonb_build_object('table', tbl, 'revision', coalesce((c->>'revision')::int, 1) + 1, 'updatedAt', stamp);
     status := 'updated';
    end if;
   end if;
   c := c || jsonb_build_object('posRef', ref);
   update public.kv_rows set body = c where restaurant_id = rid and collection = 'aal.checks' and id = cid;
  end if;
 end if;

 -- tenders taken at the till, after the lines and before the close
 tn := public.aal_pos_record_tenders(rid, cid, p_bill->'tenders', stamp);
 if tn > 0 and status = 'unchanged' then status := 'updated'; end if;

 if closing and c->>'closedAt' is null then
  bal := public.aal_pos_balance(rid, cid);
  if (bal->>'remainingCents')::bigint > 0 then
   perform public.aal_pos_fail(409, 'balance_outstanding',
     format('This bill still has %s cents outstanding in Aalayna, so it cannot be closed.', bal->>'remainingCents'),
     bal || jsonb_build_object('checkId', cid));
  end if;
  c := public.aal_pos_call(rid, 'close_check', jsonb_build_object('checkId', cid));
  status := 'closed';
 end if;

 perform set_config('aalayna.actor', '', true);
 perform set_config('request.headers', coalesce(nullif(hdr, ''), '{}'), true);
 select body into c from public.kv_rows where restaurant_id = rid and collection = 'aal.checks' and id = cid;
 return jsonb_build_object('checkId', cid, 'status', status, 'system', sys, 'externalId', ext,
   'version', (c->'posRef'->>'version')::bigint, 'revision', coalesce((c->>'revision')::int, 1),
   'table', (c->>'table')::int, 'currency', coalesce(c->>'currency', 'USD'),
   'closed', c->>'closedAt' is not null, 'closedAt', c->>'closedAt', 'tendersRecorded', tn, 'created', created,
   'balance', public.aal_pos_balance(rid, cid));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Webhooks: queue, kick, claim, record
-- ---------------------------------------------------------------------------
create or replace function public.aal_pos_cron_secret() returns text
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare s text;
begin
 if to_regclass('vault.decrypted_secrets') is not null then
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into s using 'aalayna_cron_secret';
 end if;
 if s is null then select value into s from public.integration_settings where key = 'cron_secret'; end if;
 return nullif(s, '');
end $$;

-- The delivery function's address: vault aalayna_functions_url + /pos-webhook-deliver,
-- else integration_settings deliver_url.
create or replace function public.aal_pos_deliver_url() returns text
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare u text;
begin
 if to_regclass('vault.decrypted_secrets') is not null then
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into u using 'aalayna_functions_url';
  if nullif(u, '') is not null then return rtrim(u, '/') || '/pos-webhook-deliver'; end if;
 end if;
 select value into u from public.integration_settings where key = 'deliver_url';
 return nullif(u, '');
end $$;

-- Ask pos-webhook-deliver to run, through pg_net, when a delivery is due. pg_net sends
-- after the transaction commits, so a rolled-back payment sends nothing.
create or replace function public.aal_pos_kick() returns boolean
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare u text; s text;
begin
 if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return false; end if;
 if not exists (select 1 from public.webhook_deliveries where delivered_at is null and next_attempt_at <= now()) then return false; end if;
 u := public.aal_pos_deliver_url();
 s := public.aal_pos_cron_secret();
 if u is null or s is null then return false; end if;
 execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
   using u, '{}'::jsonb, '{}'::jsonb, jsonb_build_object('Content-Type', 'application/json', 'X-Aalayna-Cron', s), 5000;
 return true;
end $$;

-- One delivery per active endpoint that wants the event; never twice for one event_id.
create or replace function public.aal_pos_enqueue_event(p_rid text, p_type text, p_event_id text, p_payload jsonb) returns int
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare n int;
begin
 insert into public.webhook_deliveries (endpoint_id, event_type, event_id, payload)
 select e.id, p_type, p_event_id,
        jsonb_build_object('event', p_type, 'eventId', p_event_id, 'venue', p_rid,
          'occurredAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || p_payload
   from public.webhook_endpoints e
  where e.restaurant_id = p_rid and e.active and p_type = any (e.events)
 on conflict (endpoint_id, event_id) do nothing;
 get diagnostics n = row_count;
 return n;
end $$;

create or replace function public.aal_pos_webhook_trigger() returns trigger
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare c jsonb; cid text; paid bigint; total bigint; n int := 0; origin text;
begin
 if not exists (select 1 from public.webhook_endpoints e where e.restaurant_id = new.restaurant_id and e.active) then return null; end if;
 begin
  if new.collection = 'aal.checks' then
   c := new.body; cid := new.id;
   if c->>'closedAt' is not null and (tg_op = 'INSERT' or old.body->>'closedAt' is null) then
    -- closedBy: aal_pos_bill marks its own transaction (a POS close, or a superseded bill)
    n := n + public.aal_pos_enqueue_event(new.restaurant_id, 'bill.closed', cid || ':bill.closed',
      jsonb_build_object('checkId', cid, 'externalId', c->'posRef'->>'externalId', 'table', c->'table', 'closedAt', c->>'closedAt',
        'origin', case when c->'posRef'->>'externalId' is not null then 'pos' else 'aalayna' end,
        'closedBy', case when coalesce(current_setting('aalayna.actor', true), '') = 'pos' then 'pos' else 'aalayna' end,
        'supersededBy', c->'posRef'->>'superseded'));
   end if;
  else
   -- a payment: only its move to confirmed matters
   if new.body->>'status' is distinct from 'confirmed' or (tg_op = 'UPDATE' and old.body->>'status' = 'confirmed') then return null; end if;
   cid := new.body->>'checkId';
   select r.body into c from public.kv_rows r where r.restaurant_id = new.restaurant_id and r.collection = 'aal.checks' and r.id = cid;
  end if;
  if c is not null then
   total := coalesce((c->>'totalCents')::bigint, 0);
   paid := (public.aal_pos_balance(new.restaurant_id, cid)->>'paidCents')::bigint;
   if total > 0 and paid >= total then
    n := n + public.aal_pos_enqueue_event(new.restaurant_id, 'bill.paid', cid || ':bill.paid',
      jsonb_build_object('checkId', cid, 'externalId', c->'posRef'->>'externalId', 'table', c->'table',
        'origin', case when c->'posRef'->>'externalId' is not null then 'pos' else 'aalayna' end,
        'totalCents', total, 'paidCents', paid, 'currency', coalesce(c->>'currency', 'USD'),
        'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rail', r.body->>'rail',
             'amountCents', round((r.body->>'amount')::numeric*100)::bigint,
             'tipCents', round(coalesce((r.body->>'tip')::numeric, 0)*100)::bigint,
             'confirmedAt', r.body->>'confirmedAt', 'externalRef', r.body->>'externalRef',
             'tenderExternalId', case when r.body->>'source' = 'pos' then r.body->'posRef'->>'externalId' end)
             order by r.body->>'confirmedAt', r.id), '[]'::jsonb)
           from public.kv_rows r
          where r.restaurant_id = new.restaurant_id and r.collection = 'aal.settle' and r.body->>'checkId' = cid
            and r.body->>'status' = 'confirmed' and r.body->>'refunded' is null)));
   end if;
  end if;
  if n > 0 then perform public.aal_pos_kick(); end if;
 exception when others then
  raise warning 'aalayna webhooks: nothing queued for % % (%: %)', new.collection, new.id, sqlstate, sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists kv_rows_pos_webhooks on public.kv_rows;
create trigger kv_rows_pos_webhooks after insert or update on public.kv_rows
  for each row when (new.collection in ('aal.checks', 'aal.settle')) execute function public.aal_pos_webhook_trigger();

-- Up to 50 due deliveries with their endpoint, leased for five minutes so that two runs
-- never send the same delivery at once.
create or replace function public.aal_pos_claim_deliveries(p_limit int default 50) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_out jsonb;
begin
 with due as (
   select d.id from public.webhook_deliveries d
    where d.delivered_at is null and d.next_attempt_at <= now()
    order by d.next_attempt_at, d.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 50)
    for update skip locked),
 leased as (
   update public.webhook_deliveries d set next_attempt_at = now() + interval '5 minutes'
     from due where d.id = due.id
   returning d.id, d.endpoint_id, d.event_type, d.event_id, d.payload, d.attempts, d.created_at)
 select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'endpointId', l.endpoint_id, 'eventType', l.event_type,
          'eventId', l.event_id, 'payload', l.payload, 'attempts', l.attempts,
          'url', e.url, 'secret', e.secret, 'active', e.active) order by l.created_at), '[]'::jsonb)
   into v_out
   from leased l join public.webhook_endpoints e on e.id = l.endpoint_id;
 return v_out;
end $$;

-- A 2xx marks it delivered; anything else counts an attempt and sets the next one
-- (p_next_attempt_at null: given up, last_error stays).
create or replace function public.aal_pos_delivery_result(p_id uuid, p_ok boolean, p_status int, p_error text, p_next_attempt_at timestamptz)
returns void language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
 if p_ok then
  update public.webhook_deliveries set delivered_at = now(), attempts = attempts + 1, last_status = p_status,
         last_error = null, next_attempt_at = null
   where id = p_id and delivered_at is null;
 else
  update public.webhook_deliveries set attempts = attempts + 1, last_status = p_status,
         last_error = left(coalesce(p_error, 'failed'), 500), next_attempt_at = p_next_attempt_at
   where id = p_id and delivered_at is null;
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The owner's surface: keys and endpoints
-- ---------------------------------------------------------------------------
-- The venue's owner key, or a signed-in owner (not a manager): as aal_staff.
create or replace function public.aal_pos_is_owner(p_rid text) returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select (public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = p_rid and v.owner_key = public.aal_key()))
        or coalesce(public.aal_staff_role(p_rid), '') = 'owner'
$$;

create or replace function public.aal_integration(p_rid text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_body jsonb := coalesce(p_body, '{}'::jsonb); v_op text; v_key text; v_row public.integration_keys; v_list jsonb;
begin
 if jsonb_typeof(v_body) <> 'object' then raise exception 'Integration request must be a JSON object.'; end if;
 if not public.aal_pos_is_owner(p_rid) then raise exception 'Only the restaurant owner can manage POS keys.' using errcode = '42501'; end if;
 v_op := coalesce(v_body->>'op', 'list');
 if v_op not in ('list', 'issue', 'revoke') then raise exception 'Unknown integration operation.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_rid, 0));
 if v_op = 'issue' then
  if (select count(*) from public.integration_keys where restaurant_id = p_rid and revoked_at is null) >= 10 then
   raise exception 'This restaurant already has 10 live POS keys. Revoke one first.';
  end if;
  v_key := 'pos_' || encode(gen_random_bytes(32), 'hex');
  insert into public.integration_keys (restaurant_id, label, key_hash, key_hint)
  values (p_rid, left(btrim(coalesce(v_body->>'label', '')), 80), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), substr(v_key, 5, 8))
  returning * into v_row;
 elsif v_op = 'revoke' then
  update public.integration_keys set revoked_at = now()
   where restaurant_id = p_rid and id::text = coalesce(v_body->>'id', '') and revoked_at is null;
  if not found then raise exception 'No live POS key with that id.'; end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'hint', 'pos_' || i.key_hint || '...', 'scopes', to_jsonb(i.scopes),
          'created_at', i.created_at, 'last_used_at', i.last_used_at, 'revoked_at', i.revoked_at)
          order by (i.revoked_at is not null), i.created_at desc), '[]'::jsonb)
   into v_list from public.integration_keys i where i.restaurant_id = p_rid;
 if v_op = 'issue' then
  -- the only time the key exists outside the POS: it is not stored
  return jsonb_build_object('restaurant_id', p_rid, 'id', v_row.id, 'key', v_key, 'keys', v_list);
 end if;
 return jsonb_build_object('restaurant_id', p_rid, 'keys', v_list);
end $$;

create or replace function public.aal_webhooks(p_rid text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
 v_body jsonb := coalesce(p_body, '{}'::jsonb); v_op text; v_url text; v_host text; v_events text[];
 v_secret text; v_ep public.webhook_endpoints; v_event text; v_list jsonb;
begin
 if jsonb_typeof(v_body) <> 'object' then raise exception 'Webhook request must be a JSON object.'; end if;
 if not public.aal_pos_is_owner(p_rid) then raise exception 'Only the restaurant owner can manage webhooks.' using errcode = '42501'; end if;
 v_op := coalesce(v_body->>'op', 'list');
 if v_op not in ('list', 'add', 'remove', 'test', 'deliveries') then raise exception 'Unknown webhook operation.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_rid, 0));

 if v_op = 'add' then
  v_url := btrim(coalesce(v_body->>'url', ''));
  v_host := lower(substring(v_url from '^https://([^/?#:@]+)(:[0-9]+)?([/?#]|$)'));
  -- a public host name only: no IP literal, no local or internal name
  if length(v_url) > 2000 or v_host is null or v_host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
     or v_host ~ '(^|\.)(localhost|local|internal|localdomain|home|lan|test|invalid)$' then
   raise exception 'The webhook address must be https:// and a public host name.';
  end if;
  if jsonb_typeof(v_body->'events') = 'array' then
   select coalesce(array_agg(distinct e order by e), '{}') into v_events from jsonb_array_elements_text(v_body->'events') e;
   if cardinality(v_events) = 0 or not v_events <@ array['bill.paid', 'bill.closed'] then
    raise exception 'Events must be bill.paid and/or bill.closed.';
   end if;
  else
   v_events := array['bill.paid', 'bill.closed'];
  end if;
  if (select count(*) from public.webhook_endpoints where restaurant_id = p_rid and active) >= 5 then
   raise exception 'This restaurant already has 5 webhook endpoints. Remove one first.';
  end if;
  v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');
  insert into public.webhook_endpoints (restaurant_id, url, secret, events)
  values (p_rid, v_url, v_secret, v_events) returning * into v_ep;
  -- the only time the secret is shown
  return jsonb_build_object('restaurant_id', p_rid, 'id', v_ep.id, 'url', v_ep.url, 'events', to_jsonb(v_ep.events), 'secret', v_secret);
 end if;

 if v_op in ('remove', 'test') then
  select * into v_ep from public.webhook_endpoints where restaurant_id = p_rid and id::text = coalesce(v_body->>'id', '') and active;
  if not found then raise exception 'No active webhook endpoint with that id.'; end if;
  if v_op = 'remove' then
   update public.webhook_endpoints set active = false where id = v_ep.id;
   update public.webhook_deliveries set next_attempt_at = null, last_error = coalesce(last_error || '; ', '') || 'endpoint removed'
    where endpoint_id = v_ep.id and delivered_at is null and next_attempt_at is not null;
  else
   v_event := 'ping:' || gen_random_uuid()::text;
   insert into public.webhook_deliveries (endpoint_id, event_type, event_id, payload)
   values (v_ep.id, 'ping', v_event, jsonb_build_object('event', 'ping', 'eventId', v_event, 'venue', p_rid, 'endpointId', v_ep.id,
     'occurredAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
   perform public.aal_pos_kick();
   return jsonb_build_object('restaurant_id', p_rid, 'id', v_ep.id, 'queued', v_event);
  end if;
 end if;

 if v_op = 'deliveries' then
  return jsonb_build_object('restaurant_id', p_rid, 'deliveries', coalesce((
   select jsonb_agg(x.j order by x.created_at desc) from (
    select d.created_at, jsonb_build_object('id', d.id, 'endpointId', d.endpoint_id, 'event', d.event_type, 'eventId', d.event_id,
             'attempts', d.attempts, 'next_attempt_at', d.next_attempt_at, 'delivered_at', d.delivered_at,
             'last_status', d.last_status, 'last_error', d.last_error, 'created_at', d.created_at, 'payload', d.payload) as j
      from public.webhook_deliveries d join public.webhook_endpoints e on e.id = d.endpoint_id
     where e.restaurant_id = p_rid and (coalesce(v_body->>'id', '') = '' or e.id::text = v_body->>'id')
     order by d.created_at desc limit 50) x), '[]'::jsonb));
 end if;

 select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'url', e.url, 'events', to_jsonb(e.events), 'active', e.active,
          'created_at', e.created_at) order by e.active desc, e.created_at desc), '[]'::jsonb)
   into v_list from public.webhook_endpoints e where e.restaurant_id = p_rid;
 return jsonb_build_object('restaurant_id', p_rid, 'endpoints', v_list);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges: the bridge's functions are the service role's; the owner's two are
--    callable by anon and authenticated and decide for themselves
-- ---------------------------------------------------------------------------
revoke all on function public.aal_pos_fail(int, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_pos_balance(text, text) from public, anon, authenticated;
revoke all on function public.aal_pos_call(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_pos_line_owner(text) from public, anon, authenticated;
revoke all on function public.aal_pos_append_lines(jsonb, jsonb, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.aal_pos_record_tenders(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.aal_pos_cron_secret() from public, anon, authenticated, service_role;
revoke all on function public.aal_pos_deliver_url() from public, anon, authenticated, service_role;
revoke all on function public.aal_pos_kick() from public, anon, authenticated, service_role;
revoke all on function public.aal_pos_enqueue_event(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_pos_webhook_trigger() from public, anon, authenticated;
revoke all on function public.aal_pos_is_owner(text) from public, anon, authenticated;
revoke all on function public.aal_pos_resolve(text) from public, anon, authenticated;
revoke all on function public.aal_pos_bill(text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_pos_claim_deliveries(int) from public, anon, authenticated;
revoke all on function public.aal_pos_delivery_result(uuid, boolean, int, text, timestamptz) from public, anon, authenticated;
grant execute on function public.aal_pos_resolve(text) to service_role;
grant execute on function public.aal_pos_bill(text, jsonb) to service_role;
grant execute on function public.aal_pos_claim_deliveries(int) to service_role;
grant execute on function public.aal_pos_delivery_result(uuid, boolean, int, text, timestamptz) to service_role;
revoke all on function public.aal_integration(text, jsonb) from public;
revoke all on function public.aal_webhooks(text, jsonb) from public;
grant execute on function public.aal_integration(text, jsonb) to anon, authenticated;
grant execute on function public.aal_webhooks(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. The every-minute run, when pg_cron is there
-- ---------------------------------------------------------------------------
do $$ begin
 if to_regnamespace('cron') is not null then
  execute $c$select cron.schedule('aalayna-pos-webhooks', '* * * * *', 'select public.aal_pos_kick()')$c$;
 else
  raise notice 'pg_cron is not installed: call pos-webhook-deliver every minute some other way (supabase/README.md).';
 end if;
exception when others then
 raise notice 'Could not schedule aalayna-pos-webhooks (%): schedule it by hand (supabase/README.md).', sqlerrm;
end $$;
commit;
