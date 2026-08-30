import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSummary } from './summary';
import { SUMMARY_METRIC_LINES } from './assistant/summaryLines.ts';
import { translateIn } from './i18n/LocaleProvider';

const rpc = vi.fn();
vi.mock('./supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

const scanAlerts = vi.fn();
vi.mock('./alerts', () => ({ scanAlerts: (...args: unknown[]) => scanAlerts(...args) }));

const row = (metric_key: string, value: number | string | null, measured = true) =>
  ({ metric_key, value, measured });

const allFive = () => [
  row('received_week', 4),
  row('awaiting_approval', 2),
  row('expected_payments', '1234.56'),
  row('suppliers_raised', 1),
  row('open_exceptions', 0),
];

/**
 * The shape half: every line carries the KEY, the route and the unit it was defined with. The
 * wording half is below, against the dictionaries — split because a single assertion comparing
 * `t(key)` to `t(key)` would pass whether or not either language says anything at all.
 */
const EXPECTED_LINES = [
  { key: 'received_week', labelKey: 'businessSummary.receivedWeek', labelVars: { days: 7 }, unit: 'count', to: '/invoices' },
  { key: 'awaiting_approval', labelKey: 'businessSummary.awaitingApproval', unit: 'count', to: '/invoices' },
  { key: 'expected_payments', labelKey: 'businessSummary.expectedPayments', unit: 'currency', to: '/payment-requests' },
  { key: 'suppliers_raised', labelKey: 'businessSummary.suppliersRaised', labelVars: { days: 30 }, unit: 'count', to: '/prices' },
  { key: 'open_exceptions', labelKey: 'businessSummary.openExceptions', unit: 'count', to: '/exceptions' },
] as const;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: allFive(), error: null });
  scanAlerts.mockReset().mockResolvedValue({ alerts: [], complete: true, failures: [] });
});

describe('הסיכום העסקי מול המודל השרתי (0165)', () => {
  it('חמשת המדדים שומרים מפתח, תווית עברית, יחידה ויעד ניווט — החוזה של /alerts לא זז', async () => {
    const summary = await buildSummary();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('p2_business_summary_rows');
    expect(summary.lines.map(({ value: _value, ...line }) => line)).toEqual(EXPECTED_LINES);
    expect(summary.complete).toBe(true);
    expect(summary.failures).toEqual([]);
  });

  it('אפס נשאר אפס — מדד שנמדד ומצא כלום אינו הופך ל"אין נתונים"', async () => {
    const summary = await buildSummary();
    const exceptions = summary.lines.find((line) => line.key === 'open_exceptions');
    expect(exceptions?.value).toBe(0);
    // and the string-encoded numeric that PostgREST may return is still a number
    const payments = summary.lines.find((line) => line.key === 'expected_payments');
    expect(payments?.value).toBe(1234.56);
  });

  it('measured:false הופך ל-value:null ולרשומת כשל עם מפתח התווית — וארבעת האחרים נשארים שלמים', async () => {
    rpc.mockResolvedValue({
      data: [...allFive().filter((r) => r.metric_key !== 'suppliers_raised'), row('suppliers_raised', null, false)],
      error: null,
    });
    const summary = await buildSummary();
    expect(summary.lines.find((line) => line.key === 'suppliers_raised')?.value).toBeNull();
    // The field was always called `labelKey` and always held a Hebrew sentence, and `/alerts`
    // renders it as `tDynamic(key) ?? key` — so the miss fell through to the raw Hebrew and read
    // correctly for exactly one kind of reader. It is a key now, with its window as a variable.
    expect(summary.failures).toEqual([
      { code: 'suppliers_raised', labelKey: 'businessSummary.suppliersRaised', labelVars: { days: 30 } },
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
      alerts: [], complete: false, failures: [{ code: 'scan_x', labelKey: 'סריקה X' }],
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

  it('כל תווית נושאת ניסוח מדויק בשתי השפות, כולל החלון כמשתנה', () => {
    // The other half of the split. Both languages are pinned exactly, and the window arrives as a
    // variable rather than baked in — a label that printed a literal `{days}` would pass a
    // truthiness check and fail here.
    const wording = {
      he: {
        receivedWeek: 'חשבוניות שנקלטו ב-7 הימים האחרונים',
        awaitingApproval: 'חשבוניות הממתינות לאישור',
        expectedPayments: 'סכום פתוח בדרישות תשלום',
        suppliersRaised: 'ספקים שהעלו מחיר ב-30 הימים האחרונים',
        openExceptions: 'חריגים פתוחים',
      },
      en: {
        receivedWeek: 'Invoices received in the last 7 days',
        awaitingApproval: 'Invoices awaiting approval',
        expectedPayments: 'Open amount in payment requests',
        suppliersRaised: 'Suppliers that raised a price in the last 30 days',
        openExceptions: 'Open exceptions',
      },
    } as const;
    for (const locale of ['he', 'en'] as const) {
      for (const line of EXPECTED_LINES) {
        const name = line.labelKey.slice('businessSummary.'.length) as keyof typeof wording['he'];
        // `as const` narrows each row separately, so the three without a window have no such
        // property at all rather than an undefined one.
        const vars = 'labelVars' in line ? line.labelVars : undefined;
        expect(translateIn(locale, line.labelKey, vars)).toBe(wording[locale][name]);
      }
    }
  });

  it('ההגדרות לא חוזרות לדפדפן — אין שאילתת טבלה ישירה ב-summary.ts', () => {
    // Vitest runs with the repo root as cwd; import.meta.url is not a file: URL under jsdom.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'summary.ts'), 'utf8');
    expect(source).not.toContain(".from('invoices')");
    expect(source).not.toContain(".from('exceptions')");
    expect(source).not.toContain('.from(');
    // and the single server definition is the one being called
    expect(source).toContain("supabase.rpc('p2_business_summary_rows')");
  });
});
