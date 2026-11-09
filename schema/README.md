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

## Owner groups (T2, one floor for several venues)

The shared store's model is `supabase/groups-2026-10-28.sql` (tables `owner_groups`,
`owner_group_venues`, `owner_group_staff`, `daily_close_group_log`). The no-key demo keeps the
same shape in one localStorage key, written by `owner-group.js`:

| Postgres | Prototype | Shape |
| --- | --- | --- |
| `owner_groups` (id, name) | `aal.group` | `{ id, name, venues, staff }`, one group per device |
| `owner_group_venues` | `aal.group.venues` | `[{ name, place, placeTr, brand, bg, font, theme }]`; a venue's id is `venueId()` of that object |
| `owner_group_staff` (owner, manager) | `aal.group.staff` rows with `venueId: null` | `{ email, name, role, venueId, revokedAt }` |
| `staff_members` (owner, manager, waiter) | `aal.group.staff` rows with a `venueId` | the same shape, one venue |
| `daily_close_group_log` | none | the demo sends no email |

Rules the port keeps:

- Who sees what is `A.groupAccess(email)` in the demo and `aal_role` on the server: a group owner or
  manager has the owner's rights at every venue of the group; a venue's own staff see only that venue;
  a waiter is never group staff and sees only their venue's Live floor. The higher of a venue role and
  a group role wins.
- Records are never re-keyed: checks, payments, events and guests keep their `venueId`. A group figure
  is computed per venue exactly as that venue's dashboard computes it (`Aalayna.util.withVenue`) and
  then summed (`A.groupReport`, `A.groupLive`, `A.groupRatings` in owner-metrics.js); rates are worked
  out from the summed counts. A legacy payment row without a `venueId` shows in every venue, so it
  would count once per venue in a group sum.
- Guest lists are never joined across venues; the group view links to each venue's list instead.
- The floor plan is the one venue document kept per venue in the demo: `aal.floor` for the device's
  own venue, `aal.floor@<venueId>` for the others. The menu (`aal.live`) and the rate stay shared by
  the group's venues in the demo; on the server each venue has its own `kv_docs`.
- The demo seeds the group once, only for the fictional Mayda (venue Mayda, place Lebanese Grill) and
  only without a key: two more branches, Achrafieh and Batroun, with today's bills, payments, a pending
  cash request each, a few ratings, and their own floors and staff. The device's own venue gets no
  invented activity.
