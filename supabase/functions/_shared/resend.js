/* Transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email).
   Plain ES module: Deno runs it in the functions, node --test runs it in tests/.

   Two ways in:
     send({to, subject, text, html, from, attachments, idempotencyKey}) -> Promise<{id}>
         module-level, configured from the environment (RESEND_API_KEY), global fetch.
     createResend({apiKey, fetch, sleep}) -> {send}
         the same call with explicit configuration, for tests and injected handlers.

   Message fields
     to              one address (string) or an array of addresses
     subject, text   required; html optional (text is always sent, so every client can read it)
     from            default "Aalayna <receipts@aalayna.com>" (aalayna.com is verified in Resend)
     attachments     optional [{filename, content}] with content in base64
     idempotencyKey  optional; sent as the Idempotency-Key header. Resend answers a repeat
                     of the same key and payload within 24 hours with the first email's id
                     instead of sending again.
   No reply_to is set and no tags or tracking options are sent.

   Retries: a 429, a 5xx or a network failure is retried once, after Retry-After (capped at
   5 s) or 1 s. Anything else throws at once.
   Errors: ResendError {message, status, retryable}. message never contains an address:
   anything shaped like one is replaced with "[address]", so it can be stored in a log. */

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'Aalayna <receipts@aalayna.com>';

export class ResendError extends Error {
  constructor(message, status, retryable) {
    super(scrub(message));
    this.name = 'ResendError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function scrub(s) {
  return String(s == null ? '' : s).replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '[address]').slice(0, 300);
}

function apiKeyFromEnv() {
  try { if (globalThis.Deno && globalThis.Deno.env) return globalThis.Deno.env.get('RESEND_API_KEY'); } catch (_) { /* no permission */ }
  return globalThis.process && globalThis.process.env ? globalThis.process.env.RESEND_API_KEY : undefined;
}

export function createResend({ apiKey, fetch: fetchImpl, sleep } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function once(payload, idempotencyKey) {
    const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
    let res;
    try {
      res = await doFetch(RESEND_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (e) {
      throw Object.assign(new ResendError('Could not reach Resend (' + (e && e.message || e) + ')', 0, true), { after: 1000 });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (res.ok && data && data.id) return { id: String(data.id) };
    const retryable = res.status === 429 || res.status >= 500;
    const ra = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
    const err = new ResendError('Resend ' + res.status + ': ' + (data && (data.message || data.name) || text.slice(0, 200) || 'no id in the answer'), res.status, retryable || (res.ok && !data));
    err.after = Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 5000) : 1000;
    throw err;
  }

  async function send(message) {
    const m = message || {};
    if (!apiKey) throw new ResendError('RESEND_API_KEY is not set', 0, false);
    const to = Array.isArray(m.to) ? m.to : [m.to];
    if (!to.length || to.some((a) => typeof a !== 'string' || !a)) throw new ResendError('No recipient', 0, false);
    if (!m.subject || !m.text) throw new ResendError('subject and text are required', 0, false);
    const payload = { from: m.from || DEFAULT_FROM, to, subject: String(m.subject), text: String(m.text) };
    if (m.html) payload.html = String(m.html);
    if (Array.isArray(m.attachments) && m.attachments.length) payload.attachments = m.attachments;
    try {
      return await once(payload, m.idempotencyKey);
    } catch (e) {
      if (!(e instanceof ResendError) || !e.retryable) throw e;
      await wait(e.after || 1000);
      return once(payload, m.idempotencyKey);
    }
  }
  return { send };
}

export const send = (message) => createResend({ apiKey: apiKeyFromEnv() }).send(message);
