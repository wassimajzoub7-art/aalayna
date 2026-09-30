/* Payments taken at the till (rail 'pos', recorded by aal_pos_record_tenders) on the owner pages.
   A tender is a confirmed settlement with amount including the tip, method cash|card|other, and no
   server. Proves that owner-metrics.js (ownerReport, eventMetrics), aalayna-store.js (byRail,
   tipsOwed, tipsAtTill), restaurant-growth.js (checkBalance) and the daily close email all count
   it in its own bucket, and that cash, card and whish figures are what they were without it. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const NOW=Date.parse('2026-06-01T12:00:00Z');
const iso=ms=>new Date(ms).toISOString(),plain=v=>JSON.parse(JSON.stringify(v));

function setup(){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
 const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const window={location:{search:''},addEventListener(){},localStorage:storage};
 const ctx=vm.createContext({window,localStorage:storage,URLSearchParams,Date:Clock});
 for(const f of ['aalayna-store.js','restaurant-growth.js','owner-metrics.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);
 const a=window.Aalayna;a.setVenue({name:'Restaurant',place:'Beirut'});
 return {a,map};
}
/* rows as the stores write them: confirmed, amount includes the tip */
function row(venueId,id,rail,amount,tip,extra){
 const ts=iso(NOW-3600000);
 return Object.assign({id,venueId,checkId:'chk_'+id,table:5,rail,amount,tip,items:{},currency:'USD',amountUsd:amount,fxRateUsed:null,status:'confirmed',ts,confirmedAt:ts},
  rail==='pos'?{source:'pos',method:'card',posRef:{externalId:'ext_'+id,method:'card'},recordedAt:ts}:{server:'Sara'},extra||{});
}
function event(venueId,s,n){
 return {eventId:'ev'+n,deviceId:'d'+n,sessionId:'s'+n,restaurantId:venueId,tableId:'5',customerId:null,eventType:'payment_completed',
  payload:{paymentId:s.id,orderId:s.checkId,amount:s.amount,tip:s.tip,rail:s.rail,currency:'USD',amountUsd:s.amountUsd},createdAt:s.confirmedAt};
}
/* cash 40 (tip 4), card 55 (tip 5), whish 22 (tip 2), pos 100 (tip 10; a card tender), pos 30 (no tip; a cash tender) */
function fixture(){
 const e=setup(),vid=e.a.venueId();
 const rows=[row(vid,'p_cash','cash',40,4),row(vid,'p_card','card',55,5),row(vid,'p_whish','whish',22,2),
  row(vid,'tnd_a','pos',100,10),row(vid,'tnd_b','pos',30,0,{method:'cash',posRef:{externalId:'ext_b',method:'cash'}})];
 e.map.set('aal.settle',JSON.stringify(rows));
 e.map.set('aal.events',JSON.stringify(rows.map((s,i)=>event(vid,s,i))));
 return e;
}

test('ownerReport: the pos bucket is real, the per-rail lines add up to the total, cash card and whish are unchanged',()=>{
 const {a}=fixture(),c=a.ownerReport('7').current;
 assert.deepEqual(plain(c.rails),{cash:4000,card:5500,whish:2200,pos:13000});
 assert.equal(Number.isNaN(c.rails.pos),false);
 const sum=c.rails.cash+c.rails.card+c.rails.whish+c.rails.pos;
 assert.equal(sum,c.grossCents);assert.equal(sum,24700);
 assert.equal(c.netCents,22600);assert.equal(c.tipCents,2100);assert.equal(c.paymentCount,5);
});
test('ownerReport: a refunded till payment leaves the bucket like any other refund',()=>{
 const {a,map}=fixture(),rows=JSON.parse(map.get('aal.settle'));
 rows.find(r=>r.id==='tnd_a').refunded=iso(NOW-60000);map.set('aal.settle',JSON.stringify(rows));
 const c=a.ownerReport('7').current;assert.equal(c.rails.pos,3000);assert.equal(c.grossCents,14700);
});
test('eventMetrics: pos has its own rail and share; cash, in-app digital and till shares add to 100%',()=>{
 const {a}=fixture(),m=a.eventMetrics('7');
 assert.deepEqual(plain(m.rails),{cash:4000,card:5500,whish:2200,pos:13000,other:0});
 const total=24700;
 assert.equal(m.cashShare,4000/total);assert.equal(m.digitalShare,7700/total);assert.equal(m.tillShare,13000/total);
 assert.ok(Math.abs(m.cashShare+m.digitalShare+m.tillShare-1)<1e-12);
 assert.equal(m.payments,5);
});
test('eventMetrics: with no till payments the shares are what they were and the till share is zero',()=>{
 const {a,map}=fixture();
 map.set('aal.events',JSON.stringify(JSON.parse(map.get('aal.events')).filter(e=>e.payload.rail!=='pos')));
 const m=a.eventMetrics('7');
 assert.equal(m.rails.pos,0);assert.equal(m.tillShare,0);assert.equal(m.cashShare,4000/11700);assert.equal(m.digitalShare,7700/11700);
});
test('eventMetrics: an unknown rail still lands in other, not in the till',()=>{
 const {a,map}=fixture(),ev=JSON.parse(map.get('aal.events'));
 ev.push(Object.assign({},ev[0],{eventId:'evx',sessionId:'sx',payload:Object.assign({},ev[0].payload,{rail:'cheque',amount:10,amountUsd:10})}));
 map.set('aal.events',JSON.stringify(ev));
 const m=a.eventMetrics('7');assert.equal(m.rails.other,1000);assert.equal(m.rails.pos,13000);
});
test('byRail counts pos with the others and settledTotal agrees',()=>{
 const {a}=fixture(),t=a.byRail();
 assert.deepEqual(plain(t),{whish:22,card:55,cash:40,pos:130});
 assert.equal(t.whish+t.card+t.cash+t.pos,a.settledTotal());
});
test('tipsOwed leaves till tips out (no server); tipsAtTill reports them',()=>{
 const {a}=fixture(),owed=a.tipsOwed();
 assert.deepEqual(plain(owed.map(o=>o.server)),['Sara']);            // no "undefined" server
 assert.equal(owed[0].amount,7);                              // card 5 + whish 2; cash tips are never owed
 assert.equal(owed.some(o=>o.server==='undefined'||o.server===undefined),false);
 assert.deepEqual(plain(a.tipsAtTill()),{amount:10});
 const {a:empty}=setup();assert.deepEqual(plain(empty.tipsAtTill()),{amount:0});
});
test('checkBalance has a pos method total instead of NaN',()=>{
 const {a,map}=setup(),vid=a.venueId(),c=a.openServiceCheck({table:12,total:100});
 const ts=iso(NOW-1000);
 map.set('aal.settle',JSON.stringify([row(vid,'tnd_c','pos',100,10,{checkId:c.id,table:12,ts,confirmedAt:ts})]));
 const b=a.checkBalance(c.id);
 assert.equal(b.methods.pos,9000);assert.equal(b.methods.cash+b.methods.card+b.methods.whish+b.methods.pos,b.confirmedCents);
});

/* ------------------------------------------------------------ daily close */
let loaded;
const mod=()=>loaded||(loaded=(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-rail-')),file=path.join(dir,'handler.mjs');
 fs.copyFileSync(path.join(root,'supabase/functions/daily-close/handler.js'),file);return import(pathToFileURL(file).href);})());
const T=t=>'2026-09-30T'+t+'Z';
const RID='["kababji","hamra"]';
const kv=(id,body)=>({id,body});
const sRow=(id,body)=>kv(id,Object.assign({id,venueId:RID,currency:'USD',tip:0,status:'confirmed',ts:T('12:00:00.000'),confirmedAt:T('12:01:00.000'),checkId:'c_'+id,table:3},body));

test('daily close: two tenders are their own line, by method, and stay out of Cash and Digital',async()=>{
 const m=await mod();
 const settles=[
  sRow('p1',{rail:'cash',amount:20,tip:2,amountUsd:20,server:'Sara'}),
  sRow('p2',{rail:'card',amount:50,tip:5,amountUsd:50,server:'Sara'}),
  sRow('tnd_1',{rail:'pos',source:'pos',method:'cash',posRef:{externalId:'e1',method:'cash'},amount:30,tip:0,amountUsd:30,ts:T('13:00:00.000'),confirmedAt:T('13:00:00.000')}),
  sRow('tnd_2',{rail:'pos',source:'pos',method:'card',posRef:{externalId:'e2',method:'card'},amount:70,tip:7,amountUsd:70,ts:T('14:00:00.000'),confirmedAt:T('14:00:00.000')})
 ];
 const f=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles,guests:[],events:[],docs:[]});
 assert.deepEqual(f.till,{count:2,usdCents:10000,methods:{cash:{count:1,usdCents:3000},card:{count:1,usdCents:7000}}});
 assert.deepEqual(f.cash,{count:1,usdCents:2000,lbp:null});
 assert.equal(f.digital.count,1);assert.equal(f.digital.usdCents,5000);assert.deepEqual(f.digital.rails,{card:{count:1,usdCents:5000}});
 assert.deepEqual(f.tips,{usdCents:1400,byRail:{cash:200,card:500,pos:700}});
 const mail=m.buildEmail({venue:{name:'Kababji'},figures:f,csvName:'x.csv'}),t=mail.text;
 assert.match(t,/Cash confirmed:\s+1 payment, \$20\.00\n/);
 assert.match(t,/Digital confirmed:\s+1 payment, \$50\.00\n/);
 assert.doesNotMatch(t,/Pos:/);
 assert.match(t,/Paid at the till:\s+2 payments, \$100\.00\n/);
 assert.match(t,/\n\s+Cash:\s+1 payment, \$30\.00\n/);assert.match(t,/\n\s+Card:\s+1 payment, \$70\.00\n/);
 assert.match(t,/Tips:\s+\$14\.00 \(Card \$5\.00, Cash \$2\.00, Till \$7\.00\)/);
 assert.ok(t.indexOf('Digital confirmed')<t.indexOf('Paid at the till'));
 assert.match(mail.html,/Paid&nbsp;at&nbsp;the&nbsp;till/);
 assert.doesNotMatch(t+mail.html,/[\u2014\u{1F300}-\u{1FAFF}]/u);
 const csv=m.buildCsv(f.csvRows).split('\r\n');
 assert.equal(csv.filter(l=>/,pos,confirmed,/.test(l)).length,2);
 assert.match(csv.find(l=>l.startsWith('tnd_2')),/^tnd_2,c_tnd_2,3,pos,confirmed,70\.00,7\.00,USD,/);
});
test('daily close: a till tender with an unknown method counts as other; no tenders means no till line',async()=>{
 const m=await mod();
 const one=[sRow('tnd_9',{rail:'pos',source:'pos',method:'voucher',amount:12,amountUsd:12})];
 const f=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles:one,guests:[],events:[],docs:[]});
 assert.deepEqual(f.till.methods,{other:{count:1,usdCents:1200}});assert.equal(f.digital.count,0);
 assert.match(m.buildEmail({venue:{name:'V'},figures:f,csvName:'x.csv'}).text,/\n\s+Other:\s+1 payment, \$12\.00\n/);
 const none=m.computeClose({window:m.windowFor('2026-09-30'),checks:[],settles:[sRow('p1',{rail:'card',amount:5,amountUsd:5})],guests:[],events:[],docs:[]});
 assert.deepEqual(none.till,{count:0,usdCents:0,methods:{}});
 assert.doesNotMatch(m.buildEmail({venue:{name:'V'},figures:none,csvName:'x.csv'}).text,/Paid at the till/);
});
