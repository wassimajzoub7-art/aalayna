# Aalayna POS integration (v1)

For the engineer connecting a point-of-sale system to Aalayna. Your POS pushes each table's bill to Aalayna; guests scan the table code, see that bill and pay their share on their phone; Aalayna tells your POS when the bill is paid and when it is closed. Payments taken at your till come back to Aalayna on the same call. The waiter types nothing twice.

Your POS stays the authority on items and prices. Aalayna is the authority on what guests paid through it.

## Connecting

| | |
| --- | --- |
| Base URL | `https://xeqbkamwucqplvoavhyd.supabase.co/functions/v1` |
| Endpoint | `POST /pos-bill`, `Content-Type: application/json`, body at most 256 KB |
| Auth header | `X-Aalayna-Integration-Key: pos_<64 hex digits>` |

The venue owner issues one key per venue (or per till) and gives it to you. It is shown once; Aalayna stores only its hash. Keep it on your server or the till, never in a browser, and ask the owner to revoke it if it leaks: a revoked key stops at once.

## Sending a bill

Send the whole bill every time it changes: open, items added or voided, table moved, closed. There is no separate "add item" call.

| Field | Type | Rule |
| --- | --- | --- |
| `externalId` | string, 1 to 100 | Your bill ID. Must never repeat for the venue: if check numbers restart each day, send `2026-09-30/0042`, not `0042`. |
| `system` | string, optional | Your product name, for example `omega`. Default `pos`. |
| `table` | integer 1 to 9999 | The table the guests scan. |
| `currency` | `USD` or `LBP` | Fixed once the bill is open. |
| `lines` | array, up to 500 | `{externalId, name, quantity, unitPriceCents, modifiers?, note?}` |
| `lines[].externalId` | string | Your line ID, unique on the bill and stable across versions. Must not start with `aalayna:`. |
| `lines[].quantity` | integer 0 to 999 | 0, or leaving the line out, voids it. No fractional quantities. |
| `lines[].unitPriceCents` | integer | Price of one unit, modifiers included. |
| `lines[].modifiers` | array, optional | Names shown after the item, for example `["Extra garlic"]`. |
| `lines[].note` | string, optional | Accepted and discarded: notes can hold guest details. |
| `discountCents`, `serviceCents` | integers, optional | Bill-level discount and service charge. |
| `totalCents` | integer | Must equal the sum of `quantity x unitPriceCents`, minus `discountCents`, plus `serviceCents`. |
| `version` | integer >= 1 | Grows with every change you send. |
| `tenders` | array, optional, up to 50 | Payments taken at your till: `{externalId, method, amountCents, tipCents?, takenAt?}`. See below. |
| `closed` | boolean, optional | `true` asks Aalayna to close the bill. |

Amounts are integer minor units, 100 per unit in both currencies: USD 12.50 is `1250`, LBP 1,500,000 is `150000000`. Aalayna converts nothing; bills are in the venue's display currency and any USD/LBP rate is the venue's own. The service charge appears as its own line, `Service`. Aalayna has no negative lines, so a discount is spread over the item lines in proportion to their value, to the cent.

**Open** (a new `externalId`): answers `201`.

```http
POST /functions/v1/pos-bill
X-Aalayna-Integration-Key: pos_3f9c...
{"externalId":"2026-09-30/0042","system":"omega","table":7,"currency":"USD","version":1,
 "lines":[{"externalId":"L1","name":"Hummus","quantity":2,"unitPriceCents":500},
          {"externalId":"L2","name":"Shish taouk","quantity":1,"unitPriceCents":1200,"modifiers":["Fries"]}],
 "serviceCents":220,"totalCents":2420}
```
```json
{"checkId":"pos_4be1c07a9d2f6e3b18a5c0d7","status":"opened","system":"omega","externalId":"2026-09-30/0042",
 "version":1,"revision":1,"table":7,"currency":"USD","closed":false,"closedAt":null,
 "balance":{"totalCents":2420,"paidCents":0,"pendingCents":0,"remainingCents":2420}}
```

**Update** (same `externalId`, higher `version`): answers `200` with `"status":"updated"`. Here a dessert is added and the table moves to 9:

```json
{"externalId":"2026-09-30/0042","system":"omega","table":9,"currency":"USD","version":2,
 "lines":[{"externalId":"L1","name":"Hummus","quantity":2,"unitPriceCents":500},
          {"externalId":"L2","name":"Shish taouk","quantity":1,"unitPriceCents":1200,"modifiers":["Fries"]},
          {"externalId":"L3","name":"Knefeh","quantity":1,"unitPriceCents":600}],
 "serviceCents":280,"totalCents":3080}
```

**Close** (`"closed": true`, with the latest contents): answers `200` with `"status":"closed"` once the whole bill is paid, by guests through Aalayna or by the tenders you send. If money is still owed the answer is `409 balance_outstanding` and the bill stays open:

```json
{"error":{"code":"balance_outstanding","message":"This bill still has 1480 cents outstanding in Aalayna, so it cannot be closed.",
 "totalCents":3080,"paidCents":1600,"pendingCents":0,"remainingCents":1480,"checkId":"pos_4be1c07a9d2f6e3b18a5c0d7"}}
```

An answer is `201` when the request created the bill (even if it also closed it), else `200`; `tendersRecorded` counts the tenders it recorded. Every answer carries `balance`: `paidCents` is confirmed payments (guests' and your tenders) without tips, `pendingCents` is cash awaiting a waiter or a card payment in progress, `remainingCents` is total minus paid (pending included).

## Payments taken at your till

Send each tender with the bill, on any update or with the close. Aalayna records it as a confirmed payment (rail `pos`), in the bill's currency, so the guest page stops asking for that money and the close succeeds once the balance is zero.

| Field | Rule |
| --- | --- |
| `externalId` | Your tender ID, unique on the bill. Sending it again is a no-op; the same ID with another amount or method is `409 tender_changed`. |
| `method` | `cash`, `card` or `other`. |
| `amountCents` | What was taken, tip included. |
| `tipCents` | The tip within `amountCents`, default 0. Must be less than `amountCents`. |
| `takenAt` | ISO 8601, optional. Kept between the bill's opening and now. |

Tenders are recorded after the lines and before the close, all in one transaction. A tender that would take paid plus pending guest payments past the total is `409 overpaid` with `leftToPayCents`, and nothing in the request is saved; a guest may be paying on their phone at that moment, so show the message to staff. A bill paid entirely at the till is one request:

```json
{"externalId":"2026-09-30/0042","table":7,"currency":"USD","version":3,"totalCents":2420,"closed":true,
 "lines":[{"externalId":"L1","name":"Hummus","quantity":2,"unitPriceCents":500},
          {"externalId":"L2","name":"Shish taouk","quantity":1,"unitPriceCents":1200}],
 "serviceCents":220,
 "tenders":[{"externalId":"T-881","method":"cash","amountCents":2000},
            {"externalId":"T-882","method":"card","amountCents":720,"tipCents":300}]}
```

## A new bill on a busy table

If a new `externalId` arrives for a table whose Aalayna bill is still open (a bill your POS closed without telling Aalayna, or one staff opened in Aalayna), Aalayna closes the old bill as superseded and opens yours, provided nobody paid or asked to pay anything on it. If the old bill has any payment record, even a cancelled request, the answer is `409 table_busy` with `openCheckId`, and staff settle it in Aalayna first.

## Versions, retries, idempotency

- A request is all or nothing: a refused request changes nothing.
- The same `version` with the same contents is a no-op `200` (`"status":"unchanged"`), so retry freely after a timeout. Adding `closed: true` or new tenders to the current version is allowed: tenders are matched by their own `externalId`, not by the version.
- The same `version` with different contents is `409 version_reused`. A lower `version` is `409 stale_version`, with `currentVersion`: drop it, a newer one already arrived.
- Timestamps in milliseconds make good versions.

## Errors

Every error is `{"error": {"code", "message", ...}}`. Show `message` to staff as is.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_json`, `bad_body` | `fields: [{field, message}]` names each problem, e.g. `lines[2].quantity`. |
| 400 | `empty_bill` | A new bill needs at least one item. |
| 401 | `unknown_key` | Missing, unknown or revoked key. |
| 409 | `rule` | A guest has paid for part of the bill; see below. `message` is Aalayna's sentence, e.g. "Hummus is covered by a payment and cannot be removed." |
| 409 | `balance_outstanding` | Close refused; `remainingCents` says how much. |
| 409 | `table_busy` | That table's open Aalayna bill has payment records (`openCheckId`); see above. |
| 409 | `overpaid` | A tender would overpay the bill; `leftToPayCents`, `paidCents`, `pendingCents`. |
| 409 | `tender_changed` | A tender ID already recorded with another amount or method. |
| 409 | `bill_closed`, `currency_changed`, `stale_version`, `version_reused` | As named. |
| 413 | `too_large` | Body over 256 KB. |
| 429 | `rate_limited` | Over 600 requests in a clock minute for this key. Wait `Retry-After` seconds. |
| 500, 503 | `internal`, `unavailable` | Retry the same request later with backoff. |

Once any payment exists on a bill (a guest's, pending or confirmed, or a tender), the lines Aalayna shows never change again; your later versions are followed by adding lines only:

- A new item appears at its full price.
- A line whose quantity grows grows in place, or, if it carries part of a discount, gets an added line `aalayna:+<version>:<your line id>` for the extra units at full price.
- A service charge that grows gets an added `Service` line `aalayna:service:<version>` for the difference. A service charge that shrinks is refused: "A payment is recorded on this bill. Items can be added, not removed or reduced."
- A discount that grows or shrinks is refused: "A payment is recorded on this bill. The discount cannot change."
- A removed or reduced line is refused ("Hummus is covered by a payment and cannot be removed." when a guest paid for it), and so is a changed unit price.

Voids, comps and discounts belong before anyone pays.

## Webhooks

The owner registers your HTTPS endpoint and gives you its secret (`whsec_...`, shown once). Aalayna POSTs JSON:

| Event | When | Payload |
| --- | --- | --- |
| `bill.paid` | Confirmed payments first cover the total | `venue, checkId, externalId, table, totalCents, paidCents, currency, payments: [{id, rail, amountCents, tipCents, confirmedAt, externalRef}]` |
| `bill.closed` | The bill is closed, by your POS, by staff, or superseded | `venue, checkId, externalId, table, closedAt, closedBy, supersededBy` |
| `ping` | The owner presses "test" | `venue, endpointId` |

Every payload also has `event`, `eventId` and `occurredAt`; `bill.paid` and `bill.closed` also have `origin`: `pos` for a bill your POS opened, `aalayna` for one staff opened in Aalayna (its `externalId` is `null`). `closedBy` is `pos` when your own request closed or superseded the bill, so you can ignore your own closes, and `aalayna` when staff closed it; `supersededBy` is the new `externalId` that replaced the bill, else `null`. In `payments`, `amountCents` includes the tip and `tipCents` is the tip within it; `rail` is `cash`, `card` or `whish` for guests paying through Aalayna and `pos` for your own tenders, which also carry `tenderExternalId` (else `null`).

```http
POST https://your-server.example/aalayna
X-Aalayna-Event: bill.paid
X-Aalayna-Delivery: 0f5c2b8e-8d1b-4b7e-9d8a-6a1f3e2c9b10
X-Aalayna-Signature: <64 hex digits>
{"event":"bill.paid","eventId":"pos_4be1c07a9d2f6e3b18a5c0d7:bill.paid","venue":"[\"mayda\",\"hamra\"]",
 "occurredAt":"2026-09-30T21:14:03.120Z","checkId":"pos_4be1c07a9d2f6e3b18a5c0d7","externalId":"2026-09-30/0042",
 "table":9,"origin":"pos","totalCents":3080,"paidCents":3080,"currency":"USD",
 "payments":[{"id":"tnd_5c1e","rail":"pos","amountCents":1600,"tipCents":0,"confirmedAt":"2026-09-30T21:02:40.511Z","externalRef":null,"tenderExternalId":"T-881"},
             {"id":"pay-2","rail":"whish","amountCents":1780,"tipCents":300,"confirmedAt":"2026-09-30T21:14:03.101Z","externalRef":"whish-88213","tenderExternalId":null}]}
```

Check the signature on the raw bytes before parsing:

```
expected = hex(hmac_sha256(key = endpoint_secret, message = raw_request_body))
if not constant_time_equal(expected, header["X-Aalayna-Signature"]): return 401
if seen(header["X-Aalayna-Delivery"]): return 200   // already handled
```

Answer any 2xx within 10 seconds; do the work afterwards. Anything else, a redirect or a timeout is retried after 1, 5, 30, 120, 720, 720 and 720 minutes; after 8 failed attempts the delivery is dropped and shown to the owner. Delivery is at least once and not ordered: deduplicate on `X-Aalayna-Delivery` (the same on every retry) or `eventId`.

## What Aalayna never does

- It never creates orders or sends items to your kitchen.
- It never changes prices or items on your bill; it only refuses changes that would contradict what guests already paid.
- It never refunds, voids or reopens anything through your POS; refunds go through the payment provider and your staff.
- It never converts currency on your bills.

## Known limits of v1

- Refunds and voids of tenders are not accepted from the POS; a tender, once recorded, stays.
- LBP bills are stored and totalled as sent, but the guest page and payments label amounts in USD today; send USD until Aalayna confirms LBP display.
