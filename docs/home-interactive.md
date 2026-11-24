# The homepage: version E of the table, the interactive version (17 October 2026)

Amendment 10 of `table-brief.md`, built on style D after its mobile rebuild (amendments 9 and 11 kept). Launched as the homepage on
17 October (amendment 13): `index.html`, `fr/index.html` and `ar/index.html`, with `home.css` and `home.js`.

## What is live

The three phones on the table (the menu, the split, the payment, and the thank-you screen under the payment) are HTML
replicas of the real guest app as the film shows it: `guest.html?theme=balat` (bone paper, ink rules, square
corners, the cement tiles, Fraunces and Reem Kufi for names and figures, Instrument Sans and IBM Plex Sans Arabic for
the rest), with the real menu pack (`venues/mayda.json`) and the real sample check (twelve lines, $152.50). Each
screen is laid out in the app's own points (390 to the screen's width, one point is `--p`) and its type uses the
site's six size tokens in those points, as the lettering on the other objects does in theirs.

`tools/home-screens.js` writes each screen's default HTML into the three pages (between `<!--g:name-->` markers),
from the data and words that `home.js` exports under Node; run it after changing either. Without JavaScript the
screens read the film's evening and the controls are visible and disabled.

| Stretch | What can be tried | Default (the film) |
| --- | --- | --- |
| The menu | the language (EN, FR, AR) and the currency (USD, LBP) in the app's own two pickers; a dish tapped on or off the bill | English, dollars, the film's twelve dishes: $152.50 (the bar reads Open the bill and the total, as the real app) |
| The split | How many of you? 2 to 6 | 4: $38.13, and $38.13, $38.13, $38.11 for the others |
| The payment | No tip, 5, 10 or 15%; Whish, Card or Cash | 10%: $3.81, $41.94; Whish |

The way to pay carries on like the rest: the button reads as the real app's (Pay $41.94 for Whish and card,
Request cash collection for cash), and the thank-you screen says Paid via Whish Money, Card or Cash; for cash it adds
the real app's confirmed line (Cash collection confirmed by your server) and the Paid chip reads Paid $41.94 · cash.

On a wide screen a control acts only while its phone is in its hold (complete and centred: 50% to 32% of the
window, to 10% for the menu, which nothing moves after). On the phone stage it acts for as long as its phone is the
current one: from the moment the phone is complete until its own hand-off begins (the menu until its table starts to
move; the split and the payment until your share or the Pay press leaves); outside that, the caption's controls
dim to 40%. Tabbing to a control first brings its phone there. Nothing is dragged and nothing scrolls inside a phone.
Under 1024 px the caption also carries the language and currency, the guests and the tips at full size (44 px and
more); the screen's own controls still answer a tap, and keyboard focus goes to the caption's.

## How the state flows

One object, `S` in `home.js` (`lang`, `ccy`, `q` the quantity of each dish, `people`, `tip`), and one function of
it, `calc`, give every amount: the bill bar's total, the receipt on the brass tray (its lines, its height
and the number of guests), your share and each of the other guests' shares (the ones that fly off), the rest for the
others, the payment's bill share, tip and total, the Pay button, the Paid chip, the thank-you screen and the review
card's Paid line. Each tap changes `S` and repaints text only, so the elements the scroll engine moves stay the same.
If the receipt gains or loses a line the engine measures again (the receipt's travel is sized from it).

The arithmetic is the real app's: LBP at 89,500 (`Aalayna.rate()`'s default) rounded to the nearest LL 1,000; each
share is the bill over the guests rounded to the cent, the last share takes the remainder (three of you on $152.50:
$50.83, $50.83, $50.84; six: five of $25.42 and $25.40); the tip is the share times the rate, rounded to the cent.

## The stage's unit, and ?debug=1

On the phone stage every stretch is measured in the stage's own height (100svh and the header), never in
innerHeight, which Safari changes as its toolbars come and go; the gate asks which stretch the scroll is in and how far
through it, from that timeline. A re-measure (window or visualViewport resize) keeps the reader at the same point of
the same stretch. `?debug=1` adds a read-out at the foot of the window: the stretch and its progress, which phone
takes taps, innerHeight, visualViewport.height and the stage's unit, the tip and the way to pay.

## Editable from anywhere

Whether a phone takes taps is a function of the scroll position alone: the gate is set on every scroll event as
well as on every frame, and nothing is remembered from the way down. The animation loop restarts itself if a frame
is ever dropped (a page frozen in the back/forward cache as the reader leaves it, a tab sent to the background
mid-scroll) and on pageshow and visibilitychange; before this, a dropped frame left the loop switched off and every
phone's controls stuck in their last gate.

## The soft settle (behind a flag)

`?settle=1` turns it on (remembered for the session, so it survives the language switch); `?settle=0` turns it off;
off by default. When the reader stops within 15% of a window's height of a hero's settle target, the page eases the
last pixels over 400 ms with the site's ease-out so the hero sits centred and complete, its caption aligned. Targets:
beside the table, the hero's centre at 50% of the window (the start of its hold); on the phone stage, the middle of its
stretch's hold (from the stage's own timeline). It starts only after 120 ms without a scroll event (on a touch screen,
after the finger has lifted), never inside a travel (the chain's links on a wide screen, every hand-off on the
stage), never after keyboard scrolling or while a tapped control holds focus, and never with reduced motion. Any
wheel, touch, key or pointer input, or a scroll it did not write, cancels it at once. It writes the scroll position
each frame (requestAnimationFrame and an instant scrollTo), so the chain renders every frame like any other scroll.

The native path (CSS `scroll-snap-type: y proximity` with markers at the targets) was tried and dropped: Chromium
snapped from 45% of a window away (its proximity is its own, not 15%) and pulled a PageDown onto the next target,
while WebKit did not snap from a wheel at all; neither can be kept out of the hand-offs. The script path runs
everywhere.

## The captions on the phone stage

During a hand-off the outgoing caption steps back (55%, a quarter of a rem up) and stays until the incoming caption
lands; the two cross over the last tenth of the hand-off, so the cream band is never empty.

## The app's Arabic, written for this page

English and French are the real app's strings. The Arabic below was written fresh for the page and, since the T6 read (November 2026), uses the
app's own wording wherever the two show the same thing; back-translations in brackets.

| Key | Arabic | Back-translation |
| --- | --- | --- |
| sub | طاولة 12 · مشاوي لبنانية | Table 12 · Lebanese grills |
| lang / ccy | اللغة / العملة | Language / Currency |
| usd / lbp | دولار $ / ليرة ل.ل. | Dollar $ / Lira LL |
| filters | فلاتر غذائية | Dietary filters |
| openBill | افتح الفاتورة | Open the bill |
| splitTitle | كيف نقسّم الفاتورة؟ | How do we split the bill? |
| splitSub | لا أحد مضطر إلى الحساب | Nobody has to do the maths |
| even / mine / custom / all | بالتساوي / ما طلبتُه / مبلغ آخر / كلّها عليّ | Equally / What I ordered / Another amount / All of it on me |
| howMany | كم شخصاً على الطاولة؟ | How many people at the table? |
| fewer / more | شخص أقل / شخص أكثر | One person fewer / One person more |
| yourShare | حصّتك | Your share |
| rest | يبقى {مبلغ} لبقية الضيوف. والنقد المعلّق محجوز حتى يؤكّده الموظفون أو يلغوه. | {amount} remains for the other guests. Pending cash is held until staff confirm or cancel it. |
| cont | متابعة · {مبلغ} | Continue · {amount} |
| powered | بتقنية | Powered by (literally: with the technology of) |
| toPay | المبلغ المستحق · طاولة 12 | Amount due · Table 12 |
| billShare / tip | حصّتك من الفاتورة / الإكرامية | Your share of the bill / The tip |
| tipFor | إكرامية لـأبو كريم؟ | A tip for Abou Karim? |
| noTip | بدون | None |
| whishDesc | يُفتح والمبلغ معبّأ مسبقاً | Opens with the amount already filled in |
| card / cash | بطاقة / الدفع نقداً | Card / Paying cash |
| cashDesc | يؤكّده الموظفون بعد الاستلام | Staff confirm it after collection |
| cashMark | نقد | Cash |
| pay | ادفع {مبلغ} | Pay {amount} |
| thanks | شكراً. | Thank you. |
| paidVia / tableL | الدفع عبر / الطاولة | Payment via / Table |
| mailPh | واتساب (+رمز الدولة) أو البريد الإلكتروني | WhatsApp (+country code) or email |
| send | أرسلوا لي الإيصال | Send me the receipt |
| offers | أرسلوا لي عروض Mayda | Send me Mayda's offers |
| rateQ | كيف كانت سهرتك في Mayda؟ | How was your evening at Mayda? |
| paid | مدفوع {مبلغ} | Paid {amount} |
| railCard / railCash | بطاقة / نقداً | Card / Cash |
| reqCash | اطلب استلام المبلغ نقداً | Ask for the cash to be collected |
| paidCash | مدفوع {مبلغ} · نقداً | Paid {amount} · cash |
| cashOk | أكّد النادل استلام المبلغ نقداً. | The server confirmed collecting the cash. |
| onBill / offBill (labels) | {عدد} على الفاتورة / ليس على الفاتورة | {n} on the bill / not on the bill |

The page's own new words (the hints beside the phones on a wide screen, the caption controls on a phone):

| English | Arabic | Back-translation |
| --- | --- | --- |
| Try it: change the language or the currency, or tap a dish. | جرّب بنفسك: غيّر اللغة أو العملة، أو اضغط على طبق. | Try it yourself: change the language or the currency, or press a dish. |
| Try it: change how many of you there are. | جرّب بنفسك: غيّر عدد الأشخاص. | Try it yourself: change the number of people. |
| Try it: choose the tip, or how to pay. | جرّب بنفسك: اختر الإكرامية، أو طريقة الدفع. | Try it yourself: choose the tip, or the way to pay. |
| Pay with: Whish, Card, Cash | الدفع عبر: Whish، بطاقة، نقداً | Payment via: Whish, card, cash |
| Guests | الضيوف | The guests |
| USD / LBP | دولار / ليرة | Dollar / Lira |
| No tip | بلا | Without |

The receipt on the tray speaks the page's language: طاولة 12 · {n} ضيوف · 21:40 (ضيفان for two), المجموع, شكراً، إلى اللقاء (Table 12 ·
{n} guests · 21:40, Total, Thank you, goodbye), with short dish names (شيش طاووق، لحم بعجين، عرايس كفتة ...). The
founder approves all copy before launch.

The bill stretch's line (17 October): "On their phone from the moment they order." / «على هاتف الضيف منذ لحظة
الطلب.» (On the guest's phone from the moment of ordering.)

## The French page (fr/index.html)

The French homepage's phones speak the real app's French (`guest.html`'s own strings, with its narrow no-break space
before ? and %, its `10 %`, and dollars and lira written as the app writes them: `$41.94`, `LL 3,412,635`). The
venue's own line stays as the venue wrote it (Table 12 · Lebanese Grill), as in the app. The page's own words beside
the phones, and the receipt on the tray, are French:

| English | French |
| --- | --- |
| Try it: change the language or the currency, or tap a dish. | Essayez : changez la langue ou la devise, ou touchez un plat. |
| Try it: change how many of you there are. | Essayez : changez le nombre de convives. |
| Try it: choose the tip, or how to pay. | Essayez : choisissez le pourboire, ou le moyen de paiement. |
| Try the menu / Language / Currency | Essayer le menu / Langue / Devise |
| Guests / One fewer / One more | Convives / Un de moins / Un de plus |
| No tip / Tip / Pay with: Whish, Card, Cash | Aucun / Pourboire / Payer par : Whish, Carte, Espèces |
| The guest app: the menu, the split, the payment | L’appli client : le menu, le partage, le paiement |
| Table 12 · {n} guests · 21:40 / Total / Shukran, see you soon | Table 12 · {n} convives · 21:40 / Total / Shukran, à bientôt |

The receipt's French short names: Chiche taouk, Lahm bi ajine, Arayes kafta, Fattouche, Houmous, Batata kezbara, Warak
enab, Moutabal, Mouhammara, Ayran, Citronnade, Sodas (Taboulé, Salade raheb, Houmous viande when added).
