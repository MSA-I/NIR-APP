import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { PlanLimitNote } from './PlanLimitNote';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

/**
 * The note reads through the shared cache now (ADR-0003), so it needs the two providers the app
 * shell already supplies: the query client, and the tenant scope every key is rooted at.
 *
 * A FRESH CLIENT PER TEST, deliberately. One client across the file would serve the previous
 * test's snapshot from cache and the next assertion would pass without a request having happened —
 * which is the exact failure this component must never have, since what it renders is a claim
 * about the customer's current period.
 */
const renderNote = (org: string | null = 'org-1', metricKey = 'documents.monthly') => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <OrgScopeProvider org={org}><PlanLimitNote metricKey={metricKey} /></OrgScopeProvider>
  </QueryClientProvider>,
);

const row = (over: Record<string, unknown> = {}) => ({
  metric_key: 'documents.monthly',
  label: 'מסמכים',
  used: 10,
  usage_limit: 100,
  unlimited: false,
  measured: true,
  remaining: 90,
  percent_used: 10,
  period_start: '2026-08-04T00:00:00.000Z',
  period_end: '2026-09-04T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  rpc.mockResolvedValue({ data: [row()], error: null });
});

const settle = () => waitFor(() => expect(rpc).toHaveBeenCalled());

describe('התרעת מכסת מסלול', () => {
  it('שותקת מתחת ל־60% — הסף הראשון ש־#202 מכיר בו', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 59, remaining: 41, percent_used: 59 })], error: null });
    const { container } = renderNote();
    await settle();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('שותקת כשאין הגבלה כלל', async () => {
    rpc.mockResolvedValue({
      data: [row({ unlimited: true, usage_limit: null, percent_used: null, remaining: null })],
      error: null,
    });
    const { container } = renderNote();
    await settle();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('ב־60% מדווחת עובדות שימוש בלבד — בלי המלצת מסלול ובלי השוואת חיסכון', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 60, remaining: 40, percent_used: 60 })], error: null });
    renderNote();
    expect(await screen.findByText(/60/)).toBeInTheDocument();
    expect(screen.getByText(/100/)).toBeInTheDocument();
    expect(screen.queryByText(/שדרג|מומלץ|כדאי|חיסכון|לחסוך/)).not.toBeInTheDocument();
  });

  it('ב־80% עדיין עובדות, ובלי דחיפות מומצאת', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 80, remaining: 20, percent_used: 80 })], error: null });
    renderNote();
    expect(await screen.findByText(/80/)).toBeInTheDocument();
    expect(screen.queryByText(/נותרו רק|מהרו|בעוד \d+ שעות/)).not.toBeInTheDocument();
  });

  it('ב־100% אומרת שרק עיבוד חדש נעצר, ואין מחיקה או חסימה למפרע', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 100, remaining: 0, percent_used: 100 })], error: null });
    renderNote();
    expect(await screen.findByText(/עיבוד חדש נעצר/)).toBeInTheDocument();
    expect(screen.getByText(/אינו נמחק/)).toBeInTheDocument();
    expect(screen.getByText(/למפרע/)).toBeInTheDocument();
  });

  it('מדברת על תקופת השימוש, לא על תקופת החיוב — הן נפרדות לפי #242', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 90, remaining: 10, percent_used: 90 })], error: null });
    renderNote();
    expect(await screen.findByText(/תקופת השימוש/)).toBeInTheDocument();
    expect(screen.queryByText(/תקופת החיוב/)).not.toBeInTheDocument();
    // The period is anchored to the organization's signup date, so no calendar-month language.
    expect(screen.queryByText(/החודש הקלנדרי|תחילת החודש|ב־1 ל/)).not.toBeInTheDocument();
  });

  it('מכסה שלא הוגדרה מוצגת כמקף ותקלת הגדרה אצלנו — לא כאפס ולא כהזמנה לשדרג', async () => {
    rpc.mockResolvedValue({
      data: [row({ measured: false, unlimited: false, usage_limit: null, used: null, percent_used: null })],
      error: null,
    });
    renderNote();
    expect(await screen.findByText(/זו הגדרה במערכת/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText(/לשדרג|שדרג/)).not.toBeInTheDocument();
  });

  /**
   * The same gate `PlanBadge` and `useFeatureFlags` carry, for the same reason: before AuthProvider
   * has an organisation the Supabase client may hold no session, and `organization_usage_snapshot`
   * is a tenant resolver `anon` holds no EXECUTE on. An early call leaves as an anonymous request
   * that can only come back 502 — never as a grant.
   */
  it('אינה שואלת לפני שיש ארגון — קריאה מוקדמת יוצאת אנונימית', async () => {
    const { container } = renderNote(null);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(rpc).not.toHaveBeenCalled();
  });
});
