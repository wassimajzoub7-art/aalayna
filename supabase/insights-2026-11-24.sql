-- Insights in shared mode: one venue's events for a period, read on demand, 2026-11-24.
--
-- Run after review-fixes-2026-11-10.sql (and after all-venues-2026-11-24.sql where it is
-- installed), in the Supabase SQL editor. It needs groups-2026-10-28.sql's aal_role.
--
-- Safe to re-run: one transaction, "create or replace function", "create index if not exists"
-- and grant/revoke statements only. No table, row, policy or existing function is changed. It
-- stops without changing anything if aal_role is missing.
--
-- Why
--   The owner dashboard's Insights tab (owner-insights.js) needs a month or more of a venue's
--   events. aal_snapshot sends the whole history and the page keeps it in localStorage (about
--   5 MB, ten thousand events), where a full store cuts every event log to its last 200 rows; a
--   busy venue (100 sessions a day, about 30,000 events a month) never holds its month. The tab
--   asks this function for the period it shows and keeps the answer in memory only.
--
-- aal_insights_events(p_rid text, p_body jsonb)  NEW, STABLE, security definer. Read only.
--   who        aal_role(p_rid) = 'owner', the rule every owner read follows: the venue's owner or
--              manager signed in, the venue's owner key, a group owner or manager (or the group
--              key) at a venue of the group. Anyone else (a waiter, a guest key, another venue's
--              owner, nobody) gets 42501 "Only the venue's owner ...".
--   p_body     {"since": ISO time, "until": ISO time}. until defaults to now and is never later
--              than now; since defaults to 30 days before until and is moved to 90 days before
--              until when it asks for more (the answer says "clamped": true).
--   rows       the venue's aal.events rows (aal_snapshot's rule: the row's restaurantId or venueId
--              is the venue) of the types Insights reads, created in [since, until): qr_scan,
--              item_view, ui_action, bill_requested, order_placed, payment_completed. Each row is
--              narrowed to what owner-insights.js reads:
--                eventId, eventType, createdAt, sessionId, deviceId, tableId, restaurantId, and in
--                payload: itemId, categoryId, action, value, n, orderId, revision, items (each line
--                reduced to itemId and qty), paymentId, rail, method, amount, amountUsd, currency, tip.
--              Never customerId, the user agent, payerRef, externalRef, or any guest contact.
--   cap        at most 40,000 rows (about 8 MB of JSON), the newest kept: with "truncated": true the
--              period's oldest part is missing and "from" says where the answer starts.
--   returns    {version: 1, since, until, clamped, limit, truncated, from, count,
--               firstEventAt   the venue's first recorded event of any date (days collected),
--               deviceFirstSeen {deviceId: first time this phone was seen at the venue}, for the
--                              phones in the answer (returning phones; deviceId is the random
--                              per-browser id the owner snapshot already carries),
--               events: [...] oldest first}.
--
-- Index: kv_rows_events_created on kv_rows (restaurant_id, (body->>'createdAt')) where
-- collection = 'aal.events'. createdAt is the server's stamp (YYYY-MM-DDTHH24:MI:SS.MSZ), so text
-- order is time order and the bounds are written in the same form.

begin;
set local search_path = public, extensions, pg_temp;

do $$ begin
 if to_regprocedure('public.aal_role(text)') is null or to_regclass('public.kv_rows') is null then
  raise exception 'Run auth-2026-09-24.sql and groups-2026-10-28.sql before insights-2026-11-24.sql';
 end if;
end $$;

create index if not exists kv_rows_events_created on public.kv_rows (restaurant_id, (body->>'createdAt')) where collection = 'aal.events';

-- the keys of a JSON object that are in p_keys; anything that is not an object reads as {}
create or replace function public.aal_insights_keep(p_body jsonb, p_keys text[]) returns jsonb
language sql immutable set search_path = public, extensions, pg_temp as $$
  select case when jsonb_typeof(p_body) = 'object' then coalesce(
    (select jsonb_object_agg(e.key, e.value) from jsonb_each(p_body) e where e.key = any (p_keys)), '{}'::jsonb)
    else '{}'::jsonb end
$$;

-- one event as Insights reads it (see the header)
create or replace function public.aal_insights_row(p_body jsonb) returns jsonb
language sql immutable set search_path = public, extensions, pg_temp as $$
  select public.aal_insights_keep(p_body, array['eventId', 'eventType', 'createdAt', 'sessionId', 'deviceId', 'tableId', 'restaurantId'])
    || jsonb_build_object('payload',
         public.aal_insights_keep(p_body->'payload', array['itemId', 'categoryId', 'action', 'value', 'n', 'orderId', 'revision',
                                                          'paymentId', 'rail', 'method', 'amount', 'amountUsd', 'currency', 'tip'])
         || case when jsonb_typeof(p_body->'payload'->'items') = 'array' then jsonb_build_object('items',
              (select coalesce(jsonb_agg(public.aal_insights_keep(i, array['itemId', 'qty']) order by k), '[]'::jsonb)
                 from jsonb_array_elements(p_body->'payload'->'items') with ordinality t(i, k)))
            else '{}'::jsonb end)
$$;

create or replace function public.aal_insights_events(p_rid text, p_body jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
  v_body  jsonb := coalesce(p_body, '{}'::jsonb);
  v_limit int := 40000;
  v_until timestamptz;
  v_since timestamptz;
  v_clamped boolean := false;
  v_lo text; v_hi text;
  v_rows jsonb; v_count int; v_total int; v_first text; v_devices jsonb;
  fmt constant text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
begin
  if coalesce(public.aal_role(p_rid), '') <> 'owner' then
    raise exception 'Only the venue''s owner or a manager can read its insights.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_body) <> 'object' then raise exception 'Insights request must be a JSON object.'; end if;
  begin
    v_until := least(coalesce((v_body->>'until')::timestamptz, now()), now());
    v_since := coalesce((v_body->>'since')::timestamptz, v_until - interval '30 days');
  exception when others then
    raise exception 'since and until must be ISO times.' using errcode = '22007';
  end;
  if v_since < v_until - interval '90 days' then v_since := v_until - interval '90 days'; v_clamped := true; end if;
  if v_since > v_until then v_since := v_until; end if;
  v_lo := to_char(v_since at time zone 'UTC', fmt);
  v_hi := to_char(v_until at time zone 'UTC', fmt);

  with win as (
    select r.body
      from public.kv_rows r
     where r.restaurant_id = p_rid and r.collection = 'aal.events'
       and (r.body->>'createdAt') >= v_lo and (r.body->>'createdAt') < v_hi
       and coalesce(r.body->>'venueId', r.body->>'restaurantId') = r.restaurant_id
       and r.body->>'eventType' in ('qr_scan', 'item_view', 'ui_action', 'bill_requested', 'order_placed', 'payment_completed')
  ), counted as (select count(*)::int as n from win),
  kept as (select w.body from win w order by w.body->>'createdAt' desc, w.body->>'eventId' desc limit v_limit)
  select coalesce((select jsonb_agg(public.aal_insights_row(k.body) order by k.body->>'createdAt', k.body->>'eventId') from kept k), '[]'::jsonb),
         (select count(*)::int from kept), (select n from counted)
    into v_rows, v_count, v_total;

  select min(r.body->>'createdAt') into v_first
    from public.kv_rows r
   where r.restaurant_id = p_rid and r.collection = 'aal.events'
     and coalesce(r.body->>'venueId', r.body->>'restaurantId') = r.restaurant_id;

  select coalesce(jsonb_object_agg(d.device, d.first), '{}'::jsonb) into v_devices
    from (select r.body->>'deviceId' as device, min(r.body->>'createdAt') as first
            from public.kv_rows r
            join (select distinct e->>'deviceId' as device from jsonb_array_elements(v_rows) e where e->>'deviceId' is not null) p
              on p.device = r.body->>'deviceId'
           where r.restaurant_id = p_rid and r.collection = 'aal.events'
             and coalesce(r.body->>'venueId', r.body->>'restaurantId') = r.restaurant_id
             and r.body->>'eventType' in ('qr_scan', 'item_view', 'ui_action', 'bill_requested', 'review_submitted')
           group by 1) d;

  return jsonb_build_object('version', 1, 'since', v_lo, 'until', v_hi, 'clamped', v_clamped, 'limit', v_limit,
    'truncated', v_total > v_count, 'from', case when v_count > 0 then v_rows->0->>'createdAt' else v_lo end, 'count', v_count,
    'firstEventAt', v_first, 'deviceFirstSeen', v_devices, 'events', v_rows);
end $$;

revoke all on function public.aal_insights_keep(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.aal_insights_row(jsonb) from public, anon, authenticated;
revoke all on function public.aal_insights_events(text, jsonb) from public;
grant execute on function public.aal_insights_events(text, jsonb) to anon, authenticated;

commit;
