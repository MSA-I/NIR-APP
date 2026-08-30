/**
 * Puts `t` (and any other locale binding tsc says is missing) in scope wherever the extractor put
 * a call. Driven by the COMPILER rather than by a guess about where components begin: tsc names
 * the exact line, and the enclosing declaration is walked back from there.
 *
 *   node .tmp/wire-t.mjs            # repeat until it reports nothing to do
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WANTED = new Set(['t', 'errorText', 'statusLabel', 'locale', 'tDynamic']);
const DECL = /^(?:export default function|export function|function|export const|const)\s+([A-Za-z_$][\w$]*)/;

let out = '';
try {
  out = execFileSync('npx', ['tsc', '--noEmit'], { encoding: 'utf8', shell: true });
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

/** file -> Set(line numbers) -> names needed */
const needed = new Map();
for (const line of out.split('\n')) {
  const m = line.match(/^(.+?)\((\d+),\d+\): error TS2304: Cannot find name '(\w+)'/);
  if (!m || !WANTED.has(m[3])) continue;
  const file = m[1].replace(/\\/g, '/');
  if (!needed.has(file)) needed.set(file, []);
  needed.get(file).push({ line: Number(m[2]), name: m[3] });
}

if (needed.size === 0) { console.log('nothing to wire'); process.exit(0); }

for (const [file, hits] of needed) {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

  // Which declaration owns each reported line, and what that declaration needs.
  const perDecl = new Map();
  for (const { line, name } of hits) {
    let at = -1;
    for (let i = line - 1; i >= 0; i -= 1) {
      if (DECL.test(lines[i])) { at = i; break; }
    }
    if (at < 0) { console.log(`  ${file}:${line} module scope — left for hand conversion`); continue; }
    if (!perDecl.has(at)) perDecl.set(at, new Set());
    perDecl.get(at).add(name);
  }

  for (const at of [...perDecl.keys()].sort((a, b) => b - a)) {
    const names = [...perDecl.get(at)].sort();
    // Find the line that opens the function body.
    let open = at;
    const limit = at + 80;
    while (open < lines.length && open < limit) {
      const trimmed = lines[open].trimEnd();
      if (trimmed.endsWith('}) {') || trimmed.endsWith(') {') || trimmed.endsWith('=> {')) break;
      open += 1;
    }
    if (open >= limit) { console.log(`  ${file}: no body opener for ${lines[at].slice(0, 60)}`); continue; }

    // Extend an existing destructure in the same body rather than adding a second useT() call.
    let existing = -1;
    for (let j = open + 1; j < Math.min(open + 40, lines.length); j += 1) {
      if (/^\s*const \{[^}]*\} = useT\(\);\s*$/.test(lines[j])) { existing = j; break; }
      if (DECL.test(lines[j])) break;
    }
    if (existing >= 0) {
      const have = new Set(lines[existing].match(/\{([^}]*)\}/)[1].split(',').map((s) => s.trim()).filter(Boolean));
      names.forEach((n) => have.add(n));
      lines[existing] = lines[existing].replace(/\{[^}]*\}/, `{ ${[...have].sort().join(', ')} }`);
    } else {
      lines.splice(open + 1, 0, `  const { ${names.join(', ')} } = useT();`);
    }
  }

  let s = lines.join('\n');
  if (!/from '[^']*i18n\/LocaleProvider'/.test(s)) {
    const depth = file.split('/').length - 2;
    const prefix = depth <= 0 ? './' : '../'.repeat(depth);
    const ls = s.split('\n');
    const first = ls.findIndex((l) => l.startsWith('import '));
    ls.splice(first, 0, `import { useT } from '${prefix}lib/i18n/LocaleProvider';`);
    s = ls.join('\n');
  }
  writeFileSync(file, s, 'utf8');
  console.log(`wired ${file}: ${perDecl.size} declaration(s)`);
}
