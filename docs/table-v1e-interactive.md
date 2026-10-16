# Table V1, version E: the interactive version (17 October 2026)

Amendment 10 of `table-brief.md`, built on style D after its mobile rebuild (amendments 9 and 11 kept). The page is
`table-v1.html` and `ar/table-v1.html`, with `table-v1.css` and `table-v1.js`.

## What is live

The three phones on the table (the menu, the split, the payment, and the thank-you screen under the payment) are HTML
replicas of the real guest app as the film shows it: `guest.html?theme=balat` (bone paper, ink rules, square
corners, the cement tiles, Fraunces and Reem Kufi for names and figures, Instrument Sans and IBM Plex Sans Arabic for
the rest), with the real menu pack (`venues/mayda.json`) and the real sample check (twelve lines, $152.50). Each
screen is laid out in the app's own points (390 to the screen's width, one point is `--p`) and its type uses the
site's six size tokens in those points, as the lettering on the other objects does in theirs.

`tools/table-v1e-screens.js` writes each screen's default HTML into both pages (between `<!--g:name-->` markers),
from the data and words that `table-v1.js` exports under Node; run it after changing either. Without JavaScript the
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

One object, `S` in `table-v1.js` (`lang`, `ccy`, `q` the quantity of each dish, `people`, `tip`), and one function of
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

## The captions on the phone stage

During a hand-off the outgoing caption steps back (55%, a quarter of a rem up) and stays until the incoming caption
lands; the two cross over the last tenth of the hand-off, so the cream band is never empty.

## The app's Arabic, written for this page

English and French are the real app's strings. The Arabic below is written fresh for the page (the app has its own,
which these follow in spirit); back-translations in brackets.

| Key | Arabic | Back-translation |
| --- | --- | --- |
| sub | طاولة 12 · مشاوي لبنانية | Table 12 · Lebanese grills |
| lang / ccy | اللغة / العملة | Language / Currency |
| usd / lbp | دولار $ / ليرة ل.ل. | Dollar $ / Lira LL |
| filters | فلاتر الحمية | Diet filters |
| openBill | افتح الفاتورة | Open the bill |
| splitTitle | كيف نتقاسم الفاتورة؟ | How do we share the bill? |
| splitSub | ولا أحد يحسب شيئاً | And nobody works anything out |
| even / mine / custom / all | بالتساوي / ما طلبتُه / مبلغ آخر / كلّها عليّ | Equally / What I ordered / Another amount / All of it on me |
| howMany | كم شخصاً على الطاولة؟ | How many people at the table? |
| fewer / more | شخص أقل / شخص أكثر | One person fewer / One person more |
| yourShare | حصّتك | Your share |
| rest | يبقى {مبلغ} لبقية الضيوف. الدفع النقدي المعلّق يبقى محجوزاً إلى أن يؤكّده الفريق أو يلغيه. | {amount} remains for the other guests. A pending cash payment stays held until the team confirms or cancels it. |
| cont | متابعة · {مبلغ} | Continue · {amount} |
| powered | بتقنية | Powered by (literally: with the technology of) |
| toPay | المبلغ المستحق · طاولة 12 | Amount due · Table 12 |
| billShare / tip | حصّتك من الفاتورة / الإكرامية | Your share of the bill / The tip |
| tipFor | شي لـأبو كريم؟ | Something for Abou Karim? (Lebanese) |
| noTip | بلا إكرامية | No tip |
| whishDesc | يفتح والمبلغ معبّأ | Opens with the amount filled in |
| card / cash | بطاقة / الدفع نقداً | Card / Paying cash |
| cashDesc | يؤكّده الفريق عند الاستلام | The team confirms it on collection |
| cashMark | نقد | Cash |
| pay | ادفع {مبلغ} | Pay {amount} |
| thanks | شكراً. | Thank you. |
| paidVia / tableL | دُفعت عبر / الطاولة | Paid via / Table |
| mailPh | واتساب أو بريد إلكتروني | WhatsApp or email |
| send | أرسلوا الإيصال | Send the receipt |
| offers | أرسلوا لي عروض Mayda | Send me Mayda's offers |
| rateQ | كيف كانت السهرة في Mayda؟ | How was the evening at Mayda? |
| paid | مدفوع {مبلغ} | Paid {amount} |
| railCard / railCash | بطاقة / نقداً | Card / Cash |
| reqCash | اطلبوا استلام المبلغ نقداً | Ask for the cash to be collected |
| paidCash | مدفوع {مبلغ} · نقداً | Paid {amount} · cash |
| cashOk | استلم النادل المبلغ نقداً وأكّده. | The server collected the cash and confirmed it. |
| onBill / offBill (labels) | {عدد} على الفاتورة / ليس على الفاتورة | {n} on the bill / not on the bill |

The page's own new words (the hints beside the phones on a wide screen, the caption controls on a phone):

| English | Arabic | Back-translation |
| --- | --- | --- |
| Try it: change the language or the currency, or tap a dish. | جرّبها: غيّر اللغة أو العملة، أو اضغط على طبق. | Try it: change the language or the currency, or press a dish. |
| Try it: change how many of you there are. | جرّبها: غيّر عدد الأشخاص. | Try it: change the number of people. |
| Try it: choose the tip, or how to pay. | جرّبها: اختر الإكرامية، أو طريقة الدفع. | Try it: choose the tip, or the way to pay. |
| Pay with: Whish, Card, Cash | الدفع عبر: Whish، بطاقة، نقداً | Payment via: Whish, card, cash |
| Guests | الضيوف | The guests |
| USD / LBP | دولار / ليرة | Dollar / Lira |
| No tip | بلا | Without |

The receipt on the tray speaks the page's language: طاولة 12 · {n} ضيوف · 21:40 (ضيفان for two), المجموع, شكراً، إلى اللقاء (Table 12 ·
{n} guests · 21:40, Total, Thank you, goodbye), with short dish names (شيش طاووق، لحم بعجين، عرايس كفتة ...). The
founder approves all copy before launch.

The bill stretch's line (17 October): "On their phone from the moment they order." / «على هاتف الضيف منذ لحظة
الطلب.» (On the guest's phone from the moment of ordering.)
