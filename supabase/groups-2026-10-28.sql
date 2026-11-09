-- Owner groups: one owner, several venues (T2 "One floor for three places"), 2026-10-28.
--
-- Run after auth-2026-09-24.sql (and, when installed, after daily-close-2026-09-30.sql and
-- integrations-2026-09-30.sql), in the Supabase SQL editor.
-- UNTESTED: written for Postgres 15, not yet run against the live project or any PostgreSQL here.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or replace
-- function", and grant/revoke statements only. No existing row, table or policy is changed. It
-- stops without changing anything if auth-2026-09-24.sql (and so admin.sql) has not been applied.
--
-- The model
--   owner_groups        one row per organisation that owns several venues: id (grp_...), name,
--                       owner_key (own_..., the group's owner link key), created_at.
--   owner_group_venues  which venues a group owns. A venue belongs to at most one group
--                       (restaurant_id is unique). Removing a venue from a group ends the group's
--                       access to it at once.
--   owner_group_staff   people who sign in for the whole group: role owner | manager only.
--                       Waiters are never group staff: a waiter is a staff_members row at one
--                       venue and sees only that venue. Revoking sets revoked_at; the row stays.
--   daily_close_group_log  one row per group per business day, like daily_close_log per venue.
--   All four are closed to anon and authenticated (RLS on, no policies), as staff_members is;
--   they are read and written only by the SECURITY DEFINER functions below and the service role.
--
-- Who sees what (every policy and function that calls aal_role keeps working unchanged)
--   aal_role(rid)       REPLACED, same signature. Order: the venue's owner key -> 'owner'; the
--                       owner key of the group that owns the venue -> 'owner' (new); a signed-in
--                       owner or manager of the venue OR of its group -> 'owner'; a signed-in
--                       waiter of the venue -> 'waiter'; the guest key -> 'guest'; else null.
--                       So a group owner or manager reads and runs every venue of the group with
--                       the owner's rights, and a waiter only their own venue, as before.
--   aal_staff_role(rid) REPLACED, same signature: the higher of the caller's venue role and their
--                       group role for the venue's group (owner > manager > waiter). aal_staff's
--                       "only an owner manages staff" and aal_pos_is_owner (integrations) follow it,
--                       so a signed-in group owner manages each venue's staff and POS keys.
--   aal_staff(...)      REPLACED (auth-2026-09-24.sql's text; only the lines marked "-- T2 group"
--                       change). 'mine' also lists every venue of the caller's groups, with the
--                       group role and group_id/group_name, so the staff gate admits a group
--                       manager at each venue. The group owner key may list, invite, revoke and
--                       change roles at a venue of its group, as the venue's owner key may.
--   aal_group(p_body)   the group surface, for the group owner key or a signed-in group member:
--                       {op:'mine'}  the caller's groups with their venues.
--                       {op:'list', group_id}  the group, its venues, its staff, and (owner only)
--                          each venue's staff list, so the owner sees who sees what.
--                       {op:'invite'|'revoke'|'change_role', group_id, email, role}  the group
--                          owner key or a signed-in group owner; role owner | manager. A signed-in
--                          owner cannot revoke or change their own row; the key can.
--   aal_admin_create_group(name), aal_admin_group_venue(group_id, restaurant_id, 'add'|'remove'),
--   aal_admin_list_groups(), aal_admin_rotate_group_key(group_id): the admin key (admin.sql).
--
-- What this file does not change: aal_snapshot and aal_mutate (they ask aal_role, so a group owner
-- is an owner at each venue and a waiter stays a waiter), the guest path, chk_ bill keys, the POS
-- bridge (it borrows the venue's own owner key). aal_pos_is_owner still accepts only the venue's
-- own owner key, not the group key; a signed-in group owner qualifies through aal_staff_role.
--
-- Re-running auth-2026-09-24.sql restores aal_role, aal_staff_role and aal_staff without groups;
-- run this file again after it.

begin;
set local search_path = public, extensions, pg_temp;

do $$ begin
 if to_regclass('public.staff_members') is null or to_regprocedure('public.aal_staff(text,jsonb)') is null
    or to_regprocedure('public.aal_staff_email()') is null then
  raise exception 'Run auth-2026-09-24.sql before groups-2026-10-28.sql';
 end if;
 if to_regclass('public.venue_profiles') is null or to_regprocedure('public.aal_is_admin()') is null then
  raise exception 'Run admin.sql and auth-2026-09-24.sql before groups-2026-10-28.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.owner_groups (
  id         text primary key check (id ~ '^grp_[0-9a-f]{12,64}$'),
  name       text not null check (length(btrim(name)) between 1 and 80),
  owner_key  text not null unique check (owner_key ~ '^own_[0-9a-f]{12,64}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.owner_group_venues (
  group_id      text not null references public.owner_groups (id) on delete cascade,
  restaurant_id text not null unique references public.venue_keys (restaurant_id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (group_id, restaurant_id)
);
create table if not exists public.owner_group_staff (
  group_id   text not null references public.owner_groups (id) on delete cascade,
  email      text not null check (email = lower(btrim(email)) and length(email) <= 254
                                  and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role       text not null check (role in ('owner', 'manager')),
  invited_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (group_id, email)
);
create index if not exists owner_group_staff_email on public.owner_group_staff (email) where revoked_at is null;
create table if not exists public.daily_close_group_log (
  id          uuid primary key default gen_random_uuid(),
  group_id    text not null references public.owner_groups (id) on delete cascade,
  day         date not null,
  recipients  int  not null default 0 check (recipients >= 0),
  status      text not null check (status in ('sent', 'skipped', 'failed')),
  provider_id text,
  error       text,
  created_at  timestamptz not null default now()
);
create unique index if not exists daily_close_group_log_group_day on public.daily_close_group_log (group_id, day);

alter table public.owner_groups enable row level security;            -- no policies: closed
alter table public.owner_group_venues enable row level security;
alter table public.owner_group_staff enable row level security;
alter table public.daily_close_group_log enable row level security;
revoke all on public.owner_groups, public.owner_group_venues, public.owner_group_staff, public.daily_close_group_log
  from public, anon, authenticated;
do $$ begin
 if exists (select 1 from pg_roles where rolname = 'service_role') then
  -- the daily close reads the groups and keeps the group log
  grant select on public.owner_groups, public.owner_group_venues, public.owner_group_staff to service_role;
  grant select, insert, update on public.daily_close_group_log to service_role;
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Who is calling
-- ---------------------------------------------------------------------------
create or replace function public.aal_group_of(p_rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select gv.group_id from public.owner_group_venues gv where gv.restaurant_id = p_rid
$$;

-- true when x-aalayna-key is the owner key of the group that owns this venue
create or replace function public.aal_group_key_for(p_rid text) returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select public.aal_key() <> '' and exists (
    select 1 from public.owner_group_venues gv join public.owner_groups g on g.id = gv.group_id
     where gv.restaurant_id = p_rid and g.owner_key = public.aal_key())
$$;

-- the signed-in caller's live role in a group, or null
create or replace function public.aal_group_staff_role(p_group text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select s.role from public.owner_group_staff s
   where s.group_id = p_group and s.revoked_at is null
     and s.email = public.aal_staff_email() and s.email <> ''
$$;

-- REPLACED (auth-2026-09-24.sql): the higher of the venue role and the group role.
create or replace function public.aal_staff_role(p_rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  with v as (
    select (select s.role from public.staff_members s
             where s.restaurant_id = p_rid and s.revoked_at is null
               and s.email = public.aal_staff_email() and s.email <> '') as r),
  g as (select public.aal_group_staff_role(public.aal_group_of(p_rid)) as r) -- T2 group
  select case when v.r = 'owner' or g.r = 'owner' then 'owner'
              when v.r = 'manager' or g.r = 'manager' then 'manager'
              else v.r end
  from v, g
$$;

-- REPLACED (auth-2026-09-24.sql). Same signature and parameter name, so every policy keeps working.
create or replace function public.aal_role(rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  with s as (select public.aal_staff_role(rid) as r)
  select case
    when public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = rid and v.owner_key = public.aal_key()) then 'owner'
    when public.aal_group_key_for(rid) then 'owner' -- T2 group: the group owner key, at a venue of its group
    when s.r in ('owner', 'manager') then 'owner'
    when s.r = 'waiter' then 'waiter'
    when public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = rid and v.guest_key = public.aal_key()) then 'guest'
    else null end
  from s
$$;

-- ---------------------------------------------------------------------------
-- Venue staff (auth-2026-09-24.sql's aal_staff; only the lines marked "-- T2 group" change)
-- ---------------------------------------------------------------------------
create or replace function public.aal_staff(p_rid text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  v_body  jsonb := coalesce(p_body, '{}'::jsonb);
  v_op    text;
  v_me    text := public.aal_staff_email();
  v_key   boolean;
  v_venue_key boolean; -- T2 group
  v_email text;
  v_role  text;
  v_row   public.staff_members;
begin
  if jsonb_typeof(v_body) <> 'object' then raise exception 'Staff request must be a JSON object.'; end if;
  v_op := coalesce(v_body->>'op', 'list');

  -- the caller's own memberships: what the staff pages ask right after sign-in
  if v_op = 'mine' then
    if v_me = '' then raise exception 'Sign in with your email first.' using errcode = '42501'; end if;
    return coalesce((
      select jsonb_agg(jsonb_build_object('restaurant_id', m.restaurant_id, 'role', m.role,
                                          'name', coalesce(vp.name, vk.name), 'place', vp.place, 'slug', vp.slug,
                                          'group_id', m.group_id, 'group_name', og.name) -- T2 group
                       order by lower(coalesce(vp.name, vk.name, m.restaurant_id)))
        from ( -- T2 group: venue rows and group rows, one per venue, the higher role kept
          select distinct on (x.restaurant_id) x.restaurant_id, x.role, gv.group_id
            from (select s.restaurant_id, s.role from public.staff_members s where s.email = v_me and s.revoked_at is null
                  union all
                  select gv2.restaurant_id, gs.role from public.owner_group_staff gs
                    join public.owner_group_venues gv2 on gv2.group_id = gs.group_id
                   where gs.email = v_me and gs.revoked_at is null) x
            left join public.owner_group_venues gv on gv.restaurant_id = x.restaurant_id
           order by x.restaurant_id, array_position(array['owner','manager','waiter'], x.role)) m
        join public.venue_keys vk on vk.restaurant_id = m.restaurant_id
        left join public.venue_profiles vp on vp.restaurant_id = m.restaurant_id
        left join public.owner_groups og on og.id = m.group_id), '[]'::jsonb);
  end if;

  -- everything else: the venue's owner key, the owner key of its group, or a signed-in owner (not a manager)
  v_venue_key := public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = p_rid and v.owner_key = public.aal_key()); -- T2 group
  v_key := v_venue_key or public.aal_group_key_for(p_rid); -- T2 group
  if not v_key and coalesce(public.aal_staff_role(p_rid), '') <> 'owner' then
    raise exception 'Only the restaurant owner can manage staff.' using errcode = '42501';
  end if;
  if v_op not in ('list', 'invite', 'revoke', 'change_role') then raise exception 'Unknown staff operation.'; end if;
  if v_op = 'list' then return public.aal_staff_json(p_rid); end if;

  v_email := lower(btrim(coalesce(v_body->>'email', '')));
  if length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  v_role := v_body->>'role';
  if v_op in ('invite', 'change_role') and coalesce(v_role, '') not in ('owner', 'manager', 'waiter') then
    raise exception 'Role must be owner, manager or waiter.';
  end if;
  -- the same venue lock as aal_mutate: staff changes for one venue never interleave
  perform pg_advisory_xact_lock(hashtextextended(p_rid, 0));
  select * into v_row from public.staff_members s where s.restaurant_id = p_rid and s.email = v_email;

  if v_op = 'invite' then
    if found and v_row.revoked_at is null then
      raise exception '% is already on the staff list. Change their role instead.', v_email;
    elsif found then
      update public.staff_members
         set role = v_role, invited_by = case when v_venue_key then 'owner key' when v_key then 'group key' else v_me end, created_at = now(), revoked_at = null -- T2 group
       where restaurant_id = p_rid and email = v_email;
    else
      insert into public.staff_members (restaurant_id, email, role, invited_by)
      values (p_rid, v_email, v_role, case when v_venue_key then 'owner key' when v_key then 'group key' else v_me end); -- T2 group
    end if;
    return public.aal_staff_json(p_rid);
  end if;

  if not found or v_row.revoked_at is not null then raise exception '% is not on the staff list.', v_email; end if;
  if not v_key and v_email = v_me then
    raise exception 'You cannot % your own access. Ask another owner.', case when v_op = 'revoke' then 'revoke' else 'change' end;
  end if;
  if v_op = 'revoke' then
    update public.staff_members set revoked_at = now() where restaurant_id = p_rid and email = v_email;
  else
    update public.staff_members set role = v_role where restaurant_id = p_rid and email = v_email;
  end if;
  return public.aal_staff_json(p_rid);
end $$;

-- ---------------------------------------------------------------------------
-- The group surface
-- ---------------------------------------------------------------------------
create or replace function public.aal_group_venues_json(p_group text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('restaurant_id', gv.restaurant_id, 'name', coalesce(vp.name, vk.name),
                                               'place', vp.place, 'slug', vp.slug)
                            order by lower(coalesce(vp.name, vk.name, gv.restaurant_id)), lower(coalesce(vp.place, ''))), '[]'::jsonb)
    from public.owner_group_venues gv
    join public.venue_keys vk on vk.restaurant_id = gv.restaurant_id
    left join public.venue_profiles vp on vp.restaurant_id = gv.restaurant_id
   where gv.group_id = p_group
$$;

create or replace function public.aal_group_staff_json(p_group text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('email', s.email, 'role', s.role, 'invited_by', s.invited_by,
                                               'created_at', s.created_at, 'revoked_at', s.revoked_at, 'scope', 'group')
                            order by (s.revoked_at is not null), array_position(array['owner','manager'], s.role), s.email), '[]'::jsonb)
    from public.owner_group_staff s where s.group_id = p_group
$$;

create or replace function public.aal_group_json(p_group text, p_with_venue_staff boolean) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('group_id', g.id, 'name', g.name,
    'venues', public.aal_group_venues_json(g.id),
    'staff', public.aal_group_staff_json(g.id),
    'venue_staff', case when p_with_venue_staff then coalesce((
       select jsonb_agg(public.aal_staff_json(gv.restaurant_id) order by gv.restaurant_id)
         from public.owner_group_venues gv where gv.group_id = g.id), '[]'::jsonb) else null end)
  from public.owner_groups g where g.id = p_group
$$;

create or replace function public.aal_group(p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  v_body  jsonb := coalesce(p_body, '{}'::jsonb);
  v_op    text;
  v_me    text := public.aal_staff_email();
  v_group text;
  v_key   boolean;
  v_mine  text;
  v_email text;
  v_role  text;
  v_row   public.owner_group_staff;
begin
  if jsonb_typeof(v_body) <> 'object' then raise exception 'Group request must be a JSON object.'; end if;
  v_op := coalesce(v_body->>'op', 'mine');

  if v_op = 'mine' then
    if public.aal_key() <> '' and exists (select 1 from public.owner_groups g where g.owner_key = public.aal_key()) then
      return (select jsonb_agg(jsonb_build_object('group_id', g.id, 'name', g.name, 'role', 'owner', 'via', 'key',
                                                  'venues', public.aal_group_venues_json(g.id)))
                from public.owner_groups g where g.owner_key = public.aal_key());
    end if;
    if v_me = '' then raise exception 'Sign in with your email or open the group owner link first.' using errcode = '42501'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('group_id', g.id, 'name', g.name, 'role', s.role, 'via', 'session',
                                                         'venues', public.aal_group_venues_json(g.id)) order by lower(g.name))
                       from public.owner_group_staff s join public.owner_groups g on g.id = s.group_id
                      where s.email = v_me and s.revoked_at is null), '[]'::jsonb);
  end if;

  v_group := v_body->>'group_id';
  if coalesce(v_group, '') = '' or not exists (select 1 from public.owner_groups g where g.id = v_group) then
    raise exception 'Unknown group.';
  end if;
  v_key := public.aal_key() <> '' and exists (select 1 from public.owner_groups g where g.id = v_group and g.owner_key = public.aal_key());
  v_mine := public.aal_group_staff_role(v_group);
  if not v_key and v_mine is null then
    raise exception 'Only the group owner or a group manager can open this group.' using errcode = '42501';
  end if;
  if v_op = 'list' then return public.aal_group_json(v_group, v_key or v_mine = 'owner'); end if;
  if v_op not in ('invite', 'revoke', 'change_role') then raise exception 'Unknown group operation.'; end if;
  if not v_key and v_mine <> 'owner' then
    raise exception 'Only the group owner can manage group staff.' using errcode = '42501';
  end if;

  v_email := lower(btrim(coalesce(v_body->>'email', '')));
  if length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  v_role := v_body->>'role';
  if v_op in ('invite', 'change_role') and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'A group role is owner or manager. Waiters are invited at their venue.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_group, 0));
  select * into v_row from public.owner_group_staff s where s.group_id = v_group and s.email = v_email;

  if v_op = 'invite' then
    if found and v_row.revoked_at is null then
      raise exception '% is already on the group staff list. Change their role instead.', v_email;
    elsif found then
      update public.owner_group_staff
         set role = v_role, invited_by = case when v_key then 'group key' else v_me end, created_at = now(), revoked_at = null
       where group_id = v_group and email = v_email;
    else
      insert into public.owner_group_staff (group_id, email, role, invited_by)
      values (v_group, v_email, v_role, case when v_key then 'group key' else v_me end);
    end if;
    return public.aal_group_json(v_group, true);
  end if;

  if not found or v_row.revoked_at is not null then raise exception '% is not on the group staff list.', v_email; end if;
  if not v_key and v_email = v_me then
    raise exception 'You cannot % your own access. Ask another owner.', case when v_op = 'revoke' then 'revoke' else 'change' end;
  end if;
  if v_op = 'revoke' then
    update public.owner_group_staff set revoked_at = now() where group_id = v_group and email = v_email;
  else
    update public.owner_group_staff set role = v_role where group_id = v_group and email = v_email;
  end if;
  return public.aal_group_json(v_group, true);
end $$;

-- ---------------------------------------------------------------------------
-- Admin (the admin key, admin.sql): create a group, add and remove venues, rotate its key
-- ---------------------------------------------------------------------------
create or replace function public.aal_admin_group_json(p_group text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('group_id', g.id, 'name', g.name, 'owner_key', g.owner_key, 'created_at', g.created_at,
                            'venues', public.aal_group_venues_json(g.id), 'staff', public.aal_group_staff_json(g.id))
    from public.owner_groups g where g.id = p_group
$$;

create or replace function public.aal_admin_create_group(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_name text := btrim(coalesce(p_name, '')); v_id text; v_key text;
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  if length(v_name) < 1 or length(v_name) > 80 then raise exception 'A group name has 1 to 80 characters.'; end if;
  v_id := 'grp_' || encode(gen_random_bytes(9), 'hex');
  loop   -- a group key is never equal to a venue key: both are owner keys in x-aalayna-key
    v_key := 'own_' || encode(gen_random_bytes(20), 'hex');
    exit when not exists (select 1 from public.venue_keys v where v.owner_key = v_key);
  end loop;
  insert into public.owner_groups (id, name, owner_key) values (v_id, v_name, v_key);
  return public.aal_admin_group_json(v_id);
end $$;

create or replace function public.aal_admin_group_venue(p_group text, p_rid text, p_op text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_other text;
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  if not exists (select 1 from public.owner_groups g where g.id = p_group) then raise exception 'Unknown group.'; end if;
  if not exists (select 1 from public.venue_keys v where v.restaurant_id = p_rid) then raise exception 'Unknown venue.'; end if;
  if p_op = 'add' then
    select gv.group_id into v_other from public.owner_group_venues gv where gv.restaurant_id = p_rid;
    if v_other is not null and v_other <> p_group then raise exception 'This venue already belongs to another group. Remove it there first.'; end if;
    insert into public.owner_group_venues (group_id, restaurant_id) values (p_group, p_rid) on conflict do nothing;
  elsif p_op = 'remove' then
    delete from public.owner_group_venues where group_id = p_group and restaurant_id = p_rid;
  else
    raise exception 'Say add or remove.';
  end if;
  return public.aal_admin_group_json(p_group);
end $$;

create or replace function public.aal_admin_list_groups() returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.aal_admin_group_json(g.id) order by g.created_at desc) from public.owner_groups g), '[]'::jsonb);
end $$;

-- The old group key stops working at once at every venue of the group.
create or replace function public.aal_admin_rotate_group_key(p_group text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_key text;
begin
  if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
  loop
    v_key := 'own_' || encode(gen_random_bytes(20), 'hex');
    exit when not exists (select 1 from public.venue_keys v where v.owner_key = v_key);
  end loop;
  update public.owner_groups set owner_key = v_key where id = p_group;
  if not found then raise exception 'Unknown group.'; end if;
  return public.aal_admin_group_json(p_group);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges. Helpers run only inside the SECURITY DEFINER functions.
-- ---------------------------------------------------------------------------
revoke all on function public.aal_group_of(text) from public, anon, authenticated;
revoke all on function public.aal_group_key_for(text) from public, anon, authenticated;
revoke all on function public.aal_group_staff_role(text) from public, anon, authenticated;
revoke all on function public.aal_staff_role(text) from public, anon, authenticated;
revoke all on function public.aal_group_venues_json(text) from public, anon, authenticated;
revoke all on function public.aal_group_staff_json(text) from public, anon, authenticated;
revoke all on function public.aal_group_json(text, boolean) from public, anon, authenticated;
revoke all on function public.aal_admin_group_json(text) from public, anon, authenticated;
grant execute on function public.aal_role(text) to anon, authenticated;
revoke all on function public.aal_staff(text, jsonb) from public;
grant execute on function public.aal_staff(text, jsonb) to anon, authenticated;
revoke all on function public.aal_group(jsonb) from public;
grant execute on function public.aal_group(jsonb) to anon, authenticated;
revoke all on function public.aal_admin_create_group(text) from public;
revoke all on function public.aal_admin_group_venue(text, text, text) from public;
revoke all on function public.aal_admin_list_groups() from public;
revoke all on function public.aal_admin_rotate_group_key(text) from public;
grant execute on function public.aal_admin_create_group(text) to anon, authenticated;
grant execute on function public.aal_admin_group_venue(text, text, text) to anon, authenticated;
grant execute on function public.aal_admin_list_groups() to anon, authenticated;
grant execute on function public.aal_admin_rotate_group_key(text) to anon, authenticated;
commit;
