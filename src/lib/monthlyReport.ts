import * as XLSX from 'xlsx';
import { neutralizeSpreadsheetRow, neutralizeSpreadsheetString } from './documentExport';
import { exportDefinition } from './exportTemplates';
import type { ReportTemplateValues } from './reportTemplateExport';
import { currencyMinorUnits } from './format';

const neutralize = neutralizeSpreadsheetString;

export interface MonthlyReportData {
  invoices: { supplier: { name: string }; invoice_number: string; invoice_date: string; amount_before_vat: number; vat_amount: number; total_amount: number; currency: string; review_status: string; payment_status: string }[];
  payments: { supplier: { name: string }; paid_date: string; amount: number; currency: string; method: string | null; reference: string | null }[];
  credits: { supplier: { name: string }; reason: string; amount: number; currency: string; status: string }[];
  exceptions: { type: string; title: string; supplier: { name: string } | null }[];
}

export interface MonthlyReportSnapshot {
  id: string;
  org_id: string;
  unit_id: string;
  report_month: string;
  version: number;
  report_version: string;
  base_currency?: string;
  organization_name: string;
  legal_entity_name: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  invoice_rows: (Omit<MonthlyReportData['invoices'][number], 'currency'> & {
    currency?: string;
    review_status_label?: string;
    payment_status_label?: string;
  })[];
  payment_rows: (Omit<MonthlyReportData['payments'][number], 'currency'> & { currency?: string })[];
  credit_rows: (Omit<MonthlyReportData['credits'][number], 'currency'> & {
    currency?: string;
    reason_label?: string;
    status_label?: string;
  })[];
  exception_rows: (MonthlyReportData['exceptions'][number] & { type_label?: string })[];
  bank_rows: {
    id: string;
    tx_date: string;
    description: string;
    amount: number;
    is_debit: boolean;
    reference: string | null;
    status: string;
    currency?: string;
    direction_label?: string;
    status_label?: string;
  }[];
  totals: {
    invoice_count: number;
    invoice_total: number;
    before_vat_total: number;
    vat_total: number;
    payment_count: number;
    payment_total: number;
    credit_count: number;
    credit_total: number;
    exception_count: number;
    bank_transaction_count: number;
    bank_total: number;
    unpaid_invoice_count: number;
    by_currency?: {
      currency: string;
      invoice_total: number;
      before_vat_total: number;
      vat_total: number;
      payment_total: number;
      credit_total: number;
      bank_total: number;
    }[];
  };
  content_hash: string;
}

export interface MonthlyReportLabels {
  invoiceReview: Record<string, { label: string } | undefined>;
  invoicePayment: Record<string, { label: string } | undefined>;
  creditReason: Record<string, string | undefined>;
  creditStatus: Record<string, { label: string } | undefined>;
  exceptionType: Record<string, string | undefined>;
}

/**
 * The nine figures the /reports screen puts on its KPI grid, with the one distinction the screen
 * has to make and a spreadsheet does not: a **sum over an empty set is an absence, not a zero**.
 * Three of the nine are sums (`invoices`, `vat`, `paid`) and go `null` when their source set is
 * empty, so `fmtMoneyExact` renders `—` — the dashboard already applies exactly this rule to the
 * same money facts (Dashboard.tsx money strip), and CLAUDE.md:31 forbids the fake `0`. A month
 * that HAS invoices which happen to sum to 0 keeps a real `0`: that is a measurement.
 *
 * The counts stay numbers unconditionally. A set of zero invoices genuinely contains zero unpaid
 * invoices — the universe is empty, but the count of it was taken.
 *
 * The workbook builders below deliberately keep plain `0`: a numeric cell is what an accountant's
 * own formulas consume, and `—` would turn it into text. The `—` rule governs screens.
 */
/**
 * THE MONTH'S FIGURES, ONE TOTAL PER CURRENCY (0217, OPEN-DECISIONS #277).
 *
 * This is the accountant's reconciliation screen, so it is the last place a single number may
 * quietly cover two kinds of money. A month holding ₪12,400 of shekel invoices and $3,100 of
 * dollar ones has two totals; the four money figures below are therefore lists, each entry a sum
 * taken inside one currency. The counts stay counts — an invoice is one invoice in any currency.
 *
 * An empty list means "no invoices", which is what `hasInvoices` already says and what the screen
 * renders as an em dash. It is not a zero.
 */
export function monthlyReportScreenTotals(data: {
  invoices: { total_amount: number; amount_before_vat: number; vat_amount: number; currency: string; payment_status: string }[];
  payments: { amount: number; currency: string }[];
  bank: { status: string }[];
}) {
  const hasInvoices = data.invoices.length > 0;
  const totalsWithin = <T>(rows: readonly T[], currency: (row: T) => string, amount: (row: T) => number) => {
    const sums = new Map<string, number>();
    for (const row of rows) sums.set(currency(row), (sums.get(currency(row)) ?? 0) + amount(row));
    return [...sums].map(([code, value]) => ({ currency: code, amount: value }));
  };
  return {
    invoices: totalsWithin(data.invoices, (i) => i.currency, (i) => i.total_amount),
    beforeVat: totalsWithin(data.invoices, (i) => i.currency, (i) => i.amount_before_vat),
    vat: totalsWithin(data.invoices, (i) => i.currency, (i) => i.vat_amount),
    paid: totalsWithin(data.payments, (p) => p.currency, (p) => p.amount),
    unpaidCount: data.invoices.filter((i) => i.payment_status !== 'paid').length,
    unmatchedBank: data.bank.filter((b) => b.status === 'unmatched').length,
    suggestedBank: data.bank.filter((b) => b.status === 'suggested').length,
    hasInvoices,
  };
}

const MONEY_FORMAT = '#,##0.00';

function moneyFormat(currency: string): string {
  try {
    const digits = currencyMinorUnits(currency) ?? 2;
    return digits === 0 ? '#,##0' : `#,##0.${'0'.repeat(digits)}`;
  } catch {
    return MONEY_FORMAT;
  }
}

function orderedCurrencies(codes: Iterable<string>, baseCurrency: string): string[] {
  return [...new Set(codes)].filter((code) => /^[A-Z]{3}$/.test(code)).sort((a, b) => {
    if (a === baseCurrency) return -1;
    if (b === baseCurrency) return 1;
    return a.localeCompare(b);
  });
}

/** Column widths + a money number-format pass — the styling SheetJS CE writes reliably. */
function styleSheet(
  sheet: XLSX.WorkSheet | undefined,
  widths: number[],
  moneyCols: number[],
  format = MONEY_FORMAT,
) {
  if (!sheet) return;
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = range.s.r + 1; row <= range.e.r; row++) {
    for (const col of moneyCols) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell && cell.t === 'n') cell.z = format;
    }
  }
}

/**
 * The two merged heading rows above a key/value block. Merges are in the measured
 * writes-reliably set; cell fills and fonts are NOT — see DEBT-REGISTER §37.
 */
function mergeTitleRows(sheet: XLSX.WorkSheet, lastCol: number) {
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
}

export function buildMonthlyWorkbook(input: {
  orgName: string | null | undefined;
  baseCurrency?: string;
  /** Locked snapshots include bank currencies even when no invoice/payment row carries them. */
  currencyCodes?: string[];
  month: string;
  generatedAt: Date;
  data: MonthlyReportData;
  labels: MonthlyReportLabels;
}) {
  const { data } = input;
  const baseCurrency = input.baseCurrency ?? 'ILS';
  const currencies = orderedCurrencies([
    ...(input.currencyCodes ?? []),
    ...data.invoices.map((row) => row.currency),
    ...data.payments.map((row) => row.currency),
    ...data.credits.map((row) => row.currency),
  ], baseCurrency);
  if (currencies.length === 0) currencies.push(baseCurrency);
  const mixed = currencies.length > 1;
  const workbook = XLSX.utils.book_new();

  const invoiceRows = (currency: string) => data.invoices.filter((row) => row.currency === currency);
  const paymentRows = (currency: string) => data.payments.filter((row) => row.currency === currency);
  const creditRows = (currency: string) => data.credits.filter((row) => row.currency === currency);
  const sum = <T>(rows: readonly T[], value: (row: T) => number) =>
    rows.reduce((total, row) => total + value(row), 0);
  const namedSheet = (name: string, currency: string) => {
    const value = mixed ? `${name} ${currency}` : name;
    if (value.length > 31) throw new Error(`monthly_report_sheet_name_too_long:${value}`);
    return value;
  };

  // The heading rows are new (owner review 19.08.2026): the summary sheet opened straight into a
  // bare key/value dump, which is what an export looks like when nobody decided how it should
  // read. The machine-readable rows below it are unchanged — the title is added above them, not
  // instead of them.
  const summaryRows: unknown[][] = [
    [`דוח חודשי לרו״ח — ${neutralize(input.orgName ?? '—')}`],
    [`${input.month} · הופק ${input.generatedAt.toISOString()}`],
    [],
    ['שם ארגון', neutralize(input.orgName ?? '—')],
    ['חודש', input.month],
    ['נוצר בתאריך', input.generatedAt.toISOString()],
    ['הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'],
    [],
    ['מדד', 'מספר רשומות', 'סכום', 'מטבע'],
  ];
  for (const currency of currencies) {
    const invoices = invoiceRows(currency);
    const payments = paymentRows(currency);
    const credits = creditRows(currency);
    summaryRows.push(
      ['חשבוניות', invoices.length, sum(invoices, (row) => row.total_amount), currency],
      ['לפני מע״מ', invoices.length, sum(invoices, (row) => row.amount_before_vat), currency],
      ['מע״מ', invoices.length, sum(invoices, (row) => row.vat_amount), currency],
      ['תשלומים', payments.length, sum(payments, (row) => row.amount), currency],
      ['זיכויים', credits.length, sum(credits, (row) => row.amount), currency],
    );
  }
  summaryRows.push(['חריגים פתוחים כרגע', data.exceptions.length, null, null]);
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);

  // Everything below that is not a number goes through neutralizeSpreadsheetRow. This workbook
  // LEAVES THE BUILDING — it is the file the accountant opens — and it carries supplier names,
  // exception titles, payment references and payment methods straight from tenant data. A value
  // starting `=` or `@` is a formula to Excel regardless of what we meant by it, and until now
  // this file neutralized nothing while documentExport.ts, which never leaves the app, did.
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'פרטי הדוח');
  for (const currency of currencies) {
    const rows = invoiceRows(currency).map((row) => neutralizeSpreadsheetRow({
      'ספק': row.supplier.name, 'מספר חשבונית': row.invoice_number, 'תאריך': row.invoice_date,
      'לפני מע"מ': row.amount_before_vat, 'מע"מ': row.vat_amount, 'סה"כ': row.total_amount,
      'מטבע': row.currency,
      'סטטוס בדיקה': input.labels.invoiceReview[row.review_status]?.label,
      'סטטוס תשלום': input.labels.invoicePayment[row.payment_status]?.label,
    }));
    const name = namedSheet('חשבוניות', currency);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, {
      header: ['ספק', 'מספר חשבונית', 'תאריך', 'לפני מע"מ', 'מע"מ', 'סה"כ', 'מטבע', 'סטטוס בדיקה', 'סטטוס תשלום'],
    }), name);
    styleSheet(workbook.Sheets[name], [24, 16, 12, 14, 12, 14, 10, 14, 14], [3, 4, 5], moneyFormat(currency));
  }
  for (const currency of currencies) {
    const rows = paymentRows(currency).map((row) => neutralizeSpreadsheetRow({
      'ספק': row.supplier.name, 'תאריך': row.paid_date, 'סכום': row.amount,
      'מטבע': row.currency, 'אמצעי': row.method, 'אסמכתא': row.reference,
    }));
    const name = namedSheet('תשלומים', currency);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, {
      header: ['ספק', 'תאריך', 'סכום', 'מטבע', 'אמצעי', 'אסמכתא'],
    }), name);
    styleSheet(workbook.Sheets[name], [24, 12, 14, 10, 14, 18], [2], moneyFormat(currency));
  }
  for (const currency of currencies) {
    const rows = creditRows(currency).map((row) => neutralizeSpreadsheetRow({
      'ספק': row.supplier.name, 'סיבה': input.labels.creditReason[row.reason], 'סכום': row.amount,
      'מטבע': row.currency, 'סטטוס': input.labels.creditStatus[row.status]?.label,
    }));
    const name = namedSheet('זיכויים', currency);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, {
      header: ['ספק', 'סיבה', 'סכום', 'מטבע', 'סטטוס'],
    }), name);
    styleSheet(workbook.Sheets[name], [24, 16, 14, 10, 14], [2], moneyFormat(currency));
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.exceptions.map((row) => neutralizeSpreadsheetRow({
    'סוג': input.labels.exceptionType[row.type], 'תיאור': row.title, 'ספק': row.supplier?.name ?? '',
  }))), 'חריגים פתוחים כרגע');

  /**
   * RTL is set HERE, in the one builder every path routes through, and not in each caller.
   * The locked snapshot download (Reports.tsx `downloadSnapshot`) shipped a LEFT-to-right
   * workbook to a Hebrew accountant because it was the one path that never got this line.
   *
   * This reverses the earlier decision to keep the locked workbook untouched, deliberately.
   * `RTL` is a VIEW attribute: it changes no cell value, and `snapshot.content_hash` is computed
   * server-side over the snapshot ROWS, never over the xlsx bytes. The evidence contract is a
   * claim about values, and the values are exactly what they were.
   *
   * Measured on the pinned xlsx@0.20.3: a single `Views[0]` entry writes `rightToLeft="1"` into
   * every `xl/worksheets/sheetN.xml` — there is no per-sheet array to fill in.
   */
  workbook.Workbook = { Views: [{ RTL: true }] };

  mergeTitleRows(summarySheet, 3);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 22 }, { wch: 16 }, { wch: 10 }];
  for (let row = 0; row < summaryRows.length; row++) {
    const currency = summaryRows[row]?.[3];
    const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 2 })];
    if (cell?.t === 'n' && typeof currency === 'string') cell.z = moneyFormat(currency);
  }
  styleSheet(workbook.Sheets['חריגים פתוחים כרגע'], [16, 40, 24], []);
  return workbook;
}

/**
 * The BUILT-IN styled default for the monthly accountant report (owner decision 18.08.2026):
 * used when no custom template is configured, replacing the bare fallback workbook.
 *
 * Styled IN CODE, not from a template file, on purpose. A shipped .xlsx asset would rest on
 * SheetJS CE preserving cell styles through a read→write round trip — exactly the unproven debt
 * DEBT-REGISTER §37 tracks. Every builder here uses only what CE writes reliably: RTL views,
 * merges, column widths and number formats — measured, not assumed. Cell fills and fonts are
 * discarded on write, so brand colour in the workbook is not on the table (§37 again). What this
 * builder adds on top of the base is the summary sheet: the same figures a custom template maps,
 * labeled from the EXPORT_DEFINITIONS registry, so both paths speak one vocabulary.
 *
 * The locked snapshot (buildLockedMonthlyWorkbook) shares the BASE builder's presentation — RTL
 * views, widths, number formats, a heading block — because none of it touches a cell value. It
 * does not share this summary sheet: a version is an evidence artifact and its figures come only
 * from the frozen snapshot rows, never from today's registry or today's live data.
 */
export function buildStyledMonthlyWorkbook(input: Parameters<typeof buildMonthlyWorkbook>[0] & {
  summary: ReportTemplateValues;
}): XLSX.WorkBook {
  const workbook = buildMonthlyWorkbook(input);

  const { data, summary } = input;
  const currencies = orderedCurrencies([
    ...data.invoices.map((row) => row.currency),
    ...data.payments.map((row) => row.currency),
    ...data.credits.map((row) => row.currency),
  ], input.baseCurrency ?? 'ILS');
  // A scalar template field cannot represent two currencies. The base builder already produced
  // the honest per-currency summary and split sheets, so a mixed month keeps that sheet.
  if (currencies.length > 1) return workbook;
  const reportCurrency = currencies[0] ?? input.baseCurrency ?? 'ILS';
  const definition = exportDefinition('accountant_monthly_report');
  const commonKeys = new Set(['org_name', 'period_label', 'period_from', 'period_to', 'generated_at']);
  const moneyKeys = new Set(['net_total', 'vat_total', 'gross_total', 'credits_recognized', 'net_expense']);
  // A missing value stays an empty cell — never 0 (constitution: אפס הוא גם טענה על המציאות).
  const fieldRows = (definition?.fields ?? [])
    .filter((field) => !commonKeys.has(field.key))
    .map((field) => [
      field.label,
      summary[field.key] ?? null,
      moneyKeys.has(field.key) ? reportCurrency : null,
    ]);

  const sheet = XLSX.utils.aoa_to_sheet([
    [`דוח חודשי לרו״ח — ${neutralize(input.orgName ?? '—')}`],
    [`${summary.period_label ?? input.month} · ${summary.period_from ?? ''}–${summary.period_to ?? ''} · הופק ${summary.generated_at ?? input.generatedAt.toISOString()}`],
    [],
    ['נתון', 'ערך', 'מטבע'],
    ...fieldRows,
    [],
    ['מדד', 'מספר רשומות', 'מטבע'],
    ['חשבוניות', data.invoices.length, null],
    ['תשלומים', data.payments.length, null],
    ['זיכויים', data.credits.length, null],
    ['חריגים פתוחים כרגע', data.exceptions.length, null],
    [],
    ['הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'],
  ]);
  mergeTitleRows(sheet, 2);
  sheet['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 16 }];
  fieldRows.forEach(([label], index) => {
    const field = definition?.fields.find((candidate) => candidate.label === label);
    if (!field || !moneyKeys.has(field.key)) return;
    const cell = sheet[XLSX.utils.encode_cell({ r: 4 + index, c: 1 })];
    if (cell && cell.t === 'n') cell.z = moneyFormat(reportCurrency);
  });
  // The data sheets are already styled by the base builder; only the summary sheet is replaced.
  workbook.Sheets['פרטי הדוח'] = sheet;
  return workbook;
}

/**
 * Build an accountant workbook exclusively from an immutable database snapshot.
 *
 * No live query result, external link or formula is consulted here. Re-downloading a version
 * therefore produces equivalent workbook values even when the operational tables later change.
 *
 * Presentation is a different question from values. This workbook inherits the base builder's
 * RTL views, column widths and number formats and adds the same heading block, because none of
 * those reads a value or changes one — and a snapshot the accountant cannot read left-to-right
 * is not better evidence for being plain.
 */
export function buildLockedMonthlyWorkbook(input: {
  snapshot: MonthlyReportSnapshot;
}) {
  const { snapshot } = input;
  // v1/v2 rows predate currency columns. They were written while 0108 refused every non-ILS
  // document, so ILS is evidence about history rather than a display fallback.
  const invoiceRows = snapshot.invoice_rows.map((row) => ({ ...row, currency: row.currency ?? 'ILS' }));
  const paymentRows = snapshot.payment_rows.map((row) => ({ ...row, currency: row.currency ?? 'ILS' }));
  const creditRows = snapshot.credit_rows.map((row) => ({ ...row, currency: row.currency ?? 'ILS' }));
  const bankRows = snapshot.bank_rows.map((row) => ({ ...row, currency: row.currency ?? 'ILS' }));
  const baseCurrency = snapshot.base_currency ?? 'ILS';
  const currencies = orderedCurrencies([
    ...invoiceRows.map((row) => row.currency),
    ...paymentRows.map((row) => row.currency),
    ...creditRows.map((row) => row.currency),
    ...bankRows.map((row) => row.currency),
  ], baseCurrency);
  if (currencies.length === 0) currencies.push(baseCurrency);
  // v2 stores every row label beside the raw enum. Older local v1 artifacts remain readable
  // without consulting today's label maps: their frozen raw value is the conservative fallback.
  const frozenLabels: MonthlyReportLabels = {
    invoiceReview: Object.fromEntries(invoiceRows.map((row) => [
      row.review_status, { label: row.review_status_label ?? row.review_status },
    ])),
    invoicePayment: Object.fromEntries(invoiceRows.map((row) => [
      row.payment_status, { label: row.payment_status_label ?? row.payment_status },
    ])),
    creditReason: Object.fromEntries(creditRows.map((row) => [
      row.reason, row.reason_label ?? row.reason,
    ])),
    creditStatus: Object.fromEntries(creditRows.map((row) => [
      row.status, { label: row.status_label ?? row.status },
    ])),
    exceptionType: Object.fromEntries(snapshot.exception_rows.map((row) => [
      row.type, row.type_label ?? row.type,
    ])),
  };
  const workbook = buildMonthlyWorkbook({
    orgName: snapshot.organization_name,
    baseCurrency,
    currencyCodes: currencies,
    month: snapshot.report_month.slice(0, 7),
    generatedAt: new Date(snapshot.created_at),
    data: {
      invoices: invoiceRows,
      payments: paymentRows,
      credits: creditRows,
      exceptions: snapshot.exception_rows,
    },
    labels: frozenLabels,
  });

  const summaryRows: unknown[][] = [
    [`דוח סופי נעול — ${neutralize(snapshot.organization_name)} · ${neutralize(snapshot.legal_entity_name)}`],
    [`${snapshot.report_month.slice(0, 7)} · גרסה ${snapshot.version} · נוצר ${snapshot.created_at}`],
    [],
    ['סוג הדוח', 'דוח סופי נעול'],
    ['שם ארגון', neutralize(snapshot.organization_name)],
    ['ישות משפטית', neutralize(snapshot.legal_entity_name)],
    ['חודש', snapshot.report_month.slice(0, 7)],
    ['גרסת snapshot', snapshot.version],
    ['גרסת מבנה הדוח', snapshot.report_version],
    ['נוצר בתאריך', snapshot.created_at],
    ['נוצר על ידי', neutralize(snapshot.created_by_name)],
    ['Snapshot ID', snapshot.id],
    ['Checksum', snapshot.content_hash],
    ['הערה', 'דוח סופי זה נוצר רק מנתוני snapshot נעולים במסד הנתונים ומשקף את גבול הדוח החי במועד היצירה.'],
    [],
    ['מדד', 'מספר רשומות', 'סכום', 'מטבע'],
  ];
  const sum = <T>(rows: readonly T[], value: (row: T) => number) =>
    rows.reduce((total, row) => total + value(row), 0);
  for (const currency of currencies) {
    const invoices = invoiceRows.filter((row) => row.currency === currency);
    const payments = paymentRows.filter((row) => row.currency === currency);
    const credits = creditRows.filter((row) => row.currency === currency);
    const bank = bankRows.filter((row) => row.currency === currency);
    summaryRows.push(
      ['חשבוניות', invoices.length, sum(invoices, (row) => row.total_amount), currency],
      ['לפני מע״מ', invoices.length, sum(invoices, (row) => row.amount_before_vat), currency],
      ['מע״מ', invoices.length, sum(invoices, (row) => row.vat_amount), currency],
      ['תשלומים', payments.length, sum(payments, (row) => row.amount), currency],
      ['זיכויים', credits.length, sum(credits, (row) => row.amount), currency],
      ['תנועות בנק', bank.length, sum(bank, (row) => row.amount), currency],
    );
  }
  summaryRows.push(['חריגים פתוחים בעת היצירה', snapshot.totals.exception_count, null, null]);
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  mergeTitleRows(summarySheet, 3);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 34 }, { wch: 16 }, { wch: 10 }];
  for (let row = 0; row < summaryRows.length; row++) {
    const currency = summaryRows[row]?.[3];
    const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 2 })];
    if (cell?.t === 'n' && typeof currency === 'string') cell.z = moneyFormat(currency);
  }
  workbook.Sheets['פרטי הדוח'] = summarySheet;

  for (const currency of currencies) {
    const rows = bankRows.filter((row) => row.currency === currency).map((row) => neutralizeSpreadsheetRow({
      'תאריך': row.tx_date,
      'תיאור': row.description,
      'סכום': row.amount,
      'מטבע': row.currency,
      'סוג': row.direction_label ?? (row.is_debit ? 'debit' : 'credit'),
      'אסמכתא': row.reference,
      'סטטוס': row.status_label ?? row.status,
    }));
    const name = currencies.length > 1 ? `תנועות בנק ${currency}` : 'תנועות בנק';
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, {
      header: ['תאריך', 'תיאור', 'סכום', 'מטבע', 'סוג', 'אסמכתא', 'סטטוס'],
    }), name);
    styleSheet(workbook.Sheets[name], [12, 40, 14, 10, 10, 18, 14], [2], moneyFormat(currency));
  }

  return workbook;
}
