// pos-webhook-deliver Edge Function: Deno wiring only; the logic is in handler.js (tested with node --test).
// Deploy with verify_jwt = false: the function checks X-Aalayna-Cron itself.
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (injected by Supabase) and
// AALAYNA_CRON_SECRET (set by hand; the same value as vault secret 'aalayna_cron_secret', shared with daily-close).
import { handle } from './handler.js';

const env = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  AALAYNA_CRON_SECRET: Deno.env.get('AALAYNA_CRON_SECRET') ?? '',
};

Deno.serve((request: Request) =>
  handle(request, { fetch, env, now: () => new Date(), crypto: globalThis.crypto, log: console })
);
