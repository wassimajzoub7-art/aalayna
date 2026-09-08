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
  A.ownerPaymentHistory=function(range,at){
    var w=A.ownerWindow(range,at);
    return A.settlements().filter(function(s){return s.venueId===A.venueId()&&A.settlementStatus(s)!=='pending'&&within(timestamp(s),w);});
  };
})(window);
