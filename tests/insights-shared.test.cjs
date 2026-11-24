/* Insights in shared mode (supabase/insights-2026-11-24.sql, insights-panel.js).
   Proves:
   - the SQL (static always; against PostgreSQL with PGLITE_MODULE): an owner (key, or a manager
     signed in) reads their venue's events for the period; a waiter, a guest key, another venue's
     owner and nobody get nothing; the window is [since, until), capped at 90 days and at now; the
     rows are narrowed to what owner-insights.js reads (no customerId, user agent, payer or provider
     reference, unit price); the answer says when the row cap cut it; the insights computed from the
     answer equal those computed from the venue's full event log;
   - the panel: in shared mode it asks the server once per period (again on Refresh), keeps the answer
     in memory only (nothing written to storage), falls back to the device's events with a note when
     the function is missing (404) or fails, and never asks in the demo or for a waiter. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8'),DAY=86400000;
const plain=x=>JSON.parse(JSON.stringify(x)),flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const SQL=read('supabase/insights-2026-11-24.sql');
function mem(m){return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}};}
function store(search=''){
 const map=new Map(),storage=mem(map),window={location:{search},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js','owner-insights.js','insights-demo.js'])vm.runInContext(read(f),ctx,{filename:f});
 return {a:window.Aalayna,map};
}
const texts=r=>r.insights.map(i=>i.id+' | '+i.text);

test('insights SQL: an owner-only, read-only reader with a 90-day window, a row cap and narrowed rows',()=>{
 assert.match(SQL,/create or replace function public\.aal_insights_events\(p_rid text, p_body jsonb default '\{\}'::jsonb\) returns jsonb\s*language plpgsql stable security definer/);
 assert.match(SQL,/if coalesce\(public\.aal_role\(p_rid\), ''\) <> 'owner' then\s*raise exception 'Only the venue''s owner or a manager can read its insights\.' using errcode = '42501';/);
 assert.match(SQL,/v_limit int := 40000;/);assert.match(SQL,/interval '90 days'/);
 assert.match(SQL,/create index if not exists kv_rows_events_created on public\.kv_rows \(restaurant_id, \(body->>'createdAt'\)\) where collection = 'aal\.events';/);
 assert.match(SQL,/revoke all on function public\.aal_insights_keep\(jsonb, text\[\]\) from public, anon, authenticated;/);
 assert.match(SQL,/revoke all on function public\.aal_insights_row\(jsonb\) from public, anon, authenticated;/);
 assert.match(SQL,/revoke all on function public\.aal_insights_events\(text, jsonb\) from public;\s*grant execute on function public\.aal_insights_events\(text, jsonb\) to anon, authenticated;/);
 assert.doesNotMatch(SQL.replace(/--.*$/gm,''),/\b(insert|update|delete)\b/i,'nothing written');
 assert.doesNotMatch(SQL.replace(/--.*$/gm,''),/customerId|userAgent|payerRef|externalRef/,'never asks for guest or payer fields');
 assert.match(read('supabase/README.md'),/insights-2026-11-24\.sql/);
});

const modulePath=process.env.PGLITE_MODULE;
test('insights SQL against PostgreSQL: who reads, the window, the narrowing, the cap, and the same insights',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>read('supabase/'+f).replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
  await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql',
   'followups-2026-09-24.sql','theme-2026-09-28.sql','daily-close-2026-09-30.sql','payments-2026-09-30.sql','integrations-2026-09-30.sql','payment-start-2026-10-14.sql',
   'groups-2026-10-28.sql','close-narrative-2026-10-28.sql','review-fixes-2026-11-10.sql','insights-2026-11-24.sql','insights-2026-11-24.sql'])await db.exec(sql(f));
  const U={mona:'11111111-1111-4111-8111-111111111111',sam:'33333333-3333-4333-8333-333333333333'};
  for(const [n,u] of Object.entries(U))await db.query('insert into auth.users values($1,$2,now(),null)',[u,n+'@g.example']);
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers,claims)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify(claims||{role})]);await db.exec('set role '+role);};
  const who=n=>({role:'authenticated',sub:U[n],email:n+'@g.example'});
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  await as('anon',{'x-aalayna-admin':'adm_test'});
  const A=await one("select aal_admin_register_venue('Mayda','Hamra','hamra','{}'::jsonb) as value");
  const B=await one("select aal_admin_register_venue('Other','Gemmayzeh','other','{}'::jsonb) as value");
  await db.exec('reset role');
  await db.query("insert into staff_members(restaurant_id,email,role) values($1,'mona@g.example','manager'),($1,'sam@g.example','waiter')",[A.restaurant_id]);
  /* Hamra's history: the demo's six weeks, as the server would hold it, plus the fields that must never leave */
  const now=Date.now(),demo=store().a,items=demo.published().items;
  const events=demo.demoInsightEvents({items,at:now,venueId:A.restaurant_id}).map(e=>{const b=Object.assign({},e);delete b.demo;b.customerId='cust-1';
   if(b.eventType==='qr_scan')b.payload=Object.assign({},b.payload,{userAgent:'Mozilla/5.0'});
   if(b.eventType==='payment_completed')b.payload=Object.assign({},b.payload,{payerRef:'+9613000000',externalRef:'prov_1'});return b;});
  const phone=events.find(e=>Date.parse(e.createdAt)>=now-29*DAY).deviceId;   // a phone of this month
  const extra=[
   {eventId:'old-1',eventType:'qr_scan',createdAt:new Date(now-200*DAY).toISOString(),sessionId:'s-old',deviceId:phone,tableId:'1',restaurantId:A.restaurant_id,payload:{}},
   {eventId:'rev-1',eventType:'review_submitted',createdAt:new Date(now-DAY).toISOString(),sessionId:'s-r',deviceId:'d-r',restaurantId:A.restaurant_id,payload:{rating:5,comment:'lovely'}},
   {eventId:'stray',eventType:'item_view',createdAt:new Date(now-DAY).toISOString(),sessionId:'s-x',deviceId:'d-x',restaurantId:B.restaurant_id,payload:{itemId:'i01'}}];
  for(const e of events.concat(extra))await db.query("insert into kv_rows(restaurant_id,collection,id,body) values($1,'aal.events',$2,$3)",[A.restaurant_id,e.eventId,JSON.stringify(e)]);
  await db.query("insert into kv_rows(restaurant_id,collection,id,body) values($1,'aal.events','b-1',$2)",[B.restaurant_id,JSON.stringify({eventId:'b-1',eventType:'qr_scan',createdAt:new Date(now-DAY).toISOString(),restaurantId:B.restaurant_id,sessionId:'b',deviceId:'b',payload:{}})]);
  const ask=(body,rid=A.restaurant_id)=>one('select aal_insights_events($1,$2) as value',[rid,JSON.stringify(body||{})]);
  const since=new Date(now-30*DAY).toISOString(),until=new Date(now).toISOString();
  /* who reads */
  await as('anon',{'x-aalayna-key':A.owner_key});const res=await ask({since,until});
  await as('authenticated',{},who('mona'));assert.equal((await ask({since,until})).count,res.count,'a manager has owner rights, as in every owner read');
  for(const [label,run] of [['waiter',()=>as('authenticated',{},who('sam'))],['guest key',()=>as('anon',{'x-aalayna-key':A.guest_key})],
   ['another venue owner',()=>as('anon',{'x-aalayna-key':B.owner_key})],['nobody',()=>as('anon',{})]]){
   await run();await assert.rejects(ask({since,until}),e=>/Only the venue's owner or a manager/.test(e.message)&&e.code==='42501',label);
  }
  await as('anon',{'x-aalayna-key':B.owner_key});assert.deepEqual((await ask({since,until},B.restaurant_id)).events.map(e=>e.eventId),['b-1'],'B reads B only');
  /* the window and the narrowing */
  await as('anon',{'x-aalayna-key':A.owner_key});
  const inWin=events.filter(e=>e.createdAt>=since&&e.createdAt<until&&e.eventType!=='review_submitted');
  assert.equal(res.version,1);assert.equal(res.truncated,false);assert.equal(res.clamped,false);assert.equal(res.limit,40000);
  assert.equal(res.count,inWin.length);assert.deepEqual(plain(res.events.map(e=>e.eventId).sort()),plain(inWin.map(e=>e.eventId).sort()));
  assert.ok(!res.events.some(e=>e.eventId==='rev-1'||e.eventId==='stray'||e.eventId==='old-1'),'reviews, a row claiming another venue, and older rows stay out');
  const keys=new Set(),pkeys=new Set();for(const e of res.events){Object.keys(e).forEach(k=>keys.add(k));Object.keys(e.payload).forEach(k=>pkeys.add(k));}
  assert.deepEqual([...keys].sort(),['createdAt','deviceId','eventId','eventType','payload','restaurantId','sessionId','tableId']);
  for(const k of pkeys)assert.ok(['itemId','categoryId','action','value','n','orderId','revision','items','paymentId','rail','method','amount','amountUsd','currency','tip'].includes(k),k);
  const order=res.events.find(e=>e.eventType==='order_placed');assert.deepEqual(Object.keys(order.payload.items[0]).sort(),['itemId','qty']);
  assert.ok(!JSON.stringify(res).match(/cust-1|Mozilla|\+9613000000|prov_1|lovely/),'no guest, payer or provider data');
  assert.equal(res.firstEventAt,extra[0].createdAt,'the venue\'s first event of any date');
  assert.equal(res.deviceFirstSeen[phone],extra[0].createdAt,'a phone seen 200 days ago');
  const asc=res.events.map(e=>e.createdAt);assert.deepEqual(asc,asc.slice().sort(),'oldest first');
  // bounds: since is in, until is out; until in the future is now; more than 90 days is clamped
  const t0=inWin[10].createdAt,t1=inWin[20].createdAt,part=await ask({since:t0,until:t1});
  assert.ok(part.events.length&&part.events.every(e=>e.createdAt>=t0&&e.createdAt<t1));assert.ok(part.events.some(e=>e.createdAt===t0));assert.ok(!part.events.some(e=>e.createdAt===t1));
  const future=await ask({since,until:new Date(now+10*DAY).toISOString()});assert.ok(Date.parse(future.until)<=Date.now()+1000);
  const long=await ask({since:new Date(now-200*DAY).toISOString(),until});assert.equal(long.clamped,true);assert.equal(Date.parse(long.until)-Date.parse(long.since),90*DAY);
  await assert.rejects(ask({since:'not a time'}),/since and until must be ISO times/);
  /* the same insights from the answer as from the full log on the device */
  const full=demo.computeInsights({events:events.concat(extra.filter(e=>e.restaurantId===A.restaurant_id)),items,sections:demo.published().sections,at:now,days:30});
  const fromServer=demo.computeInsights({events:res.events,items,sections:demo.published().sections,at:now,days:30,firstEventAt:res.firstEventAt,deviceFirstSeen:res.deviceFirstSeen});
  assert.ok(full.insights.length>=12);assert.deepEqual(plain(texts(fromServer)),plain(texts(full)));assert.equal(fromServer.daysCollected,full.daysCollected);
  /* the row cap: the newest 40,000 are kept and the answer says so */
  await db.exec('reset role');
  await db.query("insert into kv_rows(restaurant_id,collection,id,body) select $1,'aal.events','x'||g, jsonb_build_object('eventId','x'||g,'eventType','item_view','restaurantId',$1::text,'sessionId','s'||g,'deviceId','d','createdAt',to_char((now() - interval '1 day' + g * interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'payload',jsonb_build_object('itemId','i01')) from generate_series(1,40005) g",[B.restaurant_id]);
  await as('anon',{'x-aalayna-key':B.owner_key});
  const big=await ask({since,until},B.restaurant_id);
  assert.equal(big.truncated,true);assert.equal(big.count,40000);assert.equal(big.events.length,40000);
  assert.equal(big.from,big.events[0].createdAt);assert.ok(!big.events.some(e=>e.eventId==='b-1'||e.eventId==='x1'),'the oldest rows are the ones left out');
 }finally{await db.close();}
});

/* ---- the panel, against a minimal DOM, with a shared store stub ---- */
function panel({role='owner',demo=false,answer,status=200}={}){
 class El{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.style={};this.attrs={};this.className='';this.classes=new Set();}
  appendChild(c){this.children.push(c);return c;}append(...c){this.children.push(...c);}replaceChildren(...c){this.children=[...c];}setAttribute(k,v){this.attrs[k]=v;}
  get classList(){const s=this.classes;return {contains:k=>s.has(k),add:k=>s.add(k),remove:k=>s.delete(k)};}}
 const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El('div'));return els.get(id);};
 const S=store('?venue=Test%20Bistro&place=Hamra'),B=S.a,calls=[];
 // the device holds one session of its own
 B.newSession();B.logEvent('qr_scan',{tableId:'3'},{tableId:3});B.logEvent('item_view',{itemId:'i01'},{tableId:3});
 if(!demo){B.demoMode=()=>false;B.sync={enabled:true,signedIn:false,key:()=>'own_'+'ab'.repeat(18),state:()=>({role})};}
 const fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body),headers:init.headers});return {ok:status===200,status,text:async()=>status===200?JSON.stringify(answer):JSON.stringify({code:'PGRST202',message:'Could not find the function public.aal_insights_events'})};};
 const ctx=vm.createContext({Aalayna:B,$,fetch,AalaynaConfig:{supabaseUrl:'https://x.supabase.co',anonKey:'anon'},document:{createElement:t=>new El(t),createTextNode:t=>Object.assign(new El('#text'),{textContent:t})},
  opsEl:(t,text,cls)=>Object.assign(new El(t),{textContent:text==null?'':text,className:cls||''}),opsCount:(n,w)=>n+' '+w+(n===1?'':'s'),
  opsDuration:ms=>Math.round(ms/1000)+'s',money:v=>'$'+v.toFixed(2),go(){},setTimeout(){return 1;},FL_DEFAULT:{1:{},2:{},3:{}},Date,Math,JSON,Object,Number,String,Array,Promise,Error});
 ctx.window=ctx;
 vm.runInContext(read('insights-panel.js'),ctx,{filename:'insights-panel.js'});
 $('v-insights').classList.add('on');$('ins-period').value='30';
 const text=n=>n.textContent+' '+n.children.map(text).join(' ');
 return {B,map:S.map,calls,ctx,$,text:()=>text($('insights-body'))};
}
function serverAnswer(){
 const {a}=store(),now=Date.now(),items=a.published().items;
 const events=a.demoInsightEvents({items,at:now,venueId:'r'}).filter(e=>Date.parse(e.createdAt)>=now-30*DAY).map(e=>{const b=Object.assign({},e);delete b.demo;return b;});
 return {version:1,since:new Date(now-30*DAY).toISOString(),until:new Date(now).toISOString(),clamped:false,limit:40000,truncated:false,from:events[0].createdAt,count:events.length,
  firstEventAt:new Date(now-50*DAY).toISOString(),deviceFirstSeen:{},events};
}

test('shared mode: one read per period, findings from the server answer, held in memory only',async()=>{
 const answer=serverAnswer(),p=panel({answer});
 const before=new Map(p.map);
 p.ctx.paintInsights();
 assert.match(p.text(),/Reading this period’s activity from the shared store/);
 await flush();
 assert.equal(p.calls.length,1);
 const c=p.calls[0];assert.equal(c.url,'https://x.supabase.co/rest/v1/rpc/aal_insights_events');assert.equal(c.headers['x-aalayna-key'],'own_'+'ab'.repeat(18));
 assert.equal(c.body.p_rid,p.B.venueId());assert.equal(Date.parse(c.body.p_body.until)-Date.parse(c.body.p_body.since),30*DAY);
 const t=p.text();
 assert.match(t,/Read from the shared store for this period \(\d+ events\)/);assert.match(t,/51 days of recorded activity/);
 assert.match(t,/was opened \d+ times .* but is on only \d+ bills/,'the server events drive the findings');
 assert.doesNotMatch(t,/Sample history/);
 // repaints (a store change, opening the tab again) reuse the answer
 p.ctx.paintInsights();p.ctx.paintInsights();await flush();assert.equal(p.calls.length,1);
 // another period: one more read; Refresh: one more
 p.$('ins-period').value='7';p.ctx.paintInsights();await flush();assert.equal(p.calls.length,2);assert.equal(Date.parse(p.calls[1].body.p_body.until)-Date.parse(p.calls[1].body.p_body.since),7*DAY);
 p.ctx.insRefresh();await flush();assert.equal(p.calls.length,3);
 // nothing of it reached storage
 assert.deepEqual([...p.map.keys()].sort(),[...before.keys()].sort());
 for(const [k,v] of p.map)assert.equal(v,before.get(k),k+' unchanged');
 assert.ok(![...p.map.values()].some(v=>v.indexOf(answer.events[5].eventId)>=0));
});

test('shared mode without the function (404): the device\'s own events, and a note saying so',async()=>{
 const p=panel({status:404});
 p.ctx.paintInsights();await flush();
 assert.equal(p.calls.length,1);
 const t=p.text();
 assert.match(t,/Insights are limited to what this device holds: the shared store cannot send a period’s activity yet \(supabase\/insights-2026-11-24\.sql is not installed\)\./);
 assert.match(t,/1 day of recorded activity/);assert.match(t,/1 session, 1 dish open/);
 p.ctx.paintInsights();await flush();assert.equal(p.calls.length,1,'no retry loop; Refresh asks again');
 const e=panel({status:500});e.ctx.paintInsights();await flush();assert.match(e.text(),/limited to what this device holds: the shared store did not answer/);
});

test('the demo and a waiter never ask the server',async()=>{
 const d=panel({demo:true});d.ctx.paintInsights();await flush();assert.equal(d.calls.length,0);assert.doesNotMatch(d.text(),/shared store/);
 const w=panel({role:'waiter'});w.ctx.paintInsights();await flush();assert.equal(w.calls.length,0);
});
