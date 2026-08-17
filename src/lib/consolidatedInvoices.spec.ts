import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './supabase';
import {
  consolidatedStatusLabel,
  getConsolidatedInvoiceWorkspace,
  matchChannelLabel,
  matchGroupLabel,
  previousJerusalemMonth,
} from './consolidatedInvoices';

vi.mock('./supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

describe('consolidated supplier invoice UI model', () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockReset();
  });

  it('locks the intake to the previous Jerusalem calendar month at the year boundary', () => {
    expect(previousJerusalemMonth(new Date('2026-01-01T00:30:00.000Z'))).toEqual({
      value: '2025-12',
      start: '2025-12-01',
      end: '2025-12-31',
      label: 'דצמבר 2025',
    });
  });

  it('uses the Jerusalem day rather than the caller timezone', () => {
    expect(previousJerusalemMonth(new Date('2026-03-31T21:30:00.000Z')).value).toBe('2026-03');
  });

  it('names every operational group and comparison channel in Hebrew', () => {
    expect((['matched', 'missing_source', 'source_not_on_anchor', 'ambiguous', 'quantity_mismatch', 'price_mismatch'] as const).map(matchGroupLabel)).toEqual([
      'מותאם', 'חסר מקור', 'מקור שלא הופיע במרכזת', 'עמום', 'פער כמות', 'פער מחיר',
    ]);
    expect((['anchor_vs_interim', 'anchor_vs_receipts', 'interim_vs_receipts'] as const).map(matchChannelLabel)).toEqual([
      'מרכזת מול חשבוניות ביניים', 'מרכזת מול קבלות שהושלמו', 'חשבוניות ביניים מול קבלות',
    ]);
    expect(consolidatedStatusLabel('blocked')).toBe('חסומה לרישום');
    expect(consolidatedStatusLabel('needs_review')).toBe('נדרשת בדיקה');
  });

  it('normalizes workspaces returned by the previous RPC shape', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: {
        case: { id: 'case-1' },
        anchor: null,
        sources: [],
        reconciliation: {},
        current_revision: null,
        warnings: [],
      },
      error: null,
    } as never);

    const workspace = await getConsolidatedInvoiceWorkspace('case-1');

    expect(workspace.intake).toBeNull();
    expect(workspace.pages).toEqual([]);
  });
});
