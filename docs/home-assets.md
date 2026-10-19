# Table V1, style D: the photographs (16 October 2026)

Every photograph on `index.html` and `ar/index.html` (style D, the photographic version). All are free for
commercial use without attribution under the license named; the source page of each was checked for that license on
16 October 2026 (no Unsplash+ or other paid image is used, and no image was generated). Credit is recorded here all
the same.

| File in `images/table/` | What it shows | Source | Photographer | License |
| --- | --- | --- | --- | --- |
| `linen.webp` | The tablecloth: natural flax linen, flat, seen from above | https://www.pexels.com/photo/close-up-of-a-linen-texture-7794365/ | Monstera Production | Pexels License |
| `phone.webp`, `phone.png` | A titanium iPhone from above, its screen cut out | https://unsplash.com/photos/smartphone-with-blank-white-screen-fNsML7R50Ec | Mockupnest.com (@mockupnest) | Unsplash License |
| `plate.webp`, `plate.png` | A white-glazed plate with a wooden rim, from above | https://www.pexels.com/photo/a-white-plate-on-the-red-surface-8058299/ | Eva Bronzini | Pexels License |
| `tray.webp`, `tray.png` | A round brushed-brass tray, from above | https://www.pexels.com/photo/stainless-tweezers-on-brown-plate-5128321/ | Nataliya Vaitkevich | Pexels License |
| `paper.webp`, `receipt.webp` | Cotton card texture (the cards), and the same flattened (receipt paper) | https://www.pexels.com/photo/close-up-shot-of-blank-cards-8058801/ | Eva Bronzini | Pexels License |

The phones' screens are the real app (`images/guest-menu-plain.webp`, `guest-split.webp`, `guest-pay.webp`,
`guest-paid.webp`, already in the repo). `guest-pay` is used rather than `guest-pay-cash` because its button reads
"Pay $41.94", the button the chain presses; `guest-paid` ("Shukran.") is what the screen becomes once it is pressed.

Looked at and not used: a used plate with cutlery (Pexels 6448483; the knife runs off the plate onto a grey ground of
the same tone, so no clean cut-out), an engraved brass tray (Pexels 6475298; cropped by its frame), glasses and
carafes (all in hard sun with long caustic shadows, a different light), a bank card and a banknote (cut, as in
style C: the screen already says Whish, card or cash).

## How they were made

Downloaded at full size into a scratch folder outside the repo, processed with Python (Pillow, NumPy, SciPy), not
retouched by hand:

- **Linen:** lighting flattened (the image minus its own wide blur), moved to a warm flax (226, 217, 202) with 62%
  of its contrast, reduced to 1000 x 640 and made to tile by cross-fading an 80 px band at two edges. Shown at
  31.25rem wide, with a second, larger pass of the same weave at 28% to break the repeat.
- **Phone:** cropped to the body and masked geometrically (the body's rounded rectangle, radius measured on the
  photograph, minus the screen's, plus the Dynamic Island), anti-aliased at 4x. The screen sits under it in CSS at
  the measured inset (4.007%, 1.929%, 91.985% x 96.142%, corners 13.6% / 6.25%).
- **Plate:** the glaze found by colour, its ellipse fitted from its moments and grown by the rim's width, cut with a
  3 px feathered edge; the glaze white-balanced to a warm white (it read mint on the red ground).
- **Tray:** cut by its ellipse (brass against a white ground); the three tweezers lying on it replaced by the clean
  patch mirrored across the tray's middle, its light matched by a low-frequency correction, the edges feathered.
- **Paper:** the inside of one card cropped, its lighting flattened, white-balanced to warm white; the receipt paper
  is the same card with a third of the texture.

Every cast shadow is CSS (one light, from the top left, the same for every object), never part of a photograph, so a
shadow can stay behind and lengthen when its object is lifted.

## Weight

The page's images as loaded: linen 80 KB, phone 13 KB, plate 17 KB, tray 24 KB, paper 11 KB, receipt 2 KB, and the
four app screens 46 + 37 + 42 + 28 KB, about 300 KB in all. The 256-colour PNG fallbacks exist only for the three
cut-outs that need transparency, and load only where WebP is not supported.

## The table variants (?table=a, b, c; 19 October 2026)

No new file. The floor of variant B is a flat tone (`--ground:#F3EEE5`) with a gentle lightening toward the window's
edges, and the place settings of variant C are the plate above (`plate.webp`, also used as its own mask) with a napkin
cut from the paper texture (`paper.webp`), both washed 40% toward the linen. A photographic floor texture and overhead
cutlery cut-outs from Pexels or Unsplash were not downloaded for this round; if the founder picks B or C, they can be
sourced, recorded here and swapped in. Added weight: none (the two images are already on the page).
