/**
 * Measure the DEBT register against the tree, section by section.
 *
 * The staleness pattern found twice today: a section cites `0110:326-329` or a function name as
 * its evidence, a LATER migration rewrites exactly that line through an anchored replacement, and
 * the section keeps asserting something that stopped being true. A line number is not durable
 * evidence. This finds every section where that could have happened.
 *
 * Read-only. Writes one JSON report.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || path.resolve(here, '..');
const outFile = process.argv[3] || null;
const migrationsDir = path.join(repo, 'supabase', 'migrations');

const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migrationText = new Map();
for (const m of migrations) migrationText.set(m, readFileSync(path.join(migrationsDir, m), 'utf8'));
const numOf = (name) => Number(name.slice(0, 4));
const HIGHEST = Math.max(...migrations.map(numOf));

/** Every migration that DEFINES or PATCHES a given function name, by number. */
function touchers(fn) {
  const bare = fn.replace(/^(public|private)\./, '');
  const out = [];
  for (const [name, sql] of migrationText) {
    const defines = new RegExp(`(create|replace)\\s+(or\\s+replace\\s+)?function\\s+(public\\.|private\\.)?${bare}\\s*\\(`, 'i').test(sql);
    // An anchored replacement names the function inside pg_get_functiondef(...) and re-executes it.
    const patches = sql.includes('pg_get_functiondef') && new RegExp(`\\b${bare}\\b`).test(sql);
    if (defines || patches) out.push({ name, num: numOf(name), defines, patches });
  }
  return out;
}

// ---------------------------------------------------------------- split the register into sections
const doc = readFileSync(path.join(repo, 'docs', 'DEBT-REGISTER.md'), 'utf8').replace(/\r\n/g, '\n');
const lines = doc.split('\n');
const heads = [];
lines.forEach((l, i) => { if (/^### §/.test(l)) heads.push(i); });

const sections = heads.map((start, idx) => {
  const end = idx + 1 < heads.length ? heads[idx + 1] : lines.length;
  const body = lines.slice(start, end).join('\n');
  const heading = lines[start];
  const numbers = [...heading.matchAll(/§(\d+)/g)].map((m) => m[1]);
  return { numbers, heading: heading.replace(/^### /, ''), body, line: start + 1 };
});

const report = [];
for (const s of sections) {
  const closedInHeading = /נסגר|נסגרה/.test(s.heading);

  // ---- cited migrations: `0110`, `0110_apply_reviewed_document.sql`, with or without :lines
  const citedNums = new Set();
  for (const m of s.body.matchAll(/`(\d{4})(?:_[a-z0-9_]+\.sql)?(?::[\d\-, ]+)?`/gi)) citedNums.add(Number(m[1]));
  const citedLineRefs = [...s.body.matchAll(/`(\d{4})(?:_[a-z0-9_]+\.sql)?:(\d[\d\-]*)/gi)]
    .map((m) => `${m[1]}:${m[2]}`);

  // ---- cited functions
  const citedFns = new Set();
  for (const m of s.body.matchAll(/`(public|private)\.([a-z0-9_]+)\(/gi)) citedFns.add(`${m[1]}.${m[2]}`);
  for (const m of s.body.matchAll(/`([a-z][a-z0-9_]{6,})\(\)`/gi)) citedFns.add(m[1]);

  // ---- cited repo paths
  const citedPaths = new Set();
  for (const m of s.body.matchAll(/`((?:src|scripts|supabase|docs|worker|public|\.github)\/[A-Za-z0-9_\-./]+)/g)) {
    citedPaths.add(m[1].replace(/[.,:]$/, ''));
  }
  const missingPaths = [...citedPaths].filter((p) => !existsSync(path.join(repo, p.split(':')[0])));

  // ---- THE SIGNAL: a later migration touched a function this section cites as evidence
  const overtaken = [];
  const maxCited = citedNums.size ? Math.max(...citedNums) : 0;
  for (const fn of citedFns) {
    const t = touchers(fn);
    if (!t.length) continue;
    const latest = Math.max(...t.map((x) => x.num));
    if (maxCited && latest > maxCited) {
      overtaken.push({ fn, citedUpTo: maxCited, rewrittenBy: latest });
    }
  }

  // ---- a cited gate/suite name that no longer exists anywhere
  const citedSuites = [...s.body.matchAll(/`(p\d+[a-z0-9_]*\.sql)`/gi)].map((m) => m[1]);
  const missingSuites = citedSuites.filter(
    (f) => !existsSync(path.join(repo, 'supabase', 'tests', f)));

  const flags = [];
  if (overtaken.length) flags.push('EVIDENCE_OVERTAKEN');
  if (missingPaths.length) flags.push('CITED_PATH_GONE');
  if (missingSuites.length) flags.push('CITED_SUITE_GONE');
  if (citedLineRefs.length && !closedInHeading) flags.push('CITES_LINE_NUMBERS');

  report.push({
    section: s.numbers.map((n) => `§${n}`).join(' / '),
    line: s.line,
    closedInHeading,
    title: s.heading.replace(/^§[\d §/]+—\s*/, '').slice(0, 90),
    flags,
    overtaken,
    citedLineRefs,
    missingPaths,
    missingSuites,
  });
}

if (outFile) writeFileSync(outFile, JSON.stringify({ highestMigration: HIGHEST, sections: report }, null, 2));

const open = report.filter((r) => !r.closedInHeading);
const overtaken = open.filter((r) => r.flags.includes('EVIDENCE_OVERTAKEN'));
const gonePath = open.filter((r) => r.flags.includes('CITED_PATH_GONE'));
const lineCited = open.filter((r) => r.flags.includes('CITES_LINE_NUMBERS'));

console.log(`sections: ${report.length}  open: ${open.length}  (highest migration ${HIGHEST})`);
console.log(`\nEVIDENCE OVERTAKEN by a later migration -- prime suspects (${overtaken.length}):`);
for (const r of overtaken) {
  console.log(`  ${r.section.padEnd(12)} ${r.title}`);
  for (const o of r.overtaken) console.log(`      ${o.fn}: cited up to ${o.citedUpTo}, rewritten by ${o.rewrittenBy}`);
}
console.log(`\nCITED PATH NO LONGER EXISTS (${gonePath.length}):`);
for (const r of gonePath) console.log(`  ${r.section.padEnd(12)} ${r.missingPaths.join(', ')}`);
console.log(`\nCITES A LINE NUMBER as evidence (fragile, ${lineCited.length}):`);
console.log('  ' + lineCited.map((r) => r.section).join(' '));
