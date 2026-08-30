/**
 * For one source file: every Hebrew string literal it still holds, and the dictionary keys whose
 * value is exactly that string — its own namespace first, since a key from the file's own namespace
 * is almost always the one the extraction produced for that very line.
 *
 *   node artifacts/i18n-audit-20260830/match.cjs <file> <preferred-namespace>
 */
const fs = require('node:fs');
const HEBREW = /[֐-׿]/;
const [file, preferred] = process.argv.slice(2);

function byValue(dict) {
  const lines = fs.readFileSync(dict, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');
  const out = new Map();
  let ns = null;
  let sub = null;
  for (const line of lines) {
    let m = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{/);
    if (m) { ns = m[1]; sub = null; continue; }
    m = line.match(/^ {4}([A-Za-z0-9_]+):\s*\{/);
    if (m) { sub = m[1]; continue; }
    if (/^ {4}\},?$/.test(line)) { sub = null; continue; }
    m = line.match(/^\s+([A-Za-z0-9_]+):\s*'(.*)',?\s*$/);
    if (!m || !ns) continue;
    const key = (sub ? ns + '.' + sub + '.' : ns + '.') + m[1];
    if (!out.has(m[2])) out.set(m[2], []);
    out.get(m[2]).push(key);
  }
  return out;
}
const HE = byValue('src/lib/i18n/dictionaries/he.ts');
const EN = byValue('src/lib/i18n/dictionaries/en.ts');
const enByKey = new Map();
for (const [value, keys] of EN) for (const k of keys) enByKey.set(k, value);

const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const seen = new Set();
for (const line of src.split('\n')) {
  if (!HEBREW.test(line)) continue;
  for (const piece of line.split(/[{}<>'"`]/)) {
    const v = piece.trim().replace(/^[,.;:·—-]+/, '').replace(/[,;:·—-]+$/, '').trim();
    if (v.length < 2 || !HEBREW.test(v) || seen.has(v)) continue;
    seen.add(v);
    const keys = HE.get(v) ?? [];
    const own = keys.filter((k) => k.startsWith(preferred + '.'));
    const pick = own[0] ?? keys[0];
    console.log((pick ? '  ' : '?? ') + JSON.stringify(v));
    if (pick) console.log('      -> ' + own.join(' | ') + (own.length ? '' : keys.slice(0, 3).join(' | ')) + '   EN: ' + JSON.stringify(enByKey.get(pick) ?? '—'));
  }
}
