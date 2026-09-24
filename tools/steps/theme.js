'use strict';
/* Step 2. Brand colour, background and font from the menu itself.
   in:  inputs.files (the menu PDF or photos); --brand, --bg, --font override the model
   out: data {brand, bg, font, reasoning, source}; written to the venue profile with
        aal_admin_update_profile (admin key)
   The model sees the menu and answers with the set_theme tool. The font must come from
   FONTS below: there is no font list in the store or the editor (aalayna-store.js accepts
   any Google Fonts name and loads it at weights 400 to 800), so this list is the fixed
   choice, Google Fonts families checked to exist, including Arabic-capable ones. */
const path = require('path');
const { callTool, fileBlocks, DEFAULT_MODEL } = require('../lib/anthropic');
const { hex, luminance, FONT } = require('../lib/venue');

const FONTS = [
  // sans
  'Montserrat', 'Inter', 'Poppins', 'Raleway', 'Work Sans', 'Nunito', 'Manrope', 'Plus Jakarta Sans', 'DM Sans',
  'Open Sans', 'Outfit', 'Figtree', 'Lexend', 'Archivo', 'Barlow', 'Rubik', 'Josefin Sans', 'Oswald', 'Kanit',
  'Red Hat Display', 'Space Grotesk', 'Syne', 'Lato',
  // serif and display
  'Playfair Display', 'Fraunces', 'EB Garamond', 'Lora', 'Cormorant Garamond', 'Libre Baskerville', 'Crimson Pro',
  'Bodoni Moda', 'Cinzel', 'Merriweather', 'Alegreya',
  // Arabic and Latin in one family
  'Cairo', 'Tajawal', 'Almarai', 'Changa', 'Readex Pro', 'El Messiri', 'Noto Kufi Arabic', 'Alexandria', 'Amiri'
];
const MIN_BG_LUMINANCE = 0.7;   // the guest app draws dark text on the background

const TOOL = {
  name: 'set_theme',
  description: 'Record the restaurant theme read from its menu.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['brand', 'bg', 'font', 'reasoning'],
    properties: {
      brand: { type: 'string', description: 'The main brand colour as a six digit hex, like #EA312B. It fills buttons with white text, so it must not be pale.' },
      bg: { type: 'string', description: 'A light page background as a six digit hex, like #F0EFEA, taken from or matching the menu paper.' },
      font: { type: 'string', enum: FONTS, description: 'The listed Google Fonts family closest to the menu typography.' },
      reasoning: { type: 'string', description: 'One sentence on why these match the menu.' }
    }
  }
};

function needsModel(ctx) {
  return !(ctx.opts.brand && ctx.opts.bg && ctx.opts.font);
}
function fixture(ctx) { return ctx.opts.fixtureDir ? path.join(ctx.opts.fixtureDir, 'theme.json') : null; }

module.exports = {
  name: 'theme',
  description: 'Choose brand colour, background and font from the menu (model), write them to the profile',
  FONTS,
  TOOL,
  env: function (ctx) {
    return ['AALAYNA_ADMIN_KEY'].concat(needsModel(ctx) && !fixture(ctx) ? ['ANTHROPIC_API_KEY'] : []);
  },
  skip: function (ctx) { return ctx.opts.noTheme ? 'skipped (--no-theme)' : null; },
  plan: function (ctx) {
    return (needsModel(ctx) ? 'send ' + ctx.inputs.files.length + ' menu file(s) to ' + (ctx.inputs.model || DEFAULT_MODEL) +
      (fixture(ctx) ? ' (replayed from ' + fixture(ctx) + ')' : '') + ' for brand, background and font; ' : 'use --brand, --bg, --font as given; ') +
      'write them with aal_admin_update_profile';
  },
  run: async function (ctx) {
    let got = {}, source = 'flags', notes = [];
    if (needsModel(ctx)) {
      if (!ctx.inputs.files.length && !fixture(ctx)) return { ok: false, summary: 'No menu file was given, so there is nothing to read the theme from. Pass the menu PDF or photos, or --brand, --bg and --font.' };
      got = await callTool({
        apiKey: ctx.env.ANTHROPIC_API_KEY, env: ctx.env, fetch: ctx.fetch, model: ctx.inputs.model, fixture: fixture(ctx), tool: TOOL,
        strict: ctx.opts.strict, effort: ctx.opts.effort, log: ctx.log,
        blocks: fixture(ctx) ? [] : fileBlocks(ctx.inputs.files, ctx.cwd),
        system: 'You set up the digital menu of a restaurant in Lebanon. You read its printed menu and choose colours and a typeface that make the digital menu feel like the printed one.',
        prompt: 'This is the menu of ' + ctx.inputs.name + ' in ' + ctx.inputs.place + '. Choose the brand colour (the dominant accent of the logo or headings), ' +
          'a light background that matches the paper, and the closest font from the list. Use only colours you can see in the menu.',
        maxTokens: 4000
      });
      source = 'model';
    }
    const brand = ctx.opts.brand ? hex(ctx.opts.brand) : hex(got.brand);
    let bg = ctx.opts.bg ? hex(ctx.opts.bg) : hex(got.bg);
    let font = ctx.opts.font || got.font || '';
    if (ctx.opts.brand && !brand) return { ok: false, summary: '--brand must be a six digit hex colour, like #EA312B.' };
    if (ctx.opts.bg && !bg) return { ok: false, summary: '--bg must be a six digit hex colour, like #F0EFEA.' };
    if (ctx.opts.font && !FONT.test(ctx.opts.font)) return { ok: false, summary: '--font must be a Google Fonts name: letters, digits and spaces, up to 40 characters.' };
    if (!brand) return { ok: false, summary: 'The model gave no usable brand colour (' + JSON.stringify(got.brand) + '). Pass --brand.' };
    if (!ctx.opts.bg && bg && luminance(bg) < MIN_BG_LUMINANCE) { notes.push('background ' + bg + ' is too dark for the guest app, left at the default'); bg = null; }
    if (!ctx.opts.font && FONTS.indexOf(font) < 0) { notes.push('font ' + JSON.stringify(font) + ' is not on the list, left at the default'); font = ''; }
    const profile = { brand: brand };
    if (bg) profile.bg = bg;
    if (font) profile.font = font;
    await ctx.sb.rpc('aal_admin_update_profile', { p_rid: ctx.rid, p_profile: profile }, { admin: ctx.env.AALAYNA_ADMIN_KEY });
    return {
      ok: true,
      summary: 'brand ' + brand + ', background ' + (bg || 'default') + ', font ' + (font || 'default') + ' (' + (source === 'model' ? 'from the menu' : 'from flags') +
        (ctx.opts.brand || ctx.opts.bg || ctx.opts.font ? (source === 'model' ? ', flags win' : '') : '') + ')' + (notes.length ? '; ' + notes.join('; ') : ''),
      data: { brand, bg, font: font || null, reasoning: String(got.reasoning || '').slice(0, 400), source },
      lines: got.reasoning ? ['model: ' + String(got.reasoning).slice(0, 300)] : []
    };
  }
};
