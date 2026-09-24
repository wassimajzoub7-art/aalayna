'use strict';
/* Step 6. A live smoke test against this venue, on table 9999, away from real service.
   in:  the venue (slug, owner key)
   out: data {checkId, checks: [{name, status: pass|fail|skip, detail}]}
   The full guest path, each expectation asserted: code issued, bill opened (one line,
   $1.00), two scans give the same bill key, the guest reserves cash with a 40-character
   payer token, the owner confirms it and closes the bill, the guest key still reads the
   closed bill, a receipt request to an example.com address is accepted, a fresh scan
   gives no key, and table 9999's code is revoked (always attempted, even after a failure).
   Left in place on purpose, as the venue's audit trail: the closed $1.00 bill, its cash
   payment, their events and one guest record for the example.com address. A test bill
   left open by an interrupted earlier run is settled and closed first. */
const crypto = require('crypto');

const TABLE = 9999;
const PREFIX = 'onboard-verify-';

module.exports = {
  name: 'verify',
  description: 'Smoke test the live guest path on table 9999 (bill, scans, cash, close, receipt)',
  TABLE,
  env: [],
  plan: function () {
    return 'on table ' + TABLE + ': issue a code, open a $1.00 bill, scan twice, reserve cash as the guest, confirm and close as owner, ' +
      'read the closed bill with the guest key, send a receipt request to an example.com address, scan again (no key), revoke the code';
  },
  run: async function (ctx) {
    const sb = ctx.sb, rid = ctx.rid, owner = { key: ctx.ownerKey }, slug = ctx.inputs.slug;
    const mutate = (op, body, cred, token) => sb.rpc('aal_mutate', { p_rid: rid, p_op: op, p_body: body, p_token: token || '' }, cred);
    const scan = (token) => sb.rpc('aal_table_session', { p_slug: slug, p_table: TABLE, p_token: token }, null);
    const checks = [], lines = [];
    let broken = false;
    async function check(name, fn) {
      if (broken) { checks.push({ name, status: 'fail', detail: 'not run: an earlier check failed' }); return; }
      try {
        const r = await fn();
        if (r === 'skip' || (r && r.skip)) checks.push({ name, status: 'skip', detail: (r && r.skip) || '' });
        else checks.push({ name, status: 'pass', detail: (r && r.detail) || '' });
      } catch (e) {
        checks.push({ name, status: 'fail', detail: e.message });
        broken = true;
      }
    }
    function expect(cond, msg) { if (!cond) throw new Error(msg); }

    // a test bill left open by an interrupted run would block this one: settle and close it
    const snap = await sb.rpc('aal_snapshot', { p_rid: rid }, owner);
    const rows = (snap && snap.rows) || [];
    const leftovers = rows.filter(r => r.collection === 'aal.checks' && r.body && r.body.table === TABLE && !r.body.closedAt);
    for (const l of leftovers) {
      if (String(l.id).indexOf(PREFIX) !== 0) {
        return { ok: false, summary: 'Table ' + TABLE + ' has an open bill (' + l.id + ') that this tool did not open. Close it on the dashboard, then run again.' };
      }
      const pays = rows.filter(r => r.collection === 'aal.settle' && r.body && r.body.checkId === l.id && !r.body.refunded && !r.body.cancelled);
      let paid = 0;
      for (const p of pays) {
        if (p.body.status === 'pending' && p.body.rail === 'cash') await mutate('confirm_cash', { id: p.id }, owner);
        if (p.body.status === 'pending' || p.body.status === 'confirmed') paid += Math.round(p.body.amount * 100) - Math.round((p.body.tip || 0) * 100);
      }
      const due = (l.body.totalCents || 0) - paid;
      if (due > 0) {
        const id = crypto.randomUUID();
        await mutate('reserve', { id, requestId: crypto.randomUUID(), checkId: l.id, rail: 'cash', amount: due / 100, tip: 0, items: {} }, owner, crypto.randomBytes(20).toString('hex'));
        await mutate('confirm_cash', { id }, owner);
      }
      await mutate('close_check', { checkId: l.id }, owner);
      lines.push('closed a test bill left open by an earlier run (' + l.id + ')');
    }

    const checkId = PREFIX + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
    const payId = crypto.randomUUID();
    const payer = crypto.randomBytes(20).toString('hex');   // 40 characters
    const contact = 'onboarding-check@example.com';
    let code = null, key = null;
    try {
      await check('issue a code for table ' + TABLE, async () => {
        const r = await sb.rpc('aal_table_tokens', { p_rid: rid, p_body: { op: 'issue', table: TABLE } }, owner);
        const t = (r.tokens || []).filter(x => x.table === TABLE)[0];
        expect(t && /^tbl_[0-9a-f]{48}$/.test(t.token), 'no tbl_ code came back for table ' + TABLE);
        code = t.token;
      });
      await check('open a $1.00 bill on table ' + TABLE, async () => {
        const c = await mutate('open_check', { id: checkId, table: TABLE, lines: [{ id: 'aalayna-setup-test', q: 1, p: 1, name: 'Aalayna setup test' }] }, owner);
        expect(c && c.id === checkId, 'the server returned another bill (' + (c && c.id) + '); is a bill already open on table ' + TABLE + '?');
        expect(c.totalCents === 100 && c.table === TABLE && c.source === 'staff' && !c.closedAt, 'the bill came back as ' + JSON.stringify({ totalCents: c.totalCents, table: c.table, source: c.source }));
        return { detail: checkId };
      });
      await check('first scan returns the open bill and a bill key', async () => {
        const s = await scan(code);
        expect(s.checkId === checkId, 'scan returned bill ' + s.checkId);
        expect(/^chk_/.test(s.key || ''), 'scan returned no chk_ key');
        key = s.key;
      });
      await check('second scan returns the same key', async () => {
        const s = await scan(code);
        expect(s.key === key, 'the second scan returned a different key');
      });
      await check('the scan carries the published menu', async () => {
        const s = await scan(code);
        const live = (s.docs || []).filter(d => d.key === 'aal.live')[0];
        const menu = ctx.state.steps.menu;
        if (!menu || menu.status !== 'done') return { skip: 'the menu is not published yet' };
        expect(live && live.body && Array.isArray(live.body.items) && live.body.items.length, 'no aal.live in the scan');
        expect(live.body.version === menu.data.version, 'the scan shows menu version ' + live.body.version + ', published ' + menu.data.version);
      });
      await check('guest reserves $1.00 cash with a 40-character payer token', async () => {
        expect(payer.length === 40, 'payer token length ' + payer.length);
        const p = await mutate('reserve', { id: payId, requestId: crypto.randomUUID(), checkId, rail: 'cash', amount: 1, tip: 0, items: {} }, { key }, payer);
        expect(p && p.id === payId && p.status === 'pending' && Number(p.amount) === 1, 'reserve returned ' + JSON.stringify(p && { status: p.status, amount: p.amount }));
      });
      await check('owner confirms the cash', async () => {
        const p = await mutate('confirm_cash', { id: payId }, owner);
        expect(p && p.status === 'confirmed', 'status is ' + (p && p.status));
      });
      await check('owner closes the bill', async () => {
        const c = await mutate('close_check', { checkId }, owner);
        expect(c && c.closedAt, 'the bill has no closedAt');
      });
      await check('guest key reads the closed bill', async () => {
        const s = await sb.rpc('aal_snapshot', { p_rid: rid }, { key });
        expect(s.role === 'guest' && s.checkId === checkId, 'snapshot role ' + s.role + ', bill ' + s.checkId);
        const c = (s.rows || []).filter(r => r.collection === 'aal.checks' && r.id === checkId)[0];
        expect(c && c.body.closedAt, 'the guest does not see the bill as closed');
        const p = (s.rows || []).filter(r => r.collection === 'aal.settle' && r.id === payId)[0];
        expect(p && p.body.status === 'confirmed', 'the guest does not see the confirmed payment');
      });
      await check('guest receipt request to ' + contact + ' is accepted', async () => {
        const r = await mutate('receipt', { id: payId, requestId: crypto.randomUUID(), contact, channel: 'email', receipt: true, marketing: false }, { key }, payer);
        expect(r && r.saved === true, 'receipt returned ' + JSON.stringify(r));
      });
      await check('a fresh scan returns no bill key', async () => {
        const s = await scan(code);
        expect(s.checkId == null && s.key == null, 'the scan still returns bill ' + s.checkId);
      });
    } finally {
      // never leave a live code on table 9999, whatever failed above
      const wasBroken = broken;
      broken = false;
      await check('revoke table ' + TABLE + '\'s code', async () => {
        if (!code) {
          const l = await sb.rpc('aal_table_tokens', { p_rid: rid, p_body: { op: 'list' } }, owner);
          if (!(l.tokens || []).some(x => x.table === TABLE)) return { skip: 'no code was issued' };
        }
        const r = await sb.rpc('aal_table_tokens', { p_rid: rid, p_body: { op: 'revoke', table: TABLE } }, owner);
        expect(!(r.tokens || []).some(x => x.table === TABLE), 'table ' + TABLE + ' still has a live code');
      });
      broken = wasBroken || broken;
    }
    const failed = checks.filter(c => c.status === 'fail');
    const passed = checks.filter(c => c.status === 'pass');
    checks.forEach(c => lines.push(c.status + '  ' + c.name + (c.detail && c.status !== 'pass' ? ': ' + c.detail : '')));
    lines.push('left in place: the closed $1.00 test bill ' + checkId + ' on table ' + TABLE + ', its cash payment, their events and a guest record for ' +
      contact + ' (the venue\'s audit trail; it shows in today\'s dashboard figures)');
    return {
      ok: failed.length === 0,
      summary: passed.length + ' of ' + checks.length + ' checks passed' + (failed.length ? '; failed: ' + failed.map(c => c.name).join('; ') : '') +
        '; test bill left closed on table ' + TABLE,
      data: { checkId, checks, at: new Date().toISOString() },
      lines
    };
  }
};
