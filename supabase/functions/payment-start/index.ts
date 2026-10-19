// Hosted payment pages: GET/POST /functions/v1/payment-start (which rails a bill may pay, and
// the provider page to send the guest to) and the fake provider's own checkout page under
// /functions/v1/payment-start/fake/checkout. Thin Deno wrapper; all logic is in handler.js,
// which node --test exercises (tests/payment-start.test.cjs).
// Deploy with verify_jwt false: the guest page presents the bill key and the payer token, and
// the browser coming back from a provider page presents nothing; the function checks both
// itself and answers CORS for the origins in PAYMENT_RETURN_ORIGINS.
// deno-lint-ignore-file no-explicit-any
import { createHandler } from './handler.js';

Deno.serve(createHandler({
  now: () => new Date(),
  env: (name: string) => Deno.env.get(name),
  crypto: globalThis.crypto,
  log: console,
}) as any);
