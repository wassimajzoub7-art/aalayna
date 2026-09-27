/* The guest app as it is shown on a sales demo (guest.html): a fictional restaurant only,
   every screen in English, French and Arabic from one string table, Arabic mirrored on
   the whole app, amounts in LBP when the guest picks it, reviews routed by the rating,
   and the offline worker (sw.js) it registers. The page runs as in the other guest tests
   (store, growth rules, table QR script and the page's own script) on a minimal DOM that
   keeps the attributes the page sets. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'guest.html'),'utf8');
const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const TQ=inline.find(s=>s.indexOf('var AalaynaTableQR')>=0),PAGE=inline.find(s=>s.indexOf('function loadMenu')>=0);
const I18N=html.slice(html.indexOf('/* i18n:start */'),html.indexOf('/* i18n:end */'));
const STR=(()=>{const c={};vm.createContext(c);vm.runInContext(I18N+';this.STR=STR;',c);return c.STR;})();

function makeDom(){
 const byId=new Map();
 function el(id){
  const cls=new Set(),kids=[],attrs={};
  return {id:id||'',style:{setProperty(){}},dataset:{},innerHTML:'',textContent:'',value:'',disabled:false,checked:false,hidden:false,children:kids,childNodes:kids,attrs,
   classList:{add:(...c)=>c.forEach(x=>cls.add(x)),remove:(...c)=>c.forEach(x=>cls.delete(x)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):!!f;on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
   appendChild(c){kids.push(c);return c;},append(...c){kids.push(...c);},prepend(...c){kids.unshift(...c);},insertBefore(c){kids.push(c);return c;},removeChild(c){return c;},remove(){},replaceChildren(){kids.length=0;},
   setAttribute(k,v){attrs[k]=String(v);},getAttribute(k){return k in attrs?attrs[k]:null;},removeAttribute(k){delete attrs[k];},hasAttribute(k){return k in attrs;},addEventListener(){},removeEventListener(){},
   querySelector:()=>el(),querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0,right:0,bottom:0}),getClientRects:()=>[],
   focus(){},blur(){},click(){},scrollTo(){},scrollIntoView(){},closest:()=>null,matches:()=>false,contains:()=>false,
   offsetWidth:0,offsetHeight:0,offsetLeft:0,offsetTop:0,scrollTop:0,scrollHeight:0,clientHeight:0,clientWidth:0,parentNode:null,parentElement:null,firstChild:null,lastChild:null,nextSibling:null};
 }
 const views=['v-land','v-menu','v-bill','v-settle','v-pay','v-done'];
 const document={visibilityState:'visible',cookie:'',readyState:'complete',title:'',
  getElementById:id=>{if(!byId.has(id))byId.set(id,el(id));return byId.get(id);},
  querySelector:()=>el(),querySelectorAll:s=>s==='.view'?views.map(id=>document.getElementById(id)):[],createElement:()=>el(),createTextNode:()=>el(),addEventListener(){},removeEventListener(){},
  body:el('body'),head:el('head'),documentElement:el('html'),activeElement:null};
 return document;
}
function boot({search='?venue=Mayda&place=Lebanese+Grill',language}={}){
 const store=m=>({getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;}});
 const timers=[],alerts=[],opened=[],document=makeDom(),session=new Map();
 const window={document,location:{pathname:'/guest.html',search,origin:'https://aalayna.com',href:'https://aalayna.com/guest.html'+search,replace(){}},
  history:{replaceState(){}},localStorage:store(new Map()),sessionStorage:store(session),crypto:require('node:crypto').webcrypto,
  navigator:{userAgent:'test',language,clipboard:{writeText(){}},onLine:true},
  addEventListener(){},removeEventListener(){},open:(...a)=>opened.push(a),
  requestAnimationFrame(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({getPropertyValue:()=>''}),
  setInterval(){return 0;},clearInterval(){},setTimeout(f){timers.push(f);return timers.length;},clearTimeout(){},
  scrollTo(){},alert(m){alerts.push(m);},prompt(){},confirm:()=>true,innerHeight:844,innerWidth:390,
  URLSearchParams,URL,Intl,Date,Math,JSON,Promise,console,Number,String,Array,Object,Error,TypeError,RegExp,Set,Map};
 window.window=window;window.self=window;
 const ctx=vm.createContext(window),run=code=>vm.runInContext(code,ctx);
 run(fs.readFileSync(path.join(root,'aalayna-store.js'),'utf8'));
 run(fs.readFileSync(path.join(root,'restaurant-growth.js'),'utf8'));
 run(TQ);run(PAGE);
 return {window,document,run,$:id=>document.getElementById(id),alerts,opened,session,timers:()=>{while(timers.length)timers.shift()();}};
}

test('guest.html names no real restaurant, place or payment provider',()=>{
 for(const word of ['Hallab','1881','Tripoli','Kasr El Helou','Riad El Solh','Kababji','areeba'])
  assert.ok(!html.toLowerCase().includes(word.toLowerCase()),word+' is in guest.html');
 assert.match(html,/<title>Mayda · Aalayna<\/title>/);
 assert.match(html,/Card payment &middot; simulated/);
});

test('one string table: every key exists in en, fr and ar, and each fills the same placeholders',()=>{
 const keys=Object.keys(STR.en);
 assert.ok(keys.length>150);
 for(const lang of ['fr','ar']){
  assert.deepEqual(Object.keys(STR[lang]).sort(),keys.slice().sort(),lang+' has the same keys as en');
  for(const k of keys){
   const vars=s=>(String(s).match(/\{\w+\}/g)||[]).sort().join();
   assert.equal(vars(STR[lang][k]),vars(STR.en[k]),lang+'.'+k+' placeholders');
   assert.ok(String(STR[lang][k]).trim(),lang+'.'+k+' is empty');
  }
 }
 // every key the page asks for exists
 const asked=new Set([...html.matchAll(/\bt\('([A-Za-z_]+)'[,)]/g)].map(m=>m[1]).concat([...html.matchAll(/data-i18n(?:-ph|-aria)?="([A-Za-z_]+)"/g)].map(m=>m[1])).concat([...html.matchAll(/data-i18n-html="([A-Za-z_]+)"/g)].map(m=>m[1]+'Html')));
 for(const k of asked)assert.ok(k in STR.en,'missing key '+k);
});

test('French typography: a narrow no-break space before : ; ? and !',()=>{
 for(const [k,s] of Object.entries(STR.fr)){
  const text=String(s).replace(/<[^>]*>/g,'');
  for(const m of text.matchAll(/[:;?!]/g))
   assert.equal(text[m.index-1],' ','fr.'+k+': "'+text.slice(Math.max(0,m.index-12),m.index+1)+'"');
 }
 // and never in English or Arabic
 for(const lang of ['en','ar'])for(const [k,s] of Object.entries(STR[lang]))assert.ok(!String(s).includes(' '),lang+'.'+k);
 // Arabic keeps Western digits, as the rest of the site does
 for(const [k,s] of Object.entries(STR.ar))assert.ok(!/[٠-٩]/.test(s),'ar.'+k);
});

test('Arabic mirrors the whole app, the language survives Start over, and ?lang= and the phone pick it',()=>{
 const p=boot({search:'?venue=Mayda&place=Lebanese+Grill&lang=ar'});
 assert.equal(p.run('LANG'),'ar');
 assert.equal(p.$('app').getAttribute('dir'),'rtl');assert.equal(p.$('app').getAttribute('lang'),'ar');
 assert.equal(p.document.title,'Mayda · Aalayna');
 assert.equal(p.$('pay-who').textContent,'المبلغ المطلوب · طاولة 12');
 assert.equal(p.$('rate-q').textContent,'كيف كانت سهرتك في Mayda؟');
 p.run('restart()');
 assert.equal(p.run('LANG'),'ar');assert.equal(p.$('app').getAttribute('dir'),'rtl');
 p.run("setLang('fr')");
 assert.equal(p.$('app').getAttribute('dir'),'ltr');assert.equal(p.session.get('aal.guest-lang'),'fr');
 assert.equal(p.$('tip-who').textContent.slice(-2),' ?');
 p.run('restart()');assert.equal(p.run('LANG'),'fr');
 // the phone's language when it is French or Arabic; English otherwise
 assert.equal(boot({language:'fr-LB'}).run('LANG'),'fr');
 assert.equal(boot({language:'ar'}).$('app').getAttribute('dir'),'rtl');
 assert.equal(boot({language:'de-DE'}).run('LANG'),'en');
});

test('LBP: every amount on the way to paying and on the receipt is in lira; the math stays in USD',async()=>{
 const p=boot();
 p.run("setCcy('lbp')");
 p.run("go('v-settle')");p.run("mode('even')");p.run("go('v-pay')");p.run("pick($('pm-cash'),'cash')");
 for(const id of ['sh-v','bigamt','pay-share','pay-tip','tv5','tv10','tv15','note-1','land-tot','pill-tot','r-tot'])
  assert.match(p.$(id).textContent,/^LL [\d,]+$/,id+': '+p.$(id).textContent);
 assert.match(p.$('bigll').textContent,/^≈ \$\d+\.\d\d$/);
 assert.match(p.$('chgout').innerHTML,/LL [\d,]+/);
 const share=p.run('share'),tip=p.run('tipAmt()');
 assert.equal(tip,Math.round(share*.1*100)/100);                        // 10% preselected, in USD
 // a note of LL 10,000,000 is handed over: the request is recorded in USD with the change owed
 p.run("setNote($('note-3'),noteValue(2))");
 p.run('settle()');await new Promise(r=>setImmediate(r));
 const rec=JSON.parse(JSON.stringify(p.run('Aalayna.settlements().slice(-1)[0]')));
 assert.equal(rec.rail,'cash');assert.equal(rec.amount,Math.round((share+tip)*100)/100);
 assert.ok(Math.abs(rec.note-10000000/p.run('RATE()'))<0.01);
 assert.match(p.$('rc-amt').textContent,/^LL [\d,]+$/);
 assert.match(p.$('rc-method').textContent,/^Cash · LL [\d,]+ change$/);
 // in Arabic the lira reads as on the Arabic homepage
 p.run("setLang('ar')");assert.match(p.$('rc-amt').textContent,/^[\d,]+ ل\.ل\.$/);
});

test('reviews are routed by the rating through Aalayna.reviewURL; the old one-panel-for-all note is gone',()=>{
 const code=html.slice(html.indexOf('/* Reviews are routed by the rating'),html.indexOf('function syncReceiptViewport(){'));
 assert.match(code,/Aalayna\.reviewURL\(\)/);
 assert.match(code,/n >= 4 \? 'google' : 'private'/);
 assert.ok(!/No rating-based/i.test(html));assert.ok(!/Every rating opens the same/.test(html));
 // on the page: 5 stars with a Google place opens it in a new tab; 2 stars stays private
 const p=boot({search:'?venue=Mayda&place=Lebanese+Grill&gplace=ChIJ0000000000000000000000'});
 const url=p.run('Aalayna.reviewURL()');
 p.run("go('v-settle')");p.run("go('v-pay')");p.run("pick($('pm-card'),'card')");p.run('settle()');
 p.run('cardConfirm()');p.timers();
 p.run('rate(5)');assert.equal(p.$('review-submit').textContent,'Review on Google');
 assert.match(url,/^https:\/\//);p.run('submitReview()');assert.deepEqual(p.opened.at(-1),[url,'_blank','noopener']);
 p.run('closeReview()');
 p.run('rate(2)');assert.equal(p.$('review-submit').textContent,'Send privately');assert.equal(p.$('review-note').hidden,false);
 p.$('review-text').value='Too loud';p.run('submitReview()');
 const ev=JSON.parse(JSON.stringify(p.run("Aalayna.events().filter(function(e){return e.eventType==='review_submitted';})")));
 assert.equal(ev.at(-1).payload.destination,'private');assert.equal(ev.at(-1).payload.comment,'Too loud');assert.equal(ev.at(-1).payload.rating,2);
});

test('sw.js exists, is published, and keeps the guest shell and menus with a versioned cache',()=>{
 const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
 assert.match(fs.readFileSync(path.join(root,'.gitignore'),'utf8'),/^!sw\.js$/m);
 assert.match(sw,/var VERSION = 'aal-guest-v\d+'/);
 assert.match(sw,/venues\\\/\[\^\/\]\+\\\.json/);          // menus: network first
 assert.match(sw,/networkFirst/);assert.match(sw,/cacheFirst/);
 assert.match(sw,/request\.method !== 'GET'/);
 for(const f of ['guest.html','aalayna-store.js','restaurant-growth.js','aalayna-sync.js'])assert.ok(sw.includes("'"+f+"'"),f);
 new vm.Script(sw);                                                     // it parses
 // the page registers it only over http(s), scoped to itself, and never breaks when it cannot
 assert.match(html,/'serviceWorker' in navigator && \/\^https\?:\$\/\.test\(location\.protocol\)/);
 assert.match(html,/register\('sw\.js', \{ scope: 'guest\.html', updateViaCache: 'none' \}\)\.catch/);
});
