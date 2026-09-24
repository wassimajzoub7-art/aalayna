/* Staff sign-in (T4): one-time email codes and roles on the dashboard and editor.
   The real store, growth rules, sync layer (with AalaynaAuth) and each page's own
   sign-in script run against a mocked Supabase (Auth endpoints and PostgREST) and a
   minimal DOM. Proves that sign-in calls /auth/v1/otp then /auth/v1/verify with the
   right bodies, that a signed-in page sends Authorization: Bearer <token> and no
   x-aalayna-key, that the token is refreshed before it expires, that a venue missing
   from aal_staff 'mine' shows the refusal, that waiters are admitted to the
   dashboard but not the editor, that sign-out clears the session, and that the demo,
   the owner-key fallback and the guest path keep working. The SQL is not run here;
   see the optional PGlite block at the end. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const gateScript=page=>{const html=fs.readFileSync(path.join(root,page),'utf8');const s=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(x=>x.indexOf('AalaynaAuth.gate(')>=0);assert.ok(s,page+' has a sign-in script');return s;};
const RID=JSON.stringify(['kababji','hamra']),SEARCH='?venue=Kababji&place=Hamra',USER='0b7c6f7e-1d2a-4c3b-9e8f-112233445566';
const OWNER_KEY='own_'+'ab'.repeat(18);
const sessionFor=(email,{token='at-1',refresh='rt-1',expiresIn=3600}={})=>JSON.stringify({access_token:token,refresh_token:refresh,expires_at:Math.floor(Date.now()/1000)+expiresIn,email,user_id:USER});

/* a minimal DOM: elements by id, with the few behaviours the sign-in panel uses */
function makeDom(){
 const byId=new Map();
 function el(id){
  const attrs={},kids=[],cls=new Set();
  const node={id:id||'',style:{},dataset:{},textContent:'',innerHTML:'',value:'',href:'',disabled:false,hidden:false,children:kids,childNodes:kids,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   setAttribute(k,v){attrs[k]=String(v);},getAttribute(k){return k in attrs?attrs[k]:null;},removeAttribute(k){delete attrs[k];},hasAttribute(k){return k in attrs;},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},replaceChildren(...c){kids.length=0;kids.push(...c);},remove(){},
   addEventListener(){},removeEventListener(){},focus(){},click(){if(node.onclick)return node.onclick({preventDefault(){}});},querySelector:()=>null,querySelectorAll:()=>[]};
  return node;
 }
 return {visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  createElement:tag=>Object.assign(el(),{tagName:String(tag).toUpperCase()}),createTextNode:t=>Object.assign(el(),{textContent:t}),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html')};
}
function store(m){return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}};}

/* the mocked Supabase: Auth endpoints, aal_staff, aal_snapshot, aal_mutate */
function makeServer(o={}){
 const server={calls:[],role:o.role||'owner',mine:o.mine||[{restaurant_id:RID,role:o.role||'owner',name:'Kababji',place:'Hamra',slug:'kababji-hamra'}],tokens:0,rows:[]};
 server.fetch=async(url,options)=>{
  const body=options&&options.body?JSON.parse(options.body):null;server.calls.push({url,body,headers:Object.assign({},options.headers)});
  const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
  const u=url.replace('https://mock.invalid','');
  if(u==='/auth/v1/otp')return reply(200,{});
  if(u==='/auth/v1/verify')return body.token==='123456'?reply(200,{access_token:'at-1',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'rt-1',user:{id:USER,email:body.email}})
    :reply(403,{code:403,error_code:'otp_expired',msg:'Token has expired or is invalid'});
  if(u==='/auth/v1/token?grant_type=refresh_token'){server.tokens++;return reply(200,{access_token:'at-'+(server.tokens+1),expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'rt-'+(server.tokens+1),user:{id:USER,email:'rami@kababji.com'}});}
  if(u==='/auth/v1/logout?scope=local')return reply(204,null);
  if(u==='/rest/v1/rpc/aal_staff')return reply(200,server.mine);
  if(u==='/rest/v1/rpc/aal_snapshot')return reply(200,{version:2,role:server.role,checkId:null,rows:server.rows,docs:[]});
  if(u==='/rest/v1/rpc/aal_mutate'){const b=body.p_body;if(body.p_op!=='open_check')return reply(200,b);
   const {sessionId,deviceId,...rest}=b,row=Object.assign(rest,{venueId:body.p_rid,source:'staff',openedAt:'2026-09-24T10:00:00.000Z',revision:1});
   server.rows.push({collection:'aal.checks',id:row.id,body:row,updated_at:'now'});return reply(200,row);}
  return reply(201,null);
 };
 return server;
}
/* one page load: store, growth rules, config, sync layer (with AalaynaAuth), the page's sign-in script */
function boot({page='dashboard.html',search=SEARCH,server=makeServer(),local=new Map(),session=new Map(),gate=true}={}){
 const document=makeDom(),reloads=[],timers=[];
 const window={document,location:{pathname:'/'+page,search,origin:'https://aalayna.com',href:'https://aalayna.com/'+page+search,reload(){reloads.push(1);}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),navigator:{userAgent:'test'},crypto:require('node:crypto').webcrypto,
  addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),
  setInterval(){return 0;},clearInterval(){},setTimeout(f,ms){timers.push({f,ms});return timers.length;},clearTimeout(i){if(timers[i-1])timers[i-1].cleared=true;},confirm:()=>true,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,RegExp,Set,Map,fetch:server.fetch};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 if(page==='dashboard.html')run(fs.readFileSync(path.join(root,'owner-metrics.js'),'utf8'),'owner-metrics.js');   // the dashboard's own order
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 if(gate)run(gateScript(page),page+'#staff-sign-in');
 const $=id=>document.getElementById(id);
 return {window,document,$,server,local,session,reloads,timers,a:window.Aalayna,auth:window.AalaynaAuth,gate:window.staffGate};
}
const rest=server=>server.calls.filter(c=>c.url.indexOf('/rest/v1/')>=0);

test('with no session the sign-in panel covers the dashboard and the editor; the demo continues without it',async()=>{
 for(const page of ['dashboard.html','editor.html']){
  const p=boot({page,search:''});
  assert.equal(p.$('staff-gate').hidden,false,page);assert.equal(p.$('staff-signin').hidden,false);
  assert.equal(p.$('staff-refusal').hidden,true);assert.equal(p.$('staff-code-form').hidden,true);
  assert.equal(p.$('staff-send').textContent,'Send me a code');
  assert.equal(p.$('staff-demo').hidden,false);assert.equal(p.$('staff-key').hidden,true);   // demo mode: no key, no session
  assert.equal(p.a.demoMode(),true);
  p.$('staff-demo').click();
  assert.equal(p.$('staff-gate').hidden,true);assert.equal(p.$('staff-bar').hidden,false);
  assert.equal(p.$('staff-bar-who').textContent,'Demo, not signed in');assert.equal(p.$('staff-bar-action').textContent,'Sign in');
  assert.equal(p.session.get('aal.gate'),'demo');
  assert.equal(p.server.calls.length,0);                                        // nothing leaves the browser in the demo
  // the same tab reloads straight into the demo; "Sign in" brings the panel back
  const again=boot({page,search:'',session:p.session});
  assert.equal(again.$('staff-gate').hidden,true);
  again.$('staff-bar-action').click();
  assert.equal(again.$('staff-gate').hidden,false);assert.equal(again.session.has('aal.gate'),false);
 }
});

test('sign-in sends the code through /auth/v1/otp, then /auth/v1/verify, and keeps the session in aal.session',async()=>{
 const p=boot();
 p.$('staff-email').value='  Rami@Kababji.com ';
 await p.$('staff-email-form').onsubmit({preventDefault(){}});
 const otp=p.server.calls[0];
 assert.equal(otp.url,'https://mock.invalid/auth/v1/otp');
 assert.deepEqual(otp.body,{email:'rami@kababji.com',create_user:true});
 assert.equal(otp.headers.apikey,'public-anon');assert.equal(otp.headers['x-aalayna-key'],undefined);
 assert.equal(p.$('staff-code-form').hidden,false);assert.equal(p.$('staff-send').textContent,'Send a new code');
 assert.match(p.$('staff-msg').textContent,/six-digit code to rami@kababji\.com/);
 // a malformed code is refused here; a wrong one by the server
 p.$('staff-code').value='12a45';await p.$('staff-code-form').onsubmit({preventDefault(){}});
 assert.equal(p.server.calls.length,1);assert.match(p.$('staff-msg').textContent,/six-digit code/);
 p.$('staff-code').value='654321';await p.$('staff-code-form').onsubmit({preventDefault(){}});
 assert.match(p.$('staff-msg').textContent,/wrong or has expired/);assert.equal(p.local.has('aal.session'),false);
 p.$('staff-code').value='123 456';await p.$('staff-code-form').onsubmit({preventDefault(){}});
 const verify=p.server.calls[p.server.calls.length-1];
 assert.equal(verify.url,'https://mock.invalid/auth/v1/verify');
 assert.deepEqual(verify.body,{type:'email',email:'rami@kababji.com',token:'123456'});
 assert.equal(verify.headers.apikey,'public-anon');
 const s=JSON.parse(p.local.get('aal.session'));
 assert.equal(s.access_token,'at-1');assert.equal(s.refresh_token,'rt-1');assert.equal(s.email,'rami@kababji.com');assert.equal(s.user_id,USER);
 assert.ok(s.expires_at>Date.now()/1000);
 assert.equal(p.reloads.length,1);                                              // the page restarts signed in
 assert.equal(p.server.calls.filter(c=>c.url.indexOf('/rest/v1/')>=0).length,0);
});

test('a signed-in page sends Authorization: Bearer <access token>, keeps apikey, and never sends x-aalayna-key',async()=>{
 // an owner key stored for this venue earlier must not be sent once a session exists
 const local=new Map([['aal.session',sessionFor('rami@kababji.com')],['aal.access:'+RID+':owner',OWNER_KEY]]);
 const p=boot({local});await p.a.sync.ready;await p.gate.ready;await flush();
 assert.equal(p.a.sync.enabled,true);assert.equal(p.a.sync.signedIn,true);assert.equal(p.a.demoMode(),false);
 await p.a.openServiceCheck({table:4,total:12,lines:[]});
 const calls=rest(p.server);
 assert.deepEqual([...new Set(calls.map(c=>c.url.split('/rpc/')[1]))].sort(),['aal_mutate','aal_snapshot','aal_staff']);
 for(const c of calls){
  assert.equal(c.headers.Authorization,'Bearer at-1',c.url);
  assert.equal(c.headers.apikey,'public-anon',c.url);
  assert.equal('x-aalayna-key' in c.headers,false,c.url);
 }
 assert.deepEqual(calls.find(c=>c.url.endsWith('/rpc/aal_staff')).body,{p_rid:null,p_body:{op:'mine'}});
 assert.equal(calls.find(c=>c.url.endsWith('/rpc/aal_mutate')).body.p_op,'open_check');
 // a member of this venue: the panel steps aside and the header names the person
 assert.equal(p.$('staff-gate').hidden,true);
 assert.equal(p.$('staff-bar-who').textContent,'Signed in as rami@kababji.com · Owner');assert.equal(p.$('staff-bar-action').textContent,'Sign out');
 assert.equal(p.document.documentElement.getAttribute('data-staff-role'),'owner');
});

test('the access token is refreshed through /auth/v1/token before it expires, and the new one is sent',async()=>{
 const local=new Map([['aal.session',sessionFor('rami@kababji.com',{expiresIn:30})]]);   // 30 s left
 const p=boot({local});await p.a.sync.ready;await p.gate.ready;await flush();
 const refresh=p.server.calls.filter(c=>c.url.endsWith('/auth/v1/token?grant_type=refresh_token'));
 assert.equal(refresh.length,1);                                                // one refresh, shared by every caller
 assert.deepEqual(refresh[0].body,{refresh_token:'rt-1'});assert.equal(refresh[0].headers.apikey,'public-anon');
 for(const c of rest(p.server))assert.equal(c.headers.Authorization,'Bearer at-2',c.url);
 const s=JSON.parse(p.local.get('aal.session'));
 assert.equal(s.access_token,'at-2');assert.equal(s.refresh_token,'rt-2');assert.equal(s.user_id,USER);
 // and a refresh is scheduled ahead of the new expiry
 const t=p.timers.filter(x=>!x.cleared).pop();assert.ok(t&&t.ms>3000000&&t.ms<3600000,'a timer about 90 s before expiry');
});

test("a venue that is not in the user's memberships shows the refusal instead of the app",async()=>{
 const server=makeServer({mine:[{restaurant_id:JSON.stringify(['roadster','dbayeh']),role:'manager',name:"Roadster's",place:'Dbayeh',slug:'roadster'},
                                {restaurant_id:JSON.stringify(['tawlet','']),role:'waiter',name:null,place:null,slug:null}]});
 const p=boot({server,local:new Map([['aal.session',sessionFor('rami@kababji.com')]])});
 assert.equal(p.$('staff-wait').hidden,false);                                  // checking before anything shows
 await p.gate.ready;
 assert.equal(p.$('staff-gate').hidden,false);assert.equal(p.$('staff-refusal').hidden,false);assert.equal(p.$('staff-signin').hidden,true);
 assert.equal(p.$('staff-refusal-title').textContent,"You are not on this restaurant's staff list");
 assert.match(p.$('staff-refusal-text').textContent,/^Signed in as rami@kababji\.com\. Ask the owner to invite this email address\./);
 const links=p.$('staff-venues').children.map(li=>li.children[0]);
 assert.deepEqual(links.map(a=>a.href),["dashboard.html?venue=Roadster's&place=Dbayeh",'dashboard.html?venue=tawlet']);
 assert.deepEqual(links.map(a=>a.textContent),["Roadster's · Dbayeh (Manager)",'tawlet (Waiter)']);
 assert.equal(p.$('staff-venues').hidden,false);assert.equal(p.$('staff-retry').hidden,true);
 assert.equal(p.document.documentElement.getAttribute('data-staff-role'),null);
 // a store that lacks the SQL says so
 const missing=makeServer();missing.fetch=(f=>async(url,o)=>url.endsWith('/rpc/aal_staff')?{ok:false,status:404,text:async()=>JSON.stringify({code:'PGRST202',message:'Could not find the function'})}:f(url,o))(missing.fetch);
 const q=boot({server:missing,local:new Map([['aal.session',sessionFor('rami@kababji.com')]])});await q.gate.ready;
 assert.equal(q.$('staff-refusal-title').textContent,'Could not check your staff access');
 assert.match(q.$('staff-refusal-text').textContent,/Run supabase\/auth-2026-09-24\.sql/);assert.equal(q.$('staff-retry').hidden,false);
});

test('a waiter is admitted to the dashboard, can open a bill, and is refused by the menu editor',async()=>{
 const local=new Map([['aal.session',sessionFor('sara@kababji.com')]]);
 const p=boot({server:makeServer({role:'waiter'}),local});
 assert.equal(p.a.sync.state().role,'staff');                                   // no role until the server names it
 p.a.recordHealth();                                                            // the dashboard writes a health report at boot
 await p.a.sync.ready;await p.gate.ready;await flush();
 assert.equal(p.a.sync.state().pending,0);assert.equal(p.a.sync.state().failed,0);   // never queued as an owner write
 assert.equal(rest(p.server).filter(x=>x.url.indexOf('/rest/v1/kv_')>=0).length,0);
 assert.equal(p.$('staff-gate').hidden,true);
 assert.equal(p.document.documentElement.getAttribute('data-staff-role'),'waiter');   // hides data-owner-only controls
 assert.equal(p.$('staff-bar-who').textContent,'Signed in as sara@kababji.com · Waiter');
 assert.equal(p.a.sync.state().role,'waiter');
 const c=await p.a.openServiceCheck({table:3,total:20,lines:[]});
 assert.equal(c.table,3);assert.equal(rest(p.server).filter(x=>x.url.endsWith('/rpc/aal_mutate')).length,1);
 const e=boot({page:'editor.html',server:makeServer({role:'waiter'}),local:new Map([['aal.session',sessionFor('sara@kababji.com')]])});await e.gate.ready;
 assert.equal(e.$('staff-gate').hidden,false);assert.equal(e.$('staff-refusal').hidden,false);
 assert.equal(e.$('staff-refusal-title').textContent,'The menu editor is for owners and managers');
 const m=boot({page:'editor.html',server:makeServer({role:'manager'}),local:new Map([['aal.session',sessionFor('lina@kababji.com')]])});await m.gate.ready;
 assert.equal(m.$('staff-gate').hidden,true);assert.equal(m.$('staff-bar-who').textContent,'Signed in as lina@kababji.com · Manager');
});

test('sign-out clears the session and this user\'s cached venue data, tells Supabase, and reloads to the panel',async()=>{
 const local=new Map([['aal.session',sessionFor('rami@kababji.com')]]);
 const p=boot({local});await p.a.sync.ready;await p.gate.ready;await flush();
 const cached=[...p.local.keys()].filter(k=>k.indexOf('aal.scope:')===0);
 assert.ok(cached.length>0&&cached.every(k=>k.indexOf('"user:'+USER+'"')>0),'the signed-in cache is scoped to the user');
 p.local.set('aal.scope:'+JSON.stringify([RID,'owner',OWNER_KEY])+':aal.checks','[]');     // another credential's cache stays
 await p.$('staff-bar-action').onclick({preventDefault(){}});await flush();
 assert.equal(p.local.has('aal.session'),false);
 assert.deepEqual([...p.local.keys()].filter(k=>k.indexOf('aal.scope:')===0),['aal.scope:'+JSON.stringify([RID,'owner',OWNER_KEY])+':aal.checks']);
 const out=p.server.calls.find(c=>c.url.endsWith('/auth/v1/logout?scope=local'));
 assert.ok(out);assert.equal(out.headers.Authorization,'Bearer at-1');
 assert.equal(p.reloads.length,1);
 assert.equal(p.auth.session(),null);
 const next=boot({local:p.local});
 assert.equal(next.$('staff-gate').hidden,false);assert.equal(next.$('staff-signin').hidden,false);
});

test('without a session an owner link still works, behind "Continue with the owner link", and sends the key',async()=>{
 const p=boot({search:SEARCH+'&k='+OWNER_KEY});await p.a.sync.ready;await flush();
 assert.equal(p.$('staff-gate').hidden,false);
 assert.equal(p.$('staff-key').hidden,false);assert.equal(p.$('staff-demo').hidden,true);
 p.$('staff-key').click();
 assert.equal(p.$('staff-gate').hidden,true);assert.equal(p.$('staff-bar-who').textContent,'Owner link, not signed in');
 for(const c of rest(p.server)){assert.equal(c.headers['x-aalayna-key'],OWNER_KEY);assert.equal(c.headers.Authorization,'Bearer public-anon');}
});

test('the guest path ignores a staff session: a chk_ page still sends its bill key with the anon bearer',async()=>{
 const KEY='chk_'+'cd'.repeat(24),local=new Map([['aal.session',sessionFor('rami@kababji.com')]]);
 const p=boot({page:'guest.html',search:SEARCH+'&k='+KEY,local,gate:false});await p.a.sync.ready;await flush();
 assert.equal(p.a.sync.signedIn,false);
 const calls=rest(p.server);assert.ok(calls.length>0);
 for(const c of calls){assert.equal(c.headers['x-aalayna-key'],KEY);assert.equal(c.headers.Authorization,'Bearer public-anon');}
 assert.equal(p.server.calls.filter(c=>c.url.indexOf('/auth/v1/')>=0).length,0);
});

/* restaurant-ops.js paintCheckBalances, the real function, with the page helpers it expects */
function buttons(node,out=[]){(node.children||[]).forEach(c=>{if(c.tagName==='BUTTON')out.push(c.textContent);buttons(c,out);});return out;}
async function floorAs(role,{signedIn=true}={}){
 const local=new Map(signedIn?[['aal.session',sessionFor(role+'@kababji.com')]]:[]);
 const p=boot({server:makeServer({role}),local,search:signedIn?SEARCH:'',gate:false});
 const before=p.a.sync.state().role;
 await p.a.sync.ready;await flush();
 const open=await p.a.openServiceCheck({table:4,total:12,lines:[]});
 await p.a.openServiceCheck({table:5,total:20,lines:[]});
 const rows=JSON.parse(p.local.get(p.a.util.storageKey('aal.settle'))||'[]');
 rows.push({id:'pay-4',venueId:p.a.venueId(),checkId:open.id,table:4,rail:'cash',amount:12,tip:0,items:{},status:'confirmed',ts:'2026-09-24T10:01:00.000Z',confirmedAt:'2026-09-24T10:02:00.000Z'});
 p.a.util.rawWrite('aal.settle',rows);
 return {p,before};
}

test('Live floor controls follow the role: staff open bills and bill links, only the owner closes a bill',async()=>{
 const paint=p=>{vm.runInContext(fs.readFileSync(path.join(root,'restaurant-ops.js'),'utf8')+';paintCheckBalances();',p.ctx);return buttons(p.$('check-balances'));};
 const count=(list,label)=>list.filter(x=>x===label).length;
 for(const role of ['owner','waiter']){
  const {p}=await floorAs(role);
  p.window.$=id=>p.document.getElementById(id);p.window.money=v=>'$'+Number(v).toFixed(2);p.window.toast=()=>{};p.$('report-period').value='7';
  p.ctx=vm.createContext(p.window);
  const labels=paint(p);
  assert.equal(count(labels,'Open a bill from a POS total'),1,role);
  assert.equal(count(labels,'Guest bill link'),2,role);
  assert.equal(count(labels,'Close settled bill'),role==='owner'?1:0,role);     // aal_mutate refuses close_check for a waiter
 }
 // before the first read names the role: no shared-mode controls at all
 const early=boot({server:makeServer({role:'owner'}),local:new Map([['aal.session',sessionFor('rami@kababji.com')]]),gate:false});
 early.window.$=id=>early.document.getElementById(id);early.window.money=v=>'$'+Number(v).toFixed(2);early.window.toast=()=>{};early.$('report-period').value='7';early.ctx=vm.createContext(early.window);
 assert.equal(early.a.sync.state().role,'staff');
 assert.deepEqual(paint(early).filter(l=>['Open a bill from a POS total','Guest bill link','Close settled bill'].indexOf(l)>=0),[]);
 // the local demo keeps closing bills and has no shared-mode buttons
 const demo=boot({search:'',gate:false});
 demo.window.$=id=>demo.document.getElementById(id);demo.window.money=v=>'$'+Number(v).toFixed(2);demo.window.toast=()=>{};demo.$('report-period').value='7';demo.ctx=vm.createContext(demo.window);
 const c=demo.a.openServiceCheck({table:6,total:5,lines:[]});
 demo.a.util.rawWrite('aal.settle',[{id:'d1',venueId:demo.a.venueId(),checkId:c.id,table:6,rail:'cash',amount:5,tip:0,items:{},status:'confirmed',ts:'2026-09-24T10:01:00.000Z',confirmedAt:'2026-09-24T10:02:00.000Z'}]);
 const d=paint(demo);
 assert.ok(d.indexOf('Close settled bill')>=0);assert.equal(d.indexOf('Guest bill link'),-1);assert.equal(d.indexOf('Open a bill from a POS total'),-1);
});

test("the dashboard's health report waits for the first read: an owner's is queued and sent, a waiter's never",async()=>{
 const html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
 const snippet=html.slice(html.indexOf('var healthAfterRead'),html.indexOf('Aalayna.on(function(){ paintTonight(); paintTips(); });'));
 assert.match(snippet,/onReady/);
 const health=p=>rest(p.server).filter(c=>c.url.indexOf('/rest/v1/kv_rows')>=0&&c.body.some(r=>r.collection==='aal.health_reports'));
 for(const role of ['owner','waiter']){
  const p=boot({server:makeServer({role}),local:new Map([['aal.session',sessionFor(role+'@kababji.com')]]),gate:false});
  let paints=0;p.window.paintTonight=()=>paints++;p.window.paintTips=()=>{};
  vm.runInContext(snippet,p.ctx=vm.createContext(p.window));                    // the page's own boot lines
  assert.equal(paints,1);assert.deepEqual(JSON.parse(p.local.get(p.a.util.storageKey('aal.health_reports'))||'[]'),[]);   // nothing before the read
  await p.a.sync.ready;await flush(12);
  assert.equal(paints,2,role);                                                 // repainted once the role is known
  assert.ok(JSON.parse(p.local.get(p.a.util.storageKey('aal.health_reports'))||'[]').length>0,role);
  if(role==='owner'){
   await p.a.sync.pull().then(()=>p.a.sync.retry());await flush(12);
   const sent=health(p);assert.equal(sent.length,1);assert.equal(sent[0].headers.Authorization,'Bearer at-1');assert.equal('x-aalayna-key' in sent[0].headers,false);
  }else{assert.equal(health(p).length,0);assert.equal(p.a.sync.state().failed,0);}
 }
 // no key and no session: it runs at once, as before
 const demo=boot({search:'',gate:false});let ran=0;demo.window.paintTonight=()=>{};demo.window.paintTips=()=>{};
 const rh=demo.a.recordHealth;demo.a.recordHealth=function(){ran++;return rh.apply(this,arguments);};
 vm.runInContext(snippet,vm.createContext(demo.window));assert.equal(ran,1);assert.equal(demo.server.calls.length,0);
});

/* The SQL, against a real PostgreSQL (PGlite), like tests/database.test.cjs. Skipped
   unless PGLITE_MODULE points at @electric-sql/pglite (see supabase/README.md).
   auth.users is a stand-in with the columns aal_staff_email() reads. */
const modulePath=process.env.PGLITE_MODULE;
test('auth SQL: staff list, roles in aal_role, waiter limits in aal_mutate and aal_snapshot',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),db=new PGlite(),sql=f=>fs.readFileSync(path.join(root,'supabase',f),'utf8').replace('create extension if not exists pgcrypto;','');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;`);
  await db.exec(`create function gen_random_bytes(n integer) returns bytea language sql as $$select substring(decode(string_agg(replace(gen_random_uuid()::text,'-',''),''),'hex') from 1 for n) from generate_series(1,ceil(n/16.0)::int)$$;`);
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);`);
  for(const f of ['migration.sql','site-events.sql','hardening-2026-09-15.sql','hardening-2026-09-24.sql','admin.sql','sessions-2026-09-24.sql','auth-2026-09-24.sql','auth-2026-09-24.sql'])await db.exec(sql(f));
  const OWNER='11111111-1111-4111-8111-111111111111',WAITER='22222222-2222-4222-8222-222222222222',STRANGER='33333333-3333-4333-8333-333333333333';
  await db.query(`insert into auth.users values($1,'rami@kababji.com',now(),null),($2,'sara@kababji.com',now(),null),($3,'x@y.com',null,null)`,[OWNER,WAITER,STRANGER]);
  await db.query("insert into admin_keys(admin_key,label) values('adm_test','test')");
  const as=async(role,headers,claims)=>{await db.exec('reset role');await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.stringify(headers||{}),JSON.stringify(claims||{role})]);await db.exec('set role '+role);};
  const one=async(q,args)=>(await db.query(q,args)).rows[0].value;
  await as('anon',{'x-aalayna-admin':'adm_test'});
  const v=await one("select aal_admin_register_venue('Kababji','Hamra','kababji-hamra','{}'::jsonb) as value");
  const rid=v.restaurant_id,staff=body=>one('select aal_staff($1,$2::jsonb) as value',[rid,JSON.stringify(body)]);
  const mutate=(op,body,token='')=>one('select aal_mutate($1,$2,$3::jsonb,$4) as value',[rid,op,JSON.stringify(body),token]);
  const snapshot=()=>one('select aal_snapshot($1) as value',[rid]);
  const role=()=>one('select aal_role($1) as value',[rid]);
  const owner={role:'authenticated',sub:OWNER,email:'rami@kababji.com'},waiter={role:'authenticated',sub:WAITER,email:'sara@kababji.com'};
  // the owner key manages the list; the table itself is closed
  await as('anon',{'x-aalayna-key':v.owner_key});
  await assert.rejects(db.query('select * from staff_members'),/permission denied/);
  let list=await staff({op:'invite',email:' Rami@Kababji.com ',role:'owner'});
  assert.deepEqual(list.staff.map(s=>[s.email,s.role,s.invited_by]),[['rami@kababji.com','owner','owner key']]);
  await staff({op:'invite',email:'sara@kababji.com',role:'waiter'});
  await assert.rejects(staff({op:'invite',email:'sara@kababji.com',role:'manager'}),/already on the staff list/);
  await assert.rejects(staff({op:'invite',email:'nope',role:'waiter'}),/valid email/);
  await assert.rejects(staff({op:'invite',email:'a@b.co',role:'chef'}),/owner, manager or waiter/);
  await as('anon',{'x-aalayna-key':v.guest_key});
  await assert.rejects(staff({op:'list'}),/Only the restaurant owner/);
  // roles from the session
  await as('authenticated',{},owner);assert.equal(await role(),'owner');
  assert.deepEqual((await one("select aal_staff(null,'{\"op\":\"mine\"}'::jsonb) as value")).map(m=>[m.restaurant_id,m.role,m.slug]),[[rid,'owner','kababji-hamra']]);
  await assert.rejects(staff({op:'revoke',email:'rami@kababji.com'}),/cannot revoke your own/);
  await as('authenticated',{},{role:'authenticated',sub:STRANGER,email:'x@y.com'});assert.equal(await role(),null);   // unconfirmed, not listed
  await assert.rejects(one("select aal_staff(null,'{\"op\":\"mine\"}'::jsonb) as value"),/Sign in/);
  await as('authenticated',{},{role:'authenticated',sub:WAITER,email:'rami@kababji.com'});assert.equal(await role(),null);   // email must match the user
  await as('authenticated',{},waiter);assert.equal(await role(),'waiter');
  await assert.rejects(staff({op:'list'}),/Only the restaurant owner/);
  // a waiter works the floor
  const bill=await mutate('open_check',{id:'bill-1',table:5,lines:[{id:'k1',q:2,p:18,name:'Shish taouk'}],currency:'USD'});
  assert.equal(bill.totalCents,1800);
  await mutate('update_check',{checkId:'bill-1',lines:[{id:'k1',q:3,p:27,name:'Shish taouk'}]});
  assert.match((await mutate('issue_key',{checkId:'bill-1'})).key,/^chk_/);
  await mutate('event',{eventId:'e1',eventType:'ui_action'});
  await assert.rejects(mutate('reserve',{id:'p0',checkId:'bill-1',amount:27,tip:0,rail:'cash'},'t'.repeat(40)),/Wrong bill/);
  // a guest pays cash with a bill key; the waiter confirms one request and cancels another
  await as('authenticated',{},owner);const k=(await mutate('issue_key',{checkId:'bill-1'})).key;
  await as('anon',{'x-aalayna-key':k});
  await mutate('reserve',{id:'p1',checkId:'bill-1',amount:10,tip:0,rail:'cash'},'t'.repeat(40));
  await mutate('reserve',{id:'p2',checkId:'bill-1',amount:17,tip:0,rail:'cash'},'u'.repeat(40));
  await as('authenticated',{},waiter);
  assert.equal((await mutate('confirm_cash',{id:'p1'})).status,'confirmed');
  assert.equal((await mutate('cancel',{id:'p2'})).status,'cancelled');
  await assert.rejects(mutate('refund',{id:'p1'}),/Digital refunds require/);
  await assert.rejects(mutate('receipt',{id:'p1',contact:'g@x.com',channel:'email',receipt:true,marketing:false,requestId:'r1'}),/Wrong payer token/);
  await as('anon',{'x-aalayna-key':k});await mutate('reserve',{id:'p3',checkId:'bill-1',amount:17,tip:0,rail:'cash'},'v'.repeat(40));
  await as('authenticated',{},waiter);await mutate('confirm_cash',{id:'p3'});
  await assert.rejects(mutate('close_check',{checkId:'bill-1'}),/Only staff may close/);
  // the waiter snapshot: bills and payments, no guests, no events, no draft or tips
  await as('anon',{'x-aalayna-key':k});await mutate('receipt',{id:'p1',contact:'g@x.com',channel:'email',receipt:true,marketing:true,requestId:'r2'},'t'.repeat(40));
  await as('authenticated',{},waiter);
  const snap=await snapshot();
  assert.equal(snap.role,'waiter');
  assert.deepEqual([...new Set(snap.rows.map(r=>r.collection))].sort(),['aal.checks','aal.settle']);
  assert.ok(snap.rows.filter(r=>r.collection==='aal.settle').every(r=>!('customerId' in r.body)&&!('deviceId' in r.body)));
  assert.equal((await db.query('select count(*)::int as n from kv_rows')).rows[0].n,0);   // direct reads: nothing for a waiter
  // the owner sees the guest list; revoking the waiter ends access at once
  await as('authenticated',{},owner);
  assert.ok((await snapshot()).rows.some(r=>r.collection==='aal.guests'));
  list=await staff({op:'change_role',email:'sara@kababji.com',role:'manager'});
  assert.equal(list.staff.find(s=>s.email==='sara@kababji.com').role,'manager');
  await staff({op:'revoke',email:'sara@kababji.com'});
  await as('authenticated',{},waiter);assert.equal(await role(),null);
  await assert.rejects(snapshot(),/Open a current bill link/);
  // a banned user loses access even with a live row
  await as('authenticated',{},owner);await db.exec('reset role');await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[OWNER]);
  await as('authenticated',{},owner);assert.equal(await role(),null);
 }finally{await db.close();}
});
