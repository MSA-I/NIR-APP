/**
 * Turns report.json into the appendix of FINDINGS.md: the per-screen ranking, what a reader in
 * English actually sees on each screen, and the file worklist the extractor would be pointed at.
 *
 * The narrative half of FINDINGS.md is written by hand and lives in narrative.md; this appends to
 * it rather than replacing it, so re-running the audit refreshes the numbers without eating the
 * analysis.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(process.cwd(), 'artifacts', 'i18n-audit-20260830');
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'i18n-baseline.json'), 'utf8'));
const EXEMPT = new Set(Object.keys(baseline.__reason));

const lines = [];
const say = (s) => lines.push(s === undefined ? '' : s);

const screens = report.map((r) => ({ ...r, visibleHard: r.hardcoded.filter((f) => f.visible) }));
const distinct = new Set();
for (const s of screens) for (const f of s.hardcoded) distinct.add(f.text);

say('## Appendix A — every route walked');
say();
say('`hardcoded` = the string exists as a literal in `src/` outside the dictionaries, so it renders');
say('in Hebrew whatever the reader chose. `data` = not in the source; it came out of the database.');
say('Counts are distinct strings per screen, so the same header on ten rows counts once.');
say();
say('| screen | route | hardcoded | visible | data | screenshot |');
say('|---|---|---:|---:|---:|---|');
for (const s of [...screens].sort((a, b) => b.hardcoded.length - a.hardcoded.length)) {
  say('| ' + s.name + ' | `' + s.route + '` | ' + s.hardcoded.length + ' | ' + s.visibleHard.length +
      ' | ' + s.dataStrings.length + ' | `' + path.basename(s.shot) + '` |');
}
say();
const visible = new Set();
for (const s of screens) for (const f of s.visibleHard) visible.add(f.text);
say('Totals: **' + report.length + '** routes, **' + distinct.size + '** distinct hardcoded strings of which **' +
    visible.size + '** rendered visible, **' +
    screens.filter((s) => s.hardcoded.length === 0).length + '** screens with none.');
say();

say('## Appendix B — what an English reader sees, screen by screen');
say();
say('Visible strings only, ordered worst first. Screens with nothing visible are omitted.');
say();
for (const s of [...screens].sort((a, b) => b.visibleHard.length - a.visibleHard.length)) {
  if (s.visibleHard.length === 0) continue;
  say('### `' + s.route + '`  (' + s.visibleHard.length + ')');
  say();
  for (const f of s.visibleHard) {
    const owners = f.files.filter((x) => !EXEMPT.has(x));
    const home = owners.length ? owners.join(', ') : f.files.join(', ') + ' _(exempt)_';
    say('- `' + f.text + '` — ' + home + (f.source === 'text' ? '' : ' [' + f.source + ']'));
  }
  say();
}

// ------------------------------------------------------------------ file worklist
const byFile = new Map();
for (const s of screens) {
  for (const f of s.visibleHard) {
    for (const file of f.files) {
      if (!byFile.has(file)) byFile.set(file, { strings: new Set(), screens: new Set() });
      byFile.get(file).strings.add(f.matched);
      byFile.get(file).screens.add(s.name);
    }
  }
}
say('## Appendix C — file worklist');
say();
say('Every file that holds a string seen on screen. A string that appears in several files is');
say('counted against each of them, so this is a candidate list, not an attribution.');
say();
say('| file | baseline lines | documented exemption | strings seen | screens |');
say('|---|---:|---|---:|---:|');
for (const [file, e] of [...byFile.entries()].sort((a, b) => b[1].strings.size - a[1].strings.size)) {
  say('| `' + file + '` | ' + (baseline.counts[file] ?? '—') + ' | ' + (EXEMPT.has(file) ? 'yes' : '') +
      ' | ' + e.strings.size + ' | ' + e.screens.size + ' |');
}
say();

const narrative = fs.readFileSync(path.join(OUT, 'narrative.md'), 'utf8');
fs.writeFileSync(path.join(OUT, 'FINDINGS.md'), narrative.trimEnd() + '\n\n' + lines.join('\n'), 'utf8');
console.log('FINDINGS.md: ' + report.length + ' screens, ' + distinct.size + ' distinct hardcoded strings, ' + byFile.size + ' candidate files');
