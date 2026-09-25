/* Owner UI. Data writes are local; nothing in this file sends messages. */
var selectedGrowthCustomer = null;
var ownerReportSnapshot = null;
function opsReport(){return ownerReportSnapshot || Aalayna.ownerReport($('report-period').value);}
function opsPercent(value){return value==null?'–':(value*100).toFixed(1)+'%';}
function opsRateChange(current,previous){
  if(current==null || previous==null)return 'Comparison needs more history';
  var delta=(current-previous)*100;
  return (delta>0?'+':'')+delta.toFixed(1)+' percentage points vs previous period';
}
function opsMoneyChange(current,previous){
  if(!previous)return current?'No collected payments in previous period':'No collected payments in either period';
  var delta=(current/previous-1)*100;
  return (delta>0?'+':'')+delta.toFixed(1)+'% vs previous period';
}
function opsReportDates(w){
  var format=function(t){return new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Beirut',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});};
  return format(w.start)+' – '+format(w.end-1);
}
function opsEl(tag, text, cls) { var n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n; }
function opsButton(label, fn) { var b=opsEl('button',label,'btn');b.type='button';b.onclick=function(){try{fn();}catch(e){toast(e.message);}};return b; }
function opsDate(value) { return value ? new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : 'No confirmed visit'; }
function opsMask(contact) { if(contact.indexOf('@')>=0){var p=contact.split('@');return p[0].slice(0,2)+'***@'+p[1];}return '•••• '+contact.slice(-4); }
function opsGo(view) { var nav=Array.from(document.querySelectorAll('.ni')).find(function(n){return (n.getAttribute('onclick')||'').indexOf("'"+view+"'")>=0;}); if(nav)go(nav,view); }
function opsDownload(name, text, type) { var url=URL.createObjectURL(new Blob([text],{type:type})),a=opsEl('a');a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000); }
function paintGrowth() { paintGrowthCustomers();paintGrowthCampaigns();paintAudience();paintGrowthWeek();paintCheckBalances();paintBills();paintDishInterest();paintGuestJourney();paintDataHealth();paintFeedbackAttention();paintRecordedRatings(); }
function paintGrowthCustomers() {
  var profiles=Aalayna.customerProfiles(),box=$('gl-rows'),q=$('guest-search').value.trim().toLowerCase();box.replaceChildren();
  $('gl-total').textContent=profiles.length;$('gl-mkt').textContent=profiles.filter(function(g){return g.marketing;}).length;$('gl-ret').textContent=profiles.filter(function(g){return g.visits>1;}).length;
  var visible=profiles.filter(function(g){return g.contact.toLowerCase().indexOf(q)>=0;}).sort(function(a,b){return (b.last||'').localeCompare(a.last||'');});
  if(!visible.length)box.appendChild(opsEl('p',profiles.length?'No contact matches this search.':'No linked contacts yet. Optional details saved after a confirmed guest payment appear here.','ops-empty'));
  visible.forEach(function(g){
    var row=opsEl('div',null,'ops-row'),body=opsEl('div');body.appendChild(opsEl('strong',opsMask(g.contact)));
    body.appendChild(opsEl('p',g.channel+' · '+g.visits+' recorded visit'+(g.visits===1?'':'s')+' · '+money(g.spendCents/100)+' linked spending','cs'));
    body.appendChild(opsEl('p','Last visit: '+opsDate(g.last)+' · '+(g.marketing?'Offers permitted':'Marketing off'),'cs'));
    row.append(body,opsButton('View history',function(){selectedGrowthCustomer=g.id;paintGrowthCustomers();$('customer-dialog').showModal();}));box.appendChild(row);
  });
  var detail=$('customer-detail');detail.replaceChildren();
  var g=profiles.find(function(x){return x.id===selectedGrowthCustomer;});
  if(g){
    detail.appendChild(opsEl('h3',g.contact));detail.appendChild(opsEl('p','Receipt permission: '+(g.receipt?'yes':'no')+' · Marketing permission: '+(g.marketing?'yes':'no'),'cs'));
    g.history.slice().reverse().forEach(function(v){detail.appendChild(opsEl('p',opsDate(v.at)+' · '+money(v.spendCents/100)+' · '+v.rails.join(', ')+' · bill '+v.checkId.slice(-8),'ops-history'));});
    var consent=opsEl('details');consent.appendChild(opsEl('summary','Permission history'));
    (g.consentHistory||[]).slice().reverse().forEach(function(h){consent.appendChild(opsEl('p',new Date(h.at).toLocaleString()+' · '+h.source+' · marketing '+(h.marketing?'on':'off'),'cs'));});detail.appendChild(consent);
    if(g.marketing)detail.appendChild(opsButton('Record marketing opt-out',function(){Aalayna.withdrawMarketing(g.id);toast('Marketing permission withdrawn.');}));
  }
  var legacy=Aalayna.guests().filter(function(g){return !g.venueId && g.venue===Aalayna.venue().name;}).length;
  $('legacy-guests').textContent=legacy?legacy+' older contact record(s) have no linked bill or branch identity. They are excluded from these profiles and campaigns until a new receipt opt-in is recorded.':'';
}
function paintAudience() {
  var channel=$('cp-channel').value,segment=$('cp-aud').value,rows=Aalayna.campaignAudience(segment,channel);
  $('audience-count').textContent=rows.length+' eligible '+channel+' contact'+(rows.length===1?'':'s')+'. Only active marketing permissions with confirmed visit history are included.';
}
function saveGrowthCampaign() {
  try {
    Aalayna.prepareCampaign({name:$('cp-name').value,message:$('cp-msg').value,audience:$('cp-aud').value,channel:$('cp-channel').value,useHoldout:$('cp-holdout').checked});
    closeCampaign();opsPanel('growth','growth-campaigns');
    $('cp-name').value='';$('cp-msg').value='';
    toast('Draft saved. Review it before approving an audience.');
  }catch(e){toast(e.message);}
}
function importGrowthDeliveries(id) {
  var input=opsEl('input');input.type='file';input.accept='.json,application/json';
  input.onchange=async function(){
    try{var file=input.files[0];if(!file)return;if(file.size>1000000)throw new Error('Choose a delivery report smaller than 1 MB.');var rows=JSON.parse(await file.text());Aalayna.recordCampaignDeliveries(id,rows);toast('Delivery report recorded; no messages sent by Aalayna.');}
    catch(e){toast(e.message);}
  };input.click();
}
function paintGrowthCampaigns() {
  var box=$('cp-rows');box.replaceChildren();var campaigns=Aalayna.growthCampaigns().slice().reverse();
  if(!campaigns.length)box.appendChild(opsEl('p','No campaigns yet. Start with an invitation to make a second visit.','ops-empty'));
  campaigns.forEach(function(c){
    var card=opsEl('article',null,'ops-campaign');card.appendChild(opsEl('h3',c.name));
    card.appendChild(opsEl('span',c.status==='draft'?'Draft':'Audience approved','status-badge '+(c.status==='draft'?'draft':'approved')));
    card.appendChild(opsEl('p',c.channel+' · '+opsDate(c.ts),'cs'));
    card.appendChild(opsEl('p',c.message,'ops-message'));
    if(c.status==='draft'){
      var current=Aalayna.campaignAudience(c.audience,c.channel).length;
      card.appendChild(opsEl('p',current+' currently eligible · '+(c.useHoldout?'20% comparison group':'No comparison group')+'. Confirm the message identifies your restaurant and explains how to opt out.','cs'));
      card.appendChild(opsButton('Approve audience · does not send',function(){Aalayna.approveCampaign(c.id);toast('Audience approved. Nothing was sent.');}));
    }else{
      var report=Aalayna.campaignReport(c.id),eligible=Aalayna.exportCampaignAudience(c.id).length;
      card.appendChild(opsEl('p',c.recipients.length+' assigned recipients · '+c.holdout.length+' comparison contacts · '+eligible+' still eligible to export','cs'));
      var outcomes=opsEl('div',null,'campaign-outcomes');
      [['Reported deliveries',report.delivered.size],['Guests who returned',report.delivered.returners],['Linked return spending',money(report.delivered.spendCents/100)]].forEach(function(pair){var metric=opsEl('div');metric.append(opsEl('span',pair[0]),opsEl('strong',String(pair[1])));outcomes.appendChild(metric);});
      card.appendChild(outcomes);
      card.appendChild(opsEl('p','After reported delivery · spending excludes tips and refunded payments.','cs'));
      var rate=function(g){return g.rate==null?'–':(g.rate*100).toFixed(1)+'%';};
      card.appendChild(opsEl('p','Return rate by original assignment: recipients '+rate(report.assigned)+' ('+report.assigned.returners+'/'+report.assigned.size+'), comparison '+rate(report.comparison)+' ('+report.comparison.returners+'/'+report.comparison.size+').','cs'));
      card.appendChild(opsEl('p',(report.windowComplete?'30-day observation window ended. ':'30-day observation window still open. ')+'Observed returns are not proof of additional sales. Small groups are directional; return visits may overlap campaigns. Delivery reports are owner-imported, not independently verified.','cs'));
      var actions=opsEl('div',null,'ops-actions');
      actions.appendChild(opsButton('Export eligible audience',function(){var rows=Aalayna.exportCampaignAudience(c.id);if(!rows.length)throw new Error('No eligible contacts remain.');opsDownload('campaign-audience.json',JSON.stringify(rows,null,2),'application/json');toast('Audience exported. Recheck permissions before sending through your provider.');}));
      actions.appendChild(opsButton('Import delivery report',function(){importGrowthDeliveries(c.id);}));card.appendChild(actions);
      var help=opsEl('details');help.appendChild(opsEl('summary','Delivery report format'));help.appendChild(opsEl('p','Upload a JSON array with customerId from the audience export, deliveredAt (ISO timestamp), and providerMessageId. Include only actual successful deliveries. Exporting an audience does not count as delivery.','cs'));card.appendChild(help);
    }
    box.appendChild(card);
  });
}
function paintGrowthWeek() {
  var report=opsReport(),w=report.current,p=report.previous;
  $('overview-period').textContent=report.window.label+' · recorded payments and customer growth';
  $('week-net').textContent=money(w.netCents/100);
  $('overview-money-detail').textContent=w.completedBills+' completed bills · '+money(w.tipCents/100)+' tips separately';
  $('overview-money-change').textContent=opsMoneyChange(w.netCents,p.netCents);
  $('capture-rate').textContent=opsPercent(w.captureRate);$('capture-detail').textContent=w.identifiedBills+' of '+w.bills+' paid bills linked to a contact';
  $('capture-change').textContent=opsRateChange(w.captureRate,p.captureRate);
  $('optin-rate').textContent=opsPercent(w.optInRate);$('optin-detail').textContent=w.marketingContacts+' of '+w.receiptContacts+' receipt contacts chose offers';
  $('optin-change').textContent=opsRateChange(w.optInRate,p.optInRate);
  $('return-rate').textContent=opsPercent(w.returnRate);$('return-detail').textContent=w.eligibleReturners?w.returners+' of '+w.eligibleReturners+' eligible guests returned':'Waiting for a full 30-day follow-up';
  $('return-change').textContent=opsRateChange(w.returnRate,p.returnRate);
  $('overview-period-detail').textContent='Reporting: '+opsReportDates(report.window)+'. Previous equal-length period: '+opsReportDates(report.previousWindow)+'. Beirut time.';
  $('return-cohort-detail').textContent='Return-rate group: first observed visits '+opsReportDates(w.cohort)+'. The group is shifted back 30 days so every guest has a complete follow-up. '+(w.eligibleReturners<30?'Small or empty samples are directional.':'');
  $('withdrawal-detail').textContent=w.withdrawals+' contacts withdrew marketing permission in this period. This is an account-level count, not a campaign unsubscribe rate.';
  var box=$('weekly-actions');box.replaceChildren();
  Aalayna.recommendations().forEach(function(r){var row=opsEl('article',null,'ops-row'),body=opsEl('div');body.append(opsEl('h3',r.title),opsEl('p',r.detail,'cs'));row.appendChild(body);
    if(r.action)row.appendChild(opsButton(r.action,function(){
      if(r.kind==='cash'){opsGo('tonight');opsPanel('service','service-live');$('cash-queue').scrollIntoView({block:'center'});return;}
      opsGo('guests');
      if(r.kind==='second_visit'||r.kind==='lapsed'){$('cp-aud').value=r.kind;if(!Aalayna.campaignAudience(r.kind,$('cp-channel').value).length)$('cp-channel').value=$('cp-channel').value==='email'?'whatsapp':'email';paintAudience();openCampaign();}
    }));box.appendChild(row);
  });
}
function paintCheckBalances() {
  var box=$('check-balances');box.replaceChildren();var checks=Aalayna.serviceChecks().slice().sort(function(a,b){return Number(!!a.closedAt)-Number(!!b.closedAt)||(b.openedAt||'').localeCompare(a.openedAt||'');});
  $('live-open').textContent=checks.filter(function(c){return !c.closedAt;}).length;
  $('live-cash').textContent=money(Aalayna.pendingCash().reduce(function(sum,x){return sum+x.amount;},0));
  $('live-paid').textContent=money(opsReport().current.grossCents/100);
  var active=checks.filter(function(c){return !c.closedAt || Aalayna.checkBalance(c.id).remainingCents>0;});
  /* T4 roles: live staff (owner, or a signed-in waiter) open bills and issue bill links; closing a bill stays
     with the owner in shared mode (aal_mutate refuses it for a waiter), and with anyone in the local demo.
     Until the first server read names the role ('staff'), neither shows. */
  var liveRole=Aalayna.sync && Aalayna.sync.enabled ? Aalayna.sync.state().role : null;
  var liveStaff=liveRole==='owner'||liveRole==='waiter', ownerControls=!(Aalayna.sync && Aalayna.sync.enabled)||liveRole==='owner';
  /* shared mode keeps upstream's quick path for a bill that only has a POS total; itemised bills use Bills above */
  if(liveStaff)box.appendChild(opsButton('Open a bill from a POS total',async function(){
    var table=window.prompt('Table number'),total=table&&window.prompt('Bill total in USD, copied from the POS');
    if(!table||!total)return;
    if(!Number.isInteger(Number(table))||Number(table)<1||!Number.isFinite(Number(total))||Number(total)<=0){toast('Enter a valid table and bill total.');return;}
    try{await Aalayna.openServiceCheck({table:Number(table),total:Number(total),lines:[]});toast('Bill opened. Use Guest bill link to share it.');}catch(error){toast(error.message);}
  }));
  if(!active.length)box.appendChild(opsEl('p',checks.length?'All recorded bills are closed. No outstanding balances.':'No bills recorded yet. Choose a table above and enter its bill.','ops-empty'));
  active.forEach(function(c){var b=Aalayna.checkBalance(c.id),row=opsEl('article',null,'ops-row'),body=opsEl('div');
    var head=opsEl('div',null,'ops-heading');head.appendChild(opsEl('h3','Table '+c.table+((c.source||'prototype')==='prototype'?' · sample bill':'')));
    var state=c.closedAt?(b.remainingCents?'Review refund':'Closed'):(b.pendingCents?'Payment reserved':(b.remainingCents?'Open':'Ready to close'));
    head.appendChild(opsEl('span',state,'status-badge '+(b.pendingCents?'pending':c.closedAt?'draft':'approved')));body.appendChild(head);
    var balance=opsEl('p',null,'bill-balance');balance.append(opsEl('strong',money(b.remainingCents/100)),opsEl('span',' outstanding'));body.appendChild(balance);
    body.appendChild(opsEl('p','Collected '+money(b.confirmedCents/100)+' of '+money(c.totalCents/100),'cs'));
    if(b.pendingCents)body.appendChild(opsEl('p',money(b.pendingCents/100)+' reserved · '+money(b.availableCents/100)+' available to pay','cs'));
    var detail=opsEl('details',null,'ops-help');detail.appendChild(opsEl('summary','Bill details'));detail.appendChild(opsEl('p','Opened '+opsDate(c.openedAt)+' · bill '+c.id.slice(-8)+' · Cash '+money(b.methods.cash/100)+' · Whish '+money(b.methods.whish/100)+' · Card '+money(b.methods.card/100)+' · Tips '+money(b.tipCents/100),'cs'));body.appendChild(detail);row.appendChild(body);
    var actions=opsEl('div',null,'ops-actions bill-row-actions');
    if(!c.closedAt)actions.appendChild(opsButton('Edit bill',function(){billPickTable(c.table);$('bills-card').scrollIntoView({block:'start',behavior:'smooth'});}));
    if(liveStaff && !c.closedAt)actions.appendChild(opsButton('Guest bill link',async function(){
      try{var issued=await Aalayna.sync.issueCheckKey(c.id),v=Aalayna.venue(),url=new URL('guest.html',location.href);url.search=new URLSearchParams({venue:v.name,place:v.place||'',k:issued.key}).toString();window.prompt('Copy this bill link. It only opens this bill, and stops working 24 hours after the bill is closed.',url.href);}catch(error){toast(error.message);}
    }));
    if(ownerControls&&!c.closedAt&&!b.remainingCents&&!b.pendingCents)actions.appendChild(opsButton('Close settled bill',async function(){try{await Aalayna.closeServiceCheck(c.id);toast(liveStaff?'Bill closed. Guests can still ask for their receipt for 24 hours; then its links stop working.':'Bill closed. The next guest session can open a new bill.');}catch(error){toast(error.message);}}));
    if(actions.childNodes.length)row.appendChild(actions);box.appendChild(row);
  });
}

/* ---- Bills: a waiter enters each table's bill until a POS supplies checks. ----
   The draft lives here until Save; the store decides what may change. Once a
   payment is recorded on a bill, existing lines are locked and only additions
   are accepted, and the store refuses anything else even if this view is stale. */
var BILL_TABLES = 16;
var billDraft = null;   // {table, checkId, revision, dirty, lines:[{id, name, q, pc, unit}]}
function billLoad(table){
  table=Number(table)||1;
  var open=Aalayna.openCheckFor(table),items=Aalayna.published().items;
  /* from the check itself, so staff also see a leftover sample check that guests no longer see */
  billDraft={table:table,checkId:open?open.id:null,revision:open?(open.revision||1):0,dirty:false,sample:!!open&&(open.source||'prototype')==='prototype',posTotal:open&&!(open.lines||[]).length?open.totalCents:0,
    lines:open?(open.lines||[]).map(function(l){var pc=Aalayna.util.cents(l.p),item=items.find(function(x){return x.id===l.id;});return {id:l.id,name:item?item.name:(l.name||'(removed)'),q:l.q,pc:pc,unit:pc/l.q};}):[]};
}
/* what the live bill allows: the minimum quantity per line, from payments */
function billLocks(){
  var none={paid:false,floor:{},claimed:{}};
  if(!billDraft||!billDraft.checkId)return none;
  var b;try{b=Aalayna.checkBalance(billDraft.checkId);}catch(e){return none;}
  var paid=b.confirmedCents+b.pendingCents>0,floor={};
  if(paid)b.check.lines.forEach(function(l){floor[l.id]=l.q;});
  Object.keys(b.items).forEach(function(k){floor[k]=Math.max(floor[k]||0,b.items[k]);});
  return {paid:paid,floor:floor,claimed:b.items,balance:b};
}
function billMenu(){ return Aalayna.published().items.filter(function(x){return !x.archivedAt&&x.available!==false;}); }
function billMatches(){
  var q=$('bill-search').value.trim().toLowerCase();
  if(!q)return [];
  /* names that start with the search come first, then any other match */
  return billMenu().filter(function(x){return x.name.toLowerCase().indexOf(q)>=0;})
    .sort(function(a,b){return (a.name.toLowerCase().indexOf(q)===0?0:1)-(b.name.toLowerCase().indexOf(q)===0?0:1);}).slice(0,8);
}
function billChanged(){billDraft.dirty=true;paintBills();}
function billAdd(item){
  var hit=billDraft.lines.find(function(l){return l.id===item.id;});
  if(hit){if(hit.q>=999)return;hit.q++;hit.pc=Math.round(hit.unit*hit.q);}
  else{var pc=Aalayna.util.cents(item.price);billDraft.lines.push({id:item.id,name:item.name,q:1,pc:pc,unit:pc});}
  $('bill-search').value='';paintBillSearch();$('bill-search').focus();billChanged();
}
function billStep(id,d){
  var l=billDraft.lines.find(function(x){return x.id===id;}),min=Math.max(1,billLocks().floor[id]||0);
  if(!l)return;l.q=Math.max(min,Math.min(999,l.q+d));l.pc=Math.round(l.unit*l.q);billChanged();
}
function billRemove(id){
  if(billLocks().floor[id]){toast('This item is covered by a payment and cannot be removed.');return;}
  billDraft.lines=billDraft.lines.filter(function(x){return x.id!==id;});billChanged();
}
function billPickTable(v){
  var t=Number(v);
  if(billDraft&&billDraft.dirty&&t!==billDraft.table&&!confirm('Discard unsaved changes for table '+billDraft.table+'?')){$('bill-table').value=String(billDraft.table);return;}
  billLoad(t);$('bill-table').value=String(t);paintBills();
}
function billDiscard(){ if(billDraft){billLoad(billDraft.table);paintBills();} }
function billSearchKey(e){ if(e.key==='Enter'){var m=billMatches();if(m.length){e.preventDefault();billAdd(m[0]);}} }
/* In demo mode the store saves at once. In shared mode (a venue key) the save is
   a server operation (aal_mutate open_check / update_check) and returns a promise;
   the draft stays on screen until the server answers. */
var billSaving=false;
function billSave(){
  var d=billDraft;if(!d||!d.dirty||billSaving)return;
  var open=Aalayna.openCheckFor(d.table),lines=d.lines.map(function(l){return {id:l.id,q:l.q,p:l.pc/100,name:l.name};}),result;
  try{
    if(d.checkId){
      if(!open||open.id!==d.checkId){billLoad(d.table);throw new Error('This bill was closed or replaced on another device. Your changes were not saved.');}
      if((open.revision||1)!==d.revision){billLoad(d.table);throw new Error('This bill was changed on another device. It has been reloaded; enter your changes again.');}
      result=Aalayna.updateServiceCheck(open.id,lines);
    }else{
      if(open){billLoad(d.table);throw new Error('Table '+d.table+' already has an open bill. It has been loaded; add your items again.');}
      if(!lines.length)throw new Error('Add at least one item before saving.');
      result=Aalayna.openServiceCheck({table:d.table,lines:lines,source:'staff'});
    }
  }catch(e){toast(e.message);paintBills();return;}
  var shared=!!(Aalayna.sync&&Aalayna.sync.enabled);
  billSaving=true;$('bill-save').disabled=true;
  Promise.resolve(result).then(function(){
    billSaving=false;billLoad(d.table);toast('Bill saved for table '+d.table+(shared?'. Guests with its bill link see it now.':'. The guest sees it now.'));paintBills();
  },function(e){
    billSaving=false;
    /* a lost connection keeps the change in the outbox; it is sent on reconnect, so it must not be entered twice */
    if(e&&e.queued){billLoad(d.table);toast('No connection. This bill is waiting to be sent and saves automatically. Do not enter it again.');}
    else toast(e&&e.message?e.message:'The bill was not saved.');
    paintBills();
  });
}
function paintBillSearch(){
  var box=$('bill-results');if(!box)return;box.replaceChildren();
  var q=$('bill-search').value.trim(),rows=billMatches();
  if(q&&!rows.length)box.appendChild(opsEl('p','No available dish matches this search. Sold out and archived dishes are hidden.','ops-empty'));
  rows.forEach(function(x){var b=opsEl('button',null,'bill-result');b.type='button';b.append(opsEl('span',x.name),opsEl('span',money(x.price),'bill-result-price'));b.onclick=function(){billAdd(x);};box.appendChild(b);});
}
function paintBills(){
  var sel=$('bill-table');if(!sel)return;
  if(!billDraft)billLoad(1);
  else if(!billDraft.dirty)billLoad(billDraft.table);
  var open={};Aalayna.serviceChecks().forEach(function(c){if(!c.closedAt)open[c.table]=c;});
  var max=Math.max.apply(null,[BILL_TABLES].concat(Object.keys(open).map(Number)));sel.replaceChildren();
  for(var t=1;t<=max;t++){
    if(t>BILL_TABLES&&!open[t])continue;
    var label='Table '+t;
    if(open[t]){try{label+=' · '+money(Aalayna.checkBalance(open[t].id).remainingCents/100)+' due';}catch(e){}}
    var o=opsEl('option',label);o.value=String(t);sel.appendChild(o);
  }
  sel.value=String(billDraft.table);
  var d=billDraft,locks=billLocks(),box=$('bill-lines');box.replaceChildren();
  var state=!d.checkId?'No open bill for table '+d.table+'. Add items and save to open one.'
    :d.sample&&!Aalayna.sampleAllowed()?'This is the demo sample bill, hidden from guests. Replace its items with the real bill and save, or remove them all and close it.'
    :locks.paid?'A payment is recorded on this bill. You can add items; existing items cannot be removed or reduced.'
    :'Open bill for table '+d.table+'. Changes reach the guest when you save.';
  if(d.posTotal)state+=' It was opened from a POS total of '+money(d.posTotal/100)+' without items; saving items replaces that total with their sum.';
  else if(d.checkId&&!d.lines.length&&!locks.paid)state+=' Saving with no items leaves a zero bill that you can close.';
  if(d.dirty)state+=' Unsaved changes.';
  $('bill-state').textContent=state;
  if(!d.lines.length)box.appendChild(opsEl('p','No items on this bill yet. Search the menu above to add one.','ops-empty'));
  d.lines.forEach(function(l){
    var row=opsEl('div',null,'bill-line'),info=opsEl('div',null,'bill-line-info'),min=Math.max(1,locks.floor[l.id]||0),claimed=locks.claimed[l.id]||0;
    info.append(opsEl('strong',l.name),opsEl('span',money(l.unit/100)+' each','cs'));
    var step=opsEl('div',null,'bill-step'),minus=opsEl('button','−','btn icon-btn'),plus=opsEl('button','+','btn icon-btn'),n=opsEl('span',String(l.q),'bill-qty');
    minus.type=plus.type='button';minus.disabled=l.q<=min;plus.disabled=l.q>=999;
    minus.setAttribute('aria-label','One fewer '+l.name);plus.setAttribute('aria-label','One more '+l.name);
    minus.onclick=function(){billStep(l.id,-1);};plus.onclick=function(){billStep(l.id,1);};step.append(minus,n,plus);
    var total=opsEl('strong',money(l.pc/100),'bill-line-total'),end=opsEl('div',null,'bill-line-end');end.append(step,total);
    if(locks.floor[l.id])end.appendChild(opsEl('span',claimed>=l.q?'Paid':claimed?claimed+' of '+l.q+' paid':'Locked','status-badge '+(claimed?'approved':'draft')));
    else{var rm=opsEl('button','Remove','btn bill-remove');rm.type='button';rm.onclick=function(){billRemove(l.id);};end.appendChild(rm);}
    row.append(info,end);box.appendChild(row);
  });
  var sum=d.lines.reduce(function(a,l){return a+l.pc;},0);
  $('bill-total').textContent=money(sum/100);
  $('bill-total-label').textContent=locks.balance?' bill total · '+money(locks.balance.confirmedCents/100)+' collected':' bill total';
  $('bill-save').disabled=!d.dirty||billSaving;$('bill-discard').disabled=!d.dirty||billSaving;
  paintBillSearch();
}

/* Focused sections retain their form values when switching views. Native dialogs
   provide Escape dismissal and focus containment without a second modal system. */
function opsPanel(group,id){
  document.querySelectorAll('[data-panel-group="'+group+'"]').forEach(function(p){p.hidden=p.id!==id;});
  document.querySelectorAll('button[data-group="'+group+'"]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.panel===id));});
}
function openCampaign(){opsPanel('growth','growth-campaigns');$('campaign-compose').showModal();$('cp-name').focus();}
function closeCampaign(){$('campaign-compose').close();}

/* ---- Dashboard v2: cards computed from the event stream. Read-only; nothing here writes. ---- */
function opsDuration(ms){ var s=Math.round(ms/1000),m=Math.floor(s/60),r=s%60; return m+':'+(r<10?'0':'')+r; }
function opsBeirutTime(value){ return new Date(value).toLocaleString('en-GB',{timeZone:'Asia/Beirut',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' Beirut'; }
function opsCount(n,word){ return n+' '+word+(n===1?'':'s'); }
function opsMetric(label,value,definition){ var b=opsEl('div',null,'journey-metric'); b.append(opsEl('div',label,'k'),opsEl('div',value,'v'),opsEl('div',definition,'d')); return b; }
function paintDishInterest(){
  var body=$('dish-rows'); if(!body)return;
  var rows=Aalayna.dishInterest($('report-period').value), w=Aalayna.ownerWindow($('report-period').value);
  $('dish-period').textContent=w.label+' · dish views and distinct bills containing each dish. These are separate counts, not a conversion rate. Viewing sessions are not unique people.';
  body.replaceChildren();
  var seen=rows.filter(function(r){ return r.opens>0; }), unseen=rows.filter(function(r){ return r.opens===0; });
  seen.slice(0,25).forEach(function(r){ var tr=opsEl('tr'); [r.name,String(r.opens),String(r.sessions),r.avgDwellS==null?'–':r.avgDwellS+' s',String(r.onBills)].forEach(function(t,i){ tr.appendChild(opsEl('td',t,i?'num':null)); }); body.appendChild(tr); });
  if(!seen.length){ var tr=opsEl('tr'); var td=opsEl('td','No dish opened yet in this period. Rows appear as guests browse the menu on their phones.','ops-empty'); td.colSpan=5; tr.appendChild(td); body.appendChild(tr); }
  $('dish-none').textContent=unseen.length?'Not opened at all in this period: '+unseen.slice(0,12).map(function(r){ return r.name; }).join(', ')+(unseen.length>12?' and '+(unseen.length-12)+' more':'')+'.':'';
}
function paintGuestJourney(){
  var box=$('journey-metrics'); if(!box)return;
  var m=Aalayna.eventMetrics($('report-period').value); box.replaceChildren();
  $('journey-period').textContent=m.window.label+' · from QR scan to payment, computed from recorded events.';
  box.appendChild(opsMetric('Scan to payment',opsPercent(m.conversion),opsCount(m.paidSessions,'paid session')+' of '+opsCount(m.scans,'scan')));
  box.appendChild(opsMetric('Repeat devices',opsPercent(m.repeatRate),m.repeatSessions+' of '+opsCount(m.sessions,'session')+' from a device seen before'));
  var total=m.rails.cash+m.rails.card+m.rails.whish+m.rails.other, digital=m.rails.card+m.rails.whish;
  box.appendChild(opsMetric('Cash vs digital',m.digitalShare==null?'–':Math.round(m.cashShare*100)+'% / '+Math.round(m.digitalShare*100)+'%',total?'Cash '+money(m.rails.cash/100)+', digital '+money(digital/100)+' of '+money(total/100)+' collected':'No collected amount in this period'));
  box.appendChild(opsMetric('Bill to payment',m.medianBillToPaymentMs==null?'–':opsDuration(m.medianBillToPaymentMs),m.timedSessions?'Median across '+opsCount(m.timedSessions,'timed session')+', bill opened to first payment':'No timed sessions yet'));
  box.appendChild(opsMetric('Identity capture',opsPercent(m.captureRate),m.identifiedPayments+' of '+opsCount(m.payments,'payment')+' linked to a known guest'));
  var list=$('journey-never'); list.replaceChildren();
  if(!m.neverOrdered.length)list.appendChild(opsEl('p','No viewed item is missing from every bill in this period.','ops-empty'));
  m.neverOrdered.forEach(function(x){ var row=opsEl('div',null,'journey-item'); row.append(opsEl('span',x.name),opsEl('strong',opsCount(x.views,'view'))); list.appendChild(row); });
  var usage=Aalayna.uiUsage($('report-period').value), ub=$('journey-usage');
  if(ub){ ub.replaceChildren();
    var LAB={language:'Language',currency:'Currency shown',split:'Split chosen',tip:'Tip chosen',rail:'Payment method chosen',note:'Cash note declared',filter:'Filters used',option:'Dish options picked'};
    var keys=Object.keys(LAB).filter(function(k){ return usage[k]; });
    if(!keys.length)ub.appendChild(opsEl('p','No interface choices recorded yet. They appear as guests use the menu on their phones.','ops-empty'));
    keys.forEach(function(k){ var u=usage[k], vals=Object.keys(u.values).sort(function(a,b){ return u.values[b]-u.values[a]; }).slice(0,6);
      var row=opsEl('div',null,'journey-item'); row.append(opsEl('strong',LAB[k]),opsEl('span',vals.map(function(v){ return v+' '+Math.round(100*u.values[v]/u.sessions)+'%'; }).join(' · ')+' · '+opsCount(u.sessions,'session')));
      ub.appendChild(row); });
  }
}

function paintDataHealth(){
  var box=$('health-rows'); if(!box)return; box.replaceChildren();
  var report=Aalayna.healthReport();
  report.checks.forEach(function(c){
    var row=opsEl('div',null,'health-row'); row.append(opsEl('span',c.label,'health-label'),opsEl('strong',String(c.value),'health-value'));
    if(c.flag)row.appendChild(opsEl('span','Flag','status-badge flag'));
    box.appendChild(row);
  });
  $('health-summary').textContent=(report.issues?opsCount(report.issues,'check')+' flagged':'No checks flagged')+' · ISO week '+report.week+'. One row is stored per week.';
  var rate=Aalayna.rateInfo(),line=$('health-rate'); line.replaceChildren();
  var age=rate.ageDays===0?'today':rate.ageDays+' day'+(rate.ageDays===1?'':'s')+' ago';
  line.appendChild(opsEl('span',rate.updatedAt?'Rate '+rate.rate.toLocaleString('en-US')+' LL, updated '+age+' by '+(rate.updatedBy||'owner')+'.':'Rate not set: default '+rate.rate.toLocaleString('en-US')+' LL in use.'));
  if(rate.stale)line.appendChild(opsEl('span','Stale','status-badge flag'));
}
function paintFeedbackAttention(){
  var card=$('feedback-attention'); if(!card)return;
  var w=Aalayna.ownerWindow($('report-period').value),rows=Aalayna.lowRatings(w.start).slice().reverse(),box=$('feedback-rows'); box.replaceChildren();
  card.hidden=!rows.length; $('feedback-count').textContent=rows.length+' to review';
  rows.forEach(function(e){
    var row=opsEl('div',null,'ops-row'),body=opsEl('div');
    body.append(opsEl('strong',e.payload.rating+'/5'+(e.tableId?' · Table '+e.tableId:'')),opsEl('p',e.payload.comment||'No comment','cs'),opsEl('p',opsBeirutTime(e.createdAt),'cs'));
    row.appendChild(body); box.appendChild(row);
  });
  var incomplete=Aalayna.published().items.filter(function(x){ return !x.archivedAt&&x.status==='incomplete'; }).length,badge=$('incomplete-badge');
  badge.hidden=!incomplete; badge.textContent='Filters disabled for '+opsCount(incomplete,'item');
}
function paintRecordedRatings(){
  var box=$('rating-rows'); if(!box)return; box.replaceChildren();
  var rows=Aalayna.events().filter(function(e){ return e.eventType==='review_submitted'; }).sort(function(a,b){ return b.createdAt.localeCompare(a.createdAt); }).slice(0,50);
  if(!rows.length){ box.appendChild(opsEl('p','No ratings recorded yet. Guests are asked for a rating after each payment.','ops-empty')); return; }
  rows.forEach(function(e){
    var row=opsEl('div',null,'ops-row'),body=opsEl('div'),destination=e.payload.destination==='google'?'Shared on Google':e.payload.destination==='private'?'Private feedback':'Destination not recorded';
    body.append(opsEl('strong',e.payload.rating+'/5'+(e.tableId?' · Table '+e.tableId:'')),opsEl('p',e.payload.comment||'No comment','cs'),opsEl('p',destination+' · '+opsBeirutTime(e.createdAt),'cs'));
    row.appendChild(body); box.appendChild(row);
  });
}
