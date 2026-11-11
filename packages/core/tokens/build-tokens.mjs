#!/usr/bin/env node
/**
 * build-tokens.mjs — rsL Core Kit · v1.0 2026
 * Reads DTCG 2025.10 token files and writes rsl-tokens.css (light on :root, dark in the
 * three-state pattern: prefers-color-scheme guarded by :not([data-theme=light]) + [data-theme=dark]).
 * Zero dependencies. Style Dictionary v5 can consume the same .tokens.json files for iOS/Android outputs.
 *   node tokens/build-tokens.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, 'rsl.tokens.json'), 'utf8'));
const dark = JSON.parse(readFileSync(join(here, 'rsl.dark.tokens.json'), 'utf8'));

function flatten(node, path = [], out = {}, inheritedType) {
  const type = node.$type || inheritedType;
  if (Object.prototype.hasOwnProperty.call(node, '$value')) { out[path.join('-')] = { type, value: node.$value }; return out; }
  for (const [k, v] of Object.entries(node)) if (!k.startsWith('$') && v && typeof v === 'object') flatten(v, [...path, k], out, type);
  return out;
}

function resolve(value, all) {
  if (typeof value === 'string' && /^\{[^}]+\}$/.test(value)) {
    const ref = value.slice(1, -1).split('.').join('-');
    if (!all[ref]) throw new Error(`Unresolved reference ${value}`);
    return `var(--${ref})`;
  }
  return null;
}

function css(t, all) {
  const ref = resolve(t.value, all);
  if (ref) return ref;
  const v = t.value;
  switch (t.type) {
    case 'color': return typeof v === 'string' ? v : (v.alpha !== undefined && v.alpha < 1
      ? `rgb(${v.components.map((c) => Math.round(c * 255)).join(' ')} / ${v.alpha})` : v.hex);
    case 'dimension': case 'duration': return `${v.value}${v.unit}`;
    case 'fontFamily': return (Array.isArray(v) ? v : [v]).map((f) => (/[\s"]/.test(f) && !/^[a-z-]+$/.test(f) ? `"${f}"` : f)).join(', ');
    case 'cubicBezier': return `cubic-bezier(${v.join(', ')})`;
    case 'fontWeight': case 'number': return String(v);
    default: return String(v);
  }
}

const L = flatten(base), D = flatten(dark);
const all = { ...L };
const block = (map) => Object.entries(map).map(([k, t]) => `  --${k}: ${css(t, all)};`).join('\n');

const out = `/* rsl-tokens.css — GENERATED from rsl.tokens.json + rsl.dark.tokens.json (DTCG 2025.10). Do not edit by hand. */
:root {
${block(L)}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${block(D).replace(/^/gm, '  ')}
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${block(D)}
  color-scheme: dark;
}
`;
writeFileSync(join(here, 'rsl-tokens.css'), out);
console.log(`rsl-tokens.css: ${Object.keys(L).length} tokens, ${Object.keys(D).length} dark overrides`);
