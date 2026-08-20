import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanLimitNote } from './PlanLimitNote';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

const row = (over: Record<string, unknown> = {}) => ({
  metric_key: 'documents.monthly',
  label: 'מסמכים בחודש',
  used: 10,
  usage_limit: 100,
  unlimited: false,
  measured: true,
  remaining: 90,
  percent_used: 10,
  period_end: '2026-09-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  rpc.mockResolvedValue({ data: [row()], error: null });
});

const settle = () => waitFor(() => expect(rpc).toHaveBeenCalled());

describe('התרעת מכסת מסלול', () => {
  it('שותקת כשהמכסה רחוקה — באנר קבוע הוא קישוט, וקישוט על כסף נקרא כלחץ', async () => {
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

  it('מתריעה כשמתקרבים למכסה, ואומרת שהקיים אינו מושפע', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 85, remaining: 15, percent_used: 85 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/85/)).toBeInTheDocument();
    expect(screen.getByText(/המסמכים הקיימים אינם מושפעים/)).toBeInTheDocument();
  });

  it('כשהמכסה נוצלה — אומרת מה ייחסם ומה נשאר זמין, בלי דחיפות מומצאת', async () => {
    rpc.mockResolvedValue({ data: [row({ used: 100, remaining: 0, percent_used: 100 })], error: null });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/עיבוד מסמך חדש ייחסם/)).toBeInTheDocument();
    expect(screen.getByText(/נשארים זמינים במלואם/)).toBeInTheDocument();
    // No fabricated countdown, and no claim about a plan whose price and limits do not exist yet.
    expect(screen.queryByText(/נותרו רק/)).not.toBeInTheDocument();
    expect(screen.queryByText(/שדרג ל/)).not.toBeInTheDocument();
  });

  it('מכסה שלא הוגדרה מוצגת כתקלת הגדרה אצלנו, לא כהזמנה לשדרג', async () => {
    rpc.mockResolvedValue({
      data: [row({ measured: false, unlimited: false, usage_limit: null, percent_used: null })],
      error: null,
    });
    render(<PlanLimitNote metricKey="documents.monthly" />);
    expect(await screen.findByText(/זו הגדרה במערכת/)).toBeInTheDocument();
    expect(screen.queryByText(/לשדרג/)).not.toBeInTheDocument();
  });
});
