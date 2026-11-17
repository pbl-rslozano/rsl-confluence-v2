/**
 * WP28 Task 6: native backup HTTP for the phone shell. `isAllowed` is the app's backup allowlist; `request` is
 * CapacitorHttp.request, injected by index.js so this module imports no native package. The allowlist is
 * checked before every request (native HTTP is not policed by the CSP). Redirects are disabled and responses
 * above 20 MB are refused.
 */
const MAX_BYTES = 20 * 1024 * 1024;

export function makeNativeRequest(isAllowed, request) {
  return async ({ method, url, headers, body, signal }) => {
    if (typeof isAllowed !== 'function' || !isAllowed(url)) throw new Error('Native request refused: URL not on the backup allowlist');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await request({ url, method, headers, data: body, responseType: 'text', connectTimeout: 15000, readTimeout: 60000, disableRedirects: true });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const out = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) out[k.toLowerCase()] = String(v);
    const declared = Number(out['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('too-large-file');
    const text = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data);
    if (text.length > MAX_BYTES || (text.length * 3 > MAX_BYTES && new TextEncoder().encode(text).length > MAX_BYTES)) throw new Error('too-large-file');
    return { status: res.status, headers: out, text };
  };
}
