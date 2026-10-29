#!/usr/bin/env python3
"""Build the pinned OFL symbol subset. Development only: fonttools==4.60.2 brotli==1.2.0."""
import hashlib
import io
import json
import pathlib
import urllib.request
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'assets' / 'observer'
SOURCES = [
    ('NotoSansSymbols2', '2.008', 'c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d'),
    ('NotoSansSymbols', '2.003', '6eea9cb4cd39269ea9f95ba5c2735f80ae74049dfc9e1a7c932a5cfc8f0c3030'),
    ('NotoSansMath', '3.000', 'b127e84699212b6b2ef50aff58e0ebebeec04ffe6db1b9eb9e209c8c3d97b4aa'),
]
CODEPOINTS = sorted(set(range(0x2190, 0x2200)) | set(range(0x2300, 0x2400)) |
                    set(range(0x25A0, 0x2600)) | set(range(0x2700, 0x27C0)) |
                    {0x2605, 0x2606, 0x2610, 0x2611, 0x2612, 0x26A0, 0x26A1, 0x26D4, 0x29C9, 0x2B24})


def main():
    fonts, provenance = [], []
    for family, version, digest in SOURCES:
        url = f'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/{family}/unhinted/ttf/{family}-Regular.ttf'
        data = urllib.request.urlopen(url, timeout=60).read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f'Source digest mismatch: {family}')
        font = TTFont(io.BytesIO(data))
        fonts.append(font)
        provenance.append(dict(family=family, version=version, url=url, sha256=digest,
            copyright=sorted({record.toUnicode() for record in font['name'].names if record.nameID == 0})))
    builder = FontBuilder(1000, isTTF=True)
    glyphs = {'.notdef': TTGlyphPen(None).glyph()}
    cmap, metrics = {}, {'.notdef': (600, 0)}
    for cp in CODEPOINTS:
        for font in fonts:
            source_name = font.getBestCmap().get(cp)
            if not source_name:
                continue
            glyph_set = font.getGlyphSet()
            bounds = BoundsPen(glyph_set)
            glyph_set[source_name].draw(bounds)
            base_scale = 1000 / font['head'].unitsPerEm
            x_min, y_min, x_max, y_max = bounds.bounds or (0, 0, 0, 0)
            width = (x_max - x_min) * base_scale
            scale = base_scale * min(1, 600 / width) if width else base_scale
            # Uniform scale, preserving the original vertical center and centering in one cell.
            dx = 300 - (x_min + x_max) * scale / 2
            dy = (y_min + y_max) * (base_scale - scale) / 2
            pen = TTGlyphPen(None)
            recording = DecomposingRecordingPen(glyph_set)
            glyph_set[source_name].draw(recording)
            recording.replay(TransformPen(pen, (scale, 0, 0, scale, dx, dy)))
            name = f'uni{cp:04X}'
            glyph = pen.glyph()
            glyphs[name] = glyph
            cmap[cp] = name
            glyph.recalcBounds(glyphs)
            metrics[name] = (600, glyph.xMin if glyph.numberOfContours else 0)
            break
    builder.setupGlyphOrder(list(glyphs))
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=1100, descent=-400)
    builder.setupNameTable({'copyright': '\n'.join(sorted({notice for source in provenance for notice in source['copyright']})),
        'familyName': 'Zylos Observer Symbols', 'styleName': 'Regular',
        'uniqueFontIdentifier': 'Zylos Observer Symbols 1.0', 'fullName': 'Zylos Observer Symbols Regular',
        'psName': 'ZylosObserverSymbols-Regular', 'version': 'Version 1.000',
        'licenseDescription': 'Licensed under the SIL Open Font License, Version 1.1. See OFL.txt.',
        'licenseInfoURL': 'https://openfontlicense.org/'})
    builder.setupOS2(sTypoAscender=1100, sTypoDescender=-400, usWinAscent=1100, usWinDescent=400)
    builder.setupPost(isFixedPitch=1)
    builder.setupMaxp()
    builder.font['head'].created = builder.font['head'].modified = 2082844800
    builder.font.recalcTimestamp = False
    builder.font.flavor = 'woff2'
    ROOT.mkdir(parents=True, exist_ok=True)
    output = ROOT / 'observer-symbols.woff2'
    builder.font.save(output)
    (ROOT / 'observer-symbols.json').write_text(json.dumps({'family': 'Zylos Observer Symbols',
        'sources': provenance, 'codepoints': len(cmap), 'missing': [f'U+{cp:04X}' for cp in CODEPOINTS if cp not in cmap],
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'build': 'fontTools ' + __import__('fontTools').__version__,
        'normalization': '1000 UPM, 600 advance; uniform scaling, horizontal centering, original vertical center'}, indent=2) + '\n')
    print(output, len(cmap), hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
