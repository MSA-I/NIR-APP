import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildLockedMonthlyWorkbook,
  buildMonthlyWorkbook,
  buildStyledMonthlyWorkbook,
  monthlyReportScreenTotals,
  type MonthlyReportLabels,
  type MonthlyReportSnapshot,
} from './monthlyReport';
import { currentMonthISO, fmtMoneyExact, monthRange, safeMonthISO } from './format';
import { monthlyReportTemplateValues } from './reportTemplateExport';

const labels: MonthlyReportLabels = {
  invoiceReview: { approved: { label: 'מאושרת' } },
  invoicePayment: { unpaid: { label: 'לא שולמה' } },
  creditReason: { shortage: 'חוסר' },
  creditStatus: { open: { label: 'פתוח' } },
  exceptionType: { price_mismatch: 'פער מחיר' },
};

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

const snapshot: MonthlyReportSnapshot = {
  id: 'a2f0f6c4-0000-4000-8000-000000000001',
  org_id: 'a2f0f6c4-0000-4000-8000-0000000000ff',
  unit_id: 'a2f0f6c4-0000-4000-8000-0000000000fe',
  report_month: '2026-08-01',
  version: 3,
  report_version: 'v2',
  organization_name: 'מסעדת לדוגמה',
  legal_entity_name: 'לדוגמה בע״מ',
  created_by: 'a2f0f6c4-0000-4000-8000-0000000000fd',
  created_by_name: 'בעל העסק',
  created_at: '2026-09-01T08:00:00.000Z',
  invoice_rows: [{
    supplier: { name: 'ספק אחד' }, invoice_number: 'INV-1', invoice_date: '2026-08-01',
    amount_before_vat: 100, vat_amount: 18, total_amount: 118,
    review_status: 'approved', payment_status: 'unpaid',
    review_status_label: 'מאושרת', payment_status_label: 'לא שולמה',
  }],
  payment_rows: [],
  credit_rows: [],
  exception_rows: [],
  bank_rows: [{
    id: 'a2f0f6c4-0000-4000-8000-0000000000fc',
    tx_date: '2026-08-03', description: 'העברה לספק', amount: 118, is_debit: true,
    reference: 'REF-1', status: 'matched', direction_label: 'חיוב', status_label: 'הותאמה',
  }],
  totals: {
    invoice_count: 1, invoice_total: 118, before_vat_total: 100, vat_total: 18,
    payment_count: 0, payment_total: 0, credit_count: 0, credit_total: 0,
    exception_count: 0, bank_transaction_count: 1, bank_total: 118, unpaid_invoice_count: 1,
  },
  content_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
};

/**
 * Read the worksheet XML the writer actually produced. `Workbook.Views[0].RTL` on the in-memory
 * object proves only that we set a property; `rightToLeft="1"` in `xl/worksheets/sheetN.xml` is
 * what an accountant's Excel reads. `files` is not on the public WorkBook type, hence the cast.
 */
function worksheetXml(workbook: XLSX.WorkBook): string[] {
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  const reopened = XLSX.read(bytes, { type: 'array', bookFiles: true }) as XLSX.WorkBook & {
    files?: Record<string, { content: Uint8Array }>;
  };
  return Object.entries(reopened.files ?? {})
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, file]) => Buffer.from(file.content).toString('utf8'));
}

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

  /**
   * The base builder now carries the heading block itself, so the styled default adds a summary
   * sheet rather than the only structure in the file. What must NOT leak downward is the
   * registry vocabulary: the locked snapshot's figures come from frozen rows, and a label the
   * registry renamed since must not appear in a version already archived.
   */
  it('keeps the registry summary out of the plain and locked builders', () => {
    const flatten = (sheet: XLSX.WorkSheet) =>
      XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }).flat().map(String);

    for (const sheet of [
      buildMonthlyWorkbook(input).Sheets['פרטי הדוח'],
      buildLockedMonthlyWorkbook({ snapshot }).Sheets['פרטי הדוח'],
    ]) {
      const flat = flatten(sheet);
      for (const label of ['הוצאה נטו', 'זיכויים שקוזזו', 'מספר ספקים']) {
        expect(flat).not.toContain(label);
      }
      // The heading block is two merged rows and nothing more — the same shape everywhere.
      expect(sheet['!merges']).toHaveLength(2);
    }
  });

  it('builds the locked workbook only from snapshot values, styling included', () => {
    const locked = buildLockedMonthlyWorkbook({ snapshot });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(locked.Sheets['פרטי הדוח'], { header: 1 });
    const rowOf = (label: string) => rows.find((row) => row[0] === label)!;
    expect(rowOf('Checksum')[1]).toBe(snapshot.content_hash);
    expect(rowOf('גרסת snapshot')[1]).toBe(snapshot.version);
    expect(rowOf('חשבוניות')[2]).toBe(snapshot.totals.invoice_total);
    // Styling reaches the snapshot sheets too — widths and money formats carry no value.
    expect(locked.Sheets['תנועות בנק']['!cols']?.length).toBeGreaterThan(0);
    const [bankRow] = XLSX.utils.sheet_to_json<Record<string, unknown>>(locked.Sheets['תנועות בנק']);
    expect(bankRow['סכום']).toBe(118);
  });
});

/**
 * Defect 12(a). `Workbook.Views[0].RTL` on the in-memory object is our own property; what the
 * accountant's Excel obeys is `rightToLeft="1"` inside each worksheet part. The locked snapshot
 * download shipped without it, so this asserts on the produced BYTES, for every builder.
 */
describe('accountant workbook — right-to-left in the produced file', () => {
  const builders: [string, () => XLSX.WorkBook][] = [
    ['buildMonthlyWorkbook', () => buildMonthlyWorkbook(input)],
    ['buildStyledMonthlyWorkbook', () => buildStyledMonthlyWorkbook({ ...input, summary })],
    ['buildLockedMonthlyWorkbook', () => buildLockedMonthlyWorkbook({ snapshot })],
  ];

  it.each(builders)('%s marks every worksheet right-to-left', (_name, build) => {
    const sheets = worksheetXml(build());
    expect(sheets.length).toBeGreaterThan(0);
    for (const xml of sheets) expect(xml).toContain('rightToLeft="1"');
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

describe('monthlyReportScreenTotals — אפס שנמדד מול אפס שלא נמדד', () => {
  const invoice = (total: number, paid = 'unpaid') =>
    ({ total_amount: total, amount_before_vat: total / 1.18, vat_amount: total - total / 1.18, payment_status: paid });

  it('חודש ריק — הסכומים הם null (המסך יציג —), הספירות הן 0', () => {
    const totals = monthlyReportScreenTotals({ invoices: [], payments: [], bank: [] });
    expect(totals.invoices).toBeNull();
    expect(totals.beforeVat).toBeNull();
    expect(totals.vat).toBeNull();
    expect(totals.paid).toBeNull();
    expect(totals.hasInvoices).toBe(false);
    // A count over an empty universe was still taken. It stays a number.
    expect(totals.unpaidCount).toBe(0);
    expect(totals.unmatchedBank).toBe(0);
    expect(totals.suggestedBank).toBe(0);
    expect(fmtMoneyExact(totals.vat)).toBe('—');
  });

  it('חודש שיש בו חשבוניות שסכומן 0 — אפס אמיתי, לא null', () => {
    // The half a blanket null-conversion would have destroyed: rows exist, they sum to zero.
    const totals = monthlyReportScreenTotals({ invoices: [invoice(0)], payments: [], bank: [] });
    expect(totals.invoices).toBe(0);
    expect(totals.hasInvoices).toBe(true);
    expect(fmtMoneyExact(totals.invoices)).not.toBe('—');
    expect(fmtMoneyExact(totals.invoices)).toContain('0.00');
  });

  it('תשלומים וחשבוניות נמדדים בנפרד — חודש עם חשבוניות ובלי תשלומים', () => {
    const totals = monthlyReportScreenTotals({ invoices: [invoice(118)], payments: [], bank: [] });
    expect(totals.invoices).toBe(118);
    expect(totals.paid).toBeNull();
    expect(totals.unpaidCount).toBe(1);
  });
});
