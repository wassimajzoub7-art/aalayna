/* Owner groups (T2 "One floor for three places"): one owner, several venues, one floor, one close.
   Proves:
   - who sees what, in the demo model (owner-group.js A.groupAccess) and in the SQL
     (supabase/groups-2026-10-28.sql, static checks; against PostgreSQL when PGLITE_MODULE is set):
     a group owner or manager runs every venue of the group, a venue's own staff only that venue,
     a waiter only their venue and never as group staff, the higher role wins, revoking ends it;
   - the demo seed: only the fictional Mayda, only without a key, the device's own venue untouched;
   - the aggregation (owner-metrics.js A.groupReport, A.groupLive, A.groupRatings): each venue's
     figures inside the group equal that venue's own report computed alone, and every group figure is
     the sum of its venues' with rates worked out from the summed counts;
   - the group close (supabase/functions/daily-close): one email to the group's owners and managers,
     the group's figures equal the sum of its venues' closes, a section per venue, the CSV with a venue
     column; venue closes go on without the group's recipients; logs, reruns, ?group=, quiet days and a
     database without the groups tables. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),vm=require('node:vm'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..'),DAY=86400000;
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

/* ------------------------------------------------------------ the demo store */
function store({search='?venue=Mayda&place=Lebanese%20Grill',seed=new Map()}={}){
 let time=Date.parse('2026-06-01T12:00:00Z');
 class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const map=seed,storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),key:i=>[...map.keys()][i]??null,get length(){return map.size;}};
 const window={location:{search},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl,Date:Clock});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js','owner-group.js'])vm.runInContext(read(f),ctx,{filename:f});
 return {a:window.Aalayna,map,advance:d=>time+=d*DAY,at:()=>time};
}
const plain=x=>JSON.parse(JSON.stringify(x));
const V={hamra:{name:'Mayda',place:'Hamra'},achrafieh:{name:'Mayda',place:'Achrafieh'},batroun:{name:'Mayda',place:'Batroun'}};
const id=v=>JSON.stringify([v.name.toLowerCase(),v.place.toLowerCase()]);
function bill(a,{table=3,amount=40,tip=0,rail='card',contact,marketing=false,close=true,rating}={}){
 const c=a.openServiceCheck({table,total:amount,source:'staff'}),p=a.settle({table,checkId:c.id,rail,amount:amount+tip,tip});
 if(rail==='cash'&&close)a.confirmCash(p.id);
 if(contact)a.optIn({settlementId:p.id,contact,receipt:true,marketing});
 if(rating!=null)a.submitReview({settlementId:p.id,rating});
 if(close)a.closeServiceCheck(c.id);
 return {c,p};
}
/* the same evening at two venues, then the same evening at one venue alone in another store */
const EVENING={
 hamra:a=>{bill(a,{table:1,amount:40,tip:4,contact:'a@example.com',marketing:true,rating:5});bill(a,{table:2,amount:25,rail:'cash'});bill(a,{table:4,amount:30,rail:'cash',close:false});a.openServiceCheck({table:9,total:12,source:'staff'});},
 achrafieh:a=>{bill(a,{table:1,amount:60,tip:6,rail:'whish',contact:'b@example.com',rating:2});bill(a,{table:5,amount:15,contact:'c@example.com',marketing:true});bill(a,{table:6,amount:22,rail:'cash',close:false});},
 batroun:a=>{bill(a,{table:2,amount:18,tip:2,rating:4});}
};
function groupStore(){
 const e=store({search:'?venue=Mayda&place=Hamra'}),a=e.a;
 a.setGroup({id:'grp_test',name:'Mayda Group',venues:[V.hamra,V.achrafieh,V.batroun],staff:[]});
 for(const k of Object.keys(EVENING))a.util.withVenue(V[k],()=>EVENING[k](a));
 return e;
}
function aloneStore(k){
 const e=store({search:'?venue=Mayda&place='+V[k].place});EVENING[k](e.a);return e;
}

test('who sees what in the demo: group staff every venue, venue staff their venue, a waiter only theirs',()=>{
 const {a}=store(),H=id(V.hamra),A=id(V.achrafieh),B=id(V.batroun);
 const g={id:'grp_t',name:'G',venues:[V.hamra,V.achrafieh,V.batroun],staff:[
  {email:'owner@g.example',role:'owner',venueId:null},
  {email:'ops@g.example',role:'manager',venueId:null},
  {email:'lead@g.example',role:'manager',venueId:A},
  {email:'sam@g.example',role:'waiter',venueId:B},
  {email:'both@g.example',role:'waiter',venueId:H},{email:'both@g.example',role:'manager',venueId:null},
  {email:'gone@g.example',role:'manager',venueId:null,revokedAt:'2026-05-01T00:00:00Z'},
  {email:'odd@g.example',role:'waiter',venueId:null}]};
 assert.deepEqual(plain(a.groupAccess('owner@g.example',g)),{[H]:'owner',[A]:'owner',[B]:'owner'});
 assert.deepEqual(plain(a.groupAccess(' OPS@g.example ',g)),{[H]:'owner',[A]:'owner',[B]:'owner'});
 assert.deepEqual(plain(a.groupAccess('lead@g.example',g)),{[A]:'owner'});                   // a venue's manager: that venue only
 assert.deepEqual(plain(a.groupAccess('sam@g.example',g)),{[B]:'waiter'});                    // a waiter: their venue, as a waiter
 assert.deepEqual(plain(a.groupAccess('both@g.example',g)),{[H]:'owner',[A]:'owner',[B]:'owner'});   // the higher role wins
 assert.deepEqual(plain(a.groupAccess('gone@g.example',g)),{});                              // revoked
 assert.deepEqual(plain(a.groupAccess('odd@g.example',g)),{});                               // a waiter is never group staff
 assert.deepEqual(plain(a.groupAccess('stranger@x.example',g)),{});
 const t=a.groupTeam(A,g);
 assert.deepEqual(plain(t.group.map(s=>s.email)),['owner@g.example','ops@g.example','both@g.example']);
 assert.deepEqual(plain(t.venue.map(s=>s.email)),['lead@g.example']);
});

test('the demo seed: Mayda and two branches, once, only without a key; the device keeps its venue',()=>{
 const e=store(),a=e.a,g=a.seedDemoGroup();
 assert.deepEqual(plain(g.venues.map(v=>v.place)),['Lebanese Grill','Achrafieh','Batroun']);
 assert.equal(g.staff.filter(s=>s.venueId===null).every(s=>s.role==='owner'||s.role==='manager'),true);
 assert.equal(a.seedDemoGroup().id,g.id);                                               // once
 assert.equal(a.venue().place,'Lebanese Grill');assert.equal(JSON.parse(e.map.get('aal.venue')).place,'Lebanese Grill');
 assert.equal(a.settlements().length,0,'the device\'s own venue gets no invented activity');
 const branch=g.venues[1];
 a.useVenue(branch);
 assert.equal(a.venueId(),id(V.achrafieh));assert.ok(a.settlements().length>0);assert.deepEqual(plain(a.floor().servers),['Nadine','Elie']);
 assert.equal(JSON.parse(e.map.get('aal.venue')).place,'Lebanese Grill','looking at a branch never moves the device');
 a.useVenue(null);assert.deepEqual(plain(a.floor().servers),['Abou Karim','Sara','Jad']);   // the own venue keeps aal.floor
 assert.ok(e.map.has('aal.floor@'+id(V.achrafieh)));
 // another restaurant's walk-in link gets no invented branches; neither does a keyed device
 assert.equal(store({search:'?venue=Test%20Bistro&place=Achrafieh'}).a.seedDemoGroup(),null);
 const keyed=store({seed:new Map([['aal.key','own_'+'ab'.repeat(18)]])});
 assert.equal(keyed.a.seedDemoGroup(),null);assert.equal(keyed.map.has('aal.group'),false);
 // a group whose venues do not include this device's venue does not apply here
 const other=store({search:'?venue=Test%20Bistro&place=Achrafieh'});other.a.setGroup(g);
 assert.equal(other.a.groupActive(),null);assert.deepEqual(plain(other.a.groupVenues()).map(v=>v.name),['Test Bistro']);
});

test('aggregation: each venue inside the group equals its own report computed alone',()=>{
 const g=groupStore();
 for(const range of ['today','7','30']){
  const r=g.a.groupReport(range);
  for(const k of Object.keys(EVENING)){
   const alone=aloneStore(k).a.ownerReport(range),inGroup=r.venues.find(p=>p.venueId===id(V[k])).report;
   assert.deepEqual(plain(inGroup.current),plain(alone.current),k+' '+range+' current');
   assert.deepEqual(plain(inGroup.previous),plain(alone.previous),k+' '+range+' previous');
  }
 }
 // and the live queue of a venue is what that venue's own Live floor shows
 const live=g.a.groupLive('today');
 for(const k of Object.keys(EVENING)){
  const a=aloneStore(k).a,p=live.venues.find(x=>x.venueId===id(V[k]));
  assert.equal(p.pendingCashCents,a.pendingCash().reduce((n,x)=>n+Math.round(x.amount*100),0),k+' cash');
  assert.equal(p.openBills,a.serviceChecks().filter(c=>!c.closedAt).length,k+' open');
  assert.equal(p.collectedCents,a.ownerReport('today').current.grossCents,k+' collected');
 }
});

test('aggregation: the group is the sum of its venues, rates worked out from the summed counts',()=>{
 const {a}=groupStore(),r=a.groupReport('7'),c=r.current,per=r.venues.map(p=>p.report.current);
 const sum=k=>per.reduce((n,m)=>n+m[k],0);
 for(const k of ['netCents','tipCents','grossCents','paymentCount','bills','identifiedBills','completedBills','completedTotalCents','receiptContacts','marketingContacts','withdrawals','eligibleReturners','returners'])assert.equal(c[k],sum(k),k);
 for(const rail of ['cash','card','whish','pos'])assert.equal(c.rails[rail],per.reduce((n,m)=>n+m.rails[rail],0),rail);
 assert.equal(c.captureRate,c.identifiedBills/c.bills);assert.equal(c.optInRate,c.marketingContacts/c.receiptContacts);
 assert.equal(c.averageBillCents,Math.round(c.completedTotalCents/c.completedBills));
 assert.equal(c.returnRate,null);                                                      // no eligible returners: a dash, never 0%
 // the figures themselves, so a silent zero cannot pass
 assert.equal(c.netCents,4000+2500+6000+1500+1800);assert.equal(c.tipCents,1200);assert.equal(c.completedBills,5);
 assert.equal(c.rails.cash,2500);assert.equal(c.rails.whish,6600);assert.equal(c.identifiedBills,3);assert.equal(c.bills,5);
 assert.equal(c.captureRate,0.6);assert.equal(c.optInRate,2/3);
 const live=a.groupLive('7');
 assert.equal(live.total.pendingCashCents,3000+2200);assert.equal(live.total.openBills,3);assert.equal(live.total.collectedCents,c.grossCents);
 for(const k of ['pendingCashCents','pendingCount','openBills','collectedCents','netCents'])assert.equal(live.total[k],live.venues.reduce((n,v)=>n+v[k],0),k);
 const rt=a.groupRatings('7');
 assert.deepEqual(plain(rt.venues.map(v=>[v.count,v.low])),[[1,0],[1,1],[1,0]]);
 assert.equal(rt.total.count,3);assert.equal(rt.total.low,1);assert.equal(rt.total.average,(5+2+4)/3);
 // a refund at one venue moves that venue and the group by the same amount, and nothing else
 const before=a.groupReport('7');
 a.util.withVenue(V.batroun,()=>{a.refund(a.settlements()[0].id);});
 const after=a.groupReport('7');
 assert.equal(before.current.netCents-after.current.netCents,1800);
 assert.deepEqual(plain(after.venues[0].report.current),plain(before.venues[0].report.current));
});

test('a venue that is not in a group: the group figures are that venue alone, and no switcher state leaks',()=>{
 const e=aloneStore('hamra'),a=e.a;
 assert.equal(a.groupActive(),null);
 const r=a.groupReport('7');
 assert.equal(r.venues.length,1);assert.deepEqual(plain(r.current.rails),plain(a.ownerReport('7').current.rails));
 assert.throws(()=>{a.util.activateScope('["x","owner","own_1"]');a.useVenue(V.batroun);},/its own link/);
});

/* ----------------------------------------------------------------------- SQL */
const SQL=read('supabase/groups-2026-10-28.sql'),CODE=SQL.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
test('groups-2026-10-28.sql: closed tables, one group per venue, no waiter at group scope, one transaction',()=>{
 assert.equal((CODE.match(/^begin;$/gm)||[]).length,1);assert.equal((CODE.match(/^commit;$/gm)||[]).length,1);
 for(const t of ['owner_groups','owner_group_venues','owner_group_staff','daily_close_group_log']){
  assert.match(CODE,new RegExp('create table if not exists public\\.'+t+' \\('),t);
  assert.match(CODE,new RegExp('alter table public\\.'+t+' enable row level security'),t+' RLS');
 }
 assert.doesNotMatch(CODE,/create policy/);
 assert.match(CODE,/revoke all on public\.owner_groups, public\.owner_group_venues, public\.owner_group_staff, public\.daily_close_group_log\s+from public, anon, authenticated/);
 assert.match(CODE,/restaurant_id text not null unique references public\.venue_keys/);                 // a venue in at most one group
 assert.match(CODE,/owner_group_staff[\s\S]*?role\s+text not null check \(role in \('owner', 'manager'\)\)/);   // no waiter at group scope
 assert.match(CODE,/owner_key  text not null unique check \(owner_key ~ '\^own_\[0-9a-f\]\{12,64\}\$'\)/);   // the sync layer treats it as an owner key
 assert.match(CODE,/create unique index if not exists daily_close_group_log_group_day on public\.daily_close_group_log \(group_id, day\)/);
 assert.match(CODE,/raise exception 'Run auth-2026-09-24\.sql before groups-2026-10-28\.sql'/);
 assert.doesNotMatch(SQL,/eyJ[A-Za-z0-9_-]{20,}|own_[0-9a-f]{12,}|adm_[0-9a-f]{12,}/,'no key value in the file');
});
test('groups-2026-10-28.sql: aal_role admits the group key and group staff as owners, waiters only at their venue',()=>{
 const role=/create or replace function public\.aal_role\(rid text\)[\s\S]*?\n\$\$;/.exec(CODE)[0];
 const lines=role.split('\n').filter(l=>/^\s+when /.test(l)).map(l=>l.trim());
 assert.equal(lines.length,5);
 assert.match(lines[0],/v\.owner_key = public\.aal_key\(\)\) then 'owner'/);
 assert.match(lines[1],/aal_group_key_for\(rid\) then 'owner'/);
 assert.match(lines[2],/s\.r in \('owner', 'manager'\) then 'owner'/);
 assert.match(lines[3],/s\.r = 'waiter' then 'waiter'/);
 assert.match(lines[4],/guest_key = public\.aal_key\(\)\) then 'guest'/);
 // the group key is checked against the venue's own group, never any group
 assert.match(CODE,/aal_group_key_for\(p_rid text\)[\s\S]*?where gv\.restaurant_id = p_rid and g\.owner_key = public\.aal_key\(\)/);
 // the staff role: the higher of the venue's and the group's
 assert.match(CODE,/when v\.r = 'owner' or g\.r = 'owner' then 'owner'\s+when v\.r = 'manager' or g\.r = 'manager' then 'manager'\s+else v\.r end/);
 // aal_staff: mine lists group venues; the group key manages a venue of its group; everything else as before
 const staff=CODE.slice(CODE.indexOf('create or replace function public.aal_staff(p_rid text'),CODE.indexOf('-- The group surface'));
 assert.match(staff,/from public\.owner_group_staff gs\s+join public\.owner_group_venues gv2/);
 assert.match(staff,/v_key := v_venue_key or public\.aal_group_key_for\(p_rid\)/);
 assert.match(staff,/'Only the restaurant owner can manage staff\.'/);
 // aal_group: only the group owner key or the group's own staff; only an owner manages; waiters refused
 const grp=CODE.slice(CODE.indexOf('create or replace function public.aal_group(p_body jsonb)'));
 assert.match(grp,/if not v_key and v_mine is null then\s+raise exception 'Only the group owner or a group manager can open this group\.'/);
 assert.match(grp,/if not v_key and v_mine <> 'owner' then\s+raise exception 'Only the group owner can manage group staff\.'/);
 assert.match(grp,/not in \('owner', 'manager'\) then\s+raise exception 'A group role is owner or manager\. Waiters are invited at their venue\.'/);
 for(const f of ['aal_admin_create_group','aal_admin_group_venue','aal_admin_list_groups','aal_admin_rotate_group_key']){
  const body=CODE.slice(CODE.indexOf('function public.'+f+'('));
  assert.match(body.slice(0,600),/if not public\.aal_is_admin\(\) then raise exception 'Admin key required\.'/,f);
 }
 for(const f of ['aal_group_of(text)','aal_group_key_for(text)','aal_group_staff_role(text)','aal_staff_role(text)','aal_group_json(text, boolean)','aal_admin_group_json(text)'])
  assert.match(CODE,new RegExp('revoke all on function public\\.'+f.replace(/[()]/g,'\\$&')+' from public, anon, authenticated'),f);
 assert.match(CODE,/grant execute on function public\.aal_group\(jsonb\) to anon, authenticated/);
 assert.match(read('supabase/README.md'),/then `groups-2026-10-28\.sql`\s+last/);
});

const modulePath=process.env.PGLITE_MODULE;
test('groups SQL against PostgreSQL: the group key and group staff see every venue of the group, a waiter only theirs',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>read('supabase/'+f).replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);`);
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql','groups-2026-10-28.sql','groups-2026-10-28.sql'])await db.exec(sql(f));
  const LEA='11111111-1111-4111-8111-111111111111',SAM='22222222-2222-4222-8222-222222222222';
  await db.query(`insert into auth.users values($1,'lea@g.example',now(),null),($2,'sam@g.example',now(),null)`,[LEA,SAM]);
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers,claims)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify(claims||{role})]);await db.exec('set role '+role);};
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  await as('anon',{'x-aalayna-admin':'adm_test'});
  const [h,a,o]=[await one("select aal_admin_register_venue('Mayda','Hamra','mayda-hamra','{}'::jsonb) as value"),await one("select aal_admin_register_venue('Mayda','Achrafieh','mayda-achrafieh','{}'::jsonb) as value"),await one("select aal_admin_register_venue('Other','Gemmayzeh','other','{}'::jsonb) as value")];
  const g=await one("select aal_admin_create_group('Mayda Group') as value");
  for(const v of [h,a])await one('select aal_admin_group_venue($1,$2,$3) as value',[g.group_id,v.restaurant_id,'add']);
  await as('anon',{});
  await assert.rejects(one("select aal_admin_create_group('Y') as value"),/Admin key required/);
  const role=rid=>one('select aal_role($1) as value',[rid]);
  // the group key: owner at both venues of the group, nothing at the other venue
  await as('anon',{'x-aalayna-key':g.owner_key});
  assert.equal(await role(h.restaurant_id),'owner');assert.equal(await role(a.restaurant_id),'owner');assert.equal(await role(o.restaurant_id),null);
  assert.equal((await one('select aal_snapshot($1) as value',[a.restaurant_id])).role,'owner');
  await one('select aal_group($1::jsonb) as value',[JSON.stringify({op:'invite',group_id:g.group_id,email:'lea@g.example',role:'manager'})]);
  await assert.rejects(one('select aal_group($1::jsonb) as value',[JSON.stringify({op:'invite',group_id:g.group_id,email:'sam@g.example',role:'waiter'})]),/Waiters are invited at their venue/);
  await one('select aal_staff($1,$2::jsonb) as value',[a.restaurant_id,JSON.stringify({op:'invite',email:'sam@g.example',role:'waiter'})]);   // the group key manages a venue of its group
  await assert.rejects(one('select aal_staff($1,$2::jsonb) as value',[o.restaurant_id,JSON.stringify({op:'list'})]),/Only the restaurant owner/);
  // the venue's own key: that venue only
  await as('anon',{'x-aalayna-key':h.owner_key});
  assert.equal(await role(h.restaurant_id),'owner');assert.equal(await role(a.restaurant_id),null);
  // a group manager signed in: owner at both venues, listed in 'mine' for both, not at the other venue
  const lea={role:'authenticated',sub:LEA,email:'lea@g.example'},sam={role:'authenticated',sub:SAM,email:'sam@g.example'};
  await as('authenticated',{},lea);
  assert.equal(await role(h.restaurant_id),'owner');assert.equal(await role(a.restaurant_id),'owner');assert.equal(await role(o.restaurant_id),null);
  assert.deepEqual((await one("select aal_staff(null,'{\"op\":\"mine\"}'::jsonb) as value")).map(m=>[m.restaurant_id,m.role,m.group_id]).sort(),[[a.restaurant_id,'manager',g.group_id],[h.restaurant_id,'manager',g.group_id]].sort());
  await assert.rejects(one('select aal_group($1::jsonb) as value',[JSON.stringify({op:'invite',group_id:g.group_id,email:'x@g.example',role:'manager'})]),/Only the group owner can manage/);
  assert.equal((await one('select aal_group($1::jsonb) as value',[JSON.stringify({op:'list',group_id:g.group_id})])).venue_staff,null);   // a manager sees the group, not each venue's staff list
  // a waiter of Achrafieh: a waiter there, nobody at Hamra
  await as('authenticated',{},sam);
  assert.equal(await role(a.restaurant_id),'waiter');assert.equal(await role(h.restaurant_id),null);
  assert.equal((await one('select aal_snapshot($1) as value',[a.restaurant_id])).role,'waiter');
  await assert.rejects(one('select aal_group($1::jsonb) as value',[JSON.stringify({op:'list',group_id:g.group_id})]),/Only the group owner or a group manager/);
  // a venue leaving the group leaves the group's reach at once
  await as('anon',{'x-aalayna-admin':'adm_test'});await one('select aal_admin_group_venue($1,$2,$3) as value',[g.group_id,a.restaurant_id,'remove']);
  await as('authenticated',{},lea);assert.equal(await role(a.restaurant_id),null);assert.equal(await role(h.restaurant_id),'owner');
  await as('anon',{'x-aalayna-key':g.owner_key});assert.equal(await role(a.restaurant_id),null);
 }finally{await db.close();}
});

/* ------------------------------------------------------------------ the close */
let loaded;
const mod=()=>loaded||(loaded=(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-close-')),file=path.join(dir,'handler.mjs');
 fs.copyFileSync(path.join(root,'supabase/functions/daily-close/handler.js'),file);return import(pathToFileURL(file).href);})());
const SECRET='test-cron-secret-not-real',NOW=Date.parse('2026-10-01T01:00:00Z'),T=t=>'2026-09-30T'+t+'Z';
const R1='["mayda","hamra"]',R2='["mayda","achrafieh"]',R3='["solo","gemmayzeh"]',GID='grp_0123456789abcdef';
function fakeDb(seed,{noGroups=false}={}){
 const db=Object.assign({venue_profiles:[],staff_members:[],kv_docs:[],kv_rows:[],daily_close_log:[]},noGroups?{}:{owner_groups:[],owner_group_venues:[],owner_group_staff:[],daily_close_group_log:[]},seed),calls=[];
 const cell=(row,col)=>{const m=/^(\w+)->>(\w+)$/.exec(col);if(m){const v=row[m[1]]&&row[m[1]][m[2]];return v==null?null:String(v);}return row[col]==null?null:row[col];};
 const iso=/^\d{4}-\d\d-\d\dT/,cmp=(a,b)=>iso.test(String(a))&&iso.test(String(b))?Date.parse(a)-Date.parse(b):String(a)<String(b)?-1:String(a)>String(b)?1:0;
 const ok=(op,c)=>{if(op==='is.null')return c===null;if(c===null)return false;if(op.startsWith('eq.'))return String(c)===op.slice(3);if(op.startsWith('gte.'))return cmp(c,op.slice(4))>=0;
  if(op.startsWith('in.('))return op.slice(4,-1).split(',').includes(String(c));throw new Error('fake: filter '+op);};
 const match=(t,params)=>db[t].filter(r=>{for(const [k,v] of params)if(!['select','order','limit','offset','on_conflict'].includes(k)&&!ok(v,cell(r,k)))return false;return true;});
 db.calls=calls;
 db.rest=async(p,opts={})=>{
  const i=p.indexOf('?'),t=i<0?p:p.slice(0,i),params=new URLSearchParams(i<0?'':p.slice(i+1)),method=opts.method||'GET';calls.push({t,method,p});
  if(!db[t]){if(/^owner_group|^daily_close_group/.test(t))throw new Error('database 404: {"code":"PGRST205","message":"Could not find the table public.'+t+' in the schema cache"}');throw new Error('fake: no table '+t);}
  if(method==='GET'){const rows=match(t,params),off=Number(params.get('offset')||0),lim=params.has('limit')?Number(params.get('limit')):rows.length;return plain(rows.slice(off,off+lim));}
  if(method==='POST'){const out=[];for(const item of JSON.parse(opts.body)){const col=t==='daily_close_group_log'?'group_id':'restaurant_id';
    if(db[t].some(r=>r[col]===item[col]&&r.day===item.day))continue;const row=Object.assign({id:'log-'+(db[t].length+1)},item);db[t].push(row);out.push(row);}return plain(out);}
  if(method==='PATCH'){const patch=JSON.parse(opts.body);match(t,params).forEach(r=>Object.assign(r,patch));return null;}
 };
 return db;
}
const kv=(rid,collection,id,body,updated)=>({restaurant_id:rid,collection,id,body,updated_at:updated});
const pay=(rid,id,b)=>kv(rid,'aal.settle',id,Object.assign({id,venueId:rid,currency:'USD',tip:0},b),[b.ts,b.confirmedAt].filter(Boolean).sort().pop());
const chk=(rid,id,b)=>kv(rid,'aal.checks',id,Object.assign({id,venueId:rid},b),[b.openedAt,b.closedAt].filter(Boolean).sort().pop());
function fixture(o={}){
 return fakeDb({
  venue_profiles:[{restaurant_id:R1,name:'Mayda',place:'Hamra',slug:'mayda-hamra'},{restaurant_id:R2,name:'Mayda',place:'Achrafieh',slug:'mayda-achrafieh'},{restaurant_id:R3,name:'Solo',place:'Gemmayzeh',slug:'solo'}],
  staff_members:[
   {restaurant_id:R1,email:'karim@mayda.example',role:'owner',revoked_at:null},       // also group owner: gets the group email only
   {restaurant_id:R1,email:'chef@mayda.example',role:'manager',revoked_at:null},
   {restaurant_id:R2,email:'sam@mayda.example',role:'waiter',revoked_at:null},
   {restaurant_id:R3,email:'solo@solo.example',role:'owner',revoked_at:null}],
  kv_docs:[{restaurant_id:R1,key:'aal.rate',body:89500}],
  kv_rows:[
   chk(R1,'h1',{table:4,openedAt:T('10:00:00.000'),closedAt:T('12:00:00.000'),totalCents:3000,lines:[{id:'d1',q:2,p:20,name:'Hummus'},{id:'d2',q:1,p:10,name:'Kebab'}]}),
   chk(R1,'h2',{table:7,openedAt:T('19:00:00.000'),totalCents:1500,lines:[]}),
   pay(R1,'hp1',{checkId:'h1',table:4,rail:'cash',amount:32,tip:2,amountUsd:32,status:'confirmed',ts:T('11:00:00.000'),confirmedAt:T('11:05:00.000')}),
   pay(R1,'hp2',{checkId:'h2',table:7,rail:'cash',amount:15,amountUsd:15,status:'pending',ts:T('20:00:00.000')}),
   kv(R1,'aal.events','he1',{eventId:'he1',eventType:'review_submitted',createdAt:T('12:30:00.000'),payload:{rating:5}},T('12:30:00.000')),
   chk(R2,'a1',{table:2,openedAt:T('13:00:00.000'),closedAt:T('14:00:00.000'),totalCents:5000,lines:[{id:'x9',q:3,p:30,name:'Hummus'},{id:'x8',q:1,p:20,name:'Fattoush'}]}),
   pay(R2,'ap1',{checkId:'a1',table:2,rail:'card',amount:55,tip:5,amountUsd:55,status:'confirmed',ts:T('13:50:00.000'),confirmedAt:T('13:55:00.000'),externalRef:'r-1'}),
   kv(R2,'aal.events','ae1',{eventId:'ae1',eventType:'review_submitted',createdAt:T('14:30:00.000'),payload:{rating:2}},T('14:30:00.000')),
   kv(R2,'aal.events','ae2',{eventId:'ae2',eventType:'review_submitted',createdAt:T('14:40:00.000'),payload:{rating:4}},T('14:40:00.000')),
   chk(R3,'s1',{table:1,openedAt:T('12:00:00.000'),closedAt:T('12:30:00.000'),totalCents:700,lines:[{id:'z',q:1,p:7,name:'Lemonade'}]}),
   pay(R3,'sp1',{checkId:'s1',table:1,rail:'cash',amount:7,amountUsd:7,status:'confirmed',ts:T('12:10:00.000'),confirmedAt:T('12:11:00.000')})],
  owner_groups:[{id:GID,name:'Mayda Group',owner_key:'not-read-by-the-close'}],
  owner_group_venues:[{group_id:GID,restaurant_id:R1},{group_id:GID,restaurant_id:R2}],
  owner_group_staff:o.groupStaff||[
   {group_id:GID,email:'karim@mayda.example',role:'owner',revoked_at:null},
   {group_id:GID,email:'lea@mayda.example',role:'manager',revoked_at:null},
   {group_id:GID,email:'gone@mayda.example',role:'manager',revoked_at:'2026-09-01T00:00:00.000Z'}]
 },o);
}
function harness(db,{now=NOW}={}){
 const sent=[],failFor=new Set(),state={now};
 return mod().then(m=>{
  const handle=m.createHandler({rest:db.rest,send:async x=>{if(failFor.has(x.to))throw new Error('rejected');sent.push(x);return {id:'em-'+sent.length};},now:()=>state.now,env:{AALAYNA_CRON_SECRET:SECRET}});
  const call=async(qs='')=>{const r=await handle(new Request('https://x.test/functions/v1/daily-close'+qs,{method:'POST',headers:{'X-Aalayna-Cron':SECRET}}));return {status:r.status,body:await r.json()};};
  return {m,db,sent,failFor,call,state};
 });
}
const csvOf=x=>Buffer.from(x.attachments[0].content,'base64').toString('utf8');

test('the group close: one email to the group\'s owners and managers, the venues\' own closes to the rest',async()=>{
 const h=await harness(fixture()),j=(await h.call('')).body;
 assert.equal(j.day,'2026-09-30');
 assert.deepEqual(j.groups.map(g=>[g.groupId,g.status,g.recipients]),[[GID,'sent',2]]);
 const st=Object.fromEntries(j.results.map(r=>[r.restaurantId,[r.status,r.reason||'']]));
 assert.deepEqual(st,{[R1]:['sent',''],[R2]:['skipped','no active owner or manager email'],[R3]:['sent','']});   // Achrafieh's only own staff is a waiter
 const group=h.sent.filter(x=>x.subject==='Mayda Group: Wednesday 30 September, on Aalayna');
 assert.deepEqual(group.map(x=>x.to).sort(),['karim@mayda.example','lea@mayda.example']);   // not revoked, not a waiter
 assert.deepEqual(h.sent.filter(x=>x.subject==='Mayda: Wednesday 30 September, on Aalayna').map(x=>x.to),['chef@mayda.example']);   // Karim has the group's
 assert.deepEqual(h.sent.filter(x=>x.subject.startsWith('Solo:')).map(x=>x.to),['solo@solo.example']);   // a single-venue owner: unchanged
 assert.deepEqual(h.db.daily_close_group_log.map(r=>[r.group_id,r.day,r.status,r.recipients]),[[GID,'2026-09-30','sent',2]]);
 // a rerun: already sent, nothing more
 const again=(await h.call('')).body;assert.equal(again.groups[0].status,'already sent');assert.equal(again.results.find(r=>r.restaurantId===R1).status,'already sent');assert.equal(h.sent.length,4);
});

test('the group email: the group line is the sum of the venues\' closes, then a section per venue',async()=>{
 const h=await harness(fixture());await h.call('?group='+GID+'&date=2026-09-30');
 assert.equal(h.sent.length,2);
 const t=h.sent[0].text;
 assert.match(t,/^Mayda Group, Wednesday 30 September, 04:00 to 04:00 Beirut time\.\n2 venues: Mayda · Hamra, Mayda · Achrafieh\./);
 const all=t.slice(t.indexOf('All venues\n'),t.indexOf('\nNeeds action'));
 assert.match(all,/Bills opened:\s+3\n/);assert.match(all,/Bills closed:\s+2\n/);
 assert.match(all,/Still open at 04:00:\s+1 \(Mayda · Hamra table 7\)/);
 assert.match(all,/Cash confirmed:\s+1 payment, \$32\.00\n/);                                    // no lira in the group line: each venue has its own rate
 assert.match(all,/Digital confirmed:\s+1 payment, \$55\.00/);assert.match(all,/Tips:\s+\$7\.00 \(Card \$5\.00, Cash \$2\.00\)/);
 assert.match(all,/Guests who rated:\s+3, average 3\.7 out of 5/);                               // (5 + 2 + 4) / 3, not the mean of the venue averages
 assert.match(t,/- Mayda · Hamra: Cash requested and never confirmed: 1, \$15\.00, table 7\./);
 assert.match(t,/Top dishes across the venues \(quantity on closed bills\)\n1\. Hummus, 5\n2\. Fattoush, 1\n3\. Kebab, 1/);   // Hummus 2 + 3, by name across venues
 assert.match(t,/\nMayda · Hamra\nBills opened:\s+2\n[\s\S]*Cash confirmed:\s+1 payment, \$32\.00 \(LL 2,864,000\)/);   // the venue's own section keeps its lira line
 assert.match(t,/\nMayda · Achrafieh\nBills opened:\s+1\n/);
 assert.match(h.sent[0].html,/<h2[^>]*>All venues<\/h2>/);assert.match(h.sent[0].html,/Mayda · Achrafieh<\/h2>/);
 // the figures: the group's sum equals the sum of each venue's own computeClose
 const m=h.m,w=m.windowFor('2026-09-30'),db=fixture();
 const venueClose=async rid=>{const q=async(c)=>db.rest(`kv_rows?restaurant_id=eq.${encodeURIComponent(rid)}&collection=eq.${c}`);
  return m.computeClose({window:w,checks:await q('aal.checks'),settles:await q('aal.settle'),guests:await q('aal.guests'),events:await q('aal.events'),docs:await db.rest(`kv_docs?restaurant_id=eq.${encodeURIComponent(rid)}`)});};
 const f1=await venueClose(R1),f2=await venueClose(R2),g=m.sumCloses('2026-09-30',[f1,f2]);
 for(const k of ['opened','closed','stillOpen'])assert.equal(g.bills[k],f1.bills[k]+f2.bills[k],k);
 for(const k of ['cash','digital','till','refunds'])assert.equal(g[k].usdCents,f1[k].usdCents+f2[k].usdCents,k);
 assert.equal(g.tips.usdCents,f1.tips.usdCents+f2.tips.usdCents);assert.equal(g.pendingCash.usdCents,f1.pendingCash.usdCents+f2.pendingCash.usdCents);
 assert.equal(g.csvRows.length,f1.csvRows.length+f2.csvRows.length);
 assert.equal(g.ratings.count,3);assert.equal(g.ratings.average,3.7);
 // the per-venue close is unchanged by the group: the same email as a venue with no group
 const solo=await harness(fixture());solo.db.owner_groups.length=0;solo.db.owner_group_venues.length=0;
 await solo.call('?venue='+encodeURIComponent(R1)+'&date=2026-09-30');
 const grouped=await harness(fixture());await grouped.call('?venue='+encodeURIComponent(R1)+'&date=2026-09-30');
 assert.equal(grouped.sent[0].text,solo.sent.find(x=>x.to==='chef@mayda.example').text);
 assert.equal(csvOf(grouped.sent[0]),csvOf(solo.sent[0]));
});

test('the group CSV: every venue\'s rows exactly as its own CSV, with the venue in front',async()=>{
 const h=await harness(fixture());await h.call('?group='+GID+'&date=2026-09-30');
 const att=h.sent[0].attachments[0];assert.equal(att.filename,'close-mayda-group-2026-09-30.csv');
 const lines=csvOf(h.sent[0]).split('\r\n');assert.equal(lines.pop(),'');
 assert.equal(lines[0],'venue,settlementId,checkId,table,rail,status,amountUsd,tipUsd,currency,confirmedAt,externalRef,refunded');
 assert.deepEqual(lines.slice(1).map(l=>l.split(',').slice(0,2)),[['Mayda · Hamra','hp1'],['Mayda · Hamra','hp2'],['Mayda · Achrafieh','ap1']]);
 assert.equal(lines[1],`Mayda · Hamra,hp1,h1,4,cash,confirmed,32.00,2.00,USD,${T('11:05:00.000')},,`);
 // each venue's own CSV, minus its header, is its block of the group's
 const v=await harness(fixture());await v.call('?venue='+encodeURIComponent(R1)+'&date=2026-09-30');
 assert.deepEqual(csvOf(v.sent[0]).split('\r\n').slice(1).filter(Boolean),lines.slice(1,3).map(l=>l.slice('Mayda · Hamra,'.length)));
});

test('group close routing: ?group= alone, unknown group, force, quiet days, a group with no one to send to',async()=>{
 const h=await harness(fixture());
 assert.equal((await h.call('?group=grp_nope&date=2026-09-30')).status,404);
 const only=(await h.call('?group='+GID+'&date=2026-09-30')).body;
 assert.equal(only.results.length,0);assert.equal(only.groups[0].status,'sent');assert.equal(h.db.daily_close_log.length,0);   // no venue was closed
 assert.equal((await h.call('?group='+GID+'&date=2026-09-30')).body.message,'already sent');
 assert.equal((await h.call('?group='+GID+'&date=2026-09-30&force=1')).body.groups[0].status,'sent');assert.equal(h.sent.length,4);
 assert.equal((await h.call('?venue='+encodeURIComponent(R3)+'&date=2026-09-30')).body.groups.length,0);   // ?venue= closes no group
 // a quiet day for every venue of the group: skipped, no email; force sends the zero email
 const q=await harness(fixture(),{now:Date.parse('2026-10-03T01:00:00Z')});
 const quiet=(await q.call('?group='+GID+'&date=2026-10-01')).body;
 assert.equal(quiet.groups[0].status,'skipped');assert.equal(quiet.groups[0].reason,'no activity');assert.equal(q.sent.length,0);
 assert.equal((await q.call('?group='+GID+'&date=2026-10-01&force=1')).body.groups[0].status,'sent');
 // nobody live on the group's staff list: skipped and said why; the venues still go out
 const none=await harness(fixture({groupStaff:[{group_id:GID,email:'gone@mayda.example',role:'owner',revoked_at:'2026-09-01T00:00:00.000Z'}]}));
 const j=(await none.call('')).body;
 assert.equal(j.groups[0].status,'skipped');assert.equal(j.groups[0].reason,'no active group owner or manager email');
 assert.deepEqual(none.sent.filter(x=>x.subject.startsWith('Mayda:')).map(x=>x.to).sort(),['chef@mayda.example','karim@mayda.example']);   // no group email, so Karim gets his venue's
 // a failed group send is retried by the next plain call
 const f=await harness(fixture());f.failFor.add('karim@mayda.example');f.failFor.add('lea@mayda.example');
 const bad=await f.call('');assert.equal(bad.status,500);assert.equal(bad.body.groups[0].status,'failed');
 f.failFor.clear();f.state.now+=3600000;
 const ok=(await f.call('')).body;assert.equal(ok.groups[0].status,'sent');assert.equal(f.db.daily_close_group_log[0].status,'sent');
});

test('without the groups migration the close is exactly the per-venue close it was',async()=>{
 const db=fixture({},{noGroups:true});delete db.owner_groups;delete db.owner_group_venues;delete db.owner_group_staff;delete db.daily_close_group_log;
 const h=await harness(db),r=await h.call('');
 assert.equal(r.status,200);assert.deepEqual(r.body.groups,[]);
 assert.deepEqual(h.sent.map(x=>x.to).sort(),['chef@mayda.example','karim@mayda.example','solo@solo.example']);
 assert.equal((await h.call('?group='+GID+'&date=2026-09-30')).status,404);
});
