/**
 * Which dictionary keys nobody asks for.
 *
 * The audit turned up strings that exist in BOTH dictionaries and are still hardcoded at the call
 * site — `dashboard.remainingToReceive` is translated and unused while `Dashboard.tsx:751` writes
 * the Hebrew literal. That is a different problem from missing translation, and a cheaper one: the
 * English words already exist and were paid for.
 *
 * Approximate by construction: keys resolved dynamically (`status.*`, `errors.*`, and anything
 * built by template) cannot be found by literal search, so those namespaces are excluded rather
 * than reported as orphans. Specs are searched too — a key used only by a test still counts as
 * referenced, which keeps this honest in the conservative direction.
 */
const fs = require('node:fs');
const path = require('node:path');

const he = fs.readFileSync('src/lib/i18n/dictionaries/he.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');

const leaves = [];
let ns = null;
let sub = null;
for (const line of he) {
  let m = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{/);
  if (m) { ns = m[1]; sub = null; continue; }
  m = line.match(/^ {4}([A-Za-z0-9_]+):\s*\{/);
  if (m) { sub = m[1]; continue; }
  if (/^ {4}\},?$/.test(line)) { sub = null; continue; }
  m = line.match(/^\s+([A-Za-z0-9_]+):\s*['"`]/);
  if (m && ns) leaves.push(sub ? ns + '.' + sub + '.' + m[1] : ns + '.' + m[1]);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    if (/\.tsx?$/.test(entry)) files.push(full);
  }
})('src');

let blob = '';
for (const f of files) {
  const rel = f.split(path.sep).join('/');
  if (rel.includes('/i18n/dictionaries/')) continue;
  blob += fs.readFileSync(f, 'utf8') + '\n';
}

const DYNAMIC = new Set(['status', 'errors']);
const quoted = (k) => blob.includes("'" + k + "'") || blob.includes('"' + k + '"') || blob.includes('`' + k + '`');
const orphans = leaves.filter((k) => !DYNAMIC.has(k.split('.')[0]) && !quoted(k));

console.log('leaf keys in he.ts: ' + leaves.length);
console.log('no literal call site anywhere in src: ' + orphans.length);
const byNs = {};
for (const k of orphans) { const n = k.split('.')[0]; byNs[n] = (byNs[n] || 0) + 1; }
for (const [n, c] of Object.entries(byNs).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log('   ' + String(c).padStart(4) + '  ' + n);
}
console.log('samples: ' + orphans.slice(0, 15).join(', '));
fs.writeFileSync('artifacts/i18n-audit-20260830/orphan-keys.json', JSON.stringify(orphans, null, 2), 'utf8');
