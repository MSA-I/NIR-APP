import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files: string[] = [];

function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(css|html|tsx?)$/.test(entry)) files.push(full);
  }
}

walk(path.join(root, 'src'));
files.push(path.join(root, 'index.html'));

const rules = [
  { label: 'retired IBM font', pattern: /IBM Plex (?:Sans Hebrew|Mono)/g },
  { label: 'retired mono utility', pattern: /\bfont-mono\b/g },
  { label: 'weight 700', pattern: /\bfont-bold\b/g },
  { label: 'text below 12px', pattern: /text-\[(?:[0-9]|1[01])px\]/g },
  { label: 'decorative tracking', pattern: /\btracking-(?:wide|wider|widest|tight|tighter)\b/g },
];

const violations: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  for (const rule of rules) {
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relative}:${line} ${rule.label}: ${match[0]}`);
    }
  }
}

const css = readFileSync(path.join(root, 'src/index.css'), 'utf8');
const numRule = css.match(/\.num\s*\{[\s\S]*?\}/)?.[0] ?? '';
if (!numRule.includes('tabular-nums') || /direction\s*:\s*ltr|ui-monospace|unicode-bidi\s*:\s*embed/.test(numRule)) {
  violations.push('src/index.css .num must use tabular figures without forced LTR, embed, or monospace.');
}

if (violations.length) {
  console.error(`Typography contract failed (${violations.length}):\n${violations.join('\n')}`);
  process.exit(1);
}

console.log(`Typography contract passed (${files.length} source files).`);
