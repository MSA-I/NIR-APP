import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A file name is a NAME, and the name-isolation rule covers it (DESIGN.md, חוק בידוד השמות).
 *
 * WHY THIS IS A SCAN AND NOT A LIST. The rule was written around product and supplier names, so
 * file names were never brought under it, and the result was exactly what an unenforced rule looks
 * like: `DocumentsInbox` and `DocumentReview` had `<bdi>`, `DocumentOperations`,
 * `ConsolidatedInvoices` and `Onboarding` did not, and none of the confirm dialogs that drop a file
 * name into the middle of a Hebrew sentence isolated it at all. Nobody chose that split — it is
 * what happens when the rule lives only in prose.
 *
 * WHY IT SURVIVED EVERY SCREENSHOT REVIEW, which is the part worth remembering. Only a name that
 * mixes both scripts renders differently. Measured in Chrome on the product's own stylesheet
 * (`artifacts/w8/filenames-bidi-probe.json`):
 *
 *   `חשבונית ספק לבדיקה.pdf`     isolated or not → identical
 *   `ADTV Ltd receipt 7352.pdf`  isolated or not → identical
 *   `invoice-2026-08 סופי.pdf`   bare → `pdf.יפוס invoice-2026-08`   isolated → `invoice-2026-08 יפוס.pdf`
 *
 * So the extension is torn off the name and parked at the opposite margin, and every demo file name
 * anyone happened to look at was single-script.
 *
 * WHAT THIS DOES NOT CLAIM. It is a source scan, not a rendering. It proves each site carries one
 * of the three sanctioned forms; the browser measurement above is what proves those forms work.
 */

/** `process.cwd()`, the idiom the other source-reading specs in this repository use. `import.meta.url`
    is not a `file:` URL under the jsdom environment, and its `.pathname` mangles the Hebrew path
    this repository lives under. */
const SRC = join(process.cwd(), 'src');

const tsxFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (full.endsWith('.tsx') && !full.endsWith('.spec.tsx')) out.push(full);
  }
  return out;
};

/** A file name reaching the screen: `something.file_name` or `something.fileName`. */
const READS_A_FILE_NAME = /\.(file_name|fileName)\b/;

/** The three sanctioned forms, all of which appear on the same line as the read. */
const ISOLATED = /<bdi[\s>]|bidiIsolate\(|dir=["']auto["']/;

/**
 * A line only DRAWS a name if it is markup or a translated sentence. Everything else — building a
 * record, an RPC argument, a comparison, a search predicate — moves the string without showing it,
 * and isolating there would put control characters into data.
 */
const DRAWS_SOMETHING = /<|\bt\(/;

/**
 * Lines that reach the person through a channel that is SPOKEN rather than drawn. Control
 * characters in an accessible name or a live-region announcement are a risk with no payoff: the
 * screen reader reads the logical string, which is already in the right order.
 */
const SPOKEN_NOT_DRAWN = [
  { needle: 'aria-label', why: 'an accessible name' },
  { needle: 'label={', why: 'an accessible name handed to a component' },
  { needle: 'rowLabel', why: "the DataTable's per-row accessible name" },
  { needle: 'RowLabel', why: 'the same, on another screen' },
  { needle: 'announce(', why: 'a live-region announcement — read aloud, never painted' },
];

/** Reads that are plumbing even though the line also carries markup or a `t(` call. */
const NOT_A_RENDER = [
  { needle: 'sortValue:', why: 'a sort key' },
  { needle: 'searchFn', why: 'a search predicate' },
  { needle: 'fileName={', why: 'a prop handed to a component, which isolates at its own render site' },
  { needle: 'reason:', why: 'text written to audit_logs; control characters must not reach the database' },
];

describe('every file name rendered inline is bidi-isolated (DESIGN.md, חוק בידוד השמות)', () => {
  it('finds no unisolated file-name render anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (!READS_A_FILE_NAME.test(code)) return;
        if (ISOLATED.test(code)) return;
        if (!DRAWS_SOMETHING.test(code)) return;
        // The spoken-channel test reads a small window, because `announce(` and `label={` are
        // routinely written across two or three lines and a per-line test would miss the opener.
        const window = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
        if (SPOKEN_NOT_DRAWN.some((exempt) => window.includes(exempt.needle))) return;
        if (NOT_A_RENDER.some((exempt) => code.includes(exempt.needle))) return;
        offenders.push(`${relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `wrap the name in <bdi> (markup) or bidiIsolate() (inside a translated sentence):\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('scans a real number of files, so a broken path cannot pass by finding nothing', () => {
    expect(tsxFiles(SRC).length).toBeGreaterThan(100);
  });
});
