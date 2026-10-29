# NFC tags on the table card

A table card can carry an NFC tag inside it. A guest taps the card with a phone, and the table's bill opens. The QR stays on the face of every card, and the card says "Tap or scan".

## Why it works

A table card opens one plain link: `https://aalayna.com/guest.html?v=<slug>&t=<table>&s=<code>`. An NFC tag can hold that same link. The tag and the QR open the same page, so nothing changes on the server, in the guest page or on the dashboard.

## Which tags

- NTAG213 or NTAG215 stickers. They cost under a dollar each.
- One NDEF record of type URL (also called URI), holding the table's link.
- Our link is about 100 characters (the code alone is 52). With the longest slug, 40 characters, it is 134 characters and still fits an NTAG213, which holds 144 bytes. An NTAG215 holds 504 bytes, for more room.
- Choose tags made for paper or plastic. A tag glued onto metal does not read.

## How to write and lock them

1. Onboard the venue with `--nfc` (or tick "Cards carry an NFC tag" in the onboarding page). The tool writes `onboarding/<slug>-table-tags.csv`, one row per table: `table,url`. The url is the exact link the card's QR encodes. For cards made in `qr.html`, tick the same box and use "Copy tag list".
2. Open a free NDEF writer app on a phone, such as NFC Tools.
3. For each row, add a URL record with that row's url, then hold the phone to that table's tag to write it.
4. Lock the tag read-only in the same app. Locking cannot be undone.
5. Tap the tag once from an iPhone and once from an Android. Each must open that table's page.
6. Glue the tag inside its card, behind the table number, away from the QR.

The CSV holds the table codes, like the card sheet. It stays in `onboarding/`, which git ignores. Keep it private.

## What phones do

- iPhone XS and later read a tag in the background, from the home screen or the lock screen. The screen must be on. They do not read while the camera app is open. The link shows as a banner, and the guest taps it to open the page.
- Android phones read a tag when NFC is on, with the screen on and unlocked. Most have NFC on by default. The link opens in the browser.
- Older iPhones and phones without NFC use the QR.

## Why the QR stays on the face

- The same code goes on menus, receipts and windows, where there is no tag.
- Some guests have NFC off, or a phone without it.
- A tag can fail: it is damaged, glued onto metal, or was not written.
- Guests already know how to scan a code.

## Tampering

Lock every tag read-only, so no one can rewrite it. Someone could still stick their own tag on top of a card. That tag can only send the guest to another address. It cannot open another table's bill: each link carries that table's own code, and the server checks it. If a card looks tampered with, replace it and revoke its code in `qr.html`.
