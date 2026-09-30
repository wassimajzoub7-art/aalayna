/* The service-role PostgREST client every Edge Function uses. Plain ES module: Deno runs it
   in the functions, node --test runs it in tests/.

   Two ways in:
     rest(path, {method, body, headers}) and rpc(name, args)
         module-level, configured from the environment: SUPABASE_URL and
         SUPABASE_SERVICE_ROLE_KEY (Supabase injects both into every Edge Function), fetch is
         the global one.
     createClient({url, serviceKey, fetch}) -> {rest, rpc}
         the same two calls with explicit configuration, for tests and handlers that inject
         their dependencies. fromEnv(env, fetch) builds one from an env object or getter.

   rest(path, opts)
     path     relative to /rest/v1/, e.g. "kv_rows?collection=eq.aal.settle&select=body"
              (build filter values with eq(value), which URL-encodes them).
     opts     method (default GET); body (an object or array is sent as JSON, a string as is);
              headers (added to, and able to override, the defaults, e.g. Prefer).
     returns  the parsed JSON body, or null for an empty body (204, return=minimal).
     throws   SupabaseError {message, status, code, details, hint} on any non-2xx answer;
              message is PostgREST's "message" (for a raise exception in SQL, the SQL
              sentence exactly). A network failure throws SupabaseError with status 0.
   rpc(name, args) = rest('rpc/' + name, {method: 'POST', body: args || {}}).

   The key goes in both apikey and Authorization: Bearer, as supabase-js sends it. That
   Bearer is what makes request.jwt.claims.role 'service_role' in SQL, which is what
   aal_mutate checks for confirm_digital. Never send this client's key to a browser. */

export class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = body && body.code || null;
    this.details = body && body.details || null;
    this.hint = body && body.hint || null;
  }
}

export const eq = (value) => 'eq.' + encodeURIComponent(String(value));

export function createClient({ url, serviceKey, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  function config() {
    if (!url || !serviceKey) throw new SupabaseError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set', 0, null);
    return String(url).replace(/\/+$/, '');
  }
  async function rest(path, opts = {}) {
    const base = config();
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      Accept: 'application/json',
    }, opts.body === undefined ? {} : { 'Content-Type': 'application/json' }, opts.headers || {});
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    let res;
    try {
      res = await doFetch(base + '/rest/v1/' + String(path).replace(/^\/+/, ''), { method, headers, body });
    } catch (e) {
      throw new SupabaseError('Could not reach the database (' + (e && e.message || e) + ')', 0, null);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const message = data && (data.message || data.error_description || data.error) || text.slice(0, 200) || 'HTTP ' + res.status;
      throw new SupabaseError(String(message), res.status, data);
    }
    return data;
  }
  const rpc = (name, args) => rest('rpc/' + name, { method: 'POST', body: args || {} });
  return { rest, rpc };
}

export function envGetter(env) {
  if (typeof env === 'function') return env;
  if (env && typeof env === 'object') return (k) => env[k];
  return (k) => {
    try { if (globalThis.Deno && globalThis.Deno.env) return globalThis.Deno.env.get(k); } catch (_) { /* no permission */ }
    return globalThis.process && globalThis.process.env ? globalThis.process.env[k] : undefined;
  };
}

export function fromEnv(env, fetchImpl) {
  const get = envGetter(env);
  return createClient({ url: get('SUPABASE_URL'), serviceKey: get('SUPABASE_SERVICE_ROLE_KEY'), fetch: fetchImpl });
}

/* Module-level calls, configured from the process environment on each call (so a test or
   a redeploy with new secrets is picked up without re-importing). */
export const rest = (path, opts) => fromEnv().rest(path, opts);
export const rpc = (name, args) => fromEnv().rpc(name, args);
