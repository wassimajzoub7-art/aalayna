-- Payment callbacks and receipt emails (T14), 2026-09-30.
--
-- Run after auth-2026-09-24.sql (and the files before it), in the Supabase SQL editor.
-- Tested against PGlite (tests/receipt-email.test.cjs with PGLITE_MODULE set); not yet run
-- against the live project.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or replace
-- function", "drop trigger if exists" + "create trigger", grants and revokes, and a named
-- pg_cron job that is replaced in place. No existing row, table, policy or function is
-- changed; aal_mutate is not touched. It stops without changing anything if
-- auth-2026-09-24.sql or admin.sql has not been applied.
--
-- What it adds
--   payment_callbacks      one row per verified provider callback, whatever the outcome
--                          (supabase/functions/payment-webhook): provider, external_ref,
--                          payment_id, restaurant_id, amount_cents, currency, status (the
--                          provider's: paid | failed | refunded), outcome (what we did),
--                          http_status, server_reply (the database's sentence), occurred_at,
--                          received_at. Append only: the service role may insert and read,
--                          not change or delete. No request body is stored.
--   outbox_email           one row per email to send (supabase/functions/receipt-email):
--                          restaurant_id, kind ('receipt'), ref (the settlement id), to_hash
--                          (SHA-256 hex of the address; the address itself stays in the guest
--                          record only), status queued | sending | sent | failed | skipped,
--                          attempts, next_attempt_at, locked_until (the sender's lease),
--                          sent_at, provider_id (Resend's id), last_error, created_at.
--                          Unique on (restaurant_id, kind, ref): one receipt per settlement,
--                          ever. (A settlement id is unique per venue, as kv_rows' key is.)
--   aal_receipt_enqueue()  trigger on kv_rows: when an aal.settle row gains a customerId
--                          (the receipt op sets it once), queue its receipt and poke the
--                          sender. Any error here is turned into a warning, so the guest's
--                          receipt request is never refused because of the outbox.
--   aal_receipt_email_kick(p_only_if_due)
--                          POST, through pg_net, to
--                          https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/receipt-email
--                          (or <aalayna_functions_url>/receipt-email when that Vault secret
--                          exists, e.g. for another project) with the header X-Aalayna-Cron:
--                          <aalayna_cron_secret> from Supabase Vault, the same secret the
--                          daily-close jobs use. Does nothing (returns null) when pg_net,
--                          Vault or the secret is missing; then only a manual POST to the
--                          function drains the outbox.
--   aal_outbox_claim(p_kind, p_limit, p_lease_seconds)
--                          for the sender: takes up to p_limit due rows of that kind (queued
--                          and due, or 'sending' with an expired lease), marks them sending,
--                          attempts + 1, lease p_lease_seconds; skip locked, so two runs
--                          never take the same row. Service role only.
--   aal_payment_failed(p_rid, p_id, p_external_ref)
--                          for the webhook: a provider says the payment failed. An
--                          'initiated' payment becomes 'failed' (the guest page shows
--                          "declined") and a payment_cancelled event is written, as the
--                          cancel op would. Already failed, cancelled or expired: returned
--                          unchanged. Anything else: 'Payment already completed'. Needed
--                          because aal_mutate's cancel op only accepts the owner, the payer
--                          token or a waiter (cash), never the service role. Service role
--                          only; the same venue lock as aal_mutate.
--   pg_cron job 'aalayna-receipt-email'
--                          every minute: select public.aal_receipt_email_kick(true), which
--                          calls the sender only when a row is due. Created only if pg_cron
--                          is enabled.
--
-- Before running it (Dashboard > Database > Extensions): enable pg_net and pg_cron. Vault
-- (supabase_vault) is on in every Supabase project. Then, once, in the SQL editor, unless
-- daily-close-2026-09-30.sql's setup already did it (the value is the AALAYNA_CRON_SECRET
-- function secret; never commit it):
--   select vault.create_secret('<AALAYNA_CRON_SECRET>', 'aalayna_cron_secret');
-- Without pg_net nothing is called from the database; the file still installs, the outbox
-- fills, and a manual POST to the function drains it.

begin;
do $$ begin
 if to_regprocedure('public.aal_staff_email()') is null or to_regprocedure('public.aal_mutate(text,text,jsonb,text)') is null then
  raise exception 'Run auth-2026-09-24.sql before payments-2026-09-30.sql';
 end if;
 if to_regclass('public.venue_profiles') is null or to_regclass('public.kv_rows') is null then
  raise exception 'Run migration.sql and admin.sql before payments-2026-09-30.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Provider callbacks, as received
-- ---------------------------------------------------------------------------
create table if not exists public.payment_callbacks (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  external_ref  text,
  payment_id    text,
  restaurant_id text,
  amount_cents  bigint,
  currency      text,
  status        text,
  outcome       text not null,
  http_status   integer not null,
  server_reply  text,
  occurred_at   timestamptz,
  received_at   timestamptz not null default now()
);
create index if not exists payment_callbacks_payment on public.payment_callbacks (restaurant_id, payment_id, received_at);
create index if not exists payment_callbacks_ref on public.payment_callbacks (provider, external_ref);
alter table public.payment_callbacks enable row level security;   -- no policies: closed
revoke all on public.payment_callbacks from public, anon, authenticated;
revoke update, delete, truncate on public.payment_callbacks from service_role;
grant select, insert on public.payment_callbacks to service_role;

-- ---------------------------------------------------------------------------
-- Email outbox
-- ---------------------------------------------------------------------------
create table if not exists public.outbox_email (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   text not null,
  kind            text not null check (kind ~ '^[a-z][a-z_]{0,39}$'),
  ref             text not null,
  to_hash         text,
  status          text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  sent_at         timestamptz,
  provider_id     text,
  last_error      text,
  created_at      timestamptz not null default now()
);
create unique index if not exists outbox_email_once on public.outbox_email (restaurant_id, kind, ref);
create index if not exists outbox_email_due on public.outbox_email (kind, next_attempt_at) where status in ('queued', 'sending');
alter table public.outbox_email enable row level security;        -- no policies: closed
revoke all on public.outbox_email from public, anon, authenticated;
revoke delete, truncate on public.outbox_email from service_role;
grant select, insert, update on public.outbox_email to service_role;

-- the functions read these with the service role (Supabase grants this by default; stated
-- here so the functions do not depend on it)
grant select on public.kv_rows, public.kv_docs, public.venue_profiles to service_role;

-- ---------------------------------------------------------------------------
-- Poke the sender through pg_net
-- ---------------------------------------------------------------------------
create or replace function public.aal_receipt_email_kick(p_only_if_due boolean default false) returns bigint
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_url text; v_secret text; v_id bigint;
 v_default constant text := 'https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1';
begin
 if p_only_if_due and not exists (
   select 1 from public.outbox_email
    where kind = 'receipt'
      and ((status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and locked_until < now()))) then
  return null;
 end if;
 if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or to_regclass('vault.decrypted_secrets') is null then
  return null;
 end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'aalayna_functions_url';
 execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'aalayna_cron_secret';
 if coalesce(v_secret, '') = '' then return null; end if;
 v_url := coalesce(nullif(v_url, ''), v_default);
 execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
   into v_id
   using rtrim(v_url, '/') || '/receipt-email', '{}'::jsonb, '{}'::jsonb,
         jsonb_build_object('Content-Type', 'application/json', 'X-Aalayna-Cron', v_secret), 5000;
 return v_id;
exception when others then
 raise warning 'aal_receipt_email_kick: %', sqlerrm;
 return null;
end $$;
revoke all on function public.aal_receipt_email_kick(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Queue a receipt when the receipt op links a guest to a payment
-- ---------------------------------------------------------------------------
create or replace function public.aal_receipt_enqueue() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_contact text;
begin
 begin
  select g.body->>'contact' into v_contact from public.kv_rows g
   where g.restaurant_id = new.restaurant_id and g.collection = 'aal.guests' and g.id = new.body->>'customerId';
  insert into public.outbox_email (restaurant_id, kind, ref, to_hash)
  values (new.restaurant_id, 'receipt', new.id,
          case when coalesce(v_contact, '') <> '' then encode(sha256(convert_to(v_contact, 'UTF8')), 'hex') end)
  on conflict (restaurant_id, kind, ref) do nothing;
  if found then perform public.aal_receipt_email_kick(false); end if;
 exception when others then
  raise warning 'aal_receipt_enqueue: % (payment %)', sqlerrm, new.id;
 end;
 return null;
end $$;
revoke all on function public.aal_receipt_enqueue() from public, anon, authenticated;

drop trigger if exists kv_rows_receipt_enqueue on public.kv_rows;
create trigger kv_rows_receipt_enqueue after update on public.kv_rows
 for each row
 when (new.collection = 'aal.settle' and (new.body->>'customerId') is not null and (old.body->>'customerId') is null)
 execute function public.aal_receipt_enqueue();

-- ---------------------------------------------------------------------------
-- The sender takes due rows
-- ---------------------------------------------------------------------------
create or replace function public.aal_outbox_claim(p_kind text, p_limit integer default 10, p_lease_seconds integer default 120)
returns setof public.outbox_email
language sql volatile security definer set search_path = public, extensions, pg_temp as $$
 update public.outbox_email o
    set status = 'sending',
        attempts = o.attempts + 1,
        locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
  where o.id in (
    select q.id from public.outbox_email q
     where q.kind = p_kind
       and ((q.status = 'queued' and q.next_attempt_at <= now()) or (q.status = 'sending' and q.locked_until < now()))
     order by q.next_attempt_at, q.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked)
 returning o.*
$$;
revoke all on function public.aal_outbox_claim(text, integer, integer) from public, anon, authenticated;
grant execute on function public.aal_outbox_claim(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- A provider says the payment failed
-- ---------------------------------------------------------------------------
create or replace function public.aal_payment_failed(p_rid text, p_id text, p_external_ref text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
 p jsonb; ev jsonb; event_id text;
 stamp text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
  raise exception 'Verified provider callback required';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_rid, 0));
 select body into p from public.kv_rows where restaurant_id = p_rid and collection = 'aal.settle' and id = p_id;
 if p is null then raise exception 'Payment unavailable'; end if;
 if p->>'status' in ('failed', 'cancelled', 'expired') then return p; end if;
 if p->>'status' <> 'initiated' then raise exception 'Payment already completed'; end if;
 p := p || jsonb_build_object('status', 'failed', 'failedAt', stamp, 'failureRef', nullif(p_external_ref, ''));
 update public.kv_rows set body = p where restaurant_id = p_rid and collection = 'aal.settle' and id = p_id;
 event_id := gen_random_uuid()::text;
 ev := jsonb_build_object('eventId', event_id, 'eventType', 'payment_cancelled', 'restaurantId', p_rid, 'tableId', p->'table',
   'deviceId', p->'deviceId', 'sessionId', p->'sessionId', 'createdAt', stamp, 'customerId', p->'customerId',
   'payload', jsonb_build_object('paymentId', p_id, 'orderId', p->>'checkId', 'amount', p->'amount', 'tip', p->'tip',
     'rail', p->'rail', 'currency', p->'currency', 'amountUsd', p->'amountUsd', 'reason', 'failed'));
 insert into public.kv_rows values (p_rid, 'aal.events', event_id, ev, now());
 return p;
end $$;
revoke all on function public.aal_payment_failed(text, text, text) from public, anon, authenticated;
grant execute on function public.aal_payment_failed(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Every minute, if pg_cron is enabled
-- ---------------------------------------------------------------------------
do $$ begin
 if to_regprocedure('cron.schedule(text,text,text)') is not null then
  execute $cron$select cron.schedule('aalayna-receipt-email', '* * * * *', 'select public.aal_receipt_email_kick(true)')$cron$;
 else
  raise notice 'pg_cron is not enabled: enable it (Database > Extensions) and run this file again to schedule the receipt sender.';
 end if;
end $$;
commit;
