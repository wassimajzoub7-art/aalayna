'use strict';
/* Step 1. Create the venue with the admin key, or find it again.
   in:  inputs.name, inputs.place, inputs.slug; the theme if already known (flags or step 2)
   out: data {restaurant_id, slug, existed}; the owner key goes to state.venue, never to data
   Idempotent: a venue already listed under this slug is reused and its keys are not rotated. */
const { themeFromState } = require('../lib/venue');

module.exports = {
  name: 'register',
  description: 'Register the venue on Supabase with its profile (admin key)',
  env: ['AALAYNA_ADMIN_KEY'],
  plan: function (ctx) {
    return 'find "' + ctx.inputs.slug + '" in aal_admin_list_venues, else aal_admin_register_venue("' + ctx.inputs.name + '", "' +
      ctx.inputs.place + '") with profile {slug, menu_pack, demo_payments: false}; store restaurant_id and the owner key in the state file';
  },
  run: async function (ctx) {
    const admin = { admin: ctx.env.AALAYNA_ADMIN_KEY };
    const rid = ctx.rid;
    const list = await ctx.sb.rpc('aal_admin_list_venues', {}, admin);
    const bySlug = (list || []).filter(function (v) { return v.profile && v.profile.slug === ctx.inputs.slug; })[0];
    const byRid = (list || []).filter(function (v) { return v.restaurant_id === rid; })[0];
    if (bySlug && bySlug.restaurant_id !== rid) {
      return { ok: false, summary: 'The slug ' + ctx.inputs.slug + ' already belongs to another venue (' + (bySlug.profile.name || bySlug.name) +
        ', ' + (bySlug.profile.place || '') + '). Choose another --slug.' };
    }
    if (byRid && byRid.profile && byRid.profile.slug && byRid.profile.slug !== ctx.inputs.slug) {
      return { ok: false, summary: ctx.inputs.name + ', ' + ctx.inputs.place + ' is already registered with the slug ' + byRid.profile.slug +
        '. Run again with --slug ' + byRid.profile.slug + ' (changing a slug breaks printed table cards).' };
    }
    if (bySlug) {
      ctx.setVenue({ restaurant_id: bySlug.restaurant_id, owner_key: bySlug.owner_key, slug: ctx.inputs.slug });
      return { ok: true, summary: ctx.inputs.name + ', ' + ctx.inputs.place + ' was already registered as ' + ctx.inputs.slug + '; reused it, keys unchanged',
        data: { restaurant_id: bySlug.restaurant_id, slug: ctx.inputs.slug, existed: true, demo_payments: bySlug.profile.demo_payments !== false } };
    }
    const profile = Object.assign({ slug: ctx.inputs.slug, menu_pack: ctx.inputs.slug, demo_payments: false }, themeFromState(ctx));
    const res = await ctx.sb.rpc('aal_admin_register_venue',
      { p_name: ctx.inputs.name, p_place: ctx.inputs.place, p_slug: ctx.inputs.slug, p_profile: profile }, admin);
    if (!res || res.restaurant_id !== rid || !/^own_/.test(res.owner_key || '')) {
      return { ok: false, summary: 'The server registered something unexpected (restaurant id ' + (res && res.restaurant_id) + ', expected ' + rid + ').' };
    }
    ctx.setVenue({ restaurant_id: res.restaurant_id, owner_key: res.owner_key, slug: res.slug || ctx.inputs.slug });
    return { ok: true, summary: ctx.inputs.name + ', ' + ctx.inputs.place + ' registered as ' + (res.slug || ctx.inputs.slug) +
        (res.existed ? ' (the venue existed without this slug; profile written, keys unchanged)' : ''),
      data: { restaurant_id: res.restaurant_id, slug: res.slug || ctx.inputs.slug, existed: !!res.existed,
        demo_payments: !!(res.profile && res.profile.demo_payments) } };
  }
};
