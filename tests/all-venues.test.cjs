/* All venues in shared mode (supabase/all-venues-2026-11-24.sql, aalayna-sync.js A.sync.pullVenues,
   owner-group.js A.loadSharedVenues, the store's util.lendVenues, dashboard.html's switcher).
   Proves:
   - the store: another venue lent to a shared page is read only and in memory; group figures over
     this venue's live records and the lent venues equal each venue's own report computed alone, and
     the group line is their sum with rates from the summed counts; nothing is written or queued;
   - the page: a signed-in owner's dashboard asks aal_all_venues once the first read says owner,
     keeps only each venue's own rows, gets All venues with the same figures; a waiter never asks;
     a server list without this page's venue, or with one venue, gives no switcher; another venue
     opens its own page; the demo is unchanged;
   - the SQL (static always; against PostgreSQL with PGLITE_MODULE): an owner of A and B never sees
     C, a waiter of A gets nothing, a manager of A alone gets A alone, the group key gets the group,
     a venue key its venue, revoking or removing a venue ends it at once; the rows are aal_snapshot's
     rows for the figures, less the guest contact and payment references, and the figures computed
     from them equal the venue's own figures from its full snapshot. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8'),DAY=86400000;
const plain=x=>JSON.parse(JSON.stringify(x)),flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const V={hamra:{name:'Mayda',place:'Hamra'},achrafieh:{name:'Mayda',place:'Achrafieh'},batroun:{name:'Mayda',place:'Batroun'},other:{name:'Other',place:'Gemmayzeh'}};
const id=v=>JSON.stringify([v.name.toLowerCase(),v.place.toLowerCase()]);
const AT=Date.parse('2026-06-01T12:00:00Z');
function mem(m){return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}};}

/* ---------------------------------------------------- a demo store, to make each venue's evening */
function demoStore(search){
 let time=AT;
 class Clock extends Date{constructor(...a){super(...(a.length?a:[time]));}static now(){return time;}}
 const map=new Map(),storage=mem(map),window={location:{search},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl,Date:Clock});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js','owner-group.js'])vm.runInContext(read(f),ctx,{filename:f});
 return {a:window.Aalayna,map,advance:d=>time+=d*DAY};
}
function bill(a,{table=3,amount=40,tip=0,rail='card',contact,marketing=false,close=true,rating}={}){
 const c=a.openServiceCheck({table,total:amount,source:'staff'}),p=a.settle({table,checkId:c.id,rail,amount:amount+tip,tip});
 if(rail==='cash'&&close)a.confirmCash(p.id);
 if(contact)a.optIn({settlementId:p.id,contact,receipt:true,marketing});
 if(rating!=null)a.submitReview({settlementId:p.id,rating});
 if(close)a.closeServiceCheck(c.id);
}
/* each venue: this evening, forty days on; at Hamra a guest who first came forty days ago and returned twenty days later */
const EVENING={
 hamra:e=>{bill(e.a,{table:8,amount:20,contact:'old@example.com',marketing:true});e.advance(20);bill(e.a,{table:8,amount:16,contact:'old@example.com',marketing:false});e.advance(20);
  bill(e.a,{table:1,amount:40,tip:4,contact:'a@example.com',marketing:true,rating:5});bill(e.a,{table:2,amount:25,rail:'cash'});bill(e.a,{table:4,amount:30,rail:'cash',close:false});e.a.openServiceCheck({table:9,total:12,source:'staff'});},
 achrafieh:e=>{e.advance(40);bill(e.a,{table:1,amount:60,tip:6,rail:'whish',contact:'b@example.com',rating:2});bill(e.a,{table:5,amount:15,contact:'c@example.com',marketing:true,rating:3});bill(e.a,{table:6,amount:22,rail:'cash',close:false});},
 batroun:e=>{e.advance(40);bill(e.a,{table:2,amount:18,tip:2,rating:4});},
 other:e=>{e.advance(40);bill(e.a,{table:1,amount:999,tip:99,rail:'card',contact:'z@example.com',marketing:true,rating:1});}
};
const NOW=AT+40*DAY;
const COLLECTIONS=['aal.checks','aal.settle','aal.guests','aal.events','aal.campaigns'];
/* a venue alone: its records as the server would hold them, and its own figures */
function alone(k){
 const e=demoStore('?venue='+encodeURIComponent(V[k].name)+'&place='+encodeURIComponent(V[k].place));EVENING[k](e);
 const rows=[];
 for(const c of COLLECTIONS)for(const b of JSON.parse(e.map.get(c)||'[]'))rows.push({collection:c,id:String(b.id!=null?b.id:b.eventId),body:b,updated_at:'2026-07-11T12:00:00Z'});
 const docs=[{key:'aal.floor',body:{servers:[k+'-server'],tables:{},pooled:false},updated_at:'x'},{key:'aal.draft',body:{secret:'menu draft'},updated_at:'x'}];
 const figures=r=>({report:plain(e.a.ownerReport(r,NOW)),pending:e.a.pendingCash().length,open:e.a.serviceChecks().filter(c=>!c.closedAt).length,
  ratings:plain(e.a.groupRatings(r,NOW,[e.a.venue()]).total)});
 return {e,rows,docs,figures};
}
const data=(rows,docs)=>{const d={};for(const c of ['aal.checks','aal.settle','aal.guests','aal.events'])d[c]=rows.filter(r=>r.collection===c).map(r=>r.body);for(const x of docs||[])if(x.key==='aal.floor')d[x.key]=x.body;return d;};
/* what the SQL keeps of each row (the same rules, written again here, for the store test) */
const keep=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)?Object.fromEntries(Object.entries(o).filter(([k])=>keys.includes(k))):{};
function narrow(rows){
 return rows.filter(r=>['aal.checks','aal.settle','aal.guests'].includes(r.collection)||(r.collection==='aal.events'&&r.body.eventType==='review_submitted')).map(r=>{
  const b=r.body;let body=b;
  if(r.collection==='aal.settle'){body=Object.assign({},b);for(const k of ['deviceId','sessionId','payerRef','externalRef','identityId'])delete body[k];}
  if(r.collection==='aal.guests')body=keep(b,['id','venueId','venue','receipt','marketing','createdAt','consentHistory']);
  if(r.collection==='aal.events')body=Object.assign(keep(b,['eventId','eventType','restaurantId','venueId','createdAt']),{payload:keep(b.payload,['rating'])});
  return Object.assign({},r,{body});
 });
}

test('the store: a lent venue is read only and in memory; group figures equal each venue alone, and their sum',()=>{
 const own=alone('hamra'),others={achrafieh:alone('achrafieh'),batroun:alone('batroun')};
 // a shared page for Hamra: its own records in its credential scope
 const map=new Map(),storage=mem(map),window={location:{search:'?venue=Mayda&place=Hamra'},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl,Date});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(read(f),ctx,{filename:f});
 const a=window.Aalayna;a.util.activateScope(JSON.stringify([id(V.hamra),'staff','user:1']));
 for(const c of ['aal.checks','aal.settle','aal.guests','aal.events'])a.util.rawWrite(c,own.rows.filter(r=>r.collection===c).map(r=>r.body));
 const writes=[];a.util.hooks.afterWrite.push(k=>writes.push(k));
 assert.throws(()=>a.util.withVenue(V.achrafieh,()=>1),/only in the demo/,'nothing lent yet');
 a.util.lendVenues({[id(V.achrafieh)]:{venue:V.achrafieh,data:data(narrow(others.achrafieh.rows),others.achrafieh.docs)},
  [id(V.batroun)]:{venue:V.batroun,data:data(narrow(others.batroun.rows),others.batroun.docs)},
  [id(V.other)]:{venue:V.batroun,data:data(others.batroun.rows)},                   // a venue under another's id: dropped
  [id(V.hamra)]:{venue:V.hamra,data:{'aal.settle':[]}}});                          // this page's venue is never lent
 assert.deepEqual(plain(a.util.lentVenues()).sort(),[id(V.achrafieh),id(V.batroun)].sort());
 const before=new Map(map),venues=[V.hamra,V.achrafieh,V.batroun];
 for(const range of ['today','7','30']){
  const r=a.groupReport(range,NOW,venues),live=a.groupLive(range,NOW,venues),rt=a.groupRatings(range,NOW,venues);
  for(const [k,x] of [['hamra',own],['achrafieh',others.achrafieh],['batroun',others.batroun]]){
   const f=x.figures(range),p=r.venues.find(v=>v.venueId===id(V[k]));
   assert.deepEqual(plain(p.report.current),f.report.current,k+' '+range+' current');
   assert.deepEqual(plain(p.report.previous),f.report.previous,k+' '+range+' previous');
   const l=live.venues.find(v=>v.venueId===id(V[k]));assert.equal(l.pendingCount,f.pending,k+' pending');assert.equal(l.openBills,f.open,k+' open');
   const t=rt.venues.find(v=>v.venueId===id(V[k]));assert.deepEqual([t.count,t.sum,t.low],[f.ratings.count,f.ratings.sum,f.ratings.low],k+' ratings');
  }
  const per=r.venues.map(p=>p.report.current),c=r.current,sum=k=>per.reduce((n,m)=>n+m[k],0);
  for(const k of ['netCents','tipCents','grossCents','paymentCount','bills','identifiedBills','completedBills','completedTotalCents','receiptContacts','marketingContacts','withdrawals','eligibleReturners','returners'])assert.equal(c[k],sum(k),range+' '+k);
  assert.equal(c.captureRate,c.bills?c.identifiedBills/c.bills:null);assert.equal(c.returnRate,c.eligibleReturners?c.returners/c.eligibleReturners:null);
 }
 // the figures themselves, so a silent zero cannot pass (last 30 days, the three venues, not Other's $999)
 const r30=a.groupReport('30',NOW,venues).current;
 assert.equal(r30.netCents,1600+4000+2500+6000+1500+1800);assert.equal(r30.tipCents,1200);assert.equal(r30.returners,1);
 assert.equal(a.groupLive('today',NOW,venues).total.openBills,3);
 assert.equal(a.groupRatings('today',NOW,venues).total.count,4);
 // the lent venue's floor, and this venue's own
 assert.deepEqual(plain(a.util.withVenue(V.batroun,()=>a.floor().servers)),['batroun-server']);
 assert.equal(a.util.withVenue(V.hamra,()=>a.venueId()),id(V.hamra));
 // read only: no write lands, no hook fires, the page's storage is as it was
 assert.throws(()=>a.util.withVenue(V.achrafieh,()=>a.confirmCash(a.pendingCash()[0].id)),/read only/);
 assert.throws(()=>a.util.withVenue(V.achrafieh,()=>a.setFloor({servers:['x'],tables:{}})),/read only/);
 assert.throws(()=>a.util.withVenue(V.achrafieh,()=>a.util.rawWrite('aal.settle',[])),/read only/);
 assert.deepEqual(writes,[]);assert.deepEqual([...map.entries()],[...before.entries()]);
 assert.equal(a.venueId(),id(V.hamra),'the page stays on its venue');
 assert.throws(()=>a.useVenue(V.batroun),/its own link/);
 a.util.lendVenues({});assert.throws(()=>a.util.withVenue(V.batroun,()=>1),/only in the demo/);
});

/* ------------------------------------------------ a signed-in dashboard against a mocked Supabase */
const USER='0b7c6f7e-1d2a-4c3b-9e8f-112233445566';
function makeServer({role='owner',venues}={}){
 const s={calls:[],role,venues:venues||[],snapshotRows:[]};
 s.fetch=async(url,o)=>{
  const body=o&&o.body?JSON.parse(o.body):null,u=url.replace('https://mock.invalid','');s.calls.push({u,body,headers:Object.assign({},o.headers)});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
  if(u==='/rest/v1/rpc/aal_staff')return reply(200,[{restaurant_id:id(V.hamra),role:s.role,name:'Mayda',place:'Hamra'}]);
  if(u==='/rest/v1/rpc/aal_snapshot')return reply(200,{version:2,role:s.role,checkId:null,rows:s.snapshotRows,docs:[]});
  if(u==='/rest/v1/rpc/aal_all_venues')return s.venues===404?reply(404,{message:'Could not find the function public.aal_all_venues'}):reply(200,{version:1,venues:s.venues});
  if(u==='/rest/v1/rpc/aal_group')return reply(200,{group_id:body.p_body.group_id,name:'Mayda Group',venues:[],staff:[{email:'lea@g.example',role:'manager',revoked_at:null},{email:'gone@g.example',role:'manager',revoked_at:'2026-05-01T00:00:00Z'}],
   venue_staff:[{restaurant_id:id(V.batroun),staff:[{email:'joe@g.example',role:'waiter',revoked_at:null}]}]});
  return reply(201,null);
 };
 return s;
}
function boot({server,search='?venue=Mayda&place=Hamra',local=new Map(),session=new Map()}){
 local.set('aal.session',JSON.stringify({access_token:'at-1',refresh_token:'rt-1',expires_at:Math.floor(Date.now()/1000)+3600,email:'karim@g.example',user_id:USER}));
 const intervals=[],window={document:{visibilityState:'visible',body:{appendChild(){}},addEventListener(){},createElement:()=>({style:{},append(){},setAttribute(){}}),getElementById:()=>null,documentElement:{setAttribute(){}}},
  location:{pathname:'/dashboard.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/dashboard.html'+search},history:{replaceState(){}},
  localStorage:mem(local),sessionStorage:mem(session),navigator:{userAgent:'test'},crypto:require('node:crypto').webcrypto,addEventListener(){},removeEventListener(){},
  setInterval(f){intervals.push(f);return intervals.length;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,RegExp,Set,Map,fetch:server.fetch};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window);
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js','owner-group.js'])vm.runInContext(read(f),ctx,{filename:f});
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 vm.runInContext(read('aalayna-sync.js'),ctx,{filename:'aalayna-sync.js'});
 return {a:window.Aalayna,window,local};
}
const listed=(k,x,extra={})=>Object.assign({restaurant_id:id(V[k]),name:V[k].name,place:V[k].place,slug:k,group_id:'grp_0123456789ab',group_name:'Mayda Group',rows:narrow(x.rows),docs:x.docs.filter(d=>d.key==='aal.floor')},extra);

test('a signed-in owner\'s dashboard: All venues from aal_all_venues, the same figures, nothing written back',async()=>{
 const own=alone('hamra'),ach=alone('achrafieh'),bat=alone('batroun'),oth=alone('other');
 // a row of Other's that somehow came back under Batroun is dropped by the page too (venueId is not Batroun's)
 const stray=oth.rows.find(r=>r.collection==='aal.settle');
 const server=makeServer({venues:[listed('achrafieh',ach),listed('batroun',bat,{rows:narrow(bat.rows).concat([stray])}),listed('hamra',own,{rows:[]})]});
 server.snapshotRows=own.rows.filter(r=>r.collection!=='aal.campaigns');
 const p=boot({server}),a=p.a;
 await a.sync.ready;await flush();
 assert.equal(a.sync.state().role,'owner');assert.equal(a.demoMode(),false);
 assert.equal(a.groupActive(),null,'nothing before the server lists the venues');
 const g=await a.loadSharedVenues();
 const call=server.calls.find(c=>c.u==='/rest/v1/rpc/aal_all_venues');
 assert.deepEqual(call.body,{});assert.equal(call.headers.Authorization,'Bearer at-1');assert.equal('x-aalayna-key' in call.headers,false);
 assert.equal(g.shared,true);assert.equal(g.name,'Mayda Group');
 assert.deepEqual(plain(g.venues.map(id)),[id(V.achrafieh),id(V.batroun),id(V.hamra)]);
 assert.equal(a.groupShared(),true);
 const r=a.groupReport('30',NOW),live=a.groupLive('today',NOW);
 for(const [k,x] of [['hamra',own],['achrafieh',ach],['batroun',bat]]){
  assert.deepEqual(plain(r.venues.find(v=>v.venueId===id(V[k])).report.current),x.figures('30').report.current,k);
  assert.equal(live.venues.find(v=>v.venueId===id(V[k])).openBills,x.figures('today').open,k);
 }
 assert.equal(r.current.netCents,1600+4000+2500+6000+1500+1800,'Other\'s $999 is not in Batroun');
 // the team: group staff (not the revoked), and each venue's own staff
 const team=a.groupTeam(id(V.batroun),g);
 assert.deepEqual(plain(team.group.map(s=>s.email)),['lea@g.example']);assert.deepEqual(plain(team.venue.map(s=>[s.email,s.role])),[['joe@g.example','waiter']]);
 // nothing was queued or sent but reads
 assert.equal(a.sync.state().pending,0);
 assert.deepEqual([...new Set(server.calls.map(c=>c.u))].sort(),['/rest/v1/rpc/aal_all_venues','/rest/v1/rpc/aal_group','/rest/v1/rpc/aal_snapshot','/rest/v1/rpc/aal_staff'].filter(u=>server.calls.some(c=>c.u===u)).sort());
 assert.ok(server.calls.every(c=>/\/rpc\/(aal_all_venues|aal_group|aal_snapshot|aal_staff)$/.test(c.u)),'reads only');
 assert.ok(server.calls.filter(c=>c.u==='/rest/v1/rpc/aal_group').every(c=>c.body.p_body.op==='list'));
 assert.equal([...p.local.keys()].some(k=>/achrafieh|batroun/.test(k)),false,'no other venue is stored on this device');
 // opening another venue: its own page; a venue the server did not list has no address
 assert.equal(a.sharedVenueHref(V.batroun),'dashboard.html?venue=Mayda&place=Batroun');
 assert.equal(a.sharedVenueHref(V.other),null);
 // a later read without Batroun (removed from the group) drops it at once
 server.venues=[listed('achrafieh',ach),listed('hamra',own,{rows:[]})];
 await a.loadSharedVenues();
 assert.deepEqual(plain(a.groupVenues().map(id)),[id(V.achrafieh),id(V.hamra)]);
 assert.throws(()=>a.util.withVenue(V.batroun,()=>1));assert.equal(a.sharedVenueHref(V.batroun),null);
 // down to this venue alone: no group
 server.venues=[listed('hamra',own,{rows:[]})];
 assert.equal(await a.loadSharedVenues(),null);assert.equal(a.groupActive(),null);
});

test('no All venues for a waiter, for a list without this venue, or without the migration; the demo is unchanged',async()=>{
 const own=alone('hamra'),ach=alone('achrafieh');
 const w=makeServer({role:'waiter',venues:[listed('achrafieh',ach),listed('hamra',own)]}),pw=boot({server:w});
 await pw.a.sync.ready;await flush();
 assert.equal(pw.a.sync.state().role,'waiter');
 assert.equal(await pw.a.loadSharedVenues(),null);
 assert.equal(w.calls.some(c=>c.u==='/rest/v1/rpc/aal_all_venues'),false,'a waiter never asks');
 const n=makeServer({venues:[listed('achrafieh',ach),listed('batroun',alone('batroun'))]}),pn=boot({server:n});
 await pn.a.sync.ready;await flush();
 assert.equal(await pn.a.loadSharedVenues(),null,'this page\'s venue is not listed as owned');
 assert.throws(()=>pn.a.util.withVenue(V.achrafieh,()=>1));
 const m=makeServer({venues:404}),pm=boot({server:m});
 await pm.a.sync.ready;await flush();
 assert.equal(await pm.a.loadSharedVenues(),null,'the SQL not installed: the page stays on its venue');
 // the demo: the same seeded group as before, and loadSharedVenues does nothing
 const d=demoStore('?venue=Mayda&place=Lebanese%20Grill'),g=d.a.seedDemoGroup();
 assert.equal(g.venues.length,3);assert.equal(d.a.groupShared(),false);
 assert.equal(await d.a.loadSharedVenues(),null);assert.equal(d.a.groupActive().id,g.id);
});

test('dashboard.html: shared mode loads All venues for owners only, opens other venues by their own page, never moves this page',()=>{
 const html=read('dashboard.html'),js=html.slice(html.indexOf('<!-- ==== T2 owner group: start ==== -->'),html.indexOf('<!-- ==== T2 owner group: end ==== -->'));
 assert.match(js,/if \(shared && id !== 'all' && id !== groupOwnId\(\)\)\{[\s\S]*?location\.href = href;[\s\S]*?return;\s*\}/);
 assert.match(js,/if \(!shared\)\{[\s\S]*?Aalayna\.useVenue\(/,'the demo switch only in the demo');
 assert.match(js,/Aalayna\.sync\.onReady\(function\(\)\{\s*if \(Aalayna\.sync\.state\(\)\.role !== 'owner'\) return;/);
 assert.match(js,/setInterval\(function\(\)\{ if \(floorScope === 'all' && document\.visibilityState !== 'hidden'\) load\(\); \}, 30000\)/);
 assert.match(read('owner-group.js'),/A\.loadSharedVenues = function/);
 assert.match(read('aalayna-sync.js'),/call\('rpc\/aal_all_venues',\{\}\)/);
});

/* ----------------------------------------------------------------------- SQL */
const SQL=read('supabase/all-venues-2026-11-24.sql'),CODE=SQL.split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
test('all-venues SQL: one transaction, groups first, stable and read only, owner rights only, helpers closed',()=>{
 assert.match(CODE,/^\s*begin;/m);assert.match(CODE.trim(),/commit;$/);assert.equal((CODE.match(/^\s*begin;/gm)||[]).length,1);
 const check=CODE.indexOf("raise exception 'Run groups-2026-10-28.sql before all-venues-2026-11-24.sql'");
 assert.ok(check>0&&check<CODE.indexOf('create or replace function'),'the check comes before any change');
 const fns=[...SQL.matchAll(/create or replace function (public\.\w+)\([^)]*\) returns jsonb\n([^\n]*)/g)];
 assert.deepEqual(fns.map(m=>m[1]),['public.aal_all_venues_keep','public.aal_all_venues_rows','public.aal_all_venues']);
 for(const m of fns){assert.match(m[2],/set search_path = public, extensions, pg_temp as \$\$/,m[1]);assert.doesNotMatch(m[2],/volatile/,m[1]);}
 assert.match(SQL,/function public\.aal_all_venues\(\) returns jsonb\nlanguage plpgsql stable security definer/);
 assert.match(CODE,/where public\.aal_role\(c\.restaurant_id\) = 'owner'/);
 assert.doesNotMatch(CODE,/\b(insert|update|delete)\b\s+(into|public\.|from)/i);
 assert.doesNotMatch(CODE,/\b(drop|alter|create (table|policy|trigger))\b/i);
 assert.doesNotMatch(CODE,/function public\.(aal_role|aal_snapshot|aal_mutate|aal_staff|aal_group)\(/);
 assert.match(CODE,/revoke all on function public\.aal_all_venues_keep\(jsonb, text\[\]\) from public, anon, authenticated;/);
 assert.match(CODE,/revoke all on function public\.aal_all_venues_rows\(text\) from public, anon, authenticated;/);
 assert.match(CODE,/revoke all on function public\.aal_all_venues\(\) from public;\s*grant execute on function public\.aal_all_venues\(\) to anon, authenticated;/);
 assert.match(read('supabase/README.md'),/all-venues-2026-11-24\.sql/);
});

const modulePath=process.env.PGLITE_MODULE;
test('all-venues SQL against PostgreSQL: exactly the venues owned today, each venue\'s own rows, the same figures',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>read('supabase/'+f).replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec("create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;");
  await db.exec('create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);');
  const files=['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql',
   'followups-2026-09-24.sql','theme-2026-09-28.sql','daily-close-2026-09-30.sql','payments-2026-09-30.sql','integrations-2026-09-30.sql','payment-start-2026-10-14.sql'];
  for(const f of files)await db.exec(sql(f));
  await assert.rejects(db.exec(sql('all-venues-2026-11-24.sql')),/Run groups-2026-10-28\.sql before all-venues-2026-11-24\.sql/);
  await db.exec('rollback');
  for(const f of ['groups-2026-10-28.sql','close-narrative-2026-10-28.sql','review-fixes-2026-11-10.sql','all-venues-2026-11-24.sql','all-venues-2026-11-24.sql'])await db.exec(sql(f));
  const U={karim:'11111111-1111-4111-8111-111111111111',lea:'22222222-2222-4222-8222-222222222222',sam:'33333333-3333-4333-8333-333333333333',nadine:'44444444-4444-4444-8444-444444444444',olga:'55555555-5555-4555-8555-555555555555'};
  for(const [n,u] of Object.entries(U))await db.query('insert into auth.users values($1,$2,now(),null)',[u,n+'@g.example']);
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers,claims)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify(claims||{role})]);await db.exec('set role '+role);};
  const who=n=>({role:'authenticated',sub:U[n],email:n+'@g.example'});
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  const all=async()=>one('select aal_all_venues() as value');
  const ids=async()=>(await all()).venues.map(v=>v.restaurant_id);
  await as('anon',{'x-aalayna-admin':'adm_test'});
  const reg={};for(const k of ['hamra','achrafieh','batroun','other'])reg[k]=await one("select aal_admin_register_venue($1,$2,$3,'{}'::jsonb) as value",[V[k].name,V[k].place,k]);
  for(const k of Object.keys(reg))assert.equal(reg[k].restaurant_id,id(V[k]));
  const g=await one("select aal_admin_create_group('Mayda Group') as value");
  for(const k of ['hamra','achrafieh','batroun'])await one('select aal_admin_group_venue($1,$2,$3) as value',[g.group_id,reg[k].restaurant_id,'add']);
  // each venue's records as the server holds them, plus a row filed under Batroun that says it is Other's
  await db.exec('reset role');
  const src={};for(const k of Object.keys(V)){src[k]=alone(k);for(const r of src[k].rows)await db.query('insert into kv_rows(restaurant_id,collection,id,body) values($1,$2,$3,$4)',[id(V[k]),r.collection,r.id,JSON.stringify(r.body)]);
   for(const d of src[k].docs)await db.query('insert into kv_docs(restaurant_id,key,body) values($1,$2,$3)',[id(V[k]),d.key,JSON.stringify(d.body)]);}
  const stray=src.other.rows.find(r=>r.collection==='aal.settle');
  await db.query('insert into kv_rows(restaurant_id,collection,id,body) values($1,$2,$3,$4)',[id(V.batroun),'aal.settle','stray',JSON.stringify(stray.body)]);
  // staff: Karim group owner; Lea group manager; Nadine manager of Achrafieh alone; Sam waiter at Achrafieh; Olga owner of Other and waiter at Hamra
  await db.query("insert into owner_group_staff(group_id,email,role) values($1,'karim@g.example','owner'),($1,'lea@g.example','manager')",[g.group_id]);
  await db.query("insert into staff_members(restaurant_id,email,role) values($1,'nadine@g.example','manager'),($1,'sam@g.example','waiter'),($2,'olga@g.example','owner'),($3,'olga@g.example','waiter')",[id(V.achrafieh),id(V.other),id(V.hamra)]);
  const group=[id(V.achrafieh),id(V.batroun),id(V.hamra)];
  // nobody at all: refused
  await as('anon',{});await assert.rejects(all(),/Sign in with your email or open your owner link first/);
  // the group owner and the group manager: the three venues of the group, never Other
  await as('authenticated',{},who('karim'));assert.deepEqual(await ids(),group);
  await as('authenticated',{},who('lea'));assert.deepEqual(await ids(),group);
  // a venue's manager: that venue alone; a waiter: nothing; Other's owner who waits tables at Hamra: Other alone
  await as('authenticated',{},who('nadine'));assert.deepEqual(await ids(),[id(V.achrafieh)]);
  await as('authenticated',{},who('sam'));assert.deepEqual(await all(),{version:1,venues:[]});
  await as('authenticated',{},who('olga'));assert.deepEqual(await ids(),[id(V.other)]);
  // keys: the group key gets the group, a venue key its venue, a guest key nothing
  await as('anon',{'x-aalayna-key':g.owner_key});assert.deepEqual(await ids(),group);
  await as('anon',{'x-aalayna-key':reg.hamra.owner_key});assert.deepEqual(await ids(),[id(V.hamra)]);
  await as('anon',{'x-aalayna-key':reg.hamra.guest_key});assert.deepEqual((await all()).venues,[]);
  // what comes back: aal_snapshot's rows for the figures, less the guest contact and payment references
  await as('authenticated',{},who('karim'));
  const res=await all(),venue=k=>res.venues.find(v=>v.restaurant_id===id(V[k]));
  assert.deepEqual([venue('batroun').name,venue('batroun').place,venue('batroun').group_id,venue('batroun').group_name],['Mayda','Batroun',g.group_id,'Mayda Group']);
  for(const k of ['hamra','achrafieh','batroun']){
   const v=venue(k),snap=await one('select aal_snapshot($1) as value',[id(V[k])]),cols=new Set(v.rows.map(r=>r.collection));
   assert.ok([...cols].every(c=>['aal.checks','aal.settle','aal.guests','aal.events'].includes(c)),k);
   assert.ok(v.rows.every(r=>(r.body.venueId||r.body.restaurantId)===id(V[k])),k+': only its own rows');
   const want=narrow(snap.rows).map(r=>[r.collection,r.id,r.body]).sort((x,y)=>(x[0]+x[1]).localeCompare(y[0]+y[1]));
   assert.deepEqual(v.rows.map(r=>[r.collection,r.id,r.body]).sort((x,y)=>(x[0]+x[1]).localeCompare(y[0]+y[1])),want,k+': the snapshot\'s rows, narrowed');
   assert.deepEqual(v.docs.map(d=>[d.key,d.body]),[['aal.floor',{servers:[k+'-server'],tables:{},pooled:false}]]);
   for(const r of v.rows.filter(r=>r.collection==='aal.guests'))for(const f of ['contact','channel','deviceId','customerId'])assert.equal(f in r.body,false,k+' guest '+f);
   for(const r of v.rows.filter(r=>r.collection==='aal.settle'))for(const f of ['deviceId','sessionId','payerRef','externalRef','identityId'])assert.equal(f in r.body,false,k+' payment '+f);
   assert.ok(v.rows.filter(r=>r.collection==='aal.events').every(r=>r.body.eventType==='review_submitted'&&Object.keys(r.body.payload).every(x=>x==='rating')));
  }
  assert.equal(venue('batroun').rows.some(r=>r.id==='stray'),false,'a row that names another venue never leaves');
  assert.ok(venue('hamra').rows.some(r=>r.collection==='aal.guests'),'there were guests to narrow');
  // the figures from these rows, lent to a shared Hamra page, equal each venue's own (from its full records)
  const map=new Map(),storage=mem(map),window={location:{search:'?venue=Mayda&place=Hamra'},addEventListener(){},localStorage:storage};
  const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl,Date});
  for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(read(f),ctx,{filename:f});
  const a=window.Aalayna;a.util.activateScope(JSON.stringify([id(V.hamra),'staff','user:k']));
  for(const c of ['aal.checks','aal.settle','aal.guests','aal.events'])a.util.rawWrite(c,src.hamra.rows.filter(r=>r.collection===c).map(r=>r.body));
  a.util.lendVenues(Object.fromEntries(['achrafieh','batroun'].map(k=>[id(V[k]),{venue:V[k],data:data(venue(k).rows,venue(k).docs)}])));
  const venues=[V.hamra,V.achrafieh,V.batroun];
  for(const range of ['today','7','30']){
   const r=a.groupReport(range,NOW,venues),rt=a.groupRatings(range,NOW,venues);
   for(const k of ['hamra','achrafieh','batroun']){
    const f=src[k].figures(range);
    assert.deepEqual(plain(r.venues.find(v=>v.venueId===id(V[k])).report),{window:f.report.window,previousWindow:f.report.previousWindow,current:f.report.current,previous:f.report.previous},k+' '+range);
    const t=rt.venues.find(v=>v.venueId===id(V[k]));assert.deepEqual([t.count,t.sum,t.low],[f.ratings.count,f.ratings.sum,f.ratings.low],k+' '+range+' ratings');
   }
  }
  // revoking, and a venue leaving the group, end it at once
  await db.exec('reset role');
  await db.query("update owner_group_staff set revoked_at=now() where email='lea@g.example'");
  await as('authenticated',{},who('lea'));assert.deepEqual(await all(),{version:1,venues:[]});
  await as('anon',{'x-aalayna-admin':'adm_test'});await one('select aal_admin_group_venue($1,$2,$3) as value',[g.group_id,id(V.batroun),'remove']);
  await as('authenticated',{},who('karim'));assert.deepEqual(await ids(),[id(V.achrafieh),id(V.hamra)]);
  await as('anon',{'x-aalayna-key':g.owner_key});assert.deepEqual(await ids(),[id(V.achrafieh),id(V.hamra)]);
  // read only: no role can call the helpers, and the function cannot write
  for(const role of ['anon','authenticated']){
   await as(role,{});
   await assert.rejects(db.query("select aal_all_venues_rows('x')"),/permission denied/);
   await assert.rejects(db.query("select aal_all_venues_keep('{}'::jsonb,array['a'])"),/permission denied/);
  }
  await db.exec('reset role');
  const vol=(await db.query("select provolatile, prosecdef from pg_proc where proname='aal_all_venues'")).rows[0];
  assert.deepEqual([vol.provolatile,vol.prosecdef],['s',true]);
 }finally{await db.close();}
});
