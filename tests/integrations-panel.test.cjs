/* T16: the owner's Integrations card on the dashboard (POS keys, webhook endpoints, deliveries).
   The real store, growth rules, sync layer (with AalaynaAuth) and restaurant-ops.js run against a fake
   PostgREST (aal_snapshot, aal_integration, aal_webhooks, with the server's own sentences and result shapes,
   copied from supabase/integrations-2026-09-30.sql) and a minimal DOM. Proves who sees the card (a live owner
   whose role the first server read has named; never the demo, a waiter, a manager or a wrong key), that each
   action sends the right RPC with the credential the dashboard already uses, that a key or secret is shown once
   and leaves no trace once the box is closed, that the three delivery statuses read correctly, and that a
   refusal shows the server's sentence. The SQL itself is covered by tests/pos-bridge.test.cjs and friends. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),flush=async(n=24)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const RID=JSON.stringify(['mayda','hamra']),SEARCH='?venue=Mayda&place=Hamra',USER='0b7c6f7e-1d2a-4c3b-9e8f-112233445566';
const OWNER_KEY='own_'+'ab'.repeat(18);
const sessionFor=email=>JSON.stringify({access_token:'at-1',refresh_token:'rt-1',expires_at:Math.floor(Date.now()/1000)+3600,email,user_id:USER});
const html=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

/* a minimal DOM: hidden, checked, value, children, and the few methods the card uses */
function makeDom(){
 const byId=new Map();
 function el(id,tag){
  const attrs={},kids=[];
  const node={id:id||'',tagName:tag?String(tag).toUpperCase():'',style:{},dataset:{},textContent:'',innerHTML:'',value:'',className:'',disabled:false,hidden:false,checked:false,type:'',children:kids,childNodes:kids,
   setAttribute(k,v){attrs[k]=String(v);},getAttribute(k){return k in attrs?attrs[k]:null;},removeAttribute(k){delete attrs[k];},hasAttribute(k){return k in attrs;},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},replaceChildren(...c){kids.length=0;kids.push(...c);},remove(){},scrollIntoView(){},
   addEventListener(){},removeEventListener(){},focus(){},click(){if(node.onclick)return node.onclick({preventDefault(){}});},querySelector:()=>null,querySelectorAll:()=>[]};
  return node;
 }
 return {visibilityState:'visible',cookie:'',readyState:'complete',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  createElement:tag=>el('',tag),createTextNode:t=>Object.assign(el(),{textContent:t}),querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},
  createRange:()=>({selectNodeContents(){}}),execCommand:()=>true,
  body:el('body'),head:el('head'),documentElement:el('html')};
}
const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}});
const text=n=>(n.textContent||'')+(n.children||[]).map(text).join(' ');
const walk=(n,out=[])=>{out.push(n);(n.children||[]).forEach(c=>walk(c,out));return out;};
const buttons=n=>walk(n).filter(x=>x.tagName==='BUTTON');
const button=(n,label)=>{const b=buttons(n).find(x=>x.textContent===label);assert.ok(b,'button '+label+' in '+text(n).slice(0,200));return b;};
const hex=n=>[...Array(n)].map(()=>Math.floor(Math.random()*16).toString(16)).join('');

/* the fake PostgREST: results are shaped like the SQL's, refusals carry the SQL's sentences */
function makeServer(o={}){
 const server={calls:[],role:o.role||'owner',keys:o.keys||[],endpoints:o.endpoints||[],deliveries:o.deliveries||[],ownerKey:OWNER_KEY,gate:null,refuse:null,down:false,seq:0};
 const cred=h=>h['x-aalayna-key']===server.ownerKey?'owner':/^Bearer at-/.test(h.Authorization||'')?server.role:'guest';
 const reply=(status,obj)=>({ok:status<300,status,text:async()=>obj==null?'':JSON.stringify(obj)});
 const fail=(status,message,code)=>reply(status,{code:code||'P0001',message,details:null,hint:null});
 const keyList=()=>server.keys.slice().sort((a,b)=>(a.revoked_at?1:0)-(b.revoked_at?1:0));
 server.fetch=async(url,options)=>{
  if(server.down)throw new TypeError('Failed to fetch');
  const u=url.replace('https://mock.invalid',''),body=options&&options.body?JSON.parse(options.body):null,headers=Object.assign({},options.headers);
  server.calls.push({fn:u.replace('/rest/v1/rpc/',''),rid:body&&body.p_rid,body:body&&body.p_body,headers});
  if(u==='/rest/v1/rpc/aal_snapshot'){const c=cred(headers);return reply(200,{version:2,role:c==='owner'?'owner':c==='waiter'?'waiter':'guest',checkId:null,rows:[],docs:[]});}
  if(u==='/rest/v1/rpc/aal_staff')return reply(200,[]);
  if(u!=='/rest/v1/rpc/aal_integration'&&u!=='/rest/v1/rpc/aal_webhooks')return reply(201,null);
  if(server.gate)await server.gate;
  if(server.missing)return reply(404,{code:'PGRST202',message:'Could not find the function public.aal_integration in the schema cache'});
  const isKeys=u.endsWith('aal_integration'),b=body.p_body,op=b.op||'list';
  if(server.refuse)return fail(403,server.refuse,'42501');
  if(cred(headers)!=='owner')return fail(403,isKeys?'Only the restaurant owner can manage POS keys.':'Only the restaurant owner can manage webhooks.','42501');
  if(isKeys){
   if(op==='issue'){
    if(server.keys.filter(k=>!k.revoked_at).length>=(o.keyCap??10))return fail(400,'This restaurant already has 10 live POS keys. Revoke one first.');
    const key='pos_'+hex(64),row={id:'k'+(++server.seq),label:b.label,hint:'pos_'+key.slice(4,12)+'...',scopes:['pos'],created_at:'2026-09-30T09:00:00Z',last_used_at:null,revoked_at:null};
    server.keys.push(row);return reply(200,{restaurant_id:body.p_rid,id:row.id,key,keys:keyList()});
   }
   if(op==='revoke'){const k=server.keys.find(x=>x.id===b.id&&!x.revoked_at);if(!k)return fail(400,'No live POS key with that id.');k.revoked_at='2026-09-30T10:00:00Z';return reply(200,{restaurant_id:body.p_rid,keys:keyList()});}
   return reply(200,{restaurant_id:body.p_rid,keys:keyList()});
  }
  const epList=()=>server.endpoints.slice().sort((a,c)=>(c.active?1:0)-(a.active?1:0));
  if(op==='add'){
   const host=(/^https:\/\/([^\/?#:@]+)/.exec(b.url)||[])[1]||'';
   if(!host||!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host))return fail(400,'The webhook address must be https:// and a public host name.');
   const secret='whsec_'+hex(64),ep={id:'e'+(++server.seq),url:b.url,events:b.events||['bill.paid','bill.closed'],active:true,created_at:'2026-09-30T09:05:00Z'};
   server.endpoints.push(ep);return reply(200,{restaurant_id:body.p_rid,id:ep.id,url:ep.url,events:ep.events,secret});
  }
  if(op==='remove'||op==='test'){
   const ep=server.endpoints.find(x=>x.id===b.id&&x.active);if(!ep)return fail(400,'No active webhook endpoint with that id.');
   if(op==='remove'){ep.active=false;return reply(200,{restaurant_id:body.p_rid,endpoints:epList()});}
   server.deliveries.unshift({id:'d'+(++server.seq),endpointId:ep.id,event:'ping',attempts:0,next_attempt_at:'2026-09-30T09:06:00Z',delivered_at:null,last_status:null,last_error:null,created_at:'2026-09-30T09:06:00Z'});
   return reply(200,{restaurant_id:body.p_rid,id:ep.id,queued:'ping:x'});
  }
  if(op==='deliveries')return reply(200,{restaurant_id:body.p_rid,deliveries:server.deliveries.slice().sort((a,c)=>c.created_at.localeCompare(a.created_at))});
  return reply(200,{restaurant_id:body.p_rid,endpoints:epList()});
 };
 return server;
}

/* one dashboard load: store, growth rules, config, sync, restaurant-ops.js; credential: 'key', 'session' or 'demo' */
function boot({as='key',server=makeServer(),init=true}={}){
 const document=makeDom(),toasts=[],confirms=[],copied=[],local=new Map(as==='session'?[['aal.session',sessionFor('rami@mayda.com')]]:[]),session=new Map();
 let answer=true;
 const window={document,location:{pathname:'/dashboard.html',search:SEARCH+(as==='key'?'&k='+OWNER_KEY:''),origin:'https://aalayna.com',href:'https://aalayna.com/dashboard.html',reload(){}},
  history:{replaceState(s,t,url){window.location.search=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';}},
  localStorage:store(local),sessionStorage:store(session),navigator:{userAgent:'test',clipboard:{writeText:async v=>{copied.push(v);}}},crypto:require('node:crypto').webcrypto,
  addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getSelection:()=>({removeAllRanges(){},addRange(){}}),
  setInterval(){return 0;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},confirm:m=>{confirms.push(m);return answer;},
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,RegExp,Set,Map,fetch:server.fetch};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(code,name)=>vm.runInContext(code,ctx,{filename:name});
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'),'aalayna-store.js');
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'),'restaurant-growth.js');
 run(fs.readFileSync(path.join(root,'owner-metrics.js'),'utf8'),'owner-metrics.js');
 window.AalaynaConfig=as==='noconfig'?{}:{supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run(fs.readFileSync(path.join(root,'aalayna-sync.js'),'utf8'),'aalayna-sync.js');
 window.$=id=>document.getElementById(id);window.money=v=>'$'+Number(v).toFixed(2);window.toast=m=>toasts.push(m);
 run(fs.readFileSync(path.join(root,'restaurant-ops.js'),'utf8'),'restaurant-ops.js');
 const $=window.$;
 $('integrations-card').hidden=true;$('int-key-reveal').hidden=true;$('int-ep-reveal').hidden=true;$('int-ev-paid').checked=true;$('int-ev-closed').checked=true;   // as dashboard.html ships them
 if(init)run('opsIntegrationsInit()','init');
 const p={window,document,$,server,local,session,toasts,confirms,copied,a:window.Aalayna,run,
  card:()=>$('integrations-card'),shown:()=>!$('integrations-card').hidden,
  answer:v=>{answer=v;},
  /* the page opens the Team view: the card loads */
  open:async()=>{await p.run('opsIntegrationsOpen()');await flush();},
  ready:async()=>{if(p.a.sync&&p.a.sync.ready)await p.a.sync.ready;await flush();},
  calls:()=>server.calls.filter(c=>c.fn==='aal_integration'||c.fn==='aal_webhooks'),
  rpcs:()=>p.calls().map(c=>c.fn+':'+(c.body.op||'')),
  form:async(id)=>{await $(id).onsubmit({preventDefault(){}});await flush();},
  click:async(node,label)=>{button(node,label).click();await flush();}};
 return p;
}
async function liveOwner(o={}){const p=boot(o);await p.ready();return p;}

test('dashboard.html ships the card hidden, inside the Team view, with both events on and the vendor link',()=>{
 const card=html.slice(html.indexOf('id="integrations-card"'),html.indexOf('<!-- ==== T16 integrations: end'));
 assert.ok(card.length>500);
 assert.ok(html.indexOf('id="v-team"')<html.indexOf('id="integrations-card"')&&html.indexOf('id="integrations-card"')<html.indexOf('</main>'));
 assert.match(html.slice(html.indexOf('id="integrations-card"')-40,html.indexOf('id="integrations-card"')+120),/data-owner-only hidden>/);
 assert.match(card,/<input type="checkbox" id="int-ev-paid" checked>/);assert.match(card,/<input type="checkbox" id="int-ev-closed" checked>/);
 assert.match(card,/<a href="docs\/pos-integration\.md"[^>]*>Give this page to your POS vendor<\/a>/);
 assert.match(card,/id="int-key-reveal" role="status" hidden>/);assert.match(card,/id="int-ep-reveal" role="status" hidden>/);
 assert.match(card,/type="url"/);assert.match(card,/id="int-key-label"[^>]*maxlength="80"/);
 for(const id of ['int-keys','int-key-form','int-key-label','int-key-issue','int-key-reveal','int-endpoints','int-ep-form','int-ep-url','int-ev-paid','int-ev-closed','int-ep-add','int-ep-reveal','int-deliveries','int-dl-refresh','int-refresh-all'])
  assert.equal(html.split('id="'+id+'"').length,2,id+' exists once');
 assert.match(html,/restaurant-ops\.js\?v=13"/);assert.match(html,/restaurant-ops\.css\?v=8"/);
 assert.match(html,/if \(v === 'team' && window\.opsIntegrationsOpen\) opsIntegrationsOpen\(\)/);
 assert.match(html,/if \(window\.opsIntegrationsInit\) opsIntegrationsInit\(\)/);
 assert.ok(fs.readFileSync(path.join(root,'docs','pos-integration.md'),'utf8').length>0);
});

test('who sees the card: a live owner once the first read names the role; never the demo, a waiter, a manager or a wrong key',async()=>{
 // owner link: hidden until the first read, then shown
 const key=boot();assert.equal(key.shown(),false);await key.ready();assert.equal(key.shown(),true);
 // signed-in owner: the role is 'staff' until the read
 const owner=boot({as:'session'});assert.equal(owner.a.sync.state().role,'staff');assert.equal(owner.shown(),false);
 await owner.ready();assert.equal(owner.a.sync.state().role,'owner');assert.equal(owner.shown(),true);
 // a waiter and a manager (the server names a manager 'guest' in the snapshot) never see it
 for(const role of ['waiter','manager']){const p=boot({as:'session',server:makeServer({role})});await p.ready();assert.equal(p.shown(),false,role);await p.open();assert.deepEqual(p.calls(),[],role+': no integrations call');}
 // an owner link the server does not recognise: role becomes guest, card stays hidden
 const wrong=makeServer();wrong.ownerKey='own_'+'cd'.repeat(18);const fake=boot({server:wrong});
 await fake.ready();assert.equal(fake.shown(),false);await fake.open();assert.deepEqual(fake.calls(),[]);
 // the demo: no shared store, no card, no calls at all
 for(const as of ['demo','noconfig']){const demo=boot({as});await demo.ready();demo.run('opsIntegrationsOpen()');await flush();
  assert.equal(demo.a.demoMode(),true,as);assert.equal(demo.shown(),false,as);assert.equal(demo.server.calls.length,0,as);}
});

test('opening the Team view loads keys, endpoints and deliveries with the dashboard credential, for this venue',async()=>{
 for(const as of ['key','session']){
  const p=await liveOwner({as});await p.open();
  assert.deepEqual(p.rpcs(),['aal_integration:list','aal_webhooks:list','aal_webhooks:deliveries'],as);
  for(const c of p.calls()){
   assert.equal(c.rid,RID);assert.equal(c.headers.apikey,'public-anon');
   if(as==='key'){assert.equal(c.headers['x-aalayna-key'],OWNER_KEY);assert.equal(c.headers.Authorization,'Bearer public-anon');}
   else{assert.equal(c.headers.Authorization,'Bearer at-1');assert.equal(c.headers['x-aalayna-key'],undefined);}
  }
 }
});

test('loading and empty states, then a key list with label, hint, dates, last use and status',async()=>{
 const server=makeServer({keys:[{id:'k1',label:'Front till',hint:'pos_3f9c1a2b...',scopes:['pos'],created_at:'2026-09-12T10:30:00Z',last_used_at:'2026-09-29T21:14:00Z',revoked_at:null},
  {id:'k2',label:'Old till',hint:'pos_aabbccdd...',scopes:['pos'],created_at:'2026-08-01T10:00:00Z',last_used_at:null,revoked_at:'2026-09-01T08:00:00Z'}]});
 let release;server.gate=new Promise(r=>{release=r;});
 const p=await liveOwner({server});const opening=p.run('opsIntegrationsOpen()');await flush();
 assert.match(text(p.$('int-keys')),/Loading\.\.\./);assert.match(text(p.$('int-deliveries')),/Loading\.\.\./);
 release();await opening;await flush();
 const keys=text(p.$('int-keys'));
 assert.match(keys,/Front till/);assert.match(keys,/pos_3f9c1a2b\.\.\./);assert.match(keys,/Issued 12 Sept?, 13:30 Beirut/);assert.match(keys,/Last used 30 Sept?, 00:14 Beirut/);assert.match(keys,/Live/);
 assert.match(keys,/Old till[\s\S]*Never used[\s\S]*Revoked 1 Sept?, 11:00 Beirut/);
 assert.equal(buttons(p.$('int-keys')).filter(b=>b.textContent==='Revoke').length,1);   // only the live key
 assert.match(text(p.$('int-endpoints')),/No webhook endpoints yet/);assert.match(text(p.$('int-deliveries')),/No deliveries yet/);
 const empty=await liveOwner();await empty.open();
 assert.match(text(empty.$('int-keys')),/No keys yet\. Issue one when your POS vendor is ready\./);
});

test('issue: a label is required; the plain key shows once with its sentence and a Copy button, the list refreshes, and nothing keeps the key',async()=>{
 const p=await liveOwner();await p.open();
 p.$('int-key-label').value='   ';await p.form('int-key-form');
 assert.equal(p.rpcs().filter(x=>x==='aal_integration:issue').length,0);assert.match(p.toasts.at(-1),/label/);
 p.$('int-key-label').value='  Front till ';await p.form('int-key-form');
 const issue=p.calls().filter(c=>c.body.op==='issue');assert.equal(issue.length,1);assert.deepEqual(issue[0].body,{op:'issue',label:'Front till'});
 const key=p.server.keys[0],shown=text(p.$('int-key-reveal'));
 assert.equal(p.$('int-key-reveal').hidden,false);
 const plain=walk(p.$('int-key-reveal')).find(n=>/^pos_[0-9a-f]{64}$/.test(n.textContent));assert.ok(plain,'the plain key is in the box');
 assert.match(shown,/Copy it now\. It is shown once and never again\./);
 assert.ok(buttons(p.$('int-key-reveal')).some(b=>b.textContent==='Copy'));
 assert.match(text(p.$('int-keys')),/Front till/);assert.match(text(p.$('int-keys')),new RegExp(key.hint.replace('.','\\.')));   // the list shows the hint, not the key
 assert.equal(text(p.$('int-keys')).includes(plain.textContent),false);
 assert.equal(p.$('int-key-label').value,'');
 // Copy hands exactly that key to the clipboard
 const secret=plain.textContent;await p.click(p.$('int-key-reveal'),'Copy');assert.deepEqual(p.copied,[secret]);assert.equal(p.toasts.at(-1),'Copied.');
 // it is nowhere in storage, in the toasts or in the page's other text
 const everywhere=()=>[...p.local.values(),...p.session.values(),...p.toasts,text(p.$('int-keys')),text(p.$('int-endpoints')),text(p.$('int-deliveries')),text(p.card())].join('\n');
 assert.equal(everywhere().includes(secret),false);
 // a refresh does not disturb the box; closing it removes the key from the DOM
 p.$('int-refresh-all').click();await flush();assert.equal(p.$('int-key-reveal').hidden,false);
 await p.click(p.$('int-key-reveal'),'I have copied it');
 assert.equal(p.$('int-key-reveal').hidden,true);assert.equal(p.$('int-key-reveal').children.length,0);
 assert.equal(walk(p.$('int-key-reveal')).some(n=>(n.textContent||'').includes(secret)),false);
 await p.open();assert.equal(everywhere().includes(secret),false);
 assert.equal(walk(p.card()).some(n=>(n.textContent||'').indexOf(secret)>=0),false);
 // the clipboard fallback (no async clipboard) copies through the selection
 p.window.navigator.clipboard=undefined;p.$('int-key-label').value='Back till';await p.form('int-key-form');
 await p.click(p.$('int-key-reveal'),'Copy');assert.equal(p.toasts.at(-1),'Copied.');
});

test('revoke: asks first, sends the key id, and the row turns Revoked',async()=>{
 const p=await liveOwner({server:makeServer({keys:[{id:'k7',label:'Front till',hint:'pos_3f9c1a2b...',scopes:['pos'],created_at:'2026-09-12T10:30:00Z',last_used_at:null,revoked_at:null}]})});
 await p.open();
 p.answer(false);await p.click(p.$('int-keys'),'Revoke');
 assert.equal(p.rpcs().includes('aal_integration:revoke'),false);assert.match(p.confirms.at(-1),/Front till/);
 p.answer(true);await p.click(p.$('int-keys'),'Revoke');
 const call=p.calls().find(c=>c.body.op==='revoke');assert.deepEqual(call.body,{op:'revoke',id:'k7'});
 assert.match(text(p.$('int-keys')),/Revoked/);assert.equal(buttons(p.$('int-keys')).length,0);
 assert.equal(p.toasts.at(-1),'Key revoked.');
});

test('add endpoint: https and a host name only, at least one event; the secret shows once with its sentence',async()=>{
 const p=await liveOwner();await p.open();const before=p.calls().length;
 for(const bad of ['','http://pos.example.com/hook','pos.example.com','https://localhost/hook','https://','ftp://pos.example.com']){
  p.$('int-ep-url').value=bad;await p.form('int-ep-form');
  assert.match(p.toasts.at(-1),/https:\/\//,bad);
 }
 assert.equal(p.calls().length,before,'nothing was sent for a bad address');
 p.$('int-ep-url').value='https://pos.example.com/aalayna';p.$('int-ev-paid').checked=false;p.$('int-ev-closed').checked=false;await p.form('int-ep-form');
 assert.match(p.toasts.at(-1),/at least one event/);assert.equal(p.calls().length,before);
 p.$('int-ev-paid').checked=true;p.$('int-ev-closed').checked=true;p.$('int-ep-url').value='  https://pos.example.com/aalayna ';await p.form('int-ep-form');
 const add=p.calls().find(c=>c.body.op==='add');assert.deepEqual(add.body,{op:'add',url:'https://pos.example.com/aalayna',events:['bill.paid','bill.closed']});
 const box=p.$('int-ep-reveal'),secretNode=walk(box).find(n=>/^whsec_[0-9a-f]{64}$/.test(n.textContent));assert.ok(secretNode,'the secret is in the box');
 assert.match(text(box),/Copy it now\. It is shown once and never again\./);assert.match(text(box),/Give this secret to the POS vendor; it signs every delivery\./);
 assert.match(text(p.$('int-endpoints')),/https:\/\/pos\.example\.com\/aalayna/);assert.match(text(p.$('int-endpoints')),/bill\.paid, bill\.closed/);assert.match(text(p.$('int-endpoints')),/Active/);
 const secret=secretNode.textContent;assert.equal(text(p.$('int-endpoints')).includes(secret),false);
 await p.click(box,'Copy');assert.deepEqual(p.copied,[secret]);
 await p.click(box,'I have copied it');
 assert.equal(box.hidden,true);assert.equal(walk(p.card()).some(n=>(n.textContent||'').includes(secret)),false);
 assert.equal([...p.local.values(),...p.session.values(),...p.toasts].join('\n').includes(secret),false);
 // one event only
 p.$('int-ev-closed').checked=false;p.$('int-ep-url').value='https://pos2.example.com/hook';await p.form('int-ep-form');
 assert.deepEqual(p.calls().filter(c=>c.body.op==='add').at(-1).body.events,['bill.paid']);
});

test('send a test queues a ping and refreshes deliveries; remove asks first, then the endpoint reads Removed',async()=>{
 const p=await liveOwner({server:makeServer({endpoints:[{id:'e1',url:'https://pos.example.com/aalayna',events:['bill.paid','bill.closed'],active:true,created_at:'2026-09-30T08:00:00Z'}]})});
 await p.open();
 assert.match(text(p.$('int-deliveries')),/No deliveries yet/);
 await p.click(p.$('int-endpoints'),'Send a test');
 assert.deepEqual(p.calls().find(c=>c.body.op==='test').body,{op:'test',id:'e1'});
 assert.match(p.toasts.at(-1),/Test queued/);
 assert.equal(p.rpcs().at(-1),'aal_webhooks:deliveries');
 assert.match(text(p.$('int-deliveries')),/ping[\s\S]*Queued[\s\S]*https:\/\/pos\.example\.com\/aalayna/);
 p.answer(false);await p.click(p.$('int-endpoints'),'Remove');assert.equal(p.calls().some(c=>c.body.op==='remove'),false);assert.match(p.confirms.at(-1),/pos\.example\.com/);
 p.answer(true);await p.click(p.$('int-endpoints'),'Remove');
 assert.deepEqual(p.calls().find(c=>c.body.op==='remove').body,{op:'remove',id:'e1'});
 assert.match(text(p.$('int-endpoints')),/Removed/);assert.equal(buttons(p.$('int-endpoints')).length,0);
 assert.equal(p.toasts.some(m=>m==='Endpoint removed.'),true);
 // the delivery still names its endpoint after removal
 assert.match(text(p.$('int-deliveries')),/https:\/\/pos\.example\.com\/aalayna/);
});

test('deliveries: delivered, retrying with its next attempt, and failed after N, newest first, in Beirut time; Refresh reloads',async()=>{
 const ep={id:'e1',url:'https://pos.example.com/aalayna',events:['bill.paid'],active:true,created_at:'2026-09-30T08:00:00Z'};
 const server=makeServer({endpoints:[ep],deliveries:[
  {id:'d1',endpointId:'e1',event:'bill.paid',attempts:1,next_attempt_at:null,delivered_at:'2026-09-30T18:14:03Z',last_status:200,last_error:null,created_at:'2026-09-30T18:14:00Z'},
  {id:'d2',endpointId:'e1',event:'bill.closed',attempts:2,next_attempt_at:'2026-09-30T20:30:00Z',delivered_at:null,last_status:502,last_error:'HTTP 502',created_at:'2026-09-30T19:00:00Z'},
  {id:'d3',endpointId:'e1',event:'bill.paid',attempts:8,next_attempt_at:null,delivered_at:null,last_status:null,last_error:'timeout after 10 s',created_at:'2026-09-29T12:00:00Z'}]});
 const p=await liveOwner({server});await p.open();
 const rows=p.$('int-deliveries').children.map(text);assert.equal(rows.length,3);
 assert.match(rows[0],/bill\.closed/);assert.match(rows[1],/bill\.paid/);assert.match(rows[2],/bill\.paid/);   // newest first
 assert.match(rows[0],/Retrying/);assert.match(rows[0],/Attempt 2 failed\. Next attempt 30 Sept?, 23:30 Beirut/);assert.match(rows[0],/HTTP 502/);assert.equal((rows[0].match(/HTTP 502/g)||[]).length,1);   // the status is not repeated when the error already says it
 
 assert.match(rows[1],/Delivered/);assert.match(rows[1],/Delivered 30 Sept?, 21:14 Beirut/);assert.match(rows[1],/HTTP 200/);
 assert.match(rows[2],/Failed after 8 attempts/);assert.match(rows[2],/timeout after 10 s/);
 for(const r of rows)assert.match(r,/https:\/\/pos\.example\.com\/aalayna/);
 const before=p.calls().length;
 // the deliveries Refresh is wired to the reload of deliveries only
 p.server.deliveries.push({id:'d4',endpointId:'e1',event:'ping',attempts:1,next_attempt_at:null,delivered_at:'2026-09-30T22:00:00Z',last_status:204,last_error:null,created_at:'2026-09-30T22:00:00Z'});
 await p.$('int-dl-refresh').onclick();await flush();
 assert.equal(p.$('int-deliveries').children.length,4);assert.match(text(p.$('int-deliveries').children[0]),/ping/);
 assert.equal(p.calls().slice(before).filter(c=>c.body.op==='deliveries').length>=1,true);
 assert.equal(p.calls().slice(before).filter(c=>c.fn==='aal_integration').length,0);
});

test("errors show the server's own sentence in a toast: a refused owner call, the key cap, a bad address, a missing install, no connection",async()=>{
 // the cap
 const capped=await liveOwner({server:makeServer({keyCap:0})});await capped.open();
 capped.$('int-key-label').value='Till';await capped.form('int-key-form');
 assert.equal(capped.toasts.at(-1),'This restaurant already has 10 live POS keys. Revoke one first.');
 assert.equal(capped.$('int-key-reveal').hidden,true);assert.equal(capped.$('int-key-issue').disabled,false);   // the button is usable again
 // an address the client lets through and the server refuses
 capped.$('int-ep-url').value='https://10.0.0.1/hook';await capped.form('int-ep-form');
 assert.equal(capped.toasts.at(-1),'The webhook address must be https:// and a public host name.');
 assert.equal(capped.$('int-ep-reveal').hidden,true);
 // the server refuses the owner call (a stale role)
 const refused=await liveOwner();refused.server.refuse='Only the restaurant owner can manage POS keys.';await refused.open();
 assert.equal(refused.toasts.length,1);assert.equal(refused.toasts[0],'Only the restaurant owner can manage POS keys.');   // one toast for three failed reads
 assert.match(text(refused.$('int-keys')),/Could not load this/);
 refused.$('int-key-label').value='Till';await refused.form('int-key-form');assert.equal(refused.toasts.at(-1),'Only the restaurant owner can manage POS keys.');
 // the SQL is not installed
 const missing=await liveOwner();missing.server.missing=true;await missing.open();
 assert.match(missing.toasts[0],/Integrations are not installed on the shared store yet\. Run supabase\/integrations-2026-09-30\.sql\./);
 const signed=await liveOwner({as:'session'});signed.server.missing=true;await signed.open();
 assert.match(signed.toasts[0],/Integrations are not installed/);   // AalaynaAuth.rpc says "Staff sign-in"; the card says what is missing
 // no connection
 const down=await liveOwner();down.server.down=true;await down.open();
 assert.equal(down.toasts[0],'Could not reach the shared store. Check the connection and try again.');
 // a failed revoke or test keeps the list and shows the sentence
 const p=await liveOwner({server:makeServer({keys:[{id:'k1',label:'Till',hint:'pos_00000000...',scopes:['pos'],created_at:'2026-09-12T10:30:00Z',last_used_at:null,revoked_at:null}]})});
 await p.open();p.server.keys[0].revoked_at='2026-09-30T00:00:00Z';   // revoked elsewhere meanwhile
 await p.click(p.$('int-keys'),'Revoke');assert.equal(p.toasts.at(-1),'No live POS key with that id.');
});

test('the card and any unclosed key leave with the role: a sign-out or a role change hides the card and wipes the box',async()=>{
 const p=await liveOwner({as:'session'});await p.open();
 p.$('int-key-label').value='Till';await p.form('int-key-form');
 const secret=walk(p.$('int-key-reveal')).find(n=>/^pos_[0-9a-f]{64}$/.test(n.textContent)).textContent;
 assert.equal(p.shown(),true);
 p.server.role='waiter';await p.a.sync.pull();await flush();
 assert.equal(p.a.sync.state().role,'waiter');assert.equal(p.shown(),false);
 assert.equal(walk(p.card()).some(n=>(n.textContent||'').includes(secret)),false);assert.equal(p.$('int-key-reveal').hidden,true);
 assert.equal(p.$('int-keys').children.length,1);assert.match(text(p.$('int-keys')),/No keys yet/);   // lists wiped back to the empty state
});

test('the file is ES5 for the browser and the card adds no second credential path or storage',()=>{
 const src=fs.readFileSync(path.join(root,'restaurant-ops.js'),'utf8'),block=src.slice(src.indexOf('T16 Integrations panel: start'),src.indexOf('T16 Integrations panel: end'));
 assert.ok(block.length>2000);
 assert.equal(/=>|\blet\b|\bconst\b|\basync\b|\bawait\b|`/.test(block),false);
 assert.equal(/localStorage|sessionStorage|indexedDB/.test(block),false);
 assert.equal(/[—–]/.test(block),false);
});

test('a till payment (rail pos) reads "Paid at the till", with its method when the bridge recorded one',()=>{
 const p=boot({as:'demo'});
 const label=x=>p.run('opsRailLabel('+JSON.stringify(x)+')');
 assert.equal(label({rail:'pos'}),'Paid at the till');
 assert.equal(label({rail:'pos',method:'card'}),'Paid at the till (card)');
 assert.equal(label({rail:'pos',method:'cash'}),'Paid at the till (cash)');
 assert.equal(label({rail:'pos',method:'other'}),'Paid at the till (other)');
 assert.equal(label({rail:'pos',method:'<b>x</b>'}),'Paid at the till');   // only the three known methods are printed
 assert.equal(label({rail:'whish'}),'Whish Money');assert.equal(label({rail:'card',method:'cash'}),'Card');assert.equal(label({rail:'cash'}),'Cash');
 // the dashboard's payment list uses it, and its settlement statement has a till row that sums with the others
 assert.match(html,/\(opsRailLabel\(x\) \+ \(x\.rail === 'cash'/);
 assert.match(html,/id="r-pos"/);assert.match(html,/\$\('r-pos'\)\.textContent=money\(\(r\.pos\|\|0\)\/100\)/);
});

test('the till is a third share in Cash vs digital, a line in bill details, and a line under tips; without till payments nothing changes',()=>{
 const p=boot({as:'demo'}),$=p.$;
 const journey=(rails,shares)=>{
  p.window.Aalayna.eventMetrics=()=>Object.assign({window:{label:'Last 7 days'},neverOrdered:[],conversion:null,paidSessions:0,scans:0,repeatRate:null,repeatSessions:0,sessions:0,medianBillToPaymentMs:null,timedSessions:0,payments:0,identifiedPayments:0,captureRate:null,rails},shares);
  $('report-period').value='7';$('journey-metrics').replaceChildren();p.run('paintGuestJourney()');
  return $('journey-metrics').children.map(text).find(t=>/^Cash/.test(t));
 };
 // no till payments: the line reads exactly as before
 const before=journey({cash:2000,card:3000,whish:0,pos:0,other:0},{cashShare:0.4,digitalShare:0.6,tillShare:0});
 assert.match(before,/^Cash vs digital 40% \/ 60% Cash \$20\.00, digital \$30\.00 of \$50\.00 collected$/);
 assert.equal(/till/i.test(before),false);
 // with till payments: a third share, "At the till", and the amounts add up
 const after=journey({cash:1000,card:2000,whish:0,pos:2000,other:0},{cashShare:0.2,digitalShare:0.4,tillShare:0.4});
 assert.match(after,/^Cash, digital, at the till 20% \/ 40% \/ 40% Cash \$10\.00, digital \$20\.00, at the till \$20\.00 of \$50\.00 collected$/);
 assert.equal(/NaN/.test(after),false);
 // bill details: a till tender on a real bill reads "Paid at the till", a bill without one is unchanged
 const a=p.a,c1=a.openServiceCheck({table:3,total:40,lines:[]}),c2=a.openServiceCheck({table:4,total:10,lines:[]});
 const row=(id,checkId,rail,amount)=>({id,venueId:a.venueId(),checkId,table:3,rail,amount,tip:0,items:{},status:'confirmed',ts:'2026-09-30T10:00:00.000Z',confirmedAt:'2026-09-30T10:01:00.000Z'});
 a.util.rawWrite('aal.settle',[row('t1',c1.id,'pos',15),row('t2',c1.id,'cash',5),row('t3',c2.id,'cash',10)]);
 $('report-period').value='7';p.run('paintCheckBalances()');
 const details=$('check-balances').children.map(text).join('\n');
 assert.match(details,/Cash \$5\.00 · Whish \$0\.00 · Card \$0\.00 · Paid at the till \$15\.00 · Tips \$0\.00/);
 assert.match(details,/Cash \$10\.00 · Whish \$0\.00 · Card \$0\.00 · Tips \$0\.00/);   // no till: the same words as before
 assert.equal(/NaN|undefined/.test(details),false);
 // tips panel: dashboard.html's own paintTips, with the till line only above zero
 const src=html.slice(html.indexOf('function paintTips()'),html.indexOf('function payTip'));
 assert.ok(src.indexOf('Tips recorded at the till: ')>0);
 p.run(src);
 const tips=(till,owed=[])=>{p.window.Aalayna.tipsAtTill=()=>({amount:till});p.window.Aalayna.tipsOwed=()=>owed;p.window.document.createElement=(f=>t=>f(t))(p.document.createElement);p.run('paintTips()');return {hidden:$('tips-till').hidden,text:$('tips-till').textContent};};
 assert.deepEqual(tips(0),{hidden:true,text:''});
 assert.deepEqual(tips(7),{hidden:false,text:'Tips recorded at the till: $7.00'});
 assert.deepEqual(tips(0,[]),{hidden:true,text:''});
 assert.match(html,/<p class="cs" id="tips-till" hidden><\/p>/);
});
