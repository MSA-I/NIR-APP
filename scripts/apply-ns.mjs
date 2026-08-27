/**
 * Adds (or extends) one namespace in both dictionaries from the extractor's output.
 *
 *   node .tmp/apply-ns.mjs <namespace>
 *
 * Reads `.tmp/pending/<ns>.json` (Hebrew, written by extract.mjs) and `.tmp/en/<ns>.json`
 * (English, written by hand) and refuses if a key is missing from either — a half-translated
 * namespace would compile and then show a key to somebody.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ns = process.argv[2];
if (!ns) { console.error('usage: node .tmp/apply-ns.mjs <namespace>'); process.exit(1); }

const he = JSON.parse(readFileSync(`.tmp/pending/${ns}.json`, 'utf8'));
const enPath = `.tmp/en/${ns}.json`;
if (!existsSync(enPath)) { console.error(`missing ${enPath}`); process.exit(1); }
const en = JSON.parse(readFileSync(enPath, 'utf8'));

const missing = Object.keys(he).filter((k) => !(k in en));
const extra = Object.keys(en).filter((k) => !(k in he));
if (missing.length) { console.error(`no English for: ${missing.join(', ')}`); process.exit(1); }
if (extra.length) { console.error(`English for keys that do not exist: ${extra.join(', ')}`); process.exit(1); }

const lit = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

for (const [path, table] of [['src/lib/i18n/dictionaries/he.ts', he], ['src/lib/i18n/dictionaries/en.ts', en]]) {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const open = `  ${ns}: {`;
  const at = lines.indexOf(open);
  const block = Object.entries(table).map(([k, v]) => `    ${k}: ${lit(v)},`);
  if (at >= 0) {
    const close = lines.indexOf('  },', at);
    const existing = new Set(lines.slice(at + 1, close).map((l) => l.trim().split(':')[0]));
    lines.splice(close, 0, ...block.filter((l) => !existing.has(l.trim().split(':')[0])));
  } else {
    // Insert before the closing brace of the object literal, keeping namespaces in one block.
    const end = lines.findIndex((l) => l === '} as const;' || l === '};');
    lines.splice(end, 0, open, ...block, '  },', '');
  }
  writeFileSync(path, lines.join('\n'), 'utf8');
  console.log(`${path}: ${block.length} key(s) under ${ns}`);
}
