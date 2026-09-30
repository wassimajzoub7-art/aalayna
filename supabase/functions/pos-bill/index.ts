// pos-bill Edge Function: Deno wiring only; the logic is in handler.js (tested with node --test).
// Deploy with verify_jwt = false: the function checks X-Aalayna-Integration-Key itself.
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, injected by Supabase. Nothing else.
import { handle } from './handler.js';

const env = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
};

Deno.serve((request: Request) =>
  handle(request, { fetch, env, now: () => new Date(), crypto: globalThis.crypto, log: console })
);
