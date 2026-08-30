/**
 * The contract seam the read-model plan adds: a calendar period the assistant may name out loud,
 * a draft block that carries a supplier reminder without ever claiming it was sent, and the
 * product-help entry shape #192 makes the single authoritative source.
 *
 * These are contract tests, not rendering tests. They pin the shapes that Edge validation, the
 * Deno tools and the browser renderer all read from one file, so a shape change is one reviewed
 * edit rather than three that can drift.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_DRAFT_LABEL_KEY,
  ASSISTANT_DRAFT_ROLES,
  ASSISTANT_SENT_CLAIM_MARKER,
  AssistantBlockSchema,
  ASSISTANT_SENT_CLAIM_PATTERNS,
  CALENDAR_PERIOD_LABEL_KEYS,
  CALENDAR_PERIODS,
  DraftBlockSchema,
  FACT_KINDS,
  ProductHelpEntrySchema,
  PRODUCT_HELP_LOCALES,
  TIME_WINDOW_LABEL_KEYS,
} from './contracts';
import { APP_ROUTE_POLICY } from '../routePolicy';
import { translateIn } from '../i18n/LocaleProvider';
import { he } from '../i18n/dictionaries/he';
import { en } from '../i18n/dictionaries/en';

describe('calendar periods (#178, #189)', () => {
  /**
   * #178 is a claim about what the words MEAN, so it has to hold in every language the answer can
   * arrive in. Checking only the key would prove nothing — a key is a string and matches nothing —
   * and checking only Hebrew would let an English reader be told "last 30 days" over a calendar
   * computation, which is the exact confusion #178 was decided to end.
   */
  const TRAILING = { he: /הימים האחרונים/, en: /last \d+ days/i };
  const MONTHLY = { he: /חודש/, en: /month/i };

  it.each(PRODUCT_HELP_LOCALES)(
    'names the calendar month separately from the trailing windows in %s',
    (locale) => {
      expect(CALENDAR_PERIODS).toContain('this_calendar_month');
      for (const key of Object.values(TIME_WINDOW_LABEL_KEYS)) {
        expect(translateIn(locale, key)).toMatch(TRAILING[locale]);
        expect(translateIn(locale, key)).not.toMatch(MONTHLY[locale]);
      }
      const month = translateIn(locale, CALENDAR_PERIOD_LABEL_KEYS.this_calendar_month);
      expect(month).not.toMatch(TRAILING[locale]);
      expect(month).toMatch(MONTHLY[locale]);
    },
  );

  it.each(PRODUCT_HELP_LOCALES)('labels every declared calendar period in %s', (locale) => {
    for (const period of CALENDAR_PERIODS) {
      const key = CALENDAR_PERIOD_LABEL_KEYS[period];
      const label = translateIn(locale, key);
      expect(label.length).toBeGreaterThan(0);
      // `translate` returns the key on a miss, exactly as the browser does — so an unresolved key
      // is a non-empty string and would sail past a length check on its own.
      expect(label).not.toBe(key);
    }
  });
});

describe('draft block (#191)', () => {
  const draft = {
    type: 'draft' as const,
    text: 'שלום, נשמח לעדכון על מועד האספקה של הזמנה 1042.',
    fact_ids: ['f1'],
    source_ids: [],
  };

  it('is part of the answer block union', () => {
    expect(AssistantBlockSchema.safeParse(draft).success).toBe(true);
  });

  it('carries no label of its own — the label is a product constant', () => {
    // Split: the contract pins the KEY, and each dictionary pins the word a reader sees. The
    // product still decides the label; it just no longer decides the reader's language with it.
    expect(ASSISTANT_DRAFT_LABEL_KEY).toBe('assistantContracts.draftLabel');
    expect(he.assistantContracts.draftLabel).toBe('טיוטה');
    expect(en.assistantContracts.draftLabel).toBe('Draft');
    expect(DraftBlockSchema.safeParse({ ...draft, label: 'נשלח' }).success).toBe(false);
  });

  it('must rest on at least one fact issued by the run', () => {
    expect(DraftBlockSchema.safeParse({ ...draft, fact_ids: [] }).success).toBe(false);
  });

  it('is offered only to the roles #191 named', () => {
    expect([...ASSISTANT_DRAFT_ROLES]).toEqual(['owner', 'office']);
    expect(ASSISTANT_DRAFT_ROLES).not.toContain('accountant');
  });
});

describe('fact kinds for the new read models (#189, #190, #192)', () => {
  it('covers the comparison, baseline and product-help semantics', () => {
    for (const kind of [
      'supplier.price_baseline',
      'comparison.saved_vs_next',
      'comparison.extra_vs_cheapest',
      'comparison.minimum_breach',
      'product_help.entry',
    ]) {
      expect(FACT_KINDS).toContain(kind);
    }
  });
});

describe('product-help entry (#192)', () => {
  const entry = {
    id: 'where_do_i_import_a_price_list',
    version: 1,
    owner: 'product',
    locale: 'he' as const,
    roles: ['owner', 'office'] as const,
    route: 'prices' as const,
    label: 'ייבוא מחירון ספק',
    steps: ['נכנסים למסך המחירונים', 'בוחרים ספק', 'מעלים את הקובץ ומאשרים'],
    source: 'docs/ASSISTANT.md §7.3',
    updated_at: '2026-08-24',
  };

  it('accepts a complete entry whose route is a canonical app route', () => {
    const parsed = ProductHelpEntrySchema.safeParse(entry);
    expect(parsed.success).toBe(true);
    expect(Object.keys(APP_ROUTE_POLICY)).toContain(entry.route);
  });

  it('refuses an entry without steps, locale or source — no guessing allowed', () => {
    expect(ProductHelpEntrySchema.safeParse({ ...entry, steps: [] }).success).toBe(false);
    expect(ProductHelpEntrySchema.safeParse({ ...entry, source: '' }).success).toBe(false);
    expect(ProductHelpEntrySchema.safeParse({ ...entry, locale: 'fr' }).success).toBe(false);
  });

  it('refuses a role that is not an assistant role', () => {
    expect(ProductHelpEntrySchema.safeParse({ ...entry, roles: ['kitchen'] }).success).toBe(false);
  });
});

describe('the sent-claim marker (#191)', () => {
  it('exists exactly once so the guard has one line to allow', () => {
    expect(ASSISTANT_SENT_CLAIM_MARKER).toBe('נשלח');
    // The refusal in supabase/functions/assistant/validate.ts imports this rather than repeating
    // the literal; scripts/check-assistant-no-send.mjs allows only this one definition line.
    expect(he.assistantContracts.draftLabel).not.toContain(ASSISTANT_SENT_CLAIM_MARKER);
  });

  /**
   * The claim has to be unmakeable in EVERY language the product answers in. While there was one
   * language a substring test was the whole guard; a second language turned that same test into a
   * hole that opens by asking the question in English.
   */
  it('refuses the sent claim in every language the assistant can answer in', () => {
    for (const locale of PRODUCT_HELP_LOCALES) {
      expect(ASSISTANT_SENT_CLAIM_PATTERNS[locale]).toBeInstanceOf(RegExp);
      // No language may be given a label that its own refusal would reject.
      const label = translateIn(locale, ASSISTANT_DRAFT_LABEL_KEY);
      expect(label).not.toMatch(ASSISTANT_SENT_CLAIM_PATTERNS[locale]);
    }
    expect(ASSISTANT_SENT_CLAIM_PATTERNS.he.test('ההודעה נשלחה לספק')).toBe(true);
    expect(ASSISTANT_SENT_CLAIM_PATTERNS.en.test('The message was sent to the supplier')).toBe(true);
    // The word boundary is the whole reason this is a pattern and not a substring: three ordinary
    // English words contain `sent`, and refusing a draft for saying "consent" would teach the next
    // reader to delete the guard rather than obey it.
    for (const innocent of ['We need your consent', 'The data presented here', 'One more sentence']) {
      expect(ASSISTANT_SENT_CLAIM_PATTERNS.en.test(innocent)).toBe(false);
    }
  });
});
