/* Owner UI. Data writes are local; nothing in this file sends messages. */
var selectedGrowthCustomer = null;
function opsEl(tag, text, cls) { var n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n; }
function opsButton(label, fn) { var b=opsEl('button',label,'btn');b.type='button';b.onclick=function(){try{fn();}catch(e){toast(e.message);}};return b; }
function opsDate(value) { return value ? new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : 'No confirmed visit'; }
function opsMask(contact) { if(contact.indexOf('@')>=0){var p=contact.split('@');return p[0].slice(0,2)+'***@'+p[1];}return '•••• '+contact.slice(-4); }
function opsGo(view) { var nav=Array.from(document.querySelectorAll('.ni')).find(function(n){return (n.getAttribute('onclick')||'').indexOf("'"+view+"'")>=0;}); if(nav)go(nav,view); }
function opsDownload(name, text, type) { var url=URL.createObjectURL(new Blob([text],{type:type})),a=opsEl('a');a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000); }
function paintGrowth() { paintGrowthCustomers();paintGrowthCampaigns();paintAudience();paintGrowthWeek();paintCheckBalances(); }
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
    try{var file=input.files[0];if(!file)return;if(file.size>1000000)throw new Error('Choose a delivery report smaller than 1 MB.');var rows=JSON.parse(await file.text());Aalayna.recordCampaignDeliveries(id,rows);toast('Delivery report recorded; no messages sent by 3alayna.');}
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
      card.appendChild(opsEl('p',report.delivered.size+' reported deliveries · '+report.delivered.returners+' contacts returned after delivery · '+money(report.delivered.spendCents/100)+' linked return spending','ops-history'));
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
  var w=Aalayna.weeklySummary();$('week-net').textContent=money(w.netCents/100);$('week-tips').textContent=money(w.tipCents/100);$('week-checks').textContent=w.checks;$('week-identified').textContent=w.identifiedChecks;
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
  $('live-paid').textContent=money(Aalayna.settledTotal());
  if(!checks.length)box.appendChild(opsEl('p','No bills recorded yet. Opening the guest experience creates a sample bill; a live POS connection will supply real checks.','ops-empty'));
  checks.forEach(function(c){var b=Aalayna.checkBalance(c.id),row=opsEl('article',null,'ops-row'),body=opsEl('div');
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
