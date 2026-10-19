/* Request helpers shared by the Edge Functions that face the public internet. Plain ES
   module: Deno runs it in the functions, node --test runs it in tests/.

     readCapped(request, max)   -> {text} | {tooLarge:true} | {invalid:true}
         Reads at most max bytes (by Content-Length, then by counting); {invalid} for a body
         that is not UTF-8.
     createLimiter({max, windowMs}) -> {take(key, at) -> boolean}
         A fixed window per key, in this instance's memory. take answers false once a key has
         used its max within the window. The map is cleared past 10,000 keys.
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

export function createLimiter({ max = 120, windowMs = 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    take(key, at) {
      const t = at instanceof Date ? at.getTime() : Number(at);
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) {
        if (hits.size > 10000) hits.clear();
        h = { start: t, n: 0 };
        hits.set(key, h);
      }
      h.n += 1;
      return h.n <= max;
    },
  };
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
