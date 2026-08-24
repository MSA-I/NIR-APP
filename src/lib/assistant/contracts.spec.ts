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
  ASSISTANT_DRAFT_LABEL,
  ASSISTANT_DRAFT_ROLES,
  AssistantBlockSchema,
  CALENDAR_PERIOD_LABELS,
  CALENDAR_PERIODS,
  DraftBlockSchema,
  FACT_KINDS,
  ProductHelpEntrySchema,
  TIME_WINDOW_LABELS,
} from './contracts';
import { APP_ROUTE_POLICY } from '../routePolicy';

describe('calendar periods (#178, #189)', () => {
  it('names the calendar month separately from the trailing windows', () => {
    expect(CALENDAR_PERIODS).toContain('this_calendar_month');
    // A trailing window may never be called a month, and a calendar period may never be called
    // "the last 30 days" — that is the whole point of #178.
    for (const label of Object.values(TIME_WINDOW_LABELS)) {
      expect(label).toMatch(/הימים האחרונים/);
    }
    expect(CALENDAR_PERIOD_LABELS.this_calendar_month).not.toMatch(/הימים האחרונים/);
    expect(CALENDAR_PERIOD_LABELS.this_calendar_month).toMatch(/חודש/);
  });

  it('labels every declared calendar period', () => {
    for (const period of CALENDAR_PERIODS) {
      expect(CALENDAR_PERIOD_LABELS[period]?.length).toBeGreaterThan(0);
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
    expect(ASSISTANT_DRAFT_LABEL).toBe('טיוטה');
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
