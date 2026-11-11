import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogHash } from "../apps/confluence/web/scripts/catalog-status.mjs";
import { approvalsNeeded, checkApprovals } from "./check-certification-pr.mjs";

const msgs = { "paper.banner": "B", "status.disclaimer": "D", "a.b": "x" };
const cert = (m = msgs, extra = {}) => ({ ...m, "@status": "CERTIFIED", "@reviewer": "Rev Name", "@reviewerGithub": "rev", "@certifiedAt": "2026-11-07", "@certifiedHash": catalogHash(m), ...extra });
const mc = (m = msgs) => ({ ...m, "@status": "MACHINE-CHECKED" });
const lock = { fr: { "paper.banner": "h1", "status.disclaimer": "h2" } };
const APPROVED = (user, extra = {}) => ({ state: "APPROVED", user, commitId: "HEAD", association: "COLLABORATOR", ...extra });

test("newly certifying a language needs its named reviewer", () => {
  assert.deepEqual(approvalsNeeded({ base: { fr: mc() }, head: { fr: cert() }, baseLock: lock, headLock: lock }).map((n) => [n.code, n.reviewer]), [["fr", "rev"]]);
});

test("editing a certified catalog and recomputing its hash still needs the reviewer (I2 bypass)", () => {
  const edited = { ...msgs, "a.b": "changed" };
  const needs = approvalsNeeded({ base: { fr: cert() }, head: { fr: cert(edited) }, baseLock: lock, headLock: lock });
  assert.deepEqual(needs.map((n) => n.code), ["fr"]);
});

test("changing the named reviewer or certification fields of a certified catalog needs approval", () => {
  const needs = approvalsNeeded({ base: { fr: cert() }, head: { fr: cert(msgs, { "@reviewerGithub": "friend" }) }, baseLock: lock, headLock: lock });
  assert.deepEqual(needs.map((n) => [n.code, n.reviewer]), [["fr", "friend"]]);
});

test("an untouched certified catalog, or stepping back to MACHINE-CHECKED, needs nothing", () => {
  assert.deepEqual(approvalsNeeded({ base: { fr: cert() }, head: { fr: cert() }, baseLock: lock, headLock: lock }), []);
  assert.deepEqual(approvalsNeeded({ base: { fr: cert() }, head: { fr: mc({ ...msgs, "a.b": "y" }) }, baseLock: lock, headLock: lock }), []);
});

test("a renewed safety lock entry needs approval; entries new to the lock do not", () => {
  const renewed = { fr: { "paper.banner": "other", "status.disclaimer": "h2" } };
  assert.deepEqual(approvalsNeeded({ base: { fr: mc() }, head: { fr: mc() }, baseLock: lock, headLock: renewed }).map((n) => [n.code, n.reviewer]), [["fr", null]]);
  assert.deepEqual(approvalsNeeded({ base: { fr: mc() }, head: { fr: mc() }, baseLock: null, headLock: lock }), []);
});

test("the named reviewer's approval on the head commit passes", () => {
  assert.equal(checkApprovals({ needs: [{ code: "fr", reviewer: "rev", why: "x" }], reviews: [APPROVED("Rev")], author: "owner", headSha: "HEAD" }).ok, true);
});

test("an approval from someone else, on an older commit, or by a non-collaborator fails", () => {
  const needs = [{ code: "fr", reviewer: "rev", why: "x" }];
  assert.equal(checkApprovals({ needs, reviews: [APPROVED("other")], author: "owner", headSha: "HEAD" }).ok, false);
  assert.equal(checkApprovals({ needs, reviews: [APPROVED("rev", { commitId: "OLD" })], author: "owner", headSha: "HEAD" }).ok, false);
  assert.equal(checkApprovals({ needs, reviews: [APPROVED("rev", { association: "NONE" })], author: "owner", headSha: "HEAD" }).ok, false);
});

test("the reviewer cannot be the PR author, and a later change request withdraws an approval", () => {
  assert.equal(checkApprovals({ needs: [{ code: "fr", reviewer: "rev", why: "x" }], reviews: [APPROVED("rev")], author: "rev", headSha: "HEAD" }).ok, false);
  const withdrawn = [APPROVED("rev"), { state: "COMMENTED", user: "rev", commitId: "HEAD", association: "COLLABORATOR" }, { state: "CHANGES_REQUESTED", user: "rev", commitId: "HEAD", association: "COLLABORATOR" }];
  assert.equal(checkApprovals({ needs: [{ code: "fr", reviewer: "rev", why: "x" }], reviews: withdrawn, author: "owner", headSha: "HEAD" }).ok, false);
});

test("a lock renewal without a named reviewer accepts any collaborator other than the author", () => {
  const needs = [{ code: "fr", reviewer: null, why: "lock" }];
  assert.equal(checkApprovals({ needs, reviews: [APPROVED("someone")], author: "owner", headSha: "HEAD" }).ok, true);
  assert.equal(checkApprovals({ needs, reviews: [APPROVED("owner")], author: "owner", headSha: "HEAD" }).ok, false);
});

test("nothing to approve passes", () => {
  assert.equal(checkApprovals({ needs: [], reviews: [], author: "owner", headSha: "HEAD" }).ok, true);
});
