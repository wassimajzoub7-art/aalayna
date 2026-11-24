/* The Insights tab: owner-insights.js (the rules, a pure function of events, menu and time),
   insights-demo.js (the demo's sample history) and insights-panel.js (the panel), with the
   dashboard wiring. Events are built by hand so every number in a sentence can be checked. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const DAY=86400000,MIN=60000;
const AT=Date.parse('2026-11-24T18:00:00Z');   // a Tuesday, 20:00 in Beirut

function setup(search=''){
 const map=new Map(),storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
 const window={location:{search},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Intl});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js','owner-insights.js','insights-demo.js'])vm.runInContext(read(f),ctx,{filename:f});
 return window.Aalayna;
}
const A=setup(),MENU=A.published();
const ITEMS=MENU.items,SECTIONS=MENU.sections;
/* an event log builder: sessions at a time, on a table, from a phone */
function log(){
 const events=[];let n=0;
 const ev=(type,t,s,payload)=>{events.push({eventId:'e'+(++n),eventType:type,createdAt:new Date(t).toISOString(),sessionId:s.id,deviceId:s.device,tableId:s.table==null?null:String(s.table),restaurantId:'r',payload:payload||{}});};
 const session=(t,{table=1,device}={})=>{const s={id:'s'+(++n),device:device||'d'+n,table};ev('qr_scan',t,s,{tableId:String(table)});return s;};
 return {events,ev,session};
}
const run=(events,extra={})=>A.computeInsights(Object.assign({events,items:ITEMS,sections:SECTIONS,at:AT},extra));
const plain=x=>JSON.parse(JSON.stringify(x));
const find=(r,prefix)=>r.insights.find(i=>i.id.indexOf(prefix)===0);
const waiting=(r,id)=>r.waiting.find(w=>w.id===id);

/* the steak case: Mixed Grill (i07) opened 40 times, on 5 bills; other dishes reach bills at their usual pace */
function steak({opens=40,bills=5,lines=true,start=AT-20*DAY}={}){
 const L=log();
 for(let k=0;k<60;k++){
  const t=start+k*6*3600000,s=L.session(t,{table:1+k%6});
  if(k<opens)L.ev('item_view',t+MIN,s,{itemId:'i07'});
  for(const id of ['i05','i06','i13'])if(k%2===0)L.ev('item_view',t+2*MIN,s,{itemId:id});
  const items=[];
  if(k<bills)items.push({itemId:'i07',qty:1});
  for(const id of ['i05','i06','i13'])if(k%2===0&&k%4===0)items.push({itemId:id,qty:1});
  L.ev('order_placed',t+5*MIN,s,{orderId:'o'+k,revision:1,items:lines?items:[],total:20});
 }
 return L;
}

test('the steak case: opened 40 times, on 5 bills, said in a sentence with its numbers and an action',()=>{
 const r=run(steak().events),f=find(r,'dish-low:i07');
 assert.ok(f,'the rule fires');
 assert.match(f.text,/^Mixed Grill platter was opened 40 times \(in 40 sessions\) but is on only 5 bills\./);
 assert.match(f.text,/A typical dish is on about 5 bills for every 10 opens; this one on 1\.3\./);
 assert.match(f.action,/photo.*description.*price/);
 assert.equal(f.family,'dishes');assert.equal(r.insights[0].id,f.id,'ranked first');
 assert.match(f.rule,/at least 20 times/);
});

test('a dish claim needs 20 opens: 19 waits, and the tab says what it needs and has',()=>{
 assert.equal(find(run(steak({opens:19,bills:1}).events),'dish-low:i07'),undefined);
 const L=log();for(let k=0;k<19;k++){const s=L.session(AT-DAY+k*MIN);L.ev('item_view',AT-DAY+k*MIN+1,s,{itemId:'i07'});L.ev('order_placed',AT-DAY+k*MIN+2,s,{orderId:'o'+k,revision:1,items:[{itemId:'i06',qty:1}]});}
 const r=run(L.events);
 assert.equal(find(r,'dish-low'),undefined);
 assert.deepEqual(plain(waiting(r,'dish-low')),{id:'dish-low',family:'dishes',label:'Dishes guests look at but rarely order',need:'a dish opened 20 times',have:'the most-opened dish has 19'});
 assert.ok(find(run(steak({opens:20,bills:1}).events),'dish-low:i07'));
 assert.equal(A.INSIGHT_MIN.dishOpens,20);
});

test('"ordered" is a bill line on the latest revision of each bill only',()=>{
 const L=steak({bills:0}),s={id:'sx',device:'dx',table:3};
 // five more bills that once had the grill and lost it in their second revision
 for(let k=0;k<5;k++){L.ev('order_placed',AT-DAY+k*MIN,s,{orderId:'rev'+k,revision:1,items:[{itemId:'i07',qty:1}]});L.ev('order_placed',AT-DAY+k*MIN+1000,s,{orderId:'rev'+k,revision:2,items:[{itemId:'i06',qty:1}]});}
 const r=run(L.events),d=r.tables.dishes.find(x=>x.itemId==='i07');
 assert.equal(d.onBills,0);assert.match(find(r,'dish-low:i07').text,/is on no bill/);
});

test('bills without dish lines: the view-side insights only, and the tab says plainly why',()=>{
 const L=steak({lines:false});
 for(let k=0;k<40;k++)L.ev('item_view',AT-DAY+k*MIN,{id:'v'+k,device:'v'+k,table:2},{itemId:['i01','i02','i03'][k%3]});
 const r=run(L.events);
 assert.equal(r.hasLines,false);
 assert.match(r.orderNote,/^The 60 bills in this period arrived as totals only, without dish lines/);
 assert.match(r.orderNote,/cannot say which dishes were ordered/);
 assert.equal(r.insights.filter(i=>/^(dish-low|dish-staple|section)/.test(i.id)).length,0);
 assert.equal(waiting(r,'dish-low').need,'bills with dish lines');
 const unopened=find(r,'dish-unopened');assert.ok(unopened,'view-side: dishes nobody opened still shows');
 assert.doesNotMatch(unopened.text,/bill/);
 const none=run(steak({bills:0}).events.filter(e=>e.eventType!=='order_placed'));
 assert.match(none.orderNote,/^No bills were recorded in this period/);
});

test('the reverse case, dishes nobody opens, reading time and options',()=>{
 const L=steak();
 // the egg awarma: on 30 bills, opened 3 times
 for(let k=0;k<30;k++){const s=L.session(AT-2*DAY+k*MIN,{table:2});if(k<3)L.ev('item_view',AT-2*DAY+k*MIN+1000,s,{itemId:'i02'});L.ev('order_placed',AT-2*DAY+k*MIN+2000,s,{orderId:'h'+k,revision:1,items:[{itemId:'i02',qty:1}]});}
 // the latte: opened, oat milk picked in 12 sessions, read for long
 for(let k=0;k<14;k++){const t=AT-3*DAY+k*MIN,s=L.session(t,{table:4});L.ev('item_view',t+1000,s,{itemId:'i17'});if(k<12)L.ev('ui_action',t+2000,s,{action:'option',value:'Milk:Oat milk'});L.ev('ui_action',t+3000,s,{action:'option',value:'Milk:Fresh cow milk'});L.ev('ui_action',t+40000,s,{action:'dwell',value:'i17',n:40});}
 for(const id of ['i05','i06','i13'])for(let k=0;k<10;k++)L.ev('ui_action',AT-DAY+k,{id:'w'+id+k,device:'w',table:1},{action:'dwell',value:id,n:8});
 const r=run(L.events);
 const staple=find(r,'dish-staple:i02');assert.match(staple.text,/^Egg Awarma is on 30 bills but was opened only 3 times\. Guests order it without reading about it/);
 const none=find(r,'dish-unopened');assert.match(none.text,/were not opened once in 30 days, and none is on a bill, while guests opened dishes \d+ times\./);
 assert.match(none.text,/Foul & Hummus plate/);
 const opt=find(r,'option:i17');assert.equal(opt.text,'Oat milk (Milk, Latte) is the most-picked option: 12 of the 14 sessions that opened Latte chose it (86%). It adds $0.75.');
 assert.ok(!r.tables.options.some(o=>o.choice==='Fresh cow milk'),'the default choice does not count');
 const dw=find(r,'dish-dwell:i17');assert.match(dw.text,/^Guests spend 40 s on Latte on average \(14 timed reads\), against 8 s for a typical dish/);
});

test('diet demand against offer: share of sessions per filter and the dishes that fit, with the guest page swap rule',()=>{
 const L=log();
 for(let k=0;k<50;k++){const s=L.session(AT-5*DAY+k*MIN);if(k<9)L.ev('ui_action',AT-5*DAY+k*MIN+1,s,{action:'filter',value:'protein:on'});if(k<3)L.ev('ui_action',AT-5*DAY+k*MIN+2,s,{action:'filter',value:'veg:on'});}
 const r=run(L.events),gap=find(r,'diet-gap:protein');
 assert.equal(gap.text,"18% of sessions (9 of 50) turned on the High protein filter, and 4 of your 17 dishes fit it: Egg Awarma, Lahm b'Ajin · 4 pieces, Mixed Grill platter and Arayes.");
 assert.equal(find(r,'diet-gap:veg'),undefined,'3 sessions: under the 5-session minimum');
 // the latte is dairy-free with oat milk: the guest page offers that swap, so it fits No dairy
 const latte=ITEMS.find(x=>x.id==='i17');assert.equal(A.dietFits(latte,'nodairy'),true);assert.equal(A.dietFits(ITEMS.find(x=>x.id==='i02'),'nodairy'),false);
 assert.equal(A.dietFits(ITEMS.find(x=>x.id==='i07'),'veg'),false);
 assert.equal(r.tables.filters.find(f=>f.key==='protein').uses,9);
 const few=run(L.events.slice(0,25));assert.ok(waiting(few,'diet'),'fewer than 30 menu sessions: waiting');
});

test('time and traffic in Beirut time: busiest weekday averaged per weekday, peak hour, quiet table, slow-paying table',()=>{
 const L=log();
 for(let d=1;d<=28;d++){
  const day=AT-d*DAY,dow=new Date(day+2*3600000).getUTCDay();   // Beirut date at 20:00
  const count=dow===5?6:2;
  for(let k=0;k<count;k++){
   const t=day+k*MIN,table=1+(d*3+k)%5,s=L.session(t,{table});   // tables 1-5; table 6 listed, never scanned
   L.ev('bill_requested',t+30*MIN,s);L.ev('payment_completed',t+30*MIN+(table===5?12:3)*MIN,s,{orderId:'b'+d+k,amount:20,amountUsd:20,tip:0,rail:'card',currency:'USD'});
  }
 }
 const r=run(L.events,{tables:['1','2','3','4','5','6']});
 const tr=find(r,'traffic');
 assert.match(tr.text,/^An average Friday brings 6 sessions, against 2\.6 on an average day; Mondays are the quietest, at 2\. The busiest hour is 20:00 to 21:00 Beirut time, with 100% of sessions\.$/);
 assert.deepEqual(plain(r.tables.byWeekday),[2,2,2,2,6,2,2]);
 assert.match(find(r,'tables-low').text,/^Table 6 had no scan in 30 days; a typical table had \d+\./);
 const pay=find(r,'pay-time');assert.match(pay.text,/^Half of the tables paid within 3:00/);
 const slow=find(r,'pay-slow:5');assert.match(slow.text,/^Table 5 takes 12:00 from bill to paid \(the median of \d+ sessions\), against 3:00 across the room\.$/);
 // an event at 23:30 UTC on a Thursday is 01:30 on Friday in Beirut
 const late=log();const s=late.session(Date.parse('2026-11-19T23:30:00Z'));
 assert.equal(run(late.events).tables.byHour[1],1);
});

test('money and guests: average bill and tip (LBP converted), splits, payment methods, languages, LBP, returning phones',()=>{
 const L=log();
 for(let k=0;k<20;k++){
  const t=AT-10*DAY+k*3600000,s=L.session(t,{device:k<5?'same':undefined});
  if(k<4)L.ev('ui_action',t+1,s,{action:'language',value:'ar'});
  if(k===4){L.ev('ui_action',t+1,s,{action:'language',value:'ar'});L.ev('ui_action',t+2,s,{action:'language',value:'en'});}   // last choice wins
  if(k<6)L.ev('ui_action',t+3,s,{action:'currency',value:'lbp'});
  if(k<8){L.ev('ui_action',t+4,s,{action:'split',value:'even'});
   L.ev('payment_completed',t+5,s,{orderId:'o'+k,amount:20,amountUsd:20,tip:2,rail:'card',currency:'USD'});
   L.ev('payment_completed',t+6,s,{orderId:'o'+k,amount:20*89500,amountUsd:20,tip:89500,rail:'cash',currency:'LBP'});}
  else L.ev('payment_completed',t+5,s,{orderId:'o'+k,amount:44,amountUsd:44,tip:4,rail:k%2?'whish':'pos',currency:'USD'});
 }
 for(let k=0;k<40;k++)L.session(AT-14*DAY-k*MIN,{table:9});   // older scans, for the 14 days of history
 const r=run(L.events);
 const bill=find(r,'money-bill');
 // 8 bills of 20+20 with 2+1 tip, 12 of 44 with 4 tip: net 8*37+12*40=776, tips 8*3+12*4=72
 assert.equal(bill.text,'The average bill paid through Aalayna was $38.80 across 20 bills, and tips added 9% on top ($3.60 a bill). Guests tip 10% by card and Whish, 5% in cash.');
 assert.match(find(r,'money-split').text,/^40% of paid bills \(8 of 20\) were paid in two or more payments, 2 payments each on average\. The most-chosen way to split is equal shares \(100% of sessions that chose one\)\.$/);
 assert.match(find(r,'rails').text,/^Of the \$848\.00 paid through Aalayna, /);
 const lang=find(r,'languages');assert.match(lang.text,/^7% of sessions switched the menu to Arabic and 0% to French/);
 assert.match(lang.text,/3 dishes have no Arabic text \(Fatteh b'Laban, Arayes and Fresh lemonade w' mazaher\), so they show in English\./);
 assert.match(find(r,'currency').text,/^10% of sessions \(6 of 60\) switched prices to Lebanese pounds/);
 assert.match(find(r,'repeat').text,/^7% of sessions \(4 of 60\) came from a phone that had opened your menu before\. A phone is not a person/);
});

test('early signal until 30 days are recorded; the tab says how many days it has',()=>{
 const young=run(steak({start:AT-9*DAY-3600000}).events.filter(e=>Date.parse(e.createdAt)>=AT-9*DAY-3600000&&Date.parse(e.createdAt)<=AT));
 assert.equal(young.daysCollected,10);assert.equal(young.early,true);
 assert.ok(young.insights.length&&young.insights.every(i=>i.early===true));
 const L=steak();L.session(AT-35*DAY);
 const old=run(L.events);assert.equal(old.daysCollected,36);assert.equal(old.early,false);assert.ok(old.insights.every(i=>i.early===false));
 const empty=run([]);assert.equal(empty.daysCollected,0);assert.equal(empty.insights.length,0);assert.ok(empty.waiting.length>=8);
 // events after the report time are not counted
 assert.equal(run(steak().events,{at:AT-40*DAY}).counts.events,0);
});

test('the demo history is deterministic, sits before today, and tells the steak story on both demo menus',()=>{
 const one=A.demoInsightEvents({items:ITEMS,at:AT,venueId:'v1'}),two=A.demoInsightEvents({items:ITEMS,at:AT,venueId:'v1'});
 assert.deepEqual(one,two);assert.notDeepEqual(A.demoInsightEvents({items:ITEMS,at:AT,venueId:'v2'}).length,0);
 assert.ok(one.length>2000&&one.every(e=>Date.parse(e.createdAt)<AT-2*3600000&&e.demo===true));
 const r=A.computeInsights({events:one,items:ITEMS,sections:SECTIONS,at:AT,tables:['1','2','3','4','5','6','7','8','9','10']});
 assert.equal(r.early,false);assert.equal(r.insights[0].id,'dish-low:i07');
 for(const id of ['dish-staple:i06','dish-unopened','diet-gap:protein','pay-slow:8','tables-low','traffic','money-bill','languages','repeat','option:i17'])assert.ok(find(r,id),id);
 const M=setup(),pack=JSON.parse(read('venues/mayda.json')),d=M.draft();d.sections=pack.sections;d.items=pack.items;M.saveDraft(d);M.publish();
 const items=M.published().items,mr=M.computeInsights({events:M.demoInsightEvents({items,at:AT,venueId:M.venueId()}),items,sections:M.published().sections,at:AT});
 assert.match(mr.insights[0].text,/^Grilled Veal Filet was opened \d+ times/);
});

test('A.venueInsights reads the shown venue, and dishInterest still answers as before',()=>{
 const B=setup();B.setVenue({name:'Test',place:'Hamra'});
 const s=B.newSession();B.logEvent('qr_scan',{tableId:'3'},{tableId:3});B.logEvent('item_view',{itemId:'i01'},{tableId:3});
 const r=B.venueInsights({days:30});
 assert.equal(r.counts.sessions,1);assert.equal(r.counts.opens,1);assert.equal(r.daysCollected,1);assert.equal(r.early,true);
 assert.equal(B.dishInterest('7').find(x=>x.itemId==='i01').opens,1);
 assert.equal(B.dishInterest('7').find(x=>x.itemId==='i01').dwellReads,0);
});

/* ---- the panel, against a minimal DOM ---- */
function panel(opts={}){
 class El{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.style={};this.attrs={};this.className='';this.classes=new Set();}
  appendChild(c){this.children.push(c);return c;}append(...c){this.children.push(...c);}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}
  get classList(){const s=this.classes;return {contains:k=>s.has(k),add:k=>s.add(k),remove:k=>s.delete(k)};}}
 const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El('div'));return els.get(id);};
 const B=setup(opts.search||'');if(opts.venue)B.setVenue(opts.venue);
 const ctx=vm.createContext({Aalayna:B,$,document:{createElement:t=>new El(t),createTextNode:t=>Object.assign(new El('#text'),{textContent:t})},
  opsEl:(t,text,cls)=>Object.assign(new El(t),{textContent:text==null?'':text,className:cls||''}),opsCount:(n,w)=>n+' '+w+(n===1?'':'s'),
  opsDuration:ms=>Math.round(ms/1000)+'s',money:v=>'$'+v.toFixed(2),go(){},setTimeout(){return 1;},FL_DEFAULT:{1:{},2:{},3:{}},Date,Math,JSON,Object,Number,String});
 vm.runInContext(read('insights-panel.js'),ctx,{filename:'insights-panel.js'});
 $('v-insights').classList.add('on');$('ins-period').value='30';
 ctx.paintInsights();
 const text=n=>n.textContent+n.children.map(text).join(' ');
 return {B,body:$('insights-body'),text:()=>text($('insights-body')),ctx};
}
test('the panel: Mayda in the demo shows the labelled sample history and ranked findings; another venue shows only its own data',()=>{
 const p=panel();
 assert.ok(p.body.children.length>8);
 assert.match(p.text(),/Sample history · six weeks of illustrative guest activity at the fictional Mayda/);
 assert.match(p.text(),/Suggested: /);assert.match(p.text(),/These are separate counts, not a conversion rate\. Viewing sessions are not unique people\./);
 const findings=p.body.children.find(c=>c.className==='ins-list');assert.equal(findings.children.filter(c=>c.className==='ins-item').length,6);
 const real=panel({venue:{name:'Test Bistro',place:'Hamra'}});
 assert.doesNotMatch(real.text(),/Sample history/);
 assert.match(real.text(),/No activity recorded yet/);assert.match(real.text(),/Waiting for more data/);
 // a hidden tab is not painted, only marked for the next opening
 const h=panel();h.ctx.$('v-insights').classList.remove('on');h.ctx.$('insights-body').replaceChildren();h.ctx.paintInsights();assert.equal(h.body.children.length,0);
});

test('dashboard wiring: an owner-only Insights tab with its panel and scripts, shipped by the allowlist',()=>{
 const html=read('dashboard.html');
 assert.match(html,/<button class="ni" data-owner-only onclick="openInsights\(this\)">Insights<\/button>/);
 assert.match(html,/<div class="view" id="v-insights" data-owner-only>/);
 assert.match(html,/<section id="insights-body" aria-live="polite"><\/section>/);
 assert.match(html,/id="v-insights"[\s\S]*?data-group-only[\s\S]*?data-group-pick/,'All venues: insights are per venue, with a venue picker');
 const order=['restaurant-ops.js','owner-insights.js','insights-demo.js','insights-panel.js'].map(f=>html.indexOf('<script src="'+f));
 assert.ok(order.every((x,i)=>x>0&&(!i||x>order[i-1])),'scripts after restaurant-ops.js, in order');
 const ignore=read('.gitignore');for(const f of ['owner-insights.js','insights-demo.js','insights-panel.js'])assert.match(ignore,new RegExp('^!'+f.replace('.','\\.')+'$','m'));
 assert.match(read('restaurant-ops.css'),/\.ins-item\{/);
});
