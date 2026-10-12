# Homepage redesign notes (October 2026)

The brief: "think of how the ultimate website should look like. The content is already there. Really think outside
the box of what we have here. Take inspiration from some extremely well designed websites."

The reader is a restaurant owner or manager in Beirut, often on a phone, often skeptical of software. The page has to
feel premium, calm and trustworthy, and specific to Lebanon, never generic SaaS.

## What I looked at

Each site was opened on 12 October 2026 in a headless browser at 1440 and 390 px, with its type sizes, weights and
page length measured from the page itself.

| Site | What makes it feel premium | What I took |
| --- | --- | --- |
| Linear (linear.app) | A 64 px headline, left-aligned, one line of subhead, then the product itself as the hero image, cut by the fold so it pulls you down. Feature sections split a 48 px title on the left from a 24 px lead on the right. Proof is a few large quote cards and one sentence ("over 40,000 product teams"). The closing line is the largest type on the page (72 px). Weight 510, tight tracking, one accent. | The closing statement as the page's largest type. The hero's split between headline and lead. The product as the picture. |
| Stripe (stripe.com) | Headline and subhead set as one two-tone paragraph, ink then slate, in a light weight. A live counter as the eyebrow. Hairline guides frame the column. Four figures in a ruled row, light 32 px numbers over two-line captions. | Two-tone headings (the second sentence softer). Figures between rules, like the lines of a statement. |
| Apple Pay (apple.com/apple-pay) | A small lockup over an 80 px two-sentence headline ("Your cards. Secured on iPhone."), one button, the phone as the hero. Section labels in sentence case over 80 px titles whose second line is in the accent colour. Phones cut by the section's edge. A sticky product bar that carries the button. A pause control on the autoplaying animation. | Phones cut by their card. The sticky bar with the ask (the header already does it). The play and pause discipline of the film. |
| Vercel (vercel.com) | The brand mark itself as the hero object, between the headline and a three-line index of the page. Very tight tracking. Each product mock paired with one sentence of customer proof. | The mark as an object, kept for the close. |
| Family (family.co) | A bento of six cards, each a cropped detail of real UI (a stepper, a status line), titled with one word. "Send, receive, swap. All in one place." | Crop the product to the detail that matters, at a size you can read: the phone layout of the four steps. |
| Mercury (mercury.com) | A calm cinematic film behind a centred headline. A ruled feature list on the left that drives the product panel on the right. Money set with small raised cents. Footnoted claims. | The list that drives the panel: the stage, where the step in view drives the phone. |
| Ramp (ramp.com) | "Time is money. Save both." in a regular 64 px weight. A mono eyebrow with a live counter. A proof section called "We've got the receipts." | The receipt as an object: for a product about the bill, the price is set like one. |
| Resend (resend.com) | A 96 px headline beside one object (a cube of tiles, close to a QR grid), and a closing line that mirrors the hero. | Bookends: the page opens on the film, whose poster is the logo, and closes on the mark. |
| Raycast (raycast.com) | One centred headline, one button, and one line of requirements under it in small type. | Confirmed the note under the hero's buttons ("Two months free from go-live.") as the right pattern. |
| Cal.com (cal.com) | The real booking widget in the hero. A hairline frame with registration marks. Steps as three cards with mono 01, 02, 03 tags and a piece of UI running off each card. | UI running off a card's edge; the 01 · Label tags we already use. |
| Dia (diabrowser.com) | The name as a giant wordmark behind the product window, a small headline above, one button with a line of fine print. | The name large, once, as a set piece: the mark beside the closing line. |
| Basecamp pricing (basecamp.com/pricing) | The pricing philosophy as the headline, in plain words, over a single price. | Confirmation that our plain, honest price and FAQ answers are the strength; no plan grid. |

### Restaurant and payments sites

- **Zettle (PayPal Point of Sale)**: a vague headline ("Made for More"), stock lifestyle photography, pill buttons.
  What owners expect is there too: the price stated next to the product ("From £29").
- **Lightspeed Restaurant**: the standard template: a tracked capitals eyebrow, a two-line headline, a paragraph, two
  red pill buttons, a smiling chef composited with an award badge, then logo walls. What owners expect: a human to
  talk to (a phone number, "Talk to an expert"), pricing, and answers about switching POS.
- **sunday, Toast, Dojo**: all three refused the automated browser (403 and Cloudflare challenges). I did not work
  around that, so they are not in these notes.

To avoid: stock photographs of people who are not the reader; vague claims; award badges, logo walls and testimonials
we cannot honestly have yet; pill buttons; and the eyebrow, headline, paragraph, two buttons and photo template, which
is roughly what our old hero was. To keep: the price up front, a human on WhatsApp, the product shown plainly, and
straight answers about POS, cash and money.

## The concept: one table, one evening

The film already tells the story of one table: Table 12, four friends, a $152.50 bill, $41.94 paid with Whish Money.
The page now follows the same table, so the site and the film rhyme.

1. **The hero is a cinema screen.** The headline is set large (67 px): "The bill. The split. 3LAYNA." The lead, the
   two asks and the note sit at its foot on the right. Under them the film runs the full width of the column, with
   what Aalayna is in four lines under it like a caption strip. The headline and the film paint first and are never
   animated; only the copy under the headline rises in, 60 ms apart.
2. **The four steps are one phone.** On a computer the steps scroll by on the left and one phone stays in view on
   the right, changing screen (a 250 ms crossfade) as each step reaches the middle of the window, with the waiting
   steps dimmed. On a phone there is nothing to swipe: each step shows its own screen at close to its real size, cut
   by its card where what matters is (the menu and the split from the top, the payment and the review from the foot),
   so "YOUR SHARE $38.13 ≈ LL 3,412,635" and the $50 note are legible on the reader's own phone. On tablets, and
   without JavaScript, each step is a row: its text beside its screen.
3. **The restaurant's side is a ledger.** On the petrol band the four figures are set large and ruled like the lines
   of a bill: the figure and the line that says what it counts on the left, what it means on the right, on one
   baseline. The icons went; the figures are the picture.
4. **The offer is a bill.** The pilot is a line of four stops, with go-live and the two free months after it drawn in
   red. Beside it the price is a receipt on petrol: dashed lines between the items and a torn foot.
5. **The questions** sit in two columns, the heading staying beside them on a computer; every row is at least 64 px.
6. **The welcome closes it.** "Ahla w sahla. Tell us about your restaurant." in the page's largest type on petrol,
   with the mark beside it (the Kufi mark on the Arabic page), as the film closes on the logo.

Every piece of content stays: the four steps, the four outcomes with their figures and source lines, the pilot
timeline, the price card, the six answers, the contact block, the footer, the language menu, and every Book a demo and
WhatsApp link with its data-track and data-placement. The copy is unchanged; a heading in two sentences now sets the
second one softer, as the film's titles do.

### Why this one

An owner decides from three things: what my guests will do, what I get, and whether I can trust the people behind
it. The guest's screens are the most convincing thing we have, so the page makes them legible on a phone and central
on a computer. The film is the strongest asset, so it gets the widest frame. The figures are the argument, so they are
set like a statement. The product is about the bill, so the price is one. And the decision is made by talking, so the
page ends on a welcome and two ways to talk.

## Decisions I rejected

- **The film full-bleed behind the headline** (Mercury): the film carries its own titles, which would fight ours, and
  its poster is the logo on cream.
- **A dark hero to blend with the film's dark scenes**: the poster, and what reduced-motion readers see, is the cream
  logo frame; a dark band would frame it as a hole.
- **Keeping the carousel**: on a phone three of the four steps sat behind a swipe. The crops show all four with no
  gesture.
- **Scroll-jacking or pinning the page**: the stage is a sticky column inside ordinary scrolling; nothing takes over
  the wheel, and the keyboard, links and the browser's find all work as usual.
- **Animating the answers' height** (interpolate-size, from the motion spec): the brief keeps motion to transform and
  opacity, so an answer opens at once and its text rises in.
- **Dashboard screenshots for the restaurant's side**: the dashboard and older guest shots in images/ are from the
  green, rounded design and would contradict the brand. An HTML mock of the live floor would be new copy in three
  languages; the ledger tells the restaurant's side with the content we have.
- **Live counters and testimonials** (Stripe, Ramp): we are in pilots; a counter or quotes would be invented.
- **A QR code to the guest demo on computers** ("scan to try it as a guest"): strong, but it sends anyone into the
  live demo flow. For the founder to decide.
- **A giant wordmark in the hero** (Dia): the headline already ends on the name in the Block; the mark appears once,
  at the close.
- **A light display weight** (Stripe): the brand sets headings semibold, and the site loads only the weights it uses.

## For whoever edits the page next

- The stage's size lives in two places that must agree: website.css `@media(min-width:1024px) and (min-height:600px)`
  and `stage` in site.js. A test checks both.
- The phone crops assume the screenshots stay 390 x 816 at 2x (2.09 times as tall as wide).
- The mark at the close is a CSS background of brand/svg/3layna/block-petrol.svg (brand/svg/kufi-petrol.svg on the
  Arabic page), so `node tools/brand.js svg` keeps it current.
- The homepage bands share one measure of air, the --band token; `.section` keeps its old padding for numbers.html.
- Full-page screenshots show the stage's phone beside the first step only (a sticky element is drawn where it starts);
  look at the page while scrolling, or at the frames in shots/redesign/stage/ (shots/ is not committed).
