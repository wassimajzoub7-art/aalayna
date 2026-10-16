# Table V1, style C: the motion storyboard (16 October 2026)

The progression from one step to the next is the core design problem of this version. This file sets out, for each
hand-off, what carries the reader across, where the eye goes, the beats, the curves, what holds still and the feeling
it should give. It goes with `table-v1c-storyboard.md` (the point of each stretch) and is built in `table-v1.js`.

## The engine and the conventions

- **Driven from the scroll, in JavaScript, the same in every browser.** Once per frame `table-v1.js` reads the
  scroll position; its own position follows with 0.16 of the gap per frame (wheel steps glide, a finger never feels
  a trail), and every track writes `transform` and `opacity` to its layer. Reversible and interruptible by
  construction: stop scrolling and everything stops where it is.
- **The stage never moves.** Cloth, runner and chairs are static (founder, 16 October: the unfolding runner was a
  distraction). The continuous thread is the chain of hero objects itself.
- **A hand-off** runs from the moment the hero of step N passes 42% down the window (its stretch has been read; on a
  phone it is 36%) to the moment the hero of step N+1 is 72% down: it lands while still in the lower part of the
  window, so its own reveal and a still moment both fit before the next hand-off. On a wide screen each stretch is
  about 0.92 of a window tall, which makes every hand-off 50 to 60vh of scroll; on a phone the minimum is 48vh.
- **Every travel has four beats** (the percentages are of the hand-off):
  - 0 to 14: **anticipation.** The object lifts 0.4 to 0.75rem, turns 1.6 to 3 degrees against the direction it is
    about to go and grows 3%; its shadow falls away (further down and right, fainter). Ease-out.
  - 14 to 82: **travel.** On an eased path (`cubic-bezier(.65,0,.35,1)`, an ease-in-out), with a sideways arc of 2 to
    3rem (a sine across the path, so it leaves and arrives straight), turning back through level to a slight
    opposite tilt, shrinking or growing to the size of its landing place.
  - 82 to 94: **landing.** Ease-out (`cubic-bezier(.23,1,.32,1)`) to rest: tilt to 0, scale to exact. No bounce.
  - 84 to 100: **follow-through.** The shadow catches up under it (ease-out, to 97); from 90 the landing place's own
    drawing fades in under it while the traveller fades out (93 to 100), so the object becomes the screen.
- **Reveals after a landing** (the shares, the payment's rows, the stars, the menu's dishes, the regulars, the price
  rows) come up one after another, 3.5 to 5.5vh apart, each over 9 to 10vh, from 0.5rem below with the ease-out.
  They are progress-like in spacing (an even, linear stagger) and eased in each step.
- **Setting down** (any object, hero or quiet, as its board arrives): from 2.5rem away (the side of the chair it
  belongs to; the bill's tray from 6rem off the table's edge), from scale .94, ease-out over 40% of its view range,
  staggered by 6% of the range; its cast shadow catches up a beat later.
- **Captions** arrive line by line (eyebrow, headline, line, figure, ask), 3.5vh apart, each over 22vh, from 1rem
  below, ease-out. On a wide screen they leave as their stretch goes (from 30% down the window, upwards, 20vh).
  A caption is readable, with nothing moving behind it, from the end of its hero's reveal to the next lift.
- **Figures** count up once, over 0.9 s, when 60% of the figure is in view (as on the live site).

## Poster to QR card

1. **Persists:** nothing; the hand-over is the name. The poster ends on "Scan. Split. Settle." and the head of the
   table peeking at the foot of the window; the QR card carries the same name in the Block, so the first object on
   the table repeats the first word of the poster.
2. **Eye:** 1440: from the headline (left) down to the asks, then right and down to the head chair in the middle,
   then the QR card on the runner with "Scan." to its left at the same height. 390: straight down the column.
3. **Beats:** 0 the poster at rest. 20 the cloth's edge rises in view (static). 40 the card is being set down, from
   2.5rem below, at scale .96. 60 the card at rest, its shadow catching up; "Scan." arriving line by line. 80 the
   red scan line passes down the code (22vh, linear: it is a progress). 100 still; the card and its caption read.
4. **Timing:** set down ease-out over 40% of the card's view range; scan linear from 66% to 44% of the window.
5. **Still:** the poster (its lines rose once on load and stopped), the table.
6. **Feeling:** an invitation. **Detail:** the single red line through the red finders.

## QR card to menu

1. **Persists:** the scan. The scan line ends at the foot of the code; the phone arrives directly under the card and
   its menu writes itself top to bottom, continuing the scan's downward line.
2. **Eye:** 1440: from the card down the runner to the phone (same axis), across to "Browse." on the right.
   390: down the column, card, note, phone.
3. **Beats:** 0 the card passes the middle. 20 the card's caption leaves upward (wide). 40 the phone is set down
   from 2.5rem below. 60 the menu's head, then the dishes, come up one by one. 80 the five dishes are in. 100 still.
4. **Timing:** the phone ease-out over 40% of its view range; dishes 3.5vh apart, 10vh each, starting when the phone
   is 78% down the window.
5. **Still:** the card, the place beside the phone.
6. **Feeling:** ease. **Detail:** the language and currency switches at the very top, the first row to appear.

## Menu to dinner, dinner to bill (the dinner stretch is cut: menu to bill)

The dinner stretch ("Sahtein.") had no point of its own (storyboard), so the menu hands straight to the bill.

1. **Persists:** the order. The five dishes on the menu are the first five lines of the receipt, in the same order,
   so the eye reads the same list twice: once as choice, once as the bill.
2. **Eye:** 1440: from the menu's dishes (centre) down to the receipt's lines (centre), across to "The bill." on the
   left. 390: down the column.
3. **Beats:** 0 the phone passes the middle. 20 its caption leaves. 40 the brass tray slides in from the table's
   edge (6rem off, on the waiter's side), the receipt on it. 60 the tray at rest; a used plate and the arak are set
   down, quiet. 80 "The bill." and "10 min" arrive; the figure counts up. 100 still.
4. **Timing:** the tray ease-out over 40% of its view range; the quiet things 6% and 12% after it.
5. **Still:** the phone.
6. **Feeling:** the end of a good dinner. **Detail:** the brass catching the light on its top left edge.

## Bill to split (the chain begins)

1. **Persists:** the receipt. It lifts off the tray, travels down the table and becomes the bill's head on the split
   phone: Table 12, $152.50.
2. **Eye:** 1440: on the receipt's total, then with the receipt down the runner into the top of the next phone, then
   right to "Split.". 390: the same, straight down; the receipt passes over the bill's note, which has been read.
3. **Beats:** 0 the receipt at rest on the tray, the bill's caption read. 14 lifted 0.75rem, turned 2.4 degrees, its
   shadow fallen away: it has been picked up. 20 to 60 it travels down, shrinking toward the phone's screen, arcing
   2.5rem to the side, the phone being set down below it. 80 it is over the screen, nearly level. 94 at rest. 100 the
   screen's head (Table 12, $152.50) has taken over; then ÷4 slides in and the four shares come up one by one.
4. **Timing:** span 52 to 56vh at 1440, 55 to 68vh at 390; travel ease-in-out, landing ease-out; ÷4 9vh, shares
   3.5vh apart, 9vh each.
5. **Still:** the tray (it stays, empty, its job done), the plate, the arak, the split phone once set down.
6. **Feeling:** relief: nobody had to wave for it. **Detail:** the receipt's shadow lengthening as it is lifted.

## Split to payment

1. **Persists:** your share. Three shares leave for the other guests; yours lifts, travels and becomes the payment's
   first line ("Your share, $38.13").
2. **Eye:** 1440: on the four equal shares, then on "You" as the others leave, then with it down to the next phone,
   then left to "Settle.". 390: straight down.
3. **Beats:** 0 four shares at rest. 3 to 55 the three others leave one after another (5% apart), sliding toward
   their own seats, turning, fading, ease-in-out. 14 yours lifts 0.4rem. 20 to 80 it travels down and grows to the
   payment's width. 94 at rest. 100 the payment's first line has taken over; then the tip, the three ways and Pay
   come up one by one.
4. **Timing:** 48 to 56vh at 1440, 48 to 62vh at 390; rows 3.5vh apart, 10vh each.
5. **Still:** the split phone itself, the coffee.
6. **Feeling:** satisfaction: everyone pays their own. **Detail:** each share leaves toward a different seat.

## Payment to review

1. **Persists:** the payment. Pay is pressed and becomes Paid; the Paid chip lifts off the phone and becomes the
   head of the review card.
2. **Eye:** 1440: on the red Pay button (the last thing to arrive on the screen), on the chip, with it down to the
   review card, then right to "Rate.". 390: straight down; the chip crosses the payment's note.
3. **Beats:** before 0 (12vh) the press: the button sinks 3% and turns into the olive chip with a tick. 0 Paid, at
   rest. 14 lifted 0.6rem, turned 3 degrees; under it the phone says "Thank you. Good night." 20 to 80 it travels
   down to the slot at the head of the card. 94 at rest. 100 it is the card's head; then the five stars arrive one by
   one, 5.5vh apart, each from scale .55.
4. **Timing:** press 12vh; travel 48 to 56vh at 1440, 48 to 71vh at 390; stars 32vh in all.
5. **Still:** the payment phone (its rows stay), the review card once set down.
6. **Feeling:** finality: it is settled. **Detail:** the tick, and the thanks left behind on the screen.

## Review to next time

1. **Persists:** the guest. The stars end the review; the regulars card arrives directly below with the guest who
   just reviewed at the top of who came back.
2. **Eye:** 1440: from the fifth star (right end of the row) down to the card's first row, then left to "Again.".
   390: down the column.
3. **Beats:** 0 five stars at rest. 20 the review caption leaves. 40 the regulars card is set down; the two quiet
   places either side, after it. 60 the three rows come up one by one. 80 "Again." and "50%" arrive. 100 still.
4. **Timing:** set down ease-out over 40% of the view range; rows 3.5vh apart, 10vh each.
5. **Still:** the review card.
6. **Feeling:** recognition. **Detail:** the visit counts in clay, the only colour in the rows.

## Next time to price

1. **Persists:** the paper. The regulars card hands to the restaurant's own bill: the same cut paper, a receipt
   again, now addressed to the owner.
2. **Eye:** 1440: from the card down to the receipt, right to "$150". 390: down the column.
3. **Beats:** 0 the regulars at rest. 20 caption leaves. 40 the receipt is set down. 60 its three rows come up one by
   one: Month 1 $0, Month 2 $0, Month 3 $150. 80 the price caption arrives. 100 still.
4. **Timing:** rows 3.5vh apart, 10vh each.
5. **Still:** the regulars card.
6. **Feeling:** fairness. **Detail:** the two olive $0 arriving before the $150.

## Price to close

1. **Persists:** the table. The foot of the table brings a folded card that says Reserved, then the ask.
2. **Eye:** 1440: from the receipt down to the Reserved card, then down to "Your table is ready." centred below.
   390: the same.
3. **Beats:** 0 the price at rest. 40 the Reserved card is set down from 2.5rem below. 80 the foot chair, the end of
   the cloth. 100 the ask, still.
4. **Timing:** set down ease-out over 40% of its view range.
5. **Still:** everything else. The page ends quiet.
6. **Feeling:** welcome. **Detail:** "Reserved" on the card, answered by "Your table is ready.".
