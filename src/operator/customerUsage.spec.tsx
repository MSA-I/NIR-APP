import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CustomerUsage from './CustomerUsage';
import type { UsageRow } from '../lib/platform';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  metric_key: 'documents.monthly',
  label: 'מסמכים בחודש',
  unit: 'documents',
  measure: 'per_period',
  used: 40,
  usage_limit: 100,
  unlimited: false,
  measured: true,
  remaining: 60,
  percent_used: 40,
  period_start: '2026-08-01T00:00:00.000Z',
  period_end: '2026-09-01T00:00:00.000Z',
  period_source: 'calendar_month',
  ...over,
});

describe('פאנל השימוש של המפעיל', () => {
  it('אומר לפי איזו הגדרת תקופה חושב המספר', () => {
    render(<CustomerUsage rows={[row()]} />);
    expect(screen.getByText(/לא התקבלה תקופת חיוב/)).toBeInTheDocument();
  });

  it('מודד שאינו נמדד מוצג כמקף ומסביר עצמו, ולא כאפס', () => {
    // "0 של 500" for an unmetered thing is a claim about the customer's behaviour manufactured
    // out of our own missing instrumentation — an operator would act on a number we invented.
    render(<CustomerUsage rows={[row({
      metric_key: 'suppliers.max', label: 'ספקים', measure: 'current',
      used: null, usage_limit: null, measured: false, remaining: null, percent_used: null,
    })]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('אינו נמדד')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('מבחין בין «אין הגבלה» לבין «לא הוגדרה מגבלה»', () => {
    render(<CustomerUsage rows={[
      row({ metric_key: 'a.monthly', label: 'ללא הגבלה', unlimited: true, usage_limit: null, percent_used: null, remaining: null }),
      row({ metric_key: 'b.monthly', label: 'לא מוגדר', measured: false, unlimited: false, usage_limit: null, used: null, percent_used: null, remaining: null }),
    ]} />);
    expect(screen.getByText('ללא הגבלה', { selector: '.badge-idle' })).toBeInTheDocument();
    expect(screen.getByText('לא הוגדרה מגבלה')).toBeInTheDocument();
  });

  it('מסמן חריגה ממכסה בטון של התראה', () => {
    render(<CustomerUsage rows={[row({ used: 100, remaining: 0, percent_used: 100 })]} />);
    expect(screen.getByText('100%')).toHaveClass('badge-alert');
  });
});
