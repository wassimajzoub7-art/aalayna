# Resilience: working through a power cut or a dead cell (T1)

The outcome (docs/roadmap.md, T1): a power cut or a dead cell never costs a bill. The guest
menu and bill, cash requests and staff cash confirmations keep working offline on the venue's
devices and reconcile when the connection returns, under the rules below.

This page is the contract. Where a rule is enforced, the file and the test are named. Every
conflict in section 5 has a test in `tests/resilience.test.cjs` (client side) and, where the
server decides, a case in the same file's PGlite block (skipped unless `PGLITE_MODULE` is set,
see `supabase/README.md`, "Tests").

## 1. What is on the device, and for how long

Two layers keep a device working without the network:

- **The service worker** (`sw.js`) keeps the files. The guest page registers it with the scope
  `guest.html`; the dashboard registers the same file as `sw.js?shell=staff` with the scope
  `dashboard.html`. Each scope has its own cache (`aal-guest-*`, `aal-staff-*`) and its own
  precache list (`GUEST_SHELL`, `STAFF_SHELL`), so a guest phone never downloads the dashboard.
- **The scoped store** (`aalayna-store.js` scopes, `aalayna-sync.js`) keeps the data, in
  `localStorage`, per venue, role and credential. The service worker never caches the
  Supabase API: data offline is always the last good read of the store, never a stale HTTP
  answer.

| What | Where | Kept until | Shown offline as |
| --- | --- | --- | --- |
| Guest page, its scripts | `sw.js` precache (`GUEST_SHELL`), network first | the next deploy (`VERSION` bump), refreshed on every online load | the page, as last deployed |
| Dashboard, its scripts and styles | `sw.js?shell=staff` precache (`STAFF_SHELL`), network first | the same | the page, as last deployed |
| Any other same-origin script, style, font, JSON or SVG a controlled page asks for | runtime cache, network first | the next deploy | the copy last fetched |
| Fonts (Google Fonts) and images | runtime cache, cache first | the next deploy | as cached |
| Menu photos (`imageUrl`, other hosts) | warmed by the guest page after the menu paints (at most 60), cache first | the next deploy | the photo, or no photo (the item stays) |
| The published menu (`aal.live`) and its rate (`aal.rate`, `aal.rate_meta`) | scoped store | replaced by the next good read; no expiry | the menu as last read; a stale price cannot cost money, because the server prices the bill, not the menu |
| The guest's open bill (`aal.checks` row, its payments) | scoped store, per bill key, with the time of the last good read (`aal.sync.read`) | replaced by the next good read | "No connection. Your bill is as of 21:04 ...", with that time |
| The table card's last resolution (venue, table, whether it had a bill) | `localStorage` `aal.table-qr.last:<slug>:<table>` | 6 hours (`OFFLINE_MAX_AGE_MS`) | an offline rescan of the same card opens the bill this phone last read for that table |
| The venue's settings (theme from the link, floor plan `aal.floor`, tip rules `aal.tips`) | address and scoped store | replaced by the next good read | as last read |
| The staff dashboard snapshot (open bills, pending cash, payments) | scoped store, per staff credential | replaced by the next good read | the Live floor as last read, with the status line saying offline |
| The staff member's role at this venue | `localStorage` `aal.staff.mine:<user>` | replaced at every online check; used only while the server cannot be reached | the dashboard opens with the last role; the server re-checks the role on every queued change |
| The outbox (unsent changes) | `localStorage` `aal.scope:...:aal.outbox`, per credential | until the server answers each change | the receipt ("saved on this phone") and the status line ("Offline · 1 cash confirmation waiting to send") |

## 2. What can be done offline, and what cannot

| Action | Offline? | How |
| --- | --- | --- |
| Browse the menu, open the bill, pick a split, change the tip | yes | all local; nothing is sent |
| A guest's **cash request** | yes, if this phone read the bill in the last 6 hours | queued in the outbox as `op:reserve:<payment id>` with the payer token; the receipt reads "Cash request saved on this phone. It reaches the restaurant as soon as you are back online." |
| A guest cancelling their own cash request | yes, once the request exists on this phone | queued after the request (`op:cancel:<payment id>`), sent in that order |
| A **split** | yes, as part of the cash request | a split is not a server record of its own: it is the amount or items of the guest's cash request, checked by the server when the request arrives |
| A waiter's **cash confirmation** | yes, if this device holds the request as pending | queued as `op:confirm_cash:<payment id>`; the row reads "Confirmed on this device at 21:04 · waiting to send" and loses its buttons, so it cannot be confirmed twice |
| Entering or changing a bill (staff) | only on a dashboard that was connected when the connection dropped | queued as before (`restaurant-ops.js`: "This bill is waiting to be sent"); the server checks it against the bill's revision |
| **Closing a bill** | no | needs the server to see every payment on the bill; refused on the device: "Closing a bill needs the connection. Try again when the status line says Saved." |
| A refund, a new bill link, staff changes | no | refused on the device with the same kind of message |
| A **digital payment** (Whish, card) | no | the hand-off goes to the provider and back; the page says so, and cash stays available |
| Signing in | no | a code is sent by email; an already signed-in device keeps working |

The device clock is never trusted for money: what the server records as `ts` and
`confirmedAt` is the server's time at receipt. The device's time is kept in the outbox (`at`)
and shown to the person who acted ("confirmed on this device at 21:04").

## 3. The outbox

The outbox already existed (shared mode, T8). T1 adds three rules to it:

1. **Order.** Each queued change carries `seq`, a counter kept per device (`aal.outbox.seq`),
   and `at`, the device clock. The outbox sends in `seq` order, never in clock order (a clock
   can jump when a phone without network resyncs). A change that fails for a network reason
   stops the run, so nothing behind it overtakes it; a change the server refuses leaves the
   outbox and the next one goes. Changes queued before `seq` existed keep their place
   (they sort first, in the order they were stored).
2. **Idempotency key.** The outbox id is the idempotency key: `op:<operation>:<payment id>`.
   The payment id is made on the device before anything is sent (`requestId`), so a resend
   after a lost answer, a reload, or a second tap is the same change. Queuing a change whose
   id is already queued with the same content keeps the first one (and its `seq`) and tells the
   caller it is already waiting; it never becomes two jobs.
3. **Offline admission.** A page that has not reached the server since it loaded queues only
   what section 2 allows: a guest's cash request and cancel, a staff cash confirmation. Anything
   else is refused on the device with a plain message, never queued.

The server already treats these ids as idempotency keys, under the venue lock that
serializes every `aal_mutate` call (`supabase/auth-2026-09-24.sql`):

- `reserve` with an id it already holds: the same payer token and the same amount, tip, rail
  and items return the stored request unchanged; anything else is refused ("Payment request
  changed").
- `confirm_cash` on a confirmed request returns it unchanged; no second `payment_completed`
  event is written.
- `cancel` on a cancelled request returns it unchanged.

So T1 needs **no migration**: the server contract is unchanged.

## 4. Reconnecting

When the connection returns (the `online` event, the 4-second poll, or Retry):

1. The device reads first (`aal_snapshot`), then sends the outbox in `seq` order.
2. Each change is decided by the server against the state at the moment it arrives, under
   the venue lock. Across devices, **the first change the server receives wins**; the device
   clock never decides.
3. A change the server accepts updates the local copy from the server's answer (never from
   what the device guessed). A change the server refuses leaves the outbox, its message is
   shown once, and it is kept in the refusal list (`aal.outbox.refused`).
4. The guest receipt turns into "Cash requested." once its request is sent; the staff row
   turns into a collected payment once the confirmation is sent and read back.

## 5. Conflict rules

Each rule names what wins, what the losing side sees and the test (`tests/resilience.test.cjs`
unless noted).

| # | Conflict | Rule | The loser sees |
| --- | --- | --- | --- |
| C1 | A cash request is sent twice (the answer was lost, the page reloaded, the guest tapped twice) | One outbox entry per payment id; the server returns the stored request for a repeat with the same token and content | nothing: one request, one receipt |
| C2 | Two staff devices confirm the same cash, one or both offline | The first confirmation the server receives confirms it; the second gets the confirmed request back. One payment, one `payment_completed` event | nothing: both rows read collected |
| C3 | A waiter confirms cash offline; meanwhile the request was cancelled (by the guest, or on another staff device) | Cancel received first wins. The confirmation is refused ("Cash request changed") | the dashboard: "Table 7, $18.00: this cash request was cancelled or changed on another device before your confirmation reached the restaurant (you confirmed it on this device at 21:04). It is not recorded as paid. If you took the cash, give it back or tell the manager." |
| C4 | A waiter confirms cash offline; the bill was closed elsewhere | A bill closes only when its confirmed payments cover it, and the server counts a pending cash request against the balance (the till too: `aal_pos_bill` refuses a tender over paid + pending). So a bill with this request pending cannot close: either the request was confirmed elsewhere (C2) or cancelled first (C3). The close wins in the sense that it is never undone; the late confirmation is applied only if the request is still pending | as C2 or C3 |
| C5 | A confirmation was sent after the request was cancelled on the same device | Order on one device is `seq` order: the cancel queued first reaches the server first | the confirmation's refusal, as C3 |
| C6 | A split changed on two devices: two guests claim the same items, or together more than the balance, one or both offline | First received wins. The server refuses the second ("Item already reserved", "Another payment already covers this balance. Refresh your bill.") | the guest is taken back to Pay with that reason and the refreshed bill; their saved receipt is withdrawn, never left as "saved" |
| C7 | Staff changed the bill while a guest's cash request waited offline | The request is checked against the bill as it is when it arrives: items that no longer match, or an amount over the new balance, are refused | as C6 |
| C8 | The bill this phone holds is old (last good read more than 6 hours ago) | No offline cash request: "Connect to the restaurant before continuing." The bill is still shown with its time | the guest asks the server, as before |
| C9 | The device clock is wrong | Clocks never order or decide anything; `seq` orders one device, server receipt orders devices; server timestamps are recorded | nothing |
| C10 | Someone tries to close a bill, refund, or start a digital payment offline | Refused on the device, never queued | a plain message: it needs the connection |
| C11 | A second tap on "Confirm cash received" while the first waits | One outbox entry; the row has no buttons while its confirmation waits | "Already confirmed on this device. It is sent when the connection returns." |
| C12 | The bill's key ended (closed more than 24 hours ago) while a request waited | Unchanged from T8: unsent requests for that bill are refused with "This bill is closed. Scan the table code again for a new bill." (`tests/followups.test.cjs`) | that message |
| C13 | Staff sign out, or switch from an owner link to a sign-in, with confirmations waiting | Unchanged from T8: a warning before sign-out, and the outbox follows the device to the next credential that may send it (`tests/followups.test.cjs`) | the warning |

## 6. How people learn they are offline

- **The guest.** A thin banner under the top of the page, as soon as the phone reports no
  connection or after two failed reads in a row: "No connection. Your bill is as of 21:04; we
  will send your payment when you are back online." (in English, French and Arabic). A cash
  request made then shows its receipt with "Cash request saved on this phone. It reaches the
  restaurant as soon as you are back online." The banner goes after the next good read. No
  error screen, no motion added (the banner has no animation, so reduced motion is
  unchanged). Without JavaScript the guest page does not run at all, offline or not; that is
  unchanged.
- **The staff.** The sync status line (top right on every staff page) turns into an offline
  indicator with the queue: "Offline · 2 changes waiting to send (1 cash confirmation)", with
  Retry. Each confirmation waiting reads, on its row: "Confirmed on this device at 21:04 ·
  waiting to send". A refusal is shown once with its reason (C3), until dismissed.

## 7. What T1 does not do

- No offline sign-in, no offline bill close, no offline refunds, no offline digital payment.
- No peer-to-peer sync between devices in the room: two devices that are both offline do not
  see each other's changes until both reconnect. The rules above make that safe, not
  invisible.
- A phone that never loaded the guest page with a connection has nothing to show offline.
- The first load of the dashboard after this change installs its service worker; only the
  loads after that work offline.
