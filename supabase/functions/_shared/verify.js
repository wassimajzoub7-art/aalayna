/* Signatures and hashes over Web Crypto, the same code in Deno (Edge Functions) and in
   Node (node --test). Nothing here reads the environment.

     hmacHex(secret, message, cryptoImpl?)  -> Promise<string>  HMAC-SHA256, lower-case hex.
                                               message is a string (UTF-8) or bytes.
     sha256Hex(message, cryptoImpl?)        -> Promise<string>  SHA-256, lower-case hex.
     timingSafeEqual(a, b)                  -> boolean          string compare whose time does
                                               not depend on where the strings first differ. */

const enc = new TextEncoder();
const bytes = (m) => (typeof m === 'string' ? enc.encode(m) : m instanceof Uint8Array ? m : new Uint8Array(m));
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, message, cryptoImpl = globalThis.crypto) {
  if (typeof secret !== 'string' || !secret) throw new Error('hmacHex needs a secret');
  const key = await cryptoImpl.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await cryptoImpl.subtle.sign('HMAC', key, bytes(message)));
}

export async function sha256Hex(message, cryptoImpl = globalThis.crypto) {
  return hex(await cryptoImpl.subtle.digest('SHA-256', bytes(message)));
}

/* Every byte of the longer string is visited and the lengths are folded into the result,
   so a wrong guess costs the same time wherever it goes wrong. */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a == null ? '' : a)), y = enc.encode(String(b == null ? '' : b));
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (i < x.length ? x[i] : 0) ^ (i < y.length ? y[i] : 0);
  return diff === 0;
}
