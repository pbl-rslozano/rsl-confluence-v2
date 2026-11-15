#!/usr/bin/env python3
"""build-menu-fonts.py — v2.5: tiny vendored fonts for the language menu's native names.

Only the glyphs of the native language names (rsL Core Kit LANGUAGES) are kept, so every menu
row is readable on any device without shipping full CJK/Indic fonts. Inputs are the pinned
@fontsource packages (root devDependencies, SIL OFL 1.1); outputs are committed to
apps/confluence/web/public/fonts/menu/ so builds need no network.

  python3 tools/build-menu-fonts.py           # rebuild fonts + lock + OFL.txt
  python3 tools/build-menu-fonts.py --check   # verify lock hashes, glyph coverage, name IDs and the licence file

v2.8 (WP20, licence audit): the subsets keep the name-table records 0-6, 13 and 14 (copyright, family, style,
unique ID, full name, version, PostScript name, licence description, licence URL); OFL.txt carries the full SIL
OFL 1.1 text and every family's copyright line from its name table, and says the fonts are modified (subset)
versions. --check fails if the licence body or a copyright line is missing, a kept name ID was dropped, or a family
name uses the Reserved Font Name "Source" (Adobe's RFN on Noto Sans SC/JP/KR).

Requires fontTools (4.67.0) and brotli (1.1.0) — developer machines / CI only.
"""
import hashlib, json, os, subprocess, sys, tempfile
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "apps/confluence/web/public/fonts/menu")
LOCK = os.path.join(ROOT, "tools/menu-fonts.lock.json")
OFL_TEXT = os.path.join(ROOT, "tools/third-party-fallbacks/texts/OFL-1.1.txt")  # SPDX text, pinned in sources.json
OFL_OUT = os.path.join(OUT, "OFL.txt")
KEEP_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14]
FAMILY_NAME_IDS = [1, 4, 6, 16, 17, 21, 22]
RESERVED_FONT_NAMES = ["Source"]

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


def names(path):
    """{nameID: string} from the Windows (3) records, falling back to any platform."""
    out = {}
    for rec in TTFont(path)["name"].names:
        if rec.nameID not in out or rec.platformID == 3:
            out[rec.nameID] = str(rec)
    return out


def ofl_body():
    with open(OFL_TEXT, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n").strip() + "\n"


def ofl_file(entries):
    """entries: [(family, fontsource package, copyright line)] → OFL.txt text."""
    lines = [
        "The rsL menu fonts in this folder (rsl-menu-*.woff2) are Modified Versions, in the sense of the SIL Open",
        "Font License 1.1, of the fonts below: glyph subsets made by tools/build-menu-fonts.py that keep only the",
        "letters of each language's native name (inputs and hashes in tools/menu-fonts.lock.json). They keep the",
        "original font names, which contain no Reserved Font Name, and are distributed under the same licence.",
        "",
    ]
    by_line = {}
    for family, package, line in entries:
        by_line.setdefault(line, []).append(f"{family} ← {package}")
    for line, users in by_line.items():
        lines.append(line)
        lines.append("    (" + "; ".join(users) + ")")
    lines.append("")
    return "\n".join(lines) + "\n" + ofl_body()


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
    native = native_names()
    os.makedirs(OUT, exist_ok=True)
    lock = {"@note": "Inputs and outputs of tools/build-menu-fonts.py (fonts SIL OFL 1.1).", "families": {}}
    for family, (pkg, codes) in FAMILIES.items():
        text = "".join(native[c] for c in codes)
        chars = "".join(sorted(set(ch for ch in text if not ch.isspace())))
        sources = pick_sources(pkg, chars)
        out = os.path.join(OUT, family.lower().replace(" ", "-") + ".woff2")
        with tempfile.TemporaryDirectory() as tmp:
            # Merge is not needed: each name is covered by one file in practice; enforce it.
            if len(sources) != 1:
                raise SystemExit(f"{family}: needs {len(sources)} source files; extend the tool to merge")
            subprocess.check_call([sys.executable, "-m", "fontTools.subset", sources[0], f"--text={text}",
                                   "--flavor=woff2", "--layout-features=*", "--no-hinting",
                                   "--name-IDs=" + ",".join(map(str, KEEP_NAME_IDS)),
                                   f"--output-file={out}"])
        missing = set(map(ord, chars)) - cmap(out)
        if missing:
            raise SystemExit(f"{family}: subset lacks {''.join(map(chr, missing))}")
        version = json.load(open(os.path.join(ROOT, "node_modules/@fontsource", pkg, "package.json")))["version"]
        lock["families"][family] = {
            "package": f"@fontsource/{pkg}@{version}", "source": os.path.basename(sources[0]),
            "sourceSha256": sha256(sources[0]), "text": text, "output": os.path.relpath(out, ROOT),
            "outputSha256": sha256(out), "bytes": os.path.getsize(out),
        }
        lock["families"][family]["copyright"] = names(out).get(0, "")
        lock["families"][family]["nameIds"] = sorted(set(names(out)) & set(KEEP_NAME_IDS))
        print(f"{family}: {os.path.getsize(out)} bytes  ← {os.path.basename(sources[0])}")
    text = ofl_file([(fam, e["package"], e["copyright"]) for fam, e in lock["families"].items()])
    with open(OFL_OUT, "w", encoding="utf-8") as f:
        f.write(text)
    lock["oflSha256"] = sha256(OFL_OUT)
    with open(LOCK, "w", encoding="utf-8") as f:
        json.dump(lock, f, ensure_ascii=False, indent=2)
        f.write("\n")


def check():
    lock = json.load(open(LOCK, encoding="utf-8"))
    native = native_names()
    ofl = open(OFL_OUT, encoding="utf-8").read() if os.path.exists(OFL_OUT) else ""
    bad = []
    for family, (pkg, codes) in FAMILIES.items():
        e = lock["families"].get(family)
        text = "".join(native[c] for c in codes)
        if not e or e["text"] != text:
            bad.append(f"{family}: native names changed — rebuild"); continue
        out = os.path.join(ROOT, e["output"])
        if sha256(out) != e["outputSha256"]:
            bad.append(f"{family}: output hash differs from lock")
        if set(ord(c) for c in text if not c.isspace()) - cmap(out):
            bad.append(f"{family}: glyphs missing")
        n = names(out)
        src = os.path.join(ROOT, "node_modules/@fontsource", pkg, "files", e["source"])
        want = set(KEEP_NAME_IDS) & set(names(src)) if os.path.exists(src) else set(e.get("nameIds", KEEP_NAME_IDS))
        if want - set(n):
            bad.append(f"{family}: name IDs {sorted(want - set(n))} dropped by subsetting")
        for nid in FAMILY_NAME_IDS:
            for rfn in RESERVED_FONT_NAMES:
                if rfn.lower() in n.get(nid, "").lower():
                    bad.append(f"{family}: name ID {nid} '{n[nid]}' uses the Reserved Font Name '{rfn}'")
        if not n.get(0) or n.get(0) not in ofl:
            bad.append(f"{family}: copyright line missing from OFL.txt")
    if not os.path.exists(OFL_OUT) or ofl_body() not in ofl:
        bad.append("OFL.txt: full SIL OFL 1.1 text missing")
    if "Modified Version" not in ofl:
        bad.append("OFL.txt: does not say the fonts are modified (subset) versions")
    if bad:
        raise SystemExit("\n".join(bad))
    print(f"menu fonts OK: {len(FAMILIES)} families, {sum(e['bytes'] for e in lock['families'].values())} bytes")


if __name__ == "__main__":
    check() if "--check" in sys.argv else build()
