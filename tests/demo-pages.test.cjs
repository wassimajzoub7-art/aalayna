/* The sales demo pages (system.html, dashboard.html, editor.html, admin.html, pitch.html, qr.html)
   carry Aalayna's own brand and the fictional demo restaurant, Mayda: the Block logo instead of the old
   wordmark, Saira and no Amiri, a favicon, noindex, no real restaurant in the copy. system.html opens
   the demo with menu=mayda and demo=1 and does not list the internal admin. With demo=1 the dashboard
   and the editor open straight into the demo; a real venue (a key or a staff session) keeps its sign-in. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const PAGES=['system.html','dashboard.html','editor.html','admin.html','pitch.html','qr.html'];

test('every demo page carries the brand: Block logo, Saira, favicon, noindex, no old wordmark or Amiri',()=>{
 for(const page of PAGES){
  const html=read(page);
  assert.ok(!/aalay<b>na/i.test(html),page+' has no old wordmark');
  assert.ok(!/Amiri/.test(html),page+' does not load Amiri');
  assert.ok(!/IBM\+Plex|IBM Plex/.test(html),page+' does not load IBM Plex');
  assert.match(html,/family=Saira:/,page+' loads Saira');
  assert.match(html,/family=[^"]*Kode\+Mono/,page+' loads Kode Mono');
  assert.match(html,/<meta name="robots" content="noindex">/,page+' is noindex');
  assert.ok(html.includes('<link rel="icon" href="brand/icons/icon-32.png" sizes="32x32">'),page+' has the PNG favicon');
  assert.ok(html.includes('<link rel="icon" href="brand/svg/3layna/icon.svg" type="image/svg+xml">'),page+' has the SVG favicon');
  assert.match(html,/<path class="logo-ink" d="M/,page+' draws the logo inline');
  assert.match(html,/<path class="logo-red" d="M0 0L50 0L50 50/,page+' draws the red 3');
 }
});

test('no real restaurant is named on the demo pages',()=>{
 for(const page of PAGES){
  const html=read(page);
  for(const word of ['Hallab','1881','Tripoli','Kababji','kababji','Kasr El Helou','Knefeh','Baklava'])
   assert.ok(!html.includes(word),page+' does not mention '+word);
 }
});

test('system.html: the Mayda demo with demo=1, no admin link, honest pitch copy',()=>{
 const html=read('system.html');
 assert.match(html,/Demo · Mayda/);
 const links=[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replace(/&amp;/g,'&'));
 const Q='menu=mayda&venue=Mayda&place=Lebanese%20Grill&place_fr=Grillades%20libanaises&place_ar=%D9%85%D8%B4%D8%A7%D9%88%D9%8A%20%D9%84%D8%A8%D9%86%D8%A7%D9%86%D9%8A%D8%A9&brand=%232F6B4F&bg=%23F5F1EA&font=Montserrat';
 for(const page of ['guest.html','dashboard.html','editor.html']){
  const l=links.find(x=>x.startsWith(page+'?'));
  assert.ok(l,'links '+page);
  assert.ok(l.startsWith(page+'?'+Q),page+' opens the Mayda demo: '+l);
  if(page!=='guest.html')assert.ok(/[?&]demo=1(&|$)/.test(l),page+' skips the sign-in');
 }
 assert.ok(!links.some(l=>/admin\.html/.test(l)),'no link to the internal admin');
 assert.ok(!/nine diagnostic/i.test(html));
 const questions=(read('pitch.html').match(/<ul class="qs">([\s\S]*?)<\/ul>/)[1].match(/<li>/g)||[]).length;
 const words=['zero','one','two','three','four','five','six','seven','eight','nine'];
 assert.match(html,new RegExp('the '+words[questions]+' questions to open with'));
});

test('admin.html loads the same sync layer as the other staff pages',()=>{
 const v=p=>(read(p).match(/aalayna-sync\.js\?v=(\d+)/)||[])[1];
 assert.equal(v('admin.html'),v('dashboard.html'));
 assert.equal(v('admin.html'),v('editor.html'));
});

test('qr.html: Mayda defaults, the review flow as it works now, no em dash',()=>{
 const html=read('qr.html');
 assert.match(html,/id="f-name" value="Mayda"/);
 assert.ok(!/five stars|5-star/i.test(html));
 assert.match(html,/4 or 5 stars/);assert.match(html,/1 to 3 stars send a private note/);
 assert.ok(!/—|&mdash;/.test(html));
});

test('editor.html marks missing translations and never copies English into French or Arabic',()=>{
 const html=read('editor.html');
 assert.match(html,/Needs translation/);
 assert.ok(!/drafted automatically|Auto-draft|Draft all/i.test(html));
 assert.ok(!/edBuf\[l\]\.n\s*=\s*edBuf\.en\.n/.test(html)&&!/edBuf\[edLang\]\.n\s*=\s*edBuf\.en\.n/.test(html));
});

test('dashboard.html: no hard-coded Reviews badge',()=>{
 const html=read('dashboard.html');
 assert.ok(!/Reviews<span class="bg">\d/.test(html));
 assert.match(html,/id="reviews-badge" hidden/);
});

/* ---- the sign-in panel with demo=1: the real store, sync layer and each page's own sign-in script ---- */
function makeDom(){
 const byId=new Map();
 function el(id){
  const attrs={},kids=[];
  const node={id:id||'',style:{},dataset:{},textContent:'',innerHTML:'',value:'',href:'',disabled:false,hidden:false,children:kids,childNodes:kids,
   classList:{add(){},remove(){},toggle(){},contains:()=>false},
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
const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i]??null,get length(){return m.size;}});
function boot(page,search,local=new Map()){
 const document=makeDom(),calls=[],session=new Map();
 const fetch=async url=>{calls.push(url);return {ok:false,status:503,text:async()=>''};};
 const window={document,location:{pathname:'/'+page,search,origin:'https://aalayna.com',href:'https://aalayna.com/'+page+search,reload(){}},
  history:{replaceState(){}},localStorage:store(local),sessionStorage:store(session),navigator:{userAgent:'test'},crypto:require('node:crypto').webcrypto,
  addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),
  setInterval(){return 0;},clearInterval(){},setTimeout(){return 0;},clearTimeout(){},confirm:()=>true,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,RegExp,Set,Map,fetch};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=(f,code)=>vm.runInContext(code||read(f),ctx,{filename:f});
 run('aalayna-store.js');run('restaurant-growth.js');
 if(page==='dashboard.html')run('owner-metrics.js');
 window.AalaynaConfig={supabaseUrl:'https://mock.invalid',anonKey:'public-anon'};
 run('aalayna-sync.js');
 const gate=[...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(x=>x.indexOf('AalaynaAuth.gate(')>=0);
 run(page+'#sign-in',gate);
 return {$:id=>document.getElementById(id),session,calls};
}
const DEMO='?menu=mayda&venue=Mayda&place=Lebanese%20Grill&brand=%232F6B4F&bg=%23F5F1EA&font=Montserrat';

test('dashboard and editor: demo=1 goes straight into the demo; without it the panel shows',()=>{
 for(const page of ['dashboard.html','editor.html']){
  const d=boot(page,DEMO+'&demo=1');
  assert.equal(d.$('staff-gate').hidden,true,page+' skips the panel with demo=1');
  assert.equal(d.$('staff-bar-who').textContent,'Demo, not signed in');
  assert.equal(d.calls.length,0,'nothing leaves the browser');
  const plain=boot(page,DEMO);
  assert.equal(plain.$('staff-gate').hidden,false,page+' shows the panel without demo=1');
 }
});

test('demo=1 never skips the sign-in of a real venue (owner key in the link)',()=>{
 for(const page of ['dashboard.html','editor.html']){
  const k=boot(page,'?venue=Test%20Bistro&place=Achrafieh&k=own_'+'ab'.repeat(18)+'&demo=1');
  assert.equal(k.$('staff-gate').hidden,false,page+' keeps the panel for a keyed venue');
  assert.equal(k.$('staff-demo').hidden,true);
 }
});
