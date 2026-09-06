# 3alayna

Static restaurant product demo and marketing website. No package installation or build is required. Serve this directory with any static HTTP server. Open `index.html` for the public website, `3alyna_full_flow.html` for the guest demo, or `system.html` for the full demo index.

The public homepage and booking page contain no interactive demos or app previews; calls to action lead to a pilot conversation or direct contact. They do not link into the full guest app, menu editor or dashboard. Those existing demo pages are still accessible by their direct URLs; removing navigation links is not access control.

## Demo limits

Payments, receipts and feedback delivery are simulated. Campaigns are saved as drafts and approved for audience export; they are never marked delivered without an imported delivery report. Weekly recommendations and the customer section use recorded activity; the separate Reviews and Team sample views still contain illustrative data. No payment provider, POS backend, shared database, or staff authentication is connected. The pages share `localStorage` between tabs on one browser and origin; they do not synchronize across guest devices. Do not use the demo to collect real payments, real card details, or guest contact data.

Cash selection creates a pending collection request. It is excluded from confirmed revenue and digital tips. In the dashboard, click **Confirm collection**, then **Cash received — confirm** after collection to demonstrate the staff step. The guest tab updates when the same-browser storage event arrives. Requests can be cancelled; confirmed payments can be marked refunded. These are simulation records, not actual financial operations.

Tapping any receipt star opens one compact review panel with a comment field and a public/private destination selector. Both destinations are available at every rating; neither prototype action sends a real review or message. The receipt uses the visual viewport, with compact styling for short screens and the on-screen keyboard; overflow remains available for exceptional accessibility sizes.

## Website event measurement

`analytics.js` records `demo_start`, `demo_open`, `demo_complete`, `demo_cash_requested`, `whatsapp_click`, `booking_click`, `booking_page_view`, and `booking_calendar_click`. A cash request is not a completed payment; `demo_complete` occurs after simulated digital confirmation or staff cash confirmation while the guest tab is open.

The default configuration records a maximum of 300 events **in this browser only**. In the browser console, use `AalaynaAnalytics.events()` to inspect or export the local records and `AalaynaAnalytics.clear()` to clear them. This is instrumentation and local verification, not a cross-visitor analytics service.

To collect events across visitors, provision an HTTPS collector and set its URL in `analytics-config.js`. It must accept a text/plain POST containing JSON (`name`, `placement`, `path`, `at`) and should validate the event-name allowlist, apply rate limits and appropriate retention, and configure CORS for the website origin. No secret belongs in this public configuration. The integration uses `sendBeacon` with a keepalive-fetch fallback; it is best-effort and does not guarantee delivery or replay old local events. No external request is made with the default empty endpoint.

Events do not contain contact information, query strings, bill amounts, or persistent visitor identifiers. Do Not Track and Global Privacy Control disable recording and delivery. Booking link clicks measure intent, not confirmed bookings: the embedded third-party calendar needs a separate integration to report completion.

## Validation

Run `node --test tests/*.test.cjs` for the cash-state and measurement regressions. Static files require JavaScript syntax and local-link checks before release. The marketing page works without JavaScript.

## Live pilot prerequisites

Confirm supported POS access, verified payment callbacks, server-side payment state, operator authentication, cross-device updates, reconciliation, refunds, and operational fallback before accepting real transactions. Confirm provider fees and settlement timing in merchant agreements. The restaurant manages tip distribution.

## Customer retention and operations

The owner dashboard now includes customer profiles with confirmed visit history and linked spending, searchable contacts, permission history and marketing opt-outs. Campaigns support channel-specific audiences, explicit approval, an optional 20% comparison group, JSON audience export, provider delivery report import and 30-day return reporting. Weekly actions use recorded cash requests, visits and contact coverage. Bill balances separate collected principal, tips, pending cash and the amount available for another payment.

The guest flow uses a persistent check ID; restarting lets another payer use the same bill. Close a fully settled bill in the owner dashboard before starting the next table session. Contact capture attaches to a confirmed payment, including staff-confirmed cash. Repeated receipt submissions do not create visits.

See [INTEGRATIONS.md](INTEGRATIONS.md) for definitions, report format and the exact live POS, payment, authentication and messaging prerequisites. These features remain local prototype workflows, not a connected production service.

### Product visual update

The guest app uses an edge-to-edge viewport with scrollable menu, split and payment content. Only the receipt is designed to fit one screen, with compact sizing for short viewports and an accessible overflow fallback. Payment totals show bill share and tip separately. Restaurant-owned HTTPS dish photos can be added in the menu editor; missing or failed images leave text-only rows.

Operations open on Live floor with pending cash, open bills and confirmed totals. Cash collection controls remain two-step confirmations. Completed payment history and accounting live under Settlement report. Customers and Campaigns have separate tabs; customer history and campaign drafting use accessible dialogs. All existing prototype boundaries still apply.

### Commercial pilot offer

Two months with no 3alayna subscription fee, starting at restaurant go-live after POS and payment readiness. No automatic paid renewal. Restaurants choose whether to continue at $150/month/location; the first ten founding restaurants retain the existing $100/month/location offer. Menu setup and onboarding are included. Third-party payment charges, any additional integration setup costs and future messaging costs are disclosed separately before agreement.
