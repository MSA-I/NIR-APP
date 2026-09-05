/**
 * The mandated "—" may not be drawn in a token the palette has excused from AA.
 *
 * CLAUDE.md: "מדד שאין לו נתונים מציג `—`, לא `0` — אפס הוא גם טענה על המציאות." The dash is not
 * decoration and it is not an absence: it is the product's ANSWER to "what is this value", chosen
 * over a fake zero precisely because it asserts something. An assertion has to be readable.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT AN OPINION ABOUT COLOUR. `scripts/contrast-pairs.mjs`
 * declares — in the repository's own words, beside its own reasons — which ink tokens sit
 * deliberately below 4.5:1: `ink-faint` for "placeholder text and empty-state hints", `ink-ghost`
 * for "disabled lettering. 1.4.3 exempts inactive controls". Those exemptions are sound for what
 * they name. The mandated marker is neither a placeholder nor a disabled control, so it may not
 * borrow their exemption. The list is READ from that file rather than copied here: a token that is
 * excused tomorrow is covered by this spec the same day, and a copy would be a second source of
 * truth about which colours are allowed to be unreadable.
 *
 * MEASURED, NOT INFERRED. Both forms were read off composited pixels at 1440x900 before the fix:
 * `text-ink-faint` "—" on /prices measured 4.372:1 in the dark theme, and the sweep measured
 * `text-ink-ghost` at 1.9:1 light / 2.4:1 dark — below even the large-text threshold.
 * `docs/qa/2026-09-04/evidence/PR21-RTL-A11Y-06-RTL-A11Y-07-RED.txt` carries the run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * The exemption list, taken from the file that owns it. Sliced to the `TEXT_EXEMPT` block first —
 * the same source also lists every ink token in `INK_TOKENS`, and a scan of the whole file would
 * quietly report the entire ink scale as excused.
 */
function exemptTokens(): string[] {
  const source = read('scripts/contrast-pairs.mjs');
  const from = source.indexOf('export const TEXT_EXEMPT');
  const to = source.indexOf('export const INK_TOKENS');
  expect(from, 'contrast-pairs.mjs no longer declares TEXT_EXEMPT').toBeGreaterThan(-1);
  expect(to, 'contrast-pairs.mjs no longer declares INK_TOKENS').toBeGreaterThan(from);
  return [...source.slice(from, to).matchAll(/\[\s*'([a-z][a-z-]*)'\s*,/g)].map((m) => m[1]);
}

/** Comments blanked, the rule every source scan in this repo follows: prose is not code. */
function code(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* tsxFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.spec.tsx')) {
      yield path;
    }
  }
}

/** `<span className="…">—</span>` in any element, which is the only shape the marker is written in. */
const MARKER = /<([A-Za-z][\w.]*)\b([^>]*)>\s*—\s*<\/\1>/g;

describe('the no-data marker', () => {
  it('is never painted in a token the palette declares below AA', () => {
    const exempt = exemptTokens();
    expect(exempt.length, 'the exemption list parsed empty — this spec would assert nothing')
      .toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of tsxFiles('src')) {
      const source = code(read(file));
      for (const found of source.matchAll(MARKER)) {
        const attributes = found[2];
        const used = exempt.find((token) => attributes.includes(`text-${token}`));
        if (!used) continue;
        const line = source.slice(0, found.index).split('\n').length;
        offences.push(`${relative('.', file)}:${line} — the mandated "—" is drawn in text-${used}`);
      }
    }

    expect(offences, offences.join('\n')).toEqual([]);
  });
});
