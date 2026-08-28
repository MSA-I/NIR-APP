import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSummary } from './summary';
import { SUMMARY_METRIC_LINES } from './assistant/summaryLines.ts';

const rpc = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

const scanAlerts = vi.fn();
vi.mock('./alerts', () => ({ scanAlerts: (...args: unknown[]) => scanAlerts(...args) }));

const row = (metric_key: string, value: number | string | null, measured = true, currency: string | null = null) =>
  ({ metric_key, value, measured, currency });

const allFive = () => [
  row('received_week', 4),
  row('awaiting_approval', 2),
  row('expected_payments', '1234.56', true, 'ILS'),
  row('suppliers_raised', 1),
  row('open_exceptions', 0),
];

const EXPECTED_LINES = [
  { key: 'received_week', label: 'חשבוניות שנקלטו ב-7 הימים האחרונים', unit: 'count', to: '/invoices', currency: null },
  { key: 'awaiting_approval', label: 'חשבוניות הממתינות לאישור', unit: 'count', to: '/invoices', currency: null },
  { key: 'expected_payments', label: 'סכום פתוח בדרישות תשלום', unit: 'currency', to: '/payment-requests', currency: 'ILS' },
  { key: 'suppliers_raised', label: 'ספקים שהעלו מחיר ב-30 הימים האחרונים', unit: 'count', to: '/prices', currency: null },
  { key: 'open_exceptions', label: 'חריגים פתוחים', unit: 'count', to: '/exceptions', currency: null },
] as const;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: allFive(), error: null });
  scanAlerts.mockReset().mockResolvedValue({ alerts: [], complete: true, failures: [] });
});

describe('הסיכום העסקי מול המודל השרתי (0165)', () => {
  it('חמשת המדדים שומרים מפתח, תווית עברית, יחידה ויעד ניווט — החוזה של /alerts לא זז', async () => {
    const summary = await buildSummary();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('p2_business_summary_rows_by_currency');
    expect(summary.lines.map(({ value: _value, ...line }) => line)).toEqual(EXPECTED_LINES);
    expect(summary.complete).toBe(true);
    expect(summary.failures).toEqual([]);
  });

  it('returns one expected-payments line per currency and never their sum', async () => {
    rpc.mockResolvedValue({
      data: [...allFive(), row('expected_payments', 3100, true, 'USD')], error: null,
    });
    const summary = await buildSummary();
    const payments = summary.lines.filter((line) => line.key === 'expected_payments');
    expect(payments.map((line) => ({ value: line.value, currency: line.currency }))).toEqual([
      { value: 1234.56, currency: 'ILS' }, { value: 3100, currency: 'USD' },
    ]);
    expect(payments.some((line) => line.value === 4334.56)).toBe(false);
  });

  it('אפס נשאר אפס — מדד שנמדד ומצא כלום אינו הופך ל"אין נתונים"', async () => {
    const summary = await buildSummary();
    const exceptions = summary.lines.find((line) => line.key === 'open_exceptions');
    expect(exceptions?.value).toBe(0);
    // and the string-encoded numeric that PostgREST may return is still a number
    const payments = summary.lines.find((line) => line.key === 'expected_payments');
    expect(payments?.value).toBe(1234.56);
  });

  it('measured:false הופך ל-value:null ולרשומת כשל עם התווית העברית — וארבעת האחרים נשארים שלמים', async () => {
    rpc.mockResolvedValue({
      data: [...allFive().filter((r) => r.metric_key !== 'suppliers_raised'), row('suppliers_raised', null, false)],
      error: null,
    });
    const summary = await buildSummary();
    expect(summary.lines.find((line) => line.key === 'suppliers_raised')?.value).toBeNull();
    expect(summary.failures).toEqual([
      { code: 'suppliers_raised', label: 'ספקים שהעלו מחיר ב-30 הימים האחרונים' },
    ]);
    expect(summary.complete).toBe(false);
    expect(summary.lines.filter((line) => line.value != null)).toHaveLength(4);
  });

  it('קריאת RPC שנכשלה כולה — חמשת המדדים null, חמישה כשלים, complete:false', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'network' } });
    const summary = await buildSummary();
    expect(summary.lines.every((line) => line.value === null)).toBe(true);
    expect(summary.failures.map((failure) => failure.code)).toEqual(EXPECTED_LINES.map((line) => line.key));
    expect(summary.complete).toBe(false);
    // the alert scan still ran in parallel and its result is not blanked
    expect(scanAlerts).toHaveBeenCalledTimes(1);
  });

  it('שורה שחסרה בתשובת השרת נחשבת כשל של אותו מדד בלבד — לא הנחה שקטה של אפס', async () => {
    rpc.mockResolvedValue({ data: allFive().filter((r) => r.metric_key !== 'received_week'), error: null });
    const summary = await buildSummary();
    expect(summary.lines.find((line) => line.key === 'received_week')?.value).toBeNull();
    expect(summary.failures.map((failure) => failure.code)).toEqual(['received_week']);
  });

  it('כשלי סריקת ההתראות מצטרפים לפני כשלי המדדים, כמו בהתנהגות המקורית', async () => {
    scanAlerts.mockResolvedValue({
      alerts: [], complete: false, failures: [{ code: 'scan_x', label: 'סריקה X' }],
    });
    rpc.mockResolvedValue({ data: [...allFive().slice(1), row('received_week', null, false)], error: null });
    const summary = await buildSummary();
    expect(summary.failures.map((failure) => failure.code)).toEqual(['scan_x', 'received_week']);
    expect(summary.complete).toBe(false);
  });

  // The anti-divergence guard. This is a TEXTUAL check, not a semantic one: it cannot prove the
  // SQL and a future query agree — only that this module holds no direct table query at all, so
  // the five definitions cannot quietly fork back into the browser. The semantic proof lives in
  // supabase/tests/p57_business_summary_parity.sql.
  // Key parity between the SQL definition and the wording table, in BOTH directions: a metric
  // key added to the RPC without a label here is a number reaching a user with nothing naming
  // it, and a label with no RPC line is wording for a figure that never arrives. Textual, like
  // the guard below — it parses the migration's `return query select '<key>'::text` lines, which
  // is the shape every metric block in 0165 uses for both its success and failure branches.
  it('כל מפתח ב-RPC נושא ניסוח בטבלה, וכל ניסוח נשען על מפתח ב-RPC — בשני הכיוונים', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0165_business_summary_rows.sql'),
      'utf8',
    );
    const sqlKeys = new Set(
      [...migration.matchAll(/return query select '([a-z_]+)'::text/g)].map((match) => match[1]),
    );
    expect(sqlKeys.size).toBeGreaterThan(0);
    const labeledKeys = new Set(SUMMARY_METRIC_LINES.map((line) => line.key));
    expect([...sqlKeys].sort()).toEqual([...labeledKeys].sort());
  });

  it('ההגדרות לא חוזרות לדפדפן — אין שאילתת טבלה ישירה ב-summary.ts', () => {
    // Vitest runs with the repo root as cwd; import.meta.url is not a file: URL under jsdom.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'summary.ts'), 'utf8');
    expect(source).not.toContain(".from('invoices')");
    expect(source).not.toContain(".from('exceptions')");
    expect(source).not.toContain('.from(');
    // and the single server definition is the one being called
    expect(source).toContain("supabase.rpc('p2_business_summary_rows_by_currency')");
  });
});
