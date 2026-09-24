'use strict';
/* Venue identity and theme helpers shared by the steps. */

/* restaurant_id is the JSON of [lower-cased name, lower-cased place] (aalayna-store.js
   venueId(), admin.sql aal_admin_register_venue). */
function restaurantId(name, place) {
  return JSON.stringify([String(name).trim().toLowerCase(), String(place || '').trim().toLowerCase()]);
}

/* The same rule as aal_admin_slug in admin.sql, for a slug the founder did not give. */
function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');
  return s || 'venue';
}
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function hex(v) {
  const s = String(v || '').trim().replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}$/.test(s) ? '#' + s.toUpperCase() : null;
}
/* relative luminance 0..1 (sRGB, WCAG) */
function luminance(h) {
  const n = parseInt(h.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(function (x) {
    x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const FONT = /^[A-Za-z0-9 +]{1,40}$/;

/* The theme as known now: override flags first, then what step 2 chose. Only set keys. */
function themeFromState(ctx) {
  const t = (ctx.state.steps.theme && ctx.state.steps.theme.data) || {};
  const out = {};
  const brand = ctx.opts.brand || t.brand, bg = ctx.opts.bg || t.bg, font = ctx.opts.font || t.font;
  if (brand) out.brand = brand;
  if (bg) out.bg = bg;
  if (font) out.font = font;
  return out;
}

module.exports = { restaurantId, slugify, SLUG, hex, luminance, FONT, themeFromState };
