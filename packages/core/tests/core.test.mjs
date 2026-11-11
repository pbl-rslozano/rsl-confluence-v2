// rsL Core Kit · v1.0 2026 — unit tests.  Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJSON, sha256Hex, b64urlEncode, b64urlDecodeStrict, utf8 } from '../core/rsl-crypto.js';
import { guardedNow, DAY_MS, parseISODate, endOfDayUTC } from '../core/rsl-clock.js';
import { luhn36CheckChar, luhn36Valid, verifyLicenseKey, computeLicense, siteIdFromLocation } from '../core/rsl-license-core.js';
import { createMemoryAdapter, createSqlAdapter, fromNodeSqlite, fromTauriSql, runMigrations, exportSnapshot, importSnapshot, openStorage } from '../core/rsl-storage.js';
import { createAuditTrail, diffFields, GENESIS } from '../core/rsl-audit.js';
import { LANGUAGES, createI18n, negotiateLanguage, isolate } from '../core/rsl-i18n.js';
import { safeCell, toCSV, exportFileName, gs1CheckDigit, isValidGTIN, isValidSSCC, toGTIN14 } from '../core/rsl-export.js';
import { validateIdentity, initials, isSafeLogo, createIdentityStore, avatarColor } from '../core/rsl-identity.js';
import { brandBlockHTML, buildStamp, poweredBy, footerLines, monogramSVG, BRAND } from '../core/rsl-brand.js';
import { seedFromAppCode } from '../core/rsl-signature-art.js';
import { detectPlatform } from '../core/rsl-platform.js';

/* ───────── crypto ───────── */
test('base64url round-trip and strict decoding', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    assert.deepEqual(b64urlDecodeStrict(b64urlEncode(b)), b);
  }
  assert.equal(b64urlDecodeStrict('ab=='), null, 'padding rejected');
  assert.equal(b64urlDecodeStrict('a+b/'), null, '+ and / rejected');
  assert.equal(b64urlDecodeStrict('abcde'), null, 'length % 4 == 1 rejected');
  assert.equal(b64urlDecodeStrict('QR'), null, 'non-canonical trailing bits rejected');
  assert.deepEqual(b64urlDecodeStrict('QQ'), utf8('A'));
});
test('canonical JSON sorts keys and rejects NaN', () => {
  assert.equal(canonicalJSON({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  assert.throws(() => canonicalJSON({ a: NaN }));
});
test('sha256Hex known vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

/* ───────── clock ───────── */
test('guardedNow: set-back, bounded skew', () => {
  const real = Date.UTC(2026, 9, 29);
  const back = guardedNow(real + 10 * DAY_MS, real);
  assert.equal(back.now, real + 10 * DAY_MS); assert.equal(back.setBack, true);
  const far = guardedNow(real + 31 * DAY_MS, real);
  assert.equal(far.now, real); assert.equal(far.ignored, real + 31 * DAY_MS);
  const near = guardedNow(real + 29 * DAY_MS, real);
  assert.equal(near.now, real + 29 * DAY_MS); assert.equal(near.ignored, null);
  assert.equal(parseISODate('2026-02-30'), null);
  assert.equal(endOfDayUTC('2026-10-28'), Date.UTC(2026, 9, 28, 23, 59, 59, 999));
});

/* ───────── license ───────── */
test('Luhn mod 36: worked example from the license masterclass', () => {
  assert.equal(luhn36CheckChar('RSL-NMRC-2026-0001'), 'P');
  assert.ok(luhn36Valid('RSL-NMRC-2026-0001-P'));
  assert.ok(!luhn36Valid('RSL-NMRC-2026-0001-Q'));
  assert.ok(!luhn36Valid('RSL-NMRC-2026-0010-P'), 'adjacent swap caught');
  // every single-character substitution is caught
  const full = 'RSLNMRC20260001P';
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < full.length; i++) for (const ch of A) if (ch !== full[i]) assert.ok(!luhn36Valid(full.slice(0, i) + ch + full.slice(i + 1)));
});

async function makeKit(code = 'TEST') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const kid = `rsl-${code.toLowerCase()}-0000-1`;
  const sign = async (payload, prefix = `RSL${code}1`, key = kp.privateKey) => {
    const p64 = b64urlEncode(utf8(JSON.stringify(payload)));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${prefix}.${p64}`)));
    return `${prefix}.${p64}.${b64urlEncode(sig)}`;
  };
  return { kp, jwk, kid, sign, trustedKeys: [{ kid, jwk: { x: jwk.x, y: jwk.y }, issuedUntil: null }] };
}
const lic = (code, n) => { const body = `RSL-${code}-2026-${String(n).padStart(4, '0')}`; return `${body}-${luhn36CheckChar(body)}`; };

test('license test vectors (masterclass phase 10.1)', async () => {
  const k = await makeKit('TEST');
  const other = await makeKit('PKOS');
  const now = Date.UTC(2026, 10, 1, 12);
  const ctx = { appCode: 'TEST', appName: 'rsL Test', trustedKeys: k.trustedKeys, knownApps: { PKOS: 'rsL PackOS' }, revoked: [], site: 'file', now, editions: ['Site', 'Department', 'Enterprise'] };
  const base = { v: 1, kid: k.kid, app: 'TEST', lic: lic('TEST', 1), to: 'Saudi Masterbaker Ltd.', ed: 'Site', sites: ['file'], iat: '2026-10-29', nbf: '2026-10-29', exp: '2027-10-28', note: '' };
  const good = await k.sign(base);

  let r = await verifyLicenseKey(good, ctx); assert.equal(r.ok, true, r.reason);                     // 1
  const [p, pl, sg] = good.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  r = await verifyLicenseKey(`${p}.${flip(pl, 10)}.${sg}`, ctx); assert.ok(['E-09', 'E-05', 'E-03'].includes(r.code));  // 2
  r = await verifyLicenseKey(`${p}.${pl}.${flip(sg, 5)}`, ctx); assert.equal(r.code, 'E-09');
  r = await verifyLicenseKey(await other.sign({ ...base, app: 'PKOS', kid: other.kid }, 'RSLPKOS1'), ctx); assert.equal(r.code, 'E-07');   // 3
  r = await verifyLicenseKey(await k.sign({ ...base, kid: 'rsl-test-0000-9' }), ctx); assert.equal(r.code, 'E-08');
  const { kid, ...noKid } = base; r = await verifyLicenseKey(await k.sign(noKid), ctx); assert.equal(r.code, 'E-06');
  const der = new Uint8Array(71).fill(48); r = await verifyLicenseKey(`${p}.${pl}.${b64urlEncode(der)}`, ctx); assert.equal(r.code, 'E-04');  // 4
  r = await verifyLicenseKey(`${p}.${pl}=.${sg}`, ctx); assert.equal(r.code, 'E-03');
  r = await verifyLicenseKey('RSLTEST1.' + 'A'.repeat(2050), ctx); assert.equal(r.code, 'E-01');
  r = await verifyLicenseKey(await k.sign({ ...base, __proto__x: 1, constructor: 1 }), ctx); assert.equal(r.code, 'E-05');  // 5
  r = await verifyLicenseKey(await k.sign({ ...base, app: 'OTHR' }), ctx); assert.equal(r.code, 'E-11');
  r = await verifyLicenseKey(await k.sign({ ...base, lic: 'RSL-TEST-2026-0001-Z' }), ctx); assert.equal(r.code, 'E-12');
  r = await verifyLicenseKey(good, { ...ctx, site: 'evil.example.com' }); assert.equal(r.code, 'E-14');   // 6
  r = await verifyLicenseKey(await k.sign({ ...base, sites: ['*'] }), { ...ctx, site: 'anything.example' }); assert.equal(r.ok, true);
  r = await verifyLicenseKey(await k.sign({ ...base, nbf: '2026-11-02' }), ctx); assert.equal(r.code, 'E-15');  // 7
  const expKey = await k.sign({ ...base, exp: '2026-11-01' });
  r = await verifyLicenseKey(expKey, { ...ctx, now: Date.UTC(2026, 10, 1, 23, 59, 59, 999) }); assert.equal(r.ok, true);
  r = await verifyLicenseKey(expKey, { ...ctx, now: Date.UTC(2026, 10, 2) }); assert.equal(r.code, 'E-16');
  r = await verifyLicenseKey(good, { ...ctx, revoked: [{ lic: base.lic, date: '2026-10-30', reason: 'test' }] }); assert.equal(r.code, 'E-13');  // 10
  r = await verifyLicenseKey(await k.sign({ ...base, lic: 'RSL-TEST-2026-0001' }), { ...ctx, legacyLicenses: ['RSL-TEST-2026-0001'] }); assert.equal(r.ok, true);  // 12
  r = await verifyLicenseKey(await k.sign({ ...base, to: 'Evil‮name' }), ctx); assert.equal(r.code, 'E-11');
  r = await verifyLicenseKey(await k.sign({ ...base, iat: '2026-02-30' }), ctx); assert.equal(r.code, 'E-11');
  r = await verifyLicenseKey(' ' + good.slice(0, 20) + '​' + good.slice(20) + '\n', ctx); assert.equal(r.ok, true, 'whitespace and zero-width removed');
});

test('license state machine: free-use and reminder boundaries (phase 2.1 / 10.1 #8)', () => {
  const free = '2028-10-28';
  const end = endOfDayUTC(free);
  assert.equal(computeLicense({ now: end, freeUseUntil: free }).status, 'trial');
  assert.equal(computeLicense({ now: end + 1, freeUseUntil: free }).status, 'due');
  assert.equal(computeLicense({ now: end + 1, freeUseUntil: free }).watermark, 'FREE USAGE DUE — LICENSE REQUIRED');
  assert.equal(computeLicense({ now: end - 61 * DAY_MS, freeUseUntil: free }).remind, false);
  assert.equal(computeLicense({ now: end - 59 * DAY_MS, freeUseUntil: free }).remind, true);
  const licensed = computeLicense({ verification: { ok: true, payload: { exp: null } }, hasKey: true, now: end + 5, freeUseUntil: free });
  assert.equal(licensed.status, 'licensed'); assert.equal(licensed.watermark, null);
  const expired = computeLicense({ verification: { ok: false, code: 'E-16', reason: 'x' }, hasKey: true, now: end - DAY_MS, freeUseUntil: free });
  assert.deepEqual([expired.status, expired.sub], ['trial', 'expired']);
  assert.equal(siteIdFromLocation({ protocol: 'file:' }), 'file');
  assert.equal(siteIdFromLocation({ protocol: 'https:', hostname: 'IBAKE-PACKOS.rslozano.chatgpt.site' }), 'ibake-packos.rslozano.chatgpt.site');
  assert.equal(siteIdFromLocation({ protocol: 'tauri:', hostname: 'localhost' }), 'app');
});

/* ───────── storage ───────── */
async function portContract(port) {
  await port.put('sku', 'A-1', { name: 'Sambosa 1 kg', gtin: '06291041500213' });
  await port.put('sku', 'B 2', { name: 'Rusk 375 g' });
  assert.deepEqual(await port.get('sku', 'A-1'), { name: 'Sambosa 1 kg', gtin: '06291041500213' });
  assert.equal((await port.list('sku')).length, 2);
  await port.put('sku', 'A-1', { name: 'Sambosa 1 kg v2' });
  assert.equal((await port.get('sku', 'A-1')).name, 'Sambosa 1 kg v2');
  await port.del('sku', 'B 2'); assert.equal(await port.get('sku', 'B 2'), null);
  assert.rejects(() => port.put('bad col', 'x', {}));
}
test('StoragePort contract: memory', async () => portContract(createMemoryAdapter()));
test('StoragePort contract: SQLite (node:sqlite) + Tauri placeholder shim', async () => {
  const port = await createSqlAdapter(fromNodeSqlite(new DatabaseSync(':memory:')));
  await portContract(port);
  const seen = [];
  const shim = fromTauriSql({ execute: async (q) => seen.push(q), select: async (q) => (seen.push(q), []) });
  await shim.execute('INSERT INTO t VALUES (?, ?, ?)', [1, 2, 3]);
  assert.equal(seen[0], 'INSERT INTO t VALUES ($1, $2, $3)');
});
test('openStorage falls back to session-only memory', async () => {
  const r = await openStorage([async () => { throw new Error('blocked'); }]);
  assert.equal(r.port.sessionOnly, true); assert.match(r.notice, /only until you close/);
});
test('migrations are ordered, forward-only and recorded', async () => {
  const port = createMemoryAdapter(); const ran = [];
  const migs = [{ version: 2, name: 'b', up: async () => ran.push(2) }, { version: 1, name: 'a', up: async () => ran.push(1) }];
  assert.equal(await runMigrations(port, migs), 2);
  assert.equal(await runMigrations(port, migs), 2);
  assert.deepEqual(ran, [1, 2]);
});
test('backup snapshot: checksum, app and version guards', async () => {
  const port = createMemoryAdapter();
  await port.put('sku', '1', { name: 'Tortilla 360 g' });
  const snap = await exportSnapshot(port, { appId: 'PKOS', appVersion: '1.0', collections: ['sku'], auditHead: GENESIS });
  const fresh = createMemoryAdapter();
  await importSnapshot(fresh, snap, { appId: 'PKOS', maxSchemaVersion: 0 });
  assert.equal((await fresh.get('sku', '1')).name, 'Tortilla 360 g');
  const tampered = JSON.parse(JSON.stringify(snap)); tampered.data.sku[0].doc.name = 'X';
  await assert.rejects(() => importSnapshot(fresh, tampered, { appId: 'PKOS', maxSchemaVersion: 0 }), /damaged/);
  await assert.rejects(() => importSnapshot(fresh, snap, { appId: 'GNF', maxSchemaVersion: 0 }), /belongs to PKOS/);
});

/* ───────── audit ───────── */
test('audit trail: chain intact, tamper detected, clock set-back recorded', async () => {
  const port = createMemoryAdapter();
  let t = Date.UTC(2026, 9, 29, 8);
  const audit = createAuditTrail(port, { now: () => t });
  const d = diffFields({ net: 350, unit: 'g' }, { net: 375, unit: 'g' });
  await audit.append({ actorId: 'op-7', event: 'sku.update', record: 'sku:RUSK-375', reason: 'Artwork FA8', ...d });
  t += 1000; await audit.append({ actorId: 'op-7', event: 'report.export', record: 'rep:1' });
  assert.deepEqual(d, { before: { net: 350 }, after: { net: 375 } });
  let v = await audit.verify(); assert.equal(v.intact, true); assert.equal(v.count, 2);
  t -= 5 * DAY_MS; await audit.append({ actorId: 'op-7', event: 'sku.view' });
  const all = await audit.entries();
  assert.equal(all.at(-1).event, 'clock.set-back');
  assert.ok(all.every((e, i) => i === 0 || e.at >= all[i - 1].at), 'timestamps never go backwards');
  const row = (await port.list('audit'))[0];
  await port.put('audit', row.id, { ...row.doc, reason: 'edited later' });
  v = await audit.verify(); assert.equal(v.intact, false); assert.equal(v.brokenAt, 1);
  assert.match(await audit.footerRef(), /^AUD #4 · [0-9a-f]{4}…[0-9a-f]{4}$/);
});

/* ───────── i18n ───────── */
test('i18n: 18 languages in rsL order, plural/select, fallback, Latin digits in Arabic', () => {
  assert.equal(LANGUAGES.length, 18);
  assert.deepEqual(LANGUAGES.map((l) => l.code), ['en', 'ar', 'ja', 'fil', 'bn', 'ur', 'ru', 'hi', 'zh', 'ko', 'id', 'ms', 'tr', 'fr', 'de', 'es', 'pt', 'it']);
  const i18n = createI18n({ catalogs: {
    en: { 'empty.sku': 'No SKUs yet for {customer}. Create the first one.', 'count': '{n, plural, =0 {No items} one {# item} other {# items}}', 'lic': 'License {state, select, due {due} other {ok}}', 'only.en': 'English only' },
    ar: { 'count': '{n, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}' },
  } });
  assert.equal(i18n.t('empty.sku', { customer: 'iBake' }), 'No SKUs yet for iBake. Create the first one.');
  assert.equal(i18n.t('count', { n: 0 }), 'No items');
  assert.equal(i18n.t('count', { n: 1 }), '1 item');
  assert.equal(i18n.t('count', { n: 1234 }), '1,234 items');
  assert.equal(i18n.t('lic', { state: 'due' }), 'License due');
  i18n.setLang('ar');
  assert.equal(i18n.dir, 'rtl');
  assert.equal(i18n.t('count', { n: 11 }), '11 عنصرًا', 'Arabic plural "many" with Latin digits');
  assert.equal(i18n.t('only.en'), 'English only', 'falls back to English');
  assert.equal(i18n.t('missing.key'), '⟦missing.key⟧');
  assert.equal(negotiateLanguage(['tl-PH']), 'fil');
  assert.equal(negotiateLanguage(['ar-AE', 'en']), 'ar');
  assert.equal(isolate('rsL PackOS'), '⁨rsL PackOS⁩');
});

/* ───────── export ───────── */
test('CSV formula-injection hardening', () => {
  for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.equal(safeCell(s)[0], "'");
  assert.equal(safeCell(-5), '-5'); assert.equal(safeCell('Rusk'), 'Rusk');
  const csv = toCSV([{ sku: '=HYPERLINK("x")', qty: 3 }], { notice: 'FREE USAGE DUE — LICENSE REQUIRED' });
  assert.ok(csv.startsWith('﻿FREE USAGE DUE'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.equal(exportFileName({ app: 'PackOS', customerCode: 'IBK', docId: 'SPEC/0042', date: new Date(2026, 9, 29), ext: 'PDF' }), 'PackOS_IBK_SPEC-0042_20261029.pdf');
});
test('GS1 mod-10 check digits', () => {
  assert.equal(gs1CheckDigit('400638133393'), 1);
  assert.ok(isValidGTIN('4006381333931')); assert.ok(isValidGTIN('036000291452'));
  assert.ok(!isValidGTIN('4006381333932'));
  const sscc17 = '00629104150000001'; const sscc = sscc17 + gs1CheckDigit(sscc17);
  assert.ok(isValidSSCC(sscc)); assert.equal(sscc.length, 18);
  assert.equal(toGTIN14('036000291452'), '00036000291452');
});

/* ───────── identity & brand ───────── */
test('identity: validation, initials, safe logos, recent list', async () => {
  const v = validateIdentity({ customer: { legalName: '  iBake – Switz Group‮ ', code: 'i', site: 'SM10' } });
  assert.equal(v.value.customer.legalName, 'iBake – Switz Group', 'bidi override stripped, trimmed');
  assert.equal(v.ok, false, 'code too short');
  const ok = validateIdentity({ customer: { legalName: 'Saudi Masterbaker Ltd.', shortName: 'SMB', code: 'smb' } });
  assert.equal(ok.ok, true); assert.equal(ok.value.customer.code, 'SMB');
  assert.equal(initials('Saudi Masterbaker Ltd.'), 'SL');
  assert.equal(initials('مخبز السعودية'), 'ما');
  assert.ok(isSafeLogo('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(!isSafeLogo('data:image/svg+xml,' + encodeURIComponent('<svg onload="alert(1)"/>')));
  assert.ok(!isSafeLogo('https://example.com/logo.png'));
  assert.match(avatarColor('IBK'), /^hsl\(\d+ 62% 36%\)$/);
  const store = await createIdentityStore(createMemoryAdapter());
  await store.set({ ...store.get(), customer: { legalName: 'Saudi Masterbaker Ltd.', shortName: 'SMB', code: 'SMB', site: 'SM3' } });
  assert.equal(store.get().recent[0].code, 'IBK');
});
test('brand: build stamp after brand, credit on the last page only', () => {
  const app = { name: 'PackOS', version: '1.0', year: 2026, build: '20261029' };
  assert.equal(buildStamp(app), 'v1.0 2026 · build 20261029');
  assert.equal(poweredBy(app), 'Powered by rsL PackOS · v1.0 2026 · build 20261029');
  const html = brandBlockHTML(app);
  const order = ['rsl-mono', 'rsl-r', 'rsl-app', 'rsl-by', 'rsl-build'].map((c) => html.indexOf(c));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'monogram → rsL → app → byline → build');
  assert.ok(!footerLines(app, { page: 1, pages: 2 }).includes(BRAND.credit));
  assert.ok(footerLines(app, { page: 2, pages: 2 }).includes(BRAND.credit));
  const a = monogramSVG(), b = monogramSVG();
  assert.notEqual(a.match(/id="([^"]+)"/)[1], b.match(/id="([^"]+)"/)[1], 'unique gradient ids');
  assert.ok(brandBlockHTML({ ...app, name: '<img src=x onerror=1>' }).includes('&lt;img'));
});
test('signature seed matches the p5 viewer mapping', () => {
  assert.equal(seedFromAppCode('PKOS'), 749508);
  assert.equal(seedFromAppCode(' gnf '), 756477);
});
test('platform detection', () => {
  assert.equal(detectPlatform({ __TAURI_INTERNALS__: {}, navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32' } }).shell, 'tauri');
  const ios = detectPlatform({ Capacitor: { isNativePlatform: () => true }, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } });
  assert.deepEqual([ios.shell, ios.os, ios.mobile], ['capacitor', 'ios', true]);
  assert.equal(detectPlatform({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 } }).os, 'ios', 'iPadOS reports Mac');
});

/* ───────── tokens: WCAG contrast ───────── */
test('design tokens meet WCAG 2.2 AA (4.5:1) for text pairs in both themes', () => {
  const L = JSON.parse(readFileSync(new URL('../tokens/rsl.tokens.json', import.meta.url)));
  const D = JSON.parse(readFileSync(new URL('../tokens/rsl.dark.tokens.json', import.meta.url)));
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (t, path) => path.split('.').reduce((o, k) => o[k], t).$value.hex;
  const pairs = [['color.text', 'color.bg'], ['color.text', 'color.surface'], ['color.text-muted', 'color.surface'], ['color.text-muted', 'color.bg'],
    ['color.on-accent', 'color.accent-strong'], ['color.ok', 'color.surface'], ['color.warn', 'color.surface'], ['color.crit', 'color.surface']];
  for (const [fg, bg] of pairs) {
    assert.ok(ratio(hex(L, fg), hex(L, bg)) >= 4.5, `light ${fg} on ${bg}: ${ratio(hex(L, fg), hex(L, bg)).toFixed(2)}`);
    const dfg = D.color[fg.split('.')[1]] ? hex(D, fg) : hex(L, fg); const dbg = D.color[bg.split('.')[1]] ? hex(D, bg) : hex(L, bg);
    assert.ok(ratio(dfg, dbg) >= 4.5, `dark ${fg} on ${bg}: ${ratio(dfg, dbg).toFixed(2)}`);
  }
  assert.ok(ratio(hex(L, 'rsl.meta-on-bar'), hex(L, 'rsl.bar')) >= 4.5);
  assert.ok(ratio(hex(L, 'rsl.meta-on-light'), '#FFFFFF') >= 4.5);
});
