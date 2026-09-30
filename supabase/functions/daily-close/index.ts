// Daily close email. Thin wrapper: all logic is in handler.js, which node --test exercises.
// Deploy with verify_jwt false: pg_cron/pg_net cannot present a user JWT, and the function
// authenticates the caller itself with the X-Aalayna-Cron header.
// deno-lint-ignore-file no-explicit-any
import { createHandler } from './handler.js';
import { rest } from '../_shared/supabase.js';
import { send } from '../_shared/resend.js';

Deno.serve(createHandler({
  rest,
  send,
  now: () => Date.now(),
  env: (name: string) => Deno.env.get(name),
}));
