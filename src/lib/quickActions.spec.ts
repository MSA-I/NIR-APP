import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sectionOf, type SectionKey } from './quickActions';
import type { Tone } from './status';

const css = readFileSync('src/index.css', 'utf8');
/** Comments carry prose about tokens they must not be credited with using. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every SectionKey, kept total by the type system: adding a fourth domain breaks compilation
    here first, which is where the decision should be argued rather than in a stylesheet. */
const SECTION_KEYS = Object.keys({
  documents: true, procurement: true, money: true,
} satisfies Record<SectionKey, true>) as SectionKey[];

/** Every Tone, kept total the same way. `status.ts` exports the union but no runtime list. */
const TONES = Object.keys({
  done: true, await: true, alert: true, info: true, idle: true,
} satisfies Record<Tone, true>) as Tone[];

const SEMANTIC_TOKEN = /--color-(?:done|await|alert|info|idle)-[a-z-]+/g;

function tsxFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** All CSS rule bodies whose selector matches — crude but sufficient, since index.css is one
    hand-written file with no nesting inside the blocks these patterns reach. */
function ruleBodies(selectorPattern: RegExp): string[] {
  const bodies: string[] = [];
  for (const match of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorPattern.test(match[1].trim())) bodies.push(match[2]);
  }
  return bodies;
}

describe('זהות אזור — מאיזה מסלול, לעולם לא מאיזה נתון', () => {
  it('ממפה את שלושת תחומי העבודה, כולל מסכי הפרטים שלהם', () => {
    expect(sectionOf('/documents')).toBe('documents');
    expect(sectionOf('/documents/operations')).toBe('documents');
    expect(sectionOf('/documents/archive')).toBe('documents');
    expect(sectionOf('/documents/consolidated-invoices')).toBe('documents');
    expect(sectionOf('/documents/abc/review')).toBe('documents');

    expect(sectionOf('/orders')).toBe('procurement');
    expect(sectionOf('/orders/new?fresh=1')).toBe('procurement');
    expect(sectionOf('/receiving/abc')).toBe('procurement');
    expect(sectionOf('/inventory')).toBe('procurement');
    expect(sectionOf('/suppliers/abc')).toBe('procurement');
    expect(sectionOf('/products')).toBe('procurement');
    expect(sectionOf('/prices')).toBe('procurement');

    expect(sectionOf('/invoices/abc')).toBe('money');
    expect(sectionOf('/credits')).toBe('money');
    expect(sectionOf('/payment-requests?status=pending_approval')).toBe('money');
    expect(sectionOf('/payments')).toBe('money');
    expect(sectionOf('/bank')).toBe('money');
    expect(sectionOf('/pay')).toBe('money');
  });

  it('אינו בולע מסלול אח על גבול המחרוזת', () => {
    // The three money routes share a prefix in text and nothing else: a naive startsWith would
    // have filed /payment-requests under /payments, and both under /pay.
    expect(sectionOf('/payment-requests')).toBe('money');
    expect(sectionOf('/payments')).toBe('money');
    expect(sectionOf('/pay')).toBe('money');
    // A path that merely begins with the same letters is not a child of it.
    expect(sectionOf('/paydesk')).toBeNull();
    expect(sectionOf('/orders-archive')).toBeNull();
  });

  it('משאיר בלי מבטא את מה שמביט על פני כל התחומים — וזו הצהרה, לא פער', () => {
    for (const path of [
      '/dashboard', '/alerts', '/exceptions', '/expenses', '/reports', '/analytics',
      '/settings', '/onboarding', '/admin', '/login', '/',
    ]) {
      expect(sectionOf(path), path).toBeNull();
    }
  });
});

describe('הקיר בין שתי שפות הצבע', () => {
  it('אוצר-המילים של המקום ואוצר-המילים של המצב אינם חולקים אף ערך', () => {
    // A palette name as a tone prop is forbidden; a tone name as a section key would be the same
    // mistake from the other side — `sectionOf` would look like it could answer "alert".
    expect(SECTION_KEYS.filter((key) => (TONES as string[]).includes(key))).toEqual([]);
    expect(SECTION_KEYS).toEqual(['documents', 'procurement', 'money']);
  });

  it('לכל תחום יש מיפוי ב-index.css — מחלקה חסרה אינה שגיאת build', () => {
    for (const key of SECTION_KEYS) {
      expect(css, key).toContain(`[data-section="${key}"]`);
    }
    // Every domain resolves the accent, and they all resolve the SAME one. A fourth domain added
    // to SECTION_KEYS without a rule fails above; a domain quietly given its own token fails here.
    for (const body of ruleBodies(/^\[data-section=/)) {
      expect(body).toContain('--section-accent: var(--color-section-accent)');
    }
  });

  it('מבטא אזור הוא ליטרל קפוא, טוקן אחד, ולעולם לא כינוי', () => {
    // T7.1 froze the accents as three distinct literals (275/305/335). T7.3 retired
    // hue-wayfinding — the purple underline read as "a color with no meaning" — and left three
    // token names holding one value. On 19.08.2026 the owner collapsed them: a name is a claim,
    // and three names claimed a per-domain treatment no screen could show. Pinning the exact
    // literal keeps a re-theme from silently repainting navigation; pinning "no var() at all"
    // keeps any future alias out in one stroke; and pinning the COUNT is what stops the three
    // names from creeping back one at a time.
    const OCEANIC = 'oklch(33.66% 0.058 209)';
    const declared = [...rules.matchAll(/--color-section-([\w-]+):\s*([^;]+);/g)];
    expect(declared.map((match) => match[1])).toEqual(['accent']);
    expect(declared[0][2].trim()).toBe(OCEANIC);
    expect(declared[0][2]).not.toContain('var(');
  });

  it('אף כלל מבטא אינו נוגע בטוקן סמנטי, ואף badge/note אינו נוגע במבטא', () => {
    for (const body of ruleBodies(/^(?:\[data-section|\.section-)/)) {
      expect(body.match(SEMANTIC_TOKEN)).toBeNull();
    }
    for (const body of ruleBodies(/^\.(?:badge|note)-/)) {
      expect(body).not.toContain('--color-section-');
      expect(body).not.toContain('--section-accent');
    }
  });

  it('רק Layout קובע data-section, ורק מתוך המסלול', () => {
    // This is the test that fails if an accent is ever used to express a status. It does not try
    // to guess intent: it pins the single writer and the single source. A page that wrote
    // `data-section={invoice.overdue ? 'money' : undefined}` fails on the first assertion; a
    // Layout that switched to `data-section={someState}` fails on the second.
    const writers = tsxFiles()
      .map((file) => [relative('src', file).replace(/\\/g, '/'), readFileSync(file, 'utf8')] as const)
      .filter(([, source]) => source.includes('data-section='));
    expect(writers.map(([file]) => file)).toEqual(['components/Layout.tsx']);

    const layout = writers[0][1];
    const assignments = [...layout.matchAll(/data-section=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    // Either the call is inline, or the identifier handed over is one this same file bound to a
    // `sectionOf(...)` result. Anything bound to state or props satisfies neither.
    for (const expression of assignments) {
      const fromRoute = expression.includes('sectionOf(')
        || [...expression.matchAll(/[A-Za-z_$][\w$]*/g)].some(([name]) => name !== 'undefined'
          && new RegExp(`const ${name}\\s*=[^;]*sectionOf\\(`).test(layout));
      expect(fromRoute, expression).toBe(true);
    }
  });

  it('המבטא מוצג רק כסמל וכ-rule, ואף פעם לא כמילוי מתחת לטקסט', () => {
    // `.section-glyph` colours a glyph; `.section-mark` is a 3px rule with no text in it. Any
    // third consumer of the accent would have to argue for itself here before it could ship.
    const consumers = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => rule[2].includes('var(--section-accent'))
      .map((rule) => rule[1].trim());
    expect(consumers.sort()).toEqual(['.section-glyph', '[data-section] .section-mark']);
    expect(ruleBodies(/^\.section-glyph$/)[0]).toContain('color: var(--section-accent');

    // The tokens live in `@theme` because DESIGN.md says every colour token does, and Tailwind
    // therefore also generates `bg-section-money`, `border-section-money` and friends. Nothing may
    // use them: a `bg-*` accent is a fill behind text, which is the badge/note idiom and belongs
    // to tones alone. All real access goes through `--section-accent`.
    const misuse = tsxFiles()
      .map((file) => [relative('src', file).replace(/\\/g, '/'), readFileSync(file, 'utf8')] as const)
      .filter(([, source]) => /\b(?:bg|border|ring|divide|fill|stroke|shadow|outline|from|to|via)-section-/.test(source));
    expect(misuse.map(([file]) => file)).toEqual([]);
  });
});
