-- Staff sign-in with one-time email codes and roles (T4), 2026-09-24.
--
-- Run after sessions-2026-09-24.sql, in the Supabase SQL editor.
-- UNTESTED: written for Postgres 15, not yet run against the live project.
--
-- Before running it, in the Supabase dashboard (Authentication), the founder must:
--   * Providers > Email: enabled; "Confirm email" ON (see "Why confirm email stays
--     on" below); Email OTP length 6; Email OTP expiration 600 seconds.
--   * Emails > Templates: "Magic Link" AND "Confirm signup" both contain the code,
--     {{ .Token }}, e.g. "Your Aalayna sign-in code is {{ .Token }}".
--   * Sign In / Providers: "Allow new users to sign up" ON (the pages send
--     create_user:true; an account alone grants nothing, the staff_members row does).
--   * URL Configuration: Site URL https://aalayna.com; redirect URLs
--     https://aalayna.com/** and http://localhost:8787/** .
--   * SMTP: a custom SMTP sender. Supabase's built-in sender only delivers to the
--     project's team members and a few emails an hour.
--
-- Safe to re-run: one transaction; "create table/index if not exists", "create or
-- replace function", and grant/revoke statements only. No existing row, table or
-- policy is changed. It stops without changing anything if sessions-2026-09-24.sql
-- (and so hardening-2026-09-24.sql and admin.sql) has not been applied, or if the
-- database has no Supabase Auth schema.
--
-- What it adds
--   staff_members       one row per (venue, email): role owner | manager | waiter,
--                       invited_by, created_at, revoked_at. Revoking sets revoked_at;
--                       the row stays as the record. Closed to anon/authenticated:
--                       RLS on, no policies.
--   aal_staff_email()   the caller's email when the request carries a Supabase Auth
--                       session (JWT role 'authenticated') whose user exists in
--                       auth.users with that email confirmed and is not banned;
--                       otherwise ''. Deleting or banning the auth user ends access
--                       at once, without waiting for the JWT to expire.
--   aal_staff_role(rid) that email's live staff role for the venue, or null.
--   aal_role(rid)       REPLACED, same signature. Order: the venue's owner key in
--                       x-aalayna-key -> 'owner'; a signed-in owner or manager ->
--                       'owner'; a signed-in waiter -> 'waiter' (new value); the
--                       guest key -> 'guest'; else null. Every policy and function
--                       that tests aal_role(...)='owner' or ='guest' is unchanged
--                       and keeps working; none of them admits 'waiter'.
--   aal_snapshot(rid)   REPLACED (from hardening-2026-09-15.sql; only the role lines
--                       change). A waiter gets every bill (aal.checks) and payment
--                       (aal.settle, with device, session, customer and payer
--                       references removed as for a guest) and the menu, rate and
--                       floor documents. Never the guest list (aal.guests), the
--                       event stream (aal.events), campaigns, logs, the menu draft
--                       or tips. role in the answer is 'waiter'.
--   aal_mutate(...)     REPLACED. This is the THIRD full replacement of aal_mutate
--                       today (rebuild-2026-09-24.sql, hardening-2026-09-24.sql, this
--                       file). The body is hardening-2026-09-24.sql's text copied
--                       exactly; only the role lines changed, each marked "-- T4 role".
--                       A waiter may:     open_check, update_check, issue_key (bill
--                                         link), confirm_cash, cancel (cash only),
--                                         event.
--                       A waiter may not: close_check, refund, receipt (guest
--                                         contact capture), reserve (a guest's
--                                         payment request), confirm_digital. These
--                                         keep their upstream messages.
--   aal_staff(p_rid, p_body)   staff list management and the caller's memberships.
--                       {op:'mine'}  any signed-in user; p_rid is ignored. Returns
--                          [{restaurant_id, role, name, place, slug}] for the caller's
--                          live memberships (name/place/slug from venue_profiles;
--                          place and slug are null for a venue without a profile).
--                       {op:'list'} | {op:'invite', email, role} |
--                       {op:'revoke', email} | {op:'change_role', email, role}
--                          the venue's owner key (x-aalayna-key), or a signed-in
--                          member whose role is owner (not manager). Each returns
--                          {restaurant_id, staff:[{email, role, invited_by,
--                          created_at, revoked_at}]}, live members first.
--                          invite adds the row (or re-activates a revoked one with
--                          the new role); the person then signs in with a code sent
--                          to that email and the row is what grants access. A
--                          signed-in owner cannot revoke or change their own row
--                          (so nobody locks themselves out by mistake); the owner
--                          key can.
--   Grants: authenticated gets the same table and function privileges anon has on
--   the shared store (kv_docs, kv_rows, aal_snapshot, aal_mutate, aal_check_scope,
--   aal_role, aal_key); the policies decide, exactly as for anon.
--
-- Why confirm email stays on
--   The server trusts the email in the session. With "Confirm email" off, anyone
--   can sign up with a password as someone else's address and receive a session at
--   once, which would pass as that staff member. With it on, a session for an
--   address proves control of its inbox (the six-digit code, or a confirmation
--   link). aal_staff_email() also requires email_confirmed_at in auth.users.
--
-- The owner key keeps working (curl, admin console, qr.html). Access through it is
-- unchanged: it is still a bearer secret for the whole venue.
--
-- Re-running an older file that replaces these functions undoes part of this one:
-- rebuild-2026-09-24.sql restores the key-only aal_role; hardening-2026-09-24.sql and
-- rebuild-2026-09-24.sql restore aal_mutate without waiters; hardening-2026-09-15.sql
-- restores aal_snapshot without waiters. Run this file again after any of them.

begin;
do $$ begin
 if to_regclass('public.table_tokens') is null or to_regprocedure('public.aal_table_session(text,integer,text)') is null then
  raise exception 'Run sessions-2026-09-24.sql before auth-2026-09-24.sql';
 end if;
 if to_regprocedure('public.aal_bill_lines(jsonb)') is null or to_regclass('public.venue_profiles') is null then
  raise exception 'Run hardening-2026-09-24.sql and admin.sql before auth-2026-09-24.sql';
 end if;
 if to_regclass('auth.users') is null then
  raise exception 'auth.users is missing: auth-2026-09-24.sql needs a Supabase project with Supabase Auth';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Staff list
-- ---------------------------------------------------------------------------
create table if not exists public.staff_members (
  restaurant_id text not null references public.venue_keys (restaurant_id) on delete cascade,
  email         text not null check (email = lower(btrim(email)) and length(email) <= 254
                                     and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role          text not null check (role in ('owner', 'manager', 'waiter')),
  invited_by    text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  primary key (restaurant_id, email)
);
create index if not exists staff_members_email on public.staff_members (email) where revoked_at is null;
alter table public.staff_members enable row level security;   -- no policies: closed
revoke all on public.staff_members from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who is calling
-- ---------------------------------------------------------------------------
-- The signed-in staff email, from the Supabase Auth session (PostgREST puts the
-- verified JWT claims in request.jwt.claims). The user must still exist, with this
-- email confirmed and no ban. '' for anon, the service role and anything else.
create or replace function public.aal_staff_email() returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  with c as (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as j)
  select case when c.j ->> 'role' = 'authenticated' and coalesce(c.j ->> 'email', '') <> ''
                   and coalesce(c.j ->> 'sub', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then coalesce((
      select lower(u.email) from auth.users u
       where u.id = (c.j ->> 'sub')::uuid
         and lower(u.email) = lower(c.j ->> 'email')
         and u.email_confirmed_at is not null
         and (u.banned_until is null or u.banned_until <= now())), '')
    else '' end
  from c
$$;

create or replace function public.aal_staff_role(p_rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select s.role from public.staff_members s
   where s.restaurant_id = p_rid and s.revoked_at is null
     and s.email = public.aal_staff_email() and s.email <> ''
$$;

-- Same signature and parameter name as migration.sql, so every policy that calls it
-- keeps working. 'waiter' is new; nothing that tests for 'owner' or 'guest' admits it.
create or replace function public.aal_role(rid text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  with s as (select public.aal_staff_role(rid) as r)
  select case
    when public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = rid and v.owner_key = public.aal_key()) then 'owner'
    when s.r in ('owner', 'manager') then 'owner'
    when s.r = 'waiter' then 'waiter'
    when public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = rid and v.guest_key = public.aal_key()) then 'guest'
    else null end
  from s
$$;

-- ---------------------------------------------------------------------------
-- Guest-safe reads, with a waiter projection (hardening-2026-09-15.sql's text;
-- only the lines marked "-- T4 role" changed)
-- ---------------------------------------------------------------------------
create or replace function public.aal_snapshot(p_rid text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text := public.aal_role(p_rid); -- T4 role
 owner boolean := coalesce(v_role='owner',false); -- T4 role
 waiter boolean := coalesce(v_role='waiter',false); -- T4 role
 cid text := public.aal_check_scope(p_rid); rs jsonb; ds jsonb;
begin
 if not owner and not waiter and cid is null then raise exception 'Open a current bill link or sign in with this restaurant owner key.'; end if; -- T4 role
 select coalesce(jsonb_agg(jsonb_build_object('collection',collection,'id',id,'body',
 case when owner or collection='aal.checks' then body else body - array['deviceId','sessionId','customerId','identityId','payerRef','externalRef'] end,'updated_at',updated_at)), '[]') into rs
 from public.kv_rows where restaurant_id=p_rid and coalesce(body->>'venueId',body->>'restaurantId')=restaurant_id and (owner or
 (waiter and collection in ('aal.checks','aal.settle')) or -- T4 role: bills and payments, never guests or events
 (collection='aal.checks' and id=cid) or (collection='aal.settle' and body->>'checkId'=cid));
 select coalesce(jsonb_agg(jsonb_build_object('key',key,'body',body,'updated_at',updated_at)),'[]') into ds
 from public.kv_docs where restaurant_id=p_rid and (owner or key in ('aal.live','aal.rate','aal.rate_meta') or (waiter and key='aal.floor')); -- T4 role
 return jsonb_build_object('version',2,'role',case when owner then 'owner' when waiter then 'waiter' else 'guest' end,'checkId',cid,'rows',rs,'docs',ds); -- T4 role
end $$;

-- ---------------------------------------------------------------------------
-- Protected operations: hardening-2026-09-24.sql's aal_mutate copied exactly; only
-- the lines marked "-- T4 role" changed. Same signature, so callers stay valid.
-- ---------------------------------------------------------------------------
create or replace function public.aal_mutate(p_rid text,p_op text,p_body jsonb,p_token text default '') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
 v_role text := public.aal_role(p_rid); -- T4 role
 owner boolean := coalesce(v_role='owner',false); -- T4 role: key owner, or a signed-in owner or manager
 waiter boolean := coalesce(v_role='waiter',false); -- T4 role
 staff boolean := owner or waiter; -- T4 role
 provider boolean := coalesce(current_setting('request.jwt.claims',true)::jsonb->>'role','')='service_role';
 scope text := public.aal_check_scope(p_rid); cid text; pid text; rid text;
 c jsonb; p jsonb; previous jsonb; g jsonb; result jsonb;
 amount bigint; tip bigint; used bigint; qty numeric; claim record; line jsonb;
 contact text; channel text; gid text; stamp text := to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 event_type text; ev jsonb; event_id text; token_ok boolean;
 -- bill entry (2026-09-24)
 bill_lines jsonb; bill_total bigint; paid_confirmed bigint; paid_pending bigint; claims jsonb;
 o jsonb; n jsonb; label text; rev int;
begin
 if not staff and not provider and scope is null then raise exception 'Access denied'; end if; -- T4 role
 -- Serialise the venue's state, including contact deduplication and check creation.
 perform pg_advisory_xact_lock(hashtextextended(p_rid,0));
 if p_op='open_check' then
  if not staff then raise exception 'Only staff may open a bill'; end if; -- T4 role
  -- 2026-09-24: an itemised bill sends lines {id,q,p,name} (p = line total in dollars);
  -- they are validated and folded by id here and the total is computed from them.
  -- A bill without lines keeps the upstream path: totalCents copied from the POS.
  if jsonb_typeof(p_body->'lines')='array' and jsonb_array_length(p_body->'lines')>0 then
   bill_lines=public.aal_bill_lines(p_body->'lines');
   select coalesce(sum(round((l->>'p')::numeric*100)),0)::bigint into bill_total from jsonb_array_elements(bill_lines) l;
  else
   bill_lines='[]'::jsonb; bill_total=(p_body->>'totalCents')::bigint;
  end if;
  if coalesce(p_body->>'id','')='' or coalesce(bill_total,0)<=0 or coalesce((p_body->>'table')::int,0)<1 then raise exception 'Invalid bill'; end if;
  select body into result from public.kv_rows where restaurant_id=p_rid and collection='aal.checks'
    and body->>'table'=((p_body->>'table')::int)::text and body->>'closedAt' is null limit 1;
  if result is null then
   -- server-owned fields are never taken from the request
   result=(p_body - array['venueId','source','openedAt','closedAt','updatedAt','revision','lastRequestId','lines','totalCents','amountUsd','table','deviceId','sessionId'])
     || jsonb_build_object('venueId',p_rid,'source','staff','openedAt',stamp,'table',(p_body->>'table')::int,'lines',bill_lines,
        'totalCents',bill_total,'amountUsd',trim_scale(round(bill_total/100.0,2)),'revision',1);
   insert into public.kv_rows values(p_rid,'aal.checks',result->>'id',result,now());
   perform public.aal_order_event(p_rid,result,'opened',p_body,stamp);
  end if;
  return result;
 end if;
 -- 2026-09-24: staff change an open bill's lines. The rules are the demo store's
 -- (restaurant-growth.js planCheckUpdate), applied here under the venue lock.
 if p_op='update_check' then
  if not staff then raise exception 'Only staff may change a bill'; end if; -- T4 role
  cid=p_body->>'checkId';
  select body into c from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  if c is null then raise exception 'This bill is not available for this restaurant.'; end if;
  -- an outbox resend of a save that already committed returns the bill unchanged
  if coalesce(p_body->>'requestId','')<>'' and c->>'lastRequestId'=p_body->>'requestId' then return c; end if;
  if c->>'closedAt' is not null then raise exception 'This bill is closed. Open a new bill for the table instead.'; end if;
  -- the editing device saw this revision; a save from a stale screen is refused
  if p_body ? 'baseRevision' and coalesce((c->>'revision')::int,1)<>(p_body->>'baseRevision')::int then
   raise exception 'This bill was changed on another device. It has been reloaded; enter your changes again.';
  end if;
  bill_lines=public.aal_bill_lines(p_body->'lines');
  select coalesce(sum(round((l->>'p')::numeric*100)),0)::bigint into bill_total from jsonb_array_elements(bill_lines) l;
  -- what is paid: confirmed, plus reserved (pending cash, digital in progress), as reserve counts it
  select coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)) filter (where body->>'status'='confirmed'),0)::bigint,
         coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)) filter (where body->>'status'<>'confirmed'),0)::bigint
    into paid_confirmed, paid_pending
    from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid
     and body->>'refunded' is null and body->>'cancelled' is null
     and (body->>'status' in ('pending','confirmed') or (body->>'status'='initiated' and (body->>'expiresAt')::timestamptz>now()));
  select coalesce(jsonb_object_agg(k,q),'{}'::jsonb) into claims from (
   select i.key k, sum(i.value::numeric) q from public.kv_rows r,
     jsonb_each_text(case when jsonb_typeof(r.body->'items')='object' then r.body->'items' else '{}'::jsonb end) i
    where r.restaurant_id=p_rid and r.collection='aal.settle' and r.body->>'checkId'=cid
     and r.body->>'refunded' is null and r.body->>'cancelled' is null
     and (r.body->>'status' in ('pending','confirmed') or (r.body->>'status'='initiated' and (r.body->>'expiresAt')::timestamptz>now()))
    group by i.key) t;
  -- a line with claimed units cannot disappear or drop below the claim
  for o in select value from jsonb_array_elements(case when jsonb_typeof(c->'lines')='array' then c->'lines' else '[]'::jsonb end) loop
   select value into n from jsonb_array_elements(bill_lines) where value->>'id'=o->>'id' limit 1;
   if coalesce((claims->>(o->>'id'))::numeric,0)>0 and (n is null or (n->>'q')::numeric<(claims->>(o->>'id'))::numeric) then
    select i->>'name' into label from public.kv_docs d,
      jsonb_array_elements(case when jsonb_typeof(d.body->'items')='array' then d.body->'items' else '[]'::jsonb end) i
     where d.restaurant_id=p_rid and d.key='aal.live' and i->>'id'=o->>'id' limit 1;
    raise exception '% is covered by a payment and cannot be removed.', coalesce(nullif(label,''),nullif(o->>'name',''),'This item');
   end if;
  end loop;
  -- once any payment exists, existing lines can only grow, never shrink, vanish or change price
  if paid_confirmed+paid_pending>0 then
   for o in select value from jsonb_array_elements(case when jsonb_typeof(c->'lines')='array' then c->'lines' else '[]'::jsonb end) loop
    select value into n from jsonb_array_elements(bill_lines) where value->>'id'=o->>'id' limit 1;
    if n is null or (n->>'q')::numeric<(o->>'q')::numeric then
     raise exception 'A payment is recorded on this bill. Items can be added, not removed or reduced.';
    end if;
    if round((n->>'p')::numeric*100)*(o->>'q')::numeric<>round((o->>'p')::numeric*100)*(n->>'q')::numeric then
     raise exception 'A payment is recorded on this bill. Prices of existing items cannot change.';
    end if;
   end loop;
  end if;
  if bill_total<paid_confirmed+paid_pending then raise exception 'The new total is below what has already been paid.'; end if;
  rev=coalesce((c->>'revision')::int,1)+1;
  c=c||jsonb_build_object('lines',bill_lines,'totalCents',bill_total,'amountUsd',trim_scale(round(bill_total/100.0,2)),
     'revision',rev,'updatedAt',stamp,'source','staff','lastRequestId',nullif(p_body->>'requestId',''));
  update public.kv_rows set body=c where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  perform public.aal_order_event(p_rid,c,'updated',p_body,stamp);
  return c;
 end if;
 if p_op='issue_key' then
  if not staff then raise exception 'Only staff may issue a bill link'; end if; -- T4 role
  cid=p_body->>'checkId';
  if not exists(select 1 from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid and body->>'closedAt' is null) then raise exception 'Bill unavailable'; end if;
  rid='chk_'||encode(gen_random_bytes(24),'hex');
  insert into public.check_keys(key,restaurant_id,check_id) values(rid,p_rid,cid);
  return jsonb_build_object('key',rid,'checkId',cid);
 end if;
 if p_op='event' then
  event_type=p_body->>'eventType';
  if event_type not in ('qr_scan','item_view','bill_requested','ui_action','review_submitted') then raise exception 'This event requires a server operation'; end if;
  ev=p_body || jsonb_build_object('restaurantId',p_rid,'createdAt',stamp,'customerId',null);
  if not staff then ev=ev||jsonb_build_object('tableId',(select body->>'table' from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=scope)); end if; -- T4 role
  insert into public.kv_rows values(p_rid,'aal.events',ev->>'eventId',ev,now()) on conflict do nothing;
  return ev;
 end if;
 pid=p_body->>'id';
 if p_op='reserve' then
  cid=p_body->>'checkId';
  if not owner and cid is distinct from scope then raise exception 'Wrong bill'; end if;
  if length(p_token)<32 then raise exception 'Missing payer token'; end if;
  select body into previous from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and id=pid;
  if previous is not null then
   if not exists(select 1 from public.payment_secrets where restaurant_id=p_rid and payment_id=pid and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')) then raise exception 'Wrong payer token'; end if;
   if previous->>'checkId' is distinct from cid or previous->'amount' is distinct from p_body->'amount' or previous->'tip' is distinct from p_body->'tip' or previous->'rail' is distinct from p_body->'rail' or previous->'items' is distinct from p_body->'items' then raise exception 'Payment request changed'; end if;
   return previous;
  end if;
  amount=round((p_body->>'amount')::numeric*100); tip=round(coalesce((p_body->>'tip')::numeric,0)*100);
  if coalesce(amount,0)<=0 or tip<0 or tip>=amount or coalesce(p_body->>'rail','') not in ('cash','card','whish') then raise exception 'Invalid amount'; end if;
  select body into c from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  if c is null or c->>'closedAt' is not null then raise exception 'Bill closed or unavailable'; end if;
  select coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)),0) into used
  from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid
   and body->>'refunded' is null and body->>'cancelled' is null
   and (body->>'status' in ('pending','confirmed') or (body->>'status'='initiated' and (body->>'expiresAt')::timestamptz>now()));
  if used+amount-tip>(c->>'totalCents')::bigint then raise exception 'Another payment already covers this balance. Refresh your bill.'; end if;
  used=0;
  for claim in select key,value from jsonb_each_text(coalesce(p_body->'items','{}')) loop
   qty=claim.value::numeric;
   select value into line from jsonb_array_elements(c->'lines') where value->>'id'=claim.key;
   if line is null or qty<=0 or qty<>trunc(qty) then raise exception 'Invalid item selection'; end if;
   if qty+coalesce((select sum(coalesce((body->'items'->>claim.key)::numeric,0)) from public.kv_rows
     where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid and body->>'refunded' is null and body->>'cancelled' is null
      and (body->>'status' in ('pending','confirmed') or (body->>'status'='initiated' and (body->>'expiresAt')::timestamptz>now()))),0)>(line->>'q')::numeric then raise exception 'Item already reserved'; end if;
   used=used+round((line->>'p')::numeric*100/(line->>'q')::numeric*qty);
  end loop;
  if coalesce(p_body->'items','{}')<>'{}'::jsonb and used<>amount-tip then raise exception 'Items do not match the amount'; end if;
  if p_body->>'rail'='cash' and coalesce((p_body->>'note')::numeric,0)>0 and (p_body->>'note')::numeric*100<amount then raise exception 'Not enough cash'; end if;
  p=jsonb_build_object('id',pid,'requestId',p_body->>'requestId','venueId',p_rid,'checkId',cid,'table',c->'table',
    'rail',p_body->>'rail','amount',amount/100.0,'tip',tip/100.0,'items',coalesce(p_body->'items','{}'),
    'deviceId',p_body->>'deviceId','sessionId',p_body->>'sessionId','server',p_body->>'server','currency','USD','amountUsd',amount/100.0,
    'fxRateUsed',c->'fxRateUsed','note',coalesce((p_body->>'note')::numeric,0),'change',case when p_body->>'rail'='cash' then greatest(0,coalesce((p_body->>'note')::numeric,0)-amount/100.0) else 0 end,
    'status',case when p_body->>'rail'='cash' then 'pending' else 'initiated' end,'ts',stamp,
    'expiresAt',case when p_body->>'rail'<>'cash' then to_jsonb(now()+interval '10 minutes') else 'null'::jsonb end);
  insert into public.kv_rows values(p_rid,'aal.settle',pid,p,now());
  insert into public.payment_secrets values(p_rid,pid,encode(sha256(convert_to(p_token,'UTF8')),'hex'));
  return p;
 end if;
 if p_op='close_check' then
  if not owner then raise exception 'Only staff may close a bill'; end if;
  cid=p_body->>'checkId';
  select body into c from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=cid;
  select coalesce(sum(round((body->>'amount')::numeric*100)-round(coalesce((body->>'tip')::numeric,0)*100)),0) into used from public.kv_rows
    where restaurant_id=p_rid and collection='aal.settle' and body->>'checkId'=cid and body->>'status'='confirmed' and body->>'refunded' is null;
  if c is null or used<>(c->>'totalCents')::bigint then raise exception 'Bill is not fully settled'; end if;
  c=c||jsonb_build_object('closedAt',stamp); update public.kv_rows set body=c where restaurant_id=p_rid and collection='aal.checks' and id=cid; return c;
 end if;
 select body into p from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and id=pid;
 if p is null or (not staff and not provider and p->>'checkId' is distinct from scope) then raise exception 'Payment unavailable'; end if; -- T4 role
 token_ok=exists(select 1 from public.payment_secrets where restaurant_id=p_rid and payment_id=pid and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex'));
 if p_op='receipt' then
  if not owner and not token_ok then raise exception 'Wrong payer token'; end if;
  if p->>'status'<>'confirmed' or p->>'refunded' is not null then raise exception 'Payment must be confirmed'; end if;
  if jsonb_typeof(p_body->'receipt') is distinct from 'boolean' or jsonb_typeof(p_body->'marketing') is distinct from 'boolean' then raise exception 'Separate permissions required'; end if;
  contact=trim(p_body->>'contact'); channel=p_body->>'channel';
  if channel='email' then contact=lower(contact); if contact !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  elsif channel='whatsapp' then if contact !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'International number required'; end if;
  else raise exception 'Invalid channel'; end if;
  select body into g from public.kv_rows where restaurant_id=p_rid and collection='aal.guests' and body->>'contact'=contact limit 1;
  if g is null then g=jsonb_build_object('id',gen_random_uuid()::text,'venueId',p_rid,'contact',contact,'channel',channel,'createdAt',stamp,'consentHistory','[]'::jsonb); end if;
  gid=g->>'id';
  if p->>'customerId' is not null and p->>'customerId'<>gid then raise exception 'Payment already linked'; end if;
  -- Repeated transport delivery is idempotent; later explicit choices remain audited.
  if not exists(select 1 from jsonb_array_elements(g->'consentHistory') h where h->>'requestId'=p_body->>'requestId') then
   g=g||jsonb_build_object('receipt',p_body->'receipt','marketing',p_body->'marketing','consentHistory',(g->'consentHistory')||jsonb_build_array(jsonb_build_object('at',stamp,'source','receipt','version','restaurant-offers-v1','settlementId',pid,'requestId',p_body->>'requestId','receipt',p_body->'receipt','marketing',p_body->'marketing')));
   insert into public.kv_rows values(p_rid,'aal.guests',gid,g,now()) on conflict(restaurant_id,collection,id) do update set body=excluded.body;
   p=p||jsonb_build_object('customerId',gid);update public.kv_rows set body=p where restaurant_id=p_rid and collection='aal.settle' and id=pid;
  end if;
  return jsonb_build_object('saved',true); -- Never return an existing contact's history to a guest.
 elsif p_op='confirm_cash' then
  if not staff or p->>'rail'<>'cash' then raise exception 'Cash confirmation requires staff'; end if; -- T4 role
  if p->>'status'='confirmed' then return p; end if;
  if p->>'status'<>'pending' or p->>'cancelled' is not null then raise exception 'Cash request changed'; end if;
  p=p||jsonb_build_object('status','confirmed','confirmedAt',stamp); event_type='payment_completed';
 elsif p_op='confirm_digital' then
  if not provider then raise exception 'Verified provider callback required'; end if;
  if p->>'externalRef'=p_body->>'externalRef' and p->>'status'='confirmed' then return p; end if;
  if p->>'status'<>'initiated' or (p->>'expiresAt')::timestamptz<=now() then raise exception 'Reservation expired or changed; reconcile received funds'; end if;
  if coalesce(p_body->>'externalRef','')='' or p_body->>'currency' is distinct from p->>'currency' or (p_body->>'amountCents')::bigint is distinct from round((p->>'amount')::numeric*100)::bigint then raise exception 'Callback amount, currency or reference mismatch'; end if;
  if exists(select 1 from public.kv_rows where restaurant_id=p_rid and collection='aal.settle' and body->>'externalRef'=p_body->>'externalRef') then raise exception 'Duplicate provider reference'; end if;
  p=p||jsonb_build_object('status','confirmed','confirmedAt',stamp,'externalRef',p_body->>'externalRef'); event_type='payment_completed';
 elsif p_op='cancel' then
  if not owner and not token_ok and not (waiter and p->>'rail'='cash') then raise exception 'Wrong payer token'; end if; -- T4 role
  if p->>'status' in ('cancelled','expired','failed') then return p; end if;
  if p->>'status' not in ('pending','initiated') then raise exception 'Payment already completed'; end if;
  p=p||jsonb_build_object('status','cancelled','cancelled',stamp); event_type='payment_cancelled';
 elsif p_op='refund' then
  if not owner or p->>'rail'<>'cash' then raise exception 'Digital refunds require the payment provider integration'; end if;
  if p->>'refunded' is not null then return p; end if;
  if p->>'status'<>'confirmed' then raise exception 'Only confirmed cash can be refunded'; end if;
  p=p||jsonb_build_object('refunded',stamp); event_type='payment_refunded';
 else raise exception 'Unknown operation'; end if;
 update public.kv_rows set body=p where restaurant_id=p_rid and collection='aal.settle' and id=pid;
 event_id=gen_random_uuid()::text;
 ev=jsonb_build_object('eventId',event_id,'eventType',event_type,'restaurantId',p_rid,'tableId',p->'table','deviceId',p->'deviceId','sessionId',p->'sessionId','createdAt',stamp,'customerId',p->'customerId','payload',jsonb_build_object('paymentId',pid,'orderId',p->>'checkId','amount',p->'amount','tip',p->'tip','rail',p->'rail','currency',p->'currency','amountUsd',p->'amountUsd'));
 insert into public.kv_rows values(p_rid,'aal.events',event_id,ev,now());
 return p;
end $$;

-- ---------------------------------------------------------------------------
-- Staff list management
-- ---------------------------------------------------------------------------
create or replace function public.aal_staff_json(p_rid text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('restaurant_id', p_rid, 'staff', coalesce((
    select jsonb_agg(jsonb_build_object('email', s.email, 'role', s.role, 'invited_by', s.invited_by,
                                        'created_at', s.created_at, 'revoked_at', s.revoked_at)
                     order by (s.revoked_at is not null), array_position(array['owner','manager','waiter'], s.role), s.email)
      from public.staff_members s where s.restaurant_id = p_rid), '[]'::jsonb))
$$;
revoke all on function public.aal_staff_json(text) from public, anon, authenticated;

create or replace function public.aal_staff(p_rid text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
  v_body  jsonb := coalesce(p_body, '{}'::jsonb);
  v_op    text;
  v_me    text := public.aal_staff_email();
  v_key   boolean;
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
      select jsonb_agg(jsonb_build_object('restaurant_id', s.restaurant_id, 'role', s.role,
                                          'name', coalesce(vp.name, vk.name), 'place', vp.place, 'slug', vp.slug)
                       order by lower(coalesce(vp.name, vk.name, s.restaurant_id)))
        from public.staff_members s
        join public.venue_keys vk on vk.restaurant_id = s.restaurant_id
        left join public.venue_profiles vp on vp.restaurant_id = s.restaurant_id
       where s.email = v_me and s.revoked_at is null), '[]'::jsonb);
  end if;

  -- everything else: the venue's owner key, or a signed-in owner (not a manager)
  v_key := public.aal_key() <> '' and exists (select 1 from public.venue_keys v where v.restaurant_id = p_rid and v.owner_key = public.aal_key());
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
         set role = v_role, invited_by = case when v_key then 'owner key' else v_me end, created_at = now(), revoked_at = null
       where restaurant_id = p_rid and email = v_email;
    else
      insert into public.staff_members (restaurant_id, email, role, invited_by)
      values (p_rid, v_email, v_role, case when v_key then 'owner key' else v_me end);
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
-- Privileges. authenticated gets exactly what anon has on the shared store; the
-- row-level policies and the functions decide what either may do.
-- ---------------------------------------------------------------------------
revoke all on function public.aal_staff_email() from public, anon, authenticated;
revoke all on function public.aal_staff_role(text) from public, anon, authenticated;
revoke all on function public.aal_staff(text, jsonb) from public;
grant execute on function public.aal_staff(text, jsonb) to anon, authenticated;
grant execute on function public.aal_role(text) to anon, authenticated;
grant execute on function public.aal_key() to anon, authenticated;
grant execute on function public.aal_check_scope(text) to anon, authenticated;
revoke all on function public.aal_snapshot(text) from public;
grant execute on function public.aal_snapshot(text) to anon, authenticated;
revoke all on function public.aal_mutate(text,text,jsonb,text) from public;
grant execute on function public.aal_mutate(text,text,jsonb,text) to anon, authenticated, service_role;
grant select, insert, update, delete on public.kv_docs, public.kv_rows to authenticated;
commit;
