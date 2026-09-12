/* Owner reporting over recorded activity. No inferred POS totals or provider events. */
(function(global){
  'use strict';
  var A=global.Aalayna, DAY=86400000, cents=A.util.cents;
  var beirutFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Beirut',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function timestamp(s){ return Date.parse(s.confirmedAt || s.ts); }
  function within(t,w){ return Number.isFinite(t) && t>=w.start && t<w.end; }
  function ratio(n,d){return d ? n/d : null;}
  function beirutParts(at){
    var parts=beirutFormat.formatToParts(new Date(at)),out={};
    parts.forEach(function(p){if(p.type!=='literal')out[p.type]=Number(p.value);});return out;
  }
  function beirutMidnight(at){
    var p=beirutParts(at),target=Date.UTC(p.year,p.month-1,p.day),low=target-DAY,high=target+DAY;
    // Find the first instant of the local date, including a DST jump that skips midnight.
    while(high-low>1){
      var mid=Math.floor((low+high)/2),q=beirutParts(mid),date=Date.UTC(q.year,q.month-1,q.day);
      if(date<target)low=mid;else high=mid;
    }
    return high;
  }
  A.ownerWindow=function(range,at){
    at=at==null?Date.now():at;
    var start=range==='today'?beirutMidnight(at):at-(range==='30'?30:7)*DAY;
    return {start:start,end:at+1,label:range==='today'?'Today':range==='30'?'Last 30 days':'Last 7 days'};
  };
  A.ownerReport=function(range,at){
    at=at==null?Date.now():at;
    var w=A.ownerWindow(range,at),previous={start:w.start-(w.end-w.start),end:w.start};
    var records=A.settlements().filter(function(s){return s.venueId===A.venueId();});
    var confirmed=records.filter(function(s){return A.isConfirmed(s)&&timestamp(s)<=at;});
    var profiles=A.customerProfiles(),checks=A.serviceChecks();
    function summary(window){
      var payments=confirmed.filter(function(s){return within(timestamp(s),window);});
      var billIds=new Set(),identified=new Set(),net=0,tips=0,rails={cash:0,card:0,whish:0};
      payments.forEach(function(s){
        net+=cents(s.amount)-cents(s.tip||0);tips+=cents(s.tip||0);rails[s.rail]+=cents(s.amount);
        if(s.checkId){billIds.add(s.checkId);if(s.customerId)identified.add(s.checkId);}
      });
      var completed=checks.filter(function(c){
        if(!within(Date.parse(c.closedAt),window))return false;
        var paid=confirmed.filter(function(s){return s.checkId===c.id;}).reduce(function(n,s){return n+cents(s.amount)-cents(s.tip||0);},0);
        return paid>=c.totalCents;
      });
      var contacts=0,optedIn=0,withdrawals=0;
      var validPayments=new Set(confirmed.map(function(s){return s.id;}));
      profiles.forEach(function(g){
        var receipts=(g.consentHistory||[]).filter(function(h){return h.source==='receipt'&&h.receipt&&validPayments.has(h.settlementId)&&within(Date.parse(h.at),window);}).sort(function(a,b){return Date.parse(a.at)-Date.parse(b.at);});
        if(receipts.length){contacts++;if(receipts[receipts.length-1].marketing)optedIn++;}
        if((g.consentHistory||[]).some(function(h,i,all){return !h.marketing&&within(Date.parse(h.at),window)&&all.slice(0,i).some(function(earlier){return earlier.marketing;});}))withdrawals++;
      });
      // Shift first-visit dates back 30 days so every guest has a complete follow-up window.
      var cohort={start:window.start-30*DAY,end:window.end-30*DAY},eligible=0,returners=0;
      profiles.forEach(function(g){
        var first=Date.parse(g.first);
        if(!within(first,cohort))return;
        eligible++;
        if(g.history.slice(1).some(function(v){var t=Date.parse(v.at);return t>first&&t<=first+30*DAY&&t<=at;}))returners++;
      });
      return {netCents:net,tipCents:tips,grossCents:net+tips,rails:rails,paymentCount:payments.length,
        bills:billIds.size,identifiedBills:identified.size,captureRate:ratio(identified.size,billIds.size),
        completedBills:completed.length,averageBillCents:completed.length?Math.round(completed.reduce(function(n,c){return n+c.totalCents;},0)/completed.length):null,
        receiptContacts:contacts,marketingContacts:optedIn,optInRate:ratio(optedIn,contacts),withdrawals:withdrawals,
        cohort:cohort,eligibleReturners:eligible,returners:returners,returnRate:ratio(returners,eligible)};
    }
    return {window:w,previousWindow:previous,current:summary(w),previous:summary(previous)};
  };
  /* ---- dashboard v2: everything below is computed from the event stream ---- */
  function median(list){ if(!list.length)return null; var a=list.slice().sort(function(x,y){return x-y;}),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  A.eventMetrics=function(range,at){
    at=at==null?Date.now():at;
    var w=A.ownerWindow(range,at), events=A.events().filter(function(e){ return within(Date.parse(e.createdAt),w); });
    var byType={}; events.forEach(function(e){ (byType[e.eventType]=byType[e.eventType]||[]).push(e); });
    function sessions(type){ var s=new Set(); (byType[type]||[]).forEach(function(e){ s.add(e.sessionId); }); return s; }
    var scans=sessions('qr_scan'), paid=sessions('payment_completed'), paidScanned=0;
    paid.forEach(function(id){ if(scans.has(id))paidScanned++; });
    // viewed, never on a bill: views per item vs. items on any order in the window
    var ordered=new Set(); (byType.order_placed||[]).forEach(function(e){ (e.payload.items||[]).forEach(function(i){ ordered.add(i.itemId); }); });
    var views={}; (byType.item_view||[]).forEach(function(e){ var id=e.payload.itemId; if(id)views[id]=(views[id]||0)+1; });
    var names={}; A.published().items.forEach(function(x){ names[x.id]=x.name; });
    var neverOrdered=Object.keys(views).filter(function(id){ return !ordered.has(id); })
      .map(function(id){ return {itemId:id,name:names[id]||id,views:views[id]}; })
      .sort(function(a,b){ return b.views-a.views; }).slice(0,10);
    // cash vs digital, on the normalised amount
    var rails={cash:0,card:0,whish:0,other:0}, payments=byType.payment_completed||[];
    payments.forEach(function(e){ var r=rails.hasOwnProperty(e.payload.rail)?e.payload.rail:'other'; rails[r]+=cents(e.payload.amountUsd==null?e.payload.amount:e.payload.amountUsd); });
    var digital=rails.card+rails.whish, total=digital+rails.cash+rails.other;
    // repeat devices: a session whose device was seen before that session started
    var firstSeen={}; A.events().forEach(function(e){ var t=Date.parse(e.createdAt); if(firstSeen[e.deviceId]==null||t<firstSeen[e.deviceId])firstSeen[e.deviceId]=t; });
    var sessionStart={}, sessionDevice={};
    events.forEach(function(e){ var t=Date.parse(e.createdAt); if(sessionStart[e.sessionId]==null||t<sessionStart[e.sessionId]){sessionStart[e.sessionId]=t;sessionDevice[e.sessionId]=e.deviceId;} });
    var sessionIds=Object.keys(sessionStart), repeat=sessionIds.filter(function(id){ return firstSeen[sessionDevice[id]]<sessionStart[id]; }).length;
    // bill requested -> first payment in the same session
    var firstBill={}, firstPay={};
    (byType.bill_requested||[]).forEach(function(e){ var t=Date.parse(e.createdAt); if(firstBill[e.sessionId]==null||t<firstBill[e.sessionId])firstBill[e.sessionId]=t; });
    payments.forEach(function(e){ var t=Date.parse(e.createdAt); if(firstPay[e.sessionId]==null||t<firstPay[e.sessionId])firstPay[e.sessionId]=t; });
    var gaps=Object.keys(firstBill).filter(function(id){ return firstPay[id]!=null&&firstPay[id]>=firstBill[id]; }).map(function(id){ return firstPay[id]-firstBill[id]; });
    var identified=payments.filter(function(e){ return !!e.customerId; }).length;
    return {window:w, scans:scans.size, paidSessions:paidScanned, conversion:ratio(paidScanned,scans.size),
      neverOrdered:neverOrdered, rails:rails, digitalShare:ratio(digital,total), cashShare:ratio(rails.cash,total),
      sessions:sessionIds.length, repeatSessions:repeat, repeatRate:ratio(repeat,sessionIds.length),
      medianBillToPaymentMs:median(gaps), timedSessions:gaps.length,
      payments:payments.length, identifiedPayments:identified, captureRate:ratio(identified,payments.length)};
  };
  /* ---- how guests use the interface, from ui_action events, per session (last choice wins) ---- */
  A.uiUsage=function(range,at){
    at=at==null?Date.now():at;
    var w=A.ownerWindow(range,at), last={};
    A.events().forEach(function(e){
      if(e.eventType!=='ui_action'||!within(Date.parse(e.createdAt),w))return;
      var a=e.payload.action, key=e.sessionId+'|'+a;
      if(a==='filter'||a==='option'){ var c=last[key]=last[key]||{action:a,values:{}}; c.values[e.payload.value]=(c.values[e.payload.value]||0)+1; }
      else last[key]={action:a,value:e.payload.value};
    });
    var out={};
    Object.keys(last).forEach(function(k){
      var r=last[k], bucket=out[r.action]=out[r.action]||{sessions:0,values:{}};
      bucket.sessions++;
      if(r.values)Object.keys(r.values).forEach(function(v){ bucket.values[v]=(bucket.values[v]||0)+1; });
      else bucket.values[r.value]=(bucket.values[r.value]||0)+1;
    });
    return out;
  };
  /* ---- data-health check (spec §9): one row per restaurant per ISO week ---- */
  function isoWeek(at){
    var d=new Date(at); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));
    var y=d.getUTCFullYear(), n=Math.ceil(((d-Date.UTC(y,0,1))/DAY+1)/7);
    return y+'-W'+(n<10?'0':'')+n;
  }
  A.healthReport=function(at){
    at=at==null?Date.now():at;
    var items=A.published().items.filter(function(x){ return !x.archivedAt; }), events=A.events(), since30=at-30*DAY;
    var viewed=new Set(); events.forEach(function(e){ if(e.eventType==='item_view'&&Date.parse(e.createdAt)>=since30)viewed.add(e.payload.itemId); });
    var archived={}; A.published().items.forEach(function(x){ if(x.archivedAt)archived[x.id]=1; });
    var ordersOnArchived=events.filter(function(e){ return e.eventType==='order_placed'&&Date.parse(e.createdAt)>=since30&&(e.payload.items||[]).some(function(i){ return archived[i.itemId]&&Date.parse(e.createdAt)>=Date.parse(A.published().items.filter(function(x){return x.id===i.itemId;})[0].archivedAt); }); }).length;
    var payments=events.filter(function(e){ return e.eventType==='payment_completed'&&Date.parse(e.createdAt)>=since30; });
    var identified=payments.filter(function(e){ return !!e.customerId; }).length;
    var rate=A.rateInfo(at), menuAt=Date.parse(A.published().at||'')||null;
    var recentPayments=payments.length>0, menuStale=!!menuAt&&recentPayments&&(at-menuAt)>=60*DAY;
    var checks=[
      {key:'incomplete_items',label:'Items without an ingredient record (filters disabled)',value:items.filter(function(x){ return x.status==='incomplete'; }).length,flag:items.some(function(x){ return x.status==='incomplete'; })},
      {key:'unviewed_items',label:'Items with no views in 30 days',value:items.filter(function(x){ return !viewed.has(x.id); }).length,flag:events.some(function(e){ return e.eventType==='item_view'; })&&items.some(function(x){ return !viewed.has(x.id); })},
      {key:'stale_rate',label:'Exchange rate not updated in 14 days',value:rate.ageDays==null?'never set':rate.ageDays+' days',flag:rate.stale},
      {key:'orders_on_archived',label:'Orders referencing archived items (bug signal)',value:ordersOnArchived,flag:ordersOnArchived>0},
      {key:'identity_capture',label:'Identity capture rate, 30 days',value:payments.length?Math.round(100*identified/payments.length)+'%':'no payments',flag:payments.length>0&&identified/payments.length<0.1},
      {key:'menu_untouched',label:'Menu untouched for 60+ days at an active restaurant',value:menuAt?Math.floor((at-menuAt)/DAY)+' days':'unknown',flag:menuStale}
    ];
    return {restaurantId:A.venueId(),restaurant:A.venue().name,week:isoWeek(at),at:new Date(at).toISOString(),checks:checks,issues:checks.filter(function(c){ return c.flag; }).length};
  };
  /* the "weekly cron": whoever opens a dashboard runs it; one row per week survives */
  A.recordHealth=function(at){
    var report=A.healthReport(at), rows=A.util.read('aal.health_reports',[]);
    var i=rows.findIndex(function(r){ return r.restaurantId===report.restaurantId&&r.week===report.week; });
    if(i<0)rows.push(report);else rows[i]=report;
    A.util.write('aal.health_reports',rows.slice(-520));
    return report;
  };
  A.healthReports=function(){ return A.util.read('aal.health_reports',[]); };
  A.ownerPaymentHistory=function(range,at){
    var w=A.ownerWindow(range,at);
    return A.settlements().filter(function(s){return s.venueId===A.venueId()&&A.settlementStatus(s)!=='pending'&&within(timestamp(s),w);});
  };
})(window);
