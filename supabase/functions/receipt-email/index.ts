// Receipt emails: POST /functions/v1/receipt-email with the X-Aalayna-Cron header, from
// the outbox trigger (pg_net) and from pg_cron every minute. Thin Deno wrapper; all logic
// is in handler.js, which node --test exercises (tests/receipt-email.test.cjs).
// Deploy with verify_jwt false: pg_cron/pg_net cannot present a user JWT, and the function
// authenticates the caller itself with the X-Aalayna-Cron header.
// deno-lint-ignore-file no-explicit-any
import { createHandler } from './handler.js';

Deno.serve(createHandler({
  now: () => new Date(),
  env: (name: string) => Deno.env.get(name),
  crypto: globalThis.crypto,
  log: console,
}) as any);
