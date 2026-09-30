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
permissions.

Then, in this order: `hardening-2026-09-24.sql`, `admin.sql`, `sessions-2026-09-24.sql`,
`auth-2026-09-24.sql`, `followups-2026-09-24.sql`, `theme-2026-09-28.sql`. Each later
file replaces some functions of the earlier ones and says which; re-running an earlier
file means running the later ones again.

## Menu style (September 28)

`theme-2026-09-28.sql` adds `venue_profiles.theme`: empty is the standard guest menu,
`balat` the Beirut cement-tile menu. Pick it in admin.html (Venues, a venue's profile,
Menu style). A table scan (`aal_table_session`) returns it and the guest page opens in
that style; the tiles take the venue's brand colour. Staff "Guest bill link"s carry the
venue's name only, so they open the standard look. The files under `schema/` describe a separate future normalized
schema; do not apply them as an alternative to these shared-store migrations.

## Daily close email (September 30)

Every morning each venue's owners and managers get one email about the day that just ended on
Aalayna, with a CSV attached. Files: `functions/daily-close/` (`handler.js` holds the logic,
`index.ts` is the Deno wrapper) and `daily-close-2026-09-30.sql` (the log table and the schedule;
run it after `auth-2026-09-24.sql`).

**What it contains.** Subject `<Venue>: Wednesday 30 September, on Aalayna` (the business day).
A short table: bills opened, bills closed, bills still open at 04:00 (with table numbers); cash
confirmed (count, USD, and the lira amount when the venue's rate `aal.rate` is on file); digital
confirmed (count, USD, and each rail: card, Whish); tips (USD, by rail); refunds (count, USD);
requests cancelled or expired (and failed, when there are any); receipts requested and how many of
those guests agreed to restaurant offers; guests who rated and the average. Then "Needs action":
cash requested and never confirmed (count, USD, table numbers, including requests older than the
day) and bills still open. Then the top five dishes by quantity on the day's closed bills. No
marketing text. Amounts are USD and include tips. The attachment `close-<slug>-<date>.csv` has one
row per payment record of the day: `settlementId, checkId, table, rail, status, amountUsd, tipUsd,
currency, confirmedAt, externalRef, refunded`. A payment refunded during the day but paid the day
before is a row too, so the CSV adds up to the email.

**The day.** The business day D runs from 04:00 on D to 04:00 on D+1, Asia/Beirut time, so a late
night belongs to the evening it started in. Start is included, end is not. Everything is judged as
of the end of that window: a payment refunded, or a bill closed, after 04:00 does not change that
day's figures, and a rerun a week later reproduces the email that went out. The definitions follow
`owner-metrics.js` (see the comment at the top of `handler.js`): a confirmed payment is one that
`A.settlementStatus` calls confirmed (a refunded payment is not), placed in time by
`confirmedAt || ts`; tips and rail totals as in `A.ownerReport`; the USD value as in
`A.eventMetrics`; receipts and offers as in `A.ownerReport`'s receipt contacts. Bills closed counts
`closedAt` inside the window, as the dashboard's completed bills do, without the dashboard's extra
"paid in full" test, because `close_check` already refuses to close an unsettled bill.

**When it goes.** At 04:00 Beirut time, retried automatically. pg_cron calls the function at 01:00
and at 02:00 UTC every day, whichever of the two is 04:00 in Beirut (01:00 UTC in summer, UTC+3;
02:00 UTC in winter, UTC+2), the other is the retry. A call with no `venue` and no `date` looks at
each venue's latest finished business day (the one that ended at the most recent 04:00 Beirut) and
sends it unless `daily_close_log` already has a row for it with status `sent`. So the call at the
other hour finds the sent row and does nothing, and a send that failed or was missed is tried again
at the next cron hour with nobody touching it. The function never checks the clock hour, so the
schedule never needs editing when the clocks change. A venue with no active owner or manager is
skipped and the log says why (`no active owner or manager email`). A venue whose day had no bill
opened or closed and no payment record is skipped too, with error `no activity`, and gets no email;
`?force=1` still sends the all-zero email. Skipped and failed rows are picked up again by the next
call, so a venue that gains a recipient, or whose late-synced activity arrives, is emailed then.

**Set up (in this order).**
1. Deploy: `supabase functions deploy daily-close --no-verify-jwt --project-ref xeqbkamwucqplvoavhyd`.
   JWT verification is off because pg_net cannot present a user JWT; the function checks the
   `X-Aalayna-Cron` header itself and answers 401 without it.
2. Function secrets: `AALAYNA_CRON_SECRET` (a long random value you generate; never commit it) and
   `RESEND_API_KEY`. Optional `DAILY_CLOSE_FROM` (for example `Aalayna <close@aalayna.com>`); without
   it the shared default sender `Aalayna <receipts@aalayna.com>` is used. Supabase supplies
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` itself.
3. Store the same secret for the cron jobs, once, in the SQL editor:
   `select vault.create_secret('<the same AALAYNA_CRON_SECRET value>', 'aalayna_cron_secret');`
   To rotate it, change both places.
4. Run `daily-close-2026-09-30.sql`. It creates `daily_close_log` and schedules the two jobs
   (`daily-close-0100-utc-or-retry`, `daily-close-0200-utc-or-retry`; jobs named `daily-close-0100-utc` and `daily-close-0200-utc` from an earlier version of the file are unscheduled). If pg_cron, pg_net or Vault is missing, and the
   migration cannot enable it, it still succeeds: the table exists, nothing is scheduled, and a
   NOTICE says what to enable; enable it under Database, Extensions and run the file again.

**Manual rerun.** Same header, any time after the day has ended:

```sh
curl -X POST -H "X-Aalayna-Cron: $AALAYNA_CRON_SECRET" \
  "https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1/daily-close?venue=<restaurant_id>&date=2026-09-30"
```

`venue` alone means the latest finished day; `date` alone means every venue; add `&force=1` to send
again although the log says it was sent (otherwise the answer is 200 "already sent"). The
`restaurant_id` is URL-encoded (venue ids are JSON text such as `["kababji","hamra"]`). A plain rerun
retries a day that failed or was skipped. The answer lists each venue's result; it is HTTP 500 if
any venue failed. A day that has not ended yet, an unknown venue and a malformed date are refused.

**Checking it.** `select * from daily_close_log order by created_at desc;` shows status, how many
recipients and Resend's ids per venue and day. A row with status `failed` and error `in progress` is
a send under way (or one that died; it is retried after ten minutes). Whether the jobs fired:
`select * from cron.job_run_details order by start_time desc limit 5;` and, for the HTTP answers,
`select status_code, content from net._http_response order by created desc limit 5;`. Each venue's
emails are sent one per recipient, so one bad address does not stop the others; if some but not all
fail, the row is `sent` and `error` says how many failed. Not covered: the function and the migration have been tested here only against fakes (no Deno, Supabase CLI or PostgreSQL).

## Payment callbacks and receipt emails (September 30)

Two Edge Functions and `payments-2026-09-30.sql` (run it after `auth-2026-09-24.sql`; it
replaces no earlier function, so no other file undoes it). Each function is
`functions/<name>/handler.js` (the logic, tested by `node --test`) and a thin `index.ts`.
Shared helpers are in `functions/_shared/` (`supabase.js`, `resend.js`, `verify.js`).

**payment-webhook.** `POST /functions/v1/payment-webhook/<provider>`. A guest's digital
reserve leaves an `initiated` payment for ten minutes; this function is the only thing that
turns it into `confirmed`. It checks the provider's signature (401 if wrong), reads the
callback, finds the payment with the service role and calls `aal_mutate` `confirm_digital`
with the service role as Bearer, so the database still checks reference, currency, amount,
expiry and duplicates. Answers: confirmed 200; the same callback again 200; a reference that
already confirmed another payment ("Duplicate provider reference") 200 `duplicate`, so the
provider stops retrying and the row waits for reconciliation; expired or mismatched 409 with
the database's sentence; `failed` releases an initiated payment (status `failed`, the guest
page says "declined") through `aal_payment_failed`, because `aal_mutate`'s cancel does not
accept the service role; `refunded` is recorded only (202), digital refunds are not modelled.
Every call that passes the signature check is a row in `payment_callbacks`, whatever the
outcome; the request body itself is never logged or stored. Bodies over 64 kB are refused,
and callers are limited to 120 calls a minute per address (per function instance).
Providers: `fake` (HMAC-SHA256 of the exact body with `FAKE_WEBHOOK_SECRET`, hex in
`X-Signature`; it exists only while that secret is set, and only confirms payments at venues
whose demo payments are on in admin.html) and `whish` (answers 501 until Whish shares its
callback format; filling in its `verify` and `parse` in `handler.js` is the whole job).

**receipt-email.** When a guest asks for a receipt, the receipt op links them to the payment;
a trigger then queues one `outbox_email` row for that payment (never a second one) holding a
hash of the address, not the address, and pokes the function through pg_net. pg_cron also
calls it every minute when something is due. The function sends from
`Aalayna <receipts@aalayna.com>`, subject "Your receipt from <venue>": venue and place, table,
the lines (or only the items the guest paid for), bill total, tip, total paid, the lira amount
at the venue's rate when a rate is on file, how and when it was paid, the payment reference.
Plain text and a simple HTML version, no links, no images, no marketing; if the guest ticked
the venue's offers, one line says the venue may write to them and to reply STOP to opt out.
WhatsApp contacts are skipped (`skipped`, "WhatsApp receipts are not sent yet"). A failed
send is retried after 1, 5, 30, 120 and 120 minutes and marked `failed` after the 6th try.
Turn open and click tracking off for aalayna.com in Resend (Domains), so nothing is added.

**Set up (in this order).**
1. Dashboard, Database, Extensions: enable `pg_net` and `pg_cron`.
2. Deploy both with JWT verification off (a payment provider and pg_net cannot present a
   Supabase JWT; each function authenticates the caller itself):
   `supabase functions deploy payment-webhook --no-verify-jwt --project-ref xeqbkamwucqplvoavhyd`
   and the same for `receipt-email`.
3. Function secrets (values you generate, e.g. `openssl rand -hex 32`; never commit them):
   `RESEND_API_KEY` (receipt-email), `AALAYNA_CRON_SECRET` (receipt-email; the same value
   daily-close uses), `FAKE_WEBHOOK_SECRET` (payment-webhook, only while rehearsing).
   Optional `RECEIPT_FROM`. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Once, in the SQL editor, unless the daily-close setup already did it:
   `select vault.create_secret('<the AALAYNA_CRON_SECRET value>', 'aalayna_cron_secret');`
5. Run `payments-2026-09-30.sql`. With pg_cron it schedules `aalayna-receipt-email` every
   minute; without it a NOTICE says so (enable it and run the file again).

**Rehearsal (the founder, end to end).** Use a venue whose demo payments are on in admin.html,
not a live venue: the fake provider refuses the others. The guest app offers only cash on a
shared bill until a provider is connected, so the digital reserve is made with curl, with the
bill link's key, exactly as the guest page would send it.

```sh
SB=https://xeqbkamwucqplvoavhyd.supabase.co
ANON=<anonKey from aalayna-config.js>
RID='["<venue name>","<place>"]'        # lower case, as the venue id is stored
KEY=chk_<the key in the "Guest bill link" the dashboard gives for an open bill>
FAKE_WEBHOOK_SECRET=<the value you set>
TOKEN=$(openssl rand -hex 24); PAY=rehearsal-$(date +%s)
call() { curl -s "$SB/rest/v1/rpc/$1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "x-aalayna-key: $KEY" -H 'Content-Type: application/json' -d "$2"; echo; }

# 1. the bill id, then reserve $12 by Whish (status initiated, ten minutes to confirm)
CHECK=$(call aal_snapshot "$(jq -nc --arg r "$RID" '{p_rid:$r}')" | jq -r .checkId)
call aal_mutate "$(jq -nc --arg r "$RID" --arg id "$PAY" --arg c "$CHECK" --arg t "$TOKEN" \
  '{p_rid:$r,p_op:"reserve",p_body:{id:$id,checkId:$c,amount:12,tip:0,rail:"whish",items:{}},p_token:$t}')"

# 2. the provider's signed callback: answer {"status":"confirmed"}; the dashboard shows it paid
EVENT=$(jq -nc --arg id "$PAY" '{externalRef:("fake-"+$id),paymentId:$id,amountCents:1200,currency:"USD",status:"paid",occurredAt:(now|todate)}')
SIG=$(printf '%s' "$EVENT" | openssl dgst -sha256 -hmac "$FAKE_WEBHOOK_SECRET" | awk '{print $NF}')
curl -s -X POST "$SB/functions/v1/payment-webhook/fake" -H "X-Signature: $SIG" \
  -H 'Content-Type: application/json' --data-binary "$EVENT"; echo

# 3. the guest asks for the receipt by email: it arrives within a minute
call aal_mutate "$(jq -nc --arg r "$RID" --arg id "$PAY" --arg t "$TOKEN" --arg q "$(uuidgen)" \
  '{p_rid:$r,p_op:"receipt",p_body:{id:$id,contact:"you@example.com",channel:"email",receipt:true,marketing:false,requestId:$q},p_token:$t}')"
```

Sending step 2 again answers `confirmed` again; changing `amountCents` answers 409. To see
what happened: `select * from payment_callbacks order by received_at desc limit 5;` and
`select status, attempts, last_error, provider_id from outbox_email order by created_at desc limit 5;`
(`cron.job_run_details` and `net._http_response` show the pokes). A manual drain:
`curl -X POST -H "X-Aalayna-Cron: $AALAYNA_CRON_SECRET" $SB/functions/v1/receipt-email`.
After the rehearsal, `supabase secrets unset FAKE_WEBHOOK_SECRET`: the fake route then
answers 404. The rehearsal leaves a confirmed $12 digital payment on that demo bill.

## POS bridge (September 30)

A point-of-sale system pushes each table's bill into Aalayna and hears back when it is paid and
closed. The contract for the POS vendor is `docs/pos-integration.md`. Files:
`functions/pos-bill/`, `functions/pos-webhook-deliver/` (each `handler.js` holds the logic,
`index.ts` is the Deno wrapper; both import `functions/_shared/supabase.js` and `verify.js`) and
`integrations-2026-09-30.sql` (run it after `theme-2026-09-28.sql`).

**How the bridge opens a bill.** `aal_mutate` treats the service role as a payment provider, not
as staff, so it cannot open, change or close a bill. `aal_pos_bill` (service role only) checks the
integration key's hash, takes the venue lock, sets the venue's owner key into `request.headers`
for its own transaction only, calls `aal_mutate` `open_check` / `update_check` / `close_check`
exactly as the dashboard does, and puts the headers back. Every bill rule applies unchanged;
`aal_mutate` is not replaced. The POS reference is kept on the bill as
`posRef {system, externalId, version, digest, units, discountCents, serviceCents}`.

**Till tenders, superseded bills, lines after a payment.** Tenders the POS sends become `aal.settle`
rows with `rail 'pos'`, `source 'pos'`, `status 'confirmed'`, `method`, `posRef {externalId, method}`,
amount and tip in the bill's currency (amount includes the tip), `amountUsd` equal to the amount as
`reserve` writes it, `confirmedAt` and a `payment_completed` event; `close_check` then sees the bill
paid. A new POS bill on a table whose open bill has no `aal.settle` row closes that bill as
superseded (`posRef.superseded`, event `bill_superseded`). Once a payment exists, POS changes are
followed by adding lines only (`aalayna:+<version>:<id>`, `aalayna:service:<version>`); a discount
change or a smaller service charge is refused. What the owner pages show for rail `pos` today:
`ownerReport` counts it in net, tips, gross ("Total settled in-app") and completed bills but not in
the Whish/Card/Cash lines above that total, and its `rails.pos` is NaN; `eventMetrics` puts it in
`other`, so the cash and digital shares no longer add up to 100%; the payment list labels it `pos`;
`tipsOwed` lists a tender's tip as owed to server "undefined"; the daily close email counts it as
digital ("Pos"). Those pages need a `pos` rail of their own before a pilot that pays at the till.

**Set up (in this order).**
1. Run `integrations-2026-09-30.sql`. It tries to enable `pg_net` and `pg_cron` and schedules
   `aalayna-pos-webhooks` (every minute, `select public.aal_pos_kick()`: it calls the delivery
   function only when a delivery is due). If either extension cannot be enabled the file still
   succeeds and a NOTICE says so; enable it under Database, Extensions and run the file again, or
   call the delivery function every minute from any scheduler with the header below.
2. Deploy both functions with JWT verification off (they authenticate the caller themselves):
   `supabase functions deploy pos-bill --no-verify-jwt --project-ref xeqbkamwucqplvoavhyd` and the
   same for `pos-webhook-deliver`. With the MCP deploy, include `../_shared/supabase.js` and
   `../_shared/verify.js` beside `index.ts` and `handler.js`.
3. Secrets: `pos-bill` needs none beyond `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which
   Supabase injects. `pos-webhook-deliver` also needs `AALAYNA_CRON_SECRET`, the same value as the
   Vault secret `aalayna_cron_secret` that the daily close uses (create it once:
   `select vault.create_secret('<value>', 'aalayna_cron_secret');`). The delivery address is Vault
   `aalayna_functions_url` + `/pos-webhook-deliver` when that secret exists, else
   `integration_settings.deliver_url` (preset to this project).

**Issue a key and add a webhook** (the owner key, or a signed-in owner; a manager may not). With
curl, where `$ANON` is the public anon key from `aalayna-config.js` and `$OWNER` the venue's owner
key, both from your shell, never pasted into a file:

```sh
API=https://xeqbkamwucqplvoavhyd.supabase.co/rest/v1/rpc
H=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-aalayna-key: $OWNER" -H "Content-Type: application/json")
RID='["kababji","hamra"]'
# a key for the POS: the answer's "key" is shown once, give it to the vendor
curl -s "${H[@]}" "$API/aal_integration" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"issue",label:"Omega till 1"}}')"
curl -s "${H[@]}" "$API/aal_integration" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"list"}}')"
curl -s "${H[@]}" "$API/aal_integration" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"revoke",id:"<key id>"}}')"
# the vendor's endpoint: the answer's "secret" is shown once, give it to the vendor
curl -s "${H[@]}" "$API/aal_webhooks" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"add",url:"https://pos.example.com/aalayna"}}')"
curl -s "${H[@]}" "$API/aal_webhooks" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"test",id:"<endpoint id>"}}')"
curl -s "${H[@]}" "$API/aal_webhooks" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"deliveries"}}')"
curl -s "${H[@]}" "$API/aal_webhooks" -d "$(jq -n --arg r "$RID" '{p_rid:$r,p_body:{op:"remove",id:"<endpoint id>"}}')"
```

`add` takes an optional `events` list (`bill.paid`, `bill.closed`; both by default); the address
must be `https://` and a public host name. A venue has at most 10 live keys and 5 endpoints.
`list` never shows a key or a secret again. From the SQL editor, borrow the owner key for one
transaction:

```sql
begin;
select set_config('request.headers', json_build_object('x-aalayna-key',
  (select owner_key from venue_keys where restaurant_id = '["kababji","hamra"]'))::text, true);
select aal_integration('["kababji","hamra"]', '{"op":"issue","label":"Omega till 1"}');
select aal_webhooks('["kababji","hamra"]', '{"op":"add","url":"https://pos.example.com/aalayna"}');
commit;
```

A dashboard panel for keys, endpoints and the delivery log is a follow-up; until then these two
calls are the owner surface.

**Checking it.** `select * from webhook_deliveries order by created_at desc limit 20;` (attempts,
next attempt, last status and error; `next_attempt_at` null and no `delivered_at` means given up
after 8 attempts or endpoint removed). Calls per key per minute: `integration_key_usage`. Whether
the job fired: `select * from cron.job_run_details where jobid = (select jobid from cron.job where
jobname = 'aalayna-pos-webhooks') order by start_time desc limit 5;`.

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
- A change the server refuses (4xx with a message) leaves the outbox; its message shows once until **Dismiss**, and it
  stays on record. **Retry** resends only changes that failed for network reasons. No fallback to demo payments occurs.

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
