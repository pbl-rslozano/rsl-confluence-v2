/**
 * data-dir.mjs — every file the server touches goes through here.
 *
 * Rules:
 *   • Paths are relative to the data directory. Absolute paths, NUL bytes,
 *     drive letters and backslash tricks are rejected before touching the disk.
 *   • The resolved real path (symlinks followed) must stay inside the real
 *     data directory, so a symlink cannot point the server somewhere else.
 *   • Reads are size-limited; directory walks are depth- and count-limited.
 *   • The only write is an append to trials.jsonl (see trials.mjs).
 */
import { realpathSync, statSync, lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, dirname, basename } from "node:path";

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathError";
  }
}

const MB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  /** Largest single JSONL/CSV file streamed (ledger month, rankings, export). */
  maxStreamBytes: 512 * MB,
  /** Largest JSON document parsed in one piece (candles, JSON export, heartbeat). */
  maxJsonBytes: 64 * MB,
  /** Largest heartbeat.json. */
  maxHeartbeatBytes: 1 * MB,
  /** Largest trials.jsonl the server will read or append to. */
  maxTrialsBytes: 16 * MB,
  /** Most ledger rows held in memory across all files. */
  maxRows: 3_000_000,
  /** Most files visited by one directory walk. */
  maxWalkFiles: 20_000,
  /** Deepest directory walk below its start. */
  maxWalkDepth: 6,
});

export class DataDir {
  /**
   * @param {string} dir  data directory (must exist)
   * @param {Partial<typeof DEFAULT_LIMITS>} limits
   */
  constructor(dir, limits = {}) {
    if (typeof dir !== "string" || !dir) throw new PathError("No data directory given (use --data or CONFLUENCE_DATA_DIR).");
    if (!existsSync(dir)) throw new PathError(`Data directory does not exist: ${dir}`);
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) throw new PathError(`Data path is not a directory: ${dir}`);
    this.root = real;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** True when `abs` (already real) is the root or below it. */
  contains(abs) {
    const rel = relative(this.root, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
  }

  /**
   * Validate a caller-supplied relative path and return its absolute form.
   * Does not require the file to exist; when it exists, symlinks are resolved
   * and checked as well.
   */
  resolve(relPath) {
    if (typeof relPath !== "string" || relPath.length === 0) throw new PathError("Path must be a non-empty string.");
    if (relPath.length > 1024) throw new PathError("Path is too long.");
    if (relPath.includes("\0")) throw new PathError("Path contains a NUL byte.");
    if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith("\\") || relPath.startsWith("/")) {
      throw new PathError("Absolute paths are not accepted; give a path relative to the data directory.");
    }
    const normalised = relPath.replace(/\\/g, "/");
    if (normalised.split("/").some((part) => part === "..")) throw new PathError("Path may not contain '..' segments.");
    const abs = resolve(this.root, normalised);
    if (!this.contains(abs)) throw new PathError("Path escapes the data directory.");
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      if (!this.contains(real)) throw new PathError("Path resolves (via a link) outside the data directory.");
      return real;
    }
    // Not created yet: the nearest existing parent must still be inside.
    let parent = dirname(abs);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!this.contains(realpathSync(parent))) throw new PathError("Path's parent resolves outside the data directory.");
    return abs;
  }

  /** Path relative to the data dir, with forward slashes (for reports). */
  rel(abs) {
    return relative(this.root, abs).split(sep).join("/");
  }

  /** stat of an existing file inside the data dir, or null. */
  statFile(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    return st.isFile() ? { abs, size: st.size, mtimeMs: st.mtimeMs } : null;
  }

  /** Read a whole small file as UTF-8, refusing anything over `maxBytes`. */
  readText(relPath, maxBytes = this.limits.maxJsonBytes) {
    const st = this.statFile(relPath);
    if (!st) throw new PathError(`File not found: ${relPath}`);
    if (st.size > maxBytes) throw new PathError(`File too large (${st.size} bytes > ${maxBytes}): ${relPath}`);
    return readFileSync(st.abs, "utf8");
  }

  /**
   * Walk a sub-directory (relative) and return files whose name matches `test`.
   * Symlinked entries are followed only when they resolve inside the data dir.
   * @returns {{ files: { abs: string, rel: string, size: number, mtimeMs: number }[], truncated: boolean }}
   */
  walk(relDir, test = () => true, { maxDepth = this.limits.maxWalkDepth, maxFiles = this.limits.maxWalkFiles } = {}) {
    let start;
    try { start = this.resolve(relDir); } catch { return { files: [], truncated: false }; }
    if (!existsSync(start) || !statSync(start).isDirectory()) return { files: [], truncated: false };
    const out = [];
    let truncated = false;
    let visited = 0;
    const seen = new Set();
    const visit = (dir, depth) => {
      if (truncated || depth > maxDepth || seen.has(dir)) return;
      seen.add(dir);
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (++visited > maxFiles) { truncated = true; return; }
        if (e.name.startsWith(".")) continue;
        let p = join(dir, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const real = realpathSync(p);
            if (!this.contains(real)) continue;
            const st = statSync(real);
            p = real; isDir = st.isDirectory(); isFile = st.isFile();
          } catch { continue; }
        }
        if (isDir) visit(p, depth + 1);
        else if (isFile && test(e.name, p)) {
          const st = statSync(p);
          out.push({ abs: p, rel: this.rel(p), size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    visit(start, 0);
    return { files: out, truncated };
  }

  /** lstat that never follows a link (used before appending). */
  lstat(abs) {
    try { return lstatSync(abs); } catch { return null; }
  }

  base(abs) {
    return basename(abs);
  }
}
