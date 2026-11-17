// WP28 Task 8: AWS Signature Version 4 for S3 on node:crypto, proven against AWS's published examples
// (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html). The credentials below are AWS's public
// documentation examples, not secrets. The vectors are embedded: nothing is fetched. Never edit an expected value to fit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalQuery, canonicalRequest, sha256Hex, signS3Request, stringToSign } from "./s3-sign.mjs";

const ACCESS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const NOW = new Date("2013-05-24T00:00:00Z");
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HOST = "examplebucket.s3.amazonaws.com";
const base = { host: HOST, accessKeyId: ACCESS, secretAccessKey: SECRET, region: "us-east-1", now: NOW };

test("AWS SigV4 \"Example: GET Object\" vector: canonical request, string to sign, signature", () => {
  const headers = { range: "bytes=0-9" };
  const canonical = canonicalRequest({ method: "GET", path: "/test.txt", query: {}, headers: { ...headers, host: HOST, "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" }, payloadHash: EMPTY }).canonical;
  assert.equal(canonical, [
    "GET", "/test.txt", "",
    `host:${HOST}`, "range:bytes=0-9", `x-amz-content-sha256:${EMPTY}`, "x-amz-date:20130524T000000Z", "",
    "host;range;x-amz-content-sha256;x-amz-date", EMPTY,
  ].join("\n"));
  assert.equal(sha256Hex(canonical), "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
  assert.equal(stringToSign("20130524T000000Z", "20130524/us-east-1/s3/aws4_request", canonical), [
    "AWS4-HMAC-SHA256", "20130524T000000Z", "20130524/us-east-1/s3/aws4_request",
    "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  ].join("\n"));
  const out = signS3Request({ ...base, method: "GET", path: "/test.txt", query: {}, headers, payloadHash: EMPTY });
  assert.equal(out.authorization,
    `AWS4-HMAC-SHA256 Credential=${ACCESS}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
  assert.equal(out.host, HOST);
  assert.equal(out["x-amz-date"], "20130524T000000Z");
  assert.equal(out["x-amz-content-sha256"], EMPTY);
});

test("AWS SigV4 \"Example: PUT Object\" vector (path needs encoding, extra signed headers)", () => {
  const payloadHash = sha256Hex("Welcome to Amazon S3.");
  assert.equal(payloadHash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const out = signS3Request({
    ...base, method: "PUT", path: "/test$file.text", query: {}, payloadHash,
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
  });
  assert.match(out.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, /);
  assert.ok(out.authorization.endsWith("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"));
});

test("AWS SigV4 \"Example: GET Bucket (List Objects)\" vector (query string)", () => {
  const out = signS3Request({ ...base, method: "GET", path: "/", query: { "max-keys": "2", prefix: "J" }, headers: {}, payloadHash: EMPTY });
  assert.match(out.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, /);
  assert.ok(out.authorization.endsWith("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"));
});

test("query canonicalisation: keys sorted, / encoded as %2F, RFC 3986 unreserved kept", () => {
  assert.equal(canonicalQuery({ prefix: "rsl-confluence/", "list-type": "2" }), "list-type=2&prefix=rsl-confluence%2F");
  assert.equal(canonicalQuery({ "max-keys": "1000", prefix: "a b!*'()~_.-" }), "max-keys=1000&prefix=a%20b%21%2A%27%28%29~_.-");
  assert.equal(canonicalQuery({}), "");
});

test("the secret never appears in the returned headers", () => {
  const out = signS3Request({ ...base, method: "GET", path: "/", query: {}, headers: {}, payloadHash: EMPTY });
  assert.ok(!JSON.stringify(out).includes(SECRET));
});
