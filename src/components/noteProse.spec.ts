import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.note` is a flex ROW (index.css), so every child of `<Note>` is a flex item — including each
 * run of raw text between two inline tags. Prose handed straight to it is therefore shredded into
 * one-word columns: the settings screen measured 766px tall with a widest text run of 55px at
 * 390px, against 266px once the same prose sat in one wrapper. Twenty call sites had drifted into
 * that shape before anyone measured it, which is why this is a test and not a comment.
 *
 * The row itself is load-bearing for the icon / text / action sites, so the rule is not "no flex".
 * It is: a Note body may mix elements with each other, never with bare prose.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.includes('.spec.') ? [full] : [];
  });
}

/** The body of every non-self-closing `<Note …>…</Note>`, with its file and line. */
function noteBodies(file: string): { line: number; body: string }[] {
  const src = readFileSync(file, 'utf8');
  const found: { line: number; body: string }[] = [];
  for (let at = src.indexOf('<Note'); at >= 0; at = src.indexOf('<Note', at + 1)) {
    let i = at;
    let braces = 0;
    while (i < src.length && !(src[i] === '>' && braces === 0)) {
      if (src[i] === '{') braces += 1;
      if (src[i] === '}') braces -= 1;
      i += 1;
    }
    if (src[i - 1] === '/') continue;
    const close = src.indexOf('</Note>', i);
    if (close < 0) continue;
    found.push({ line: src.slice(0, at).split('\n').length, body: src.slice(i + 1, close) });
  }
  return found;
}

/**
 * Raw text at the body's own level — what the browser turns into an anonymous flex item.
 * Text inside a nested element or a `{…}` expression belongs to that child and is not counted.
 */
function bareProse(body: string): string {
  let out = '';
  let braces = 0;
  let elements = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') { braces += 1; continue; }
    if (char === '}') { braces -= 1; continue; }
    if (braces > 0) continue;
    if (char === '<') {
      const closing = body[i + 1] === '/';
      let quote: string | null = null;
      let inner = 0;
      let j = i + 1;
      for (; j < body.length; j += 1) {
        const tagChar = body[j];
        if (quote) { if (tagChar === quote) quote = null; continue; }
        if (tagChar === '"' || tagChar === "'") { quote = tagChar; continue; }
        if (tagChar === '{') inner += 1;
        else if (tagChar === '}') inner -= 1;
        else if (tagChar === '>' && inner === 0) break;
      }
      const selfClosing = body[j - 1] === '/';
      if (closing) elements -= 1;
      else if (!selfClosing) elements += 1;
      i = j;
      continue;
    }
    if (elements === 0) out += char;
  }
  return out.trim();
}

describe('Note bodies never mix prose with elements', () => {
  it('holds across every call site', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      for (const { line, body } of noteBodies(file)) {
        const structural = /[<{]/.test(body);
        if (structural && bareProse(body)) {
          offenders.push(`${relative(process.cwd(), file).split(sep).join("/")}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
