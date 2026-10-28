# Aalayna: the roadmap from the bill outward

Written 28 October 2026 with the founder, after the question "with no time limit and no budget limit, what can
Aalayna be?" The answer, in one line: **the operating system of the Levantine restaurant, built from the bill
outward, that a bank, a wallet and a delivery platform all have to plug into, because it is the only one at the
table when the money moves.** This document turns that into layers, horizons and work that agents can start today.

## Where we stand (October 2026)

Live: the marketing site (the table, in EN, FR, AR), the guest flow (QR, menu in three languages and two currencies,
split, tip, Whish or card hand-off to a provider page, cash with staff confirmation, receipt, review), the owner
dashboard with staff roles and one-time email codes, the menu editor, the POS bridge (integration keys, versioned
bill push, till tenders, signed webhooks with retries, a vendor spec in docs/pos-integration.md), a payment callback
receiver with a fake adapter and a Whish stub, receipt emails through an outbox, a daily close email with CSV at 04:00
Beirut, and the growth layer (identity merging, audited receipt and marketing consent, visit history, campaign drafts
and audience export, return-visit reporting, weekly recommendations). Shared mode runs on Supabase; the no-key demo
runs on localStorage. Pilots: Kababji rehearsed; Whish docs and test access awaited; a USD 25k NGO grant pending.

Not live: real money (no provider connected), tips paid out to servers, any POS actually bridged, offline operation,
more than one venue per owner view, a guest-side account, credit.

## The four layers

1. **The table, perfected.** Nothing at the table ever fails the restaurant: offline-first on the venue's own
   devices, every POS bridged (including the paper-ticket ones, by reading the printer stream), every way to pay one
   tap, settlement the same night, tips to the server's wallet, a receipt that is a legal document.
2. **The restaurant's memory.** The only system in a Lebanese restaurant that knows who came, what they ate, what
   they paid, how they rated it and whether they came back: regulars recognised at the table, offers that are earned,
   no-shows predicted from history, the evening's close written in plain words before the owner wakes, three venues
   seen as one floor.
3. **The money.** Nightly settlement through Aalayna gives a restaurant a cash-flow record a bank never had.
   Working-capital advances against next month's covers, supplier payments from the same ledger, payroll for servers
   from their tip history. In a country where restaurants cannot get credit, underwriting them is the business.
4. **The guest side.** The guest never installs anything, but after a few dinners has a quiet account: receipts,
   split history, the places that remember their table. Booking through the thing that already knows you beats a
   directory; then Aalayna owns the dinner from reservation to review.

Geography follows the pain: Lebanon first, then the places with two currencies, cash, wallets and unreliable
infrastructure (Cairo, Amman, Baghdad, Lagos) and the diaspora's restaurants (Paris, Dearborn). Not the Gulf first.

## What money does not buy

Trust at the table (one restaurant telling another), a regulator's blessing to hold money (years, and a bank
partner), and the founder's evenings on floors in Beirut. Spend on people who have run restaurants and on a
settlement licence; keep the product team small.

## Horizons

### Now to 90 days: the table, perfected (software we control)

| Track | Outcome | Depends on |
| --- | --- | --- |
| **T1 Resilience** | A power cut or a dead cell never costs a bill: the guest menu and bill, cash requests and staff cash confirmations work offline on the venue's devices and reconcile when the connection returns, with explicit conflict rules. | Nothing external |
| **T2 One floor for three places** | An owner with several venues sees them as one floor in the dashboard and gets one close, with per-venue drill-down and staff scoped per venue. | Nothing external |
| **T3 The printer-stream bridge** | A POS with no API is bridged by reading what it prints: an ESC/POS stream becomes a bill in the existing pos-bill contract, with a parser proven on real ticket captures. | Ticket captures from pilots |
| **T4 The morning close, in words** | The 04:00 close carries a plain-language narrative of the evening (what moved, what to look at, who came back), deterministic first, an optional model behind a server key later. | Nothing external |
| **T5 Whish, for real** | Whish Money payments settle through the callback receiver; tips are attributed per server and paid out through the same rail. | Whish docs and test access |
| **T6 The French and Arabic site, read** | A native read of the French and Arabic copy; the calculator relinked or retired; the questions reachable on phones. | The founder |

### 90 days to 6 months: the restaurant's memory

| Track | Outcome | Depends on |
| --- | --- | --- |
| **M1 Recognised at the table** | A returning contact's device is greeted by name on the bill, with their usual order one tap away, under the consent already recorded. | T1 |
| **M2 The guest account** | A magic link to every receipt and split a guest has had across Aalayna venues; no app, no password. | M1 |
| **M3 Earned offers** | Campaigns become rules ("third visit this month": a dessert), delivered through a connected sender with the existing audience and report model. | A messaging provider |
| **M4 No-shows and late tables** | Reservation intake (lightweight, or via a partner) joined to visit history, so the floor knows who tends not to show. | M2 |
| **M5 Ten pilots** | Ten paying venues in Beirut on the pilot terms, each with a bridged POS and real settlement. | T3, T5 |

### 6 to 24 months: the money and the guest side

| Track | Outcome | Depends on |
| --- | --- | --- |
| **F1 Nightly settlement** | Aalayna settles to the venue nightly in its chosen currency through a licensed partner; the ledger is the system of record for the day. | A bank or EMI partner, a licence |
| **F2 Advances** | Working-capital advances underwritten on covers and settlement history, repaid from the daily take. | F1, capital |
| **F3 Servers paid** | Tip payouts and, later, payroll for floor staff from the same ledger. | F1, T5 |
| **G1 Book through the thing that knows you** | Guests book at venues that remember them, from their account, with the table ready and the bill already theirs. | M2, M4 |
| **G2 The second country** | The same product in one more market with the same pain. | M5, F1 |

## Wave one, started 28 October 2026

Four agents, one per track, each in its own worktree from main, each delivering tests and a report: T1 resilience,
T2 one floor for three places, T3 the printer-stream bridge, T4 the morning close in words. T5 waits on Whish; T6
on the founder. Every build keeps the repository's rules: a static site with no build step, ES5 in the browser,
Supabase for shared mode, no real money in the demo, every change covered by `node --test tests/*.test.cjs`.
