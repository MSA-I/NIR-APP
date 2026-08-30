/**
 * How much of the Hebrew still on screen is ALREADY translated and simply not asked for.
 *
 * For every hardcoded string the audit saw, look for its exact Hebrew value in he.ts. If it is
 * there, read the English at the same key path out of en.ts. A hit means the words exist, in both
 * languages, and the screen renders a literal beside them.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(process.cwd(), 'artifacts', 'i18n-audit-20260830');
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
const orphans = new Set(JSON.parse(fs.readFileSync(path.join(OUT, 'orphan-keys.json'), 'utf8')));

/** value -> [key paths], read straight off the dictionary text so no module has to be evaluated. */
function dictionaryByValue(file) {
  const lines = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');
  const byValue = new Map();
  const byKey = new Map();
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
    const keyPath = (sub ? ns + '.' + sub + '.' : ns + '.') + m[1];
    const value = m[2].replace(/\\'/g, "'");
    byKey.set(keyPath, value);
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(keyPath);
  }
  return { byValue, byKey };
}

const HE = dictionaryByValue('src/lib/i18n/dictionaries/he.ts');
const EN = dictionaryByValue('src/lib/i18n/dictionaries/en.ts');

const seen = new Map();
for (const screen of report) {
  for (const f of screen.hardcoded) {
    if (!f.visible) continue;
    if (!seen.has(f.text)) seen.set(f.text, { screens: new Set(), files: f.files });
    seen.get(f.text).screens.add(screen.name);
  }
}

const hits = [];
const misses = [];
for (const [text, meta] of seen) {
  const keys = HE.byValue.get(text);
  if (!keys) { misses.push({ text, meta }); continue; }
  const orphanKeys = keys.filter((k) => orphans.has(k));
  hits.push({ text, keys, orphanKeys, english: keys.map((k) => EN.byKey.get(k)).filter(Boolean), meta });
}

console.log('visible hardcoded strings: ' + seen.size);
console.log('  already in he.ts (so an English value exists at the same key): ' + hits.length);
console.log('  of those, every key is an orphan nothing calls: ' +
  hits.filter((h) => h.orphanKeys.length === h.keys.length).length);
console.log('  not in the dictionary at all — genuinely untranslated: ' + misses.length);
console.log();
console.log('--- already translated, screen renders the literal anyway ---');
for (const h of hits.slice(0, 30)) {
  console.log('  "' + h.text + '"  ->  ' + h.keys[0] + (h.orphanKeys.length ? ' [orphan]' : '') +
    '  EN: "' + (h.english[0] ?? '—') + '"');
}
console.log();
console.log('--- not in the dictionary ---');
for (const m of misses.slice(0, 30)) console.log('  "' + m.text + '"  <- ' + m.meta.files.join(', '));

fs.writeFileSync(path.join(OUT, 'already-translated.json'),
  JSON.stringify({ hits, misses: misses.map((m) => ({ text: m.text, files: m.meta.files })) }, null, 2), 'utf8');
