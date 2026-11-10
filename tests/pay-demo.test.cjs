/* The fake payment provider's checkout on the site (pay-demo.html), the page payment-start's
   fake adapter sends the guest to. The page's own script runs against a minimal DOM, with
   aalayna-config.js's window.AalaynaConfig and a mocked fetch standing in for
   payment-start/fake/checkout, as tests/guest-provider.test.cjs runs the guest page. Proves that:
   - the page is noindex, sends no referrer, has a CSP, loads only aalayna-config.js and has no
     em dash; it stands in for a third party (no Aalayna styles or scripts besides the config);
   - the function's address comes from AalaynaConfig (functionsUrl, else supabaseUrl +
     /functions/v1), never from the address bar: extra query parameters naming another host
     change nothing, and s is the only parameter the script reads;
   - it shows the amount, venue and reference from the GET answer with textContent (no
     innerHTML anywhere), Pay and Decline POST {s, outcome} and the browser goes to the
     return URL only when it is on the page's own origin;
   - an expired or unreadable link, a load failure and an undelivered callback each show their
     state; the undelivered state retries the same outcome and links back to the bill;
   - the page is outside both service worker scopes and in neither shell. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pay-demo.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const ORIGIN = 'https://aalayna.com';
const SUPA = 'https://proj.supabase.co';
const ROUTE = SUPA + '/functions/v1/payment-start/fake/checkout';
const TOKEN = 'eyJwaWQiOiJwYXktMSJ9.' + 'ab'.repeat(32);
const BACK = ORIGIN + '/guest.html?venue=Mayda&place=Hamra&live=1&pay=pay-1';
const DATA = { paymentId: 'pay-1', amountCents: 2200, currency: 'USD', venue: 'Mayda', rail: 'card', returnUrl: BACK, expiresAt: new Date(Date.now() + 600000).toISOString() };

function makeDom() {
  const byId = new Map();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const hiddenAtStart = new Set([...html.matchAll(/<[a-z]+ [^>]*id="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
  for (const id of ids) {
    const listeners = {}, attrs = {};
    const el = {
      id, hidden: hiddenAtStart.has(id), disabled: false, href: '', focused: 0, listeners,
      set textContent(v) { this._text = String(v); }, get textContent() { return this._text || ''; },
      set innerHTML(v) { throw new Error('innerHTML written on #' + id); },
      addEventListener(t, f) { listeners[t] = f; }, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] == null ? null : attrs[k]; },
      focus() { this.focused++; }, click() { if (listeners.click) listeners.click({}); },
      querySelector(sel) { return sel === '.lead' ? byId.get(id + '.lead') || null : null; },
    };
    byId.set(id, el);
    if (id.startsWith('st-')) byId.set(id + '.lead', { focus() { el.focused++; } });
  }
  return { byId, document: { getElementById: (id) => byId.get(id) || null } };
}

/* a mocked payment-start: answers is {get, post} -> {status, body} or a thrown error */
function boot({ search = '?s=' + TOKEN, config = { supabaseUrl: SUPA + '/', anonKey: 'anon' }, get = { status: 200, body: DATA }, post = { status: 200, body: { returnUrl: BACK, outcome: 'paid' } }, origin = ORIGIN } = {}) {
  const { byId, document } = makeDom();
  const calls = [], replaced = [], assigned = [], timers = [];
  const answers = { get, post };
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const a = (init.method || 'GET') === 'GET' ? answers.get : answers.post;
    const out = typeof a === 'function' ? a(calls.at(-1)) : a;
    if (out instanceof Error) throw out;
    return { ok: out.status < 300, status: out.status, text: async () => (out.body == null ? '' : JSON.stringify(out.body)) };
  };
  const location = { origin, search, href: origin + '/pay-demo.html' + search, replace(u) { replaced.push(u); }, assign(u) { assigned.push(u); } };
  const window = { AalaynaConfig: config };
  const ctx = { window, document, location, fetch, URL, URLSearchParams, JSON, Number, Date, Math, String, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {}, console };
  vm.createContext(ctx);
  scripts.forEach((s) => vm.runInContext(s, ctx));
  const $ = (id) => byId.get(id);
  const shown = () => ['loading', 'ready', 'invalid', 'offline', 'undelivered'].filter((s) => !$('st-' + s).hidden);
  return { $, calls, replaced, assigned, answers, shown, timers };
}

test('pay-demo.html: noindex, no referrer, a CSP, self-contained, only aalayna-config.js, no em dash, no innerHTML', () => {
  assert.match(html, /<meta name="robots" content="noindex[^"]*">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1];
  assert.ok(csp, 'a CSP');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co/);
  assert.match(csp, /form-action 'none'/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]), ['aalayna-config.js']);
  assert.ok(!/<link\b|@import|https?:\/\/(?!\*\.supabase)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external stylesheet, font or script');
  assert.ok(!/—|&mdash;|&#8212;/.test(html), 'no em dash');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(scripts.join('\n')), 'no HTML written from script');
  assert.match(html, /<title>Demo payment provider<\/title>/);
  assert.match(html, /No money moves and no card is asked for\./);
  assert.ok(!/aalayna-store|aalayna-sync|website\.css|restaurant-ops|fonts\.googleapis/.test(html.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '')), 'not the Aalayna app');
});

test('the function address comes from AalaynaConfig, never from the query; s is the only parameter read', async () => {
  const src = scripts.join('\n');
  assert.deepEqual([...src.matchAll(/\.get\('([^']+)'\)/g)].map((m) => m[1]), ['s']);
  assert.equal((src.match(/location\.search/g) || []).length, 1);
  assert.match(src, /cfg\.functionsUrl \|\| \(cfg\.supabaseUrl \?/);
  // a hostile query changes nothing
  let p = boot({ search: '?s=' + TOKEN + '&functionsUrl=https://evil.example&supabaseUrl=https://evil.example&fn=https://evil.example' });
  await flush();
  assert.deepEqual(p.calls.map((c) => c.url), [ROUTE + '?s=' + encodeURIComponent(TOKEN)]);
  // functionsUrl wins when set, as in aalayna-sync.js
  p = boot({ config: { supabaseUrl: SUPA, functionsUrl: 'http://127.0.0.1:54321/functions/v1/' } });
  await flush();
  assert.equal(p.calls[0].url, 'http://127.0.0.1:54321/functions/v1/payment-start/fake/checkout?s=' + encodeURIComponent(TOKEN));
  // no config: nothing is fetched
  p = boot({ config: null });
  await flush();
  assert.equal(p.calls.length, 0);
  assert.deepEqual(p.shown(), ['invalid']);
  assert.match(p.$('invalid-msg').textContent, /not set up/);
});

test('ready: amount, venue and reference as text; Pay posts {s, outcome} and goes back to the bill on this origin', async () => {
  const p = boot();
  assert.deepEqual(p.shown(), ['loading']);
  await flush();
  assert.deepEqual(p.shown(), ['ready']);
  assert.equal(p.$('amt').textContent, '$22.00');
  assert.equal(p.$('pay-amt').textContent, '$22.00');
  assert.equal(p.$('venue').textContent, 'Mayda');
  assert.equal(p.$('ref').textContent, 'pay-1');
  assert.equal(p.$('back').href, BACK);
  assert.equal(p.calls[0].init.credentials, 'omit');
  p.$('pay').click();
  assert.equal(p.$('pay').disabled, true);
  assert.equal(p.$('decline').disabled, true);
  assert.match(p.$('status').textContent, /Sending/);
  p.$('pay').click();                                   // a second tap while sending does nothing
  await flush();
  const posts = p.calls.filter((c) => c.init.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, ROUTE);
  assert.deepEqual(posts[0].body, { s: TOKEN, outcome: 'paid' });
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(p.replaced, [BACK]);
  assert.deepEqual(p.assigned, []);
  // Decline is outcome failed; another currency reads after the amount; the venue is text, not markup
  const q = boot({ get: { status: 200, body: Object.assign({}, DATA, { currency: 'LBP', amountCents: 150000, venue: '<img src=x onerror=alert(1)>' }) } });
  await flush();
  assert.equal(q.$('amt').textContent, '1500.00 LBP');
  assert.equal(q.$('venue').textContent, '<img src=x onerror=alert(1)>');
  q.$('decline').click();
  await flush();
  assert.deepEqual(q.calls.at(-1).body, { s: TOKEN, outcome: 'failed' });
  assert.deepEqual(q.replaced, [BACK]);
});

test('the same-origin guard: a return URL on another origin is never followed, from GET or from POST', async () => {
  for (const bad of ['https://evil.example/guest.html?pay=pay-1', 'https://aalayna.com.evil.example/guest.html', 'javascript:alert(1)', '/guest.html?pay=pay-1', 'http://aalayna.com/guest.html', '', null]) {
    const p = boot({ get: { status: 200, body: Object.assign({}, DATA, { returnUrl: bad }) } });
    await flush();
    assert.deepEqual(p.shown(), ['invalid'], String(bad));
    assert.match(p.$('invalid-msg').textContent, /cannot send you back/);
    assert.equal(p.$('back').href, '', 'no link back to ' + bad);
    p.$('pay').click();
    await flush();
    assert.equal(p.calls.filter((c) => c.init.method === 'POST').length, 0, 'nothing posted for ' + bad);
    const q = boot({ post: { status: 200, body: { returnUrl: bad, outcome: 'paid' } } });
    await flush();
    q.$('pay').click();
    await flush();
    assert.deepEqual(q.replaced, [], String(bad));
    assert.deepEqual(q.assigned, []);
    assert.deepEqual(q.shown(), ['invalid']);
  }
  // the page on the rehearsal server: its own origin is the one it accepts
  const local = 'http://127.0.0.1:8788';
  const r = boot({ origin: local, get: { status: 200, body: Object.assign({}, DATA, { returnUrl: local + '/guest.html?pay=pay-1' }) }, post: { status: 200, body: { returnUrl: local + '/guest.html?pay=pay-1' } } });
  await flush();
  r.$('pay').click();
  await flush();
  assert.deepEqual(r.replaced, [local + '/guest.html?pay=pay-1']);
});

test('states: an unreadable token fetches nothing; expired is 404; a failed load offers a retry; an undelivered callback retries the same outcome and links back', async () => {
  for (const search of ['', '?s=', '?s=not-a-token', '?x=' + TOKEN]) {
    const p = boot({ search });
    await flush();
    assert.equal(p.calls.length, 0, search);
    assert.deepEqual(p.shown(), ['invalid']);
    assert.match(p.$('invalid-msg').textContent, /not complete/);
  }
  let p = boot({ get: { status: 404, body: { error: 'expired', status: 'expired' } } });
  await flush();
  assert.deepEqual(p.shown(), ['invalid']);
  assert.match(p.$('invalid-msg').textContent, /has expired/);
  p = boot({ get: new TypeError('Failed to fetch') });
  await flush();
  assert.deepEqual(p.shown(), ['offline']);
  p.answers.get = { status: 200, body: DATA };
  p.$('reload').click();
  await flush();
  assert.deepEqual(p.shown(), ['ready']);
  // the callback could not be delivered: Decline, then retry sends Decline again
  p = boot({ post: { status: 502, body: { error: 'The payment could not be reported to Aalayna.', returnUrl: BACK } } });
  await flush();
  p.$('decline').click();
  await flush();
  assert.deepEqual(p.shown(), ['undelivered']);
  assert.equal(p.$('back').hidden, false);
  assert.equal(p.$('back').href, BACK);
  assert.equal(p.$('retry').disabled, false);
  assert.ok(p.$('st-undelivered').focused >= 1, 'focus moves to the new state');
  p.answers.post = new TypeError('Failed to fetch');
  p.$('retry').click();
  await flush();
  assert.deepEqual(p.shown(), ['undelivered']);
  p.answers.post = { status: 200, body: { returnUrl: BACK, outcome: 'failed' } };
  p.$('retry').click();
  await flush();
  const posts = p.calls.filter((c) => c.init.method === 'POST').map((c) => c.body.outcome);
  assert.deepEqual(posts, ['failed', 'failed', 'failed']);
  assert.deepEqual(p.replaced, [BACK]);
  // expired while on the page
  p = boot({ post: { status: 404, body: { status: 'expired' } } });
  await flush();
  p.$('pay').click();
  await flush();
  assert.deepEqual(p.shown(), ['invalid']);
  assert.match(p.$('invalid-msg').textContent, /has expired/);
});

test('the device clock decides nothing: no expiry timer, even on a phone whose clock is past expiresAt; the function says expired (404)', async () => {
  const p = boot({ get: { status: 200, body: Object.assign({}, DATA, { expiresAt: new Date(Date.now() - 60000).toISOString() }) } });
  await flush();
  assert.deepEqual(p.shown(), ['ready']);
  assert.deepEqual(p.timers, [], 'no timer armed from the device clock');
  assert.ok(!/expiresAt|setTimeout/.test(scripts.join('\n').replace(/\/\*[\s\S]*?\*\//g, '')), 'the script reads no expiry');
  p.answers.post = { status: 404, body: { error: 'expired', status: 'expired' } };
  p.$('pay').click();
  await flush();
  assert.deepEqual(p.shown(), ['invalid']);
  assert.match(p.$('invalid-msg').textContent, /has expired/);
});

test('undelivered (502 {error, returnUrl}): says the payment could not be reported and that the bill shows where it stands, never "Nothing was charged"; 200 {returnUrl, outcome, result} is followed whatever the result', async () => {
  const undelivered = html.slice(html.indexOf('<section id="st-undelivered"'), html.indexOf('</section>', html.indexOf('<section id="st-undelivered"')));
  assert.match(undelivered, /could not be reported/);
  assert.match(undelivered, /Your bill shows where this payment stands\./);
  assert.ok(!/Nothing was charged/i.test(html), 'the page never claims nothing was charged');
  for (const result of ['confirmed', 'released', 'refused']) {
    const p = boot({ post: { status: 200, body: { returnUrl: BACK, outcome: 'paid', result } } });
    await flush();
    p.$('pay').click();
    await flush();
    assert.deepEqual(p.replaced, [BACK], result);
  }
});

test('targets of at least 44 px, visible focus, fits 320 px', () => {
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  assert.match(css, /\.btn\{[^}]*min-height:(4[4-9]|[5-9]\d)px/);
  assert.match(css, /:focus-visible[^{]*\{[^}]*outline:3px solid/);
  assert.match(css, /\.card\{[^}]*max-width:360px;width:100%/);
  assert.match(css, /body\{[^}]*padding:16px/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(!/user-scalable=no|maximum-scale/.test(html));
});

test('the service workers leave it alone: outside both scopes, in neither shell', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(!sw.includes("'pay-demo.html'"), 'not precached');
  const guest = fs.readFileSync(path.join(root, 'guest.html'), 'utf8'), dash = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const scopes = [...(guest + dash).matchAll(/register\('sw\.js[^']*', \{ scope: '([^']+)'/g)].map((m) => new URL(m[1], ORIGIN + '/').pathname);
  assert.deepEqual(scopes, ['/guest.html', '/dashboard.html']);
  for (const s of scopes) assert.ok(!'/pay-demo.html'.startsWith(s), 'inside ' + s);
  assert.ok(!/serviceWorker/.test(html), 'the page registers no worker');
  // and it ships: the allowlist lets it in
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^!pay-demo\.html$/m);
});
