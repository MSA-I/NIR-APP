import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildMonthlyWorkbook, type MonthlyReportLabels } from './monthlyReport';

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
