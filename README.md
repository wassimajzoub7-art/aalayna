# 3alayna

Static restaurant product demo and marketing website. No package installation or build is required. Serve this directory with any static HTTP server. Open `index.html` for the public website, `3alyna_full_flow.html` for the guest demo, or `system.html` for the full demo index.

## Demo limits

Payments, receipts, campaigns, and feedback delivery are simulated. Weekly dashboard data is illustrative. No payment provider, POS backend, shared database, or staff authentication is connected. The pages share `localStorage` between tabs on one browser and origin; they do not synchronize across guest devices. Do not use the demo to collect real payments, real card details, or guest contact data.

Cash selection creates a pending collection request. It is excluded from confirmed revenue and digital tips. In the dashboard, click **Confirm collection**, then **Cash received — confirm** after collection to demonstrate the staff step. The guest tab updates when the same-browser storage event arrives. Requests can be cancelled; confirmed payments can be marked refunded. These are simulation records, not actual financial operations.

Public review and private feedback options have equal prominence at all ratings. Neither demo option sends a real review or message.

## Website event measurement

`analytics.js` records `demo_start`, `demo_open`, `demo_complete`, `demo_cash_requested`, `whatsapp_click`, `booking_click`, `booking_page_view`, and `booking_calendar_click`. A cash request is not a completed payment; `demo_complete` occurs after simulated digital confirmation or staff cash confirmation while the guest tab is open.

The default configuration records a maximum of 300 events **in this browser only**. In the browser console, use `AalaynaAnalytics.events()` to inspect or export the local records and `AalaynaAnalytics.clear()` to clear them. This is instrumentation and local verification, not a cross-visitor analytics service.

To collect events across visitors, provision an HTTPS collector and set its URL in `analytics-config.js`. It must accept a text/plain POST containing JSON (`name`, `placement`, `path`, `at`) and should validate the event-name allowlist, apply rate limits and appropriate retention, and configure CORS for the website origin. No secret belongs in this public configuration. The integration uses `sendBeacon` with a keepalive-fetch fallback; it is best-effort and does not guarantee delivery or replay old local events. No external request is made with the default empty endpoint.

Events do not contain contact information, query strings, bill amounts, or persistent visitor identifiers. Do Not Track and Global Privacy Control disable recording and delivery. Booking link clicks measure intent, not confirmed bookings: the embedded third-party calendar needs a separate integration to report completion.

## Validation

Run `node --test tests/*.test.cjs` for the cash-state and measurement regressions. Static files require JavaScript syntax and local-link checks before release. The marketing page works without JavaScript; its preview defaults to a four-way split until scripting loads.

## Live pilot prerequisites

Confirm supported POS access, verified payment callbacks, server-side payment state, operator authentication, cross-device updates, reconciliation, refunds, and operational fallback before accepting real transactions. Confirm provider fees and settlement timing in merchant agreements. The restaurant manages tip distribution.
