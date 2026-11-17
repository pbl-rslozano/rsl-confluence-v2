/**
 * AWS Signature Version 4 for S3 (service "s3"), on node:crypto only. Used by backup-store.mjs for Backblaze B2 and
 * Cloudflare R2 (both speak the S3 API). Proven against AWS's published examples in s3-sign.test.mjs.
 *
 * Nothing here logs, throws or returns the secret key: the only output is the four request headers.
 */
import { createHash, createHmac } from "node:crypto";

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding: only A-Z a-z 0-9 - . _ ~ stay literal. */
export function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** S3 canonical URI: every segment encoded once, slashes kept. */
export const encodePath = (path) => String(path).split("/").map(uriEncode).join("/");

/** Keys and values RFC 3986-encoded, sorted by encoded key (then value). */
export function canonicalQuery(query = {}) {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v ?? "")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function canonicalRequest({ method, path, query, headers, payloadHash }) {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const canonical = [
    method.toUpperCase(),
    encodePath(path),
    canonicalQuery(query),
    ...entries.map(([k, v]) => `${k}:${v}`),
    "", // blank line closes the canonical headers
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonical, signedHeaders };
}

export const stringToSign = (amzDate, scope, canonical) => ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");

/**
 * @returns the headers to send: host, x-amz-date, x-amz-content-sha256 and authorization (the caller adds its own
 *          other headers, which must be the ones passed in `headers` so they are signed).
 */
export function signS3Request({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const sent = { host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const { canonical, signedHeaders } = canonicalRequest({ method, path, query, headers: { ...headers, ...sent }, payloadHash });
  let key = hmac("AWS4" + secretAccessKey, day);
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(stringToSign(amzDate, scope, canonical)).digest("hex");
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
