# The table: brief for the next homepage (16 October 2026)

Sixteen answers from the founder, taken in one sitting, after the "one table, one evening" redesign (PR #48) went live.
This brief is the source of truth for the prototype versions and, later, for the page that replaces index.html.

## The idea

The website is a dining table. A bold typographic poster opens the page; past it, the reader is looking down at an
illustrated table, and scrolling moves them across the evening: the QR card, the menu, the plates, the bill, the split
on a phone, the payment, the review card. Each thing on the table is one aspect of the product.

## Decisions

| Question | Decision |
| --- | --- |
| First five seconds | **Bold and direct.** Big type, big claims, short sentences. What it does and what it costs, impossible to miss. |
| Hero object | **The words alone.** A full-screen typographic poster, almost no imagery above the fold. |
| Then the table | **A real table, top-down**, illustrated: plates, glasses, the QR card, a phone. The poster comes first; the table starts when you scroll past it. |
| Illustration | **Flat, square, graphic**: bold flat shapes in the logo's square language, few colours, hard edges. SVG. |
| Colour | **Richer and warmer** than today's cream and petrol. The logo's red stays the accent. Each version gets its own palette (below), so colour is judged alongside motion. |
| Type | **Aalayna Block, big**, as the display face for headlines, not only the name. It carries the full Latin alphabet, digits and French accents (122 glyphs). Instrument Sans for reading. Arabic headlines in Noto Kufi Arabic, the Kufi of the mark. |
| Copy | **Shorter and bolder.** Every line cut to its shortest true form: poster language. New copy, so the Arabic is written fresh, not carried over. The founder approves copy before launch. |
| Content | **Cut to the essentials:** the steps as objects on the table, the four figures (10 min, 22%, 83%, 50%, with their source lines), the price with the two free months, and the ask. The six FAQ answers and the pilot timeline move to book.html. |
| Main ask | **Book a demo**, everywhere it was before, with its data-track and data-placement attributes. WhatsApp stays as the secondary link. |
| The film | **Dropped from the home page.** It stays reachable (reel.html, the booking page). |
| Audience | **Phone and laptop equally.** The table must work in portrait and landscape from the start; neither is a fallback. |
| Languages | **English and Arabic together** in every version, RTL correct, before judging. French follows the winner. |
| Scroll | **Undecided: build versions to judge visually.** |
| Motion | Follows the site's motion rules: transform and opacity only, `--ease-out: cubic-bezier(.23,1,.32,1)`, `--ease-in-out: cubic-bezier(.77,0,.175,1)`, controls under 300 ms, hover gated to a fine pointer, reduced motion gets fades and a static table, nothing scroll-jacked, a plain vertical scroll always works. |

## The four versions

Each is a self-contained page beside the live site (`table-v1.html` to `table-v4.html`, with `ar/table-v1.html` and
so on), its own stylesheet and script, the same poster, copy, content and brand rules, differing only in how the
scroll moves across the table and in palette.

| Version | Scroll | Palette |
| --- | --- | --- |
| V1 | **Down the length of the table.** Normal vertical scroll; the table runs top to bottom and the evening unfolds from one end to the other. | **Terracotta and olive:** clay reds, olive green, sand cloth, ink text. Daytime. |
| V2 | **Objects swap on a fixed table.** The table stays in view; as you scroll, what is on it changes: the menu appears, plates empty, the bill arrives, the phone splits it. | **Night service:** deep aubergine or ink-blue cloth, candle yellows, peach plates. Evening. |
| V3 | **Pan sideways along it.** Vertical scroll drives a horizontal pan along a long table, with a careful portrait fallback. | **Sun and sea:** sand, sea blue, white plates, lemon yellow. Bright Beirut summer. |
| V4 | **Zoom in and out.** Start wide on the whole table; scrolling zooms into the QR card, the phone, the receipt, then pulls back out at the end. | **Night service** again (close-ups read best on a dark cloth); the founder may reassign. |

## Hard rules carried over from the live site

- Head metadata, hreflang, analytics and config scripts as on index.html. Six type-size tokens only, every font-size a
  `var(--fs-*)`. `--brand` red as a fill under white text only; `--brand-text` for red text. Square corners except the
  phone. No em dashes. Logo SVGs byte for byte as tools/brand.js writes them. 44 px targets, visible focus, skip link,
  semantic headings, alt text. No JavaScript needed to read the page. Works from 320 px up.
- Tests in tests/website.test.cjs and tests/brand.test.cjs cover index.html, fr/, ar/, book.html and numbers.html.
  Prototypes are new files, so they do not break the suite, but they follow the same rules so the winner can replace
  index.html without rework.

## How the versions are judged

Each version ships with full-page screenshots at 1440 and 390 px in English and Arabic, plus scroll frames at four
points across the table, in `shots/table/v1/` to `v4/`. The founder judges on screen, then picks one, or a mix.

## Amendments after seeing V1 (16 October 2026, afternoon)

The founder liked V1's direction and asked for two changes, which apply to every version and supersede the type and
motion rows above.

1. **Softer type.** Headlines (the poster lines, the step headings, the close) are set in Instrument Sans, semibold,
   letter-spacing -0.02em, as the live site does, at the same size tokens. Aalayna Block is kept only for the name
   (the 3LAYNA in the poster and the logo) and for lettering that belongs to the drawn objects: the receipt, the phone
   screens and their prices. The four figures may stay in Block where they read as part of the drawings. On the
   Arabic page the Kufi face is only for the name.
2. **The travel between points is the heart of the page.** Movement from one point on the table to the next must be
   the best thing on it: choreographed and scroll-linked (proportional to scroll, reversible, interruptible, never
   time-based while the reader is scrolling). Objects that persist from one stretch to the next (the phone, the bill,
   the card, the plates) travel or transform from where they were to where they will be, rather than one copy fading
   out and another fading in. Arriving objects settle with the ease-out curve and a 40 to 80 ms stagger; the step
   label and its line swap with a small vertical slide and crossfade; something continuous ties the stretches
   together (a runner or thread drawing itself ahead of the reader, a scan line, a progress mark). Transform and
   opacity only, on the compositor; reduced motion gets crossfades only. Each version adds scroll frames at 25, 50 and
   75 percent of three transitions, at 1440 and 390 px, so the travel can be judged from stills.

## Amendments after seeing V1 live (16 October 2026, evening)

3. **The first screen sells the outcome, not the product.** The poster's headline is the restaurant's benefit in plain
   words, drawn from the four figures the page carries (tables turn faster, bigger tips, more reviews, regulars you
   know) and from the fact that nobody waits for the bill. "Scan. Split. Settle." and the QR explanation move down
   to a secondary line or the first stop on the table. The name, the price with the two free months, and the two
   asks stay on the first screen.
4. **Hand-offs are long enough to be seen.** Measured on V1 live, most phone screen changes occupied 63 to 94 px of
   scroll, less than one wheel notch, as linear opacity swaps. Every hand-off now spans at least 30vh of scroll,
   ideally 35 to 60vh. Screen changes are app-like (the outgoing screen slides up and fades over the first 60%, the
   incoming slides in from below and settles with the ease-out curve over 30 to 100%, overlapping in the middle);
   travelling objects get anticipation (a small lift with a shadow) and a settle; arrivals stagger. Travel frames are
   shot at 0, 25, 50, 75 and 100% so the middle frames show two states coexisting.
5. **V1: no riding phone, and a less pixelated drawing style.** The founder saw V1 live: the phone that stays pinned
   in the middle while the table scrolls under it adds no real value and is removed. The phone becomes one object
   among the others on the table. He is also unsure about the pixelated look of the drawings (every object built on
   the logo's 5 x 5 module), so V1 is iterated in two drawing styles for him to compare: (A) clean flat vector, with
   true circles for plates and glasses and real curves, still flat and graphic; (B) soft paper cut-out, layered flat
   shapes with soft offset shadows and gentler, more organic food shapes. Both keep the terracotta and olive palette,
   the top-down table, the poster first, and amendments 1 to 4. Implementation agents run at medium effort from here.
6. **V1 all-out version, style C (16 October, late).** The founder likes the V1 direction and wants a third version
   that goes all out, built from style B (the refined paper cut-out, no riding phone). Its organising rule: at every
   point of the page, think hard about what the reader must see and make the point come through first, with no
   distractions. One point per stretch, one object that carries it, everything else recedes. Motion exists only where
   it serves the point. Elegant and premium throughout. A storyboard of the points is written before anything is
   drawn (`docs/table-v1c-storyboard.md`).
7. **After seeing style B live (16 October, night).** "The animations are still very much lacking", and the runner
   that unfolds ahead of the reader is "too distracting". The cloth is static from here on: no moving runner, thread
   or pattern. Motion is driven from the scroll position in JavaScript (requestAnimationFrame with light smoothing)
   so it is identical in Chromium and WebKit, with CSS scroll-driven animation only as a progressive layer. Each hero
   object gets a multi-stage choreography (anticipation, eased travel with a slight arc or rotation, ease-out landing,
   follow-through) over 45 to 60vh, and the story is one continuous chain of transformations (receipt to bill to
   split to payment to paid to review), never a cut. Supporting objects arrive quietly along believable paths.
8. **Photographic, not illustrated (16 October, late night).** Style C live: "this doesn't look premium at all", the
   tile grid behind the table is not understood, the squares are uneven, and the table's frame shows when the reader
   scrolls off it. Every illustrated language (pixel module, flat vector, paper cut-out) is rejected. The founder
   chose real objects, photographic: photographed or rendered tableware on real linen, a ceramic plate, a brass
   tray, a paper receipt, an actual phone showing the real app, soft natural light and real shadows. No grid, no
   frame, no drawn cloth, no chairs. The one-point-per-stretch storyboard and the scroll-driven chain of objects
   from style C are kept. Assets come from Unsplash and Pexels at no cost (the image service has 0.4 credits and
   Blender is not running); generated or rendered assets can replace them later if the founder tops up or starts
   Blender.
9. **Phones get a pinned stage (16 October, night).** Style D live on a phone: 13 screens, most of them empty linen,
   each stretch a full-screen caption card then a full-screen object, hand-offs playing off-screen, the photographed
   phone as wide as the reader's own. Under 768 px the table becomes a sticky stage in the lower 60% of the viewport
   with the caption for the current stretch on the cream above it, the chain playing in place inside the stage, the
   hero at about 55% of the stage width, every screen showing a point and its proof together, and the whole table
   about 9 to 11 viewport heights. Reduced motion and no JavaScript get compact stacked blocks. Desktop keeps its
   layout with the half-cropped plates fixed and a quarter less empty linen between stretches.
10. **Version E: interactive (17 October).** Built on style D after its mobile rebuild. The phone screens stop being
    screenshots and become live HTML replicas of the real guest app (so the Arabic page gets Arabic screens). Three
    interactions, each inside a hold of the scroll chain, with defaults that tell the film's story for a reader who
    never taps: the menu (tap EN, FR, AR and USD, LBP; tap a dish to add or remove it, the bill updating, with the
    film's $152.50 set pre-selected), the split (a stepper, 2 to 6 guests, shares recalculating live and the chosen
    share carried into the payment), and the tip (5, 10 or 15 percent, the total carried into the Paid chip and the
    review card). No ordering flow, no drag, no gestures; big targets, keyboard reachable, scrolling never hijacked.
11. **Every hero is complete when it is centred (17 October).** Seen on style D: the review card reached the middle
    of the screen with three and a half of its five stars. A hero's arrival and all its reveal parts finish by the
    time its centre reaches 50% of the viewport height (the reveal runs from about 88% to 50%); the hold, with
    nothing on that hero moving, runs from 50% to about 32%; the next hand-off starts only after the hold. Measured
    per hero at 1440x900, 390x844 and an iPhone 14 viewport.
12. **Version E lives (17 October).** Published at table-v1e.html with five passes: live app screens with menu, split,
    tip and payment-method interactions carried along the chain; every control answering a touch on the phone
    (the phone-stage timeline measured in the stage's own height, not innerHeight, which iOS changes with its
    toolbars); the animation loop restarting itself after a dropped frame (the back/forward cache froze it and left
    every control dead); no highlight on ordered dishes, no item count on the bill bar, no price on the poster; the
    bill "on their phone from the moment they order"; and a soft settle to the holds, on by default with a mouse or
    trackpad, off on phones, `?settle=0` or `?settle=1` to override.
13. **Version E is the homepage (17 October).** "Let's make this the main website now." index.html, fr/index.html and
    ar/index.html are version E (home.css, home.js, tools/home-screens.js; the notes are docs/home-*.md); the French
    page follows the winner, its phones in the real app's French. The head is the live site's again (indexable, real
    titles and descriptions led by the outcome line, OG and Twitter, hreflang for /, /fr/ and /ar/, the analytics
    scripts). The table's six booking placements keep the funnel's names (navigation, hero, how, outcomes, pricing,
    footer). The pilot timeline and the six questions are on book.html (#pilot, #faq), beside the calendar. The
    preview pages are retired; git history keeps them.
