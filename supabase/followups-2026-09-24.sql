-- Pilot-blocking follow-ups (T8), 2026-09-24.
--
-- Run after auth-2026-09-24.sql, in the Supabase SQL editor.
-- UNTESTED: written for Postgres 15, not yet run against the live project or any
-- PostgreSQL here (tests/followups.test.cjs has an optional PGlite block, skipped
-- unless PGLITE_MODULE is set, as for the other SQL files).
--
-- aal_mutate is NOT replaced, and no trigger is added: the grace period below lives in
-- aal_check_scope and the clean-up in aal_table_session, so the three full copies of
-- aal_mutate made today stay the only ones and re-running auth-2026-09-24.sql does not
-- undo any of this.
--
-- Safe to re-run: one transaction; "create or replace function", "create index if not
-- exists", "drop trigger/function if exists" (an earlier draft of this file used a
-- trigger; it is removed if present), "drop policy if exists" + "create policy", grant
-- and revoke. The only data change is deleting check_keys rows whose check closed more
-- than 24 hours ago or no longer exists, which are dead under the new rule anyway; a
-- second run finds none that were not already due. It stops without changing anything
-- if auth-2026-09-24.sql (and so sessions, hardening and admin) has not been applied.
--
-- What changes
--   aal_check_scope(rid)  REPLACED, same signature. A chk_ key resolves to its check
--                         while the check is open, and for 24 hours after its closedAt
--                         (the grace period: staff close a bill seconds after the last
--                         payment and guests ask for the emailed receipt after that).
--                         Afterwards, or if the check no longer exists, it gives null,
--                         and every guest read (aal_snapshot, docs_read) and write
--                         (aal_mutate) with that key is refused.
--                         During the grace period a guest can read the closed bill
--                         (aal_snapshot) and use receipt and cancel. Nothing else changes
--                         in aal_mutate: reserve already refuses a closed bill ("Bill
--                         closed or unavailable"), update_check refuses it, issue_key
--                         refuses it, open_check is staff only. Client events (event op,
--                         analytics only) are still accepted in the window.
--   check_keys_check      NEW index on check_keys (restaurant_id, check_id), for the
--                         reuse lookup and the clean-up below.
--   aal_table_session(p_slug, p_table, p_token)   REPLACED (sessions-2026-09-24.sql's
--                         text; only the lines marked "-- T8" changed).
--                         * Clean-up: once the table code is verified, it deletes this
--                           venue's keys whose check closed more than 24 hours ago (or is
--                           gone): one delete, under the venue lock, so no scheduler is
--                           needed. It runs after the code check rather than on the very
--                           first line so an unauthenticated caller cannot make it write.
--                         * Reuse: with an open bill it returns the newest chk_ key already
--                           issued for that check (by a scan or a staff "Guest bill link")
--                           and mints one only when none exists, so check_keys no longer
--                           grows by one row per scan.
--   docs_write policy on kv_docs   REPLACED. Unchanged for the owner (the owner key,
--                         or a signed-in owner or manager). New: a signed-in waiter may
--                         write the floor document (aal.floor: which server has which
--                         table, the table layout, pooled tips) as a JSON object under
--                         64 kB, and nothing else. Table-to-server assignment is low
--                         risk and waiters were already editing it on the dashboard,
--                         where it never reached the server. aal_snapshot already
--                         returns aal.floor to a waiter (auth-2026-09-24.sql).
--   One-off: check_keys rows of checks closed more than 24 hours ago, or missing, are
--   deleted (the same rule as the clean-up).
--
-- Re-running an older file undoes part of this one: hardening-2026-09-15.sql restores
-- the old aal_check_scope (keys that never expire); sessions-2026-09-24.sql restores the
-- minting aal_table_session without clean-up; migration.sql and rebuild-2026-09-24.sql
-- restore the owner-only docs_write. Run this file again after any of them.

begin;
do $$ begin
 if to_regclass('public.staff_members') is null or to_regprocedure('public.aal_staff(text,jsonb)') is null
    or to_regprocedure('public.aal_staff_role(text)') is null then
  raise exception 'Run auth-2026-09-24.sql before followups-2026-09-24.sql';
 end if;
 if to_regclass('public.check_keys') is null or to_regprocedure('public.aal_table_session(text,integer,text)') is null then
  raise exception 'Run hardening-2026-09-15.sql and sessions-2026-09-24.sql before followups-2026-09-24.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A bill key resolves while its bill is open, and for 24 hours after it closes
-- ---------------------------------------------------------------------------
create or replace function public.aal_check_scope(rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select c.check_id from public.check_keys c
   join public.kv_rows r on r.restaurant_id = c.restaurant_id and r.collection = 'aal.checks' and r.id = c.check_id
  where c.restaurant_id = rid and c.key = public.aal_key() and public.aal_key() <> ''
    and (r.body->>'closedAt' is null or (r.body->>'closedAt')::timestamptz > now() - interval '24 hours')
  limit 1
$$;
revoke all on function public.aal_check_scope(text) from public;
grant execute on function public.aal_check_scope(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Keys of bills closed more than 24 hours ago: no trigger, a clean-up
-- ---------------------------------------------------------------------------
-- an earlier draft of this file deleted keys at the moment of close; remove it if present
drop trigger if exists kv_rows_close_keys on public.kv_rows;
drop function if exists public.aal_forget_check_keys();

create index if not exists check_keys_check on public.check_keys (restaurant_id, check_id);

-- one-off: keys that are already dead under the 24-hour rule
delete from public.check_keys c
 where not exists (select 1 from public.kv_rows r
                    where r.restaurant_id = c.restaurant_id and r.collection = 'aal.checks' and r.id = c.check_id
                      and (r.body->>'closedAt' is null or (r.body->>'closedAt')::timestamptz > now() - interval '24 hours'));

-- ---------------------------------------------------------------------------
-- 3. A table scan reuses the open bill's newest key (sessions-2026-09-24.sql's text;
--    only the lines marked "-- T8" changed); it also clears the venue's dead keys
-- ---------------------------------------------------------------------------
create or replace function public.aal_table_session(p_slug text, p_table int, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  vp  public.venue_profiles;
  cid text;
  k   text;
  ds  jsonb;
begin
  select * into vp from public.venue_profiles p where p.slug = p_slug;
  -- one message for an unknown slug, a wrong code and a revoked code
  if not found or p_table is null or coalesce(p_token, '') = '' or not exists (
       select 1 from public.table_tokens t
        where t.restaurant_id = vp.restaurant_id and t.table_no = p_table
          and t.token = p_token and t.revoked_at is null) then
    raise exception 'This table code is not active. Ask your server for the bill.';
  end if;
  -- read the open bill under the venue lock, so a bill being opened is seen whole
  perform pg_advisory_xact_lock(hashtextextended(vp.restaurant_id, 0));
  -- T8: clean-up, no scheduler needed: this venue's keys whose check closed more than 24 hours ago, or is gone
  delete from public.check_keys c -- T8
   where c.restaurant_id = vp.restaurant_id and not exists (select 1 from public.kv_rows r -- T8
          where r.restaurant_id = c.restaurant_id and r.collection = 'aal.checks' and r.id = c.check_id -- T8
            and (r.body->>'closedAt' is null or (r.body->>'closedAt')::timestamptz > now() - interval '24 hours')); -- T8
  select r.id into cid from public.kv_rows r
   where r.restaurant_id = vp.restaurant_id and r.collection = 'aal.checks'
     and coalesce(r.body->>'venueId', r.body->>'restaurantId') = r.restaurant_id
     and r.body->>'table' = p_table::text and r.body->>'closedAt' is null
   order by r.body->>'openedAt' desc nulls last limit 1;
  if cid is not null then
    -- T8: the newest key already issued for this open bill
    select c.key into k from public.check_keys c -- T8
     where c.restaurant_id = vp.restaurant_id and c.check_id = cid -- T8
     order by c.created_at desc, c.key limit 1; -- T8
    if k is null then -- T8
      -- minted exactly as aal_mutate issue_key
      k := 'chk_' || encode(gen_random_bytes(24), 'hex');
      insert into public.check_keys (key, restaurant_id, check_id) values (k, vp.restaurant_id, cid);
    end if; -- T8
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', d.key, 'body', d.body, 'updated_at', d.updated_at)), '[]'::jsonb) into ds
    from public.kv_docs d where d.restaurant_id = vp.restaurant_id and d.key in ('aal.live', 'aal.rate', 'aal.rate_meta');
  return jsonb_build_object(
    'restaurant_id', vp.restaurant_id,
    'venue', jsonb_build_object('name', vp.name, 'place', vp.place, 'gplace', vp.gplace, 'brand', vp.brand,
                                'bg', vp.bg, 'font', vp.font, 'menu_pack', vp.menu_pack),
    'table', p_table,
    'checkId', cid,
    'key', k,
    'docs', ds);
end $$;
revoke all on function public.aal_table_session(text, int, text) from public;
grant execute on function public.aal_table_session(text, int, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Waiters may write the floor document, and only that document
-- ---------------------------------------------------------------------------
drop policy if exists docs_write on public.kv_docs;
create policy docs_write on public.kv_docs for all
  using (public.aal_role(restaurant_id) = 'owner'
         or (public.aal_role(restaurant_id) = 'waiter' and key = 'aal.floor'))
  with check (public.aal_role(restaurant_id) = 'owner'
              or (public.aal_role(restaurant_id) = 'waiter' and key = 'aal.floor'
                  and jsonb_typeof(body) = 'object' and pg_column_size(body) < 65536));
commit;
