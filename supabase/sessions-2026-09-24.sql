-- Table QR sessions (T3), 2026-09-24.
--
-- Run after hardening-2026-09-24.sql and admin.sql, in the Supabase SQL editor.
-- UNTESTED: written for Postgres 15, not yet run against the live project.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or
-- replace function", and grant/revoke statements only. No existing table, policy,
-- function or row is changed; aal_mutate is NOT replaced. It stops without changing
-- anything if hardening-2026-09-24.sql or admin.sql has not been applied.
--
-- What it adds
--   table_tokens        one row per printed table code. At most one live code
--                       (revoked_at is null) per table; revoking sets revoked_at.
--                       Closed to anon/authenticated: RLS on, no policies.
--   aal_table_tokens(p_rid, p_body)          owner key (x-aalayna-key) required.
--                       body {op:'list'} | {op:'issue', table} | {op:'revoke', table}
--                       'issue' revokes the table's previous live code and mints
--                       tbl_ + 24 random bytes (hex). Every op returns
--                       {restaurant_id, slug, name, place,
--                        tokens:[{table, token, created_at}]}  (live codes only).
--                       The slug is returned because the printed link needs it and
--                       venue_profiles is not readable with an owner key.
--   aal_table_session(p_slug, p_table, p_token)   callable by anon, no venue key.
--                       Resolves the slug through venue_profiles, checks p_token is
--                       the live code of that table, and returns
--                       {restaurant_id, venue:{name, place, gplace, brand, bg, font,
--                        menu_pack}, table, checkId, key, docs}
--                       checkId/key are null while the table has no open bill.
--                       key is a fresh chk_ key for the open bill, minted exactly as
--                       aal_mutate issue_key does (inserted into check_keys).
--                       docs are the published menu and rate documents (aal.live,
--                       aal.rate, aal.rate_meta), the same projection a chk_ guest
--                       gets from aal_snapshot, so the menu shows before a bill exists.
--                       A wrong, revoked or unknown code raises
--                       'This table code is not active. Ask your server for the bill.'
--
-- Security notes
--   A table code carries 192 random bits, so guessing one is not possible; there is
--   no rate limit at this layer. The slug is public (it is printed on the card).
--   A table code is a standing credential for that table: whoever has a photo of the
--   card can open that table's current bill, whichever party is seated. Revoke and
--   reissue a code (qr.html, Tables) when a card is lost or copied.
--   FOLLOW-UP (not fixed here): a chk_ key minted by aal_table_session inherits the
--   upstream limitation of issue_key keys: it never expires. It stays scoped to the
--   one check it names, so after that bill closes it only shows the closed bill, but
--   check_keys grows by one row per scan of a table with an open bill.

begin;
do $$ begin
 if to_regprocedure('public.aal_bill_lines(jsonb)') is null or to_regclass('public.check_keys') is null then
  raise exception 'Run hardening-2026-09-24.sql before sessions-2026-09-24.sql';
 end if;
 if to_regclass('public.venue_profiles') is null then
  raise exception 'Run admin.sql before sessions-2026-09-24.sql';
 end if;
end $$;

create table if not exists public.table_tokens (
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  table_no      int  not null check (table_no between 1 and 9999),
  token         text not null unique,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  primary key (restaurant_id, table_no, token)
);
-- one live code per table
create unique index if not exists table_tokens_live on public.table_tokens (restaurant_id, table_no) where revoked_at is null;
alter table public.table_tokens enable row level security;   -- no policies: closed
revoke all on public.table_tokens from public, anon, authenticated;

-- The live codes of a venue, as both functions below return them.
create or replace function public.aal_table_tokens_json(p_rid text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object(
    'restaurant_id', p_rid,
    'slug',  (select vp.slug  from public.venue_profiles vp where vp.restaurant_id = p_rid),
    'name',  (select vp.name  from public.venue_profiles vp where vp.restaurant_id = p_rid),
    'place', (select vp.place from public.venue_profiles vp where vp.restaurant_id = p_rid),
    'tokens', coalesce((select jsonb_agg(jsonb_build_object('table', t.table_no, 'token', t.token, 'created_at', t.created_at) order by t.table_no)
                          from public.table_tokens t where t.restaurant_id = p_rid and t.revoked_at is null), '[]'::jsonb))
$$;
revoke all on function public.aal_table_tokens_json(text) from public, anon, authenticated;

create or replace function public.aal_table_tokens(p_rid text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  v_op    text := coalesce(p_body->>'op', 'list');
  v_table int;
begin
  if coalesce(public.aal_role(p_rid), '') <> 'owner' then
    raise exception 'Owner key required.' using errcode = '42501';
  end if;
  if v_op not in ('list', 'issue', 'revoke') then raise exception 'Unknown table code operation.'; end if;
  if v_op = 'list' then return public.aal_table_tokens_json(p_rid); end if;

  -- nested so the numeric cast only runs on a JSON number
  if jsonb_typeof(p_body->'table') is distinct from 'number' then
    raise exception 'Table must be a whole number from 1 to 9999.';
  end if;
  if (p_body->>'table')::numeric <> trunc((p_body->>'table')::numeric)
     or (p_body->>'table')::numeric not between 1 and 9999 then
    raise exception 'Table must be a whole number from 1 to 9999.';
  end if;
  v_table := (p_body->>'table')::int;
  -- the same venue lock as aal_mutate: codes for one table never interleave
  perform pg_advisory_xact_lock(hashtextextended(p_rid, 0));

  if v_op = 'issue' then
    if not exists (select 1 from public.venue_profiles vp where vp.restaurant_id = p_rid) then
      raise exception 'This venue has no link name (slug) yet. Set its profile in admin first.';
    end if;
    update public.table_tokens set revoked_at = now()
     where restaurant_id = p_rid and table_no = v_table and revoked_at is null;
    insert into public.table_tokens (restaurant_id, table_no, token)
    values (p_rid, v_table, 'tbl_' || encode(gen_random_bytes(24), 'hex'));
  else
    update public.table_tokens set revoked_at = now()
     where restaurant_id = p_rid and table_no = v_table and revoked_at is null;
  end if;
  return public.aal_table_tokens_json(p_rid);
end $$;

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
  select r.id into cid from public.kv_rows r
   where r.restaurant_id = vp.restaurant_id and r.collection = 'aal.checks'
     and coalesce(r.body->>'venueId', r.body->>'restaurantId') = r.restaurant_id
     and r.body->>'table' = p_table::text and r.body->>'closedAt' is null
   order by r.body->>'openedAt' desc nulls last limit 1;
  if cid is not null then
    -- minted exactly as aal_mutate issue_key; never expires (see FOLLOW-UP above)
    k := 'chk_' || encode(gen_random_bytes(24), 'hex');
    insert into public.check_keys (key, restaurant_id, check_id) values (k, vp.restaurant_id, cid);
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

revoke all on function public.aal_table_tokens(text, jsonb) from public;
revoke all on function public.aal_table_session(text, int, text) from public;
grant execute on function public.aal_table_tokens(text, jsonb) to anon, authenticated;
grant execute on function public.aal_table_session(text, int, text) to anon, authenticated;
commit;
