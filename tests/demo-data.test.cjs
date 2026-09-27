/* The demo runs on Mayda, a fictional Lebanese grill (venues/mayda.json), never on a
   real restaurant's name, menu or prices. This checks the pack (translations,
   French typography, nutrition for the guest filters), the manifest, the store's
   default venue, the review link, and that the sample bill is priced from the menu. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const RAW=read('venues/mayda.json'),MAYDA=JSON.parse(RAW);
const REAL=/kababji|\bhallab\b|1881|tripoli|kasr el helou|riad el solh|كبابجي|حلاب|طرابلس/i;

function store(search=''){
 const map=new Map(),storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
 const window={location:{search},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams});
 for(const f of ['aalayna-store.js','restaurant-growth.js'])vm.runInContext(read(f),ctx);
 return window.Aalayna;
}
/* what ?menu=mayda does in the page, without fetch and reload */
function loadPack(a,m){const d=a.draft();d.sections=JSON.parse(JSON.stringify(m.sections));d.items=JSON.parse(JSON.stringify(m.items));a.saveDraft(d);a.publish();}
const plain=x=>JSON.parse(JSON.stringify(x));

test('venues/mayda.json is the fictional Mayda pack, with no trace of the real menu it replaced',()=>{
 assert.equal(MAYDA.name,'Mayda');
 assert.deepEqual(Object.keys(MAYDA),['name','sections','items']);
 assert.equal(MAYDA.items.length,75);assert.equal(MAYDA.sections.length,9);
 assert.doesNotMatch(RAW,REAL);
 assert.equal(fs.existsSync(path.join(root,'venues','kababji.json')),false);
 const ids=MAYDA.items.map(x=>x.id);assert.equal(new Set(ids).size,ids.length);
 const secs=new Set(MAYDA.sections.map(s=>s.id));
 for(const x of MAYDA.items){
  assert.ok(secs.has(x.sec),x.id+' section');
  assert.deepEqual(Object.keys(x),['id','sec','name','desc','price','ing','al','kcal','pr','ft','cb','tr','conf','opts'],x.id+' key order');
  assert.ok(typeof x.price==='number'&&x.price>0&&Math.round(x.price*100)===x.price*100,x.id+' price in cents');
  for(const g of x.opts)for(const c of g.choices)assert.equal(Math.round(c.p*100),c.p*100,x.id+' option price in cents');
 }
});

test('every section and dish has a French and an Arabic translation',()=>{
 const ar=/[؀-ۿ]/;
 for(const s of MAYDA.sections){
  assert.ok(s.tr&&s.tr.fr&&s.tr.fr.n.trim(),s.id+' fr');
  assert.ok(s.tr.ar&&ar.test(s.tr.ar.n),s.id+' ar');
 }
 for(const x of MAYDA.items){
  for(const f of ['n','d']){
   assert.ok(x.tr.fr[f]&&x.tr.fr[f].trim(),x.id+' fr.'+f);
   assert.ok(x.tr.ar[f]&&ar.test(x.tr.ar[f]),x.id+' ar.'+f);
  }
  assert.ok(x.name.trim()&&x.desc.trim(),x.id+' en');
 }
});

test('French strings put a narrow no-break space (U+202F) before : ; ? !',()=>{
 const fr=[...MAYDA.sections.map(s=>[s.id,s.tr.fr.n]),...MAYDA.items.flatMap(x=>[[x.id,x.tr.fr.n],[x.id,x.tr.fr.d]])];
 let seen=0;
 for(const [id,s] of fr){
  for(let i=0;i<s.length;i++)if(':;?!'.includes(s[i])){seen++;assert.equal(s[i-1],' ',id+': '+JSON.stringify(s));}
  assert.doesNotMatch(s,/[  ]+[:;?!]/,id);
  assert.doesNotMatch(s,/'/,id+' uses the typographic apostrophe');
 }
 assert.ok(seen>0,'at least one string exercises the rule');
});

test('enough dishes carry nutrition for the Under 400 kcal and High protein filters',()=>{
 /* the guest app's rules: kcal <= 400, protein >= 20 g */
 const light=MAYDA.items.filter(x=>x.kcal!=null&&x.kcal<=400),protein=MAYDA.items.filter(x=>x.pr!=null&&x.pr>=20);
 assert.ok(light.length>=15,'light '+light.length);assert.ok(protein.length>=15,'protein '+protein.length);
 assert.ok(light.filter(x=>x.pr>=20).length>=5,'light and high protein');
 for(const s of MAYDA.sections.filter(s=>s.id!=='bev'))assert.ok(light.some(x=>x.sec===s.id)||protein.some(x=>x.sec===s.id),s.name);
 assert.ok(MAYDA.items.every(x=>[x.kcal,x.pr,x.ft,x.cb].every(v=>typeof v==='number'&&v>=0)),'every dish has all four values');
});

test('venues/index.json lists Mayda and no real restaurant',()=>{
 const idx=JSON.parse(read('venues/index.json'));
 assert.deepEqual(idx.map(e=>e.slug),['mayda']);
 assert.equal(idx[0].name,'Mayda');assert.equal(idx[0].items,MAYDA.items.length);
 assert.doesNotMatch(read('venues/index.json'),REAL);
});

test('the store defaults to Mayda and names no real venue',()=>{
 const src=read('aalayna-store.js');
 assert.doesNotMatch(src,REAL);
 const v=plain(store().venue());
 assert.equal(v.name,'Mayda');assert.equal(v.place,'Lebanese Grill');assert.equal(v.heritage,0);assert.equal(v.est,'');
});

test('the sample bill takes every line price from the menu: $152.50 on the seed menu and on Mayda',()=>{
 for(const pack of [null,MAYDA]){
  const a=store();
  if(pack)loadPack(a,pack);
  const menu=a.published().items,lines=plain(a.check(12));
  assert.equal(lines.length,12);
  for(const l of lines){
   const x=menu.find(y=>y.id===l.id);assert.ok(x,l.id);
   assert.equal(Math.round(l.p*100),Math.round(x.price*100)*l.q,l.id+' line = quantity x menu price');
   assert.equal(l.name,x.name);
  }
  assert.equal(a.checkTotal(12),152.5,pack?'mayda':'seed');
 }
 /* a price change in the editor reaches the sample bill once published */
 const a=store();loadPack(a,MAYDA);
 const d=a.draft();d.items.find(x=>x.id==='i07').price=9.5;a.saveDraft(d);a.publish();
 assert.equal(plain(a.check(12)).find(l=>l.id==='i07').p,19);assert.equal(a.checkTotal(12),153.5);
 /* a dish the menu does not have is left off, not shown at a price the menu never had */
 const b=store();const e=b.draft();e.items=e.items.filter(x=>x.id!=='i16');b.saveDraft(e);
 const pub=b.published();pub.items=pub.items.filter(x=>x.id!=='i16');b.util.write('aal.live',pub);
 assert.equal(b.check(12).length,11);
});

test('reviewURL is the venue\'s own Google review link, or null when none is set',()=>{
 assert.equal(store().reviewURL(),null,'the fictional default venue has no listing');
 assert.equal(store('?venue=Mayda&place=Hamra').reviewURL(),null);
 assert.equal(store('?venue=Mayda&place=Hamra&gplace=ChIJN1t_tDeuEmsRUsoyG83frY4').reviewURL(),
  'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4');
 assert.equal(store('?venue=Mayda&gplace='+encodeURIComponent('https://g.page/r/CQx1ExAmPlE0EAE/review')).reviewURL(),'https://g.page/r/CQx1ExAmPlE0EAE/review');
 for(const bad of ['javascript:alert(1)','https://evil.example/review','short','ChIJ bad id'])
  assert.equal(store('?venue=Mayda&gplace='+encodeURIComponent(bad)).reviewURL(),null,bad);
 const a=store();a.setVenue({name:'Mayda',place:'Lebanese Grill',gplace:'ChIJN1t_tDeuEmsRUsoyG83frY4'});
 assert.match(a.reviewURL(),/placeid=ChIJN1t_tDeuEmsRUsoyG83frY4$/);
});
