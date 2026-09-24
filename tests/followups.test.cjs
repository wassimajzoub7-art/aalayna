/* Pilot-blocking follow-ups (T8). The real store, growth rules and sync layer (and, for
   the guest, the table QR script and the page's own script) run against a mocked
   Supabase and a minimal DOM, as in tests/offline.test.cjs, tests/table-sessions.test.cjs
   and tests/staff-auth.test.cjs. Proves that:
   - a job the server refuses with a definite answer (4xx with a message) leaves the
     outbox, is recorded as refused with the message, reaches onError and onState, is
     shown once in the status line until dismissed, and is never resent by Retry; a job
     that failed for network reasons (no answer, 5xx, 401, 404, a 4xx without a message)
     stays queued, keeps its place, and Retry sends it;
   - unsent changes follow the device from an owner link to a signed-in session and back,
     a waiter takes over only what a waiter may send, and another person's session
     outbox is never taken over;
   - a signed-in waiter's floor plan edit is sent to kv_docs, other documents are not;
   - a guest page whose bill closes shows "This bill is closed. Scan the table code again
     for a new bill." but keeps its key for the 24-hour grace period, so a guest on the
     payment receipt can still send the receipt request; the key is dropped only when the
     server refuses it, the page never falls back to the demo, and, from a table code, it
     polls aal_table_session again and the next bill replaces the kept key in place;
   - the bill view shows the real party size or nothing in live mode, and the demo line
     stays in demo mode; the status line says "1 change";
   - supabase/followups-2026-09-24.sql keeps the rules it states (static checks: the
     24-hour scope, no trigger, the clean-up inside aal_table_session), and, with
     PGLITE_MODULE set, behaves as stated against a real PostgreSQL. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=14)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const RID=JSON.stringify(['kababji','hamra']),SEARCH='?venue=Kababji&place=Hamra',USER='0b7c6f7e-1d2a-4c3b-9e8f-112233445566';
const OWNER_KEY='own_'+'ab'.repeat(18);
const CLOSED='This bill is closed. Scan the table code again for a new bill.';
const outboxKey=scope=>'aal.scope:'+JSON.stringify(scope)+':aal.outbox';
const OWNER_SCOPE=[RID,'owner',OWNER_KEY],USER_SCOPE=[RID,'staff','user:'+USER];
const sessionFor=(email,{token='at-1',refresh='rt-1',expiresIn=3600}={})=>JSON.stringify({access_token:token,refresh_token:refresh,expires_at:Math.floor(Date.now()/1000)+expiresIn,email,user_id:USER});
function store(m){return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}};}
const plain=x=>JSON.parse(JSON.stringify(x));

/* ---------- staff pages: the sync layer alone, as the dashboard loads it ---------- */
function staffDom(){
 const byId=new Map();
 function el(id){const kids=[];return {id:id||'',style:{},dataset:{},textContent:'',innerHTML:'',hidden:false,children:kids,childNodes:kids,
  setAttribute(){},getAttribute(){return null;},appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},addEventListener(){},removeEventListener(){},classList:{add(){},remove(){},toggle(){},contains:()=>false}};}
 return {visibilityState:'visible',cookie:'',readyState:'complete',getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  createElement:()=>el(),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},body:el('body'),head:el('head'),documentElement:el('html')};
}
/* the mocked shared store for staff: the role comes from the owner key or the bearer token */
function staffServer(o={}){
 const s={calls:[],down:false,sessionRole:o.sessionRole||'owner',docs:null,mutate:null,rows:[]};
 s.fetch=async(url,options)=>{
  if(s.down)throw new TypeError('Failed to fetch');
  const body=options&&options.body?JSON.parse(options.body):null;s.calls.push({url,body,headers:Object.assign({},options.headers)});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':typeof obj==='string'?obj:JSON.stringify(obj)});
  const u=url.replace('https://mock.invalid',''),h=options.headers||{};
  const role=h['x-aalayna-key']===OWNER_KEY?'owner':h.Authorization==='Bearer at-1'?s.sessionRole:null;
  if(u.indexOf('/auth/v1/')===0)return reply(200,{});
  if(u==='/rest/v1/rpc/aal_snapshot'){if(!role)return reply(400,{message:'Open a current bill link or sign in with this restaurant owner key.'});return reply(200,{version:2,role,checkId:null,rows:s.rows,docs:[]});}
  if(u==='/rest/v1/rpc/aal_mutate'){const r=s.mutate&&s.mutate(body,role);if(r)return reply(r[0],r[1]);return reply(200,body.p_body);}
  if(u.indexOf('/rest/v1/kv_docs')===0||u.indexOf('/rest/v1/kv_rows')===0){const r=s.docs&&s.docs(body,role);if(r)return reply(r[0],r[1]);return reply(201,null);}
  return reply(404,{message:'not found'});
 };
 s.docWrites=()=>s.calls.filter(c=>c.url.indexOf('/rest/v1/kv_docs')>=0);
 return s;
}
function staffBoot({search=SEARCH,server=staffServer(),local=new Map(),session=new Map()}={}){
 const document=staffDom(),intervals=[];
 const window={document,location:{pathname:'/dashboard.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/dashboard.html'+search,reload(){}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),navigator:{userAgent:'test'},crypto:require('node:crypto').webcrypto,
  addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},confirm:()=>true,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map,fetch:(u,o)=>server.fetch(u,o)};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 return {window,a:window.Aalayna,server,local,session,intervals,tick:async()=>{intervals.filter(i=>i.ms===4000).forEach(i=>i.f());await flush();}};
}
const floorEdit=(a,table,name)=>{const f=a.floor();f.tables[String(table)]=name;a.setFloor(f);};

test('a definite refusal leaves the outbox, is recorded with its message, reaches onError and onState, shows once and is never retried',async()=>{
 const server=staffServer(),p=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server});await p.a.sync.ready;await flush();
 const errors=[],states=[];p.a.sync.onError(r=>errors.push(r));p.a.sync.onState(s=>states.push(s));
 server.down=true;floorEdit(p.a,4,'Sara');await flush();
 assert.equal(p.a.sync.job('doc:aal.floor'),'pending');                             // a network failure keeps it
 assert.equal(p.a.sync.state().pending,1);assert.equal(p.a.sync.statusText(p.a.sync.state()),'Connection lost · 1 change waiting');
 server.down=false;server.docs=()=>[403,{code:'42501',message:'new row violates row-level security policy for table "kv_docs"'}];
 await p.a.sync.retry();await flush();
 assert.equal(server.docWrites().length,1);
 assert.equal(p.a.sync.job('doc:aal.floor'),'refused');
 assert.deepEqual(JSON.parse(p.local.get(outboxKey(OWNER_SCOPE))),{});              // out of the outbox, on the device too
 const s=p.a.sync.state();
 assert.equal(s.pending,0);assert.equal(s.failed,1);assert.equal(s.status,'error');
 assert.equal(s.lastRefusal,'Your role cannot save this change for this restaurant.');
 assert.equal(p.a.sync.statusText(s),'Not saved: Your role cannot save this change for this restaurant.');
 assert.equal(errors.length,1);
 assert.deepEqual([errors[0].id,errors[0].kind,errors[0].target,errors[0].shown],['doc:aal.floor','doc','aal.floor',false]);
 assert.equal(states[states.length-1].refused,1);assert.equal(states[states.length-1].outboxPending,0);
 // Retry only resends what is queued: the refused change is not sent again
 await p.a.sync.retry();await flush();await p.tick();
 assert.equal(server.docWrites().length,1);
 assert.deepEqual(plain(p.a.sync.refusals()).map(r=>r.message),['Your role cannot save this change for this restaurant.']);
 // shown once: dismissed, it is gone from the status line but stays on record
 p.a.sync.dismiss();
 assert.equal(p.a.sync.state().failed,0);assert.equal(p.a.sync.state().status,'live');assert.equal(p.a.sync.statusText(p.a.sync.state()),'Saved');
 assert.equal(p.a.sync.job('doc:aal.floor'),'refused');assert.equal(p.a.sync.refusals().length,0);
 assert.equal(states[states.length-1].refused,0);
 // the record survives a reload of the page
 const again=staffBoot({search:SEARCH,server,local:p.local});await again.a.sync.ready;await flush();
 assert.equal(again.a.sync.job('doc:aal.floor'),'refused');assert.equal(again.a.sync.state().failed,0);
});

test('network failures stay queued in order: no answer, 5xx, 401, 404 and a 4xx without a message are retried, not refused',async()=>{
 const server=staffServer(),p=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server});await p.a.sync.ready;await flush();
 const errors=[];p.a.sync.onError(r=>errors.push(r));
 const answers=[[503,{message:'Service unavailable'}],[401,{message:'JWT expired'}],[404,{code:'PGRST202',message:'Could not find the function'}],[400,'<html>bad gateway</html>']];
 let next=null;server.docs=()=>next;
 server.down=true;floorEdit(p.a,4,'Sara');p.a.util.write('aal.tips',{pooled:false,at:'2026-09-24T10:00:00.000Z'});await flush();
 assert.deepEqual(Object.keys(JSON.parse(p.local.get(outboxKey(OWNER_SCOPE)))).sort(),['doc:aal.floor','doc:aal.tips']);
 server.down=false;
 for(const a of answers){
  next=a;const before=server.docWrites().length;
  await p.a.sync.retry();await flush();
  assert.equal(server.docWrites().length,before+1,String(a[0]));                     // the first job only: the order is kept
  assert.equal(p.a.sync.job('doc:aal.floor'),'pending',String(a[0]));assert.equal(p.a.sync.job('doc:aal.tips'),'pending');
  assert.equal(p.a.sync.state().failed,0);
 }
 assert.equal(errors.length,0);
 next=null;await p.a.sync.retry();await flush();
 assert.equal(p.a.sync.job('doc:aal.floor'),null);assert.equal(p.a.sync.job('doc:aal.tips'),null);
 assert.equal(p.a.sync.state().status,'live');
 // an outbox from an older page kept a refusal as "blocked": it gets one more try under these rules
 const local=new Map([[outboxKey(OWNER_SCOPE),JSON.stringify({'doc:aal.floor':{kind:'doc',body:{restaurant_id:RID,key:'aal.floor',body:{servers:['Jad'],tables:{},pooled:false}},blocked:'Change was rejected (400).'}})]]);
 const old=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server:staffServer(),local});await old.a.sync.ready;await flush();
 assert.equal(old.server.docWrites().length,1);assert.equal(old.a.sync.job('doc:aal.floor'),null);
});

test('a refusal whose caller is waiting goes to that caller and is recorded as shown: no second message',async()=>{
 const server=staffServer(),p=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server});await p.a.sync.ready;await flush();
 const errors=[];p.a.sync.onError(r=>errors.push(r));
 server.mutate=b=>b.p_op==='close_check'?[400,{code:'P0001',message:'Bill is not fully settled'}]:null;
 await assert.rejects(p.a.closeServiceCheck('bill-1'),/Bill is not fully settled/);
 assert.equal(p.a.sync.job('op:close_check:bill-1'),'refused');
 assert.equal(p.a.sync.state().failed,0);assert.equal(p.a.sync.state().status,'live');
 assert.equal(errors.length,1);assert.equal(errors[0].shown,true);assert.equal(errors[0].op,'close_check');
});

test('the status line is grammatical: 1 change, 2 changes',()=>{
 const p=staffBoot({search:SEARCH+'&k='+OWNER_KEY});const t=p.a.sync.statusText;
 assert.equal(t({status:'offline',pending:1}),'Connection lost · 1 change waiting');
 assert.equal(t({status:'offline',pending:2}),'Connection lost · 2 changes waiting');
 assert.equal(t({status:'offline',pending:0}),'Connection lost');
 assert.equal(t({status:'syncing',pending:1}),'Syncing 1 change…');
 assert.equal(t({status:'error',failed:2,lastRefusal:'Bill unavailable'}),'2 changes not saved. Latest: Bill unavailable');
 const src=fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8');
 assert.equal(/' changes waiting'|changes need attention/.test(src),false);
});

test('an owner link to a signed-in session: unsent changes move to the new credential and are sent with it',async()=>{
 const server=staffServer(),local=new Map();
 const link=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server,local});await link.a.sync.ready;await flush();
 server.down=true;floorEdit(link.a,7,'Jad');await flush();
 assert.ok(JSON.parse(local.get(outboxKey(OWNER_SCOPE)))['doc:aal.floor']);
 // the owner signs in on this device; the next load is a session
 server.down=false;local.set('aal.session',sessionFor('rami@kababji.com'));
 const before=server.docWrites().length;
 const signed=staffBoot({server,local});await signed.a.sync.ready;await flush();
 assert.equal(signed.a.sync.signedIn,true);
 assert.equal(local.has(outboxKey(OWNER_SCOPE)),false);                             // nothing stranded under the old key
 const sent=server.docWrites().slice(before);
 assert.equal(sent.length,1);assert.equal(sent[0].body[0].key,'aal.floor');assert.equal(sent[0].body[0].body.tables['7'],'Jad');
 assert.equal(sent[0].headers.Authorization,'Bearer at-1');assert.equal('x-aalayna-key' in sent[0].headers,false);
 assert.equal(signed.a.sync.state().pending,0);
});

test('a signed-in session to an owner link: the session\'s unsent changes are carried and sent with the key',async()=>{
 const server=staffServer(),local=new Map([['aal.session',sessionFor('rami@kababji.com')]]);
 const signed=staffBoot({server,local});await signed.a.sync.ready;await flush();
 server.down=true;floorEdit(signed.a,3,'Sara');await flush();
 assert.ok(JSON.parse(local.get(outboxKey(USER_SCOPE)))['doc:aal.floor']);
 // the sign-in ended (a refused refresh clears the session, not the cache); the owner link is used
 server.down=false;local.delete('aal.session');
 const before=server.docWrites().length;
 const link=staffBoot({search:SEARCH+'&k='+OWNER_KEY,server,local});await link.a.sync.ready;await flush();
 const sent=server.docWrites().slice(before);
 assert.equal(sent.length,1);assert.equal(sent[0].headers['x-aalayna-key'],OWNER_KEY);assert.equal(sent[0].body[0].body.tables['3'],'Sara');
 assert.equal(local.has(outboxKey(USER_SCOPE)),false);
});

test('a waiter takes over only what a waiter may send; another person\'s session outbox is never taken',async()=>{
 const job=(kind,x)=>Object.assign({kind},x);
 const owned={'doc:aal.floor':job('doc',{body:{restaurant_id:RID,key:'aal.floor',body:{servers:['Sara'],tables:{'2':'Sara'},pooled:false}}}),
  'doc:aal.draft':job('doc',{body:{restaurant_id:RID,key:'aal.draft',body:{version:2,sections:[],items:[]}}}),
  'op:close_check:bill-1':job('op',{op:'close_check',body:{checkId:'bill-1'},token:''}),
  'op:confirm_cash:pay-1':job('op',{op:'confirm_cash',body:{id:'pay-1'},token:'',waiter:'gone'})};
 const other=[RID,'staff','user:someone-else'];
 const local=new Map([[outboxKey(OWNER_SCOPE),JSON.stringify(owned)],[outboxKey(other),JSON.stringify({'doc:aal.floor':owned['doc:aal.floor']})],
  ['aal.session',sessionFor('sara@kababji.com')]]);
 const server=staffServer({sessionRole:'waiter'});
 const p=staffBoot({server,local});await p.a.sync.ready;await flush();
 assert.equal(p.a.sync.state().role,'waiter');
 const ops=server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')).map(c=>c.body.p_op);
 assert.deepEqual(ops,['confirm_cash']);
 assert.deepEqual(server.docWrites().map(c=>c.body[0].key),['aal.floor']);
 assert.deepEqual(Object.keys(JSON.parse(local.get(outboxKey(OWNER_SCOPE)))).sort(),['doc:aal.draft','op:close_check:bill-1']);   // kept for the owner
 assert.ok(JSON.parse(local.get(outboxKey(other)))['doc:aal.floor']);              // someone else's, untouched
});

test('a signed-in waiter\'s floor plan edit reaches kv_docs; other documents are not sent',async()=>{
 const server=staffServer({sessionRole:'waiter'}),p=staffBoot({server,local:new Map([['aal.session',sessionFor('sara@kababji.com')]])});
 await p.a.sync.ready;await flush();
 assert.equal(p.a.sync.state().role,'waiter');
 floorEdit(p.a,5,'Sara');await flush();
 p.a.util.write('aal.draft',{version:3,sections:[],items:[],at:'2026-09-24T10:00:00.000Z'});await flush();
 const sent=server.docWrites();
 assert.equal(sent.length,1);assert.equal(sent[0].body[0].key,'aal.floor');assert.equal(sent[0].body[0].restaurant_id,RID);
 assert.equal(sent[0].headers.Authorization,'Bearer at-1');assert.equal(sent[0].headers.Prefer,'resolution=merge-duplicates,return=minimal');
 assert.equal(p.a.sync.job('doc:aal.draft'),null);assert.equal(p.a.sync.state().status,'live');
});

/* ---------- the guest page ---------- */
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);
const KEY='chk_'+'ab'.repeat(24),KEY2='chk_'+'cd'.repeat(24),LINK=SEARCH+'&k='+KEY,SLUG='kababji-hamra',TOKEN='tbl_'+'ef'.repeat(24);
const MENU={version:7,sections:[{id:'grl',name:'Grill',win:'all'}],items:[{id:'k1',sec:'grl',name:'Shish taouk',desc:'',price:9,status:'incomplete',available:true}],at:'2026-09-24T09:00:00.000Z'};
const CHECK={id:'bill-7',venueId:RID,table:7,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],totalCents:1800,amountUsd:18,revision:1};
const CHECK2={id:'bill-8',venueId:RID,table:7,source:'staff',openedAt:'2026-09-24T12:00:00.000Z',lines:[{id:'k1',q:1,p:9,name:'Shish taouk'}],totalCents:900,amountUsd:9,revision:1};
const VENUE={name:'Kababji',place:'Hamra',gplace:null,brand:'#EA312B',bg:null,font:null,menu_pack:'kababji'};
function guestDom(){
 const byId=new Map();
 function el(id){
  const cls=new Set(),kids=[];
  return {id:id||'',style:{setProperty(){}},dataset:{},innerHTML:'',textContent:'',value:'',disabled:false,checked:false,hidden:false,children:kids,childNodes:kids,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},prepend(...c){kids.unshift(...c);},insertBefore(c){kids.push(c);return c;},removeChild(c){return c;},remove(){},replaceChildren(){kids.length=0;},
   setAttribute(){},getAttribute(){return null;},removeAttribute(){},hasAttribute(){return false;},addEventListener(){},removeEventListener(){},
   querySelector:()=>el(),querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),getClientRects:()=>[],
   focus(){},blur(){},click(){},scrollTo(){},scrollIntoView(){},closest:()=>null,matches:()=>false,contains:()=>false,
   offsetWidth:0,offsetHeight:0,offsetLeft:0,offsetTop:0,scrollTop:0,scrollHeight:0,clientHeight:0,clientWidth:0,parentNode:null,parentElement:null,firstChild:null,lastChild:null,nextSibling:null};
 }
 const views=['v-land','v-menu','v-bill','v-settle','v-pay','v-done'];
 const document={visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  querySelector:()=>el(),querySelectorAll:s=>s==='.view'?views.map(id=>document.getElementById(id)):[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
/* the mocked shared store for guests: keys name checks; closing a bill removes its keys */
/* the mocked shared store for guests, with the SQL's rules: a closed bill keeps its keys
   for 24 hours (close), reads work and reserve is refused; then the keys go (expire) */
function guestServer(){
 const s={calls:[],down:false,keys:{[KEY]:CHECK.id},checks:{[CHECK.id]:CHECK,[CHECK2.id]:CHECK2},closed:{},settle:[],session:null};
 s.fetch=async(url,options)=>{
  if(s.down)throw new TypeError('Failed to fetch');
  const body=options&&options.body?JSON.parse(options.body):null;s.calls.push({url,body,headers:Object.assign({},options.headers)});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>JSON.stringify(obj)});
  if(url.endsWith('/rpc/aal_table_session'))return reply(200,s.session());
  const cid=s.keys[options.headers['x-aalayna-key']];
  if(url.endsWith('/rpc/aal_snapshot')){
   if(!cid)return reply(400,{code:'P0001',message:'Open a current bill link or sign in with this restaurant owner key.'});
   const c=s.closed[cid]?Object.assign({},s.checks[cid],{closedAt:s.closed[cid]}):s.checks[cid];
   return reply(200,{version:2,role:'guest',checkId:cid,rows:[{collection:'aal.checks',id:cid,body:c}].concat(s.settle.filter(x=>x.checkId===cid).map(x=>({collection:'aal.settle',id:x.id,body:x}))),docs:[{key:'aal.live',body:MENU}]});
  }
  if(url.endsWith('/rpc/aal_mutate')){
   if(!cid)return reply(400,{code:'P0001',message:'Access denied'});
   if(body.p_op==='receipt')return reply(200,{saved:true});
   if(body.p_op!=='reserve')return reply(200,body.p_body);
   if(s.closed[cid])return reply(400,{code:'P0001',message:'Bill closed or unavailable'});
   const row=Object.assign({},body.p_body,{venueId:RID,status:'pending'});s.settle.push(row);return reply(200,row);
  }
  return reply(201,'');
 };
 s.close=id=>{s.closed[id]='2026-09-24T11:00:00.000Z';};                             // staff close: keys still work
 s.expire=id=>{Object.keys(s.keys).forEach(k=>{if(s.keys[k]===id)delete s.keys[k];});};   // 24 hours later
 s.confirm=()=>{s.settle.forEach(x=>{x.status='confirmed';x.confirmedAt='2026-09-24T10:59:00.000Z';});};
 s.reads=()=>s.calls.filter(c=>c.url.endsWith('/rpc/aal_snapshot')).length;
 s.ops=op=>s.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_op===op);
 return s;
}
function guestBoot({search,server,online=true,session=new Map(),local=new Map(),config=true}){
 const intervals=[],replaced=[],listeners={},alerts=[],document=guestDom(),net={onLine:online};
 const window={document,location:{pathname:'/guest.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/guest.html'+search,replace(u){replaced.push(u);}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',clipboard:{writeText(){}},get onLine(){return net.onLine;}},
  addEventListener(type,f){(listeners[type]=listeners[type]||[]).push(f);},removeEventListener(){},
  requestAnimationFrame(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(i){if(intervals[i-1])intervals[i-1].cleared=true;},setTimeout(){return 0;},clearTimeout(){},
  scrollTo(){},alert(m){alerts.push(m);},prompt(){},confirm:()=>true,innerHeight:800,innerWidth:400,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
 window.window=window;window.self=window;window.fetch=(u,o)=>server.fetch(u,o);
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 if(config)window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(TQ,'guest.html#table-qr');
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 run(PAGE,'guest.html#page');
 const $=id=>document.getElementById(id);
 return {window,document,local,session,alerts,intervals,replaced,$,run:c=>run(c,'probe'),
  setOnline:async(on)=>{net.onLine=on;(listeners[on?'online':'offline']||[]).forEach(f=>f({type:on?'online':'offline'}));await flush();},
  tick:async()=>{intervals.filter(i=>i.ms===4000&&!i.cleared).forEach(i=>i.f());await flush();},
  on:id=>$(id).classList.contains('on'),items:()=>$('r-items').innerHTML};
}

test('a closed bill within 24 hours: the message, the key kept, and the receipt box on the payment receipt still sends',async()=>{
 const server=guestServer(),p=guestBoot({search:LINK,server});await flush();
 p.run('settle()');await flush();                                                   // the guest pays cash
 assert.equal(p.$('result-title').textContent,'Cash requested.');
 server.confirm();await p.tick();                                                   // staff confirm the cash
 assert.equal(p.$('result-title').textContent,'Shukran.');assert.equal(p.$('mailrc').style.display,'');
 server.close(CHECK.id);await p.tick();                                             // staff close the bill seconds later
 assert.equal(p.run('BILL_ENDED'),true);assert.equal(p.window.Aalayna.sync.closed(),true);
 assert.equal(p.local.get('aal.access:'+RID+':guest'),KEY);                        // the key is kept
 assert.equal(p.window.Aalayna.sync.enabled,true);assert.equal(p.window.Aalayna.demoMode(),false);
 assert.equal(p.on('v-done'),true);assert.equal(p.$('mailrc').style.display,'');    // still on the receipt, box usable
 assert.match(p.items(),/This bill is closed\. Scan the table code again for a new bill\./);
 assert.equal(p.run('CHECK'),null);assert.equal(p.run('TOTAL'),0);
 p.$('mail-in').value='guest@example.com';
 await p.run('sendReceipt()');await flush();
 const r=server.ops('receipt');
 assert.equal(r.length,1);assert.equal(r[0].headers['x-aalayna-key'],KEY);assert.equal(r[0].body.p_body.contact,'guest@example.com');
 assert.equal(p.$('payment-status').textContent,'Preferences saved to the restaurant. No receipt or message sent.');
 assert.deepEqual(p.alerts,[]);
 const reads=server.reads();await p.tick();assert.equal(server.reads(),reads+1);   // it keeps reading the closed bill
 p.run("go('v-bill')");p.run('settle()');assert.deepEqual(p.alerts,[CLOSED]);        // nothing more to pay
});

test('after 24 hours the server refuses the key: dropped, no more reads, never the demo, a reload stays on the message',async()=>{
 const server=guestServer(),p=guestBoot({search:LINK,server});await flush();
 const told=[];p.window.Aalayna.sync.onClosed(m=>told.push(m));
 p.run("go('v-pay')");
 server.close(CHECK.id);await p.tick();
 assert.equal(p.on('v-bill'),true);                                                 // a payment in progress goes back to the bill
 assert.equal(p.local.get('aal.access:'+RID+':guest'),KEY);
 server.expire(CHECK.id);await p.tick();
 assert.equal(p.local.has('aal.access:'+RID+':guest'),false);                     // dropped only now, when refused
 assert.equal(p.window.Aalayna.sync.enabled,false);assert.equal(p.window.Aalayna.sync.key(),'');
 assert.equal(p.window.Aalayna.demoMode(),false);assert.equal(p.window.Aalayna.sampleAllowed(),false);
 assert.match(p.items(),/This bill is closed\./);
 assert.equal(p.$('net-banner').hidden,true);                                       // a refused key is not "no connection"
 assert.equal(p.session.get('aal.bill-closed:'+RID),'1');
 const asked=server.calls.length;await p.tick();await p.tick();
 assert.equal(server.calls.length,asked);                                           // no more reads with a dead key
 assert.deepEqual(told,[CLOSED]);                                                    // announced once: at the close, not again at the refusal
 // reload of the first tab: still the message, still not the demo
 const again=guestBoot({search:SEARCH,server,local:p.local,session:p.session});await flush();
 assert.equal(again.window.Aalayna.demoMode(),false);assert.equal(again.run('CHECK'),null);
 again.run('buildBill()');assert.match(again.items(),/This bill is closed\./);
 // a new bill link in the same tab clears it
 server.keys[KEY2]=CHECK2.id;
 const fresh=guestBoot({search:SEARCH+'&k='+KEY2,server,local:p.local,session:p.session});await flush();
 assert.equal(fresh.run('CHECK.id'),CHECK2.id);assert.equal(fresh.session.has('aal.bill-closed:'+RID),false);assert.equal(fresh.run('BILL_ENDED'),false);
});

test('a cash request saved offline for a bill that closed meanwhile is refused and not reported as requested',async()=>{
 const server=guestServer(),p=guestBoot({search:LINK,server});await flush();
 server.down=true;await p.setOnline(false);
 const requestId=p.run('paymentRequestId');
 p.run('settle()');await flush();
 assert.equal(p.$('result-title').textContent,'Saved on this phone.');
 server.close(CHECK.id);server.down=false;await p.setOnline(true);await p.tick();
 assert.equal(server.ops('reserve').length,1);                                      // sent, refused by the server
 assert.equal(p.window.Aalayna.sync.job('op:reserve:'+requestId),'refused');
 assert.equal(p.on('v-bill'),true);assert.notEqual(p.$('result-title').textContent,'Cash requested.');
 assert.equal(p.session.get(p.run('pendingKey()')),undefined);
 assert.equal(p.run('paymentBusy'),false);assert.equal(p.window.Aalayna.sync.state().failed,0);   // shown by the page, once
 assert.match(p.items(),/This bill is closed\./);
});

test('from a table code: after the close the poll asks aal_table_session again and the next bill replaces the kept key',async()=>{
 const server=guestServer();let open={checkId:CHECK.id,key:KEY};
 server.session=()=>({restaurant_id:RID,venue:VENUE,table:7,checkId:open?open.checkId:null,key:open?open.key:null,docs:[{key:'aal.live',body:MENU,updated_at:'now'}]});
 const first=guestBoot({search:'?v='+SLUG+'&t=7&s='+TOKEN,server});await flush();
 const u=first.replaced[0],p=guestBoot({search:u.slice(u.indexOf('?')),server,session:first.session,local:first.local});await flush();
 assert.equal(p.run('CHECK.id'),CHECK.id);assert.equal(p.run('AalaynaTableQR.waiting'),false);
 const sessions=()=>server.calls.filter(c=>c.url.endsWith('/rpc/aal_table_session')).length,asked=sessions();
 // the waiter closes the bill; the table has no new bill yet (aal_table_session only offers open bills)
 open=null;server.close(CHECK.id);await p.tick();
 assert.match(p.items(),/This bill is closed\./);
 assert.equal(p.window.Aalayna.sync.key(),KEY);                                     // kept for the receipt
 assert.equal(p.run('AalaynaTableQR.waiting'),true);
 const timer=p.intervals.find(i=>i.ms===10000&&!i.cleared);assert.ok(timer,'the 10 second table poll runs again');
 p.run("go('v-bill')");
 await timer.f();await flush();
 assert.equal(sessions(),asked+1);assert.equal(p.run('AalaynaTableQR.waiting'),true);   // a fresh session, no bill yet
 // the next party's bill is entered: the poll attaches its key in place of the closed bill's
 open={checkId:CHECK2.id,key:KEY2};server.keys[KEY2]=CHECK2.id;
 await timer.f();await flush();
 assert.equal(sessions(),asked+2);
 assert.equal(p.window.Aalayna.sync.enabled,true);assert.equal(p.window.Aalayna.sync.key(),KEY2);assert.equal(p.window.Aalayna.sync.closed(),false);
 assert.equal(p.local.get('aal.access:'+RID+':guest'),KEY2);
 assert.equal(p.run('BILL_ENDED'),false);assert.equal(p.run('CHECK.id'),CHECK2.id);assert.equal(p.run('TOTAL'),9);
 assert.doesNotMatch(p.items(),/This bill is closed/);
 assert.equal(p.intervals.filter(i=>i.ms===4000).length,1);                          // one sync timer, not one per bill
 const reads=server.reads();await p.tick();assert.equal(server.reads(),reads+1);
 assert.equal(server.calls.slice(-1)[0].headers['x-aalayna-key'],KEY2);
 // a bill key that is not closed is never replaced
 assert.throws(()=>p.window.Aalayna.sync.attach('chk_'+'99'.repeat(24)),/already has a bill key/);
});

test('the bill view shows the real party size or nothing in live mode; the demo keeps its line',async()=>{
 assert.match(html,/<div class="b-sub" id="bill-sub">4 guests &middot; opened 8:42 pm<\/div>/);
 const server=guestServer();server.checks[CHECK.id]=Object.assign({},CHECK,{partySize:3});
 const p=guestBoot({search:LINK,server});await flush();
 assert.equal(p.$('bill-sub').textContent,'3 guests');assert.equal(p.$('bill-sub').hidden,false);
 server.checks[CHECK.id]=Object.assign({},CHECK,{partySize:1});await p.tick();p.run('paintTableLabels()');
 assert.equal(p.$('bill-sub').textContent,'1 guest');
 const q=guestBoot({search:LINK,server:guestServer()});await flush();
 assert.equal(q.$('bill-sub').textContent,'');assert.equal(q.$('bill-sub').hidden,true);   // unknown: nothing
 // the demo: no key, the illustrative line is left as written
 const d=guestBoot({search:'',server:guestServer()});await flush();
 assert.equal(d.window.Aalayna.demoMode(),true);
 d.$('bill-sub').textContent='4 guests · opened 8:42 pm';d.run('paintTableLabels()');
 assert.equal(d.$('bill-sub').textContent,'4 guests · opened 8:42 pm');assert.equal(d.$('bill-sub').hidden,false);
 assert.equal(d.run('BILL_ENDED'),false);assert.ok(d.run('BILL.length')>0);
});

/* ---------- the SQL: static checks here, behaviour with PGlite below ---------- */
const SQL=fs.readFileSync(path.join(root,'supabase','followups-2026-09-24.sql'),'utf8');
test('followups SQL: one transaction, pinned search paths, re-runnable statements, aal_mutate untouched',()=>{
 const body=SQL.replace(/--[^\n]*/g,'');
 assert.match(body,/^\s*begin;/);assert.match(body,/commit;\s*$/);
 assert.match(SQL,/UNTESTED/);assert.match(SQL,/Run after auth-2026-09-24\.sql/);
 assert.match(body,/raise exception 'Run auth-2026-09-24\.sql before followups-2026-09-24\.sql'/);
 const fns=[...body.matchAll(/create or replace function ([\w.]+)\(([^)]*)\)[\s\S]*?\$\$;/g)];
 assert.deepEqual(fns.map(f=>f[1]).sort(),['public.aal_check_scope','public.aal_table_session']);
 for(const f of fns)assert.match(f[0],/set search_path = public, extensions, pg_temp as \$\$/,f[1]);
 assert.equal(/create (or replace )?function public\.aal_mutate/.test(body),false);
 assert.equal(/\bcreate (table|index)\b(?! if not exists)/.test(body),false);
 // no trigger: keys are not deleted at the moment of close; an earlier draft's trigger is removed
 assert.equal(/create trigger/.test(body),false);
 assert.match(body,/drop trigger if exists kv_rows_close_keys on public\.kv_rows;/);assert.match(body,/drop function if exists public\.aal_forget_check_keys\(\);/);
 for(const m of body.matchAll(/create policy (\w+)/g))assert.match(body,new RegExp('drop policy if exists '+m[1]+' on public\\.kv_docs;'));
 // the scope: open, or closed less than 24 hours ago
 const scope=fns.find(f=>f[1]==='public.aal_check_scope')[0];
 assert.match(scope,/r\.body->>'closedAt' is null or \(r\.body->>'closedAt'\)::timestamptz > now\(\) - interval '24 hours'/);
 // the clean-up runs inside aal_table_session, after the code check and under the venue lock, with the same rule
 const session=fns.find(f=>f[1]==='public.aal_table_session')[0];
 const lock=session.indexOf('pg_advisory_xact_lock'),del=session.indexOf('delete from public.check_keys'),check=session.indexOf('This table code is not active');
 assert.ok(check>0&&lock>check&&del>lock,'code check, then lock, then clean-up');
 assert.match(session.slice(del),/c\.restaurant_id = vp\.restaurant_id and not exists[\s\S]*interval '24 hours'/);
 // the one-off clean-up uses the same 24-hour rule
 assert.match(body.slice(0,body.indexOf('create or replace function public.aal_table_session')),/delete from public\.check_keys c[\s\S]*interval '24 hours'/);
 assert.match(body,/public\.aal_role\(restaurant_id\) = 'waiter' and key = 'aal\.floor'/);
});
test('followups SQL: aal_table_session is the sessions file\'s text, changed only on the lines marked T8',()=>{
 const fn=src=>{const s=src.slice(src.indexOf('create or replace function public.aal_table_session'));return s.slice(0,s.indexOf('end $$;')+7);};
 const norm=(src,dropT8)=>fn(src).split('\n').filter(l=>!(dropT8&&/-- T8/.test(l))).map(l=>l.replace(/--.*$/,'').trim()).filter(Boolean).join('\n');
 const before=norm(fs.readFileSync(path.join(root,'supabase','sessions-2026-09-24.sql'),'utf8'),false),after=norm(SQL,true);
 assert.equal(after,before);
});

const modulePath=process.env.PGLITE_MODULE;
test('followups SQL: keys work 24 hours past the close for reads, receipt and cancel, then die; scans reuse a live key; waiters write only the floor',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>fs.readFileSync(path.join(root,'supabase',f),'utf8').replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);`);
  await assert.rejects(db.exec(sql('followups-2026-09-24.sql')),/Run auth-2026-09-24\.sql/);
  await db.exec('rollback');
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql','followups-2026-09-24.sql','followups-2026-09-24.sql'])await db.exec(sql(f));
  const WAITER='22222222-2222-4222-8222-222222222222';
  await db.query(`insert into auth.users values($1,'sara@kababji.com',now(),null)`,[WAITER]);
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers,claims)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify(claims||{role})]);await db.exec('set role '+role);};
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  await as('anon',{'x-aalayna-admin':'adm_test'});
  const v=await one("select aal_admin_register_venue('Kababji','Hamra','kababji-hamra','{}'::jsonb) as value");
  const rid=v.restaurant_id;
  const mutate=(op,body,token='')=>one('select aal_mutate($1,$2,$3::jsonb,$4) as value',[rid,op,JSON.stringify(body),token]);
  const session=(table,code)=>one('select aal_table_session($1,$2,$3) as value',['kababji-hamra',table,code]);
  const keysFor=async id=>{await db.exec('reset role');return (await db.query('select count(*)::int as n from check_keys where check_id=$1',[id])).rows[0].n;};
  await as('anon',{'x-aalayna-key':v.owner_key});
  const code=(await one('select aal_table_tokens($1,$2::jsonb) as value',[rid,JSON.stringify({op:'issue',table:7})])).tokens[0].token;
  await mutate('open_check',{id:'bill-7',table:7,lines:[{id:'k1',q:1,p:10,name:'Shish taouk'}],currency:'USD'});
  await as('anon',{});
  const k1=(await session(7,code)).key,k1b=(await session(7,code)).key;
  assert.match(k1,/^chk_[0-9a-f]{48}$/);assert.equal(k1b,k1);                       // reused, not minted per scan
  await as('anon',{'x-aalayna-key':v.owner_key});
  const k2=(await mutate('issue_key',{checkId:'bill-7'})).key;
  await as('anon',{});assert.equal((await session(7,code)).key,k2);                 // the newest live key
  await as('anon',{'x-aalayna-key':k1});
  await mutate('reserve',{id:'p1',checkId:'bill-7',amount:10,tip:0,rail:'cash'},'t'.repeat(40));
  await as('anon',{'x-aalayna-key':v.owner_key});
  await mutate('confirm_cash',{id:'p1'});
  await mutate('close_check',{checkId:'bill-7'});
  assert.equal(await keysFor('bill-7'),2);                                           // not deleted at the close
  // the grace period: read the closed bill, ask for the receipt; paying again is refused
  await as('anon',{'x-aalayna-key':k1});
  const snap=await one('select aal_snapshot($1) as value',[rid]);
  assert.equal(snap.checkId,'bill-7');assert.ok(snap.rows.find(r=>r.id==='bill-7').body.closedAt);
  assert.deepEqual(await mutate('receipt',{id:'p1',contact:'g@x.com',channel:'email',receipt:true,marketing:false,requestId:'r1'},'t'.repeat(40)),{saved:true});
  await assert.rejects(mutate('reserve',{id:'p2',checkId:'bill-7',amount:1,tip:0,rail:'cash'},'u'.repeat(40)),/Bill closed or unavailable/);
  await as('anon',{});assert.equal((await session(7,code)).key,null);               // a scan never offers a closed bill
  assert.equal(await keysFor('bill-7'),2);                                           // and does not clear keys inside the window
  // 25 hours later
  await db.exec('reset role');
  await db.query(`update kv_rows set body=body||jsonb_build_object('closedAt',to_char((now()-interval '25 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) where collection='aal.checks' and id='bill-7'`);
  await as('anon',{'x-aalayna-key':k1});
  assert.equal(await one('select aal_check_scope($1) as value',[rid]),null);
  await assert.rejects(one('select aal_snapshot($1) as value',[rid]),/Open a current bill link/);
  await assert.rejects(mutate('receipt',{id:'p1',contact:'g@x.com',channel:'email',receipt:true,marketing:false,requestId:'r2'},'t'.repeat(40)),/Access denied/);
  assert.equal(await keysFor('bill-7'),2);
  await as('anon',{});await assert.rejects(session(7,'tbl_'+'00'.repeat(24)),/not active/);
  assert.equal(await keysFor('bill-7'),2);                                           // a wrong code cleans nothing
  await as('anon',{});await session(7,code);
  assert.equal(await keysFor('bill-7'),0);                                           // the next real scan clears them
  // the floor: a signed-in waiter writes it and nothing else
  await as('anon',{'x-aalayna-key':v.owner_key});
  await one("select aal_staff($1,$2::jsonb) as value",[rid,JSON.stringify({op:'invite',email:'sara@kababji.com',role:'waiter'})]);
  await as('authenticated',{},{role:'authenticated',sub:WAITER,email:'sara@kababji.com'});
  await db.query("insert into kv_docs(restaurant_id,key,body) values($1,'aal.floor',$2::jsonb) on conflict (restaurant_id,key) do update set body=excluded.body",[rid,JSON.stringify({servers:['Sara'],tables:{'7':'Sara'},pooled:false})]);
  await db.query("insert into kv_docs(restaurant_id,key,body) values($1,'aal.floor',$2::jsonb) on conflict (restaurant_id,key) do update set body=excluded.body",[rid,JSON.stringify({servers:['Sara','Jad'],tables:{},pooled:false})]);
  await assert.rejects(db.query("insert into kv_docs(restaurant_id,key,body) values($1,'aal.draft','{}'::jsonb)",[rid]),/row-level security/);
  await assert.rejects(db.query("insert into kv_docs(restaurant_id,key,body) values($1,'aal.floor','[1]'::jsonb) on conflict (restaurant_id,key) do update set body=excluded.body",[rid]),/row-level security/);
  await db.exec('reset role');
  assert.deepEqual((await db.query("select body from kv_docs where key='aal.floor'")).rows[0].body.servers,['Sara','Jad']);
 }finally{await db.close();}
});
