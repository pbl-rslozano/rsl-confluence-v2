import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./store.mjs";

export function evaluateWorkspaceAlerts(outDir, catchUp, live, ranking) {
  const deployment = readJson(join(outDir, "workspace-rules.json"), null);
  if (deployment?.version !== 1 || !Array.isArray(deployment.rules)) return 0;
  const rules = deployment.rules.filter((rule) => rule && /^[\w-]{1,80}$/.test(rule.id) &&
    typeof rule.source === "string" && typeof rule.timeframe === "string" &&
    Array.isArray(rule.symbols) && (rule.kind === "rank-rise"
      ? Number.isInteger(rule.threshold) && rule.threshold >= 1 && rule.threshold < 300
      : (rule.kind === undefined || rule.kind === "score-crossing") && Number.isFinite(rule.threshold) && rule.threshold >= -100 && rule.threshold <= 100));
  const path = join(outDir, "workspace-inbox.json");
  const saved = readJson(path, { version: 1, cursors: {}, events: [] });
  const cursors = {};
  const events = saved.events;
  let added = 0;
  const liveRows = live.map((item) => item.row);
  const ranks = new Map(ranking?.symbols.map((symbol, i) => [symbol, i + 1]));
  const universe = ranking && ranks.size > 1 && ranks.size === ranking.symbols.length
    ? createHash("sha256").update(JSON.stringify([...ranks.keys()].sort())).digest("hex") : null;

  for (const rule of rules) {
    for (const symbol of new Set(rule.symbols)) {
      if (typeof symbol !== "string" || !/^[A-Z0-9]{2,30}$/.test(symbol)) continue;
      const rankRule = rule.kind === "rank-rise";
      const key = [rule.id, rule.source, rule.timeframe, symbol, rule.threshold].join("|") + (rankRule ? "|rank-rise" : "");
      let cursor = saved.cursors[key];
      if (rankRule) {
        const rank = ranks.get(symbol);
        const row = universe && rank && liveRows.find((item) => item.t === ranking.bar && item.src === rule.source &&
          item.tf === rule.timeframe && item.pair === symbol && !item.sup && Number.isFinite(item.sc));
        if (row && (!cursor || row.t > cursor.t)) {
          if (cursor && cursor.universe === universe && cursor.cfg === row.cfg &&
              cursor.t + ranking.intervalMs === row.t && cursor.rank - rank >= rule.threshold) {
            events.push({ id: key + "|" + row.t, ruleId: rule.id, kind: "rank-rise", previousRank: cursor.rank, rank,
              src: row.src, tf: row.tf, pair: row.pair, barOpen: row.t, barClose: row.tc, score: row.sc, cfg: row.cfg });
            added++;
          }
          cursor = { t: row.t, rank, universe, cfg: row.cfg };
        }
        if (cursor) cursors[key] = cursor;
        continue;
      }
      for (const [items, canAlert] of [[catchUp, false], [liveRows, true]]) {
        for (const row of items) {
          if (row.src !== rule.source || row.tf !== rule.timeframe || row.pair !== symbol ||
              row.sup || !Number.isFinite(row.sc) || (cursor && row.t <= cursor.t)) continue;
          if (canAlert && cursor && cursor.cfg === row.cfg && cursor.score < rule.threshold && row.sc >= rule.threshold) {
            events.push({ id: key + "|" + row.t, ruleId: rule.id, src: row.src, tf: row.tf, pair: row.pair,
              barOpen: row.t, barClose: row.tc, score: row.sc, cfg: row.cfg });
            added++;
          }
          cursor = { t: row.t, score: row.sc, cfg: row.cfg };
        }
      }
      if (cursor) cursors[key] = cursor;
    }
  }

  writeJsonAtomic(path, { version: 1, revision: deployment.revision ?? null, cursors, events: events.slice(-5000) });
  return added;
}
