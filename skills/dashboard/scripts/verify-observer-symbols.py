#!/usr/bin/env python3
"""Development-only verification against pinned source outlines (fontTools + Brotli).

Usage: python scripts/verify-observer-symbols.py --cache /path/to/source-cache
Sources are downloaded into the cache only when absent, then always digest-checked.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import urllib.request
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cache', required=True, type=pathlib.Path)
args = parser.parse_args()
args.cache.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_symbols', root / 'scripts/build-observer-symbols.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
fonts = []
sources = []
for family, version, digest in recipe.SOURCES:
    file = args.cache / f'{family}-Regular.ttf'
    if not file.exists():
        url = f'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/{family}/unhinted/ttf/{family}-Regular.ttf'
        file.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    assert hashlib.sha256(file.read_bytes()).hexdigest() == digest, family
    font = TTFont(file)
    fonts.append(font)
    names = lambda field: sorted({entry.toUnicode() for entry in font['name'].names if entry.nameID == field})
    assert any(version in value for value in names(5)), (family, names(5))
    sources.append(dict(family=family, sha256=digest, copyright=names(0), license=names(13)))

license_text = (root / 'assets/observer/OFL.txt').read_text()
for source in sources:
    for copyright_notice in source['copyright']:
        assert copyright_notice in license_text, ('Missing source attribution', copyright_notice)

asset = root / 'assets/observer/observer-symbols.woff2'
font = TTFont(asset)
cmap = font.getBestCmap()
assert len(cmap) == 647, len(cmap)
assert set(cmap) <= set(recipe.CODEPOINTS)
expected = {cp for cp in recipe.CODEPOINTS if any(cp in f.getBestCmap() for f in fonts)}
assert set(cmap) == expected
for cp in [0x23F5, 0x23BF, 0x23FA, 0x23F8, 0x25CF, 0x2714, 0x2717, 0x273B, 0x2733, 0x2736, 0x273D, 0x276F]:
    assert cp in cmap, hex(cp)
for cp in cmap:
    assert not (cp <= 0x7F or 0x2500 <= cp <= 0x259F or 0x4E00 <= cp <= 0x9FFF)
assert font['head'].unitsPerEm == 1000
assert all(advance == 600 for advance, _ in font['hmtx'].metrics.values())
assert all('Noto' not in entry.toUnicode() for entry in font['name'].names if entry.nameID in (1, 4, 6))


def bounds(f, name):
    glyphs = f.getGlyphSet()
    pen = BoundsPen(glyphs)
    glyphs[name].draw(pen)
    return pen.bounds

max_axis_error = max_horizontal_center_error = max_vertical_center_error = 0
circle = None
for cp, name in cmap.items():
    source = next(f for f in fonts if cp in f.getBestCmap())
    original = bounds(source, source.getBestCmap()[cp])
    actual = bounds(font, name)
    if not original:
        assert not actual
        continue
    assert actual
    x0, y0, x1, y1 = actual
    sx0, sy0, sx1, sy1 = original
    assert x0 >= -0.51 and x1 <= 600.51, (hex(cp), actual)
    center_error = abs((x0 + x1) / 2 - 300)
    assert center_error <= 0.51, (hex(cp), center_error)
    unit = 1000 / source['head'].unitsPerEm
    vertical_error = abs((y0 + y1) / 2 - (sy0 + sy1) * unit / 2)
    assert vertical_error <= 0.51, (hex(cp), vertical_error)
    ow, oh, width, height = sx1 - sx0, sy1 - sy0, x1 - x0, y1 - y0
    if ow and oh:
        # Independent geometric check: infer scale from width, predict height.
        # Rounding each extremum to an integer permits at most ~1 font unit per axis.
        axis_error = abs(height - oh * width / ow)
        tolerance = 1.1 + oh / ow
        assert axis_error <= tolerance, (hex(cp), axis_error, tolerance)
        assert width <= ow * unit + 1.01
        assert height <= oh * unit + 1.01
        max_axis_error = max(max_axis_error, axis_error)
    max_horizontal_center_error = max(max_horizontal_center_error, center_error)
    max_vertical_center_error = max(max_vertical_center_error, vertical_error)
    if cp == 0x25CF:
        circle = dict(sourceBounds=original, outputBounds=actual, aspectRatio=width/height)
        assert abs(width / height - ow / oh) < 0.005

provenance = json.loads((asset.parent / 'observer-symbols.json').read_text())
assert provenance['sha256'] == hashlib.sha256(asset.read_bytes()).hexdigest()
assert provenance['codepoints'] == len(cmap)
print(json.dumps(dict(result='PASS', codepoints=len(cmap), sha256=provenance['sha256'],
    sources=sources, maxAxisErrorFontUnits=max_axis_error,
    maxHorizontalCenterErrorFontUnits=max_horizontal_center_error,
    maxVerticalCenterErrorFontUnits=max_vertical_center_error, circle=circle), indent=2))
