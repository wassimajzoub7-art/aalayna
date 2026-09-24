'use strict';
/* Step 7. The welcome note for the owner, drafted, never sent.
   in:  the venue, the published menu, the tables, the staff list
   out: onboarding/<slug>-welcome.md; data {path, arabic}
   The model writes only the prose: three lines on what Aalayna does for the guests, a
   paragraph on day one, and an Arabic greeting line when it can give a standard one. It is
   given the facts and told to add none. Everything factual (links, sign-in, staff, cards,
   contact) is filled in by this code, so a link or an instruction cannot be invented. */
const fs = require('fs');
const path = require('path');
const { callTool, DEFAULT_MODEL } = require('../lib/anthropic');

const TOOL = {
  name: 'draft_welcome',
  description: 'The prose parts of the welcome note.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['arabic_greeting', 'what_it_does', 'day_one'],
    properties: {
      arabic_greeting: { type: 'string', description: 'One short, standard Arabic greeting line addressed to the owner of the restaurant, or an empty string if unsure.' },
      what_it_does: { type: 'array', items: { type: 'string' }, description: 'Exactly three short lines on what Aalayna does for the restaurant\'s guests.' },
      day_one: { type: 'string', description: 'Three to five plain sentences on what happens on the first day of service.' }
    }
  }
};

const FACTS = [
  'Guests scan the card on their table with the phone camera. No app, no account. The menu opens in English, French or Arabic.',
  'Once a waiter enters the table\'s bill on the dashboard, the guest sees the bill on the phone, can split it by item or by amount, and asks to pay cash.',
  'A cash request shows on the dashboard; the waiter collects the cash and taps Confirm cash received. Nothing is paid until staff confirm it.',
  'Card and digital wallet payments are not connected yet: guests pay cash through their server.',
  'A guest can ask for the receipt by email and leave a rating after paying.',
  'The owner edits the menu in the editor and publishes; the next guest who opens the menu sees the new version.',
  'The owner sees bills, cash to collect, payments and daily figures on the dashboard.'
];

function clean(s) {
  return String(s || '').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').replace(/[ \t]+/g, ' ').trim();
}
function fixture(ctx) { return ctx.opts.fixtureDir ? path.join(ctx.opts.fixtureDir, 'welcome.json') : null; }

function compose(ctx, prose) {
  const i = ctx.inputs, st = ctx.state.steps;
  const menu = st.menu && st.menu.status === 'done' ? st.menu.data : null;
  const staff = (st.staff && st.staff.data && st.staff.data.staff) || [{ email: i.owner, role: 'owner' }].concat(i.staff);
  const others = staff.filter(function (s) { return s.email !== i.owner; });
  const out = [];
  if (prose.arabic) out.push(prose.arabic, '');
  out.push('# Welcome to Aalayna, ' + i.name, '');
  prose.lines.forEach(function (l) { out.push(l + '  '); });
  out.push('', '## Your dashboard', '', 'https://aalayna.com/dashboard.html', '',
    'Sign in with ' + i.owner + '. A six-digit code arrives by email; there is no password. Bills, cash to collect, payments and daily figures are here.', '',
    '## Your menu', '', 'https://aalayna.com/editor.html', '',
    'Same sign-in. Change a price, mark a dish as sold out, then publish.' +
      (menu ? ' Your menu is already in: ' + menu.items + ' dishes in ' + menu.sections + ' sections. Please read through it once and tell me anything to fix.' : ''), '',
    '## Your staff', '');
  if (others.length) {
    others.forEach(function (s) { out.push('- ' + s.email + ' (' + s.role + ')'); });
    out.push('');
  }
  out.push('Each person opens https://aalayna.com/dashboard.html on their own phone and signs in with their own email; the six-digit code arrives by email. ' +
    'Managers can do everything except manage staff. Waiters open and change bills and confirm cash. To add or remove someone, message me.', '',
    '## Table cards', '',
    i.tables + ' cards, one per table, are in the print sheet that comes with this note. Put each on its table. A card opens that table\'s current bill; if one is lost or copied, tell me and I replace it.', '',
    '## Day one', '', prose.dayOne, '',
    '## Contact', '', 'Wassim, WhatsApp [WhatsApp number]', '');
  return out.join('\n');
}

module.exports = {
  name: 'welcome',
  description: 'Draft the welcome note for the owner (model); the founder sends it',
  TOOL,
  env: function (ctx) { return fixture(ctx) ? [] : ['ANTHROPIC_API_KEY']; },
  skip: function (ctx) { return ctx.opts.noWelcome ? 'skipped (--no-welcome)' : null; },
  plan: function (ctx) {
    return 'ask ' + (ctx.inputs.model || DEFAULT_MODEL) + (fixture(ctx) ? ' (replayed from ' + fixture(ctx) + ')' : '') +
      ' for the prose, fill in links, sign-in, staff and cards, write ' + path.relative(ctx.cwd, ctx.paths.welcome) + ' (not sent)';
  },
  run: async function (ctx) {
    const i = ctx.inputs;
    const got = await callTool({
      apiKey: ctx.env.ANTHROPIC_API_KEY, env: ctx.env, fetch: ctx.fetch, model: i.model, fixture: fixture(ctx), tool: TOOL, maxTokens: 4000,
      strict: ctx.opts.strict, effort: ctx.opts.effort, log: ctx.log,
      system: 'You draft short onboarding notes for restaurant owners in Lebanon on behalf of the founder of Aalayna. Plain words, no marketing, no exclamation marks, no emojis, no dashes as punctuation. ' +
        'Use only the facts given; do not add features, prices, dates or promises.',
      prompt: 'Restaurant: ' + i.name + ', ' + i.place + '. Tables: ' + i.tables + '.\nFacts about Aalayna:\n- ' + FACTS.join('\n- ') +
        '\n\nWrite three short lines on what Aalayna does for this restaurant\'s guests, a day-one paragraph for the owner, and one standard Arabic greeting line ' +
        '(for example a common welcome with the restaurant name) only if you are sure of it; otherwise an empty string.'
    });
    const lines = (Array.isArray(got.what_it_does) ? got.what_it_does : []).map(clean).filter(Boolean);
    const dayOne = clean(got.day_one);
    if (lines.length < 3 || !dayOne) return { ok: false, summary: 'The model draft was incomplete (' + lines.length + ' intro lines, day one ' + (dayOne ? 'present' : 'missing') + '). Run again, or --no-welcome.' };
    let arabic = clean(got.arabic_greeting);
    if (!/[؀-ۿ]/.test(arabic) || arabic.length > 80 || /[<>#*]/.test(arabic)) arabic = '';
    const md = compose(ctx, { arabic, lines: lines.slice(0, 3), dayOne });
    fs.mkdirSync(path.dirname(ctx.paths.welcome), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ctx.paths.welcome, md, { mode: 0o600 });
    return {
      ok: true,
      summary: 'drafted ' + path.relative(ctx.cwd, ctx.paths.welcome) + (arabic ? ' with an Arabic greeting' : ' (no Arabic greeting)') + '; not sent',
      data: { path: path.relative(ctx.cwd, ctx.paths.welcome), arabic: !!arabic }
    };
  }
};
