# Live integration handoff

## What is implemented

`restaurant-growth.js` adds restaurant/branch-scoped customer identity, audited receipt and marketing choices, confirmed-payment-linked visit history, campaign drafts and audience approval, comparison-group assignment, delivery report imports, return-visit reporting, check balances and weekly recommendations. `restaurant-ops.js` and `restaurant-ops.css` expose these in the existing owner dashboard. The guest receipt links an optional contact to its actual prototype settlement ID.

The marketing website has no interactive demos or links into the apps.

## Runtime boundary

This repository is served by GitHub Pages. Its operational data is stored in localStorage, in one browser and origin. It has no authenticated server, shared database, delivery service, POS connection or real payment processing. Branch keys are data organisation, not authentication or a tenant security boundary. Never store real customer or payment data in this public prototype. Cross-tab updates are best effort; simultaneous browser tabs cannot guarantee atomic payment reservations. A live system must enforce all these rules on a server using database transactions and access controls.

The payment buttons still simulate digital confirmation. Cash requests require an operator confirmation. Campaign approval and audience export never send messages. No receipt delivery or unsubscribe web endpoint is connected.

## Customer and campaign definitions

- A contact is an identified payer, not every diner or a verified identity. Email is normalised to lowercase; phone numbers require an international country code. Phone/email ownership verification is a live onboarding requirement.
- Each customer/check pair counts once, regardless of repeated form submissions or partial payments. Attributable spending excludes tips and refunded payments. Fully refunded visits leave this conservative paid-visit metric. Two different bills may be two recorded visits even on one day; use POS visit/session IDs if that definition is unsuitable.
- Only confirmed, scoped payments with check IDs contribute to profiles. Legacy counters and records without branch/check evidence are excluded; do not infer visits or permission from them. Record a new explicit receipt opt-in instead.
- Marketing consent is separate from receipt permission. The latest explicit choice applies, with timestamp, source and wording version recorded. Owner-recorded opt-outs remain in the audit history and suppress future exports.
- Second-visit audience: exactly one recorded visit, 7–29 days ago. Lapsed: last recorded visit at least 30 days ago. Regulars: at least three visits and last visit under 30 days ago. Every campaign audience also requires active marketing permission and the selected channel.
- Approval fixes the treatment/comparison assignment once. The optional comparison group reserves approximately 20%, with a minimum total audience of five. This is an operational minimum, not a statistical-power claim. Export rechecks current permission; the live sender must recheck again at send time.
- A draft, approval or export is not a delivery. Imported reports require eligible recipient IDs, valid successful-delivery timestamps and provider message IDs. Reports are owner supplied and not independently verified.
- Results cover the common 30-day window starting at approval. Delivered-recipient results additionally exclude visits preceding that recipient's delivery. Original-assignment results retain their original denominators, including undelivered recipients, alongside comparison contacts. Unfinished windows and small samples are labelled. A later visit may be associated with multiple campaigns. Reports do not claim causal revenue lift or profit.

## Audience and delivery report files

After approving a campaign, **Export eligible audience** downloads JSON with `campaignId`, `customerId`, `contact`, `channel` and the reviewed `message`. Comparison contacts are excluded. JSON preserves international phone numbers without spreadsheet formula interpretation. The restaurant must use its own approved provider and opt-out handling; this prototype does not submit the file anywhere.

**Import delivery report** accepts a JSON array under 1 MB. Each entry has:

```json
[
  {
    "customerId": "guest-ID-FROM-AUDIENCE-EXPORT",
    "deliveredAt": "2026-09-05T18:00:00.000Z",
    "providerMessageId": "ID-FROM-THE-MESSAGING-PROVIDER"
  }
]
```

Use actual provider delivery confirmations, never audience-export or submission timestamps. The time must be after approval and the relevant opt-in, and must not be in the future. A repeated identical record is idempotent. Reports must not include comparison contacts. Date examples above are illustrative, not importable seeded activity.

## First live POS connection

Choose one POS/version installed at willing pilot restaurants. Obtain partner access, a sandbox and written confirmation of these capabilities before selecting a direct adapter or middleware:

| Operation | Required data and behaviour |
| --- | --- |
| Read an existing waiter-created bill | Immutable restaurant/location/check IDs; table; bill version; line IDs, quantities, modifiers, tax and discounts; authoritative total and currency |
| Observe bill changes | Versioned events or documented polling, including table transfer, void, split and close |
| Apply a partial payment | Bill principal and tip separately; payment method; provider transaction ID; idempotency key; check version or atomic balance check |
| Reconcile | Read applied tenders and outstanding balance; safely retry duplicate or delayed callbacks |
| Refund or void | Explicit refund/void events; distinguish a refund after close from a newly collectible debt |

Sending new online orders to a POS does not prove support for these existing-bill operations. Provider fees, licensing, supported versions and local support remain to be confirmed.

## Whish, card and cash

1. Obtain merchant credentials, provider documentation and a test environment. Keep secrets on a backend, never in these static files.
2. Create a payment intent against an authoritative check version and reserve only the bill principal being paid. Store amounts as integer minor units with an explicit currency and rate snapshot for any conversion.
3. Verify signed provider callbacks server-side; match merchant, payment intent, currency and amount. A redirect, button click, screenshot or client claim is not confirmation.
4. Persist the provider result and POS writeback separately. If money is received but POS writeback fails, show a reconciliation exception and retry idempotently. Do not ask the diner to pay again.
5. Release expired/failed reservations. Cash reservations remain pending until an authenticated operator confirms collection or cancels them. The prototype prevents sequential overpayment but cannot provide cross-device atomicity.
6. Test cash plus card/Whish, repeated callbacks, two simultaneous payers, changed bills, partial refunds, network loss and recovery before taking real money.

## Messaging and authenticated operations

Use a shared backend with restaurant-scoped staff authentication, permissioned access, audit logs, backup/restore, retention/deletion handling and guest tokens limited to one check. Connect restaurant-owned WhatsApp Business/email accounts. Obtain the relevant approved templates, configure inbound opt-out processing and enforce suppression immediately before every send. Ingest provider delivery callbacks with signature verification and duplicate protection. Keep receipt delivery separate from marketing.

The next external inputs needed are the first pilot restaurant's POS name/version and partner access, the merchant's Whish/card integration documentation and test credentials, and a backend hosting choice. No live integration is claimed until those connections pass a real end-to-end acceptance test.
