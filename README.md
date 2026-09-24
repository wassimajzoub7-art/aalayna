# Aalayna

Static restaurant product demo and marketing website. No package installation or build is required. Serve this directory with any static HTTP server. Open `index.html` for the public website, `guest.html` for the guest demo, or `system.html` for the full demo index.

The public homepage and booking page contain no interactive demos or app previews; calls to action lead to a pilot conversation or direct contact. They do not link into the full guest app, menu editor or dashboard. Those existing demo pages are still accessible by their direct URLs; removing navigation links is not access control.

## Demo limits

Payments, receipts and feedback delivery are simulated. Campaigns are saved as drafts and approved for audience export; they are never marked delivered without an imported delivery report. Weekly recommendations and the customer section use recorded activity; the separate Reviews and Team sample views still contain illustrative data. No payment provider or POS is connected. Without a configured bill/owner key the pages share only local demo data. Shared mode requires the Supabase migrations below. Staff sign in to the dashboard and editor with a one-time email code and a role (owner, manager, waiter); the owner key remains a bearer fallback and guests use per-bill and table keys. Do not use the demo to collect real payments, real card details, or guest contact data.

**Staff login.** Run `supabase/auth-2026-09-24.sql` after the sessions file, with Supabase Auth set up
as its header says (email provider on, **Confirm email kept on**, `{{ .Token }}` in the
Magic Link and Confirm signup templates, a custom SMTP sender). The dashboard and editor
then open on a sign-in panel: staff enter their email, receive a six-digit code and sign
in; the session is kept in this browser (`aal.session`) and sent as a bearer token
instead of the owner key. Access comes from the venue's staff list, managed per venue
under **Staff** in `admin.html` (or `aal_staff` with the owner key): owners and managers
can do everything, only owners manage staff, and waiters get the Live floor (open and
change bills, bill links, confirm or cancel cash) but no refunds, bill closing, menu
editing, customer list or event stream. Revoking someone takes effect on their next
request. The owner key still works as a fallback ("Continue with the owner link"), and
the no-key demo stays open through "Continue with the demo".

Cash selection creates a pending collection request. It is excluded from confirmed revenue and digital tips. After receiving the cash, tap **Confirm cash received** once in the dashboard. The guest tab refreshes on storage updates and when returning to the tab; its own receipt also survives a reload in that tab. Both pages must use the same browser profile and origin. Guests can close the screen while awaiting collection; this does not mark a request paid. Requests can be cancelled; confirmed payments can be marked refunded. These are simulation records, not actual financial operations.

Tapping any receipt star opens one compact review panel with a comment field and a public/private destination selector. Both destinations are available at every rating; neither prototype action sends a real review or message. The receipt uses the visual viewport, with compact styling for short screens and the on-screen keyboard; overflow remains available for exceptional accessibility sizes.

## Website event measurement

`analytics.js` records `demo_start`, `demo_open`, `demo_complete`, `demo_cash_requested`, `whatsapp_click`, `booking_click`, `booking_page_view`, and `booking_calendar_click`. A cash request is not a completed payment; `demo_complete` occurs after simulated digital confirmation or staff cash confirmation while the guest tab is open.

The local buffer records up to 300 events. With the supplied Supabase configuration, allowlisted website events are also appended to `site_events`. In the browser console, use `AalaynaAnalytics.events()` to inspect or export the local records and `AalaynaAnalytics.clear()` to clear them. This is instrumentation and local verification, not a cross-visitor analytics service.

To collect events across visitors, provision an HTTPS collector and set its URL in `analytics-config.js`. It must accept a text/plain POST containing JSON (`name`, `placement`, `path`, `at`) and should validate the event-name allowlist, apply rate limits and appropriate retention, and configure CORS for the website origin. No secret belongs in this public configuration. The integration uses `sendBeacon` with a keepalive-fetch fallback; it is best-effort and does not guarantee delivery or replay old local events. No external request is made with the default empty endpoint.

Events do not contain contact information, query strings, bill amounts, or persistent visitor identifiers. Do Not Track and Global Privacy Control disable recording and delivery. Booking link clicks measure intent, not confirmed bookings: the embedded third-party calendar needs a separate integration to report completion.

## Data and payments layer

The store implements the engineering spec for data integrity, event logging, identity and payment orchestration, on localStorage, with matching server checks for protected shared payment operations. The DDL lives in `schema/` (one file per spec section) and `schema/README.md` maps every localStorage key to its table and API.

- Menu item ids are immutable. Deleting archives (`archivedAt`); archived dishes leave the guest menu but stay resolvable in history. A dish without an ingredient record is `incomplete`: it stays on the menu and is excluded from dietary filters. The 86 toggle (`available`) is a tier-1 edit. Every mutation is written to a field-level edit log with its tier.
- `aal.events` is append-only: qr_scan, item_view and bill_requested are client-fired (accept loss); order_placed, payment_completed, receipt_requested and review_submitted are emitted by the data layer. Each event carries device_id, session_id (one per scan), restaurant_id, table_id and, once known, customer_id.
- Every check and payment stores currency, raw amount, the exchange rate used and the USD figure. The rate records who set it and when; 14 days without an update flags it stale.
- Identity: a receipt contact or a wallet reference becomes a key; keys map to one customer; a transaction carrying two keys from two customers merges them and repoints history; linking a device backfills its earlier anonymous events.
- Digital payments are two-step: a request is created when the guest hands over to the provider and is confirmed once by a provider reference (duplicate callbacks are idempotent, raw callbacks are logged). Cash stays a first-class pending-then-confirmed path.
- `admin.html` is the internal view: weekly health reports, admin notifications, edit log, identity merges and payment callbacks. Nothing there is for restaurants.

## Shared store

The shared mode uses Supabase with restaurant/credential-scoped caches, a durable
retry outbox and protected server operations. **Apply the September 15 database
migration before opening shared restaurant links.** See
[supabase/README.md](supabase/README.md) for the exact installation sequence,
bill-link workflow, key rotation and acceptance tests.

Guest keys now identify one bill. Staff open the bill and generate its guest link
from Live floor. Guests can request cash; only the owner credential can confirm
collection. Digital reservations are validated on the server, but shared card and
Whish payment actions remain disabled until a verified provider is connected.
The local no-key demo still simulates payments. Shared mode never uploads demo
history or falls back to simulated payment confirmation.

### Bills

Staff enter each table's bill under **Bills** on the Live floor: pick the table,
search the published menu, set quantities, save. Once a payment exists on a bill
(pending cash, a digital payment in progress, or confirmed), existing items can
only be added to, never removed, reduced or repriced, and the total never drops
below what is paid. Every save appends an `order_placed` event with a revision;
reports count the latest revision per bill. In the no-key demo this runs in the
browser and the guest page (table 12, or `TABLE` set in the console) shows the
sample bill until the venue has a staff bill. With a venue key, saves go through
`aal_mutate` (`open_check` with lines, `update_check`); run
`supabase/hardening-2026-09-24.sql` after the September 15 file. A guest opens
the bill from its **Guest bill link** (`chk_` key); the table comes from that
check. With a key the guest page offers cash only until a payment provider is
connected.

### Offline

The guest page registers `sw.js` with the scope `guest.html`, so no other page is
touched. It keeps the guest app shell on the phone: `guest.html` and its scripts are
network first (a deploy is picked up whenever the phone is online; the cached copy
answers when the network fails or takes over six seconds), Google Fonts and images are
cache first, and the Supabase API and every non-GET request are never cached. Bump
`VERSION` in `sw.js` when it or its shell list changes; activate deletes older caches.
The bill and menu come from the phone's scoped store, so a page opened with no
connection shows the bill as of the last good read (kept per bill key). A thin banner
says so while the phone reports no connection or after two failed reads in a row, and
hides after the next good read. A cash request made offline waits in the sync outbox:
the receipt says it is saved on this phone, then reads "Cash requested." once the
outbox has sent it; a request the restaurant refuses sends the guest back to Pay with
the reason. The demo shows the same banner and keeps working locally. `sw.js` must
never get a long HTTP cache lifetime (GitHub Pages sends ten minutes, and the page
registers it with `updateViaCache: 'none'`). See `tests/offline.test.cjs`.

### Table QR

A printed table card opens `guest.html?v=<slug>&t=<table>&s=<code>`. Run
`supabase/sessions-2026-09-24.sql` after the September 24 hardening file and
`admin.sql`. In `qr.html` paste the owner key (kept in that tab only) to issue,
reissue or revoke one code per table and print one card per table; without a key
`qr.html` still makes demo cards. On a scan, `aal_table_session` checks the code and,
when the table has an open bill, returns a fresh `chk_` key for it; the page reloads
once as that bill link. Before the waiter enters the bill the guest sees the menu and
"Your bill appears here once your server enters it.", and the bill view asks again
every 10 seconds, then attaches the bill in place. A card is a standing credential
for its table: anyone with a photo of it can open that table's current bill, so
revoke and reissue a lost or copied card. Keys minted this way never expire (the
same limit as bill links).

**Pilot follow-ups (T8).** Run `supabase/followups-2026-09-24.sql` after the auth file
(its header lists every change; untested against the live project). This replaces the
note above that keys never expire: a bill's `chk_` keys keep working for 24 hours after
the bill closes (the guest can still read it, ask for the receipt or cancel), then stop
and are cleared at the next table scan; a scan reuses the open bill's newest key instead
of minting one per scan. A guest page whose bill closes shows "This bill is closed. Scan
the table code again for a new bill." (a guest on a payment receipt stays there, receipt
box usable), drops its key only once the server refuses it and, when it came from a
table card, waits for the table's next bill. A change the server refuses with a
definite answer leaves the outbox and its message shows once in the status line
(Dismiss); Retry only resends changes that failed for network reasons. Unsent changes
follow the device from an owner link to a staff sign-in and back. Signed-in waiters can
save the floor plan (`aal.floor`) and nothing else among the venue documents. See
`tests/followups.test.cjs`.

## Importing a menu

`tools/import-menu.js` turns a restaurant's menu, as a PDF or as photos, into a menu
pack in `venues/<slug>.json` (the format of `venues/kababji.json`) and adds it to
`venues/index.json`, which fills the **Menu pack** list in `admin.html`. It needs Node
18 or later and an Anthropic API key in `ANTHROPIC_API_KEY` (never written to disk):

```sh
node tools/import-menu.js --name "Kababji" --slug kababji --currency USD menu.pdf
node tools/import-menu.js --name "Em Sherif" --slug em-sherif --currency LBP page1.jpg page2.jpg
```

The model only transcribes; ids, service windows, allergen filtering and price
arithmetic are done by the script. LBP prices are converted to USD at `--rate`
(default 89,500): set the venue rate to the same value. It refuses to replace an
existing pack without `--force`; `--dry-run` prints the report and writes nothing;
`--fixture <file>` replays a saved response (`--save-response <file>` saves one) with
no API call. The first real run should be Kababji's PDF with `--save-response` and
`--dry-run`, and its report compared with `venues/kababji.json` (75 items, 9 sections).
`--strict` and `--effort <level>` are opt-in; a model that refuses one of them, or a
forced tool choice, is retried once without it. Before loading the pack, read the report and fix: items with no price
(the app stores them as 0, and loading a pack publishes it), names that appear twice
(often one dish on two overlapping photos), empty sections, sections on the
breakfast window (hidden outside 7:00 to 11:30) and any currency warning. Imported
dishes carry `conf: 0`, so they stay out of guest allergen filters until the owner
confirms each one in the editor. See `tests/import-menu.test.cjs`.

## Onboarding a venue

`tools/onboard.js` takes a signed restaurant to live in one command (Node 18 or later,
no packages):

```sh
export AALAYNA_ADMIN_KEY=...      # the adm_ key from admin.sql (steps register, theme)
export ANTHROPIC_API_KEY=...      # steps theme, menu, welcome
node tools/onboard.js --name "Em Sherif" --place "Beirut" --slug em-sherif --currency USD \
  --tables 24 --owner owner@emsherif.com \
  --staff "sara@emsherif.com:manager,ali@emsherif.com:waiter" menu.pdf
```

The Supabase URL and anon key come from `aalayna-config.js`. The seven steps, one
module each in `tools/steps/`, run in order and print one line each:

1. **register** the venue with the admin key (profile: slug, menu pack, demo payments
   off); the owner key goes into the state file.
2. **theme**: the model reads the menu and picks the brand colour, a light background
   and a font from a fixed list of Google Fonts; `--brand`, `--bg`, `--font` override it,
   `--no-theme` skips it.
3. **menu**: `tools/import-menu.js` writes `venues/<slug>.json` and its report is
   printed. **The run stops here.** Read and fix the file, then run
   `node tools/onboard.js --slug em-sherif --approve-menu`: the file is published to
   the venue (draft and live menu, exactly as the editor's Publish makes them) and read
   back from the server. A pack with an item without a price is refused.
4. **tables**: a code for tables 1 to N and `onboarding/<slug>-table-cards.html`, the
   print sheet with the same cards as `qr.html`.
5. **staff**: the owner and each `--staff` email go on the staff list. No email is
   sent; each person signs in with their email and gets a six-digit code then.
6. **verify**: a live test on table 9999: a $1.00 bill, two scans (same key), a cash
   request as the guest, confirmation and close as owner, the closed bill read with the
   guest key, a receipt request to an example.com address, a scan with no key, and table
   9999's code revoked. Each check prints pass or fail. The closed test bill, its payment
   and a guest record for `onboarding-check@example.com` stay as the audit trail and show
   in that day's dashboard figures.
7. **welcome**: `onboarding/<slug>-welcome.md`, a note for the owner (links, sign-in,
   staff, cards, day one, a placeholder for your WhatsApp). The model writes the prose,
   the links and instructions are fixed text. It is never sent; `--no-welcome` skips it.

**Resuming and idempotence.** Progress is kept in `onboarding/<slug>.json` (gitignored,
readable by you only: it holds the owner key and the table codes, never the admin key).
A re-run needs only `--slug` and continues at the first step not done. `--from <step>`
and `--only <step>` run steps again; `--reset` forgets the state file (it asks first,
`--yes` skips the question) and leaves Supabase as it is. Every step checks the server
before it changes anything: an existing venue with the slug is reused and its keys are
not rotated; a table that has a live code keeps it (codes are never reissued, a printed
card would stop working; only a table without a live code gets one, and a replaced
revoked code is named so you reprint that card); staff already on the list are not
invited again, and a revoked person is not brought back. An existing
`venues/<slug>.json` is never extracted again unless `--reimport` is given. A step that
needs a missing environment variable fails with one sentence and the run stops;
Supabase refusals are shown with the server's message. `--dry-run` prints what each
step would do and calls nothing. `--fixture-dir <dir>` replays saved model answers
(`theme.json`, `welcome.json`, and `import-menu.json` for the importer). The model
steps force their tool for every model; `--strict` and `--effort <level>` are opt-in and
reach the importer too. A model that refuses a forced tool choice, `strict` or the
effort setting is asked once more without it, as `tools/import-menu.js` does. See
`tests/onboard.test.cjs`.

**By hand afterwards** (the tool prints this list): print the card sheet on card
stock; add your WhatsApp number to the welcome note and send it; set the Google place
id in `admin.html` if the venue wants Google reviews (there is no Places API key here);
check the brand colour, background and font against their Instagram. Demo payments are
already off.

## Validation

Run `node --test tests/*.test.cjs` for the cash-state, measurement and data-layer regressions. Static files require JavaScript syntax and local-link checks before release. The marketing page works without JavaScript.

## Live pilot prerequisites

Confirm supported POS access, verified payment callbacks, server-side payment state, operator authentication, cross-device updates, reconciliation, refunds, and operational fallback before accepting real transactions. Confirm provider fees and settlement timing in merchant agreements. The restaurant manages tip distribution.

## Customer retention and operations

### Owner reporting

Service and Overview share Today / Last 7 days / Last 30 days reporting. Today begins at the first instant of the date in Beirut; 7/30-day windows are rolling. Comparisons use the immediately preceding equal-length interval. The live cash queue and open balances remain visible irrespective of the reporting window. Payment history and CSV exports follow the selected window using confirmation date (request date when unconfirmed), with current refund/cancellation status.

Overview contains four headline metrics: confirmed bill principal, bills linked to an identified payer, receipt-contact marketing sign-up rate, and a mature 30-day return rate. Receipt submissions are deduplicated per contact using the last receipt choice in the period. Return cohorts use first observed visits in the reporting interval shifted back 30 days, so every included guest has a full follow-up; they do not represent all restaurant customers. No eligible denominator displays a dash. Historical results reflect current payment/refund records, not an immutable accounting ledger.

Completed-bill count and average use distinct fully paid checks closed in the period, excluding tips and any now-refunded balance. Campaigns surface reported deliveries, returning contacts and linked spending without claiming incremental revenue. Reviews and Team prominently label their illustrative data. POS adoption, payment timing/failures and provider delivery/unsubscribe rates remain unavailable until their source data is connected.

The owner dashboard now includes customer profiles with confirmed visit history and linked spending, searchable contacts, permission history and marketing opt-outs. Campaigns support channel-specific audiences, explicit approval, an optional 20% comparison group, JSON audience export, provider delivery report import and 30-day return reporting. Weekly actions use recorded cash requests, visits and contact coverage. Bill balances separate collected principal, tips, pending cash and the amount available for another payment.

The guest flow uses a persistent check ID; restarting lets another payer use the same bill. Close a fully settled bill in the owner dashboard before starting the next table session. Contact capture attaches to a confirmed payment, including staff-confirmed cash. Repeated receipt submissions do not create visits.

See [INTEGRATIONS.md](INTEGRATIONS.md) for definitions, report format and the exact live POS, payment, authentication and messaging prerequisites. Local demos and shared cash workflows have different authority boundaries; the Supabase rollout guide is authoritative for shared mode. This is not yet a production payment service.

### Product visual update

The guest app uses an edge-to-edge viewport with scrollable menu, split and payment content. Only the receipt is designed to fit one screen, with compact sizing for short viewports and an accessible overflow fallback. Payment totals show bill share and tip separately. Restaurant-owned HTTPS dish photos can be added in the menu editor; missing or failed images leave text-only rows.

Operations open on Live floor with pending cash, open bills and confirmed totals. Cash collection uses one explicit **Confirm cash received** action; refunds retain two-step confirmation. Completed payment history and accounting live under Settlement report. Customers and Campaigns have separate tabs; customer history and campaign drafting use accessible dialogs. All existing prototype boundaries still apply.

### Commercial pilot offer

Two months with no Aalayna subscription fee, starting at restaurant go-live after POS and payment readiness. No automatic paid renewal. Restaurants choose whether to continue at $150/month/location; the first ten founding restaurants retain the existing $100/month/location offer. Menu setup and onboarding are included. Third-party payment charges, any additional integration setup costs and future messaging costs are disclosed separately before agreement.
