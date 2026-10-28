# Printer-stream fixtures

**Every capture in this folder is synthetic.** None was recorded from a real POS. They were
written by `make-fixtures.cjs` from knowledge of typical guest-check layouts, to exercise
`tools/pos-printer/escpos.js` and `tools/pos-printer/ticket.js` until pilots send real
ones. The vendor names describe a layout style, not a verified vendor format.

| Capture | Profile | What it exercises |
| --- | --- | --- |
| `cloud-foodics.bin` | `foodics` | Cloud POS, 80 mm, CP437; a status query and a raster logo (whose data holds LF and ESC bytes) before the text; priced and unpriced modifiers; VAT 11% added on top; double-size total; second total in LBP; QR code. |
| `loyverse-paid.bin` | `loyverse` | 58 mm (32 columns), CP858; table from the open ticket's name; quantity on the row below the item; paid in cash with change; barcode; drawer kick. |
| `legacy-omega-cp1252.bin` | `omega` | Legacy Windows POS, Windows-1252 with French accents; ESC * logo bands; LBP with comma thousands; qty, name, unit and amount columns; double-width total; VAT included; second total in USD. |
| `discount-service.bin` | `generic` | Generic layout read without a vendor profile; ESC D tab stops; month-name date; 10% discount and 12% service charge. |
| `reprint.bin` | `generic` | The same check twice on one connection: an exact reprint (a duplicate), then with an item added (supersedes: same externalId, higher version). |
| `arabic-cp1256.bin` | `arabic` | Windows-1256, every line in visual order as a POS sends it to a printer with no bidi; right-aligned header; an Arabic modifier; service charge. |
| `kitchen.bin` | `foodics` | A kitchen ticket with no prices: ignored. |

Each `<name>.bin` has a `<name>.expected.json`, written by hand from the ticket as printed
(not copied from the parser's output): the venue and profile to read it with, then one
entry per document (a stream can hold several, split at each cut) with its kind, its
review flag, the check fields and the exact `pos-bill` body without `version`.
`tests/pos-printer.test.cjs` reads every pair, so a new pair is tested with no code change.

Rebuild the synthetic `.bin` files after changing the generator:

```
node tests/fixtures/pos-printer/make-fixtures.cjs
node tests/fixtures/pos-printer/make-fixtures.cjs --check   # what the test runs
```

## Adding a real capture from a pilot

1. Capture the raw bytes the POS sends to the printer, as `tools/pos-printer/capture.md`
   describes (the listener's `captureDir`, a network or serial tap, a USB capture, or a
   Windows spool file). Photograph the paper ticket of the same job.
2. **Redact before committing.** This repository is public. Replace guest names, phone
   numbers, addresses, card digits and staff names in the bytes with same-length filler
   (`node -e` with `Buffer.indexOf` and `fill`, or a hex editor), and keep the paper photo
   out of the repository.
3. Name it after the POS and the venue type, for example `real-omega-7.2-hamra-bistro.bin`.
4. Write `<name>.expected.json` from the paper ticket, not from the parser: every item,
   quantity and amount, the discount, service, VAT and total as printed. Set
   `"synthetic": false` and say in `description` which POS, version and printer model
   produced it and how it was captured.
5. Run `node --test tests/pos-printer.test.cjs`. When it fails, change the vendor's profile
   in `tools/pos-printer/profiles/` (or add one) until it passes; change the parser only
   for a command it does not know. Keep the synthetic fixtures passing.
