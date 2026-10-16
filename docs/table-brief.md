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
