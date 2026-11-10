-- Review fixes, 2026-11-10: demo payments off by default, a demo flag on confirmed payments,
-- and the database's clock for the browser.
--
-- Run after payment-start-2026-10-14.sql (and every file before it), in the Supabase SQL
-- editor. Tested against PGlite (tests/review-fixes-sql.test.cjs with PGLITE_MODULE set); not
-- yet run against the live project.
--
-- Safe to re-run: one transaction; "alter column ... set default", "create or replace
-- function", "drop trigger if exists" + "create trigger", an update that touches only the
-- payments whose demo flag is not what the trigger derives (none on a second run), grants and
-- revokes. No row of venue_profiles changes: a venue whose demo payments are on keeps them on.
-- aal_snapshot and aal_mutate are not touched. It stops without changing anything if
-- payment-start-2026-10-14.sql or theme-2026-09-28.sql has not been applied.
--
-- What changes
--   venue_profiles.demo_payments
--                          default false (was true): a venue registered without naming the
--                          flag offers no fake provider. admin.sql now creates the column
--                          with the same default.
--   aal_admin_write_profile
--                          REPLACED (theme-2026-09-28.sql's text; only the two lines marked
--                          "-- review" changed): a profile that does not name demo_payments,
--                          for a venue that has none yet, is stored with demo payments off
--                          (was on); search_path also names extensions, as every function in
--                          this file does. admin.sql and theme-2026-09-28.sql carry the same
--                          fallback now, so re-running them undoes nothing here.
--   aal_settle_demo()      NEW trigger function, run by kv_rows_settle_demo before every
--                          insert or update of an aal.settle row: a confirmed payment's body
--                          carries "demo": true when the reference that confirmed it
--                          (externalRef) is the fake provider's ('fake-' ...), "demo": false
--                          otherwise; a payment in any other status carries no demo key.
--                          Derived on every write, whoever writes (aal_mutate for a guest,
--                          staff or the service role, aal_payment_failed, pos-bill, the SQL
--                          editor), so no client can set or clear it. aal_snapshot strips
--                          externalRef for everyone but the owner and keeps demo, so the
--                          guest page and a waiter can tell a demo confirmation from a real
--                          one; the dashboard tags it "Demo".
--   backfill               the aal.settle rows whose demo key differs from what the trigger
--                          derives are written again (body = body; the trigger sets it).
--                          Their updated_at moves to now, so staff devices pull them once.
--   aal_now()              NEW, the database's current time (timestamptz), for anon and
--                          authenticated: the guest page measures a payment's expiresAt
--                          against it, never against the phone's clock.
--     POST /rest/v1/rpc/aal_now  ->  "2026-11-10T09:30:00.123456+00:00"

begin;
do $$ begin
 if to_regclass('public.payment_providers') is null or to_regprocedure('public.aal_payment_provider(text,text)') is null then
  raise exception 'Run payment-start-2026-10-14.sql before review-fixes-2026-11-10.sql';
 end if;
 if to_regprocedure('public.aal_admin_write_profile(text,jsonb)') is null or not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'venue_profiles' and column_name = 'theme') then
  raise exception 'Run admin.sql and theme-2026-09-28.sql before review-fixes-2026-11-10.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Demo payments are off unless the admin turns them on
-- ---------------------------------------------------------------------------
alter table public.venue_profiles alter column demo_payments set default false;

create or replace function public.aal_admin_write_profile(p_rid text, p_profile jsonb) returns void
language plpgsql volatile set search_path = public, extensions, pg_temp as $$ -- review
declare
  v    jsonb := coalesce(p_profile, '{}'::jsonb);
  vk   public.venue_keys;
  cur  public.venue_profiles;
  ids  jsonb;
  n_name text; n_place text; n_slug text; n_demo boolean;
begin
  if jsonb_typeof(v) <> 'object' then raise exception 'Profile must be a JSON object.'; end if;
  select * into vk from public.venue_keys k where k.restaurant_id = p_rid;
  if not found then raise exception 'Unknown venue.'; end if;
  select * into cur from public.venue_profiles vp where vp.restaurant_id = p_rid;
  begin
    ids := p_rid::jsonb;
  exception when others then
    ids := jsonb_build_array(lower(coalesce(vk.name, '')), '');
  end;

  n_name := case when v ? 'name' then public.aal_admin_field('name', v->>'name')
                 else coalesce(cur.name, vk.name) end;
  n_place := coalesce(case when v ? 'place' then public.aal_admin_field('place', v->>'place')
                           else coalesce(cur.place, ids->>1) end, '');
  if n_name is null then raise exception 'Name is required.'; end if;
  if lower(n_name) <> coalesce(ids->>0, '') or lower(n_place) <> coalesce(ids->>1, '') then
    raise exception 'Name and place make the venue id, so only their capitalisation can change. Register a new venue for a new name or place.';
  end if;

  n_slug := nullif(btrim(coalesce(v->>'slug', '')), '');
  n_slug := public.aal_admin_slug(coalesce(n_slug, cur.slug), n_name, p_rid);
  n_demo := coalesce(case when v ? 'demo_payments' then (v->>'demo_payments')::boolean end,
                     cur.demo_payments, false); -- review

  insert into public.venue_profiles as vp
    (restaurant_id, slug, name, place, gplace, brand, bg, font, menu_pack, demo_payments)
  values (
    p_rid, n_slug, n_name, n_place,
    case when v ? 'gplace'    then public.aal_admin_field('gplace',    v->>'gplace')    else cur.gplace    end,
    case when v ? 'brand'     then public.aal_admin_field('brand',     v->>'brand')     else cur.brand     end,
    case when v ? 'bg'        then public.aal_admin_field('bg',        v->>'bg')        else cur.bg        end,
    case when v ? 'font'      then public.aal_admin_field('font',      v->>'font')      else cur.font      end,
    case when v ? 'menu_pack' then public.aal_admin_field('menu_pack', v->>'menu_pack') else cur.menu_pack end,
    n_demo)
  on conflict (restaurant_id) do update set
    slug = excluded.slug, name = excluded.name, place = excluded.place,
    gplace = excluded.gplace, brand = excluded.brand, bg = excluded.bg, font = excluded.font,
    menu_pack = excluded.menu_pack, demo_payments = excluded.demo_payments;
  -- the menu style, like the other optional fields: absent keeps the current value -- theme
  if v ? 'theme' then -- theme
    update public.venue_profiles vp set theme = public.aal_admin_field('theme', v->>'theme') -- theme
     where vp.restaurant_id = p_rid; -- theme
  end if; -- theme
end $$;
revoke all on function public.aal_admin_write_profile(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A confirmed payment says whether the fake provider confirmed it
-- ---------------------------------------------------------------------------
create or replace function public.aal_settle_demo() returns trigger
language plpgsql set search_path = public, extensions, pg_temp as $$
begin
 if jsonb_typeof(new.body) is distinct from 'object' then return new; end if;
 if new.body->>'status' = 'confirmed' then
  new.body := new.body || jsonb_build_object('demo', coalesce(new.body->>'externalRef', '') like 'fake-%');
 elsif new.body ? 'demo' then
  new.body := new.body - 'demo';
 end if;
 return new;
end $$;
revoke all on function public.aal_settle_demo() from public, anon, authenticated;

drop trigger if exists kv_rows_settle_demo on public.kv_rows;
create trigger kv_rows_settle_demo before insert or update on public.kv_rows
 for each row when (new.collection = 'aal.settle') execute function public.aal_settle_demo();

-- the payments already stored: only those whose flag is not what the trigger derives
update public.kv_rows set body = body
 where collection = 'aal.settle' and jsonb_typeof(body) = 'object'
   and case when body->>'status' = 'confirmed'
            then body->'demo' is distinct from to_jsonb(coalesce(body->>'externalRef', '') like 'fake-%')
            else body ? 'demo' end;

-- ---------------------------------------------------------------------------
-- 3. The database's clock, for the browser
-- ---------------------------------------------------------------------------
create or replace function public.aal_now() returns timestamptz
language sql stable set search_path = public, extensions, pg_temp as $$
 select now()
$$;
revoke all on function public.aal_now() from public;
grant execute on function public.aal_now() to anon, authenticated;
commit;
