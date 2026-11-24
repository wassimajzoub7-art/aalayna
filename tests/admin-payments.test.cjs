/* admin.html's Payments block (the T7 script), run in a VM with a minimal DOM against a fake
   shared store (aal_admin_list_payment_providers, aal_admin_set_payment_provider,
   aal_admin_remove_payment_provider) and a fake payment-start function (GET /providers, POST
   /admin/check). Proves that:
   - the block is mounted in each venue's panel right after Demo payments, its script runs
     before the venue panel's, and the page's wording points at it;
   - with demo payments on, no real provider can be connected (no Connect or Change), and the
     wording says why; existing rows can still be tested, disabled and removed;
   - with demo payments off, Connect draws the form from the connectors' fields (the demo
     provider is not offered), secret fields are password inputs, never prefilled, and empty
     after Save; Save sends config from the text fields and the secret fields as one JSON
     secret, or null to keep the saved one;
   - Disable, Test connection (admin key in x-aalayna-admin, to payment-start) and Remove (with
     a confirmation) send what they say; a webhook_route row shows its webhook URL with Copy;
   - no secret is ever drawn on the page. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const RID = JSON.stringify(['mayda', 'hamra']);
const ADMIN = 'adm_' + '0a'.repeat(12);
const SECRET = 'live-secret-value-9999';

function script() {
  const m = /<!-- ==== T7 payments \(admin\) script: start ==== -->\s*<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the T7 script');
  return m[1];
}

/* a minimal DOM: enough for el(), forms, inputs and attribute selectors */
function makeDom() {
  function node(tag) {
    const attrs = {}, kids = [];
    const n = {
      tagName: String(tag || '').toUpperCase(), children: kids, style: {}, textContent: '', value: '', type: '', className: '', disabled: false, checked: false, id: '', placeholder: '', title: '',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; }, removeAttribute(k) { delete attrs[k]; }, hasAttribute(k) { return k in attrs; },
      appendChild(c) { kids.push(c); c.parentNode = n; return c; }, append(...c) { c.forEach((x) => n.appendChild(x)); }, replaceChildren(...c) { kids.length = 0; c.forEach((x) => n.appendChild(x)); },
      addEventListener(ev, fn) { (n['_' + ev] = n['_' + ev] || []).push(fn); }, focus() {},
      get previousSibling() { const p = n.parentNode; if (!p) return null; const i = p.children.indexOf(n); return i > 0 ? p.children[i - 1] : null; },
      querySelectorAll(sel) { return all(n).filter((x) => x !== n && matches(x, sel)); },
      querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
      attrs,
    };
    return n;
  }
  function all(n, out = []) { out.push(n); (n.children || []).forEach((c) => all(c, out)); return out; }
  function matches(x, sel) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) throw new Error('selector ' + sel);
    const v = x.getAttribute && x.getAttribute(m[1]);
    return v != null && (m[2] === undefined || v === m[2]);
  }
  return { createElement: (t) => node(t), createTextNode: (t) => Object.assign(node('#text'), { textContent: t }), getElementById: () => null };
}
const walk = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => walk(c, out)); return out; };
const text = (n) => walk(n).map((x) => x.textContent || '').join(' ');
const buttons = (n) => walk(n).filter((x) => x.tagName === 'BUTTON');
const button = (n, label) => { const b = buttons(n).find((x) => x.textContent === label); assert.ok(b, 'button ' + label + ' in: ' + text(n).slice(0, 400)); return b; };
const inputs = (n) => walk(n).filter((x) => x.tagName === 'INPUT');
const formOf = (n) => walk(n).find((x) => x.tagName === 'FORM');

const PROVIDERS = [
  { name: 'fake', label: 'Demo provider (no money moves)', rails: ['card', 'whish'], fields: [], ready: true },
  { name: 'whish', label: 'Whish Money', rails: ['whish'], ready: false, fields: [{ key: 'merchant', label: 'Merchant id', kind: 'text', required: true, hint: 'From the venue.' }, { key: 'apiKey', label: 'API key', kind: 'secret', required: true }] },
];

function setup(o = {}) {
  const calls = [], rows = o.rows ? o.rows.slice() : [];
  const res = (status, obj) => ({ ok: status < 300, status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)), json: async () => obj });
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    if (url === 'https://mock.invalid/functions/v1/payment-start/providers') return res(200, { providers: PROVIDERS });
    if (url === 'https://mock.invalid/functions/v1/payment-start/admin/check') return res(o.checkStatus || 200, o.check || { ok: true, detail: 'The demo provider is ready.' });
    const fn = url.replace('https://mock.invalid/rest/v1/rpc/', '');
    if (fn === 'aal_admin_list_payment_providers') return res(200, rows);
    if (fn === 'aal_admin_set_payment_provider') {
      let r = rows.find((x) => x.rail === body.p_rail);
      if (!r) { r = { restaurant_id: body.p_rid, rail: body.p_rail, created_at: '2026-11-24T10:00:00Z', has_secret: false, secret_name: null, enabled: true, config: {} }; rows.push(r); }
      Object.assign(r, { provider: body.p_provider, updated_at: '2026-11-24T11:00:00Z' });
      if (body.p_config) r.config = body.p_config;
      if (body.p_enabled != null) r.enabled = body.p_enabled;
      if (body.p_secret) { r.has_secret = true; r.secret_name = 'aalayna_pay_x'; }
      return res(200, r);
    }
    if (fn === 'aal_admin_remove_payment_provider') { const i = rows.findIndex((x) => x.rail === body.p_rail); if (i >= 0) rows.splice(i, 1); return res(200, { removed: i >= 0 }); }
    return res(404, { code: 'PGRST202', message: 'no function' });
  };
  const session = new Map([['aal.adminKey', ADMIN]]);
  const ctx = {
    document: makeDom(), fetch, navigator: { clipboard: { writeText: async (t) => { ctx.copied = t; } } }, setTimeout: () => 0,
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, v), removeItem: (k) => session.delete(k) },
    AalaynaConfig: { supabaseUrl: 'https://mock.invalid', anonKey: 'anon-key' }, Date, JSON, Object, Array, String, Promise,
  };
  ctx.window = ctx;
  vm.runInNewContext(script(), ctx);
  const P = ctx.AalaynaAdminPayments;
  const v = { restaurant_id: RID, name: 'Mayda', owner_key: 'own_x' };
  let box = null;
  const mount = (demo) => { box = P.section(v, demo); return box; };
  return { ctx, P, calls, rows, v, mount, get box() { return box; }, rpcs: () => calls.filter((c) => c.url.includes('/rpc/')).map((c) => [c.url.split('/rpc/')[1], c.body]) };
}

test('admin.html: the Payments block is mounted after Demo payments, its script runs before the venue panel, and the wording points at it', () => {
  const hook = html.indexOf("window.AalaynaAdminPayments.section(v,p.demo)");
  assert.ok(hook > html.indexOf("box.appendChild(el('h3','Demo payments'))") && hook < html.indexOf("box.appendChild(el('h3','Profile'))"));
  assert.ok(html.indexOf('T7 payments (admin) script: start') < html.indexOf('T6 Venues (onboarding) script: start'));
  assert.match(html, /Off: only the rails connected under Payments, below, are offered; with none, cash only\./);
  assert.doesNotMatch(html, /only the rails with a payment_providers row are offered/);
  assert.match(html, /connect card or Whish under Payments/);
  const s = script();
  assert.match(s, /input\.type='password'; input\.autocomplete='new-password'; input\.value='';/);
  assert.doesNotMatch(s, /localStorage/);
  assert.doesNotMatch(s, /console\./);
  assert.match(s, /'x-aalayna-admin':k/);
  assert.match(s, /\.pay-form|pay-form/);
  assert.match(html, /\.pay-form\{/);
});

test('demo payments on: no real connection is offered; rows can still be tested, disabled and removed', async () => {
  const t = setup({ rows: [{ restaurant_id: RID, rail: 'whish', provider: 'whish', config: { merchant: 'm-1' }, enabled: true, has_secret: true, secret_name: 'aalayna_pay_x', updated_at: '2026-11-20T09:00:00Z' }] });
  t.mount(true);
  await flush();
  const box = t.P.state(RID).node;
  const s = text(box);
  assert.match(s, /Demo payments is on: card and Whish go to the demo provider and no money moves\. Real provider connections are offered once demo payments is off/);
  assert.match(s, /Demo provider \(no row needed while demo payments is on\)/);
  assert.match(s, /Whish Money · Enabled · Credentials saved · Updated/);
  assert.ok(!buttons(box).some((b) => b.textContent === 'Connect' || b.textContent === 'Change'));
  button(box, 'Disable');
  button(box, 'Test connection');
  button(box, 'Remove');
  assert.ok(!s.includes(SECRET));
});

test('demo payments off: Connect draws the form from the connectors; Save sends config and one JSON secret, then empties the secret field', async () => {
  const t = setup();
  t.mount(false);
  await flush();
  let box = t.P.state(RID).node;
  assert.match(text(box), /Not connected: not offered to guests/);
  assert.deepEqual(t.rpcs(), [['aal_admin_list_payment_providers', { p_rid: RID }]]);
  // card: only the demo provider serves it, and it is not offered: nothing to connect
  button(box, 'Connect').onclick();
  await flush();
  box = t.P.state(RID).node;
  assert.match(text(box), /No connector on this server takes card payments yet/);
  assert.equal(buttons(box).filter((b) => b.textContent === 'Connect').length, 1, 'card is open, so only Whish shows Connect');
  button(box, 'Cancel').onclick();
  box = t.P.state(RID).node;
  // whish (the second rail): the Whish fields
  const connects = buttons(box).filter((b) => b.textContent === 'Connect');
  assert.equal(connects.length, 2);
  connects[1].onclick();
  await flush();
  box = t.P.state(RID).node;
  const form = formOf(box);
  assert.ok(form, 'the whish form');
  const options = walk(form).filter((x) => x.tagName === 'OPTION').map((x) => x.value);
  assert.deepEqual(options, ['whish'], 'the demo provider is never offered as a row');
  assert.match(text(form), /Whish Money is not ready on this server yet/);
  const [merchant, apiKey] = inputs(form).filter((x) => x.getAttribute('data-pay-field'));
  assert.equal(merchant.type, 'text');
  assert.equal(apiKey.type, 'password');
  assert.equal(apiKey.value, '');
  assert.equal(apiKey.autocomplete, 'new-password');
  const enabled = inputs(form).find((x) => x.type === 'checkbox');
  assert.equal(enabled.checked, false, 'a connector that is not ready starts disabled');
  // a missing required field is refused on the page
  merchant.value = 'm-1';
  form.onsubmit({ preventDefault() {} });
  assert.equal(apiKey.getAttribute('aria-invalid'), 'true');
  assert.equal(t.rpcs().length, 1, 'nothing sent');
  apiKey.value = SECRET;
  form.onsubmit({ preventDefault() {} });
  assert.equal(apiKey.value, '', 'the secret field is emptied at once');
  await flush();
  const set = t.rpcs().find((c) => c[0] === 'aal_admin_set_payment_provider');
  assert.deepEqual(set[1], { p_rid: RID, p_rail: 'whish', p_provider: 'whish', p_config: { merchant: 'm-1' }, p_secret: JSON.stringify({ apiKey: SECRET }), p_enabled: false });
  box = t.P.state(RID).node;
  const s = text(box);
  assert.match(s, /Whish is connected to Whish Money, disabled\. The credentials are in Vault\./);
  assert.match(s, /Whish Money · Disabled · Credentials saved · Updated/);
  assert.ok(!s.includes(SECRET), 'the secret is never drawn');
  assert.ok(!walk(box).some((x) => x.value === SECRET), 'and no input holds it');
  // Change: the merchant prefilled, the secret not; Save without a secret keeps it
  button(box, 'Change').onclick();
  await flush();
  box = t.P.state(RID).node;
  const f2 = formOf(box);
  const [m2, k2] = inputs(f2).filter((x) => x.getAttribute('data-pay-field'));
  assert.equal(m2.value, 'm-1');
  assert.equal(k2.value, '');
  assert.match(k2.placeholder, /Saved\. Leave empty to keep it/);
  m2.value = 'm-2';
  inputs(f2).find((x) => x.type === 'checkbox').checked = true;
  f2.onsubmit({ preventDefault() {} });
  await flush();
  const set2 = t.rpcs().filter((c) => c[0] === 'aal_admin_set_payment_provider').pop();
  assert.deepEqual(set2[1], { p_rid: RID, p_rail: 'whish', p_provider: 'whish', p_config: { merchant: 'm-2' }, p_secret: null, p_enabled: true });
});

test('Disable, Test connection, Remove and the webhook URL', async () => {
  const t = setup({ check: { ok: false, detail: 'Testing a Whish connection is not built yet.' }, checkStatus: 501,
    rows: [{ restaurant_id: RID, rail: 'whish', provider: 'whish', config: { merchant: 'm-1' }, enabled: true, has_secret: true, secret_name: 'aalayna_pay_x', webhook_route: 'mayda-7f3a', updated_at: '2026-11-20T09:00:00Z' }] });
  t.mount(false);
  await flush();
  let box = t.P.state(RID).node;
  assert.match(text(box), /https:\/\/mock\.invalid\/functions\/v1\/payment-webhook\/whish\/mayda-7f3a/);
  button(box, 'Copy').onclick();
  await flush();
  assert.equal(t.ctx.copied, 'https://mock.invalid/functions/v1/payment-webhook/whish/mayda-7f3a');
  // test connection: to payment-start, with the admin key
  button(box, 'Test connection').onclick();
  await flush();
  const check = t.calls.find((c) => c.url.endsWith('/payment-start/admin/check'));
  assert.equal(check.method, 'POST');
  assert.equal(check.headers['x-aalayna-admin'], ADMIN);
  assert.deepEqual(check.body, { restaurantId: RID, rail: 'whish' });
  box = t.P.state(RID).node;
  assert.match(text(box), /Connection test failed\. Testing a Whish connection is not built yet\./);
  // disable
  button(box, 'Disable').onclick();
  await flush();
  assert.deepEqual(t.rpcs().filter((c) => c[0] === 'aal_admin_set_payment_provider').pop()[1], { p_rid: RID, p_rail: 'whish', p_provider: 'whish', p_config: null, p_secret: null, p_enabled: false });
  box = t.P.state(RID).node;
  assert.match(text(box), /Whish is disabled: guests are not offered it\./);
  assert.equal(button(box, 'Test connection').disabled, true, 'a disabled row cannot be tested');
  // remove, after a confirmation
  button(box, 'Remove').onclick();
  box = t.P.state(RID).node;
  assert.match(text(box), /Its credentials are deleted from Vault and cannot be recovered/);
  assert.ok(!t.rpcs().some((c) => c[0] === 'aal_admin_remove_payment_provider'), 'nothing removed before the confirmation');
  button(box, 'Remove connection').onclick();
  await flush();
  assert.deepEqual(t.rpcs().filter((c) => c[0] === 'aal_admin_remove_payment_provider').pop()[1], { p_rid: RID, p_rail: 'whish' });
  box = t.P.state(RID).node;
  assert.match(text(box), /Whish connection removed\./);
  assert.equal(walk(box).filter((x) => /Not connected/.test(x.textContent || '')).length, 2);
});
