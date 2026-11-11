#!/usr/bin/env python3
"""check-icons.py — release check R13 (v2.5): the built phone apps carry the rsL icon.

  python3 tools/check-icons.py --apk app-release.apk --expected tools/icon-fixtures/rsl-192.png
  python3 tools/check-icons.py --ipa App-unsigned.ipa --expected tools/icon-fixtures/rsl-192.png

APK: every square PNG >= 96 px under res/ is a launcher candidate (release builds obfuscate names).
IPA: Payload/*.app/AppIcon60x60@2x.png (Apple CgBI PNG, decoded here).
Pass when no candidate is the Capacitor default icon (any match fails: partial copies ship the wrong
icon) and the best candidate's mean absolute RGB difference from the expected icon at 64x64 is <= 12/255.
"Is the default" is judged on the default's logo pixels only: the default is mostly white, so a blank
square PNG shipped by a library would otherwise be within the threshold (CI run 42351867433).
Requires Pillow (CI: pillow==11.3.0).
"""
import argparse, io, os, struct, sys, zipfile, zlib
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CAPACITOR_DEFAULT = os.path.join(HERE, "icon-fixtures", "capacitor-default-192.png")
MATCH, NOT_DEFAULT = 12 / 255, 40 / 255


def decode_cgbi(data):
    """Decode Apple's CgBI PNG variant (raw deflate, BGRA, premultiplied) to an RGBA image."""
    p, idat, w = 8, b"", 0
    while p < len(data):
        n, = struct.unpack(">I", data[p:p + 4]); t = data[p + 4:p + 8]; d = data[p + 8:p + 8 + n]; p += 12 + n
        if t == b"IHDR": w, h = struct.unpack(">II", d[:8])
        elif t == b"IDAT": idat += d
    raw = zlib.decompress(idat, -15)
    bpp, stride, out, prev, i = 4, w * 4, bytearray(), bytearray(w * 4), 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; up = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + up) & 255
            elif f == 3: line[x] = (line[x] + ((a + up) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(up - c), abs(a - c), abs(a + up - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        out += line; prev = line
    for k in range(0, len(out), 4): out[k], out[k + 2] = out[k + 2], out[k]
    return Image.frombytes("RGBA", (w, h), bytes(out))


def load(data):
    if data[12:16] == b"CgBI":
        return decode_cgbi(data)
    return Image.open(io.BytesIO(data))


def norm(im):
    """64x64 RGB on white, so transparent corners compare equally."""
    im = im.convert("RGBA").resize((64, 64), Image.LANCZOS)
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255)); bg.alpha_composite(im)
    return bg.convert("RGB").tobytes()


def mad(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a) / 255


def logo_mask(ref):
    """Indexes of the RGB bytes of pixels that are not near-white in the reference (its logo)."""
    idx = []
    for p in range(0, len(ref), 3):
        if min(ref[p:p + 3]) < 224: idx += [p, p + 1, p + 2]
    return idx


def masked_mad(a, b, idx):
    return sum(abs(a[i] - b[i]) for i in idx) / len(idx) / 255


def candidates(path, kind):
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if kind == "apk" and name.startswith("res/") and name.endswith(".png") and not name.endswith(".9.png"):
                data = z.read(name)
                try:
                    im = load(data)
                except Exception:
                    continue
                if im.width == im.height and im.width >= 96:
                    yield name, im
            elif kind == "ipa" and name.startswith("Payload/") and name.endswith(".app/AppIcon60x60@2x.png"):
                yield name, load(z.read(name))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apk"); g.add_argument("--ipa")
    ap.add_argument("--expected", required=True)
    a = ap.parse_args()
    kind, path = ("apk", a.apk) if a.apk else ("ipa", a.ipa)
    want, default = norm(Image.open(a.expected)), norm(Image.open(CAPACITOR_DEFAULT))
    mask = logo_mask(default)
    best = None
    leftovers = []
    for name, im in candidates(path, kind):
        n = norm(im)
        d, dd = mad(n, want), masked_mad(n, default, mask)
        if dd <= MATCH: leftovers.append(name)
        if best is None or d < best[1]: best = (name, d, dd)
    if best is None:
        print(f"R13 FAIL: no launcher icon found in {os.path.basename(path)}"); return 1
    name, d, dd = best
    if leftovers:
        # Any leftover Capacitor default (a partial copy) ships the wrong icon on some launchers.
        print(f"R13 FAIL: Capacitor default icon still present in {os.path.basename(path)}: {', '.join(sorted(leftovers))}"); return 1
    if d <= MATCH and dd > NOT_DEFAULT:
        print(f"R13 PASS: {name} matches the rsL icon (difference {d:.3f})"); return 0
    print(f"R13 FAIL: icon differs from the rsL icon — best candidate {name} (difference {d:.3f}, vs default logo {dd:.3f})"); return 1


if __name__ == "__main__":
    sys.exit(main())
