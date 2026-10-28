/* T1 resilience (docs/resilience.md). Every conflict rule in section 5 of the design has a
   test here, named by its number, plus the outbox order and idempotency and the service
   worker's cache lists and routing.
   - The rules the device applies (order, one job per change, offline admission, the refusal
     text) are tested on the sync core directly and through the real store and sync layer,
     run against a mocked Supabase whose aal_mutate keeps the server's rules for reserve,
     confirm_cash, cancel and close_check (supabase/auth-2026-09-24.sql): idempotent by
     payment id, first received wins, every transition checked.
   - The rules the server decides are also run against a real PostgreSQL when PGLITE_MODULE
     is set (supabase/README.md, "Tests"); without it that block is skipped.
   The guest page's own screens (the receipt that says "saved on this phone", the refused
   request sent back to Pay) are in tests/offline.test.cjs; the closed-bill and carried-outbox
   rules (C12, C13) in tests/followups.test.cjs. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=16)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const RID=JSON.stringify(['mayda','hamra']),SEARCH='?venue=Mayda&place=Hamra',LIVE=SEARCH+'&live=1';
const GUEST_KEY='chk_'+'ab'.repeat(24),GUEST_KEY_2='chk_'+'cd'.repeat(24),OWNER_KEY='own_'+'ef'.repeat(24);
const USER='0b7c6f7e-1d2a-4c3b-9e8f-112233445566';
const plain=x=>JSON.parse(JSON.stringify(x));
function store(m){return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}};}

/* ---------- the sync core, alone ---------- */
function core(){const window={};vm.runInNewContext(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),{window});return window.AalaynaSyncCore;}

test('outbox order: seq order, never the device clock; jobs kept before seq existed go first, as stored (C9)',()=>{
 const c=core();
 const q={'op:b':{seq:2,at:'2026-10-28T20:00:00Z'},'op:a':{seq:1,at:'2026-10-28T23:59:00Z'},'legacy-1':{},'op:c':{seq:3,at:'2020-01-01T00:00:00Z'},'legacy-2':{at:'2030-01-01T00:00:00Z'}};
 assert.deepEqual(plain(c.orderJobs(q)),['legacy-1','legacy-2','op:a','op:b','op:c']);
 assert.deepEqual(plain(c.orderJobs({})),[]);
});

test('the same change queued twice is one job: same op, body and payer token (C1, C11)',()=>{
 const c=core(),a={kind:'op',op:'confirm_cash',body:{id:'p1'},token:''};
 assert.equal(c.sameJob(a,{kind:'op',op:'confirm_cash',body:{id:'p1'},token:''}),true);
 assert.equal(c.sameJob(a,Object.assign({},a,{waiter:'w2',seq:9,at:'x'})),true);   // its waiter and place do not make it another change
 assert.equal(c.sameJob(a,{kind:'op',op:'cancel',body:{id:'p1'},token:''}),false);
 assert.equal(c.sameJob(a,{kind:'op',op:'confirm_cash',body:{id:'p2'},token:''}),false);
 assert.equal(c.sameJob({kind:'op',op:'reserve',body:{id:'r',amount:5},token:'t1'},{kind:'op',op:'reserve',body:{id:'r',amount:5},token:'t2'}),false);
 assert.equal(c.sameJob(undefined,a),false);
});

test('offline admission: what a page that has not reached the server may queue (C8, C10)',()=>{
 const c=core(),now=Date.parse('2026-10-28T21:00:00Z'),hours=h=>new Date(now-h*3600000).toISOString();
 const pending={id:'p1',rail:'cash',status:'pending'};
 // a guest's cash request or cancel, on a bill this phone read in the last six hours
 assert.equal(c.admitOffline({role:'guest',op:'reserve',held:true,lastReadAt:hours(5.9),now}),null);
 assert.equal(c.admitOffline({role:'guest',op:'cancel',held:true,lastReadAt:hours(1),now}),null);
 assert.equal(c.admitOffline({role:'guest',op:'reserve',held:true,lastReadAt:hours(6.1),now}),'Connect to the restaurant before continuing.');   // C8
 assert.equal(c.admitOffline({role:'guest',op:'reserve',held:false,lastReadAt:hours(1),now}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'guest',op:'reserve',held:true,lastReadAt:null,now}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'guest',op:'receipt',held:true,lastReadAt:hours(1),now}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'guest',op:'confirm_cash',held:true,lastReadAt:hours(1),now}),'Connect to the restaurant before continuing.');
 // a staff cash confirmation of a request this device holds as pending; any staff role
 for(const role of ['owner','waiter','staff'])assert.equal(c.admitOffline({role,op:'confirm_cash',settlement:pending}),null,role);
 assert.equal(c.admitOffline({role:'owner',op:'confirm_cash',settlement:Object.assign({},pending,{status:'confirmed'})}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'owner',op:'confirm_cash',settlement:Object.assign({},pending,{cancelled:'x'})}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'owner',op:'confirm_cash',settlement:Object.assign({},pending,{rail:'card'})}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'owner',op:'confirm_cash',settlement:null}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:'owner',op:'open_check'}),'Connect to the restaurant before continuing.');
 assert.equal(c.admitOffline({role:null,op:'reserve',held:true,lastReadAt:hours(1),now}),'Connect to the restaurant before continuing.');
 // C10: never queued, whoever asks
 assert.deepEqual(plain(c.ONLINE_ONLY),['close_check','refund','issue_key']);
 assert.match(c.admitOffline({role:'owner',op:'close_check'}),/^Closing a bill needs the connection/);
 assert.match(c.admitOffline({role:'owner',op:'refund'}),/^A refund needs the connection/);
 assert.match(c.admitOffline({role:'waiter',op:'issue_key'}),/^A bill link needs the connection/);
 assert.equal(c.OFFLINE_MAX_AGE_MS,6*3600*1000);
});

test('a refused cash confirmation says the cash is not recorded and what to do with it (C3)',()=>{
 const c=core(),job={op:'confirm_cash',body:{id:'p1'},at:'2026-10-28T19:04:00Z'};
 const text=c.explainRefusal(job,'Cash request changed',{table:7,amount:18},()=>'21:04');
 assert.equal(text,'Table 7, $18.00: this cash request was cancelled or changed on another device before your confirmation reached the restaurant (you confirmed it on this device at 21:04). It is not recorded as paid. If you took the cash, give it back or tell the manager.');
 assert.match(c.explainRefusal(job,'Cash request changed',null,null),/^this cash request: this cash request was cancelled/);
 assert.equal(c.explainRefusal({op:'reserve'},'Item already reserved'),'Item already reserved');   // other refusals keep the server's words
});

/* ---------- the store and sync layer against a mocked venue ---------- */
const CHECK={id:'bill-7',venueId:RID,table:7,source:'staff',openedAt:'2026-10-28T18:00:00.000Z',lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],totalCents:1800,amountUsd:18,revision:1};
/* aal_mutate's rules for the operations T1 queues, as supabase/auth-2026-09-24.sql has them */
function venueServer(){
 const s={down:false,calls:[],check:plain(CHECK),settle:new Map(),tokens:new Map(),events:[]};
 const fail=m=>[400,{message:m,code:'P0001'}];
 const paidLike=x=>x.status==='pending'||x.status==='confirmed';
 s.ops={
  reserve(b,token){
   const prev=s.settle.get(b.id);
   if(prev){
    if(s.tokens.get(b.id)!==token)return fail('Wrong payer token');
    if(prev.amount!==b.amount||prev.tip!==b.tip||prev.rail!==b.rail||JSON.stringify(prev.items)!==JSON.stringify(b.items||{}))return fail('Payment request changed');
    return [200,prev];
   }
   if(s.check.closedAt)return fail('Bill closed or unavailable');
   const others=[...s.settle.values()].filter(paidLike);
   if(others.reduce((n,x)=>n+Math.round((x.amount-x.tip)*100),0)+Math.round((b.amount-b.tip)*100)>s.check.totalCents)return fail('Another payment already covers this balance. Refresh your bill.');
   for(const [id,q] of Object.entries(b.items||{})){
    const line=s.check.lines.find(l=>l.id===id);if(!line)return fail('Invalid item selection');
    if(q+others.reduce((n,x)=>n+((x.items||{})[id]||0),0)>line.q)return fail('Item already reserved');
   }
   const row={id:b.id,requestId:b.requestId,venueId:RID,checkId:s.check.id,table:s.check.table,rail:b.rail,amount:b.amount,tip:b.tip,items:b.items||{},status:'pending',ts:new Date().toISOString()};
   s.settle.set(b.id,row);s.tokens.set(b.id,token);return [200,row];
  },
  confirm_cash(b){
   const p=s.settle.get(b.id);if(!p)return fail('Payment unavailable');
   if(p.status==='confirmed')return [200,p];
   if(p.status!=='pending')return fail('Cash request changed');
   p.status='confirmed';p.confirmedAt=new Date().toISOString();s.events.push({eventType:'payment_completed',paymentId:p.id});return [200,p];
  },
  cancel(b){
   const p=s.settle.get(b.id);if(!p)return fail('Payment unavailable');
   if(p.status==='cancelled')return [200,p];
   if(p.status!=='pending')return fail('Payment already completed');
   p.status='cancelled';p.cancelled=new Date().toISOString();return [200,p];
  },
  close_check(){
   const paid=[...s.settle.values()].filter(x=>x.status==='confirmed').reduce((n,x)=>n+Math.round((x.amount-x.tip)*100),0);
   if(paid!==s.check.totalCents)return fail('Bill is not fully settled');
   s.check.closedAt=new Date().toISOString();return [200,s.check];
  }
 };
 s.fetch=async(url,options)=>{
  if(s.down)throw new TypeError('Failed to fetch');
  const body=options&&options.body?JSON.parse(options.body):null,h=options.headers||{};s.calls.push({url,body});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
  const u=url.replace('https://mock.invalid','');
  const role=/^chk_/.test(h['x-aalayna-key']||'')?'guest':h['x-aalayna-key']===OWNER_KEY||h.Authorization==='Bearer at-1'?'owner':null;
  if(u==='/rest/v1/rpc/aal_snapshot'){
   if(!role)return reply(400,{message:'Open a current bill link.'});
   return reply(200,{version:2,role,checkId:role==='guest'?s.check.id:null,
    rows:[{collection:'aal.checks',id:s.check.id,body:s.check}].concat([...s.settle.values()].map(x=>({collection:'aal.settle',id:x.id,body:x}))),docs:[]});
  }
  if(u==='/rest/v1/rpc/aal_mutate'){
   const op=s.ops[body.p_op];if(!op)return reply(200,body.p_body);
   const [status,obj]=op(body.p_body,body.p_token);return reply(status,obj);
  }
  if(u==='/rest/v1/rpc/aal_staff')return reply(200,[{restaurant_id:RID,role:'waiter',name:'Mayda',place:'Hamra'}]);
  return reply(201,null);
 };
 s.sent=op=>s.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')&&c.body.p_op===op).map(c=>c.body.p_body);
 return s;
}
function dom(){
 const byId=new Map();
 function el(id){const kids=[];return {id:id||'',style:{},dataset:{},textContent:'',innerHTML:'',value:'',hidden:false,disabled:false,children:kids,childNodes:kids,
  setAttribute(){},getAttribute(){return null;},appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},replaceChildren(){kids.length=0;},focus(){},addEventListener(){},removeEventListener(){},
  classList:{add(){},remove(){},toggle(){},contains:()=>false}};}
 return {visibilityState:'visible',cookie:'',readyState:'complete',getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  createElement:()=>el(),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},body:el('body'),head:el('head'),documentElement:el('html')};
}
/* page: 'guest' or 'dashboard'. The sync layer, as those pages load it. */
function boot({page='guest',search,server,local=new Map(),session=new Map(),online=true}){
 const intervals=[],listeners={},net={onLine:online};
 const window={document:dom(),location:{pathname:'/'+page+'.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/'+page+'.html'+search,reload(){}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',get onLine(){return net.onLine;}},
  addEventListener(type,f){(listeners[type]=listeners[type]||[]).push(f);},removeEventListener(){},
  matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),
  setInterval(f,ms){intervals.push({f,ms});return intervals.length;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},confirm:()=>true,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map,fetch:(u,o)=>server.fetch(u,o)};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 const a=window.Aalayna;
 return {window,a,local,session,
  outbox:()=>JSON.parse(local.get(a.util.storageKey('aal.outbox'))||'{}'),
  setOnline:async on=>{net.onLine=on;(listeners[on?'online':'offline']||[]).forEach(f=>f({type:on?'online':'offline'}));await flush();},
  tick:async()=>{intervals.filter(i=>i.ms===4000).forEach(i=>i.f());await flush();}};
}
const settled=p=>Promise.resolve().then(()=>p).then(v=>({ok:true,value:v}),e=>({ok:false,error:e}));
/* a guest phone that read its bill once with a connection, then a new page on it with none */
async function guestOffline(server,key=GUEST_KEY,local=new Map()){
 server.down=false;
 const first=boot({search:SEARCH+'&k='+key,server,local});await first.a.sync.ready;await flush();
 server.down=true;
 const p=boot({search:LIVE,server,local,online:false});await flush();
 return p;
}
const cash=(id,extra)=>Object.assign({checkId:'bill-7',requestId:id,rail:'cash',amount:18,tip:0,items:{},table:7},extra||{});

test('a guest cash request made offline is queued with its payment id as the key and sent exactly once (C1)',async()=>{
 const server=venueServer(),p=await guestOffline(server);
 assert.equal(p.a.sync.state().status,'offline');
 const r=await settled(p.a.settle(cash('req-1')));
 assert.equal(r.ok,false);assert.equal(r.error.queued,true);                         // saved on this phone
 const job=p.outbox()['op:reserve:req-1'];
 assert.ok(job,'queued under op:reserve:<payment id>');assert.equal(typeof job.seq,'number');assert.ok(Date.parse(job.at));
 assert.equal(job.body.id,'req-1');assert.ok(job.token.length>=32,'with the payer token');
 // tapped again, or the page asked again: one job, and the caller is told it is already waiting
 const again=await settled(p.a.settle(cash('req-1')));
 assert.equal(again.ok,false);assert.equal(again.error.queued,true);assert.equal(again.error.duplicate,true);
 assert.equal(Object.keys(p.outbox()).filter(k=>k.indexOf('op:reserve:')===0).length,1);
 assert.equal(p.outbox()['op:reserve:req-1'].seq,job.seq);                          // it kept its place
 // back online: sent once, applied once
 server.down=false;await p.setOnline(true);await flush();
 assert.equal(server.sent('reserve').length,1);
 assert.equal(p.a.sync.job('op:reserve:req-1'),null);
 assert.equal(server.settle.get('req-1').status,'pending');
 // the answer was lost and the same request arrives again (a reload replays it): the server returns the stored one
 const token=job.token,before=server.settle.size;
 assert.deepEqual(server.ops.reserve(Object.assign({},job.body),token),[200,server.settle.get('req-1')]);
 assert.equal(server.settle.size,before);
});

test('a bill this phone read more than six hours ago takes no offline cash request (C8)',async()=>{
 const server=venueServer(),local=new Map();
 const first=boot({search:SEARCH+'&k='+GUEST_KEY,server,local});await first.a.sync.ready;await flush();
 const readKey=first.a.util.storageKey('aal.sync.read'),read=JSON.parse(local.get(readKey));
 read.at=new Date(Date.now()-7*3600000).toISOString();local.set(readKey,JSON.stringify(read));
 server.down=true;
 const p=boot({search:LIVE,server,local,online:false});await flush();
 assert.ok(p.a.sync.boundCheck(),'the bill is still shown');
 const r=await settled(p.a.settle(cash('req-old')));
 assert.equal(r.ok,false);assert.equal(r.error.queued,undefined);assert.equal(r.error.message,'Connect to the restaurant before continuing.');
 assert.deepEqual(Object.keys(p.outbox()),[]);
});

test('a request then its cancel, both offline, reach the server in that order, across a reload (C5)',async()=>{
 const server=venueServer(),p=await guestOffline(server);
 await settled(p.a.settle(cash('req-2')));
 await settled(p.a.cancelCash('req-2'));
 const ob=p.outbox();assert.ok(ob['op:reserve:req-2'].seq<ob['op:cancel:req-2'].seq);
 // reloaded, still offline: the order is kept on the phone
 const again=boot({search:LIVE,server,local:p.local,online:false});await flush();
 server.down=false;await again.setOnline(true);await flush();
 const ops=server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')).map(c=>c.body.p_op+':'+c.body.p_body.id);
 assert.deepEqual(ops.filter(o=>/req-2$/.test(o)),['reserve:req-2','cancel:req-2']);
 assert.equal(server.settle.get('req-2').status,'cancelled');
 assert.deepEqual(Object.keys(again.outbox()),[]);
});

test('a network failure stops the run: nothing queued behind it overtakes it',async()=>{
 const server=venueServer(),p=await guestOffline(server);
 await settled(p.a.settle(cash('req-3',{amount:9,items:{k1:1}})));
 await settled(p.a.cancelCash('req-3'));
 server.down=false;
 let n=0;const real=server.fetch;
 server.fetch=async(url,o)=>{if(url.endsWith('/rpc/aal_mutate')&&n++===0)throw new TypeError('Failed to fetch');return real(url,o);};
 await p.setOnline(true);await flush();
 assert.equal(server.sent('cancel').length,0,'the cancel waited for the request');
 assert.deepEqual(Object.keys(p.outbox()).sort(),['op:cancel:req-3','op:reserve:req-3']);
 await p.tick();
 assert.deepEqual(server.calls.filter(c=>c.url.endsWith('/rpc/aal_mutate')).map(c=>c.body.p_op),['reserve','cancel']);
});

test('a split changed on two phones: the first request the server receives wins, the second is refused, never left as saved (C6)',async()=>{
 const server=venueServer();
 const a=await guestOffline(server,GUEST_KEY),b=await guestOffline(server,GUEST_KEY_2);
 await settled(a.a.settle(cash('split-a',{amount:18,items:{k1:2}})));
 await settled(b.a.settle(cash('split-b',{amount:9,items:{k1:1}})));
 server.down=false;
 await a.setOnline(true);await flush();
 await b.setOnline(true);await flush();
 assert.equal(server.settle.get('split-a').status,'pending');
 assert.equal(server.settle.has('split-b'),false);
 assert.equal(b.a.sync.job('op:reserve:split-b'),'refused');
 const refusal=b.a.sync.refusals().find(r=>r.id==='op:reserve:split-b');
 assert.match(refusal.message,/Another payment already covers this balance|Item already reserved/);
 assert.deepEqual(Object.keys(b.outbox()),[]);
});

test('the bill changed while a request waited: checked against the bill as it is when it arrives (C7)',async()=>{
 const server=venueServer(),p=await guestOffline(server);
 await settled(p.a.settle(cash('req-4',{amount:9,items:{k1:1}})));
 server.check.lines=[{id:'k9',q:1,p:18,name:'Mixed grill'}];server.check.revision=2;   // staff replaced the line
 server.down=false;await p.setOnline(true);await flush();
 assert.equal(p.a.sync.job('op:reserve:req-4'),'refused');
 assert.equal(p.a.sync.refusals().find(r=>r.id==='op:reserve:req-4').message,'Invalid item selection');
 assert.equal(server.settle.has('req-4'),false);
});

test('a digital payment, a bill close or a refund offline is refused on the device, never queued (C10)',async()=>{
 const server=venueServer(),p=await guestOffline(server);
 const card=await settled(p.a.requestPayment(cash('card-1',{rail:'card'})));
 assert.equal(card.ok,false);assert.match(card.error.message,/^Digital payments are not connected yet/);
 assert.deepEqual(Object.keys(p.outbox()),[]);
 // a dashboard that was connected, then lost it
 const staff=boot({page:'dashboard',search:SEARCH+'&k='+OWNER_KEY,server:Object.assign(server,{down:false})});await staff.a.sync.ready;await flush();
 server.down=true;await staff.tick();
 assert.equal(staff.a.sync.state().status,'offline');
 for(const [call,re] of [[()=>staff.a.closeServiceCheck('bill-7'),/^Closing a bill needs the connection/],[()=>staff.a.refund('x'),/^A refund needs the connection/],[()=>staff.a.sync.issueCheckKey('bill-7'),/^A bill link needs the connection/]]){
  const r=await settled(call());assert.equal(r.ok,false);assert.match(r.error.message,re);assert.equal(r.error.queued,undefined);
 }
 assert.deepEqual(Object.keys(staff.outbox()),[]);
 server.down=false;await staff.tick();
 assert.equal(server.sent('close_check').length+server.sent('refund').length+server.sent('issue_key').length,0);
});

/* staff devices: a dashboard that read the venue once, opened again with no connection */
async function staffOffline(server,local=new Map()){
 server.down=false;
 const first=boot({page:'dashboard',search:SEARCH+'&k='+OWNER_KEY,server,local});await first.a.sync.ready;await flush();
 server.down=true;
 const p=boot({page:'dashboard',search:SEARCH,server,local,online:false});await flush();
 return p;
}
function pendingCash(server,id='cash-1'){
 server.settle.set(id,{id,requestId:id,venueId:RID,checkId:'bill-7',table:7,rail:'cash',amount:18,tip:0,items:{},status:'pending',ts:'2026-10-28T18:30:00.000Z'});
 server.tokens.set(id,'g'.repeat(40));
}

test('a waiter confirms cash offline: one job per payment, a second confirmation stays one job, sent once (C11)',async()=>{
 const server=venueServer();pendingCash(server);
 const p=await staffOffline(server);
 assert.equal(p.a.sync.state().status,'offline');
 assert.equal(p.a.settlements().find(x=>x.id==='cash-1').status,'pending');
 const r=await settled(p.a.confirmCash('cash-1'));
 assert.equal(r.ok,false);assert.equal(r.error.queued,true);
 const waiting=p.a.sync.pendingJob('op:confirm_cash:cash-1');
 assert.equal(waiting.op,'confirm_cash');assert.ok(Date.parse(waiting.at));
 assert.match(p.a.sync.clock(waiting.at),/^\d\d:\d\d$/);
 const twice=await settled(p.a.confirmCash('cash-1'));
 assert.equal(twice.error.duplicate,true);assert.equal(twice.error.message,'Already confirmed on this device. It is sent when the connection returns.');
 assert.deepEqual(Object.keys(p.outbox()),['op:confirm_cash:cash-1']);
 // the offline indicator names the queue
 const s=p.a.sync.state();assert.equal(s.pending,1);assert.equal(s.pendingCash,1);
 assert.equal(p.a.sync.statusText(s),'Offline · 1 change waiting to send (1 cash confirmation)');
 assert.equal(p.a.sync.statusText({status:'offline',pending:3,pendingCash:2}),'Offline · 3 changes waiting to send (2 cash confirmations)');
 server.down=false;await p.setOnline(true);await p.tick();
 assert.equal(server.sent('confirm_cash').length,1);
 assert.equal(server.events.length,1);
 assert.equal(p.a.sync.pendingJob('op:confirm_cash:cash-1'),null);
 assert.equal(p.a.settlements().find(x=>x.id==='cash-1').status,'confirmed');
 assert.equal(p.a.sync.refusals().length,0);
});

test('a confirmation of a request this device does not hold as pending is not queued offline',async()=>{
 const server=venueServer();pendingCash(server);
 const p=await staffOffline(server);
 const r=await settled(p.a.confirmCash('never-seen'));
 assert.equal(r.ok,false);assert.equal(r.error.message,'Connect to the restaurant before continuing.');
 assert.deepEqual(Object.keys(p.outbox()),[]);
});

test('two staff devices confirm the same cash offline: one payment, one completion event, no refusal (C2)',async()=>{
 const server=venueServer();pendingCash(server);
 const a=await staffOffline(server,new Map()),b=await staffOffline(server,new Map());
 await settled(a.a.confirmCash('cash-1'));await settled(b.a.confirmCash('cash-1'));
 server.down=false;
 await a.setOnline(true);await a.tick();
 await b.setOnline(true);await b.tick();
 assert.equal(server.sent('confirm_cash').length,2);
 assert.equal(server.events.filter(e=>e.eventType==='payment_completed').length,1);
 for(const d of [a,b]){
  assert.equal(d.a.settlements().find(x=>x.id==='cash-1').status,'confirmed');
  assert.equal(d.a.sync.refusals().length,0);assert.deepEqual(Object.keys(d.outbox()),[]);
 }
});

test('a waiter confirms cash offline; the request was cancelled elsewhere first: refused, not recorded, told what to do (C3)',async()=>{
 const server=venueServer();pendingCash(server);
 const p=await staffOffline(server);
 await settled(p.a.confirmCash('cash-1'));
 const at=p.a.sync.pendingJob('op:confirm_cash:cash-1').at;
 server.ops.cancel({id:'cash-1'});                                                   // the guest, or another device, got there first
 server.down=false;await p.setOnline(true);await p.tick();
 assert.equal(server.settle.get('cash-1').status,'cancelled');
 assert.equal(server.events.length,0);
 assert.equal(p.a.sync.job('op:confirm_cash:cash-1'),'refused');
 const r=p.a.sync.refusals().find(x=>x.id==='op:confirm_cash:cash-1');
 assert.equal(r.message,'Table 7, $18.00: this cash request was cancelled or changed on another device before your confirmation reached the restaurant (you confirmed it on this device at '+p.a.sync.clock(at)+'). It is not recorded as paid. If you took the cash, give it back or tell the manager.');
 assert.equal(p.a.sync.state().status,'error');
 assert.match(p.a.sync.statusText(p.a.sync.state()),/^Not saved: Table 7, \$18\.00: /);
});

test('a waiter confirms cash offline; the bill was closed elsewhere: the close is never undone, the confirmation lands as C2 or C3 (C4)',async()=>{
 // a pending request blocks the close: the bill can only close once it was confirmed elsewhere
 const server=venueServer();pendingCash(server);
 assert.deepEqual(server.ops.close_check(),[400,{message:'Bill is not fully settled',code:'P0001'}]);
 const p=await staffOffline(server);
 await settled(p.a.confirmCash('cash-1'));
 server.ops.confirm_cash({id:'cash-1'});assert.equal(server.ops.close_check()[0],200);   // confirmed on another device, then closed
 server.down=false;await p.setOnline(true);await p.tick();
 assert.ok(server.check.closedAt);
 assert.equal(server.events.length,1,'still one completion');
 assert.equal(p.a.sync.refusals().length,0);
 assert.equal(p.a.settlements().find(x=>x.id==='cash-1').status,'confirmed');
 // or cancelled, then the bill paid otherwise and closed: refused as C3
 const s2=venueServer();pendingCash(s2,'cash-2');
 const q=await staffOffline(s2);
 await settled(q.a.confirmCash('cash-2'));
 s2.ops.cancel({id:'cash-2'});pendingCash(s2,'cash-3');s2.ops.confirm_cash({id:'cash-3'});assert.equal(s2.ops.close_check()[0],200);
 s2.down=false;await q.setOnline(true);await q.tick();
 assert.equal(q.a.sync.job('op:confirm_cash:cash-2'),'refused');
 assert.match(q.a.sync.refusals()[0].message,/It is not recorded as paid\./);
 assert.equal(s2.events.length,1);
});

test('a signed-in member offline gets the staff list the server last gave this device; never without one',async()=>{
 const gate=(local,down)=>{
  const server=venueServer();server.down=down;
  const session=JSON.stringify({access_token:'at-1',refresh_token:'rt-1',expires_at:Math.floor(Date.now()/1000)+3600,email:'w@example.invalid',user_id:USER});
  local.set('aal.session',session);
  const p=boot({page:'dashboard',search:SEARCH,server,local});
  return p.window.AalaynaAuth.gate({roles:['owner','manager','waiter']}).ready;
 };
 const local=new Map();
 const online=await gate(local,false);
 assert.equal(online.member.role,'waiter');assert.equal(!!online.offline,false);
 assert.ok(local.get('aal.staff.mine:user:'+USER),'kept for later');
 const offline=await gate(local,true);
 assert.equal(offline.member.role,'waiter');assert.equal(offline.offline,true);
 const none=await gate(new Map(),true);
 assert.equal(none.member,null);assert.equal(none.part,'staff-refusal');
});

/* ---------- the service worker ---------- */
function worker(search=''){
 const listeners={},opened={},deleted=[],fetched=[];
 const cacheFor=name=>opened[name]||(opened[name]={added:[],put:[],add:async r=>{opened[name].added.push(typeof r==='string'?r:r.url);},put:async(r)=>{opened[name].put.push(r.url);},match:async()=>undefined});
 const caches={open:async n=>cacheFor(n),keys:async()=>['aal-guest-v2','aal-guest-v3','aal-staff-v0','aal-staff-v1','someone-else'],delete:async k=>{deleted.push(k);return true;},match:async()=>undefined};
 class Req{constructor(u,o){this.url=u;Object.assign(this,o||{});}}
 const self={location:{origin:'https://aalayna.com',search},addEventListener:(t,f)=>{listeners[t]=f;},skipWaiting:async()=>{},clients:{claim:async()=>{}}};
 const ctx={self,caches,Request:Req,URL,Promise,setTimeout,clearTimeout,fetch:async r=>{fetched.push(r.url||r);return {ok:false,type:'opaque',clone(){return this;}};}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),ctx,{filename:'sw.js'});
 const lifecycle=async type=>{let p;listeners[type]({waitUntil:x=>{p=x;}});await p;};
 return {ctx,listeners,opened,deleted,fetched,lifecycle};
}
const sameOrigin=(html,re)=>[...html.matchAll(re)].map(m=>m[1]).filter(u=>!/^(https?:)?\/\//.test(u)).map(u=>u.split('?')[0]);

test('the worker precaches every same-origin script the guest page loads, and the staff shell every script and style of the dashboard',()=>{
 const g=worker(),s=worker('?shell=staff');
 const guest=fs.readFileSync(path.join(root,'guest.html'),'utf8'),dash=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
 for(const f of sameOrigin(guest,/<script src="([^"]+)"/g))assert.ok(g.ctx.SHELL.includes(f),'guest shell: '+f);
 assert.ok(g.ctx.SHELL.includes('guest.html'));
 const dashFiles=sameOrigin(dash,/<script src="([^"]+)"/g).concat(sameOrigin(dash,/<link rel="stylesheet" href="([^"]+)"/g));
 assert.ok(dashFiles.includes('restaurant-ops.css')&&dashFiles.includes('restaurant-ops.js'));
 for(const f of dashFiles)assert.ok(s.ctx.SHELL.includes(f),'staff shell: '+f);
 assert.ok(s.ctx.SHELL.includes('dashboard.html'));
 // a guest phone never downloads the dashboard, and nothing of the homepage is ever kept
 assert.ok(!g.ctx.SHELL.some(f=>/dashboard|owner-metrics|restaurant-ops/.test(f)));
 for(const f of g.ctx.SHELL.concat(s.ctx.SHELL))assert.ok(fs.existsSync(path.join(root,f)),f+' exists');
 assert.equal(g.ctx.CACHE,g.ctx.VERSION);assert.match(g.ctx.VERSION,/^aal-guest-v\d+$/);
 assert.equal(s.ctx.CACHE,s.ctx.STAFF_VERSION);assert.match(s.ctx.STAFF_VERSION,/^aal-staff-v\d+$/);
 // both pages register it, each scoped to itself
 assert.match(guest,/register\('sw\.js', \{ scope: 'guest\.html', updateViaCache: 'none' \}\)/);
 assert.match(dash,/register\('sw\.js\?shell=staff', \{ scope: 'dashboard\.html', updateViaCache: 'none' \}\)/);
});

test('install keeps its own shell; activate deletes only the older caches of its own kind',async()=>{
 const g=worker(),s=worker('?shell=staff');
 await g.lifecycle('install');await s.lifecycle('install');
 assert.deepEqual(g.opened[g.ctx.VERSION].added,plain(g.ctx.SHELL));
 assert.deepEqual(s.opened[s.ctx.STAFF_VERSION].added,plain(s.ctx.SHELL));
 await g.lifecycle('activate');await s.lifecycle('activate');
 assert.deepEqual(g.deleted,['aal-guest-v2']);
 assert.deepEqual(s.deleted,['aal-staff-v0']);
});

test('routing: the API is never cached, pages and assets network first, fonts and images cache first',()=>{
 const {ctx}=worker(),o='https://aalayna.com',r=(u,mode='cors',dest='')=>ctx.route(new URL(u),mode,dest,o);
 assert.equal(r('https://xeqbkamwucqplvoavhyd.supabase.co/rest/v1/rpc/aal_snapshot'),null);
 assert.equal(r(o+'/rest/v1/rpc/aal_mutate'),null);
 assert.equal(r(o+'/auth/v1/token'),null);
 assert.equal(r(o+'/functions/v1/pos-bill'),null);
 assert.equal(r(o+'/guest.html?venue=Mayda&live=1','navigate','document'),'network');
 assert.equal(r(o+'/aalayna-store.js?v=25','cors','script'),'network');
 assert.equal(r(o+'/venues/mayda.json'),'network');
 assert.equal(r(o+'/brand/fonts/block.woff2','cors','font'),'network');              // T1: any same-origin asset a page asks for
 assert.equal(r(o+'/something.html'),null);
 assert.equal(r(o+'/brand/icons/icon-32.png','no-cors','image'),'cache');
 assert.equal(r('https://fonts.gstatic.com/s/x.woff2','cors','font'),'cache');
 assert.equal(r('https://images.example.com/dish.jpg','no-cors','image'),'cache');
 assert.equal(r('https://plausible.io/js/script.js','no-cors','script'),null);
});

test('the guest page hands the worker its menu photos to keep: https only, at most sixty',async()=>{
 const w=worker();
 const urls=['https://img.example/a.jpg','http://img.example/plain.jpg','javascript:alert(1)',null].concat(Array.from({length:80},(_,i)=>'https://img.example/'+i+'.jpg'));
 let wait;w.listeners.message({data:{type:'warm',urls},waitUntil:p=>{wait=p;}});await wait;
 assert.equal(w.fetched.length,60);
 assert.equal(w.fetched[0],'https://img.example/a.jpg');
 assert.ok(w.fetched.every(u=>/^https:\/\//.test(u)));
 const guest=fs.readFileSync(path.join(root,'guest.html'),'utf8');
 assert.match(guest,/postMessage\(\{ type: 'warm', urls: urls \}\)/);
});

/* ---------- the server's side of the rules, on a real PostgreSQL ---------- */
const modulePath=process.env.PGLITE_MODULE;
test('server: idempotent by payment id, first received wins, one completion (C1, C2, C3, C6)',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  for(const file of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql'])await db.exec(fs.readFileSync(path.join(root,'supabase',file),'utf8').replace('create extension if not exists pgcrypto;',''));
  const a=(await db.query(`select * from aal_register_venue('A','Beirut')`)).rows[0];
  await db.exec('set role anon');
  const auth=async key=>{await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify({'x-aalayna-key':key}),JSON.stringify({role:'anon'})]);};
  const call=async(op,body,token='')=>(await db.query('select aal_mutate($1,$2,$3::jsonb,$4) as value',[a.restaurant_id,op,JSON.stringify(body),token])).rows[0].value;
  await auth(a.owner_key);
  await call('open_check',{id:'bill',table:7,totalCents:1800,lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],currency:'USD',fxRateUsed:89500});
  const guest=(await call('issue_key',{checkId:'bill'})).key;
  await auth(guest);
  const t1='x'.repeat(40),t2='y'.repeat(40),req={id:'cash-a',requestId:'cash-a',checkId:'bill',amount:9,tip:0,rail:'cash',items:{k1:1}};
  // C1: the same request twice is the stored one; changed under the same id is refused
  const first=await call('reserve',req,t1);assert.equal(first.status,'pending');
  assert.equal((await call('reserve',req,t1)).ts,first.ts);
  await assert.rejects(call('reserve',{...req,amount:10},t1),/Payment request changed/);
  // C6: the second phone claims the same item: refused
  await call('reserve',{...req,id:'cash-b',requestId:'cash-b'},t2);
  await assert.rejects(call('reserve',{...req,id:'cash-c',requestId:'cash-c'},'z'.repeat(40)),/already|reserved/);
  // C2: two confirmations, one completion
  await auth(a.owner_key);
  assert.equal((await call('confirm_cash',{id:'cash-a'})).status,'confirmed');
  assert.equal((await call('confirm_cash',{id:'cash-a'})).status,'confirmed');
  // C3: cancelled first, then confirmed: refused
  await auth(guest);await call('cancel',{id:'cash-b'},t2);
  await auth(a.owner_key);await assert.rejects(call('confirm_cash',{id:'cash-b'}),/Cash request changed/);
  const ev=await db.query("select body from kv_rows where restaurant_id=$1 and collection='aal.events'",[a.restaurant_id]);
  assert.equal(ev.rows.filter(r=>r.body.eventType==='payment_completed').length,1);
 }finally{await db.close();}
});
