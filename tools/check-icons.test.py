#!/usr/bin/env python3
"""Tests for tools/check-icons.py (release check R13). Run: python3 tools/check-icons.test.py"""
import io, os, struct, subprocess, sys, tempfile, unittest, zipfile, zlib
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "check-icons.py")
RSL = os.path.join(HERE, "icon-fixtures", "rsl-192.png")
CAP = os.path.join(HERE, "icon-fixtures", "capacitor-default-192.png")


def run(*args):
    return subprocess.run([sys.executable, TOOL, *args, "--expected", RSL], capture_output=True, text=True)


def zip_with(members):
    fd, path = tempfile.mkstemp(suffix=".zip"); os.close(fd)
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return path


def png_bytes(src, size=None):
    im = Image.open(src).convert("RGBA")
    if size: im = im.resize((size, size))
    b = io.BytesIO(); im.save(b, "PNG"); return b.getvalue()


def cgbi_bytes(src, size=120):
    """Apple's iPhone-optimised PNG: CgBI chunk, raw deflate, BGRA, filter 0."""
    im = Image.open(src).convert("RGBA").resize((size, size))
    px = bytearray(im.tobytes())
    for i in range(0, len(px), 4): px[i], px[i + 2] = px[i + 2], px[i]
    raw = b"".join(b"\x00" + bytes(px[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    comp = zlib.compressobj(9, zlib.DEFLATED, -15); idat = comp.compress(raw) + comp.flush()
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"CgBI", b"\x50\x00\x20\x06")
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


class CheckIcons(unittest.TestCase):
    def test_apk_with_rsl_icon_passes(self):
        r = run("--apk", zip_with({"res/xx.png": png_bytes(RSL), "AndroidManifest.xml": b"x"}))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("res/xx.png", r.stdout)

    def test_apk_with_capacitor_default_fails(self):
        r = run("--apk", zip_with({"res/yy.png": png_bytes(CAP), "res/zz.png": png_bytes(CAP, 144)}))
        self.assertEqual(r.returncode, 1)
        self.assertIn("Capacitor default icon", r.stdout + r.stderr)

    def test_apk_with_rsl_icon_plus_leftover_default_fails(self):
        # Partial copy: one rsL launcher image but Capacitor defaults still shipped (round/foreground/other densities).
        r = run("--apk", zip_with({"res/xx.png": png_bytes(RSL), **{f"res/d{i}.png": png_bytes(CAP) for i in range(10)}}))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("Capacitor default icon", r.stdout + r.stderr)

    def test_blank_library_images_are_not_mistaken_for_the_default_icon(self):
        # CI run 42351867433: libraries ship blank square PNGs; the default icon is mostly white, so a whole-image
        # difference (0.036) fell under the match threshold. Only the default's logo pixels may decide.
        blank = io.BytesIO(); Image.new("RGBA", (128, 128), (0, 0, 0, 0)).save(blank, "PNG")
        white = io.BytesIO(); Image.new("RGB", (192, 192), "white").save(white, "PNG")
        r = run("--apk", zip_with({"res/xx.png": png_bytes(RSL), "res/b1.png": blank.getvalue(), "res/b2.png": white.getvalue()}))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_one_leftover_default_still_fails(self):
        r = run("--apk", zip_with({"res/xx.png": png_bytes(RSL), "res/d.png": png_bytes(CAP, 144)}))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("res/d.png", r.stdout)

    def test_ipa_with_cgbi_rsl_icon_passes(self):
        r = run("--ipa", zip_with({"Payload/App.app/AppIcon60x60@2x.png": cgbi_bytes(RSL)}))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_ipa_with_opaque_ios_icon_passes_against_ios_fixture(self):
        ios_src = os.path.join(HERE, "..", "apps", "confluence", "mobile", "resources", "ios-AppIcon-1024.png")
        ipa = zip_with({"Payload/App.app/AppIcon60x60@2x.png": cgbi_bytes(ios_src)})
        r = subprocess.run([sys.executable, TOOL, "--ipa", ipa, "--expected", os.path.join(HERE, "icon-fixtures", "rsl-ios-180.png")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_ipa_without_app_icon_fails(self):
        r = run("--ipa", zip_with({"Payload/App.app/Info.plist": b"x"}))
        self.assertEqual(r.returncode, 1)

    @unittest.skipUnless(os.environ.get("ICON_TEST_APK"), "set ICON_TEST_APK to the v2.4 APK")
    def test_real_v24_apk_is_detected(self):
        r = run("--apk", os.environ["ICON_TEST_APK"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("Capacitor default icon", r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
