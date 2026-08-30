/**
 * Sizes the repair, file by file, by asking the only question that decides the cost:
 *
 *   for every Hebrew string this file still renders, does a dictionary key with that exact value
 *   already exist — and is anything calling it?
 *
 *   MATCHED   the value is in he.ts and en.ts. Re-wiring is `t('<key>')`; no translation needed.
 *   NEW       the value is nowhere in the dictionary. It needs a key AND an English sentence.
 *
 * Deliberately silent about audit reasons, parser vocabulary and stored values: files that
 * `scripts/i18n-baseline.json` documents are reported separately rather than mixed into the work.
 */
const fs = require('node:fs');
const path = require('node:path');

const HEBREW = /[֐-׿]/;
const baseline = JSON.parse(fs.readFileSync('scripts/i18n-baseline.json', 'utf8'));
const EXEMPT = new Set(Object.keys(baseline.__reason));
const orphans = new Set(JSON.parse(fs.readFileSync('artifacts/i18n-audit-20260830/orphan-keys.json', 'utf8')));

/** he.ts value -> key paths, read as text so no module has to be evaluated. */
function dictionaryByValue(file) {
  const lines = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');
  const byValue = new Map();
  let ns = null;
  let sub = null;
  for (const line of lines) {
    let m = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{/);
    if (m) { ns = m[1]; sub = null; continue; }
    m = line.match(/^ {4}([A-Za-z0-9_]+):\s*\{/);
    if (m) { sub = m[1]; continue; }
    if (/^ {4}\},?$/.test(line)) { sub = null; continue; }
    m = line.match(/^\s+([A-Za-z0-9_]+):\s*'((?:[^'\\]|\\.)*)'/);
    if (!m || !ns) continue;
    const value = m[2].replace(/\\'/g, "'");
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push((sub ? ns + '.' + sub + '.' : ns + '.') + m[1]);
  }
  return byValue;
}
const HE = dictionaryByValue('src/lib/i18n/dictionaries/he.ts');

/** Reader-facing Hebrew in one file: quoted literals plus JSX text, minus comments. */
function stringsIn(file) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const found = new Set();
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"([^"\n]*)"/g)) {
    const v = (m[1] ?? m[2] ?? '').replace(/\\'/g, "'").trim();
    if (v.length >= 2 && HEBREW.test(v)) found.add(v);
  }
  for (const line of src.split('\n')) {
    if (!HEBREW.test(line)) continue;
    for (const piece of line.split(/[{}<>'"`]/)) {
      const v = piece.trim().replace(/^[,.;:·—-]+/, '').replace(/[,;:·—-]+$/, '').trim();
      if (v.length >= 2 && HEBREW.test(v)) found.add(v);
    }
  }
  return [...found];
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) files.push(full);
  }
})('src');

const rows = [];
for (const f of files) {
  const rel = f.split(path.sep).join('/');
  if (rel.includes('/i18n/dictionaries/') || rel === 'src/portal/i18n.ts') continue;
  if (rel.startsWith('src/operator/')) continue;
  const strings = stringsIn(f);
  if (!strings.length) continue;
  const matched = [];
  const fresh = [];
  for (const s of strings) {
    const keys = HE.get(s);
    if (keys) matched.push({ text: s, keys, orphan: keys.every((k) => orphans.has(k)) });
    else fresh.push(s);
  }
  rows.push({
    file: rel,
    exempt: EXEMPT.has(rel),
    baselineLines: baseline.counts[rel] ?? 0,
    matched: matched.length,
    orphanMatched: matched.filter((m) => m.orphan).length,
    fresh: fresh.length,
    matchedList: matched,
    freshList: fresh,
  });
}

const work = rows.filter((r) => !r.exempt).sort((a, b) => (b.matched + b.fresh) - (a.matched + a.fresh));
const totals = work.reduce((acc, r) => ({ matched: acc.matched + r.matched, fresh: acc.fresh + r.fresh }), { matched: 0, fresh: 0 });

console.log('files needing work (tenant app, no documented exemption): ' + work.length);
console.log('  strings whose English ALREADY EXISTS in the dictionary: ' + totals.matched);
console.log('  strings needing a new key and a new English sentence:   ' + totals.fresh);
console.log();
console.log('file'.padEnd(60) + 'matched  orphan  new   total');
for (const r of work) {
  if (r.matched + r.fresh === 0) continue;
  console.log(r.file.padEnd(60) + String(r.matched).padStart(7) + String(r.orphanMatched).padStart(8) +
    String(r.fresh).padStart(6) + String(r.matched + r.fresh).padStart(8));
}
console.log();
const exempt = rows.filter((r) => r.exempt);
console.log('documented-exemption files, listed but not work: ' + exempt.length +
  ' (' + exempt.reduce((s, r) => s + r.matched + r.fresh, 0) + ' strings)');

fs.writeFileSync('artifacts/i18n-audit-20260830/worklist.json', JSON.stringify(work, null, 2), 'utf8');
