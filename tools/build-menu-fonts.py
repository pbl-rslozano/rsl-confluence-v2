#!/usr/bin/env python3
"""build-menu-fonts.py — v2.5: tiny vendored fonts for the language menu's native names.

Only the glyphs of the native language names (rsL Core Kit LANGUAGES) are kept, so every menu
row is readable on any device without shipping full CJK/Indic fonts. Inputs are the pinned
@fontsource packages (root devDependencies, SIL OFL 1.1); outputs are committed to
apps/confluence/web/public/fonts/menu/ so builds need no network.

  python3 tools/build-menu-fonts.py           # rebuild fonts + lock
  python3 tools/build-menu-fonts.py --check   # verify lock hashes and glyph coverage only

Requires fontTools (4.67.0) and brotli (1.1.0) — developer machines / CI only.
"""
import hashlib, json, os, subprocess, sys, tempfile
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "apps/confluence/web/public/fonts/menu")
LOCK = os.path.join(ROOT, "tools/menu-fonts.lock.json")

# family → (fontsource package, language codes whose native names it renders, layout-sensitive?)
FAMILIES = {
    "rsL Menu Arab": ("noto-naskh-arabic", ["ar"]),
    "rsL Menu Nastaliq": ("noto-nastaliq-urdu", ["ur"]),
    "rsL Menu Deva": ("noto-sans-devanagari", ["hi"]),
    "rsL Menu Beng": ("noto-sans-bengali", ["bn"]),
    "rsL Menu SC": ("noto-sans-sc", ["zh"]),
    "rsL Menu JP": ("noto-sans-jp", ["ja"]),
    "rsL Menu KR": ("noto-sans-kr", ["ko"]),
}


def native_names():
    js = "import('./packages/core/core/rsl-i18n.js').then(m=>process.stdout.write(JSON.stringify(Object.fromEntries(m.LANGUAGES.map(l=>[l.code,l.native])))))"
    return json.loads(subprocess.check_output(["node", "-e", js], cwd=ROOT))


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def cmap(path):
    return set(TTFont(path).getBestCmap().keys())


def pick_sources(pkg, chars):
    """Smallest set of 400-normal woff2 files from the package that covers every character."""
    d = os.path.join(ROOT, "node_modules/@fontsource", pkg, "files")
    files = sorted(f for f in os.listdir(d) if f.endswith("-400-normal.woff2"))
    need, chosen = set(map(ord, chars)), []
    covers = {f: cmap(os.path.join(d, f)) & need for f in files}
    while need:
        best = max(files, key=lambda f: len(covers[f] & need))
        got = covers[best] & need
        if not got:
            raise SystemExit(f"{pkg}: no file covers {''.join(map(chr, sorted(need)))}")
        chosen.append(os.path.join(d, best))
        need -= got
    return chosen


def build():
    names = native_names()
    os.makedirs(OUT, exist_ok=True)
    lock = {"@note": "Inputs and outputs of tools/build-menu-fonts.py (fonts SIL OFL 1.1).", "families": {}}
    for family, (pkg, codes) in FAMILIES.items():
        text = "".join(names[c] for c in codes)
        chars = "".join(sorted(set(ch for ch in text if not ch.isspace())))
        sources = pick_sources(pkg, chars)
        out = os.path.join(OUT, family.lower().replace(" ", "-") + ".woff2")
        with tempfile.TemporaryDirectory() as tmp:
            # Merge is not needed: each name is covered by one file in practice; enforce it.
            if len(sources) != 1:
                raise SystemExit(f"{family}: needs {len(sources)} source files; extend the tool to merge")
            subprocess.check_call([sys.executable, "-m", "fontTools.subset", sources[0], f"--text={text}",
                                   "--flavor=woff2", "--layout-features=*", "--no-hinting", f"--output-file={out}"])
        missing = set(map(ord, chars)) - cmap(out)
        if missing:
            raise SystemExit(f"{family}: subset lacks {''.join(map(chr, missing))}")
        version = json.load(open(os.path.join(ROOT, "node_modules/@fontsource", pkg, "package.json")))["version"]
        lock["families"][family] = {
            "package": f"@fontsource/{pkg}@{version}", "source": os.path.basename(sources[0]),
            "sourceSha256": sha256(sources[0]), "text": text, "output": os.path.relpath(out, ROOT),
            "outputSha256": sha256(out), "bytes": os.path.getsize(out),
        }
        print(f"{family}: {os.path.getsize(out)} bytes  ← {os.path.basename(sources[0])}")
    with open(LOCK, "w", encoding="utf-8") as f:
        json.dump(lock, f, ensure_ascii=False, indent=2)
        f.write("\n")


def check():
    lock = json.load(open(LOCK, encoding="utf-8"))
    names = native_names()
    bad = []
    for family, (pkg, codes) in FAMILIES.items():
        e = lock["families"].get(family)
        text = "".join(names[c] for c in codes)
        if not e or e["text"] != text:
            bad.append(f"{family}: native names changed — rebuild"); continue
        out = os.path.join(ROOT, e["output"])
        if sha256(out) != e["outputSha256"]:
            bad.append(f"{family}: output hash differs from lock")
        if set(ord(c) for c in text if not c.isspace()) - cmap(out):
            bad.append(f"{family}: glyphs missing")
    if bad:
        raise SystemExit("\n".join(bad))
    print(f"menu fonts OK: {len(FAMILIES)} families, {sum(e['bytes'] for e in lock['families'].values())} bytes")


if __name__ == "__main__":
    check() if "--check" in sys.argv else build()
