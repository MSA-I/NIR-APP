import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_DISPLAY_NAME_LENGTH,
  proposeDisplayName,
  visualOrderSignals,
} from './productDisplayName';
import { visualOrderSignals as reportVisualOrderSignals } from '../../scripts/report-product-name-health';

/**
 * Names measured in the live catalogue that were imported in visual order rather than logical
 * order. They are here verbatim because the whole design rests on them: if the normaliser ever
 * starts returning a proposal for one of these, it has begun inventing catalogue names.
 */
const VISUAL_ORDER_CORPUS = [
  ')ב12- אר30*30מטליות מיקרופייבר',
  ')ק"ג 5( קמח לבן',
  'שקיות אשפה 60*80 )100 יח',
];

const READABLE_CORPUS = [
  'שמן קנולה 100 מ״ל',
  'קוטג׳ תנובה 250 גרם',
  'עגבניות שרי',
  'מטליות מיקרופייבר 30*30 (12 ביחידה)',
];

describe('proposeDisplayName', () => {
  it("refuses the owner's own example, because it states two sizes that disagree", () => {
    // 100 ml against 200 cc. The rule the owner stated is that the system must not choose --
    // and it applies to his example as much as to anyone else's.
    const verdict = proposeDisplayName('שמן קנולה 100 מ״ל חברת דגן200cc', 'יח׳');

    expect(verdict.kind).toBe('conflict');
    if (verdict.kind !== 'conflict') return;
    expect(verdict.candidates).toEqual(['100 מ״ל', '200cc']);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('finds the second size even when it is glued to the brand token', () => {
    // The ordering that makes the test above work: sizes are scanned before anything is dropped.
    // Drop `חברת דגן200cc` first and the contradiction disappears with it.
    const verdict = proposeDisplayName('שמן קנולה 100 מ״ל חברת דגן200cc', 'יח׳');
    expect(verdict.kind).toBe('conflict');
  });

  it('proposes a name once there is only one size, and reports what it dropped', () => {
    const verdict = proposeDisplayName('שמן קנולה 100 מ״ל חברת דגן', 'יח׳');

    expect(verdict).toEqual({
      kind: 'proposal',
      displayName: 'שמן קנולה — 100 מ״ל',
      type: 'שמן קנולה',
      size: '100 מ״ל',
      dropped: ['חברת דגן'],
    });
  });

  it('keeps a product with no size at all, unchanged', () => {
    const verdict = proposeDisplayName('עגבניות שרי', 'ק״ג');

    expect(verdict).toEqual({
      kind: 'proposal',
      displayName: 'עגבניות שרי',
      type: 'עגבניות שרי',
      size: null,
      dropped: [],
    });
  });

  it('drops a bare repetition of the unit but never a unit carrying a number', () => {
    const repeated = proposeDisplayName('עגבניות ק״ג', 'ק״ג');
    expect(repeated.kind).toBe('proposal');
    if (repeated.kind === 'proposal') {
      expect(repeated.displayName).toBe('עגבניות');
      expect(repeated.dropped).toEqual(['ק״ג']);
    }

    const measured = proposeDisplayName('אורז 1 ק״ג', 'ק״ג');
    expect(measured.kind).toBe('proposal');
    if (measured.kind === 'proposal') {
      expect(measured.size).toBe('1 ק״ג');
      expect(measured.displayName).toBe('אורז — 1 ק״ג');
    }
  });

  it('treats two spellings of the same size as agreement, not contradiction', () => {
    // 1 litre and 1000 ml are one claim written twice. Nothing is lost by showing one of them,
    // and the reviewer is still told which spelling was set aside.
    const verdict = proposeDisplayName('מים מינרלים 1 ליטר 1000 מ״ל', 'יח׳');

    expect(verdict.kind).toBe('proposal');
    if (verdict.kind !== 'proposal') return;
    expect(verdict.size).toBe('1 ליטר');
    expect(verdict.dropped).toContain('1000 מ״ל');
  });

  it('reads a dimension as one measurement rather than two sizes in conflict', () => {
    const verdict = proposeDisplayName('מטליות מיקרופייבר 30*30', 'יח׳');

    expect(verdict.kind).toBe('proposal');
    if (verdict.kind !== 'proposal') return;
    expect(verdict.size).toBe('30*30');
    expect(verdict.displayName).toBe('מטליות מיקרופייבר — 30*30');
  });

  it('does not mistake a digit inside an ordinary word for a size', () => {
    const verdict = proposeDisplayName('גבינה 100 גרעינים', 'יח׳');
    expect(verdict.kind).toBe('proposal');
    if (verdict.kind === 'proposal') expect(verdict.size).toBeNull();
  });

  it('refuses a name too short to carry a product type', () => {
    expect(proposeDisplayName('', 'יח׳')).toEqual({ kind: 'blocked', reason: 'too_short' });
    expect(proposeDisplayName('   ', 'יח׳')).toEqual({ kind: 'blocked', reason: 'too_short' });
    expect(proposeDisplayName('7', 'יח׳')).toEqual({ kind: 'blocked', reason: 'too_short' });
    // Nothing survives the size and the company marker, so there is no type left to name.
    expect(proposeDisplayName('500 גרם חברת דגן', 'יח׳')).toEqual({
      kind: 'blocked',
      reason: 'too_short',
    });
  });

  it('refuses rather than truncates when the canonical name exceeds the column', () => {
    const long = `${'א'.repeat(MAX_DISPLAY_NAME_LENGTH + 20)} 1 ק״ג`;
    const verdict = proposeDisplayName(long, 'יח׳');

    expect(verdict.kind).toBe('conflict');
    if (verdict.kind !== 'conflict') return;
    expect(verdict.reasons[0]).toContain(String(MAX_DISPLAY_NAME_LENGTH));
  });

  it('never throws, on anything', () => {
    const hostile = ['', '   ', '\u0000', '((((', '%%%', '1 ק״ג', '—', '🍅', 'a'.repeat(5000)];
    for (const name of hostile) {
      expect(() => proposeDisplayName(name, 'יח׳')).not.toThrow();
      expect(() => proposeDisplayName(name, '')).not.toThrow();
    }
  });
});

describe('visual order', () => {
  it('blocks every name in the visual-order corpus instead of parsing it', () => {
    for (const name of VISUAL_ORDER_CORPUS) {
      expect(visualOrderSignals(name).length).toBeGreaterThan(0);
      expect(proposeDisplayName(name, 'יח׳')).toEqual({
        kind: 'blocked',
        reason: 'suspected_visual_order',
      });
    }
  });

  it('does not block names that are merely ordinary', () => {
    for (const name of READABLE_CORPUS) {
      expect(visualOrderSignals(name)).toEqual([]);
      expect(proposeDisplayName(name, 'יח׳').kind).not.toBe('blocked');
    }
  });

  it('names the signal it saw', () => {
    expect(visualOrderSignals(')ב12- מטליות')).toContain('leading_closer');
    expect(visualOrderSignals('מטליות (12')).toContain('unbalanced_brackets');
    expect(visualOrderSignals(') מטליות (')).toContain('closer_before_opener');
  });

  /**
   * `scripts/report-product-name-health.ts` carries its own copy of this rule because it runs
   * under plain node, which cannot follow this module's extensionless import of `format.ts`.
   * Two implementations are acceptable only while something proves they answer identically.
   */
  it('agrees, signal for signal, with the report script', () => {
    for (const name of [...VISUAL_ORDER_CORPUS, ...READABLE_CORPUS, '', '(a)', ')a(', '{x']) {
      expect(reportVisualOrderSignals(name)).toEqual(visualOrderSignals(name));
    }
  });
});

/**
 * "Normalise at intake or approval, never per render" is a property of the system, not an
 * intention. `display_name` is a column; a screen reads the column. The moment a page or a
 * component imports this module, the canonical name becomes a function of today's parser again,
 * and every screen silently starts showing whatever it currently believes.
 *
 * ONE FILE IS ALLOWED, AND THE ALLOWANCE IS THE RULE'S OWN SECOND CLAUSE.
 *
 * The rule has always said *intake or APPROVAL*. `pages/ProductNameReview.tsx` is the approval
 * half — the screen this module's own docblock names ("The review screen is where that gets
 * settled") and the only caller `proposeDisplayName` was ever written to have. Nothing it prints
 * is a product's name: it renders a proposal awaiting a decision, and the value that reaches the
 * column is the one a person pressed a button on. Stated as a blanket directory ban, the guard
 * caught the hazard and its own sanctioned caller with it, so it is stated as an allowlist
 * instead — which is also the version a reviewer can audit, unlike a differently-named
 * intermediate module that would have satisfied the regex while defeating the rule.
 *
 * `pages/Products.tsx` is deliberately NOT on the list. It renders a column of product names in
 * a table, which is exactly the hazard; it reaches the parser only through the component above,
 * so a future edit there cannot start normalising names at render without failing this test.
 */
const APPROVAL_SURFACES = new Set(['pages/ProductNameReview.tsx']);

describe('the no-render-import rule', () => {
  // `process.cwd()`, the idiom noteProse.spec.ts already uses for the same job. Deriving the root
  // from `import.meta.url` does not work here: under vitest that is not a file:// URL, and this
  // repository additionally lives under a Hebrew directory name, so any hand-rolled unescaping of
  // it silently yields a path that does not exist. A guard scanning a missing directory passes
  // forever -- which is what the second test below exists to catch.
  const srcRoot = join(process.cwd(), 'src');

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield path;
    }
  }

  const importsIt = /(?:from|import)\s*\(?\s*['"][^'"]*productDisplayName['"]/;

  /** Posix-shaped, so the allowlist reads the same on Windows as it does in CI. */
  function importers(): string[] {
    const found: string[] = [];
    for (const dir of ['pages', 'components']) {
      for (const file of walk(join(srcRoot, dir))) {
        if (importsIt.test(readFileSync(file, 'utf8'))) {
          found.push(relative(srcRoot, file).split(sep).join('/'));
        }
      }
    }
    return found;
  }

  it('is not imported by any page or component outside the approval surfaces', () => {
    expect(importers().filter((file) => !APPROVAL_SURFACES.has(file))).toEqual([]);
  });

  it('every allowlisted surface exists and actually imports it', () => {
    // An exemption for a file that is gone, or for one that stopped calling the parser, is a hole
    // with nothing behind it. The list has to shrink when its reason does, not sit there widening
    // the rule for whoever creates that path next.
    for (const surface of APPROVAL_SURFACES) {
      expect(existsSync(join(srcRoot, surface))).toBe(true);
    }
    expect([...APPROVAL_SURFACES].filter((surface) => !importers().includes(surface))).toEqual([]);
  });

  it('is actually looking at files', () => {
    // A guard that silently scans an empty directory passes forever. This is the guard's guard.
    const scanned = ['pages', 'components'].flatMap((dir) => [...walk(join(srcRoot, dir))]);
    expect(scanned.length).toBeGreaterThan(20);
  });
});
