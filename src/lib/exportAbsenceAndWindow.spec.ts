import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildStyledMonthlyWorkbook, type MonthlyReportLabels } from './monthlyReport';
import { monthlyReportTemplateValues } from './reportTemplateExport';
import { buildWorkbook, type WorkbookSpec } from './workbook';
import { fmtMoneyExact } from './format';
import { he } from './i18n/dictionaries/he';
import type { Dictionary } from './i18n/dictionaries/he';
import { translate } from './i18n/t';
import type { TKey } from './i18n/t';

/**
 * FOUR EXPORT ORACLES — `EXP-01`, `EXP-03`, `EXP-05`, `EXP-06` (QA sweep 04.09.2026).
 *
 * Every assertion reads the workbook BACK FROM THE BYTES the writer produced. An expectation
 * against the builder's own object proves that we set a property; the accountant opens the file.
 *
 * The expected Hebrew is written out as a literal on purpose — the same convention
 * `monthlyReport.spec.ts` states in its own header. Comparing `t(key)` against `t(key)` would pass
 * whatever the words happened to be, and the words ARE the file somebody sends to their accountant.
 */

const t = ((key, vars) => translate(he as unknown as Dictionary, key, vars)) as
  (key: TKey, vars?: Record<string, string | number>) => string;

/** The single marker for "not measured", in every exported cell. Owned by `workbook.ts`. */
const ABSENT = '—';

const EXCEPTIONS_SHEET = 'חריגים פתוחים כרגע';
const OUT_OF_WINDOW = 'פתוחים במועד ההפקה — אינם מוגבלים לתקופת הדוח';

const labels: MonthlyReportLabels = {
  invoiceReview: { approved: 'מאושרת' },
  invoicePayment: { unpaid: 'לא שולמה' },
  creditReason: { shortage: 'חוסר' },
  creditStatus: { open: 'פתוח' },
  exceptionType: { price_mismatch: 'פער מחיר' },
};

const read = async (spec: WorkbookSpec) =>
  XLSX.read(await buildWorkbook(spec), { type: 'array', cellNF: true });

/** Every cell of a sheet as rows of raw values — title rows included, so `A2` is `grid[1][0]`. */
const grid = (book: XLSX.WorkBook, name: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1 });

/* ---------------------------------------------------------------------------
 * `EXP-01` — August 2026: one shekel invoice, one dollar invoice, no payments
 * -------------------------------------------------------------------------*/

const mixedInvoices = [
  { supplier: { name: 'ספק שקלי' }, invoice_number: 'I-1', invoice_date: '2026-08-01',
    amount_before_vat: 12400, vat_amount: 0, total_amount: 12400, currency: 'ILS',
    review_status: 'approved', payment_status: 'unpaid' },
  { supplier: { name: 'ספק דולרי' }, invoice_number: 'U-1', invoice_date: '2026-08-02',
    amount_before_vat: 3100, vat_amount: 0, total_amount: 3100, currency: 'USD',
    review_status: 'approved', payment_status: 'unpaid' },
];

const mixedMonth = () => buildStyledMonthlyWorkbook({
  t,
  orgName: 'עסק לדוגמה',
  baseCurrency: 'ILS',
  month: '2026-08',
  generatedAt: new Date('2026-09-04T02:42:00.000Z'),
  data: { invoices: mixedInvoices, payments: [], credits: [], exceptions: [] },
  labels,
  summary: monthlyReportTemplateValues({
    orgName: 'עסק לדוגמה',
    periodLabel: 'אוגוסט 2026',
    periodFrom: '01.08.2026',
    periodTo: '31.08.2026',
    generatedAt: '04.09.2026, 02:42',
    invoices: mixedInvoices,
  }),
  paymentsAreAllocatedPortion: true,
});

/* ---------------------------------------------------------------------------
 * `EXP-03` / `EXP-05` / `EXP-06` — January 2020: nothing happened, and two
 * exceptions are open TODAY
 * -------------------------------------------------------------------------*/

const emptyMonth = () => buildStyledMonthlyWorkbook({
  t,
  orgName: 'עסק לדוגמה',
  baseCurrency: 'ILS',
  month: '2020-01',
  generatedAt: new Date('2026-09-04T02:39:00.000Z'),
  data: {
    invoices: [],
    payments: [],
    credits: [],
    exceptions: [
      { type: 'price_mismatch', title: 'חשבונית תבליני הגליל ממאי', supplier: { name: 'תבליני הגליל' } },
      { type: 'price_mismatch', title: 'בשר והבן #7702', supplier: { name: 'בשר והבן' } },
    ],
  },
  labels,
  summary: monthlyReportTemplateValues({
    orgName: 'עסק לדוגמה',
    periodLabel: 'ינואר 2020',
    periodFrom: '01.01.2020',
    periodTo: '31.01.2020',
    generatedAt: '04.09.2026, 02:39',
    invoices: [],
  }),
  paymentsAreAllocatedPortion: true,
});

describe('EXP-01 — the mixed-currency month is not a second-class workbook', () => {
  it('states its reporting window on every sheet that asserts one', async () => {
    const book = await read(mixedMonth());
    const withWindow = book.SheetNames.filter((name) => name !== EXCEPTIONS_SHEET);
    expect(withWindow.length).toBeGreaterThan(0);
    for (const name of withWindow) {
      expect(String(book.Sheets[name].A2?.v ?? '')).toContain('אוגוסט 2026 · 01.08.2026–31.08.2026');
    }
  });

  it('leaves the payment and credit amounts of a month with none unstated, never 0.00', async () => {
    const rows = grid(await read(mixedMonth()), 'פרטי הדוח');
    const named = (label: string) => rows.filter((row) => row[0] === label);
    // One block per currency, so two rows each — and 12,400 ILS with 3,100 USD is never one sum.
    for (const label of ['תשלומים כנגד חשבוניות', 'זיכויים']) {
      const block = named(label);
      expect(block).toHaveLength(2);
      for (const row of block) {
        // The COUNT was taken over an empty set and is a real zero.
        expect(row[1]).toBe(0);
        // The AMOUNT was never measured. `0.00` would be this file asserting nothing was paid.
        expect(row[2]).toBe(ABSENT);
      }
    }
  });
});

describe('EXP-03 — one representation of "not measured" in an exported cell', () => {
  /**
   * The three shapes the sweep found in ONE workbook, one row apart: a numeric column whose value
   * is absent, a text money column built by joining an empty per-currency list, and a column that
   * already went through `fmtMoneyExact`. All three mean the same thing and must read the same.
   */
  it('renders a blank number, an empty money list and fmtMoneyExact identically', async () => {
    const emptyList: { amount: number; currency: string }[] = [];
    const book = XLSX.read(await buildWorkbook({
      title: 'סיכום רכישות מוצרים — עסק לדוגמה',
      subtitle: '01.01.2026 – 31.12.2026',
      sheets: [{
        name: 'מוצרים',
        columns: [
          { header: 'התקבל', key: 'received', width: 10, type: 'number' },
          { header: 'הוצאה ברוטו', key: 'gross', width: 20 },
          { header: 'מחיר יחידה ממוצע', key: 'average', width: 20 },
        ],
        rows: [{
          received: null,
          gross: emptyList.map((entry) => fmtMoneyExact(entry.amount, entry.currency)).join(' · '),
          average: fmtMoneyExact(null, null),
        }],
      }],
    }), { type: 'array' });
    const sheet = book.Sheets['מוצרים'];
    for (const address of ['A5', 'B5', 'C5']) {
      expect(sheet[address]?.v).toBe(ABSENT);
    }
  });

  it('never writes a literal zero for a figure an empty month cannot have', async () => {
    const rows = grid(await read(emptyMonth()), 'פרטי הדוח');
    const valueOf = (label: string) => rows.find((row) => row[0] === label)?.[1];
    for (const label of ['סה״כ לפני מע״מ', 'סה״כ מע״מ', 'סה״כ כולל מע״מ', 'זיכויים שקוזזו', 'הוצאה נטו']) {
      expect(valueOf(label)).toBe(ABSENT);
    }
    // The counts are measurements over an empty universe and stay numbers.
    expect(valueOf('מספר חשבוניות')).toBe(0);
  });
});

describe('EXP-05 — a sheet with no rows says so, the way the screen does', () => {
  it('writes the screen\'s own sentence into each empty month sheet', async () => {
    const book = await read(emptyMonth());
    const notes: Record<string, string> = {
      'חשבוניות': 'אין חשבוניות בחודש זה',
      'תשלומים': 'אין תשלומים בחודש זה',
      'זיכויים': 'אין זיכויים בחודש זה',
    };
    for (const [name, note] of Object.entries(notes)) {
      expect(grid(book, name).flat().map(String)).toContain(note);
    }
  });
});

describe('EXP-06 — an out-of-window block states that it is out of window', () => {
  it('replaces the month banner on the exceptions sheet with what that sheet actually holds', async () => {
    const banner = String((await read(emptyMonth())).Sheets[EXCEPTIONS_SHEET].A2?.v ?? '');
    expect(banner).not.toContain('01.01.2020');
    expect(banner).toContain(OUT_OF_WINDOW);
  });
});

describe('the generated workbooks recalculate clean', () => {
  it('carries no formula and no formula error in any cell', async () => {
    for (const spec of [mixedMonth(), emptyMonth()]) {
      const book = await read(spec);
      for (const name of book.SheetNames) {
        for (const [address, cell] of Object.entries(book.Sheets[name])) {
          if (address.startsWith('!')) continue;
          const value = cell as XLSX.CellObject;
          expect(value.f).toBeUndefined();
          expect(value.t).not.toBe('e');
          expect(String(value.v ?? '')).not.toMatch(/#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NULL!|NUM!)/);
        }
      }
    }
  });
});
