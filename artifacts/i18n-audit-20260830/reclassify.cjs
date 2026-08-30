/**
 * Re-classifies report.json without re-driving the browser.
 *
 * Two corrections to the first pass, both of which changed the numbers:
 *
 *  1. COVERAGE. The first pass called a string HARDCODED whenever ANY source literal of four
 *     characters or more appeared inside it. That is wrong on catalogue data: `אקונומיקה 4 ליטר`
 *     contains `ליטר`, a unit spelling in format.ts, so nineteen product names on /orders/new were
 *     reported as translation holes when they are supplier catalogue rows. A source literal only
 *     explains an on-screen string if it accounts for most of it.
 *
 *  2. SEGMENTS, NOT LITERALS. The first index matched quoted strings and single-line JSX text
 *     only, so a sentence written straight into JSX across two lines with an interpolation in the
 *     middle — Dashboard.tsx:1018 is the case that caught it — was invisible, and its fragments
 *     were reported as database values. Splitting every source line on the characters that can
 *     bound copy catches both shapes with one rule.
 *
 * The result is still a FLOOR. A string the index cannot see is reported as DATA, never the other
 * way round, so the hardcoded count understates rather than overstates.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'artifacts', 'i18n-audit-20260830');
const HEBREW = /[֐-׿]/;
const COVERAGE = 0.6;

function sourceHebrewIndex() {
  const index = new Map();
  const skip = (rel) =>
    rel.includes('/i18n/dictionaries/') || rel === 'src/portal/i18n.ts' || /\.spec\.tsx?$/.test(rel);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (skip(rel)) continue;
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const line of src.split('\n')) {
        if (!HEBREW.test(line)) continue;
        for (const piece of line.split(/[{}<>'"`]/)) {
          const clean = piece.trim().replace(/^[,.;:·—-]+/, '').replace(/[,;:·—-]+$/, '').trim();
          if (clean.length < 2 || !HEBREW.test(clean)) continue;
          if (!index.has(clean)) index.set(clean, new Set());
          index.get(clean).add(rel);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return index;
}

const SOURCE = sourceHebrewIndex();
const KEYS = [...SOURCE.keys()].sort((a, b) => b.length - a.length);

function classify(text) {
  const clean = text.trim();
  if (SOURCE.has(clean)) return { kind: 'HARDCODED', files: [...SOURCE.get(clean)], matched: clean };
  for (const key of KEYS) {
    if (key.length < 4) break;
    if (key.length / clean.length < COVERAGE) continue;
    if (clean.includes(key)) return { kind: 'HARDCODED', files: [...SOURCE.get(key)], matched: key };
  }
  return { kind: 'DATA', files: [], matched: null };
}

const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.raw.json'), 'utf8'));
for (const screen of report) {
  const all = [...screen.hardcoded, ...screen.dataStrings]
    .map((f) => Object.assign({ text: f.text, where: f.where, source: f.source, visible: f.visible },
      classify(f.text)));
  screen.hardcoded = all.filter((f) => f.kind === 'HARDCODED');
  screen.dataStrings = all.filter((f) => f.kind === 'DATA');
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
const distinct = new Set();
for (const s of report) for (const f of s.hardcoded) distinct.add(f.text);
console.log('index segments: ' + SOURCE.size + ' — distinct hardcoded strings on screen: ' + distinct.size);
