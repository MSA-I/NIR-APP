/**
 * Screen-string extractor.
 *
 * Rewrites the Hebrew a file shows into `t('ns.key')` calls and emits the Hebrew side of the
 * dictionary. It is deliberately CONSERVATIVE: anything it cannot place safely it leaves alone and
 * reports, because a wrong rewrite in a money screen is far more expensive than a missed one.
 *
 *   node .tmp/extract.mjs <file> <namespace> [--write]
 *
 * Without --write it prints what it would do. With --write it rewrites the file and appends
 * `.tmp/pending/<namespace>.json` for the English pass.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const [file, namespace, ...flags] = process.argv.slice(2);
const write = flags.includes('--write');
if (!file || !namespace) {
  console.error('usage: node .tmp/extract.mjs <file> <namespace> [--write]');
  process.exit(1);
}

const HEBREW = /[֐-׿]/;
const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const lines = source.split('\n');

/* ---------------------------------------------------------------- comment and scope mapping */

// Which lines are inside a comment.
//
// JSX comments are the reason this is not a one-liner. `{/* ... */}` does not begin with `/*`, so
// an earlier version treated the line as code and rewrote the OWNER'S QUOTED WORDS inside a design
// note into a t() call — `(owner: "תקטין את הגודל של הלוגו")` became `(owner: t('nav.text_12'))`.
// Caught on the first shared component this ran against. Comments are prose about the code and
// must never be touched.
const inComment = new Array(lines.length).fill(false);
{
  let block = false;
  lines.forEach((line, i) => {
    if (block) { inComment[i] = true; if (line.includes('*/')) block = false; return; }
    const open = line.search(/\{?\/\*/);
    if (open < 0) return;
    const closes = line.indexOf('*/', open) >= 0;
    // A single-line `{/* ... */}` is fully a comment when nothing but whitespace surrounds it.
    if (closes) { inComment[i] = /^\s*\{?\/\*.*\*\/\}?\s*$/.test(line); return; }
    block = true;
    inComment[i] = true;
  });
}

/** Strips a trailing line comment so Hebrew in prose is never counted or rewritten. */
function codeOf(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

// The top-level declaration each line belongs to, and whether it is a React component (so a hook
// is legal there). Module scope cannot call a hook, so those sites are reported, never rewritten.
const DECL = /^(?:export default function|export function|function|export const|const)\s+([A-Za-z_$][\w$]*)/;
const owner = [];
const ownerIsFunction = [];
{
  let current = null;
  let currentIsFunction = false;
  lines.forEach((line, i) => {
    const m = DECL.exec(line);
    if (m) {
      current = m[1];
      // A capitalised name is not enough: `const MOVEMENT_LABEL: Record<..> = {` is DATA, and a
      // hook call placed inside it lands in module scope, where hooks cannot run. Only a real
      // function declaration, or an arrow assigned to one, can hold a hook.
      currentIsFunction = /function/.test(line) || /=\s*\(?[^=]*\)?\s*=>/.test(line);
    }
    owner[i] = current;
    ownerIsFunction[i] = currentIsFunction;
  });
}
const isComponentLine = (i) => Boolean(owner[i]) && /^[A-Z]/.test(owner[i]) && ownerIsFunction[i];

/* ---------------------------------------------------------------- key naming */

const used = new Set();
function claim(base) {
  const cleaned = base.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'text';
  let key = cleaned;
  let n = 2;
  while (used.has(key)) key = `${cleaned}_${n++}`;
  used.add(key);
  return key;
}

/** Names a key after the nearest identifier on the line, so it reads as a place, not a number. */
function nameFor(line, hint) {
  if (hint) return claim(hint);
  const attr = line.match(/(\w+)=["'{]\s*$/) || line.match(/(\w+):\s*$/);
  if (attr) return claim(attr[1]);
  const call = line.match(/(\w+)\(/);
  if (call && !['t', 'if', 'return'].includes(call[1])) return claim(call[1]);
  return claim('text');
}

/* ---------------------------------------------------------------- the rewrites */

const entries = new Map();
const skipped = [];
let rewritten = 0;

const out = lines.map((line, i) => {
  if (!HEBREW.test(line)) return line;
  const code = codeOf(line);
  if (!HEBREW.test(code) || inComment[i]) return line; // Hebrew only in prose
  if (!isComponentLine(i)) { skipped.push(`${i + 1}: module/helper scope (${owner[i] ?? 'top level'})`); return line; }
  if (/`/.test(code)) { skipped.push(`${i + 1}: template literal`); return line; }

  let next = line;
  let touched = false;

  // 1. attribute strings:  title="טקסט"  ->  title={t('ns.key')}
  next = next.replace(/(\s)([a-zA-Z][\w-]*)=(["'])([^"'{}<>]*[֐-׿][^"'{}<>]*)\3/g, (m, sp, attr, q, text) => {
    const key = claim(attr);
    entries.set(key, text.trim());
    touched = true;
    return `${sp}${attr}={t('${namespace}.${key}')}`;
  });

  // 2. quoted strings in expressions:  toast('טקסט')  ->  toast(t('ns.key'))
  //    Braces and angle brackets are excluded from the BODY on purpose. Without that, a line like
  //    `{' '}— נדרשת הכרעה.{' '}` matches from the first quote to the third and swallows the JSX
  //    between them, producing `{' t('ns.key') '}`. Measured, not theorised — it happened on the
  //    first file this ran against.
  next = next.replace(/(['"])((?:[^'"\\{}<>]|\\.)*[֐-׿](?:[^'"\\{}<>]|\\.)*)\1/g, (m, q, text) => {
    if (m.includes("t('")) return m;
    const key = nameFor(next, null);
    entries.set(key, text.trim());
    touched = true;
    return `t('${namespace}.${key}')`;
  });

  // 3. bare JSX text between tags:  >טקסט<  ->  >{t('ns.key')}<
  next = next.replace(/>([^<>{}]*[֐-׿][^<>{}]*)</g, (m, text) => {
    const trimmed = text.trim();
    if (!trimmed) return m;
    const key = nameFor(next, null);
    entries.set(key, trimmed);
    touched = true;
    const [lead] = text.match(/^\s*/);
    const [tail] = text.match(/\s*$/);
    return `>${lead}{t('${namespace}.${key}')}${tail}<`;
  });

  // 4. a JSX child on its own line: the commonest shape in this codebase, because the formatter
  //    puts long Hebrew on its own line and leaves `{' '}` or an expression beside it.
  //      `  פעולות ממתינות:{' '}`  ->  `  {t('ns.key')}{' '}`
  if (!touched) {
    const m = next.match(/^(\s*)([^<>{}]*[֐-׿][^<>{}]*?)(\s*)((?:\{[^{}]*\})?)\s*$/);
    if (m && m[2].trim()) {
      const key = nameFor(next, null);
      entries.set(key, m[2].trim());
      touched = true;
      next = `${m[1]}{t('${namespace}.${key}')}${m[3]}${m[4]}`;
    }
  }

  if (touched) rewritten += 1;
  else if (HEBREW.test(code)) skipped.push(`${i + 1}: no rule matched`);
  return next;
});

console.log(`${file}: ${entries.size} string(s) in ${rewritten} line(s); ${skipped.length} left`);
if (skipped.length) console.log(skipped.slice(0, 25).map((s) => `  ${s}`).join('\n'));

if (write) {
  writeFileSync(file, out.join('\n'), 'utf8');
  mkdirSync('.tmp/pending', { recursive: true });
  const target = `.tmp/pending/${namespace}.json`;
  const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
  writeFileSync(target, JSON.stringify({ ...existing, ...Object.fromEntries(entries) }, null, 2), 'utf8');
  console.log(`wrote ${file} and ${target}`);
}
