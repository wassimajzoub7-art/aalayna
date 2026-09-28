-- A menu style per venue (Balat), 2026-09-28.
--
-- Run after followups-2026-09-24.sql, in the Supabase SQL editor. Safe to re-run: one
-- transaction; "add column if not exists", the check constraint is dropped and added again,
-- "create or replace function", revoke. It stops without changing anything if
-- followups-2026-09-24.sql (and so admin, sessions and auth) has not been applied. No data
-- changes: every venue stays on the standard menu (theme null) until the admin picks one.
--
-- What changes
--   venue_profiles.theme     NEW, text: null is the standard menu, 'balat' the Beirut
--                            cement-tile menu (guest.html ?theme=balat). The same list as
--                            THEMES in aalayna-store.js; a check constraint holds it.
--   aal_admin_field          REPLACED (admin.sql's text; only the lines marked "-- theme"
--                            are new): 'theme' is lower-cased and must be on the list.
--   aal_admin_write_profile  REPLACED (admin.sql's text; only the lines marked "-- theme"
--                            are new): writes theme when the profile names it; absent keeps
--                            the current value, empty returns to the standard menu.
--   aal_table_session        REPLACED (followups-2026-09-24.sql's text; the line marked
--                            "-- theme" adds theme to the venue it returns). guest.html
--                            puts it in the address, so a table QR opens the venue's style.
--   aal_admin_venue_json and aal_admin_register_venue return to_jsonb(profile), so the
--   admin page sees theme with no change to them.
--
-- Re-running an older file undoes part of this one: admin.sql restores the two admin
-- functions without theme (the column and its values stay, the admin page can no longer
-- change them); followups-2026-09-24.sql and sessions-2026-09-24.sql restore
-- aal_table_session without theme (table QRs open the standard menu). Run this file again
-- after any of them.

begin;
do $$ begin
 if to_regclass('public.venue_profiles') is null or to_regprocedure('public.aal_admin_write_profile(text,jsonb)') is null then
  raise exception 'Run admin.sql before theme-2026-09-28.sql';
 end if;
 if to_regprocedure('public.aal_table_session(text,integer,text)') is null or to_regclass('public.check_keys_check') is null then
  raise exception 'Run followups-2026-09-24.sql before theme-2026-09-28.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The column, held to the list
-- ---------------------------------------------------------------------------
alter table public.venue_profiles add column if not exists theme text;
alter table public.venue_profiles drop constraint if exists venue_profiles_theme;
alter table public.venue_profiles add constraint venue_profiles_theme check (theme is null or theme in ('balat'));

-- ---------------------------------------------------------------------------
-- 2. The admin writes it (admin.sql's text; lines marked "-- theme" are new)
-- ---------------------------------------------------------------------------
create or replace function public.aal_admin_field(p_field text, p_value text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is null then return null; end if;
  if p_field in ('name', 'place') then
    if length(v) > 40 then
      raise exception '% is longer than 40 characters.', initcap(p_field);
    end if;
    -- restaurant_id is built by string concatenation (as aal_register_venue
    -- does); without these characters it equals the browser's JSON.stringify.
    if strpos(v, '"') > 0 or strpos(v, E'\\') > 0 or v ~ '[[:cntrl:]]' then
      raise exception '% cannot contain double quotes, backslashes or control characters.', initcap(p_field);
    end if;
    return v;
  elsif p_field in ('brand', 'bg') then
    if v !~ '^#?[0-9A-Fa-f]{6}$' then
      raise exception '% must be a six digit hex colour, like #EA312B.',
        case p_field when 'brand' then 'Brand colour' else 'Background' end;
    end if;
    return '#' || upper(ltrim(v, '#'));
  elsif p_field = 'font' then
    if v !~ '^[A-Za-z0-9 +]{1,40}$' then
      raise exception 'Font must be a Google Fonts name: letters, digits and spaces, up to 40 characters.';
    end if;
    return v;
  elsif p_field = 'gplace' then
    if v !~ '^[A-Za-z0-9_-]{1,60}$' then
      raise exception 'Google place id uses letters, digits, hyphens and underscores only, up to 60 characters.';
    end if;
    return v;
  elsif p_field = 'menu_pack' then
    if v !~ '^[a-z0-9-]{1,40}$' then
      raise exception 'Menu pack uses lower-case letters, digits and hyphens only.';
    end if;
    return v;
  elsif p_field = 'theme' then -- theme
    v := lower(v); -- theme
    if v not in ('balat') then -- theme
      raise exception 'Menu style is the standard menu (leave it empty) or balat.'; -- theme
    end if; -- theme
    return v; -- theme
  elsif p_field = 'slug' then
    if length(v) > 40 or v !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
      raise exception 'Slug uses lower-case letters, digits and hyphens only, up to 40 characters, and cannot start or end with a hyphen.';
    end if;
    return v;
  end if;
  raise exception 'Unknown profile field %.', p_field;
end $$;

create or replace function public.aal_admin_write_profile(p_rid text, p_profile jsonb) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
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
                     cur.demo_payments, true);

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

-- ---------------------------------------------------------------------------
-- 3. A table scan returns it (followups-2026-09-24.sql's text; the "-- theme" line changed)
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
                                'bg', vp.bg, 'font', vp.font, 'menu_pack', vp.menu_pack, 'theme', vp.theme), -- theme
    'table', p_table,
    'checkId', cid,
    'key', k,
    'docs', ds);
end $$;

-- the same privileges as admin.sql and followups-2026-09-24.sql give these functions
revoke all on function public.aal_admin_field(text, text) from public, anon, authenticated;
revoke all on function public.aal_admin_write_profile(text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_table_session(text, int, text) from public;
grant execute on function public.aal_table_session(text, int, text) to anon, authenticated;
commit;
