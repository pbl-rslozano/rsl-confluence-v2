/**
 * trials.mjs — the trials register: <data>/trials.jsonl, append-only.
 *
 * This is the server's ONLY write. It never truncates, rewrites, renames or
 * deletes; each call appends exactly one JSON line. A later decision about a
 * trial is a new line whose `ref` points to the earlier id. The file is
 * opened with O_APPEND (and O_NOFOLLOW where the OS supports it) and must be
 * a regular file inside the data directory.
 *
 * Record: { id, at, hypothesis, config, metric, decision, ref? }
 */
import { openSync, writeSync, fsyncSync, closeSync, readSync, constants, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readJsonl } from "./readers.mjs";
import { PathError } from "./data-dir.mjs";

export const TRIALS_FILE = "trials.jsonl";
export const DECISIONS = ["pending", "accept", "reject", "inconclusive", "abandoned"];

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ID = /^T\d{4,}-[0-9a-f]{4}$/;

function checkText(name, v, min, max) {
  if (typeof v !== "string") throw new TypeError(`${name} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new RangeError(`${name} must be ${min}–${max} characters`);
  if (CONTROL.test(s)) throw new TypeError(`${name} contains control characters`);
  return s;
}

function checkConfig(v) {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TypeError("config must be a JSON object");
  const json = JSON.stringify(v);
  if (json.length > 4096) throw new RangeError("config must serialise to at most 4096 bytes");
  const depth = (o, d) => {
    if (d > 6) throw new RangeError("config is nested too deeply (max 6)");
    if (o && typeof o === "object") for (const x of Object.values(o)) depth(x, d + 1);
  };
  depth(v, 1);
  return JSON.parse(json); // drop undefined, functions, prototypes
}

/** Validate a caller's trial and return the record fields (without id/at). */
export function validateTrial(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("trial must be an object");
  const allowed = new Set(["hypothesis", "config", "metric", "decision", "ref"]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) throw new TypeError(`unknown field: ${k} (id and at are set by the server)`);
  const out = {
    hypothesis: checkText("hypothesis", input.hypothesis, 10, 2000),
    config: checkConfig(input.config),
    metric: checkText("metric", input.metric, 2, 300),
    decision: input.decision ?? "pending",
  };
  if (!DECISIONS.includes(out.decision)) throw new RangeError(`decision must be one of ${DECISIONS.join(", ")}`);
  if (input.ref !== undefined) {
    if (typeof input.ref !== "string" || !ID.test(input.ref)) throw new TypeError("ref must be an existing trial id such as T0003-9f2c");
    out.ref = input.ref;
  }
  return out;
}

/** Read the register (newest last). Malformed lines are counted, never repaired. */
export async function readTrials(dataDir) {
  const abs = dataDir.resolve(TRIALS_FILE);
  if (!existsSync(abs)) return { trials: [], bad: 0, exists: false };
  const st = statSync(abs);
  if (!st.isFile()) throw new PathError("trials.jsonl is not a regular file");
  const { items, bad } = await readJsonl(abs, { maxBytes: dataDir.limits.maxTrialsBytes, map: (o) => (o && typeof o === "object" && typeof o.id === "string" ? o : null) });
  return { trials: items, bad, exists: true };
}

/**
 * Hypotheses tested so far, for the deflated Sharpe ratio. One counting rule
 * for the app, replay and MCP (v2.3 review C12): records without `ref`,
 * de-duplicated by `variant` when present (replay/app records), else by `id`.
 */
export const countHypotheses = (trials) =>
  new Set(trials.filter((t) => !t.ref).map((t) => (typeof t.variant === "string" ? `v:${t.variant}` : `i:${t.id}`))).size;

/** Append one trial. Returns the stored record. */
export async function appendTrial(dataDir, input, now = new Date()) {
  const fields = validateTrial(input);
  const abs = dataDir.resolve(TRIALS_FILE);
  const st = dataDir.lstat(abs);
  if (st && st.isSymbolicLink()) throw new PathError("trials.jsonl is a symbolic link; refusing to write through it");
  if (st && !st.isFile()) throw new PathError("trials.jsonl is not a regular file");
  if (st && st.size >= dataDir.limits.maxTrialsBytes) throw new PathError("trials.jsonl has reached its size limit; archive it by hand");
  const { trials } = await readTrials(dataDir);
  if (fields.ref && !trials.some((t) => t.id === fields.ref)) throw new RangeError(`ref ${fields.ref} is not in the register`);
  const seq = trials.length + 1;
  const record = { id: `T${String(seq).padStart(4, "0")}-${randomBytes(2).toString("hex")}`, at: now.toISOString(), ...fields };
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(abs, flags, 0o600);
  try {
    // If a previous writer left no trailing newline, start on a fresh line (no existing byte is changed).
    let prefix = "";
    const size = statSync(abs).size;
    if (size > 0) {
      const rfd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const last = Buffer.alloc(1);
        readSync(rfd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally { closeSync(rfd); }
    }
    writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
    // Best effort: Node's permission model disables fsync; the append itself has already happened.
    try { fsyncSync(fd); } catch { /* not durable-flushed, still appended */ }
  } finally {
    closeSync(fd);
  }
  return record;
}
