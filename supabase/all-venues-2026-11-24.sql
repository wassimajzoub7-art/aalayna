-- All venues in shared mode: one read of every venue a signed-in owner runs, 2026-11-24.
--
-- Run after groups-2026-10-28.sql (and after close-narrative-2026-10-28.sql and
-- review-fixes-2026-11-10.sql where they are installed), in the Supabase SQL editor.
--
-- Safe to re-run: one transaction, "create or replace function", and grant/revoke statements
-- only. No table, row, policy or existing function is changed. It stops without changing anything
-- if groups-2026-10-28.sql has not been applied.
--
-- Why
--   The dashboard's All venues view (owner-group.js, owner-metrics.js A.groupReport, A.groupLive,
--   A.groupRatings) sums each venue's figures, each computed by the same code as that venue's own
--   dashboard. In the demo the records are on the device. In shared mode a page holds one venue's
--   credential scope, so the other venues' records come from here: one call, read only, and only
--   for venues where the caller is an owner today. The figures are still computed in the browser,
--   by the same code, so a venue's numbers are the same in its own dashboard and in All venues.
--
-- aal_all_venues()  NEW. For the caller (a signed-in session, or the x-aalayna-key owner key):
--   candidates  the venues of the caller's live staff_members rows, of the groups whose live
--               owner_group_staff rows are theirs, of the venue whose owner key they send, and of
--               the group whose owner key they send.
--   kept        only those where aal_role(restaurant_id) = 'owner', the rule every policy, snapshot
--               and change already follows: a venue's owner or manager, a group owner or manager at
--               a venue of the group, the venue's owner key, the group's owner key. A waiter's venue
--               is never in the list (a waiter has no All venues), nor any venue the caller is not
--               on the staff of today: a revoked row, or a venue removed from the group, is out at once.
--   returns     {version: 1, venues: [{restaurant_id, name, place, slug, group_id, group_name,
--               rows: [{collection, id, body, updated_at}], docs: [{key, body, updated_at}]}]}.
--               At most 50 venues, in name order.
--   rows        only what the All venues figures read, under aal_snapshot's own row rule (the
--               row's venueId or restaurantId is the venue's id), and less of each row:
--                 aal.checks  as they are (table, lines, totals, opened and closed times);
--                 aal.settle  without deviceId, sessionId, payerRef, externalRef, identityId;
--                 aal.guests  only id, venueId, venue, receipt, marketing, createdAt and
--                             consentHistory: no contact, channel, device or identity, so no
--                             guest list leaves its venue through this view;
--                 aal.events  only review_submitted events, with eventId, eventType, restaurantId,
--                             venueId, createdAt and the rating alone.
--   docs        aal.floor (who serves tonight), nothing else.
--   It is STABLE: it cannot write, and nothing here gives a client a new way to write.
--
-- Raises 42501 "Sign in ..." when the request carries neither a session nor a key. A caller with
-- a credential but no venue as owner gets {version: 1, venues: []}.

begin;
set local search_path = public, extensions, pg_temp;

do $$ begin
 if to_regclass('public.owner_group_venues') is null or to_regclass('public.owner_group_staff') is null
    or to_regprocedure('public.aal_group(jsonb)') is null or to_regprocedure('public.aal_role(text)') is null
    or to_regprocedure('public.aal_staff_email()') is null then
  raise exception 'Run groups-2026-10-28.sql before all-venues-2026-11-24.sql';
 end if;
end $$;

-- the keys of a JSON object that are in p_keys; anything that is not an object reads as {}
create or replace function public.aal_all_venues_keep(p_body jsonb, p_keys text[]) returns jsonb
language sql immutable set search_path = public, extensions, pg_temp as $$
  select case when jsonb_typeof(p_body) = 'object' then coalesce(
    (select jsonb_object_agg(e.key, e.value) from jsonb_each(p_body) e where e.key = any (p_keys)), '{}'::jsonb)
    else '{}'::jsonb end
$$;

-- one venue's rows for the All venues figures (see the header); the caller has checked aal_role
create or replace function public.aal_all_venues_rows(p_rid text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('collection', r.collection, 'id', r.id, 'updated_at', r.updated_at, 'body',
    case r.collection
      when 'aal.checks' then r.body
      when 'aal.settle' then r.body - array['deviceId', 'sessionId', 'payerRef', 'externalRef', 'identityId']
      when 'aal.guests' then public.aal_all_venues_keep(r.body, array['id', 'venueId', 'venue', 'receipt', 'marketing', 'createdAt', 'consentHistory'])
      else public.aal_all_venues_keep(r.body, array['eventId', 'eventType', 'restaurantId', 'venueId', 'createdAt'])
           || jsonb_build_object('payload', public.aal_all_venues_keep(r.body -> 'payload', array['rating']))
    end) order by r.collection, r.id), '[]'::jsonb)
    from public.kv_rows r
   where r.restaurant_id = p_rid
     and coalesce(r.body ->> 'venueId', r.body ->> 'restaurantId') = r.restaurant_id
     and (r.collection in ('aal.checks', 'aal.settle', 'aal.guests')
          or (r.collection = 'aal.events' and r.body ->> 'eventType' = 'review_submitted'))
$$;

create or replace function public.aal_all_venues() returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
  v_me  text := public.aal_staff_email();
  v_key text := public.aal_key();
  v_out jsonb;
begin
  if v_me = '' and v_key = '' then
    raise exception 'Sign in with your email or open your owner link first.' using errcode = '42501';
  end if;
  with cand as (
    select s.restaurant_id from public.staff_members s
     where v_me <> '' and s.email = v_me and s.revoked_at is null
    union
    select gv.restaurant_id from public.owner_group_staff gs
      join public.owner_group_venues gv on gv.group_id = gs.group_id
     where v_me <> '' and gs.email = v_me and gs.revoked_at is null
    union
    select vk.restaurant_id from public.venue_keys vk
     where v_key <> '' and vk.owner_key = v_key
    union
    select gv.restaurant_id from public.owner_groups g
      join public.owner_group_venues gv on gv.group_id = g.id
     where v_key <> '' and g.owner_key = v_key
  ), mine as (
    -- the one rule: owner rights at the venue today (aal_role, groups-2026-10-28.sql)
    select c.restaurant_id from cand c where public.aal_role(c.restaurant_id) = 'owner'
  ), named as (
    select m.restaurant_id, coalesce(vp.name, vk.name) as name, vp.place, vp.slug, gv.group_id, og.name as group_name
      from mine m
      join public.venue_keys vk on vk.restaurant_id = m.restaurant_id
      left join public.venue_profiles vp on vp.restaurant_id = m.restaurant_id
      left join public.owner_group_venues gv on gv.restaurant_id = m.restaurant_id
      left join public.owner_groups og on og.id = gv.group_id
     order by lower(coalesce(vp.name, vk.name, m.restaurant_id)), lower(coalesce(vp.place, '')), m.restaurant_id
     limit 50
  )
  select coalesce(jsonb_agg(jsonb_build_object('restaurant_id', n.restaurant_id, 'name', n.name, 'place', n.place, 'slug', n.slug,
                                               'group_id', n.group_id, 'group_name', n.group_name,
                                               'rows', public.aal_all_venues_rows(n.restaurant_id),
                                               'docs', coalesce((select jsonb_agg(jsonb_build_object('key', d.key, 'body', d.body, 'updated_at', d.updated_at))
                                                                   from public.kv_docs d where d.restaurant_id = n.restaurant_id and d.key = 'aal.floor'), '[]'::jsonb))
                            order by lower(coalesce(n.name, n.restaurant_id)), lower(coalesce(n.place, '')), n.restaurant_id), '[]'::jsonb)
    into v_out from named n;
  return jsonb_build_object('version', 1, 'venues', v_out);
end $$;

-- Privileges. The helpers run only inside aal_all_venues.
revoke all on function public.aal_all_venues_keep(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.aal_all_venues_rows(text) from public, anon, authenticated;
revoke all on function public.aal_all_venues() from public;
grant execute on function public.aal_all_venues() to anon, authenticated;
commit;
