import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildMonthlyWorkbook, buildStyledMonthlyWorkbook, type MonthlyReportLabels } from './monthlyReport';
import { currentMonthISO, monthRange, safeMonthISO } from './format';
import { monthlyReportTemplateValues } from './reportTemplateExport';

const labels: MonthlyReportLabels = {
  invoiceReview: { approved: { label: 'מאושרת' } },
  invoicePayment: { unpaid: { label: 'לא שולמה' } },
  creditReason: { shortage: 'חוסר' },
  creditStatus: { open: { label: 'פתוח' } },
  exceptionType: { price_mismatch: 'פער מחיר' },
};

/**
 * The accountant's workbook is the one artefact in this product that LEAVES the building, and
 * every text cell in it is tenant data: supplier names, exception titles, payment references and
 * methods, bank descriptions. Excel and Sheets treat a cell opening with `= + - @ TAB CR` as a
 * formula whatever the writer meant, so a supplier named `=HYPERLINK("http://x","click")` becomes
 * live content in the recipient's spreadsheet.
 *
 * documentExport.ts has neutralized this since it was written; this workbook never did. The rule
 * now lives in one place and both callers use it.
 */
describe('accountant workbook — formula injection', () => {
  const sheetOf = (name: string) => {
    const workbook = buildMonthlyWorkbook({
      orgName: '=cmd|calc',
      month: '2026-08',
      generatedAt: new Date('2026-08-10T00:00:00.000Z'),
      data: {
        invoices: [{
          supplier: { name: '=HYPERLINK("http://evil","דוח")' },
          invoice_number: '@SUM(A1:A9)',
          invoice_date: '2026-08-01',
          amount_before_vat: 100, vat_amount: 18, total_amount: 118,
          review_status: 'approved', payment_status: 'unpaid',
        }],
        payments: [{
          supplier: { name: 'ספק תקין' }, paid_date: '2026-08-02',
          amount: 118, method: '+972', reference: '-1234',
        }],
        credits: [{ supplier: { name: 'ספק תקין' }, reason: 'shortage', amount: 10, status: 'open' }],
        exceptions: [{ type: 'price_mismatch', title: '=1+1', supplier: null }],
      },
      labels,
    });
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name]);
  };

  it('escapes every leading formula character across all sheets', () => {
    const [invoice] = sheetOf('חשבוניות');
    expect(invoice['ספק']).toBe(`'=HYPERLINK("http://evil","דוח")`);
    expect(invoice['מספר חשבונית']).toBe("'@SUM(A1:A9)");

    const [payment] = sheetOf('תשלומים');
    expect(payment['אמצעי']).toBe("'+972");
    expect(payment['אסמכתא']).toBe("'-1234");

    const [exception] = sheetOf('חריגים פתוחים כרגע');
    expect(exception['תיאור']).toBe("'=1+1");
  });

  it('leaves ordinary text and every number untouched', () => {
    const [payment] = sheetOf('תשלומים');
    expect(payment['ספק']).toBe('ספק תקין');
    // Amounts must stay numeric — an apostrophe here would turn money into text in the accountant's
    // sheet and break every SUM they build on it.
    expect(payment['סכום']).toBe(118);

    const [invoice] = sheetOf('חשבוניות');
    expect(invoice['סה"כ']).toBe(118);
    expect(invoice['תאריך']).toBe('2026-08-01');
  });
});

/**
 * The styled built-in default (18.08.2026): what CE writes reliably — RTL views, merges, column
 * widths, money number formats — and nothing that rests on the unproven style round trip
 * (DEBT-REGISTER §37). The locked snapshot must stay plain: version N re-downloaded is the
 * workbook the accountant already archived.
 */
describe('accountant workbook — styled built-in default', () => {
  const input = {
    orgName: 'מסעדת לדוגמה',
    month: '2026-08',
    generatedAt: new Date('2026-09-01T00:00:00.000Z'),
    data: {
      invoices: [{
        supplier: { name: 'ספק אחד' }, invoice_number: 'INV-1', invoice_date: '2026-08-01',
        amount_before_vat: 100, vat_amount: 18, total_amount: 118,
        review_status: 'approved', payment_status: 'unpaid',
      }],
      payments: [], credits: [], exceptions: [],
    },
    labels,
  };
  const summary = monthlyReportTemplateValues({
    orgName: input.orgName, periodLabel: 'אוגוסט 2026', periodFrom: '01.08.2026',
    periodTo: '31.08.2026', generatedAt: '01.09.2026',
    invoices: input.data.invoices, credits: input.data.credits,
  });
  const workbook = buildStyledMonthlyWorkbook({ ...input, summary });

  it('opens right-to-left and carries the registry vocabulary on the summary sheet', () => {
    expect(workbook.Workbook?.Views?.[0]?.RTL).toBe(true);
    const sheet = workbook.Sheets['פרטי הדוח'];
    expect(sheet['!merges']).toHaveLength(2);
    expect(sheet['!cols']?.length).toBeGreaterThan(0);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    const flat = rows.flat().map(String);
    // The same labels a custom template maps — one vocabulary for both paths.
    for (const label of ['מספר חשבוניות', 'סה״כ לפני מע״מ', 'סה״כ מע״מ', 'סה״כ כולל מע״מ', 'זיכויים שקוזזו', 'הוצאה נטו', 'מספר ספקים']) {
      expect(flat).toContain(label);
    }
  });

  it('summary values equal the template values, and money cells carry the money format', () => {
    const sheet = workbook.Sheets['פרטי הדוח'];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    const rowOf = (label: string) => rows.find((row) => row[0] === label)!;
    expect(rowOf('מספר חשבוניות')[1]).toBe(summary.invoice_count);
    expect(rowOf('סה״כ לפני מע״מ')[1]).toBe(summary.net_total);
    expect(rowOf('הוצאה נטו')[1]).toBe(summary.net_expense);
    const netRowIndex = rows.findIndex((row) => row[0] === 'סה״כ לפני מע״מ');
    const netCell = sheet[XLSX.utils.encode_cell({ r: netRowIndex, c: 1 })];
    expect(netCell.z).toBe('#,##0.00');
  });

  it('styles the invoice sheet money columns and keeps neutralization intact', () => {
    const invoiceSheet = workbook.Sheets['חשבוניות'];
    expect(invoiceSheet['!cols']?.length).toBeGreaterThan(0);
    const [invoiceRow] = XLSX.utils.sheet_to_json<Record<string, unknown>>(invoiceSheet);
    expect(invoiceRow['סה"כ']).toBe(118);
    // The neutralization path is shared with the plain builder — a hostile name stays escaped.
    const hostile = buildStyledMonthlyWorkbook({
      ...input,
      data: { ...input.data, invoices: [{ ...input.data.invoices[0], supplier: { name: '=HYPERLINK("http://evil","x")' } }] },
      summary,
    });
    const [hostileRow] = XLSX.utils.sheet_to_json<Record<string, unknown>>(hostile.Sheets['חשבוניות']);
    expect(hostileRow['ספק']).toBe(`'=HYPERLINK("http://evil","x")`);
  });

  it('keeps the locked snapshot builder plain — no RTL views, no merges', () => {
    const plain = buildMonthlyWorkbook(input);
    expect(plain.Workbook?.Views?.[0]?.RTL).toBeUndefined();
    expect(plain.Sheets['פרטי הדוח']['!merges']).toBeUndefined();
  });
});

/**
 * The month the accountant is reading now lives in `?month=`, so the value reaching `monthRange`,
 * `fmtMonth` and the export filename is whatever is in the address bar. Junk must degrade to the
 * current month rather than throw: a mistyped link should show a month, not a blank screen.
 */
describe('safeMonthISO', () => {
  it('passes a real calendar month through unchanged', () => {
    expect(safeMonthISO('2026-06')).toBe('2026-06');
    expect(safeMonthISO('2026-01')).toBe('2026-01');
    expect(safeMonthISO('2026-12')).toBe('2026-12');
  });

  it('falls back to the current month for junk, empty and absent values', () => {
    const current = currentMonthISO();
    expect(safeMonthISO('07/2026')).toBe(current);
    expect(safeMonthISO('')).toBe(current);
    expect(safeMonthISO(null)).toBe(current);
    expect(safeMonthISO(undefined)).toBe(current);
    // Shaped like a month but not one. `monthRange('2026-13')` throws, and this value can only
    // arrive from a hand-edited URL — so it is rejected here rather than crashing the report.
    expect(safeMonthISO('2026-13')).toBe(current);
    expect(safeMonthISO('2026-00')).toBe(current);
  });

  it('returns a value every downstream month consumer accepts', () => {
    expect(() => monthRange(safeMonthISO('2026-13'))).not.toThrow();
    expect(() => monthRange(safeMonthISO('07/2026'))).not.toThrow();
  });
});
