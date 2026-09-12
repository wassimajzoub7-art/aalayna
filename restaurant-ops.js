/* Owner UI. Data writes are local; nothing in this file sends messages. */
var selectedGrowthCustomer = null;
var ownerReportSnapshot = null;
function opsReport(){return ownerReportSnapshot || Aalayna.ownerReport($('report-period').value);}
function opsPercent(value){return value==null?'—':(value*100).toFixed(1)+'%';}
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
function paintGrowth() { paintGrowthCustomers();paintGrowthCampaigns();paintAudience();paintGrowthWeek();paintCheckBalances();paintDishInterest();paintGuestJourney();paintDataHealth();paintFeedbackAttention();paintRecordedRatings(); }
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
      var rate=function(g){return g.rate==null?'—':(g.rate*100).toFixed(1)+'%';};
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
  if(!active.length)box.appendChild(opsEl('p',checks.length?'All recorded bills are closed. No outstanding balances.':'No bills recorded yet. Opening the guest experience creates a sample bill; a live POS connection will supply real checks.','ops-empty'));
  active.forEach(function(c){var b=Aalayna.checkBalance(c.id),row=opsEl('article',null,'ops-row'),body=opsEl('div');
    var head=opsEl('div',null,'ops-heading');head.appendChild(opsEl('h3','Table '+c.table));
    var state=c.closedAt?(b.remainingCents?'Review refund':'Closed'):(b.pendingCents?'Cash pending':(b.remainingCents?'Open':'Ready to close'));
    head.appendChild(opsEl('span',state,'status-badge '+(b.pendingCents?'pending':c.closedAt?'draft':'approved')));body.appendChild(head);
    var balance=opsEl('p',null,'bill-balance');balance.append(opsEl('strong',money(b.remainingCents/100)),opsEl('span',' outstanding'));body.appendChild(balance);
    body.appendChild(opsEl('p','Collected '+money(b.confirmedCents/100)+' of '+money(c.totalCents/100),'cs'));
    if(b.pendingCents)body.appendChild(opsEl('p',money(b.pendingCents/100)+' awaiting cash · '+money(b.availableCents/100)+' available to pay','cs'));
    var detail=opsEl('details',null,'ops-help');detail.appendChild(opsEl('summary','Bill details'));detail.appendChild(opsEl('p','Opened '+opsDate(c.openedAt)+' · bill '+c.id.slice(-8)+' · Cash '+money(b.methods.cash/100)+' · Whish '+money(b.methods.whish/100)+' · Card '+money(b.methods.card/100)+' · Tips '+money(b.tipCents/100),'cs'));body.appendChild(detail);row.appendChild(body);
    if(!c.closedAt&&!b.remainingCents&&!b.pendingCents)row.appendChild(opsButton('Close settled bill',function(){Aalayna.closeServiceCheck(c.id);toast('Bill closed. The next guest session can open a new bill.');}));box.appendChild(row);
  });
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
  $('dish-period').textContent=w.label+' · which dishes guests open, how long they look, and whether the dish reaches a bill. From recorded events on this device.';
  body.replaceChildren();
  var seen=rows.filter(function(r){ return r.opens>0; }), unseen=rows.filter(function(r){ return r.opens===0; });
  seen.slice(0,25).forEach(function(r){ var tr=opsEl('tr'); [r.name,String(r.opens),String(r.sessions),r.avgDwellS==null?'—':r.avgDwellS+' s',String(r.onBills),r.billRate==null?'—':Math.round(r.billRate*100)+'%'].forEach(function(t,i){ tr.appendChild(opsEl('td',t,i?'num':null)); }); body.appendChild(tr); });
  if(!seen.length){ var tr=opsEl('tr'); var td=opsEl('td','No dish opened yet in this period. Rows appear as guests browse the menu on their phones.','ops-empty'); td.colSpan=6; tr.appendChild(td); body.appendChild(tr); }
  $('dish-none').textContent=unseen.length?'Not opened at all in this period: '+unseen.slice(0,12).map(function(r){ return r.name; }).join(', ')+(unseen.length>12?' and '+(unseen.length-12)+' more':'')+'.':'';
}
function paintGuestJourney(){
  var box=$('journey-metrics'); if(!box)return;
  var m=Aalayna.eventMetrics($('report-period').value); box.replaceChildren();
  $('journey-period').textContent=m.window.label+' · from QR scan to payment, computed from recorded events.';
  box.appendChild(opsMetric('Scan to payment',opsPercent(m.conversion),opsCount(m.paidSessions,'paid session')+' of '+opsCount(m.scans,'scan')));
  box.appendChild(opsMetric('Repeat devices',opsPercent(m.repeatRate),m.repeatSessions+' of '+opsCount(m.sessions,'session')+' from a device seen before'));
  var total=m.rails.cash+m.rails.card+m.rails.whish+m.rails.other, digital=m.rails.card+m.rails.whish;
  box.appendChild(opsMetric('Cash vs digital',m.digitalShare==null?'—':Math.round(m.cashShare*100)+'% / '+Math.round(m.digitalShare*100)+'%',total?'Cash '+money(m.rails.cash/100)+', digital '+money(digital/100)+' of '+money(total/100)+' collected':'No collected amount in this period'));
  box.appendChild(opsMetric('Bill to payment',m.medianBillToPaymentMs==null?'—':opsDuration(m.medianBillToPaymentMs),m.timedSessions?'Median across '+opsCount(m.timedSessions,'timed session')+', bill opened to first payment':'No timed sessions yet'));
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
