/* The optional second path of the morning close narrative (T4): the rules' text, plus the
   figures it was written from, go to the Claude API for a more natural wording in the venue's
   language. Off unless CLOSE_NARRATIVE_MODEL_KEY is set on the function. The rules' text is
   the answer on any error, refusal, timeout or doubt, and whenever the rewrite's numbers are
   not exactly the rules' numbers (sameNumbers in close-narrative.js). Plain ES module, no
   dependencies: fetch is the global one or injected.

     createNarrator({env, fetch, log}) -> async (input) -> narrative
         closeNarrative(input), then, with a key, rewriteNarrative. The result carries
         source: 'rules' | 'model' and, when the model was tried and not used, fallback: why.
     rewriteNarrative({narrative, input, apiKey, model, fetch, baseUrl, timeoutMs})
         -> {text, source, fallback?}

   Environment: CLOSE_NARRATIVE_MODEL_KEY (an Anthropic API key; unset = rules only),
   CLOSE_NARRATIVE_MODEL (default claude-sonnet-5-5), ANTHROPIC_BASE_URL (tests).
   What is sent: the rules' sentences and the day's numbers (no venue name, no dish name, no
   table-side text, no contact detail). */

import { closeNarrative, sameNumbers, toDay } from './close-narrative.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const API_VERSION = '2026-10-21';
const LANGS = { en: 'English', fr: 'French', ar: 'Modern Standard Arabic' };

export const SYSTEM = [
  'You rewrite a short daily report for a restaurant owner so it reads naturally, as a careful manager would say it.',
  'Rules, all of them strict:',
  '1. Keep every number exactly as written, in the same notation (digits, currency, separators). Do not add, drop, round, convert or spell out any number, and do not compute new ones.',
  '2. Add nothing: no fact, cause, advice, praise or greeting that is not in the report. Keep each instruction about what to check.',
  '3. Keep the same order and about the same length (the same number of sentences, give or take one).',
  '4. Write in the same language as the report. Plain prose, no lists, no headings, no emoji, no em dash.',
  '5. The figures are given only so you understand the report; never mention a figure the report does not mention.',
  'Answer with the rewritten report only.'
].join('\n');

function envGet(env) {
  if (typeof env === 'function') return env;
  if (env && typeof env === 'object') return (k) => env[k];
  return () => undefined;
}

/* The day's numbers, as plain data, so the model knows what each number in the text means. */
function figuresOf(input) {
  const pick = (x) => { const d = toDay(x); if (!d) return null; return { takingsCents: d.takingsCents, billsClosed: d.billsClosed, tipsCents: d.tipsCents, cashCents: d.cashCents, averageBillCents: d.averageBillCents, settleMinutes: d.settleMinutes }; };
  return { day: input && input.day, today: pick(input && input.today), sameWeekdayLastWeek: pick(input && input.lastWeek) };
}

export function buildRequest({ narrative, input, model }) {
  const lang = narrative.lang in LANGS ? narrative.lang : 'en';
  return {
    model: model || DEFAULT_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: `Language: ${LANGS[lang]}.\n\nFigures (for understanding only):\n${JSON.stringify(figuresOf(input))}\n\nReport to rewrite:\n${narrative.text}` }]
  };
}

/* Why a rewrite is not used, or null when it is good. */
export function rejectRewrite(original, rewrite, lang) {
  const t = String(rewrite || '').trim();
  if (!t) return 'empty answer';
  if (/[—]/.test(t)) return 'em dash';
  if (/https?:\/\/|www\.|@/i.test(t)) return 'link or address';
  if (/^\s*([-*#]|\d+\.)\s/m.test(t) || /\n\s*\n/.test(t)) return 'not plain prose';
  const ratio = t.length / Math.max(1, original.length);
  if (ratio < 0.6 || ratio > 1.5) return 'length changed';
  if (!sameNumbers(original, t, lang)) return 'numbers changed';
  return null;
}

export async function rewriteNarrative({ narrative, input, apiKey, model, fetch: fetchImpl, baseUrl, timeoutMs }) {
  const rules = { text: narrative.text, source: 'rules' };
  if (!apiKey || !narrative || !narrative.text || narrative.sentences && narrative.sentences.length < 2) return rules;
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 20000) : null;
  try {
    const res = await doFetch(String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' },
      body: JSON.stringify(buildRequest({ narrative, input, model })),
      signal: ctrl ? ctrl.signal : undefined
    });
    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
    if (!res.ok) return Object.assign(rules, { fallback: `model API ${res.status}` });
    if (!body || body.type === 'error') return Object.assign(rules, { fallback: 'no answer' });
    if (body.stop_reason === 'refusal') return Object.assign(rules, { fallback: 'refusal' });
    if (body.stop_reason === 'max_tokens') return Object.assign(rules, { fallback: 'cut off' });
    const text = (body.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
    const why = rejectRewrite(narrative.text, text, narrative.lang);
    if (why) return Object.assign(rules, { fallback: why });
    return { text: text.replace(/\s*\n\s*/g, ' '), source: 'model' };
  } catch (e) {
    return Object.assign(rules, { fallback: e && e.name === 'AbortError' ? 'timeout' : 'unreachable' });
  } finally { if (timer) clearTimeout(timer); }
}

export function createNarrator({ env, fetch: fetchImpl, log } = {}) {
  const get = envGet(env);
  return async function narrate(input) {
    const n = closeNarrative(input);
    const apiKey = get('CLOSE_NARRATIVE_MODEL_KEY');
    if (!apiKey) return Object.assign(n, { source: 'rules' });
    const r = await rewriteNarrative({ narrative: n, input, apiKey, model: get('CLOSE_NARRATIVE_MODEL') || DEFAULT_MODEL, fetch: fetchImpl, baseUrl: get('ANTHROPIC_BASE_URL') });
    if (r.fallback && typeof log === 'function') log('close narrative: model not used (' + r.fallback + ')');
    return Object.assign(n, { text: r.text, source: r.source }, r.fallback ? { fallback: r.fallback } : {});
  };
}
