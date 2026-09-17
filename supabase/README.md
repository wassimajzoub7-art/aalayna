# Shared-store rollout (September 15)

The JavaScript now requires the version-2 RPCs in `hardening-2026-09-15.sql`.
Publishing the website does **not** apply SQL to Supabase. Existing shared links
will show a connection error until the database migration is installed. Local
no-key demos continue to work independently.

## Existing Supabase project

1. Back up the existing tables through your normal database backup process.
2. Run the complete `hardening-2026-09-15.sql` in the project's SQL editor. It is
   transactional and repeatable. It preserves records, removes broad guest
   payment writes, revokes PUBLIC execution of venue registration, and introduces
   bill-specific guest reads and protected mutations.
3. Check whether `aal_register_venue` was previously executable by `PUBLIC`.
   Rotate existing owner/guest keys if they were exposed. Rotation and issuing
   replacement staff links happen in the trusted SQL editor, never on a guest page:

   ```sql
   update public.venue_keys
   set owner_key = 'own_' || encode(gen_random_bytes(18), 'hex'),
       guest_key = 'gst_' || encode(gen_random_bytes(18), 'hex')
   returning restaurant_id, owner_key, guest_key;
   ```

   Store those results privately. Owner keys are bearer credentials; sharing the
   key shares staff access. The public anon key is not an owner credential.
4. Open `dashboard.html?venue=NAME&place=PLACE&k=OWNER_KEY` and the editor with the
   owner's new key. Name/place must match the registered restaurant exactly.
   Keys are removed from the address after loading and remembered per venue and
   page role. Old global `aal.key` and demo records are not imported.
5. In Live floor choose **Open a staff-entered bill**, enter its table and POS
   total, then choose **Guest bill link**. That link contains a `chk_` key for
   precisely that check. Legacy `gst_` keys only read published menus; they cannot
   access bills. Generate a fresh bill link for each party. Static table QR/POS
   sessions are a later integration, not simulated by this release.
6. From a second device, request cash. Verify the dashboard sees it, staff can
   confirm collection, the guest sees confirmation, and a second payer cannot
   reserve an already-covered balance. Check a connection interruption and retry.

## Fresh project

Apply `migration.sql`, `site-events.sql`, then `hardening-2026-09-15.sql`, in that
order. `policies-update-2026-09-10.sql` is retired and no longer reinstates old
permissions. The files under `schema/` describe a separate future normalized
schema; do not apply them as an alternative to these shared-store migrations.

## Authority and recovery

- Local demo caches and each restaurant/credential cache are separate. Dirty
  changes are stored in an outbox, replayed after reconnect/reload, and preserved
  while reads refresh. Failed writes do not become "Saved" because a read succeeds.
- Guest reads are projected through `aal_snapshot`: one check, its payment
  balances, and published menu/rate documents. No customer list, device IDs,
  contact details, owner draft, or another check is returned.
- Guest contact capture requires the random payer token held by the requesting
  device. A receipt request returns an acknowledgement, never another person's
  existing contact history. Contact ownership verification and delivery are
  still prerequisites for live marketing.
- The server serializes protected operations with a transaction lock. Amounts,
  items, status transitions, duplicate requests, expiry, closed checks and
  callback references are validated there. Digital reservations expire after
  ten minutes; confirmation after expiry requires reconciliation, not blindly
  increasing a bill balance. Cash is reserved until confirmed or cancelled.
- Shared digital payment buttons are disabled because no provider is connected.
  They cannot manufacture confirmation. `confirm_digital` requires a trusted
  service-role callback with a matching amount, currency and provider reference.
  The provider adapter must verify the provider's signature first. Never put a
  service-role secret in any HTML/JS file or in an owner browser.
- Shared cash confirmation/refunds require the owner credential. Digital refunds
  require the future provider integration. These rows are operational records,
  not proof that money moved. Messaging, real POS synchronization, staff accounts
  and production monitoring are still separate rollout work.
- Rejected outbox changes remain visible with **Retry**. Fix the cause before
  retrying. No silent deletion or fallback to demo payments occurs.

## Tests

`node --test tests/*.test.cjs` runs local and mocked-network regressions.
For the actual PostgreSQL permissions/transaction suite, install
`@electric-sql/pglite` outside the static deployment and run:

```sh
PGLITE_MODULE=/absolute/path/to/node_modules/@electric-sql/pglite node --test tests/*.test.cjs
```

The database test creates an isolated database with fictional keys and bills. It
substitutes only the test random-byte function because this WASM build lacks the
pgcrypto extension; deployed SQL uses pgcrypto. It does not call the live project.
Before real payments, also run a provider/POS acceptance test against the installed
Supabase policies. Local tests do not verify that the production migration ran.
