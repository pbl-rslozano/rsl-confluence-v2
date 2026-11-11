#!/usr/bin/env node
// check-certification-pr.mjs — v2.5 (WP4). Human sign-off for translations, enforced on every pull request.
//
// Compared with the PR base, an approval is needed when:
//   • a catalog is CERTIFIED at head and is newly certified, or its messages (catalogHash) or any
//     @reviewer / @reviewerGithub / @certified* field changed → the head's @reviewerGithub must approve;
//   • a language's entry in tools/i18n-safety-lock.json changed (a safety statement was re-worded)
//     → that language's @reviewerGithub if it is CERTIFIED, otherwise any collaborator other than the author.
// A counting approval is the reviewer's latest decisive review, APPROVED, on the PR head commit, by an
// OWNER/MEMBER/COLLABORATOR who is not the PR author. Entries new to the lock (no base entry) need nothing.
//
// CI: .github/workflows/i18n-certification.yml (pull_request + pull_request_review), GITHUB_TOKEN read-only.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogHash } from "../apps/confluence/web/scripts/catalog-status.mjs";

const CERT_FIELDS = ["@status", "@reviewer", "@reviewerGithub", "@certifiedAt", "@certifiedHash"];
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which languages need a human approval in this PR. `base`/`head`: { code: catalog }; locks may be null. */
export function approvalsNeeded({ base, head, baseLock, headLock }) {
  const needs = [];
  for (const code of Object.keys(head).sort()) {
    const now = head[code], was = base[code];
    const certified = now["@status"] === "CERTIFIED";
    const reviewer = certified ? now["@reviewerGithub"] ?? null : null;
    if (certified) {
      const why = !was || was["@status"] !== "CERTIFIED" ? "newly certified"
        : catalogHash(now) !== catalogHash(was) ? "certified messages changed"
        : CERT_FIELDS.some((f) => !same(now[f], was[f])) ? "certification fields changed" : null;
      if (why) { needs.push({ code, reviewer, why }); continue; }
    }
    if (baseLock?.[code] && !same(baseLock[code], headLock?.[code])) needs.push({ code, reviewer, why: "safety statement lock renewed" });
  }
  return needs;
}

const DECISIVE = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
/** Each user's latest decisive review (COMMENTED reviews do not withdraw an approval). Logins compared case-insensitively. */
function latestDecisive(reviews) {
  const by = new Map();
  for (const r of reviews) if (r.user && DECISIVE.has(r.state)) by.set(r.user.toLowerCase(), r);
  return by;
}

/** @param {{needs: {code:string, reviewer:string|null, why:string}[], reviews: {state:string, user:string, commitId:string, association:string}[], author:string, headSha:string}} o */
export function checkApprovals({ needs, reviews, author, headSha }) {
  if (!needs.length) return { ok: true, reasons: ["no certification or safety-lock change"] };
  const auth = (author ?? "").toLowerCase();
  const valid = [...latestDecisive(reviews).entries()]
    .filter(([login, r]) => r.state === "APPROVED" && r.commitId === headSha && TRUSTED.has(r.association) && login !== auth)
    .map(([login]) => login);
  const reasons = []; let ok = true;
  for (const n of needs) {
    const want = n.reviewer?.toLowerCase() ?? null;
    const by = want ? valid.filter((l) => l === want) : valid;
    if (want && want === auth) { ok = false; reasons.push(`${n.code} (${n.why}): the reviewer @${n.reviewer} is the PR author — a reviewer cannot approve their own PR`); }
    else if (by.length) reasons.push(`${n.code} (${n.why}): approved by @${by.join(", @")} on ${headSha.slice(0, 7)}`);
    else { ok = false; reasons.push(`${n.code} (${n.why}): needs an approval on the head commit ${headSha.slice(0, 7)} from ${want ? `@${n.reviewer}` : "a collaborator other than the author"}`); }
  }
  return { ok, reasons };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr, BASE_SHA: baseSha, HEAD_SHA: headSha } = process.env;
  if (!repo || !pr || !baseSha || !headSha) { console.error("needs GITHUB_REPOSITORY, PR_NUMBER, BASE_SHA, HEAD_SHA"); process.exit(2); }
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const show = (sha, path) => { try { return JSON.parse(git("show", `${sha}:${path}`)); } catch { return null; } };
  const dir = "apps/confluence/web/src/rsl/i18n/";
  const catalogs = (sha) => Object.fromEntries(git("ls-tree", "--name-only", `${sha}:${dir}`).split("\n").filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), show(sha, dir + f)]).filter(([, c]) => c));
  const needs = approvalsNeeded({ base: catalogs(baseSha), head: catalogs(headSha), baseLock: show(baseSha, "tools/i18n-safety-lock.json"), headLock: show(headSha, "tools/i18n-safety-lock.json") });
  // --slurp: one JSON array of pages, so more than 30 reviews still parse.
  const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/reviews`], { encoding: "utf8" }));
  const reviews = pages.flat().map((r) => ({ state: r.state, user: r.user?.login, commitId: r.commit_id, association: r.author_association }));
  const author = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/pulls/${pr}`], { encoding: "utf8" })).user?.login;
  const r = checkApprovals({ needs, reviews, author, headSha });
  for (const line of r.reasons) console.log(`${r.ok ? "PASS" : "FAIL"}  i18n sign-off: ${line}`);
  process.exit(r.ok ? 0 : 1);
}
