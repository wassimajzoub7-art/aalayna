# Aalayna

Static restaurant product demo and marketing website. No package installation or build is required. Serve this directory with any static HTTP server. Open `index.html` for the public website, `guest.html` for the guest demo, or `system.html` for the full demo index.

The public homepage and booking page contain no interactive demos or app previews; calls to action lead to a pilot conversation or direct contact. They do not link into the full guest app, menu editor or dashboard. Those existing demo pages are still accessible by their direct URLs; removing navigation links is not access control.

## Demo limits

Payments, receipts and feedback delivery are simulated. Campaigns are saved as drafts and approved for audience export; they are never marked delivered without an imported delivery report. Weekly recommendations and the customer section use recorded activity; the separate Reviews and Team sample views still contain illustrative data. No payment provider or POS is connected. Without a configured bill/owner key the pages share only local demo data. Shared mode requires the Supabase migrations below and uses bearer credentials; individual staff accounts are not implemented. Do not use the demo to collect real payments, real card details, or guest contact data.

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
