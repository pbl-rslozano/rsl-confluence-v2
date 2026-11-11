# ADR-0014 — Application build guard: protected builds, release gates, user safeguards

**Status:** Accepted · 7 Nov 2026 (v2.6 plan, WP8–WP10; as built on build 20261107)

## Context
The owner asked for an application build guard for the application and its users, in three layers: code protection,
release gate checks and user-side safeguards. The owner's `html-app-protection-build` pipeline (master source,
structure, minify, obfuscate own code, no source maps, validate after each stage) was written for single-file HTML
apps; this app is a Next.js static export shipped to web, Android, iPhone and desktop from one `out/` folder.

## Decision
1. **Protected builds (WP8).** After `next build`, `tools/protect-build.mjs` obfuscates only the app's own chunks listed
   in `tools/protect-targets.json` with a pinned `javascript-obfuscator` and conservative settings (no control-flow
   flattening, self-defending, debug protection, domain lock or eval-based transforms). Framework and vendored chunks
   stay byte-identical. No source maps in any shipped artefact. A master source zip and the un-obfuscated minified
   `out/` are kept as CI artifacts, linked by SHA-256 in `build-manifest.json`, for audits.
2. **Release gates (WP9).** New checks R16 (public-host table), R17 (protected build), R18 (protected equivalence),
   R19 (plan ↔ user-guide parity), R20 (keyless public sources).
3. **User safeguards (WP10).** Source health states, Thin/local-market labels, no silent source substitution, Android update
   size and SHA-256 shown, source commit shown in About, Coins.ph never offered for account connection, data notice in About.

## As built
- Obfuscator settings: identifier renaming, compaction and simplify. The string array is off because it made the engine
  2.7× slower (BG-5 caps scan time at +15 %); base64/rc4 string encoding is slower still. Measured: scan time −0.1 %,
  total chunk JS +3.5 % raw / +1.7 % gzip, first-load JS +15.8 % gzip (reported, not capped).
- BG-4 runs `tools/protect-golden.mjs` (120 replay series, identical results required); R17 also enforces the BG-5
  size cap; R18 checks CI evidence of BG-3 and BG-4 for the exact protected tree hash.
- Open: the master source zip is not yet produced (the manifest field exists).

## Consequences
- Obfuscation deters copying and casual tampering; it is not a security boundary. Without the string array, text
  strings stay readable; the protection is mainly renamed identifiers and the absence of source maps. User integrity rests on platform
  signing and the published hashes.
- Audits of the compiled bundle run on the kept minified build; R18 ties it to the protected build.
- Bundle size and first-scan time may grow; BG-5 caps the growth at +15 %.
- Every future release must update the architecture plan and the user guide together (R19).
