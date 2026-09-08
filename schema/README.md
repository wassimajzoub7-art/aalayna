# Data and payments layer: Postgres schema

DDL for the engineering spec, one file per section, applied in order. The static
prototype implements the same rules on localStorage so the port is mechanical:

| Spec | File | Prototype key(s) | Prototype API (`Aalayna.*`) |
| --- | --- | --- | --- |
| §1 Stable item ids | 001_menu.sql | `aal.draft`, `aal.live` (items carry `archivedAt`, `available`, `status`) | `archiveItem`, `restoreItem`, `liveItems`, `discardDraftItem` |
| §2 Events | 002_events.sql | `aal.events` | `logEvent`, `events`, `EVENT_TYPES` |
| §3 Device token | 003_devices.sql | `aal.device` + cookie `device_id`, `aal.devices`, sessionStorage `aal.session` | `device`, `session`, `newSession` |
| §4 FX per transaction | 004_fx.sql | `aal.rate`, `aal.rate_meta`; `currency`/`fxRateUsed`/`amountUsd` on checks and payments | `setRate(v, who)`, `rateInfo` |
| §5 Identity | 005_identity.sql | `aal.identities`, `aal.identity_keys`, `aal.device_links`, `aal.identity_merges` | `identity.link`, `identity.customerForDevice`, `identity.keysFor`, `identity.merges` |
| §6 Payments | 006_payments.sql | `aal.checks` (orders), `aal.settle` (payment requests), `aal.webhook_log` | `openServiceCheck`, `requestPayment`, `confirmPayment`, `failPayment`, `settle` (cash), `confirmCash`, `cancelCash`, `refund`, `checkBalance`, `validateCheckPayment` |
| §7 Review prompt | 007_reviews.sql | events `review_submitted` | `submitReview`, `lowRatings` |
| §8 Permissions | 008_permissions.sql | `aal.edit_log`, `aal.admin_notifications` | `saveDraft(d, who)`, `editLog`, `adminNotifications`, `actor` |
| §9 Health check | 009_health.sql | `aal.health_reports` | `healthReport`, `recordHealth`, `healthReports` |
| §10 Dashboard v2 | 010_dashboard.sql | derived | `eventMetrics(range)` |

Differences the port must keep in mind:

- Identity keys are stored normalised but not hashed in the prototype (it is local
  to one browser). The backend hashes `key_value` at rest (sha256 of the normalised value).
- `payment_requests.amount_cents` is the principal in Postgres. The prototype's
  `aal.settle` rows keep `amount` = principal + tip (historical shape) and every
  reader subtracts `tip`; `net` is what the spec calls `amount`.
- The prototype has no server, so client-fired and server-fired events are all
  written by the page. Which events are authoritative is documented in 002_events.sql.
- Session and device ids fall back to in-memory values when storage is unavailable.
- Merges in Postgres go through `merge_identities()` which temporarily disables the
  events append-only trigger; run it in a transaction with a restricted role.

Non-goals, unchanged from the spec: POS integration, card gateway, CLTV modelling,
queues, multi-region.
