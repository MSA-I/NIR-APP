/**
 * check:tokens — the design-token rule as a gate instead of a sentence in prose.
 *
 * DESIGN.md ("חוק הטוקנים", §6 Runbook) requires the enforcement grep to return zero rows over
 * every .tsx file under src: no raw Tailwind palette classes and no hex colour literals — every
 * colour goes through an `@theme` token in `src/index.css`, and charts go through `chartTheme()`.
 * Until this script, the grep lived only in documentation and depended on someone running it.
 *
 * Scope is deliberately `.tsx` only, exactly as DESIGN.md:359 states it: third-party CSS (e.g.
 * pdfjs's shipped stylesheet, THIRD_PARTY_NOTICES.md) is outside the rule, and `src/index.css`
 * is where the tokens themselves are defined.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

/** DESIGN.md:359 verbatim. A new palette name or utility prefix goes into DESIGN.md first. */
const RAW_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|placeholder|accent|caret|shadow)-(?:slate|gray|zinc|indigo|violet|blue|emerald|green|amber|yellow|orange|rose|red|sky|cyan|teal)-[0-9]{2,3}\b/g;

/** DESIGN.md:361 — zero hex literals in tsx; charts read tokens via chartTheme(). */
const HEX_LITERAL = /#[0-9a-fA-F]{6}/g;

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTsx(path);
    else if (entry.isFile() && entry.name.endsWith('.tsx')) yield path;
  }
}

interface Violation {
  file: string;
  line: number;
  match: string;
}

const violations: Violation[] = [];
let scanned = 0;

for (const file of walkTsx(srcRoot)) {
  scanned += 1;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const pattern of [RAW_PALETTE, HEX_LITERAL]) {
      pattern.lastIndex = 0;
      for (const found of text.matchAll(pattern)) {
        violations.push({ file: relative(srcRoot, file), line: index + 1, match: found[0] });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('check:tokens FAILED — raw colour in .tsx. Use an @theme token (src/index.css + DESIGN.md together):');
  for (const v of violations) console.error(`  src/${v.file.replace(/\\/g, '/')}:${v.line}  ${v.match}`);
  process.exit(1);
}

console.log(`check:tokens passed: ${scanned} .tsx files, zero raw palette classes, zero hex literals.`);
