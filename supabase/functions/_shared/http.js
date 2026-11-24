/* Request helpers shared by the Edge Functions that face the public internet. Plain ES
   module: Deno runs it in the functions, node --test runs it in tests/.

     readCapped(request, max)   -> {text} | {tooLarge:true} | {invalid:true}
         Reads at most max bytes (by Content-Length, then by counting); {invalid} for a body
         that is not UTF-8.
     createLimiter({max, windowMs, maxKeys}) -> {take(key, at) -> boolean, size() -> number}
         A fixed window per key, in this instance's memory. take answers false once a key has
         used its max within the window. At most maxKeys (default 10,000) keys are held: a new
         key first drops the windows that have ended, then, if the map is still full, the
         key whose window started first. Eviction is one key at a time, oldest first, so a
         flood of new keys can never wipe every other caller's count at once (until 2026-11
         the whole map was cleared past 10,000 keys, which reset everyone's limit).
     clientAddress(request) -> string
         The caller's address for rate limiting, from what the platform sets, never from what
         the client may send (see the note above the function).
     reply(status, body, headers) -> Response   JSON body with Content-Type set.
     b64u(str) / unb64u(str)   base64url of a UTF-8 string and back (throws on bad input). */

export async function readCapped(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  const chunks = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch (_) { /* already closed */ } return { tooLarge: true }; }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(all) }; } catch (_) { return { invalid: true }; }
}

export const LIMITER_MAX_KEYS = 10000;

export function createLimiter({ max = 120, windowMs = 60 * 1000, maxKeys = LIMITER_MAX_KEYS } = {}) {
  // Insertion order is window-start order: a key whose window restarts is deleted and set
  // again, so it moves to the end. The first entries are therefore always the oldest windows.
  const hits = new Map();
  return {
    take(key, at) {
      const t = at instanceof Date ? at.getTime() : Number(at);
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) {
        if (h) hits.delete(key);
        // windows that have ended carry no count worth keeping
        for (const [k, old] of hits) { if (t - old.start < windowMs) break; hits.delete(k); }
        // still full: the oldest window goes, one at a time
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
        h = { start: t, n: 0 };
        hits.set(key, h);
      }
      h.n += 1;
      return h.n <= max;
    },
    size: () => hits.size,
  };
}

/* The caller's address, for rate limiting only (never for a decision about money).
   What Supabase Edge Functions see (from Supabase's documentation and community reports,
   2026-11; Supabase documents no client-address header for Edge Functions, so the rollout
   checks it on live, supabase/README.md "Rate limits"): the function is reached through
   Supabase's API gateway, which is served by Cloudflare. Deno.serve's info.remoteAddr is the
   gateway's address, not the caller's, so it is not used. Cloudflare sets
   CF-Connecting-IP itself and replaces any value a client sends, so it is the one header a
   caller cannot forge. X-Forwarded-For is appended to, not replaced: a client can put any
   address first, so its first entry is the caller's to choose; only the last entry was added
   by the infrastructure. X-Real-IP is not documented for Edge Functions and is not used.
   Order: CF-Connecting-IP, else the last X-Forwarded-For entry, else 'unknown'. 'unknown'
   is one shared key: callers the platform cannot place share one count, which can only make
   the limit stricter, never let a caller step around it. Anything that is not a plausible
   IPv4 or IPv6 address is ignored. */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,39}(?:%[0-9A-Za-z]+)?|[0-9a-fA-F:]{2,29}:\d{1,3}(?:\.\d{1,3}){3})$/;
const ip = (v) => { const s = String(v == null ? '' : v).trim(); return IP_RE.test(s) ? s.toLowerCase() : ''; };

export function clientAddress(request) {
  const h = request.headers;
  const cf = ip(h.get('cf-connecting-ip'));
  if (cf) return cf;
  const chain = String(h.get('x-forwarded-for') || '').split(',');
  return ip(chain[chain.length - 1]) || 'unknown';
}

export function reply(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
}

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });

export function b64u(str) {
  const bytes = enc.encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}
