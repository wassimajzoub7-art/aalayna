-- Hosted payment pages (T15), 2026-10-14.
--
-- Run after payments-2026-09-30.sql (and the files before it), in the Supabase SQL editor.
-- Tested against PGlite (tests/payment-start-sql.test.cjs with PGLITE_MODULE set); not yet run
-- against the live project.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or replace
-- function", grants and revokes. No existing row, table, policy or function is changed;
-- aal_mutate is not touched. It stops without changing anything if payments-2026-09-30.sql
-- has not been applied.
--
-- What it adds
--   payment_providers      which provider takes each digital rail at a venue
--                          (supabase/functions/payment-start): restaurant_id, rail ('card' |
--                          'whish'), provider (an adapter name in the function: 'fake',
--                          'whish', later the card gateway), config (what the adapter needs
--                          that is not secret, e.g. a merchant id), secret_name (the name of
--                          a Supabase Vault secret holding the venue's own credentials; the
--                          secret itself is never in this table), enabled. One row per
--                          (venue, rail). Closed to anon and authenticated; the service role
--                          reads it. Rows are added in the SQL editor when a venue's provider
--                          account is set up (see supabase/README.md, "Hosted payment pages").
--                          A venue with no row for a rail and demo payments on in admin.html
--                          gets the fake provider for that rail while FAKE_WEBHOOK_SECRET is
--                          set; a venue with demo payments off and no row offers cash only.
--   payment_sessions       one row each time a guest is handed to a provider's page:
--                          restaurant_id, payment_id, provider, rail, provider_ref (the
--                          provider's id for the session, when it gives one), amount_cents,
--                          currency, return_url, created_at. Append only (the service role
--                          inserts and reads, never changes or deletes). With
--                          payment_callbacks it is the trail for reconciliation: a session
--                          without a callback is a guest who left the provider's page.
--   aal_payment_provider(p_rid, p_rail)
--                          for the function: the enabled provider row for that rail with its
--                          Vault secret decrypted into "secret" (null when secret_name is null
--                          or names no secret), or null when the venue has no row. Service
--                          role only. The only place the secret leaves Vault; the function
--                          keeps it in memory for the one provider call.
begin;
do $$ begin
 if to_regclass('public.payment_callbacks') is null or to_regprocedure('public.aal_payment_failed(text,text,text)') is null then
  raise exception 'Run payments-2026-09-30.sql before payment-start-2026-10-14.sql';
 end if;
 if to_regclass('public.venue_profiles') is null or to_regclass('public.check_keys') is null or to_regclass('public.payment_secrets') is null then
  raise exception 'Run migration.sql, hardening-2026-09-15.sql and admin.sql before payment-start-2026-10-14.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Which provider takes each rail at a venue
-- ---------------------------------------------------------------------------
create table if not exists public.payment_providers (
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  rail          text not null check (rail in ('card', 'whish')),
  provider      text not null check (provider ~ '^[a-z][a-z0-9_]{0,39}$'),
  config        jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  secret_name   text check (secret_name is null or secret_name ~ '^[A-Za-z0-9_.-]{1,120}$'),
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (restaurant_id, rail)
);
alter table public.payment_providers enable row level security;   -- no policies: closed
revoke all on public.payment_providers from public, anon, authenticated;
revoke all on public.payment_providers from service_role;
grant select on public.payment_providers to service_role;

drop trigger if exists payment_providers_touch on public.payment_providers;
create trigger payment_providers_touch before update on public.payment_providers
  for each row execute function public.aal_touch();

-- ---------------------------------------------------------------------------
-- Every handoff to a provider's page
-- ---------------------------------------------------------------------------
create table if not exists public.payment_sessions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null,
  payment_id    text not null,
  provider      text not null,
  rail          text not null,
  provider_ref  text,
  amount_cents  bigint not null,
  currency      text not null,
  return_url    text,
  created_at    timestamptz not null default now()
);
create index if not exists payment_sessions_payment on public.payment_sessions (restaurant_id, payment_id, created_at);
alter table public.payment_sessions enable row level security;   -- no policies: closed
revoke all on public.payment_sessions from public, anon, authenticated;
revoke update, delete, truncate on public.payment_sessions from service_role;
grant select, insert on public.payment_sessions to service_role;

-- ---------------------------------------------------------------------------
-- The provider for a rail, with its credentials out of Vault
-- ---------------------------------------------------------------------------
create or replace function public.aal_payment_provider(p_rid text, p_rail text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
 r public.payment_providers%rowtype; s text;
begin
 if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
  raise exception 'Verified provider callback required';
 end if;
 select * into r from public.payment_providers where restaurant_id = p_rid and rail = p_rail and enabled;
 if not found then return null; end if;
 if r.secret_name is not null and to_regclass('vault.decrypted_secrets') is not null then
  select decrypted_secret into s from vault.decrypted_secrets where name = r.secret_name limit 1;
 end if;
 return jsonb_build_object('provider', r.provider, 'rail', r.rail, 'config', r.config, 'secret', s);
end $$;
revoke all on function public.aal_payment_provider(text, text) from public, anon, authenticated;
grant execute on function public.aal_payment_provider(text, text) to service_role;
commit;
