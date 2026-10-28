-- The language and currency of a venue's morning close narrative (T4), 2026-10-28.
--
-- Run after admin.sql, in the Supabase SQL editor. Safe to re-run: one transaction, "add column
-- if not exists", the check constraints are dropped and added again. It stops without changing
-- anything if admin.sql has not been applied. No data changes: every venue reads in English and
-- in dollars until its row says otherwise.
--
-- What changes
--   venue_profiles.lang      NEW, text: null or 'en' English, 'fr' French, 'ar' Arabic. The
--                            language of the narrative at the top of the daily close email.
--   venue_profiles.currency  NEW, text: null or 'USD' dollars, 'LBP' lira first (at the rate on
--                            file, aal.rate) with dollars in brackets, for the day's takings.
-- daily-close reads venue_profiles with select=*, so it works before and after this file.
-- Setting them, until the admin page has a field:
--   update public.venue_profiles set lang = 'ar', currency = 'LBP' where slug = '<slug>';

begin;
do $$ begin
 if to_regclass('public.venue_profiles') is null then
  raise exception 'Run admin.sql before close-narrative-2026-10-28.sql';
 end if;
end $$;

alter table public.venue_profiles add column if not exists lang text;
alter table public.venue_profiles drop constraint if exists venue_profiles_lang;
alter table public.venue_profiles add constraint venue_profiles_lang check (lang is null or lang in ('en', 'fr', 'ar'));
alter table public.venue_profiles add column if not exists currency text;
alter table public.venue_profiles drop constraint if exists venue_profiles_currency;
alter table public.venue_profiles add constraint venue_profiles_currency check (currency is null or currency in ('USD', 'LBP'));
commit;
