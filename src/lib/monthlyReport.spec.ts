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
import { buildWorkbook, type WorkbookSpec } from './workbook';
import { he } from '../lib/i18n/dictionaries/he';
import type { Dictionary } from '../lib/i18n/dictionaries/he';
import { translate } from '../lib/i18n/t';
import type { TKey } from '../lib/i18n/t';

/**
 * The workbook builders take the translator now, and the tests inject the HEBREW one.
 *
 * Every expectation below still names a literal sheet name and column header, so a wrong
 * dictionary entry fails here. Rewriting them to compare `t(key)` against `t(key)` would have
 * passed whatever the words were — and the words ARE the file an accountant opens.
 */
const t = ((key, vars) => translate(he as unknown as Dictionary, key, vars)) as
  (key: TKey, vars?: Record<string, string | number>) => string;

const labels: MonthlyReportLabels = {
  invoiceReview: { approved: 'מאושרת' },
  invoicePayment: { unpaid: 'לא שולמה' },
  creditReason: { shortage: 'חוסר' },
  creditStatus: { open: 'פתוח' },
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
      currency: 'ILS',
      review_status: 'approved', payment_status: 'unpaid',
      balance: { credited_amount: 0 },
    }],
    payments: [], credits: [], exceptions: [],
  },
  labels,
};

const summary = monthlyReportTemplateValues({
  orgName: input.orgName, periodLabel: 'אוגוסט 2026', periodFrom: '01.08.2026',
  periodTo: '31.08.2026', generatedAt: '01.09.2026',
  invoices: input.data.invoices,
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
async function worksheetXml(spec: WorkbookSpec): Promise<string[]> {
  const reopened = XLSX.read(await buildWorkbook(spec), { type: 'array', bookFiles: true }) as XLSX.WorkBook & {
    files?: Record<string, { content: Uint8Array }>;
  };
  return Object.entries(reopened.files ?? {})
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, file]) => Buffer.from(file.content).toString('utf8'));
}

/**
 * Every assertion below reads the workbook BACK FROM THE BYTES the writer produced, rather than
 * from an in-memory builder object. That is deliberate and it is what caught defect 12(a): a
 * property we set on our own object proves only that we set it.
 */
const widthsWritten = async (spec: WorkbookSpec) =>
  (await worksheetXml(spec)).every((xml) => /<col[^>]*width="/.test(xml));

const read = async (spec: WorkbookSpec) =>
  XLSX.read(await buildWorkbook(spec), { type: 'array', cellNF: true });

/**
 * The naive instant an Excel serial names. Day 1 is 1900-01-01 and the 1900 leap-year bug makes
 * 1899-12-30 the practical epoch. Dates are read as serials rather than through `cellDates`
 * because that option hands back a Date already shifted into the reader's own zone.
 */
const naiveDate = (serial: number) =>
  new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000)).toISOString();

/**
 * The records of a table sheet. `range: 3` because `workbook.ts` puts the title on row 1, the
 * subtitle on row 2, a blank on row 3 and the column headers on row 4.
 */
const records = (book: XLSX.WorkBook, name: string) =>
  XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[name], { range: 3 });

/** Every cell of a sheet as rows of raw values, for the key/value summary blocks. */
const grid = (book: XLSX.WorkBook, name: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1 });

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
  const bookOf = async () => read(buildMonthlyWorkbook({
    t,
      orgName: '=cmd|calc',
      month: '2026-08',
      generatedAt: new Date('2026-08-10T00:00:00.000Z'),
      data: {
        invoices: [{
          supplier: { name: '=HYPERLINK("http://evil","דוח")' },
          invoice_number: '@SUM(A1:A9)',
          invoice_date: '2026-08-01',
          amount_before_vat: 100, vat_amount: 18, total_amount: 118,
          currency: 'ILS',
          review_status: 'approved', payment_status: 'unpaid',
        }],
        payments: [{
          supplier: { name: 'ספק תקין' }, paid_date: '2026-08-02',
          amount: 118, currency: 'ILS', method: '+972', reference: '-1234',
        }],
        credits: [{ supplier: { name: 'ספק תקין' }, reason: 'shortage', amount: 10, currency: 'ILS', status: 'open' }],
        exceptions: [{ type: 'price_mismatch', title: '=1+1', supplier: null }],
      },
      labels,
    }));

  it('escapes every leading formula character across all sheets', async () => {
    const book = await bookOf();
    const [invoice] = records(book, 'חשבוניות');
    expect(invoice['ספק']).toBe(`'=HYPERLINK("http://evil","דוח")`);
    expect(invoice['מספר חשבונית']).toBe("'@SUM(A1:A9)");

    const [payment] = records(book, 'תשלומים');
    expect(payment['אמצעי']).toBe("'+972");
    expect(payment['אסמכתא']).toBe("'-1234");

    const [exception] = records(book, 'חריגים פתוחים כרגע');
    expect(exception['תיאור']).toBe("'=1+1");
  });

  it('leaves ordinary text and every number untouched', async () => {
    const book = await bookOf();
    const [payment] = records(book, 'תשלומים');
    expect(payment['ספק']).toBe('ספק תקין');
    // Amounts must stay numeric — an apostrophe here would turn money into text in the accountant's
    // sheet and break every SUM they build on it.
    expect(payment['סכום']).toBe(118);

    const [invoice] = records(book, 'חשבוניות');
    expect(invoice['סה"כ']).toBe(118);
    // A real DATE cell since 28.08.2026, not the ISO string the database hands over: the accountant
    // sorts and filters this column, and text does neither. Asserted on the SERIAL the cell holds —
    // C5 is `תאריך` on the first data row — because an .xlsx date is naive and every reader
    // re-applies a zone of its own. The calendar day must survive, or the first invoice of August
    // is filed under July.
    expect(naiveDate(book.Sheets['חשבוניות'].C5.v as number)).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('accountant workbook — currency is part of every amount', () => {
  const mixedInput = {
    orgName: 'מסעדת מטבעות',
    baseCurrency: 'USD',
    month: '2026-08',
    generatedAt: new Date('2026-09-01T00:00:00.000Z'),
    data: {
      invoices: [
        { supplier: { name: 'שקלי' }, invoice_number: 'I-1', invoice_date: '2026-08-01',
          amount_before_vat: 12400, vat_amount: 0, total_amount: 12400, currency: 'ILS',
          review_status: 'approved', payment_status: 'unpaid' },
        { supplier: { name: 'דולרי' }, invoice_number: 'U-1', invoice_date: '2026-08-02',
          amount_before_vat: 3100, vat_amount: 0, total_amount: 3100, currency: 'USD',
          review_status: 'approved', payment_status: 'unpaid' },
      ],
      payments: [
        { supplier: { name: 'שקלי' }, paid_date: '2026-08-03', amount: 500,
          currency: 'ILS', method: 'bank', reference: 'I' },
        { supplier: { name: 'דולרי' }, paid_date: '2026-08-04', amount: 80,
          currency: 'USD', method: 'bank', reference: 'U' },
      ],
      credits: [
        { supplier: { name: 'שקלי' }, reason: 'shortage', amount: 10, currency: 'ILS', status: 'open' },
        { supplier: { name: 'דולרי' }, reason: 'shortage', amount: 5, currency: 'USD', status: 'open' },
      ],
      exceptions: [],
    },
    labels,
  };

  it('keeps the five existing sheet names in a single-currency month and adds currency columns', async () => {
    const book = await read(buildMonthlyWorkbook({ ...input, baseCurrency: 'ILS', t } as never));
    expect(book.SheetNames).toEqual(['פרטי הדוח', 'חשבוניות', 'תשלומים', 'זיכויים', 'חריגים פתוחים כרגע']);
    const [invoice] = records(book, 'חשבוניות');
    expect(invoice['מטבע']).toBe('ILS');
    for (const sheetName of ['חשבוניות', 'תשלומים', 'זיכויים']) {
      const headerRows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], { header: 1, range: 3 });
      expect(headerRows[0]).toContain('מטבע');
    }
    expect(grid(book, 'פרטי הדוח').some((row) => row.includes('ILS'))).toBe(true);
  });

  it('splits every mixed money surface by currency, base currency first, with no combined total', async () => {
    const first = buildMonthlyWorkbook({ ...mixedInput, t } as never);
    const second = buildMonthlyWorkbook({ ...mixedInput, t } as never);
    const names = (spec: WorkbookSpec) => spec.sheets.map((sheet) => sheet.name);
    expect(names(first)).toEqual(names(second));
    expect(names(first)).toEqual([
      'פרטי הדוח',
      'חשבוניות USD', 'חשבוניות ILS',
      'תשלומים USD', 'תשלומים ILS',
      'זיכויים USD', 'זיכויים ILS',
      'חריגים פתוחים כרגע',
    ]);
    expect(names(first).every((name) => name.length <= 31)).toBe(true);

    const book = await read(first);
    for (const name of names(first).filter((sheet) => /^(חשבוניות|תשלומים|זיכויים) /.test(sheet))) {
      const currency = name.slice(name.lastIndexOf(' ') + 1);
      const rows = records(book, name);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row['מטבע'] === currency)).toBe(true);
    }
    const flat = grid(book, 'פרטי הדוח').flat();
    expect(flat).toContain('ILS');
    expect(flat).toContain('USD');
    // 12,400 shekels and 3,100 dollars are not 15,500, and no cell anywhere may say they are.
    expect(flat).not.toContain(15500);
    for (const sheet of Object.values(book.Sheets)) {
      for (const cell of Object.values(sheet)) {
        if (cell && typeof cell === 'object' && 'f' in cell) expect(cell.f).toBeUndefined();
      }
    }
  });

  it('reads a pre-currency snapshot as ILS without changing its content hash', async () => {
    const before = snapshot.content_hash;
    const book = await read(buildLockedMonthlyWorkbook({ t, snapshot }));
    const [invoice] = records(book, 'חשבוניות');
    expect(invoice['מטבע']).toBe('ILS');
    expect(snapshot.content_hash).toBe(before);
  });

  it('splits locked bank evidence by its own currency without changing the snapshot object', async () => {
    const mixedSnapshot = {
      ...snapshot,
      report_version: 'monthly-accountant-legal-entity-v3',
      base_currency: 'USD',
      invoice_rows: [
        { ...snapshot.invoice_rows[0], currency: 'ILS' },
        { ...snapshot.invoice_rows[0], invoice_number: 'USD-1', currency: 'USD', total_amount: 50 },
      ],
      bank_rows: [
        { ...snapshot.bank_rows[0], currency: 'ILS' },
        { ...snapshot.bank_rows[0], id: 'bank-usd', reference: 'USD', currency: 'USD', amount: 50 },
      ],
    } satisfies MonthlyReportSnapshot;
    const before = JSON.stringify(mixedSnapshot);
    const spec = buildLockedMonthlyWorkbook({ t, snapshot: mixedSnapshot });
    const names = spec.sheets.map((sheet) => sheet.name);
    expect(names).toContain('תנועות בנק USD');
    expect(names).toContain('תנועות בנק ILS');
    const book = await read(spec);
    for (const name of ['תנועות בנק USD', 'תנועות בנק ILS']) {
      const currency = name.slice(-3);
      const rows = records(book, name);
      expect(rows.every((row) => row['מטבע'] === currency)).toBe(true);
    }
    expect(JSON.stringify(mixedSnapshot)).toBe(before);
  });

  /**
   * A currency's own minor units decide how many decimal places the cell is WRITTEN with (#294).
   * Never a conversion: ¥1,200 is the same 1,200 either way, but `#,##0.00` would print it with
   * two decimal places a yen does not have, and would round a Kuwaiti fils out of the file.
   */
  it('writes each currency with its own number of decimal places', async () => {
    const book = await read(buildMonthlyWorkbook({
    t,
      ...mixedInput,
      baseCurrency: 'JPY',
      data: {
        ...mixedInput.data,
        invoices: [{
          supplier: { name: 'ין' }, invoice_number: 'J-1', invoice_date: '2026-08-01',
          amount_before_vat: 1200, vat_amount: 0, total_amount: 1200, currency: 'JPY',
          review_status: 'approved', payment_status: 'unpaid',
        }],
        payments: [], credits: [],
      },
    } as never));
    // One currency in the month, so the sheet keeps its plain name — the split only appears when
    // there is something to split.
    const jpy = book.Sheets['חשבוניות'];
    const headerRow = XLSX.utils.sheet_to_json<unknown[]>(jpy, { header: 1, range: 3 })[0] as string[];
    const totalColumn = headerRow.indexOf('סה"כ');
    const cell = jpy[XLSX.utils.encode_cell({ r: 4, c: totalColumn })];
    expect(cell.v).toBe(1200);
    expect(cell.z).toBe('#,##0');
  });
});

/**
 * The styled built-in default (18.08.2026, rewritten onto the ExcelJS writer 28.08.2026): a merged
 * title block, brand-coloured column headers, widths, money and date formats. The locked snapshot
 * shares all of it — presentation touches no cell value, and `content_hash` is computed
 * server-side over the snapshot ROWS — but it must NOT share the live registry vocabulary.
 */
describe('accountant workbook — styled built-in default', () => {
  it('opens right-to-left and carries the registry vocabulary on the summary sheet', async () => {
    const book = await read(buildStyledMonthlyWorkbook({ ...input, summary, t }));
    expect(book.Sheets['פרטי הדוח']['!merges']).toHaveLength(2);
    expect(await widthsWritten(buildStyledMonthlyWorkbook({ ...input, summary, t }))).toBe(true);
    const flat = grid(book, 'פרטי הדוח').flat().map(String);
    // The same labels a custom template maps — one vocabulary for both paths.
    for (const label of ['מספר חשבוניות', 'סה״כ לפני מע״מ', 'סה״כ מע״מ', 'סה״כ כולל מע״מ', 'זיכויים שקוזזו', 'הוצאה נטו', 'מספר ספקים']) {
      expect(flat).toContain(label);
    }
  });

  it('summary values equal the template values, and money cells carry the money format', async () => {
    const book = await read(buildStyledMonthlyWorkbook({ ...input, summary, t }));
    const rows = grid(book, 'פרטי הדוח');
    const rowOf = (label: string) => rows.find((row) => row[0] === label)!;
    expect(rowOf('מספר חשבוניות')[1]).toBe(summary.invoice_count);
    expect(rowOf('סה״כ לפני מע״מ')[1]).toBe(summary.net_total);
    expect(rowOf('הוצאה נטו')[1]).toBe(summary.net_expense);
    const netRowIndex = rows.findIndex((row) => row[0] === 'סה״כ לפני מע״מ');
    const netCell = book.Sheets['פרטי הדוח'][XLSX.utils.encode_cell({ r: netRowIndex, c: 1 })];
    expect(netCell.z).toBe('#,##0.00');
  });

  it('styles the invoice sheet money columns and keeps neutralization intact', async () => {
    const book = await read(buildStyledMonthlyWorkbook({ ...input, summary, t }));
    const [invoiceRow] = records(book, 'חשבוניות');
    expect(invoiceRow['סה"כ']).toBe(118);
    // The neutralization path is shared with the plain builder — a hostile name stays escaped.
    const hostile = await read(buildStyledMonthlyWorkbook({
      t,
      ...input,
      data: { ...input.data, invoices: [{ ...input.data.invoices[0], supplier: { name: '=HYPERLINK("http://evil","x")' } }] },
      summary,
    }));
    const [hostileRow] = records(hostile, 'חשבוניות');
    expect(hostileRow['ספק']).toBe(`'=HYPERLINK("http://evil","x")`);
  });

  /**
   * The base builder carries the heading block itself, so the styled default replaces a summary
   * sheet rather than adding the only structure in the file. What must NOT leak downward is the
   * registry vocabulary: the locked snapshot's figures come from frozen rows, and a label the
   * registry renamed since must not appear in a version already archived.
   */
  it('keeps the registry summary out of the plain and locked builders', async () => {
    for (const spec of [buildMonthlyWorkbook({ ...input, t }), buildLockedMonthlyWorkbook({ t, snapshot })]) {
      const book = await read(spec);
      const flat = grid(book, 'פרטי הדוח').flat().map(String);
      for (const label of ['הוצאה נטו', 'זיכויים שקוזזו', 'מספר ספקים']) {
        expect(flat).not.toContain(label);
      }
      // The heading block is a merged title and a merged subtitle — the same shape everywhere.
      expect(book.Sheets['פרטי הדוח']['!merges']).toHaveLength(2);
    }
  });

  it('builds the locked workbook only from snapshot values, styling included', async () => {
    const locked = await read(buildLockedMonthlyWorkbook({ t, snapshot }));
    const rows = grid(locked, 'פרטי הדוח');
    const rowOf = (label: string) => rows.find((row) => row[0] === label)!;
    expect(rowOf('Checksum')[1]).toBe(snapshot.content_hash);
    expect(rowOf('גרסת snapshot')[1]).toBe(snapshot.version);
    expect(rowOf('חשבוניות')[2]).toBe(snapshot.totals.invoice_total);
    // Styling reaches the snapshot sheets too — widths and money formats carry no value.
    expect(await widthsWritten(buildLockedMonthlyWorkbook({ t, snapshot }))).toBe(true);
    const [bankRow] = records(locked, 'תנועות בנק');
    expect(bankRow['סכום']).toBe(118);
  });
});

/**
 * Defect 12(a). A flag on the in-memory builder object is our own property; what the accountant's
 * Excel obeys is `rightToLeft="1"` inside each worksheet part. The locked snapshot download once
 * shipped without it, so this asserts on the produced BYTES, for every builder.
 */
describe('accountant workbook — right-to-left in the produced file', () => {
  const builders: [string, () => WorkbookSpec][] = [
    ['buildMonthlyWorkbook', () => buildMonthlyWorkbook({ ...input, t })],
    ['buildStyledMonthlyWorkbook', () => buildStyledMonthlyWorkbook({ t, ...input, summary })],
    ['buildLockedMonthlyWorkbook', () => buildLockedMonthlyWorkbook({ t, snapshot })],
  ];

  it.each(builders)('%s marks every worksheet right-to-left', async (_name, build) => {
    const sheets = await worksheetXml(build());
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
  const invoice = (total: number, paid = 'unpaid', currency = 'ILS') =>
    ({ total_amount: total, amount_before_vat: total / 1.18, vat_amount: total - total / 1.18, currency, payment_status: paid });

  it('חודש ריק — אין סכומים כלל (המסך יציג —), הספירות הן 0', () => {
    const totals = monthlyReportScreenTotals({ invoices: [], payments: [], bank: [] });
    // An EMPTY LIST, not a null and not a zero: there is no currency with a total in it, which is
    // the same claim the old `null` made and the screen still renders as an em dash.
    expect(totals.invoices).toEqual([]);
    expect(totals.beforeVat).toEqual([]);
    expect(totals.vat).toEqual([]);
    expect(totals.paid).toEqual([]);
    expect(totals.hasInvoices).toBe(false);
    // A count over an empty universe was still taken. It stays a number.
    expect(totals.unpaidCount).toBe(0);
    expect(totals.unmatchedBank).toBe(0);
    expect(totals.suggestedBank).toBe(0);
  });

  it('חודש שיש בו חשבוניות שסכומן 0 — אפס אמיתי, לא היעדר', () => {
    // The half a blanket null-conversion would have destroyed: rows exist, they sum to zero.
    const totals = monthlyReportScreenTotals({ invoices: [invoice(0)], payments: [], bank: [] });
    expect(totals.invoices).toEqual([{ currency: 'ILS', amount: 0 }]);
    expect(totals.hasInvoices).toBe(true);
    expect(fmtMoneyExact(totals.invoices[0].amount, 'ILS')).toContain('0.00');
  });

  it('תשלומים וחשבוניות נמדדים בנפרד — חודש עם חשבוניות ובלי תשלומים', () => {
    const totals = monthlyReportScreenTotals({ invoices: [invoice(118)], payments: [], bank: [] });
    expect(totals.invoices).toEqual([{ currency: 'ILS', amount: 118 }]);
    expect(totals.paid).toEqual([]);
    expect(totals.unpaidCount).toBe(1);
  });

  /* OPEN-DECISIONS #277, and the sentence the whole campaign is measured against: a screen that
     adds ₪12,400 and $3,100 into one number shows a false figure on a screen decisions are made
     from. The accountant's month is where that number would have appeared. */
  it('חודש עם חשבוניות בשני מטבעות — שני סכומים, לא סכום אחד', () => {
    const totals = monthlyReportScreenTotals({
      invoices: [invoice(12400), invoice(3100, 'unpaid', 'USD')],
      payments: [{ amount: 500, currency: 'ILS' }, { amount: 80, currency: 'USD' }],
      bank: [],
    });

    expect(totals.invoices).toEqual([
      { currency: 'ILS', amount: 12400 },
      { currency: 'USD', amount: 3100 },
    ]);
    expect(totals.paid).toEqual([
      { currency: 'ILS', amount: 500 },
      { currency: 'USD', amount: 80 },
    ]);
    // The counts are counts: an invoice is one invoice in any currency.
    expect(totals.unpaidCount).toBe(2);
    // And nothing anywhere in the answer equals 15,500.
    expect(totals.invoices.some((entry) => entry.amount === 15500)).toBe(false);
  });
});
