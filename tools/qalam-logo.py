#!/usr/bin/env python3
"""The Qalam logo proposal (brand/qalam/): the 3 of 3layna drawn as what it is, the Arabic letter ع.

Lebanon types ع as 3 because a 3 is an ع turned around. The mark is the isolated ع of Noto Naskh
Arabic (weight 700), mirrored, so a Latin reader sees a 3 and an Arabic reader sees an ع. The name
follows in EB Garamond (weight 580): both scripts are pen-made, so the reed pen's ع and the broad
nib's lowercase share one logic of thick and thin. Only the 3/ع is red. In علينا the red is the
same letter at the other end of the word.

The SVG files are outlines: nothing here needs a font to display. Both typefaces are under the SIL
Open Font License; the logo is artwork drawn from them, which the licence allows.

Run: python3 tools/qalam-logo.py   (needs: pip install fonttools uharfbuzz)
The two fonts are downloaded from github.com/google/fonts on first run and checked against the
SHA-256 below; set AALAYNA_FONT_CACHE to keep them somewhere other than ~/.cache/aalayna-fonts.
"""
import hashlib
import os
import urllib.request

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'brand', 'qalam')
CACHE = os.environ.get('AALAYNA_FONT_CACHE', os.path.expanduser('~/.cache/aalayna-fonts'))
FONTS = {
    'NotoNaskhArabic[wght].ttf': ('ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf',
                                  '67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f'),
    'EBGaramond[wght].ttf': ('ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf',
                             'ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027'),
}

INK, RED, PAPER = '#211B16', '#B3363F', '#FAF6F1'   # the site's ink, text red and cream
RED_ON_DARK, PETROL, PEACH = '#C9414B', '#173E43', '#F6C39F'

# The lockup, in units of the Latin type size (1 = one em of EB Garamond)
MARK_WGHT = 700      # Noto Naskh Arabic weight of the ع/3
NAME_WGHT = 580      # EB Garamond weight of "layna"
X_HEIGHT = 0.407     # EB Garamond x-height
MARK_TOP = 1.18      # the 3's head rises to 1.18 x-heights, like an old-style figure set a little large
GAP = 0.05           # 3 to l
TRACK = -0.006       # letter-spacing of "layna"
ARABIC = 1.15        # علينا size relative to the Latin size
ARABIC_WGHT = 650    # Noto Naskh Arabic weight of علينا: its stems then match the Latin ones
ICON = 0.64          # the mark's height in the square icon
EM = 100             # SVG units per em of the Latin type


def fetch(name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        url = 'https://raw.githubusercontent.com/google/fonts/main/' + FONTS[name][0]
        with urllib.request.urlopen(url) as r, open(path + '.part', 'wb') as f:
            f.write(r.read())
        os.replace(path + '.part', path)
    digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if digest != FONTS[name][1]:
        raise SystemExit(f'{name}: SHA-256 {digest} is not the checked font; the outlines would change')
    return path


class Font:
    def __init__(self, name, **axes):
        path = fetch(name)
        self.hb = hb.Font(hb.Face(hb.Blob.from_file_path(path)))
        self.hb.set_variations(axes)
        self.tt = instancer.instantiateVariableFont(TTFont(path), axes)
        self.glyphs, self.upm, self.order = self.tt.getGlyphSet(), self.tt['head'].unitsPerEm, self.tt.getGlyphOrder()

    def shape(self, s):
        buf = hb.Buffer()
        buf.add_str(s)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {})
        x, out = 0, []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((self.order[info.codepoint], x + pos.x_offset, pos.y_offset))
            x += pos.x_advance
        return out, x

    def bounds(self, glyph):
        pen = BoundsPen(self.glyphs)
        self.glyphs[glyph].draw(pen)
        return pen.bounds


class Drawing:
    """paths in SVG space (y down) with their running bounds"""
    def __init__(self):
        self.paths, self.box = [], [float('inf'), float('inf'), float('-inf'), float('-inf')]

    def glyph(self, font, name, scale, x, y, fill, mirror=False):
        m = (-scale if mirror else scale, 0, 0, -scale, x, y)
        pen = SVGPathPen(font.glyphs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
        font.glyphs[name].draw(TransformPen(pen, m))
        self.paths.append((fill, pen.getCommands()))
        bp = BoundsPen(font.glyphs)
        font.glyphs[name].draw(TransformPen(bp, m))
        x0, y0, x1, y1 = bp.bounds
        b = self.box
        self.box = [min(b[0], x0, x1), min(b[1], y0, y1), max(b[2], x0, x1), max(b[3], y0, y1)]

    def svg(self, label, pad=0, square=None, ground=None):
        x0, y0, x1, y1 = self.box
        if square:   # an icon: the drawing centred in a square of side `square`, optically raised by pad
            w, h = x1 - x0, y1 - y0
            ox, oy = (square - w) / 2 - x0, (square - h) / 2 - y0 - pad
            vb, size = f'0 0 {square} {square}', square
        else:
            ox, oy = pad - x0, pad - y0
            vb = f'0 0 {fmt(x1 - x0 + 2 * pad)} {fmt(y1 - y0 + 2 * pad)}'
        body = ''.join(f'<path fill="{fill}" d="{d}"/>' for fill, d in self.merged())
        if ox or oy:
            body = f'<g transform="translate({fmt(ox)} {fmt(oy)})">{body}</g>'
        if ground:
            body = f'<rect width="{size}" height="{size}" fill="{ground}"/>' + body
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{label}">'
                f'<title>{label}</title>{body}</svg>\n')

    def merged(self):   # one path per colour, in drawing order of first use
        out = {}
        for fill, d in self.paths:
            out.setdefault(fill, []).append(d)
        return [(f, ''.join(ds)) for f, ds in out.items()]


def fmt(v):
    return ('%.2f' % v).rstrip('0').rstrip('.')


naskh = Font('NotoNaskhArabic[wght].ttf', wght=MARK_WGHT)
naskh_text = Font('NotoNaskhArabic[wght].ttf', wght=ARABIC_WGHT)
garamond = Font('EBGaramond[wght].ttf', wght=NAME_WGHT)


def mark(dr, x, base, fill, top=MARK_TOP * X_HEIGHT * EM):
    """the ع/3, its left edge at x and its head `top` above the baseline; returns its width"""
    xmin, ymin, xmax, ymax = naskh.bounds('uni0639')
    s = top / ymax
    dr.glyph(naskh, 'uni0639', s, x + xmax * s, base, fill, mirror=True)
    return (xmax - xmin) * s


def latin(dr, x, base, ink, red):
    x += mark(dr, x, base, red) + GAP * EM
    s = EM / garamond.upm
    glyphs, _ = garamond.shape('layna')
    for i, (name, gx, gy) in enumerate(glyphs):
        dr.glyph(garamond, name, s, x + (gx + i * TRACK * garamond.upm) * s, base - gy * s, ink)


def arabic(dr, x, base, ink, red):
    """علينا, its left end at x; the ع (its first letter, at the right) in red"""
    s = ARABIC * EM / naskh_text.upm
    glyphs, _ = naskh_text.shape('علينا')
    for name, gx, gy in glyphs:
        dr.glyph(naskh_text, name, s, x + gx * s, base - gy * s, red if name.startswith('uni0639') else ink)


def build():
    files = {}
    grounds = {'': (INK, RED), '-cream': (PAPER, RED_ON_DARK), '-petrol': (PAPER, PEACH), '-ink': (INK, INK)}
    for suffix, (ink, red) in grounds.items():
        d = Drawing(); latin(d, 0, 0, ink, red)
        files[f'lockup{suffix}.svg'] = d.svg('3layna')
        d = Drawing(); arabic(d, 0, 0, ink, red)
        files[f'arabic{suffix}.svg'] = d.svg('علينا')
        # both names on one baseline, each starting at its outer edge with the red letter
        d = Drawing(); latin(d, 0, 0, ink, red)
        arabic(d, d.box[2] + 0.62 * EM, 0, ink, red)
        files[f'bilingual{suffix}.svg'] = d.svg('3layna · علينا')
    d = Drawing(); mark(d, 0, 0, RED)
    files['mark.svg'] = d.svg('3layna')
    xmin, ymin, xmax, ymax = naskh.bounds('uni0639')
    for suffix, (ground, red) in {'': (PAPER, RED), '-ink': (INK, RED_ON_DARK)}.items():
        # the mark fills ICON of the square's height; its heavy head sits a little above centre
        d = Drawing(); mark(d, 0, 0, red, top=ICON * 100 * ymax / (ymax - ymin))
        files[f'icon{suffix}.svg'] = d.svg('3layna', pad=2, square=100, ground=ground)
    os.makedirs(OUT, exist_ok=True)
    for name, text in files.items():
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            f.write(text)
    return files


if __name__ == '__main__':
    for name in sorted(build()):
        print('brand/qalam/' + name)
