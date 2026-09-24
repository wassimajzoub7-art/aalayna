-- Bill entry on the shared store (T1 on upstream hardening), 2026-09-24.
--
-- Run after hardening-2026-09-15.sql, in the Supabase SQL editor. Safe to re-run:
-- one transaction, only "create or replace function" and grant/revoke statements,
-- no table, column, policy or data changes. Re-running replaces the functions with
-- the same text. It stops without changing anything if the September 15 file has
-- not been applied.
--
-- What changes in aal_mutate (the complete function is replaced below; every other
-- operation is upstream's text, unchanged):
--   open_check    also accepts lines [{id,q,p,name}] (q whole units, p the line
--                 total in dollars). Lines are validated and folded by id, and
--                 totalCents is computed from them. Without lines, totalCents from
--                 the POS is used as before. Server-owned fields (venueId, source,
--                 openedAt, closedAt, revision, ...) are never taken from the
--                 request. A new bill starts at revision 1 and appends order_placed.
--   update_check  new, owner only. Changes an open bill's lines with the demo
--                 store's rules (restaurant-growth.js planCheckUpdate): a closed
--                 bill is refused; lines fold by id; once a payment exists
--                 (confirmed, pending cash, or a digital reservation still in
--                 progress) existing lines cannot be removed, reduced or repriced,
--                 only added; a line with claimed units never drops below the
--                 claim; the total never falls below what is paid. Recomputes
--                 totalCents and amountUsd, bumps revision, sets updatedAt and
--                 source 'staff', appends order_placed {revision, change:'updated'}.
--                 Optional body fields: requestId (an outbox resend of a committed
--                 save returns the bill unchanged) and baseRevision (a save made
--                 from a stale screen is refused).
-- Helpers aal_bill_lines and aal_order_event are only callable by aal_mutate.
-- Also fixes the search path of aal_register_venue and aal_mutate so that
-- gen_random_bytes (pgcrypto, in the "extensions" schema on Supabase) resolves.

begin;
do $$ begin
 if to_regclass('public.check_keys') is null or to_regprocedure('public.aal_check_scope(text)') is null then
  raise exception 'Run hardening-2026-09-15.sql before hardening-2026-09-24.sql';
 end if;
end $$;

-- On Supabase pgcrypto lives in the "extensions" schema. The September 15 file pinned
-- search_path = public, pg_temp on privileged functions, which hides
-- gen_random_bytes from aal_register_venue (and from aal_mutate issue_key). Every
-- function below, and aal_register_venue here, includes "extensions".
alter function public.aal_register_venue(text,text) set search_path = public, extensions, pg_temp;

-- Validate and fold bill lines the way restaurant-growth.js checkLines does.
create or replace function public.aal_bill_lines(p_lines jsonb) returns jsonb
language plpgsql immutable set search_path = public, extensions, pg_temp as $$
declare l jsonb; v_id text; v_q numeric; v_pc numeric; folded jsonb := '[]'::jsonb; pos jsonb := '{}'::jsonb; i int;
begin
 if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'A bill needs a list of items.'; end if;
 for l in select e.value from jsonb_array_elements(p_lines) with ordinality e(value,k) order by e.k loop
  if coalesce(jsonb_typeof(l),'')<>'object' or coalesce(jsonb_typeof(l->'id'),'') not in ('string','number') or coalesce(l->>'id','')=''
     or coalesce(jsonb_typeof(l->'q'),'')<>'number' or coalesce(jsonb_typeof(l->'p'),'')<>'number' then
   raise exception 'Each bill item needs a dish, a whole quantity and a price.';
  end if;
  v_id=l->>'id'; v_q=(l->>'q')::numeric; v_pc=round((l->>'p')::numeric*100);
  if v_q<>trunc(v_q) or v_q<1 or v_q>999 or v_pc<0 or v_pc>9007199254740991 then
   raise exception 'Each bill item needs a dish, a whole quantity and a price.';
  end if;
  if pos ? v_id then
   i=(pos->>v_id)::int;
   folded=jsonb_set(folded,array[i::text],(folded->i)||jsonb_build_object('q',(folded->i->>'q')::numeric+v_q,'pc',(folded->i->>'pc')::numeric+v_pc));
  else
   pos=pos||jsonb_build_object(v_id,jsonb_array_length(folded));
   folded=folded||jsonb_build_array(jsonb_build_object('id',v_id,'q',v_q,'pc',v_pc,
     'name',left(case when jsonb_typeof(l->'name') in ('string','number') then l->>'name' else '' end,120)));
  end if;
 end loop;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','q',(x->>'q')::int,'p',trim_scale(round((x->>'pc')::numeric/100,2)),'name',x->>'name') order by t.k),'[]'::jsonb)
   from jsonb_array_elements(folded) with ordinality t(x,k));
end $$;
revoke all on function public.aal_bill_lines(jsonb) from public, anon, authenticated;

-- The order_placed event the demo store appends (restaurant-growth.js orderEvent):
-- the full line list of this revision; reports count the latest revision per bill.
create or replace function public.aal_order_event(p_rid text,c jsonb,change text,p_body jsonb,stamp text) returns void
language plpgsql set search_path = public, extensions, pg_temp as $$
declare event_id text := gen_random_uuid()::text;
begin
 insert into public.kv_rows values(p_rid,'aal.events',event_id,jsonb_build_object(
  'eventId',event_id,'eventType','order_placed','restaurantId',p_rid,'tableId',c->>'table',
  'deviceId',case when jsonb_typeof(p_body->'deviceId')='string' then p_body->'deviceId' end,
  'sessionId',case when jsonb_typeof(p_body->'sessionId')='string' then p_body->'sessionId' end,
  'customerId',null,'createdAt',stamp,
  'payload',jsonb_build_object('orderId',c->>'id','revision',coalesce((c->>'revision')::int,1),'change',change,'source',c->>'source',
    'items',(select coalesce(jsonb_agg(jsonb_build_object('itemId',x->>'id','qty',(x->>'q')::int,
       'unitPrice',trim_scale(round(round(round((x->>'p')::numeric*100)/(x->>'q')::numeric)/100,2)),'currency','USD') order by t.k),'[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(c->'lines')='array' then c->'lines' else '[]'::jsonb end) with ordinality t(x,k)),
    'total',trim_scale(round((c->>'totalCents')::numeric/100,2)),'currency','USD','fxRateUsed',c->'fxRateUsed',
    'amountUsd',trim_scale(round((c->>'totalCents')::numeric/100,2)))),now());
end $$;
revoke all on function public.aal_order_event(text,jsonb,text,jsonb,text) from public, anon, authenticated;

-- Every protected operation, as in hardening-2026-09-15.sql, plus open_check with
-- lines and update_check. Same signature, so existing grants and callers stay valid.
create or replace function public.aal_mutate(p_rid text,p_op text,p_body jsonb,p_token text default '') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
 owner boolean := coalesce(public.aal_role(p_rid)='owner',false);
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
 if not owner and not provider and scope is null then raise exception 'Access denied'; end if;
 -- Serialise the venue's state, including contact deduplication and check creation.
 perform pg_advisory_xact_lock(hashtextextended(p_rid,0));
 if p_op='open_check' then
  if not owner then raise exception 'Only staff may open a bill'; end if;
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
  if not owner then raise exception 'Only staff may change a bill'; end if;
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
  if not owner then raise exception 'Only staff may issue a bill link'; end if;
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
  if not owner then ev=ev||jsonb_build_object('tableId',(select body->>'table' from public.kv_rows where restaurant_id=p_rid and collection='aal.checks' and id=scope)); end if;
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
 if p is null or (not owner and not provider and p->>'checkId' is distinct from scope) then raise exception 'Payment unavailable'; end if;
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
  if not owner or p->>'rail'<>'cash' then raise exception 'Cash confirmation requires staff'; end if;
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
  if not owner and not token_ok then raise exception 'Wrong payer token'; end if;
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

revoke all on function public.aal_mutate(text,text,jsonb,text) from public;
grant execute on function public.aal_mutate(text,text,jsonb,text) to anon, service_role;
commit;
