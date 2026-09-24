/* Table QR sessions (T3): guest.html?v=<slug>&t=<table>&s=<code>. The real guest page
   (store, growth rules, table QR script, sync layer and the page's own script) runs
   against a mocked Supabase and a minimal DOM. Proves that a scan resolves the code
   through aal_table_session, that the page then becomes a bill link (TABLE and key from
   the server), that a table without a bill shows the empty bill and polls every 10
   seconds on the bill view until the key can be attached in place, and that a refused
   code shows the message and never falls back to the demo. The SQL itself is not run
   here; see the optional PGlite block at the end. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);
const SLUG='kababji-hamra',TOKEN='tbl_'+'ab'.repeat(24),RID=JSON.stringify(['kababji','hamra']);
const VENUE={name:'Kababji',place:'Hamra',gplace:null,brand:'#EA312B',bg:null,font:null,menu_pack:'kababji'};
const MENU={version:7,sections:[{id:'grl',name:'Grill',win:'all'}],items:[{id:'k1',sec:'grl',name:'Shish taouk',desc:'',price:9,status:'incomplete',available:true}],at:'2026-09-24T09:00:00.000Z'};
const DOCS=[{key:'aal.live',body:MENU,updated_at:'now'}];
const CHECK={id:'bill-7',venueId:RID,table:7,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],totalCents:1800,amountUsd:18,revision:1};

/* a minimal DOM: every element is a stub that accepts what the page does to it */
function makeDom(){
 const byId=new Map();
 function el(id){
  const cls=new Set(),kids=[];
  const node={id:id||'',style:{setProperty(){}},dataset:{},innerHTML:'',textContent:'',value:'',disabled:false,checked:false,hidden:false,children:kids,childNodes:kids,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},prepend(...c){kids.unshift(...c);},insertBefore(c){kids.push(c);return c;},removeChild(c){return c;},remove(){},replaceChildren(){kids.length=0;},
   setAttribute(){},getAttribute(){return null;},removeAttribute(){},hasAttribute(){return false;},addEventListener(){},removeEventListener(){},
   querySelector:()=>el(),querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),getClientRects:()=>[],
   focus(){},blur(){},click(){},scrollTo(){},scrollIntoView(){},closest:()=>null,matches:()=>false,contains:()=>false,
   offsetWidth:0,offsetHeight:0,offsetLeft:0,offsetTop:0,scrollTop:0,scrollHeight:0,clientHeight:0,clientWidth:0,parentNode:null,parentElement:null,firstChild:null,lastChild:null,nextSibling:null};
  return node;
 }
 const document={visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  querySelector:()=>el(),querySelectorAll:()=>[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
/* one guest page load. server.session answers aal_table_session; server.rows feed aal_snapshot */
function boot({search,server,session=new Map(),local=new Map()}){
 const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;}});
 const intervals=[],replaced=[],document=makeDom();
 const window={document,location:{pathname:'/guest.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/guest.html'+search,replace(u){replaced.push(u);}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),navigator:{userAgent:'test',clipboard:{writeText(){}}},crypto:require('node:crypto').webcrypto,
  addEventListener(){},removeEventListener(){},requestAnimationFrame(f){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(i){if(intervals[i-1])intervals[i-1].cleared=true;},setTimeout(f){return 0;},clearTimeout(){},
  scrollTo(){},alert(){},prompt(){},confirm:()=>true,innerHeight:800,innerWidth:400,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,RegExp,Set,Map};
 window.window=window;window.self=window;
 window.fetch=async(url,options)=>{
  const body=options&&options.body?JSON.parse(options.body):null;server.calls.push({url,body,headers:options.headers});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>JSON.stringify(obj)});
  if(url.endsWith('/rpc/aal_table_session'))return server.session(body);
  if(url.endsWith('/rpc/aal_snapshot')){
   const key=options.headers['x-aalayna-key'];if(!server.keys[key])return reply(400,{message:'Open a current bill link or sign in with this restaurant owner key.'});
   return reply(200,{version:2,role:'guest',checkId:server.keys[key],rows:[{collection:'aal.checks',id:CHECK.id,body:CHECK,updated_at:'now'}],docs:DOCS});
  }
  if(url.endsWith('/rpc/aal_mutate'))return reply(200,body.p_body);
  return reply(201,'');
 };
 const ctx=vm.createContext(window);
 const run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(TQ,'guest.html#table-qr');
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 run(PAGE,'guest.html#page');
 return {window,document,intervals,replaced,session,local,run:c=>run(c,'probe')};
}
const serverWith=(answer)=>({calls:[],keys:{},session:answer});
const ok=obj=>({ok:true,status:200,text:async()=>JSON.stringify(obj)});
const answer=(extra)=>Object.assign({restaurant_id:RID,venue:VENUE,table:7,checkId:null,key:null,docs:DOCS},extra);
/* the page after location.replace: the same tab, the rewritten address */
function reload(prev,server){const u=prev.replaced[prev.replaced.length-1];return boot({search:u.slice(u.indexOf('?')),server,session:prev.session,local:prev.local});}

test('a scan with v, t and s calls aal_table_session with the slug, table and code, strips s and stays inert',async()=>{
 const server=serverWith(async()=>ok(answer({checkId:CHECK.id,key:'chk_'+'cd'.repeat(24)})));
 const p=boot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server});
 assert.equal(p.window.AalaynaTableQR.holding,true);
 assert.equal(p.window.location.search,'?v='+SLUG+'&t=7');                   // s left the address at once
 assert.equal(p.window.Aalayna.sync,undefined);                              // no key of any venue woke up
 await flush();
 const call=server.calls.find(c=>c.url.endsWith('/rpc/aal_table_session'));
 assert.deepEqual(call.body,{p_slug:SLUG,p_table:7,p_token:TOKEN});
 assert.equal(call.headers['x-aalayna-key'],undefined);                      // no venue key is sent
 assert.equal(server.calls.filter(c=>!c.url.endsWith('/rpc/aal_table_session')).length,0);
 assert.equal(p.window.Aalayna.events().length,0);                           // nothing logged on the hidden load
 assert.equal(p.replaced.length,1);
 const next=new URLSearchParams(p.replaced[0].split('?')[1]);
 assert.equal(next.get('venue'),'Kababji');assert.equal(next.get('place'),'Hamra');assert.equal(next.get('brand'),'EA312B');
 assert.equal(next.get('k'),'chk_'+'cd'.repeat(24));assert.equal(next.get('s'),null);assert.equal(next.get('menu'),null);
});

test('with an open bill the rewritten page is a bill link: TABLE from the server, key held, check bound',async()=>{
 const KEY='chk_'+'cd'.repeat(24);
 const server=serverWith(async()=>ok(answer({checkId:CHECK.id,key:KEY})));server.keys[KEY]=CHECK.id;
 const first=boot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server});await flush();
 const p=reload(first,server);
 assert.equal(p.run('TABLE'),7);                                            // from the answer, before the snapshot
 assert.equal(p.window.location.search,'?venue=Kababji&place=Hamra&brand=EA312B');   // k stripped by the sync layer
 assert.equal(p.local.get('aal.access:'+RID+':guest'),KEY);                  // held per venue and page role
 assert.equal(p.window.Aalayna.venueId(),RID);
 await flush();
 assert.equal(p.window.Aalayna.demoMode(),false);
 assert.equal(p.window.Aalayna.sync.boundCheck().id,CHECK.id);
 assert.equal(p.run('TABLE'),7);assert.equal(p.run('TOTAL'),18);assert.equal(p.run('BILL.length'),1);
 assert.equal(p.run('AalaynaTableQR.waiting'),false);
 assert.equal(p.intervals.filter(i=>i.ms===10000).length,0);                // nothing to poll for
 const scan=server.calls.find(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_body.eventType==='qr_scan');
 assert.equal(scan.body.p_body.tableId,'7');                                 // the scan is recorded against the bill
});

test('a table without a bill shows the menu and an empty bill, polls every 10 s on the bill view, then attaches in place',async()=>{
 const KEY='chk_'+'ef'.repeat(24);let bill=false;
 const server=serverWith(async()=>ok(bill?answer({checkId:CHECK.id,key:KEY}):answer()));server.keys[KEY]=CHECK.id;
 // a key this browser once held for the venue belongs to another party
 const local=new Map([['aal.access:'+RID+':guest','chk_'+'99'.repeat(24)]]);
 const first=boot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server,local});await flush();
 assert.equal(new URLSearchParams(first.replaced[0].split('?')[1]).get('k'),null);
 const p=reload(first,server);
 assert.equal(p.local.has('aal.access:'+RID+':guest'),false);
 assert.equal(p.run('AalaynaTableQR.waiting'),true);
 assert.equal(p.window.Aalayna.sync.enabled,false);
 assert.equal(p.window.Aalayna.demoMode(),false);assert.equal(p.window.Aalayna.sampleAllowed(),false);
 assert.equal(p.run('TABLE'),7);assert.equal(p.run('BILL.length'),0);assert.equal(p.run('TOTAL'),0);assert.equal(p.run('CHECK'),null);
 assert.match(p.document.getElementById('r-items').innerHTML,/Your bill appears here once your server enters it\./);
 assert.deepEqual(p.run('MENU.map(function(m){return m.n;})'),['Shish taouk']);  // the server's menu, not the demo seed
 const timer=p.intervals.find(i=>i.ms===10000);assert.ok(timer,'a 10 second poll is set');
 const asks=()=>server.calls.filter(c=>c.url.endsWith('/rpc/aal_table_session')).length,before=asks();
 await timer.f();assert.equal(asks(),before);                               // not on the bill view: no request
 p.run("go('v-bill')");
 await timer.f();assert.equal(asks(),before+1);                             // on the bill view: asks again
 assert.equal(p.run('BILL.length'),0);assert.equal(p.run('AalaynaTableQR.waiting'),true);
 bill=true;await timer.f();await flush();
 assert.equal(asks(),before+2);
 assert.equal(p.run('AalaynaTableQR.waiting'),false);assert.equal(timer.cleared,true);
 assert.equal(p.window.Aalayna.sync.enabled,true);assert.equal(p.window.Aalayna.sync.key(),KEY);
 assert.equal(p.local.get('aal.access:'+RID+':guest'),KEY);
 assert.equal(p.run('CHECK.id'),CHECK.id);assert.equal(p.run('TOTAL'),18);assert.equal(p.run('BILL[0].n'),'Shish taouk');
 // the outbox sends one run at a time; the next sync tick (4 s) sends what queued meanwhile
 p.intervals.filter(i=>i.ms===4000).forEach(i=>i.f());await flush(12);
 const events=server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')).map(c=>c.body.p_body.eventType);
 assert.ok(events.indexOf('qr_scan')>=0&&events.indexOf('bill_requested')>=0);   // recorded once a bill exists
});

test('a refused code shows the message, never the demo; a revoked code stops the poll',async()=>{
 const refuse=async()=>({ok:false,status:400,text:async()=>JSON.stringify({code:'P0001',message:'This table code is not active. Ask your server for the bill.'})});
 const server=serverWith(refuse);
 const p=boot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server});await flush();
 assert.equal(p.replaced.length,0);
 assert.equal(p.run('AalaynaTableQR.message'),'This table code is not active. Ask your server for the bill.');
 assert.equal(p.document.documentElement.classList.contains('tq-hold'),true);   // the page under it stays hidden
 // a malformed code is refused without asking
 const q=boot({search:'?v='+SLUG+'&t=7&s=tbl_short',server:serverWith(refuse)});await flush();
 assert.equal(q.run('AalaynaTableQR.message'),'This table code is not active. Ask your server for the bill.');
 // revoked while waiting
 let revoked=false;const s2=serverWith(async()=>revoked?refuse():ok(answer()));
 const first=boot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server:s2});await flush();
 const w=reload(first,s2);w.run("go('v-bill')");
 const timer=w.intervals.find(i=>i.ms===10000);revoked=true;await timer.f();
 assert.equal(w.run('AalaynaTableQR.waiting'),false);assert.equal(timer.cleared,true);
 assert.equal(w.run('AalaynaTableQR.message'),'This table code is not active. Ask your server for the bill.');
});

test('demo mode is untouched: no v, t or s means table 12, no request, no poll',async()=>{
 const server=serverWith(async()=>{throw new Error('must not call');});
 const p=boot({search:'',server});await flush();
 assert.equal(p.run('AalaynaTableQR.holding'),false);assert.equal(p.run('AalaynaTableQR.waiting'),false);
 assert.equal(p.run('TABLE'),12);assert.equal(p.window.Aalayna.demoMode(),true);assert.ok(p.run('BILL.length')>0);
 assert.equal(server.calls.length,0);assert.equal(p.intervals.filter(i=>i.ms===10000).length,0);
});

/* The SQL, against a real PostgreSQL (PGlite), like tests/database.test.cjs. Skipped
   unless PGLITE_MODULE points at @electric-sql/pglite (see supabase/README.md). */
const modulePath=process.env.PGLITE_MODULE;
test('sessions SQL: owner-issued table codes, anon table sessions, a chk_ key for the open bill',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>fs.readFileSync(path.join(root,'supabase',f),'utf8').replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await assert.rejects(db.exec(sql('sessions-2026-09-24.sql')),/Run hardening-2026-09-24.sql/);   // refuses to run too early
  await db.exec('rollback');
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','sessions-2026-09-24.sql'])await db.exec(sql(f));
  const hdr=async(h)=>{await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(h),JSON.stringify({role:'anon'})]);};
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  await hdr({'x-aalayna-admin':'adm_test'});
  const v=(await db.query("select aal_admin_register_venue('Kababji','Hamra','kababji-hamra','{}'::jsonb) as value")).rows[0].value;
  const other=(await db.query("select aal_admin_register_venue('Other','Hamra',null,'{}'::jsonb) as value")).rows[0].value;
  await db.query("insert into kv_docs values($1,'aal.live',$2,now()),($1,'aal.draft',$3,now())",[v.restaurant_id,JSON.stringify({version:3,sections:[],items:[]}),JSON.stringify({secret:'draft'})]);
  await db.exec('set role anon');
  const tokens=async(rid,body)=>(await db.query('select aal_table_tokens($1,$2::jsonb) as value',[rid,JSON.stringify(body)])).rows[0].value;
  const session=async(slug,table,token)=>(await db.query('select aal_table_session($1,$2,$3) as value',[slug,table,token])).rows[0].value;
  const mutate=async(op,body)=>(await db.query('select aal_mutate($1,$2,$3::jsonb,$4) as value',[v.restaurant_id,op,JSON.stringify(body),''])).rows[0].value;
  await assert.rejects(db.query('select * from table_tokens'),/permission denied/);
  await hdr({'x-aalayna-key':v.guest_key});
  await assert.rejects(tokens(v.restaurant_id,{op:'list'}),/Owner key required/);
  await hdr({'x-aalayna-key':other.owner_key});
  await assert.rejects(tokens(v.restaurant_id,{op:'issue',table:7}),/Owner key required/);
  await hdr({'x-aalayna-key':v.owner_key});
  await assert.rejects(tokens(v.restaurant_id,{op:'issue',table:'7'}),/whole number/);
  let list=await tokens(v.restaurant_id,{op:'issue',table:7});
  assert.equal(list.slug,'kababji-hamra');assert.equal(list.tokens.length,1);assert.match(list.tokens[0].token,/^tbl_[0-9a-f]{48}$/);
  const first=list.tokens[0].token;
  list=await tokens(v.restaurant_id,{op:'issue',table:7});const code=list.tokens[0].token;
  assert.equal(list.tokens.length,1);assert.notEqual(code,first);                    // one live code per table
  await hdr({});
  await assert.rejects(session('kababji-hamra',7,first),/This table code is not active/); // the replaced code is dead
  await assert.rejects(session('kababji-hamra',8,code),/This table code is not active/);  // another table
  await assert.rejects(session('nope',7,code),/This table code is not active/);
  let s=await session('kababji-hamra',7,code);
  assert.equal(s.restaurant_id,v.restaurant_id);assert.equal(s.venue.name,'Kababji');assert.equal(s.table,7);
  assert.equal(s.checkId,null);assert.equal(s.key,null);assert.deepEqual(s.docs.map(d=>d.key),['aal.live']);   // never the draft
  await hdr({'x-aalayna-key':v.owner_key});
  await mutate('open_check',{id:'bill-7',table:7,lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],currency:'USD'});
  await mutate('open_check',{id:'bill-8',table:8,lines:[{id:'k1',q:1,p:9}],currency:'USD'});
  await hdr({});
  s=await session('kababji-hamra',7,code);
  assert.equal(s.checkId,'bill-7');assert.match(s.key,/^chk_[0-9a-f]{48}$/);
  await hdr({'x-aalayna-key':s.key});
  const snap=(await db.query('select aal_snapshot($1) as value',[v.restaurant_id])).rows[0].value;
  assert.equal(snap.checkId,'bill-7');assert.deepEqual(snap.rows.filter(r=>r.collection==='aal.checks').map(r=>r.id),['bill-7']);
  await hdr({'x-aalayna-key':v.owner_key});
  list=await tokens(v.restaurant_id,{op:'revoke',table:7});assert.equal(list.tokens.length,0);
  await hdr({});
  await assert.rejects(session('kababji-hamra',7,code),/This table code is not active/);
 }finally{await db.close();}
});
