/* The Insights tab of dashboard.html: paints A.venueInsights (owner-insights.js) into #insights-body.
   Read-only: nothing here writes or sends. In the no-key demo at Mayda it adds the sample history
   of insights-demo.js (never stored) and says so on the page. Uses the dashboard's $, money, opsEl. */
var insightsDirty = true;
var INS_FAMILY = { dishes: 'Dishes', diet: 'Diet and allergens', traffic: 'Time and traffic', money: 'Money and guests' };
var INS_SHOWN = 6;   // findings shown before "More findings"
var insightsDemoCache = { key: null, events: null };
function insSample(){
  var A = Aalayna;
  if (!A.demoMode || !A.demoMode() || !A.demoInsightEvents || A.venue().name !== 'Mayda') return null;
  var at = Date.now(), m = A.published(), key = A.venueId() + '|' + new Date(at).toISOString().slice(0, 10) + '|' + m.items.map(function(x){ return x.id + (x.archivedAt ? 'x' : ''); }).join(',');
  if (insightsDemoCache.key !== key) insightsDemoCache = { key: key, events: A.demoInsightEvents({ items: m.items, tables: insTables(), at: at, venueId: A.venueId() }) };
  return insightsDemoCache.events;
}
/* the tables of the floor plan the dashboard draws (FL_DEFAULT), so a table with no scan shows too */
function insTables(){ try { return Object.keys(FL_DEFAULT); } catch (e) { return []; } }
function insEl(tag, text, cls){ return opsEl(tag, text, cls); }
function insTable(head, rows, numFrom){
  var wrap = insEl('div', null, 'ins-scroll'), t = insEl('table', null, 'dish-table'), th = insEl('thead'), tr = insEl('tr'), tb = insEl('tbody');
  head.forEach(function(h, i){ tr.appendChild(insEl('th', h, i >= numFrom ? 'num' : null)); });
  th.appendChild(tr); t.appendChild(th);
  rows.forEach(function(r){ var row = insEl('tr'); r.forEach(function(c, i){ row.appendChild(insEl('td', c, i >= numFrom ? 'num' : null)); }); tb.appendChild(row); });
  t.appendChild(tb); wrap.appendChild(t); return wrap;
}
function insCard(title, note){ var c = insEl('div', null, 'card mt'); c.appendChild(insEl('h3', title)); if (note) c.appendChild(insEl('div', note, 'cs')); return c; }
function insBars(values, labels, fmt){
  var box = insEl('div', null, 'ins-bars'), max = Math.max.apply(null, values.map(function(v){ return v || 0; })) || 1;
  values.forEach(function(v, i){
    var col = insEl('div', null, 'ins-bar'), fill = insEl('span', null, 'ins-fill');
    fill.style.height = Math.max(2, Math.round(100 * (v || 0) / max)) + '%';
    col.title = labels[i] + ': ' + (v == null ? 'no data' : fmt(v));
    col.append(insEl('span', v == null ? '–' : fmt(v), 'ins-val'), insEl('span', null, 'ins-track'), insEl('span', labels[i], 'ins-lab'));
    col.children[1].appendChild(fill);
    box.appendChild(col);
  });
  return box;
}
function insRow(label, value){ var r = insEl('div', null, 'journey-item'); r.append(insEl('span', label), insEl('strong', value)); return r; }
function insPct(x){ return x == null ? '–' : Math.round(x * 100) + '%'; }
function insDuration(ms){ return ms == null ? '–' : opsDuration(ms); }
function insFinding(f){
  var b = insEl('article', null, 'ins-item');
  var tags = insEl('div', null, 'ins-tags');
  tags.appendChild(insEl('span', INS_FAMILY[f.family] || f.family, 'ins-tag'));
  if (f.early) tags.appendChild(insEl('span', 'Early signal', 'ins-tag early'));
  b.append(tags, insEl('h3', f.headline), insEl('p', f.text, 'ins-text'));
  var act = insEl('p', null, 'ins-action'); act.append(insEl('b', 'Suggested: '), document.createTextNode(f.action)); b.appendChild(act);
  b.appendChild(insEl('p', f.rule, 'ins-rule'));
  return b;
}
/* ---- shared mode: the period's events come from the server (supabase/insights-2026-11-24.sql,
   aal_insights_events), one read per venue and period, kept in this variable only: never in
   localStorage, where a full store keeps 200 events. Without that function on the server (404)
   the tab falls back to the events this device holds, and says so. ---- */
var insightsServer = { key: null, status: null, data: null, error: null, at: null, pending: null };
function insShared(){ var s = Aalayna.sync; return !!(s && s.enabled && !(Aalayna.demoMode && Aalayna.demoMode()) && !(s.state && s.state().role === 'waiter')); }
function insRpc(fn, args){
  var A = Aalayna, cfg = window.AalaynaConfig || {}, key = A.sync.key && A.sync.key();
  if (A.sync.signedIn && window.AalaynaAuth) return window.AalaynaAuth.rpc(fn, args);
  if (!key) return Promise.reject(new Error('Open the dashboard with your owner link, or sign in.'));
  return fetch(String(cfg.supabaseUrl || '').replace(/\/$/, '') + '/rest/v1/rpc/' + fn, { method: 'POST',
    headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'x-aalayna-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    .then(function(r){ return r.text().then(function(t){
      var j = null; try { j = t ? JSON.parse(t) : null; } catch (ignore) {}
      if (!r.ok) { var e = new Error((j && j.message) || 'The shared store answered ' + r.status + '.'); e.status = r.status; throw e; }
      return j; }); });
}
function insFetch(days, force){
  var key = Aalayna.venueId() + '|' + days;
  if (!force && insightsServer.key === key && (insightsServer.status || insightsServer.pending)) return insightsServer.pending || Promise.resolve();
  var at = Date.now(), job = { key: key, status: null, data: null, error: null, at: at, pending: null };
  insightsServer = job;
  job.pending = insRpc('aal_insights_events', { p_rid: Aalayna.venueId(), p_body: { since: new Date(at - days * 86400000).toISOString(), until: new Date(at).toISOString() } })
    .then(function(res){
      if (!res || res.version !== 1 || !Array.isArray(res.events)) throw new Error('The shared store answered in an unknown form.');
      job.status = 'ok'; job.data = res;
    }, function(e){ job.status = e && e.status === 404 ? 'missing' : 'error'; job.error = e && e.message ? e.message : String(e); })
    .then(function(){ job.pending = null; if (insightsServer === job) paintInsights(); });
  return job.pending;
}
function insRefresh(){ insFetch(Number(($('ins-period') || {}).value) || 30, true); paintInsights(); }
function paintInsights(){
  var body = $('insights-body'); if (!body) return;
  if (!$('v-insights').classList.contains('on')) { insightsDirty = true; return; }
  insightsDirty = false;
  var days = Number(($('ins-period') || {}).value) || 30, sample = insSample(), shared = insShared(), srv = null;
  if (shared) {
    insFetch(days, false);
    if (insightsServer.pending && !insightsServer.status) { body.replaceChildren(insEl('p', 'Reading this period’s activity from the shared store…', 'ops-empty')); return; }
    if (insightsServer.status === 'ok') srv = insightsServer.data;
  }
  var r = Aalayna.venueInsights({ days: days, tables: insTables(), extraEvents: sample || [], server: srv, at: srv ? insightsServer.at : undefined });
  body.replaceChildren();
  /* coverage: how much is behind the findings */
  var cov = insEl('div', null, 'card ins-cover');
  var head = insEl('div', null, 'ops-heading');
  head.appendChild(insEl('h3', r.daysCollected ? r.daysCollected + (r.daysCollected === 1 ? ' day' : ' days') + ' of recorded activity' : 'No activity recorded yet'));
  head.appendChild(insEl('span', r.early ? 'Early signal' : 'A full month or more', 'status-badge ' + (r.early ? 'pending' : 'approved')));
  cov.appendChild(head);
  cov.appendChild(insEl('p', r.daysCollected ? 'Since ' + r.firstLabel + '. ' + (r.early ? 'Until ' + r.matureDays + ' days are recorded every finding is an early signal: ' + (r.matureDays - r.daysCollected) + ' more to go. ' : '') + 'This period: ' + opsCount(r.counts.sessions, 'session') + ', ' + opsCount(r.counts.opens, 'dish open') + ', ' + opsCount(r.counts.bills, 'bill') + ', ' + opsCount(r.counts.payments, 'payment') + '.' : 'Findings appear as guests scan the table QR codes, open dishes and pay. Each one waits until it has enough data behind it.', 'cs'));
  if (shared) {
    var note = insightsServer.status === 'ok' ? (srv.truncated ? 'This period holds more events than one read carries (' + srv.limit.toLocaleString('en-US') + '); these findings cover the newest of them, from ' + new Date(srv.from).toLocaleDateString('en-GB', { timeZone: 'Asia/Beirut', day: 'numeric', month: 'short' }) + '.' : 'Read from the shared store for this period' + ' (' + opsCount(srv.count, 'event') + ').')
      : insightsServer.status === 'missing' ? 'Insights are limited to what this device holds: the shared store cannot send a period’s activity yet (supabase/insights-2026-11-24.sql is not installed).'
      : 'Insights are limited to what this device holds: the shared store did not answer (' + insightsServer.error + ').';
    var line = insEl('p', null, 'cs ins-source' + (insightsServer.status === 'ok' && !srv.truncated ? '' : ' warn'));
    line.appendChild(document.createTextNode(note + ' '));
    var again = insEl('button', 'Refresh', 'btn'); again.type = 'button'; again.onclick = insRefresh; line.appendChild(again);
    cov.appendChild(line);
  }
  if (sample) cov.appendChild(insEl('p', 'Sample history · six weeks of illustrative guest activity at the fictional Mayda, generated for this demo and mixed with what this browser records. No real guests.', 'sample-notice'));
  body.appendChild(cov);
  if (r.orderNote) { var n = insEl('div', null, 'note warn mt'); n.append(insEl('span', 'ⓘ'), insEl('span', r.orderNote)); body.appendChild(n); }
  /* the findings, most important first */
  var list = insEl('section', null, 'ins-list');
  list.setAttribute('aria-label', 'Findings');
  if (!r.insights.length) list.appendChild(insEl('p', 'Nothing to report yet for this period. The rules waiting for data are listed below, with what each one needs.', 'ops-empty'));
  r.insights.slice(0, INS_SHOWN).forEach(function(f){ list.appendChild(insFinding(f)); });
  if (r.insights.length > INS_SHOWN) {
    var more = insEl('details', null, 'ins-more'); more.appendChild(insEl('summary', 'More findings (' + (r.insights.length - INS_SHOWN) + ')'));
    r.insights.slice(INS_SHOWN).forEach(function(f){ more.appendChild(insFinding(f)); });
    list.appendChild(more);
  }
  body.appendChild(list);
  if (r.waiting.length) {
    var w = insCard('Waiting for more data', 'Each finding appears only once it has enough data behind it.');
    r.waiting.forEach(function(x){ var row = insEl('div', null, 'health-row'); row.append(insEl('span', x.label + ' · needs ' + x.need, 'health-label'), insEl('span', x.have, 'health-value')); w.appendChild(row); });
    body.appendChild(w);
  }
  /* the figures behind them */
  body.appendChild(insEl('h2', 'The figures behind them', 'ins-h2'));
  var T = r.tables, lines = r.hasLines;
  var dc = insCard('Dishes', 'Opened: times guests opened the dish on their phone. On bills: distinct bills with the dish, latest version of each bill. These are separate counts, not a conversion rate. Viewing sessions are not unique people.');
  var dishRows = T.dishes.map(function(d){ return [d.name, d.sectionName, String(d.opens), String(d.sessions), d.avgDwellS == null ? '–' : d.avgDwellS + ' s', lines ? String(d.onBills) : '–']; });
  dc.appendChild(insTable(['Dish', 'Section', 'Opened', 'Sessions', 'Read for', 'On bills'], dishRows.slice(0, 15), 2));
  if (dishRows.length > 15) { var all = insEl('details', null, 'ins-more'); all.appendChild(insEl('summary', 'All ' + dishRows.length + ' dishes')); all.appendChild(insTable(['Dish', 'Section', 'Opened', 'Sessions', 'Read for', 'On bills'], dishRows.slice(15), 2)); dc.appendChild(all); }
  body.appendChild(dc);
  var grid = insEl('div', null, 'grid g2e mt');
  var sc = insEl('div', null, 'card'); sc.append(insEl('h3', 'Sections'), insEl('div', 'Opens and bills of the dishes in each section.', 'cs'));
  sc.appendChild(insTable(['Section', 'Dishes', 'Opened', 'On bills', 'Never opened'], T.sections.map(function(s){ return [s.name, String(s.dishes), String(s.opens), lines ? String(s.onBills) : '–', String(s.unopened)]; }), 1));
  var oc = insEl('div', null, 'card'); oc.append(insEl('h3', 'Options picked'), insEl('div', 'Sessions that picked a choice other than the default, while the dish was open.', 'cs'));
  if (T.options.length) oc.appendChild(insTable(['Option', 'Dish', 'Sessions'], T.options.map(function(o){ return [o.choice + (o.price ? ' (+' + money(o.price) + ')' : ''), o.dish, String(o.sessions) + ' of ' + o.dishSessions]; }), 2));
  else oc.appendChild(insEl('p', 'No option picked in this period.', 'ops-empty'));
  grid.append(sc, oc); body.appendChild(grid);
  var diet = insCard('Diet filters: asked for and offered', 'Share of menu sessions that turned each filter on, and the dishes that fit it as served or with one swap (the guest page’s own rule).' + (T.unknownDiet ? ' ' + opsCount(T.unknownDiet, 'dish') + ' with no confirmed ingredient record count as not fitting.' : ''));
  diet.appendChild(insTable(['Filter', 'Sessions using it', 'Dishes that fit'], T.filters.map(function(f){ return [f.label, f.uses + ' · ' + insPct(f.share), f.fit + ' of ' + f.live]; }), 1));
  body.appendChild(diet);
  var tg = insEl('div', null, 'grid g2e mt');
  var dayCard = insEl('div', null, 'card'); dayCard.append(insEl('h3', 'Sessions on an average weekday'), insEl('div', 'Beirut time. Each weekday is averaged over the days of that weekday in the period.', 'cs'));
  dayCard.appendChild(insBars(T.byWeekday, T.weekdays.map(function(d){ return d.slice(0, 3); }), function(v){ return String(v); }));
  var hourCard = insEl('div', null, 'card'); hourCard.append(insEl('h3', 'Sessions by hour'), insEl('div', 'When the first scan or dish open of a session happened, Beirut time.', 'cs'));
  var hs = [], hl = [], lo = 24, hi = -1;
  T.byHour.forEach(function(n, h){ if (n) { lo = Math.min(lo, h); hi = Math.max(hi, h); } });
  if (hi < 0) { lo = 11; hi = 23; }
  for (var h = lo; h <= hi; h++) { hs.push(T.byHour[h]); hl.push(String(h)); }
  hourCard.appendChild(insBars(hs, hl, function(v){ return String(v); }));
  tg.append(dayCard, hourCard); body.appendChild(tg);
  var tc = insCard('Tables', 'Scans of each table’s QR code, and how long its guests took from asking for the bill to the first payment (median, minutes:seconds).' + (T.payMedianMs != null ? ' Across the room: ' + insDuration(T.payMedianMs) + ', one in ten slower than ' + insDuration(T.payP90Ms) + '.' : ''));
  tc.appendChild(insTable(['Table', 'Scans', 'Timed bills', 'Bill to paid'], T.scans.map(function(t){ return ['Table ' + t.table, String(t.scans), String(t.timed), insDuration(t.medianMs)]; }), 1));
  body.appendChild(tc);
  var mg = insEl('div', null, 'grid g2e mt');
  var pay = insEl('div', null, 'card'); pay.append(insEl('h3', 'Payments'), insEl('div', 'Paid through Aalayna in the period, in US dollars. Not your POS total.', 'cs'));
  var m = T.money;
  pay.appendChild(insRow('Paid bills', String(m.bills)));
  pay.appendChild(insRow('Average bill, before tips', m.bills ? money(m.netUsd / m.bills) : '–'));
  pay.appendChild(insRow('Tips on top', m.netUsd ? Math.round(100 * m.tipsUsd / m.netUsd) + '% · ' + money(m.tipsUsd) : '–'));
  pay.appendChild(insRow('Split into two or more payments', T.split.bills ? Math.round(100 * T.split.split / T.split.bills) + '% · ' + T.split.split + ' of ' + T.split.bills : '–'));
  T.rails.forEach(function(x){ pay.appendChild(insRow(x.label, insPct(x.share) + ' · ' + money(x.amountUsd))); });
  var guests = insEl('div', null, 'card'); guests.append(insEl('h3', 'Guests’ choices'), insEl('div', 'Per session, its last choice. Sessions are not unique people, and a phone is not a person.', 'cs'));
  var sessions = r.counts.sessions;
  T.languages.forEach(function(l){ if (l.lang !== 'en') guests.appendChild(insRow('Switched the menu to ' + l.label, insPct(l.share) + ' · ' + l.sessions)); });
  guests.appendChild(insRow('Switched prices to LBP', sessions ? insPct(T.lbpSessions / sessions) + ' · ' + T.lbpSessions : '–'));
  guests.appendChild(insRow('From a phone seen here before', sessions ? insPct(T.repeatSessions / sessions) + ' · ' + T.repeatSessions : '–'));
  var SPLIT = { even: 'Split: equal shares', item: 'Split: by item', amt: 'Split: a chosen amount', all: 'Split: the whole bill' };
  Object.keys(T.split.choices).sort(function(a, b){ return T.split.choices[b] - T.split.choices[a]; }).forEach(function(k){ guests.appendChild(insRow(SPLIT[k] || 'Split: ' + k, String(T.split.choices[k]))); });
  Object.keys(T.tips).sort(function(a, b){ return T.tips[b] - T.tips[a]; }).slice(0, 5).forEach(function(k){ guests.appendChild(insRow('Tip chosen: ' + k, String(T.tips[k]))); });
  mg.append(pay, guests); body.appendChild(mg);
  body.appendChild(insEl('p', 'Computed on this device from recorded events, with no estimate added. Counts are counts: scans, opens and choices are sent by guests’ phones and may be incomplete, sessions are not unique people, and bills count only when they reach Aalayna. Times are Beirut time.', 'cs ins-foot'));
}
function openInsights(el){ go(el, 'insights'); paintInsights(); }
/* a change to the store repaints the open tab, at most once per burst of writes */
var insightsTimer = null;
Aalayna.on(function(){
  insightsDirty = true;
  if (insightsTimer || !$('v-insights') || !$('v-insights').classList.contains('on')) return;
  insightsTimer = setTimeout(function(){ insightsTimer = null; paintInsights(); }, 150);
});
