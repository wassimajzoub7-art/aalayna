-- Aalayna admin console: founder identity and venue onboarding (T6).
-- Run in the Supabase SQL editor AFTER migration.sql (it needs venue_keys,
-- kv_rows and aal_touch) and hardening-2026-09-15.sql. Safe to re-run.
-- UNTESTED: written for Postgres 15, not yet run against the live project.
--
-- What it adds
--   admin_keys        one row per admin key. Never readable through the API.
--   venue_profiles    one row per venue: slug, name, place, Google place id,
--                     brand, background, font, menu pack, demo payments flag.
--   aal_admin_register_venue(name, place, slug, profile)   create or re-read a
--                     venue and its two keys, and write its profile
--   aal_admin_list_venues()                                every venue, keys,
--                     profile and activity counts (aal.checks, aal.settle)
--   aal_admin_update_profile(restaurant_id, profile)        change the profile
--   aal_admin_rotate_keys(restaurant_id, 'owner'|'guest')   issue a new key
--   Each of the four checks the admin key first and raises 'Admin key required.'
--
-- How the admin key works
--   admin.html sends it in the request header x-aalayna-admin, the same way the
--   apps send a venue key in x-aalayna-key (see aal_key() in migration.sql). It
--   is kept in the browser tab's sessionStorage only, never in a link.
--
-- Operating instructions
--   1. Create the first admin key here, in the SQL editor, and keep the value
--      that comes back somewhere private (a password manager):
--
--        insert into admin_keys (admin_key, label) values ('adm_' || encode(gen_random_bytes(18),'hex'), 'founder') returning admin_key;
--
--      If gen_random_bytes is not found, pgcrypto lives in the extensions
--      schema: write extensions.gen_random_bytes(18) instead.
--   2. Open admin.html, paste the key into Venues, press Connect.
--   3. Register a venue with its name and place exactly as the restaurant
--      writes them (together they make restaurant_id, the store's venueId()).
--   4. Send the owner editor and owner dashboard links to the owner only.
--      Guest bill links (chk_ keys) come from the dashboard, one per bill.
--   5. A leaked key: rotate it from the venue's panel and send the new links.
--   To remove an admin key:  delete from admin_keys where label = 'founder';
--
-- Security notes
--   Brute force is the only way in without a key; keys carry 144 random bits.
--   There is no rate limit on failed attempts at this layer.
--   Owner and guest keys are returned to the admin page on purpose: the founder
--   hands them over. Treat the admin key like a master password.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.admin_keys (
  admin_key  text primary key,
  label      text,
  created_at timestamptz default now()
);
alter table public.admin_keys enable row level security;   -- no policies: closed
revoke all on public.admin_keys from public, anon, authenticated;

create table if not exists public.venue_profiles (
  restaurant_id text primary key references public.venue_keys (restaurant_id) on delete cascade,
  slug          text not null unique,
  name          text not null,
  place         text not null default '',
  gplace        text,
  brand         text,
  bg            text,
  font          text,
  menu_pack     text,
  demo_payments boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.venue_profiles enable row level security; -- no policies: closed
revoke all on public.venue_profiles from public, anon, authenticated;

drop trigger if exists venue_profiles_touch on public.venue_profiles;
create trigger venue_profiles_touch before update on public.venue_profiles
  for each row execute function public.aal_touch();

-- ---------------------------------------------------------------------------
-- Admin identity
-- ---------------------------------------------------------------------------
create or replace function public.aal_admin_key() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-aalayna-admin', '')
$$;

create or replace function public.aal_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.aal_admin_key() <> ''
     and exists (select 1 from public.admin_keys a where a.admin_key = public.aal_admin_key())
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable through the API)
-- ---------------------------------------------------------------------------

-- One profile field, validated and normalised. Empty means null. The rules
-- match what aalayna-store.js venueFromURL() accepts, so every stored value
-- survives the trip through a link unchanged.
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
  elsif p_field = 'slug' then
    if length(v) > 40 or v !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
      raise exception 'Slug uses lower-case letters, digits and hyphens only, up to 40 characters, and cannot start or end with a hyphen.';
    end if;
    return v;
  end if;
  raise exception 'Unknown profile field %.', p_field;
end $$;

-- A slug for this venue. A given slug must be free (or already this venue's);
-- an empty one is derived from the name, with -2, -3 ... until it is free.
create or replace function public.aal_admin_slug(p_slug text, p_name text, p_rid text) returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare s text := public.aal_admin_field('slug', p_slug); stem text; n int := 1;
begin
  if s is not null then
    if exists (select 1 from public.venue_profiles vp where vp.slug = s and vp.restaurant_id <> p_rid) then
      raise exception 'The slug % is already used by another venue.', s;
    end if;
    return s;
  end if;
  stem := btrim(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 36), '-');
  if stem = '' then stem := 'venue'; end if;
  s := stem;
  while exists (select 1 from public.venue_profiles vp where vp.slug = s and vp.restaurant_id <> p_rid) loop
    n := n + 1;
    s := stem || '-' || n;
  end loop;
  return s;
end $$;

-- Write a venue's profile. Keys absent from p_profile keep their current value
-- (or the default for a venue that has no profile yet). Name and place may only
-- change capitalisation: together they are the restaurant_id every link uses.
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
end $$;

-- One venue as the admin page shows it.
create or replace function public.aal_admin_venue_json(p_rid text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'restaurant_id', v.restaurant_id,
    'name',          coalesce(p.name, v.name),
    'owner_key',     v.owner_key,
    'guest_key',     v.guest_key,
    'created_at',    v.created_at,
    'profile',       case when p.restaurant_id is null then null else to_jsonb(p) - 'restaurant_id' end,
    'checks',        (select count(*) from public.kv_rows r where r.restaurant_id = v.restaurant_id and r.collection = 'aal.checks'),
    'payments',      (select count(*) from public.kv_rows r where r.restaurant_id = v.restaurant_id and r.collection = 'aal.settle'),
    'last_activity', (select max(r.updated_at) from public.kv_rows r
                       where r.restaurant_id = v.restaurant_id and r.collection in ('aal.checks', 'aal.settle')))
  from public.venue_keys v
  left join public.venue_profiles p on p.restaurant_id = v.restaurant_id
  where v.restaurant_id = p_rid
$$;

-- ---------------------------------------------------------------------------
-- API: called by admin.html at /rest/v1/rpc/<name> with x-aalayna-admin
-- ---------------------------------------------------------------------------

-- Creates the venue_keys row with the same restaurant_id rule and key format as
-- aal_register_venue (migration.sql). It mirrors that function instead of
-- calling it: hardening-2026-09-15.sql pins its search_path to public, pg_temp,
-- and on Supabase pgcrypto's gen_random_bytes lives in the extensions schema.
-- An existing venue is not changed: its keys come back and 'existed' is true.
create or replace function public.aal_admin_register_venue(p_name text, p_place text, p_slug text, p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  v_name  text;
  v_place text;
  v_rid   text;
  v_new   text;
  vk      public.venue_keys;
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  v_name  := public.aal_admin_field('name', p_name);
  v_place := coalesce(public.aal_admin_field('place', p_place), '');
  if v_name is null then raise exception 'Name is required.'; end if;
  if p_profile is not null and jsonb_typeof(p_profile) <> 'object' then
    raise exception 'Profile must be a JSON object.';
  end if;

  v_rid := '["' || lower(v_name) || '","' || lower(v_place) || '"]';
  insert into public.venue_keys (restaurant_id, owner_key, guest_key, name)
  values (v_rid, 'own_' || encode(gen_random_bytes(18), 'hex'), 'gst_' || encode(gen_random_bytes(9), 'hex'), v_name)
  on conflict (restaurant_id) do nothing
  returning restaurant_id into v_new;

  perform public.aal_admin_write_profile(v_rid,
    coalesce(p_profile, '{}'::jsonb) - 'name' - 'place' - 'slug'
      || jsonb_build_object('name', v_name, 'place', v_place, 'slug', coalesce(p_slug, '')));

  select * into vk from public.venue_keys k where k.restaurant_id = v_rid;
  return jsonb_build_object(
    'restaurant_id', vk.restaurant_id,
    'owner_key',     vk.owner_key,
    'guest_key',     vk.guest_key,
    'slug',          (select vp.slug from public.venue_profiles vp where vp.restaurant_id = v_rid),
    'profile',       (select to_jsonb(vp) - 'restaurant_id' from public.venue_profiles vp where vp.restaurant_id = v_rid),
    'existed',       v_new is null);
end $$;

create or replace function public.aal_admin_list_venues() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.aal_admin_venue_json(v.restaurant_id) order by v.created_at desc)
                     from public.venue_keys v), '[]'::jsonb);
end $$;

-- Returns the venue in the same shape as one aal_admin_list_venues() entry.
create or replace function public.aal_admin_update_profile(p_rid text, p_profile jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  perform public.aal_admin_write_profile(p_rid, p_profile);
  return public.aal_admin_venue_json(p_rid);
end $$;

-- Same key format as aal_register_venue. The old key stops working at once:
-- every device that stored it falls back until opened with a new link.
create or replace function public.aal_admin_rotate_keys(p_rid text, p_which text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  if p_which = 'owner' then
    update public.venue_keys set owner_key = 'own_' || encode(gen_random_bytes(18), 'hex') where restaurant_id = p_rid;
  elsif p_which = 'guest' then
    update public.venue_keys set guest_key = 'gst_' || encode(gen_random_bytes(9), 'hex') where restaurant_id = p_rid;
  else
    raise exception 'Say which key to rotate: owner or guest.';
  end if;
  if not found then raise exception 'Unknown venue.'; end if;
  return public.aal_admin_venue_json(p_rid);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges. Helpers run only inside the SECURITY DEFINER functions above.
-- ---------------------------------------------------------------------------
revoke all on function public.aal_admin_key() from public, anon, authenticated;
revoke all on function public.aal_is_admin() from public, anon, authenticated;
revoke all on function public.aal_admin_field(text, text) from public, anon, authenticated;
revoke all on function public.aal_admin_slug(text, text, text) from public, anon, authenticated;
revoke all on function public.aal_admin_write_profile(text, jsonb) from public, anon, authenticated;
revoke all on function public.aal_admin_venue_json(text) from public, anon, authenticated;

revoke all on function public.aal_admin_register_venue(text, text, text, jsonb) from public;
revoke all on function public.aal_admin_list_venues() from public;
revoke all on function public.aal_admin_update_profile(text, jsonb) from public;
revoke all on function public.aal_admin_rotate_keys(text, text) from public;
grant execute on function public.aal_admin_register_venue(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.aal_admin_list_venues() to anon, authenticated;
grant execute on function public.aal_admin_update_profile(text, jsonb) to anon, authenticated;
grant execute on function public.aal_admin_rotate_keys(text, text) to anon, authenticated;
