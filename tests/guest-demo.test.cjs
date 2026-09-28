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

test('Vegetarian: no dish with meat, poultry, fish or seafood passes, whatever the ingredient is called',()=>{
 const p=boot(),veg=ing=>p.run('isVeg('+JSON.stringify({ing})+')');
 // every meat ingredient on the Mayda menu, and the ones other menus will bring
 ['veal','minced meat','ground meat','lean meat','raw meat','raw lamb','kabab','lamb','beef','chicken','lamb awarma',
  'kafta','soujouk','sausage','fish','tuna','grilled shrimp','calamari'].forEach(i=>assert.equal(veg(['onion',i]),false,i));
 // and nothing that only looks like it
 ['eggplant','eggs','cheese','butter','milk','yogurt','hummus','chickpeas','tahini','bread','spices','grape leaves','vegetables','bbq sauce']
  .forEach(i=>assert.equal(veg([i]),true,i));
 const mayda=JSON.parse(fs.readFileSync(path.join(root,'venues','mayda.json'),'utf8')).items,dish=n=>mayda.find(i=>i.name===n);
 ['Grilled Veal Filet','Kabab Halabi','Sambusek','Hummus Meat and Almond','Fried Stuffed Kebbeh'].forEach(n=>assert.equal(veg(dish(n).ing),false,n));
 ['Fattoush','Tabbouleh','Raheb Salad'].forEach(n=>assert.equal(veg(dish(n).ing),true,n));
});

test('Balat (?theme=balat): the cement-tile menu, its tiles in the brand colours, and nothing changes without it',()=>{
 const std=boot(),pal=b=>JSON.parse(JSON.stringify(std.run('Aalayna.balatPalette('+JSON.stringify(b)+')')));
 // the brand takes the place of the nearest of the four pigments; greys, black and white leave them
 const base={t:'#B5502C',o:'#D39B2A',s:'#6F9A83',i:'#24366B'};
 assert.deepEqual(pal(''),base);
 assert.deepEqual(pal('#2F6B4F'),{...base,s:'#2F6B4F'},'a green brand takes the sage');
 assert.deepEqual(pal('#1E40AF'),{...base,i:'#1E40AF'},'a blue brand takes the indigo');
 assert.deepEqual(pal('#C9414B'),{...base,t:'#C9414B'},'a red brand takes the terracotta');
 assert.deepEqual(pal('#E0B020'),{...base,o:'#E0B020'},'a yellow brand takes the ochre');
 ['#777777','#050505','#FAFAFA','nope'].forEach(b=>assert.deepEqual(pal(b),base,b));
 // without the theme: the standard menu, plain tabs and rows
 const isTile=e=>e&&/^tile k[0-5]\b/.test(e.className||'');
 const tabs=p=>p.$('cats').children.filter(c=>/\bcat\b/.test(c.className||'')),rows=p=>p.$('menuscroll').children.filter(c=>/^mi\b/.test(c.className||''));
 assert.equal(std.document.documentElement.classList.contains('theme-balat'),false);
 assert.ok(tabs(std).length&&tabs(std).every(c=>!c.children.some(isTile)),'standard tabs');
 assert.ok(rows(std).length&&rows(std).every(r=>!r.children.some(isTile)),'standard rows');
 // with it: every tab is a tile, every dish carries its section's tile, every section its Arabic name
 const p=boot({search:'?venue=Mayda&place=Lebanese+Grill&theme=balat'});
 assert.equal(p.document.documentElement.classList.contains('theme-balat'),true);
 assert.ok(tabs(p).length&&tabs(p).every(c=>isTile(c.children[0])),'every tab is a tile');
 assert.ok(rows(p).length&&rows(p).every(r=>isTile(r.children[0])&&/\bdish-tile\b/.test(r.children[0].className)),'every dish has its tile');
 const heads=p.$('menuscroll').children.filter(c=>c.className==='sect-h');
 assert.ok(heads.length&&heads.every(h=>h.children.some(c=>c.className==='sect-ar'&&c.lang==='ar'&&c.textContent)),'Arabic beside each section');
 // anything but a known theme is the standard menu
 assert.equal(boot({search:'?venue=Mayda&place=Lebanese+Grill&theme=%3Cb%3E'}).document.documentElement.classList.contains('theme-balat'),false);
 // the page draws the six tiles from the four pigments, and a table QR link keeps the theme
 for(let k=0;k<6;k++)assert.match(html,new RegExp('\\.theme-balat \\.tile\\.k'+k+'\\{background:[^}]*var\\(--tile-'));
 assert.match(html,/if \(v\.theme\) p\.set\('theme', v\.theme\);/);
 assert.match(fs.readFileSync(path.join(root,'qr.html'),'utf8'),/<option value="balat">Balat · Beirut cement tiles<\/option>[\s\S]*if \(th\) q\.push\('theme=' \+ encodeURIComponent\(th\)\);/);
});

test('Balat opens a dish in place, as the tile concept does: under its row, with its Arabic name, tags and calories; a second tap closes it',()=>{
 const rows=p=>p.$('menuscroll').children.filter(c=>/^mi\b/.test(c.className||''));
 const dwell=p=>JSON.parse(JSON.stringify(p.run("Aalayna.events().filter(function(e){return e.eventType==='ui_action'&&e.payload.action==='dwell';}).map(function(e){return e.payload.value;})")));
 // the standard menu keeps its sheet
 const std=boot(),sr=rows(std)[0];
 assert.ok(!/class="mar"/.test(sr.innerHTML)&&!sr.classList.contains('has-alt'),'no second name without the theme');
 sr.onclick();assert.equal(std.$('ov-item').classList.contains('on'),true,'the standard menu opens the sheet');
 // Balat: the row shows the Arabic name, and the tap opens the dish under the row, not the sheet
 const p=boot({search:'?venue=Mayda&place=Lebanese+Grill&theme=balat'}),rs=rows(p),[a,b]=rs,esc=x=>p.run('esc('+JSON.stringify(x)+')');
 const arN=m=>m.tr&&m.tr.ar&&m.tr.ar.n,named=rs.filter(r=>arN(r._m)),bare=rs.filter(r=>!arN(r._m));
 assert.ok(named.length>20&&named.every(r=>r.classList.contains('has-alt')&&r.innerHTML.includes('<div class="mar" lang="ar"><bdi>'+esc(arN(r._m))+'</bdi></div>')),'a dish with an Arabic name shows it under its own');
 assert.ok(bare.length&&bare.every(r=>!r.classList.contains('has-alt')&&!/class="mar"/.test(r.innerHTML)),'one without keeps its description line');
 assert.equal(a.getAttribute('aria-expanded'),'false');
 a.onclick();
 assert.equal(p.$('ov-item').classList.contains('on'),false,'no sheet');
 assert.ok(a.classList.contains('open'));assert.equal(a.getAttribute('aria-expanded'),'true');
 assert.equal(p.$('i-desc').textContent,p.run('descOf(curItem)'),'the description opens with the dish');
 assert.ok(p.$('i-ing').children.length>0,'its ingredients');
 const meta=p.$('i-meta').children;
 assert.ok(meta.some(c=>c.className==='kc'&&/^\d+ kcal$/.test(c.textContent)),'its calories');
 assert.ok(meta.every(c=>c.className==='kc'||(c.className==='tg'&&c.textContent==='Vegetarian')),'its tags');
 // the allergen line is a pigment rule on the paper, not a tinted box
 assert.equal(p.$('i-alrt').style.background,'transparent');
 assert.match(p.$('i-alrt').style.borderColor,/^var\(--(tile-t|tile-s|line)\)$/);
 // straight to the next dish: the first logs its dwell before the second takes its place
 b.onclick();
 assert.ok(!a.classList.contains('open')&&b.classList.contains('open'));assert.equal(a.getAttribute('aria-expanded'),'false');
 assert.deepEqual(dwell(p),[a._m.id]);
 b.onclick();
 assert.ok(!b.classList.contains('open'));assert.equal(b.getAttribute('aria-expanded'),'false');
 assert.deepEqual(dwell(p),[a._m.id,b._m.id]);
 // Escape (closeOv) closes it too, and a rebuild never leaves it open
 a.onclick();p.run("closeOv('ov-item')");assert.ok(!a.classList.contains('open'));
 a.onclick();p.run('buildMenu()');assert.ok(!a.classList.contains('open'));assert.equal(p.run('inlineRow'),null);
 // in Arabic the second line is the name the menu was written with
 p.run("setLang('ar')");
 const ar=rows(p).slice(-p.run('MENU.length'));          // the stub keeps earlier builds' children: the last build is the Arabic one
 assert.ok(ar.length&&ar.every(r=>/<div class="mn">/.test(r.innerHTML)));
 assert.ok(ar.filter(r=>arN(r._m)).length>10&&ar.filter(r=>arN(r._m)).every(r=>r.innerHTML.includes('<div class="mar"><bdi>'+esc(r._m.n)+'</bdi></div>')),'the original name under the Arabic');
 assert.ok(ar.filter(r=>!arN(r._m)).every(r=>!/class="mar"/.test(r.innerHTML)),'no second line when the Arabic is the original');
});

test('the landing keeps its two buttons at the foot of the screen, every "powered by" is the Aalayna wordmark, and Balat runs through the bill, payment and review',()=>{
 // the buttons: a sticky dock at the bottom of the landing, in both themes
 assert.match(html,/#v-land \.dock\{position:sticky;bottom:0;[^}]*margin-top:auto/);
 assert.ok(!/#v-land\{position:relative\}/.test(html),'the landing fills the screen');
 // the wordmark is the brand's own line logo, drawn once and used in each "powered by"
 const line=fs.readFileSync(path.join(root,'brand/svg/3layna/line.svg'),'utf8'),d=[...line.matchAll(/ d="([^"]+)"/g)].map(m=>m[1]);
 const sym=html.match(/<symbol id="aal-logo" viewBox="0 0 350 50">([\s\S]*?)<\/symbol>/);
 assert.ok(sym,'the sprite');assert.deepEqual([...sym[1].matchAll(/ d="([^"]+)"/g)].map(m=>m[1]),d,'the same paths as brand/svg/3layna/line.svg');
 const powered=[...html.matchAll(/<div class="powered[^"]*">([\s\S]*?)<\/div>/g)].map(m=>m[1]);
 assert.equal(powered.length,5);
 assert.ok(powered.every(x=>x.includes('<svg class="pw-logo" role="img" aria-label="Aalayna"><use href="#aal-logo"></use></svg>')),'the logo in each');
 assert.ok(!/<b>Aalayna<\/b>/.test(html),'no plain-text name left');
 // Balat: the bill docked as an ink bar, and the rest of the visit on the same paper, rules and type
 assert.match(html,/\.theme-balat #v-menu \.billpill\{left:0;right:0;bottom:0;transform:none;justify-content:space-between/);
 assert.match(html,/  #menuscroll\{padding-bottom:96px\}/);assert.ok(!/id="menuscroll" style=/.test(html));
 assert.match(html,/html\.theme-balat\{--surface:var\(--bone\);/);
 const square=html.match(/\.theme-balat :is\(([^)]*)\)\{border-radius:0\}/);
 assert.ok(square,'square corners');
 for(const c of ['.sheet','.receipt','.pays','.tipb','.seg','.share','.pay-breakdown','.cashnote','.chg','.rcpt','.mailin','.ta','.review-close'])assert.ok(square[1].split(',').includes(c),c);
 const serif=html.match(/\.theme-balat :is\(([^)]*)\)\{font-family:'Gloock'/);
 for(const c of ['.b-title','.amt .big','.share .v','.shukran','.rc-amt'])assert.ok(serif&&serif[1].split(',').includes(c),c);
 // the thank-you screen gets its own row of tiles
 assert.match(html,/\[3, 1, 4, 0, 5, 2\]\.forEach\(function\(k\)\{ row\.appendChild\(tileEl\(k\)\); \}\);\s*inner\.prepend\(row\);/);
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

test('language and currency can be chosen on the landing screen, the place reads in the guest language, refusals are translated', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', 'guest.html'), 'utf8');
  const land = g.slice(g.indexOf('id="v-land"'), g.indexOf('id="v-menu"'));
  assert.match(land, /<select id="langsel-land" onchange="setLang\(this\.value\)"/);
  assert.match(land, /<select id="ccysel-land" onchange="setCcy\(this\.value\)"/);
  assert.match(g, /\$\('langsel'\)\.value = \$\('langsel-land'\)\.value = LANG;/);
  assert.match(g, /function venuePlace\(v\)\{ return \(LANG !== 'en' && v\.placeTr && v\.placeTr\[LANG\]\) \|\| v\.place \|\| ''; \}/);
  assert.doesNotMatch(g, /alert\(error\.message\)|textContent = error\.message/, 'store refusals go through errText');
  const store = fs.readFileSync(path.join(__dirname, '..', 'aalayna-store.js'), 'utf8');
  assert.match(store, /q\.get\('place_' \+ l\)/);
});
