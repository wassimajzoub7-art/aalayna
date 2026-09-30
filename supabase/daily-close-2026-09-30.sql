-- Daily close email log and schedule (T15), 2026-09-30.
--
-- Run after auth-2026-09-24.sql, in the Supabase SQL editor. Deploy the Edge Function
-- daily-close first (supabase/README.md, "Daily close email"); this file only creates the
-- log table and the two schedules that call it.
-- UNTESTED: written for Postgres 17, not yet run against the live project or any PostgreSQL here.
--
-- Safe to re-run: one transaction; "create table/index if not exists", grants, and
-- cron.schedule (which replaces a job of the same name). No existing row, table or policy
-- is changed. It stops without changing anything if the venue or staff tables are missing.
--
-- What it adds
--   daily_close_log   one row per venue per business day: recipients, status sent | skipped |
--                     failed, provider_id (Resend ids, comma separated), error, created_at.
--                     The unique index on (restaurant_id, day) is what makes a rerun answer
--                     "already sent" instead of sending twice. While a send is running its row
--                     reads status 'failed', error 'in progress'; a call that finds such a row
--                     younger than ten minutes leaves it alone. Closed to anon and
--                     authenticated (RLS on, no policies); only the service role reads it.
--   two pg_cron jobs  daily-close-0100-utc-or-retry and daily-close-0200-utc-or-retry, at 01:00 and
--                     02:00 UTC, each an HTTP POST through pg_net to the function with the header
--                     X-Aalayna-Cron. Beirut is UTC+3 in summer and UTC+2 in winter, so 04:00
--                     Beirut is 01:00 UTC in summer and 02:00 UTC in winter: whichever of the two
--                     is 04:00 in Beirut sends, the other is the retry. Each call closes, for every
--                     venue, the latest finished business day that has no row with status sent, so
--                     the call at the other hour finds the sent row and does nothing, and a send
--                     that failed or was missed is retried at the next hour with no one touching
--                     it. The function never looks at the clock hour, so the schedule never needs
--                     editing when the clocks change. A venue whose day had no bills and no
--                     payments is logged skipped ('no activity') and not emailed.
--                     Jobs an earlier version of this file created under the names
--                     daily-close-0100-utc and daily-close-0200-utc are unscheduled.
--
-- The secret. The header value is AALAYNA_CRON_SECRET, which is never written in this file.
-- Store it once in Supabase Vault (Project Settings, Vault, or in this editor):
--     select vault.create_secret('<the same value as the function secret>', 'aalayna_cron_secret');
-- The jobs read it from vault.decrypted_secrets each time they run. To rotate it, update the
-- Vault secret and the function secret together.
--
-- If pg_cron, pg_net or Vault is missing and cannot be enabled here, the migration still
-- succeeds: the table is created, no job is scheduled, and a NOTICE says what was skipped.
-- Enable the extension in Database, Extensions, then run this file again.

begin;
set local search_path = public, extensions, pg_temp;

do $$
begin
  if to_regclass('public.venue_keys') is null or to_regclass('public.venue_profiles') is null
     or to_regclass('public.staff_members') is null then
    raise exception 'Run admin.sql and auth-2026-09-24.sql before daily-close-2026-09-30.sql';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------------------
create table if not exists public.daily_close_log (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  day           date not null,                       -- the business day: 04:00 that day to 04:00 the next, Beirut time
  recipients    int  not null default 0 check (recipients >= 0),
  status        text not null check (status in ('sent', 'skipped', 'failed')),
  provider_id   text,
  error         text,
  created_at    timestamptz not null default now()
);
create unique index if not exists daily_close_log_venue_day on public.daily_close_log (restaurant_id, day);

alter table public.daily_close_log enable row level security;   -- no policies: closed
revoke all on public.daily_close_log from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.daily_close_log to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
do $$
declare
  cmd text;
  hour_utc int;
  old_name text;
begin
  -- Try to enable what is missing; a project that does not allow it just gets a notice.
  begin
    if not exists (select 1 from pg_extension where extname = 'pg_cron') then create extension pg_cron; end if;
  exception when others then
    raise notice 'daily-close: pg_cron is not available (%). No schedule created.', sqlerrm;
  end;
  begin
    if not exists (select 1 from pg_extension where extname = 'pg_net') then create extension pg_net with schema extensions; end if;
  exception when others then
    raise notice 'daily-close: pg_net is not available (%). No schedule created.', sqlerrm;
  end;

  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'daily-close: pg_cron is missing; the log table exists but nothing is scheduled. Enable pg_cron and run this file again.';
    return;
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'daily-close: pg_net is missing (or net.http_post has another signature); the log table exists but nothing is scheduled. Enable pg_net and run this file again.';
    return;
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice 'daily-close: Supabase Vault is missing, so the cron secret has nowhere to live; nothing is scheduled. Enable Vault and run this file again.';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'aalayna_cron_secret') then
    raise notice 'daily-close: no Vault secret named aalayna_cron_secret yet. The jobs are scheduled but will be refused (401) until you run: select vault.create_secret(''<value>'', ''aalayna_cron_secret'');';
  end if;

  cmd := $job$
    select net.http_post(
      url := 'https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/daily-close',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Aalayna-Cron', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'aalayna_cron_secret' limit 1), '')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000)
  $job$;

  -- the first version of this file used these names; leave no second pair of jobs behind
  if to_regclass('cron.job') is not null then
    for old_name in select jobname from cron.job where jobname in ('daily-close-0100-utc', 'daily-close-0200-utc') loop
      perform cron.unschedule(old_name);
    end loop;
  end if;
  foreach hour_utc in array array[1, 2] loop
    perform cron.schedule(format('daily-close-%s00-utc-or-retry', lpad(hour_utc::text, 2, '0')), format('0 %s * * *', hour_utc), cmd);
  end loop;
end $$;

commit;
