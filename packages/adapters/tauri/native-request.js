/**
 * WP28 Task 6: native backup HTTP for the desktop shell. `isAllowed` is the app's backup allowlist
 * (isAllowedBackupUrl); `httpFetch` is the Tauri HTTP plugin's fetch, injected by index.js so this module
 * imports no native package. No redirects, no cookies, 15 s connect timeout, responses above 20 MB refused.
 */
const MAX_BYTES = 20 * 1024 * 1024;

export function makeNativeRequest(isAllowed, httpFetch) {
  return async ({ method, url, headers, body, signal }) => {
    if (typeof isAllowed !== 'function' || !isAllowed(url)) throw new Error('Native request refused: URL not on the backup allowlist');
    const res = await httpFetch(url, { method, headers, body, maxRedirections: 0, connectTimeout: 15000, signal });
    const out = {};
    res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    const declared = Number(out['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('too-large-file');
    const text = await res.text();
    if (text.length > MAX_BYTES || (text.length * 3 > MAX_BYTES && new TextEncoder().encode(text).length > MAX_BYTES)) throw new Error('too-large-file');
    return { status: res.status, headers: out, text };
  };
}
