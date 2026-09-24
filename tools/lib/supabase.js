'use strict';
/* The shared store as the onboarding tool talks to it: PostgREST RPCs and the kv_docs
   upsert, with the admin key (x-aalayna-admin), the venue owner key (x-aalayna-key), a
   bill key (chk_, also x-aalayna-key) or no key at all. The Supabase URL and the public
   anon key come from aalayna-config.js, the file the pages load. AALAYNA_SUPABASE_URL
   replaces the URL (the tests point it at a local fake server). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function loadConfig(env) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'aalayna-config.js'), 'utf8'), { window });
  const cfg = window.AalaynaConfig || {};
  const url = (env && env.AALAYNA_SUPABASE_URL) || cfg.supabaseUrl;
  if (!url || !cfg.anonKey) throw new Error('aalayna-config.js has no Supabase URL or anon key.');
  return { url: String(url).replace(/\/$/, ''), anonKey: cfg.anonKey };
}

/* A server refusal keeps the server's own message; a missing function says which SQL
   file installs it. */
class SupabaseError extends Error {
  constructor(message, status, fn) { super(message); this.status = status; this.fn = fn; this.server = true; }
}

const INSTALLED_BY = {
  aal_admin_register_venue: 'supabase/admin.sql', aal_admin_list_venues: 'supabase/admin.sql',
  aal_admin_update_profile: 'supabase/admin.sql', aal_table_tokens: 'supabase/sessions-2026-09-24.sql',
  aal_table_session: 'supabase/followups-2026-09-24.sql', aal_staff: 'supabase/auth-2026-09-24.sql',
  aal_mutate: 'supabase/auth-2026-09-24.sql', aal_snapshot: 'supabase/auth-2026-09-24.sql'
};

function client(opts) {
  const cfg = opts.config || loadConfig(opts.env || process.env);
  const doFetch = opts.fetch || globalThis.fetch;
  function headers(cred) {
    const h = { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'Content-Type': 'application/json' };
    if (cred && cred.admin) h['x-aalayna-admin'] = cred.admin;
    if (cred && cred.key) h['x-aalayna-key'] = cred.key;
    return h;
  }
  async function send(pathname, body, cred, extra, label) {
    let res;
    try {
      res = await doFetch(cfg.url + pathname, { method: 'POST', headers: Object.assign(headers(cred), extra || {}), body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Could not reach Supabase at ' + cfg.url + ' (' + (e.cause && e.cause.code || e.message) + ').');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      if (res.status === 404 && INSTALLED_BY[label]) {
        throw new SupabaseError(label + ' is not installed on the server. Run ' + INSTALLED_BY[label] + ' in the Supabase SQL editor.', 404, label);
      }
      const msg = json && (json.message || json.error_description || json.error) || text.slice(0, 200) || ('HTTP ' + res.status);
      throw new SupabaseError('Supabase refused ' + label + ': ' + msg + ' (HTTP ' + res.status + ')', res.status, label);
    }
    return json;
  }
  return {
    url: cfg.url,
    rpc: (fn, args, cred) => send('/rest/v1/rpc/' + fn, args || {}, cred, null, fn),
    /* The editor's own write path (aalayna-sync.js): PostgREST upsert on (restaurant_id, key).
       Several documents go in one request, so they land together or not at all. */
    upsertDocs: (rows, cred) => send('/rest/v1/kv_docs?on_conflict=restaurant_id,key', rows, cred,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }, 'kv_docs upsert')
  };
}

module.exports = { client, loadConfig, SupabaseError, ROOT };
