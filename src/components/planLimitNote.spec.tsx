import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanLimitNote } from './PlanLimitNote';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

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
    const { container } = render(<PlanLimitNote metricKey="documents.monthly" />);
    await settle();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('שותקת כשאין הגבלה כלל', async () => {
    rpc.mockResolvedValue({
      data: [row({ unlimited: true, usage_limit: null, percent_used: null, remaining: null })],
      error: null,
    });
    const { container } = render(<PlanLimitNote metricKey="documents.monthly" />);
    await settle();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('ב־60% מדווחת עובדות שימוש בלבד — בלי המלצת מסלול ובלי השוואת חיסכון', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 60, remaining: 40, percent_used: 60 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/60/)).toBeInTheDocument();
    expect(screen.getByText(/100/)).toBeInTheDocument();
    expect(screen.queryByText(/שדרג|מומלץ|כדאי|חיסכון|לחסוך/)).not.toBeInTheDocument();
  });

  it('ב־80% עדיין עובדות, ובלי דחיפות מומצאת', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 80, remaining: 20, percent_used: 80 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/80/)).toBeInTheDocument();
    expect(screen.queryByText(/נותרו רק|מהרו|בעוד \d+ שעות/)).not.toBeInTheDocument();
  });

  it('ב־100% אומרת שרק עיבוד חדש נעצר, ואין מחיקה או חסימה למפרע', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 100, remaining: 0, percent_used: 100 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/עיבוד חדש נעצר/)).toBeInTheDocument();
    expect(screen.getByText(/אינו נמחק/)).toBeInTheDocument();
    expect(screen.getByText(/למפרע/)).toBeInTheDocument();
  });

  it('מדברת על תקופת השימוש, לא על תקופת החיוב — הן נפרדות לפי #242', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 90, remaining: 10, percent_used: 90 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
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
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/זו הגדרה במערכת/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText(/לשדרג|שדרג/)).not.toBeInTheDocument();
  });
});
