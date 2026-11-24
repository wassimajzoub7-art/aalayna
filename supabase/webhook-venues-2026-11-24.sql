-- Per-venue webhook secrets, 2026-11-24.
--
-- Run after payment-start-2026-10-14.sql (and every file before it), in the Supabase SQL
-- editor; in the full order it comes after review-fixes-2026-11-10.sql. Tested against PGlite
-- (tests/webhook-venues-sql.test.cjs with PGLITE_MODULE set); not yet run against the live
-- project.
--
-- Why: a card gateway (areeba, on the Mastercard Payment Gateway) gives each merchant, so each
-- venue, its own notification secret. payment-webhook used to check every callback against one
-- project-wide secret before it knew the venue. A provider whose adapter says
-- secretScope: 'venue' is now called at
--   POST /functions/v1/payment-webhook/<provider>/<webhook_route>
-- and the route names the payment_providers row, so the function can take that venue's secret
-- out of Vault before it checks the signature (supabase/functions/payment-webhook/handler.js).
--
-- Safe to re-run: one transaction; "add column if not exists", "alter column set default",
-- an update that fills only rows without a route (none on a second run), "create unique index
-- if not exists", a check constraint added only when missing, "create or replace function",
-- grants and revokes. No existing function is replaced; aal_payment_provider, payment-start's
-- lookup, is not touched. An existing row keeps its route on a second run. It stops without
-- changing anything if payment-start-2026-10-14.sql has not been applied.
--
-- What it adds
--   payment_providers.webhook_route
--                          an opaque token per (venue, rail) row: 'whk_' and 32 random hex
--                          digits (from gen_random_uuid(), built into PostgreSQL 13 and up),
--                          set by default on insert, filled in for every existing row, unique,
--                          not null. It is an address, not a credential: the signature with
--                          the venue's own secret is what authenticates a callback; the route
--                          only says which secret to check it with, without putting the venue
--                          id in a URL. The provider's dashboard is given
--                          https://<project>.supabase.co/functions/v1/payment-webhook/<provider>/<webhook_route>
--                          To move a venue to a new address (e.g. a route that leaked into a
--                          ticket): update payment_providers set webhook_route = default
--                          where restaurant_id = ... and rail = ...; then give the provider the
--                          new URL. Unused by project-scoped providers (fake, whish).
--   aal_payment_provider_by_route(p_provider, p_route)
--                          for payment-webhook: the enabled row with that provider and route,
--                          as {restaurant_id, rail, provider, config, secret}, the Vault secret
--                          decrypted into "secret" (null when secret_name is null, names no
--                          secret, or Vault is not installed), or null when there is no such
--                          enabled row. Service role only. Like aal_payment_provider, the
--                          function keeps the secret in memory for the one callback.
begin;
do $$ begin
 if to_regclass('public.payment_providers') is null or to_regprocedure('public.aal_payment_provider(text,text)') is null then
  raise exception 'Run payment-start-2026-10-14.sql before webhook-venues-2026-11-24.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- An address per provider row
-- ---------------------------------------------------------------------------
alter table public.payment_providers add column if not exists webhook_route text;
alter table public.payment_providers alter column webhook_route
  set default 'whk_' || replace(gen_random_uuid()::text, '-', '');
update public.payment_providers set webhook_route = default where webhook_route is null;
alter table public.payment_providers alter column webhook_route set not null;
create unique index if not exists payment_providers_webhook_route on public.payment_providers (webhook_route);
do $$ begin
 if not exists (select 1 from pg_constraint
                 where conrelid = 'public.payment_providers'::regclass and conname = 'payment_providers_webhook_route_format') then
  alter table public.payment_providers add constraint payment_providers_webhook_route_format
   check (webhook_route ~ '^[A-Za-z0-9_-]{16,100}$');
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- The row a callback's address names, with its credentials out of Vault
-- ---------------------------------------------------------------------------
create or replace function public.aal_payment_provider_by_route(p_provider text, p_route text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
 r public.payment_providers%rowtype; s text;
begin
 if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
  raise exception 'Verified provider callback required';
 end if;
 select * into r from public.payment_providers where provider = p_provider and webhook_route = p_route and enabled;
 if not found then return null; end if;
 if r.secret_name is not null and to_regclass('vault.decrypted_secrets') is not null then
  select decrypted_secret into s from vault.decrypted_secrets where name = r.secret_name limit 1;
 end if;
 return jsonb_build_object('restaurant_id', r.restaurant_id, 'rail', r.rail, 'provider', r.provider, 'config', r.config, 'secret', s);
end $$;
revoke all on function public.aal_payment_provider_by_route(text, text) from public, anon, authenticated;
grant execute on function public.aal_payment_provider_by_route(text, text) to service_role;
commit;
