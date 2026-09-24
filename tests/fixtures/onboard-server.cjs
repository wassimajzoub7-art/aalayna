/* A fake Supabase (PostgREST) and a fake Messages API on one local HTTP server, for
   tests/onboard.test.cjs. It keeps the rules of the SQL files the onboarding tool relies
   on, in memory: admin.sql (register, list, update profile), sessions-2026-09-24.sql and
   followups-2026-09-24.sql (table codes, table scans that reuse the open bill's key and
   give nothing after it closes), auth-2026-09-24.sql (aal_staff list/invite, aal_mutate
   open_check/reserve/confirm_cash/close_check/receipt, aal_snapshot with the owner or a
   bill key) and the kv_docs upsert policy (owner key only). Every call is recorded. */
const http = require('node:http');
const crypto = require('node:crypto');

function start(opts) {
  opts = opts || {};
  const ADMIN = opts.adminKey || 'adm_test_admin_key';
  const db = { venues: new Map(), profiles: new Map(), tokens: [], staff: [], rows: new Map(), docs: new Map(), checkKeys: [], secrets: new Map(), seq: 0 };
  const calls = [];
  const models = { requests: [], answers: opts.answers || {} };
  const hex = n => crypto.randomBytes(n).toString('hex');
  const now = () => new Date().toISOString();
  class Refuse extends Error { constructor(m, status, code) { super(m); this.status = status || 400; this.code = code || 'P0001'; } }
  const refuse = (m, s, c) => { throw new Refuse(m, s, c); };

  function roleOf(rid, h) {
    const v = db.venues.get(rid), k = h['x-aalayna-key'] || '';
    if (!v || !k) return null;
    if (k === v.owner_key) return 'owner';
    if (k === v.guest_key) return 'guest';
    return null;
  }
  function scopeOf(rid, h) {
    const k = h['x-aalayna-key'] || '';
    const ck = db.checkKeys.filter(c => c.key === k && c.rid === rid)[0];
    if (!ck) return null;
    const c = db.rows.get(rid + '|aal.checks|' + ck.checkId);
    if (!c) return null;
    if (c.closedAt && Date.parse(c.closedAt) <= Date.now() - 24 * 3600e3) return null;
    return ck.checkId;
  }
  const rowsOf = (rid, col) => [...db.rows.entries()].filter(([k]) => k.indexOf(rid + '|' + col + '|') === 0).map(([k, b]) => ({ id: k.slice((rid + '|' + col + '|').length), body: b }));
  const venueJson = rid => {
    const v = db.venues.get(rid), p = db.profiles.get(rid);
    return { restaurant_id: rid, name: p ? p.name : v.name, owner_key: v.owner_key, guest_key: v.guest_key, created_at: v.created_at, profile: p ? Object.assign({}, p) : null, checks: rowsOf(rid, 'aal.checks').length, payments: rowsOf(rid, 'aal.settle').length };
  };
  function field(f, v) {
    v = v == null ? '' : String(v).trim();
    if (!v) return null;
    if ((f === 'brand' || f === 'bg')) { if (!/^#?[0-9A-Fa-f]{6}$/.test(v)) refuse((f === 'brand' ? 'Brand colour' : 'Background') + ' must be a six digit hex colour, like #EA312B.'); return '#' + v.replace(/^#/, '').toUpperCase(); }
    if (f === 'font' && !/^[A-Za-z0-9 +]{1,40}$/.test(v)) refuse('Font must be a Google Fonts name: letters, digits and spaces, up to 40 characters.');
    if (f === 'slug' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v)) refuse('Slug uses lower-case letters, digits and hyphens only, up to 40 characters, and cannot start or end with a hyphen.');
    return v;
  }
  function writeProfile(rid, p) {
    const cur = db.profiles.get(rid) || { demo_payments: true };
    const next = Object.assign({}, cur);
    ['slug', 'name', 'place', 'gplace', 'brand', 'bg', 'font', 'menu_pack'].forEach(f => { if (f in p) next[f] = f === 'place' ? (field(f, p[f]) || '') : field(f, p[f]); });
    if ('demo_payments' in p) next.demo_payments = !!p.demo_payments;
    for (const [r, q] of db.profiles) if (r !== rid && q.slug === next.slug) refuse('The slug ' + next.slug + ' is already used by another venue.');
    db.profiles.set(rid, next);
  }

  const rpc = {
    aal_admin_list_venues(b, h) {
      if (h['x-aalayna-admin'] !== ADMIN) refuse('Admin key required.', 403, '42501');
      return [...db.venues.keys()].map(venueJson);
    },
    aal_admin_register_venue(b, h) {
      if (h['x-aalayna-admin'] !== ADMIN) refuse('Admin key required.', 403, '42501');
      const name = String(b.p_name).trim(), place = String(b.p_place || '').trim();
      const rid = '["' + name.toLowerCase() + '","' + place.toLowerCase() + '"]';
      const existed = db.venues.has(rid);
      if (!existed) db.venues.set(rid, { owner_key: 'own_' + hex(18), guest_key: 'gst_' + hex(9), name, created_at: now() });
      const p = Object.assign({}, b.p_profile || {});
      delete p.name; delete p.place; delete p.slug;
      writeProfile(rid, Object.assign(p, { name, place, slug: b.p_slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-') }));
      const v = db.venues.get(rid);
      return { restaurant_id: rid, owner_key: v.owner_key, guest_key: v.guest_key, slug: db.profiles.get(rid).slug, profile: Object.assign({}, db.profiles.get(rid)), existed };
    },
    aal_admin_update_profile(b, h) {
      if (h['x-aalayna-admin'] !== ADMIN) refuse('Admin key required.', 403, '42501');
      if (!db.venues.has(b.p_rid)) refuse('Unknown venue.');
      writeProfile(b.p_rid, b.p_profile || {});
      return venueJson(b.p_rid);
    },
    aal_table_tokens(b, h) {
      const rid = b.p_rid, body = b.p_body || {}, op = body.op || 'list';
      if (roleOf(rid, h) !== 'owner') refuse('Owner key required.', 403, '42501');
      const json = () => { const p = db.profiles.get(rid) || {}; return { restaurant_id: rid, slug: p.slug, name: p.name, place: p.place, tokens: db.tokens.filter(t => t.rid === rid && !t.revoked_at).sort((a, b) => a.table - b.table).map(t => ({ table: t.table, token: t.token, created_at: t.created_at })) }; };
      if (op === 'list') return json();
      if (typeof body.table !== 'number' || body.table !== Math.floor(body.table) || body.table < 1 || body.table > 9999) refuse('Table must be a whole number from 1 to 9999.');
      db.tokens.filter(t => t.rid === rid && t.table === body.table && !t.revoked_at).forEach(t => { t.revoked_at = now(); });
      if (op === 'issue') db.tokens.push({ rid, table: body.table, token: 'tbl_' + hex(24), created_at: now(), revoked_at: null });
      else if (op !== 'revoke') refuse('Unknown table code operation.');
      return json();
    },
    aal_table_session(b) {
      const e = [...db.profiles.entries()].filter(([, p]) => p.slug === b.p_slug)[0];
      if (!e || !db.tokens.some(t => t.rid === e[0] && t.table === b.p_table && t.token === b.p_token && !t.revoked_at)) refuse('This table code is not active. Ask your server for the bill.');
      const rid = e[0], p = e[1];
      const open = rowsOf(rid, 'aal.checks').filter(r => r.body.table === b.p_table && !r.body.closedAt)[0];
      let key = null;
      if (open) {
        const have = db.checkKeys.filter(c => c.rid === rid && c.checkId === open.id).sort((a, b) => b.seq - a.seq)[0];
        if (have) key = have.key;
        else { key = 'chk_' + hex(24); db.checkKeys.push({ key, rid, checkId: open.id, seq: ++db.seq }); }
      }
      const docs = ['aal.live', 'aal.rate', 'aal.rate_meta'].filter(k => db.docs.has(rid + '|' + k)).map(k => ({ key: k, body: db.docs.get(rid + '|' + k).body }));
      return { restaurant_id: rid, venue: { name: p.name, place: p.place, gplace: p.gplace || null, brand: p.brand || null, bg: p.bg || null, font: p.font || null, menu_pack: p.menu_pack || null }, table: b.p_table, checkId: open ? open.id : null, key, docs };
    },
    aal_staff(b, h) {
      const rid = b.p_rid, body = b.p_body || {}, op = body.op || 'list';
      if (roleOf(rid, h) !== 'owner') refuse('Only the restaurant owner can manage staff.', 403, '42501');
      const json = () => ({ restaurant_id: rid, staff: db.staff.filter(s => s.rid === rid).map(s => ({ email: s.email, role: s.role, invited_by: s.invited_by, created_at: s.created_at, revoked_at: s.revoked_at })) });
      if (op === 'list') return json();
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse('Enter a valid email address.');
      if (op === 'invite') {
        if (['owner', 'manager', 'waiter'].indexOf(body.role) < 0) refuse('Role must be owner, manager or waiter.');
        const cur = db.staff.filter(s => s.rid === rid && s.email === email)[0];
        if (cur && !cur.revoked_at) refuse(email + ' is already on the staff list. Change their role instead.');
        if (cur) Object.assign(cur, { role: body.role, revoked_at: null, created_at: now() });
        else db.staff.push({ rid, email, role: body.role, invited_by: 'owner key', created_at: now(), revoked_at: null });
        return json();
      }
      if (op === 'revoke') { const cur = db.staff.filter(s => s.rid === rid && s.email === email && !s.revoked_at)[0]; if (!cur) refuse(email + ' is not on the staff list.'); cur.revoked_at = now(); return json(); }
      refuse('Unknown staff operation.');
    },
    aal_snapshot(b, h) {
      const rid = b.p_rid, role = roleOf(rid, h), owner = role === 'owner', cid = scopeOf(rid, h);
      if (!owner && !cid) refuse('Open a current bill link or sign in with this restaurant owner key.');
      const rows = [];
      for (const [k, body] of db.rows) {
        const [r, col, id] = [k.slice(0, k.indexOf('|')), k.split('|').slice(-2)[0], k.split('|').slice(-1)[0]];
        if (r !== rid) continue;
        if (owner || (col === 'aal.checks' && id === cid) || (col === 'aal.settle' && body.checkId === cid)) rows.push({ collection: col, id, body });
      }
      const docs = [...db.docs.entries()].filter(([k]) => k.indexOf(rid + '|') === 0).map(([k, d]) => ({ key: k.slice(rid.length + 1), body: d.body }))
        .filter(d => owner || ['aal.live', 'aal.rate', 'aal.rate_meta'].indexOf(d.key) >= 0);
      return { version: 2, role: owner ? 'owner' : 'guest', checkId: cid, rows, docs };
    },
    aal_mutate(b, h) {
      const rid = b.p_rid, op = b.p_op, body = b.p_body || {}, token = b.p_token || '';
      const owner = roleOf(rid, h) === 'owner', scope = scopeOf(rid, h);
      if (!owner && !scope) refuse('Access denied');
      const K = (c, id) => rid + '|' + c + '|' + id;
      const hash = t => crypto.createHash('sha256').update(t).digest('hex');
      if (op === 'open_check') {
        if (!owner) refuse('Only staff may open a bill');
        const lines = body.lines || [];
        const total = lines.reduce((a, l) => a + Math.round(l.p * 100), 0);
        if (!body.id || total <= 0 || !(body.table >= 1)) refuse('Invalid bill');
        const open = rowsOf(rid, 'aal.checks').filter(r => r.body.table === body.table && !r.body.closedAt)[0];
        if (open) return open.body;
        const c = { id: body.id, venueId: rid, source: 'staff', openedAt: now(), table: body.table, lines: lines.map(l => ({ id: l.id, q: l.q, p: l.p, name: l.name })), totalCents: total, amountUsd: total / 100, revision: 1 };
        db.rows.set(K('aal.checks', c.id), c);
        return c;
      }
      if (op === 'reserve') {
        if (!owner && body.checkId !== scope) refuse('Wrong bill');
        if (token.length < 32) refuse('Missing payer token');
        const c = db.rows.get(K('aal.checks', body.checkId));
        if (!c || c.closedAt) refuse('Bill closed or unavailable');
        const used = rowsOf(rid, 'aal.settle').filter(r => r.body.checkId === body.checkId && !r.body.cancelled && ['pending', 'confirmed'].indexOf(r.body.status) >= 0).reduce((a, r) => a + Math.round(r.body.amount * 100), 0);
        if (used + Math.round(body.amount * 100) > c.totalCents) refuse('Another payment already covers this balance. Refresh your bill.');
        const p = { id: body.id, requestId: body.requestId, venueId: rid, checkId: body.checkId, table: c.table, rail: body.rail, amount: body.amount, tip: body.tip || 0, items: body.items || {}, currency: 'USD', status: body.rail === 'cash' ? 'pending' : 'initiated', ts: now() };
        db.rows.set(K('aal.settle', p.id), p);
        db.secrets.set(rid + '|' + p.id, hash(token));
        return p;
      }
      if (op === 'close_check') {
        if (!owner) refuse('Only staff may close a bill');
        const c = db.rows.get(K('aal.checks', body.checkId));
        const paid = rowsOf(rid, 'aal.settle').filter(r => r.body.checkId === body.checkId && r.body.status === 'confirmed' && !r.body.refunded).reduce((a, r) => a + Math.round((r.body.amount - (r.body.tip || 0)) * 100), 0);
        if (!c || paid !== c.totalCents) refuse('Bill is not fully settled');
        c.closedAt = now();
        return c;
      }
      const p = db.rows.get(K('aal.settle', body.id));
      if (!p || (!owner && p.checkId !== scope)) refuse('Payment unavailable');
      const tokenOk = db.secrets.get(rid + '|' + body.id) === hash(token);
      if (op === 'confirm_cash') {
        if (!owner || p.rail !== 'cash') refuse('Cash confirmation requires staff');
        if (p.status === 'confirmed') return p;
        if (p.status !== 'pending') refuse('Cash request changed');
        Object.assign(p, { status: 'confirmed', confirmedAt: now() });
        return p;
      }
      if (op === 'receipt') {
        if (!owner && !tokenOk) refuse('Wrong payer token');
        if (p.status !== 'confirmed') refuse('Payment must be confirmed');
        if (typeof body.receipt !== 'boolean' || typeof body.marketing !== 'boolean') refuse('Separate permissions required');
        if (body.channel !== 'email' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contact || '')) refuse('Invalid email');
        const g = { id: crypto.randomUUID(), venueId: rid, contact: String(body.contact).toLowerCase(), channel: 'email', receipt: body.receipt, marketing: body.marketing };
        db.rows.set(K('aal.guests', g.id), g);
        p.customerId = g.id;
        return { saved: true };
      }
      refuse('Unknown operation');
    }
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(400, { message: 'bad json' }); }
      const u = new URL(req.url, 'http://x');
      const h = req.headers;
      calls.push({ method: req.method, path: u.pathname, search: u.search, headers: Object.assign({}, h), body });
      if (u.pathname === '/v1/messages') {
        models.requests.push({ headers: Object.assign({}, h), body });
        if (models.refuseForced && body.tool_choice && body.tool_choice.type === 'tool') {
          return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } });
        }
        if (models.refuseStrict && body.tools && body.tools.some(t => 'strict' in t)) {
          return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.custom.strict: Extra inputs are not permitted' } });
        }
        if (models.refuseOutputConfig && 'output_config' in body) {
          return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: not supported for this model' } });
        }
        const tool = body && body.tools && body.tools[0] && body.tools[0].name;
        const a = models.answers[tool];
        if (!a) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'no fake answer for ' + tool } });
        return send(200, a);
      }
      if (opts.down) return send(503, { message: 'Service unavailable' });
      if (h.apikey !== opts.anonKey && opts.anonKey) return send(401, { message: 'Invalid API key' });
      try {
        if (u.pathname.indexOf('/rest/v1/rpc/') === 0) {
          const fn = u.pathname.slice('/rest/v1/rpc/'.length);
          if (!rpc[fn] || (opts.missing || []).indexOf(fn) >= 0) return send(404, { code: 'PGRST202', message: 'Could not find the function public.' + fn });
          return send(200, rpc[fn](body || {}, h));
        }
        if (u.pathname === '/rest/v1/kv_docs' && req.method === 'POST') {
          if (u.searchParams.get('on_conflict') !== 'restaurant_id,key' || !/resolution=merge-duplicates/.test(h.prefer || '')) return send(409, { message: 'duplicate key value violates unique constraint "kv_docs_pkey"' });
          const list = Array.isArray(body) ? body : [body];
          if (list.some(r => roleOf(r.restaurant_id, h) !== 'owner')) return send(403, { code: '42501', message: 'new row violates row-level security policy for table "kv_docs"' });
          list.forEach(r => db.docs.set(r.restaurant_id + '|' + r.key, { body: r.body, updated_at: now() }));
          return send(201, null);
        }
        return send(404, { message: 'not found' });
      } catch (e) {
        if (e instanceof Refuse) return send(e.status, { code: e.code, message: e.message });
        return send(500, { message: e.message });
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    resolve({ url, db, calls, models, ADMIN, close: () => new Promise(r => server.close(r)),
      rpcCalls: fn => calls.filter(c => c.path === '/rest/v1/rpc/' + fn) });
  }));
}

module.exports = { start };
