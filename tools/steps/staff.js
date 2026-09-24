'use strict';
/* Step 5. The staff list.
   in:  inputs.owner (email), inputs.staff [{email, role}]
   out: data {invited: [...], present: [...], staff: [{email, role}]}
   aal_staff invite only adds a staff_members row (auth-2026-09-24.sql); it sends no email.
   Each person signs in at the dashboard or editor with their email and gets a six-digit
   code then. Idempotent: an email already live on the list is not invited again. A
   revoked email is not brought back and a different role is not changed: both are the
   owner's decisions, so they are reported for admin.html instead. */

module.exports = {
  name: 'staff',
  description: 'Invite the owner and staff emails to the staff list (no email is sent)',
  env: [],
  plan: function (ctx) {
    return 'aal_staff list, then invite ' + [ctx.inputs.owner + ' as owner'].concat(ctx.inputs.staff.map(function (s) { return s.email + ' as ' + s.role; })).join(', ') +
      ' unless already on the list';
  },
  run: async function (ctx) {
    const cred = { key: ctx.ownerKey };
    const want = [{ email: ctx.inputs.owner, role: 'owner' }].concat(ctx.inputs.staff);
    let res = await ctx.sb.rpc('aal_staff', { p_rid: ctx.rid, p_body: { op: 'list' } }, cred);
    const on = {};
    (res.staff || []).forEach(function (s) { on[s.email] = s; });
    const invited = [], present = [], lines = [];
    for (const p of want) {
      const cur = on[p.email];
      if (cur && !cur.revoked_at) {
        present.push(p.email);
        if (cur.role !== p.role) lines.push(p.email + ' is already on the list as ' + cur.role + ', not ' + p.role + '; left unchanged (change it in admin.html, Staff).');
        continue;
      }
      if (cur && cur.revoked_at) {
        lines.push(p.email + ' was revoked on ' + String(cur.revoked_at).slice(0, 10) + '; not invited again (do it in admin.html, Staff, if that is intended).');
        continue;
      }
      res = await ctx.sb.rpc('aal_staff', { p_rid: ctx.rid, p_body: { op: 'invite', email: p.email, role: p.role } }, cred);
      invited.push(p.email);
    }
    const staff = (res.staff || []).filter(function (s) { return !s.revoked_at; }).map(function (s) { return { email: s.email, role: s.role }; });
    staff.forEach(function (s) { lines.push(s.role + ': ' + s.email); });
    return {
      ok: true,
      summary: 'invited ' + invited.length + ', already on the list ' + present.length + '; ' + staff.length + ' live staff member(s), no email sent',
      data: { invited, present, staff },
      lines
    };
  }
};
