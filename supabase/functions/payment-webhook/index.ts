// Payment provider callbacks: POST /functions/v1/payment-webhook/<provider>.
// Thin Deno wrapper; all logic is in handler.js, which node --test exercises
// (tests/payment-webhook.test.cjs).
// Deploy with verify_jwt false: a payment provider cannot present a Supabase JWT. Each
// adapter authenticates the call itself (the fake one by HMAC over the raw body).
// deno-lint-ignore-file no-explicit-any
import { createHandler } from './handler.js';

Deno.serve(createHandler({
  now: () => new Date(),
  env: (name: string) => Deno.env.get(name),
  crypto: globalThis.crypto,
  log: console,
}) as any);
