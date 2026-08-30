import { exportDefinition } from './exportTemplates';
import type { TKey } from './i18n/t.ts';
import { fmtDateTime } from './format';
import type {
  WorkbookCellType, WorkbookMatrixRow, WorkbookMatrixSheet, WorkbookSheet, WorkbookSpec,
} from './workbook';
import type { ReportTemplateValues } from './reportTemplateExport';
import { currencyMinorUnits } from './format';

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

/**
 * RESOLVED labels, not the status maps. The maps carry dictionary keys now, and a spreadsheet
 * builder is the wrong place to be resolving a language — it would need a locale, and a workbook
 * exported in the wrong one is a file somebody sends to their accountant.
 */
export interface MonthlyReportLabels {
  invoiceReview: Record<string, string | undefined>;
  invoicePayment: Record<string, string | undefined>;
  creditReason: Record<string, string | undefined>;
  creditStatus: Record<string, string | undefined>;
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

/** A key/value line inside a summary sheet: label in the first column, value in the second. */
const pair = (label: string, value: unknown, type?: WorkbookCellType): WorkbookMatrixRow =>
  ({ cells: [label, value], types: [undefined, type] });

const MONEY_FORMAT = '#,##0.00';

/**
 * THE NUMBER FORMAT FOR ONE CURRENCY, FROM ITS OWN MINOR UNITS (0217, #294).
 *
 * A fixed `#,##0.00` is a claim that every currency has two decimal places. JPY has none and KWD
 * has three, so the fixed format would print ¥1,200 as ¥1,200.00 and round a Kuwaiti fils out of
 * an accountant's file. This is a WRITING rule and never a conversion: the same figure, spelled
 * with the number of digits its own currency actually uses.
 */
function moneyFormat(currency: string): string {
  try {
    const digits = currencyMinorUnits(currency) ?? 2;
    return digits === 0 ? '#,##0' : `#,##0.${'0'.repeat(digits)}`;
  } catch {
    return MONEY_FORMAT;
  }
}

/**
 * `<name> <ISO>` in a mixed month and the bare name otherwise (#287), so a shekel-only business
 * gets exactly the workbook it had before the currency campaign. Excel refuses a sheet name over
 * 31 characters and refuses the whole FILE rather than the sheet, and `create_monthly_report_snapshot`
 * hashes what it is handed — so this throws rather than letting `sheetName()` quietly truncate two
 * currencies down to one name.
 */
function namedSheet(name: string, currency: string, mixed: boolean): string {
  const value = mixed ? `${name} ${currency}` : name;
  if (value.length > 31) throw new Error(`monthly_report_sheet_name_too_long:${value}`);
  return value;
}

/** Base currency first, then ISO order (#287), so a snapshot hash cannot depend on arrival order. */
function orderedCurrencies(codes: Iterable<string>, baseCurrency: string): string[] {
  return [...new Set(codes)].filter((code) => /^[A-Z]{3}$/.test(code)).sort((a, b) => {
    if (a === baseCurrency) return -1;
    if (b === baseCurrency) return 1;
    return a.localeCompare(b);
  });
}

export function buildMonthlyWorkbook(input: {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  orgName: string | null | undefined;
  baseCurrency?: string;
  /** Locked snapshots include bank currencies even when no invoice/payment row carries them. */
  currencyCodes?: string[];
  month: string;
  generatedAt: Date;
  data: MonthlyReportData;
  labels: MonthlyReportLabels;
}): WorkbookSpec {
  const { data, t } = input;
  const baseCurrency = input.baseCurrency ?? 'ILS';
  const currencies = orderedCurrencies([
    ...(input.currencyCodes ?? []),
    ...data.invoices.map((row) => row.currency),
    ...data.payments.map((row) => row.currency),
    ...data.credits.map((row) => row.currency),
  ], baseCurrency);
  if (currencies.length === 0) currencies.push(baseCurrency);
  const mixed = currencies.length > 1;

  const invoiceRows = (currency: string) => data.invoices.filter((row) => row.currency === currency);
  const paymentRows = (currency: string) => data.payments.filter((row) => row.currency === currency);
  const creditRows = (currency: string) => data.credits.filter((row) => row.currency === currency);
  const sum = <T>(rows: readonly T[], value: (row: T) => number) =>
    rows.reduce((total, row) => total + value(row), 0);
  /**
   * `<name> <ISO>` in a mixed month and the bare name otherwise (#287), so a shekel-only business
   * gets exactly the workbook it had before the currency campaign. Excel refuses a sheet name over
   * 31 characters and refuses the whole FILE rather than the sheet, and `create_monthly_report_snapshot`
   * hashes what it is handed — so this throws rather than letting `sheetName()` quietly truncate
   * two currencies down to one name.
   */
  const named = (name: string, currency: string) => namedSheet(name, currency, mixed);

  const summaryMatrix: WorkbookMatrixRow[] = [
    pair(t('reports.xlOrgName'), input.orgName ?? '—'),
    pair(t('reports.xlMonth'), input.month),
    pair(t('reports.xlCreatedOn'), input.generatedAt, 'date'),
    pair(t('reports.xlNote'), t('reports.xlNoteLive')),
    { cells: [] },
    { cells: [t('reports.xlMeasure'), t('reports.xlRecordCount'), t('reports.xlAmount'), t('reports.xlCurrency')], header: true },
  ];
  /* ONE SUMMARY BLOCK PER CURRENCY, AND NO COMBINED ROW — #287, and the sentence the whole
     currency campaign is measured against: 12,400 shekels and 3,100 dollars are not 15,500. The
     block repeats for a second currency instead of a column quietly gaining a second meaning, so
     a single-currency month reads exactly as it always did with its currency named beside it. */
  for (const currency of currencies) {
    const invoices = invoiceRows(currency);
    const payments = paymentRows(currency);
    const credits = creditRows(currency);
    const line = (label: string, count: number, amount: number): WorkbookMatrixRow => ({
      cells: [label, count, amount, currency],
      types: [undefined, 'number', 'money'],
      moneyFormat: moneyFormat(currency),
    });
    summaryMatrix.push(
      line(t('reports.xlInvoices'), invoices.length, sum(invoices, (row) => row.total_amount)),
      line(t('reports.xlBeforeVat'), invoices.length, sum(invoices, (row) => row.amount_before_vat)),
      line(t('reports.xlVat'), invoices.length, sum(invoices, (row) => row.vat_amount)),
      line(t('reports.xlPayments'), payments.length, sum(payments, (row) => row.amount)),
      line(t('reports.xlCredits'), credits.length, sum(credits, (row) => row.amount)),
    );
  }
  summaryMatrix.push({
    cells: [t('reports.xlOpenExceptionsNow'), data.exceptions.length, null, null],
    types: [undefined, 'number', 'money'],
  });

  /**
   * Every value below that is not a number is tenant data — supplier names, exception titles,
   * payment references and methods, bank descriptions. `workbook.ts` neutralizes each text cell as
   * it writes it, because a value starting `=` or `@` is a formula to Excel regardless of what we
   * meant by it, and this workbook LEAVES THE BUILDING.
   *
   * RTL, the merged title block, column widths and the money format are the writer's job too, and
   * that is the point of routing every builder through it: the locked snapshot download once
   * shipped a left-to-right workbook to a Hebrew accountant for no reason other than being the one
   * path that never got the line. A caller cannot forget what it does not set.
   */
  return {
    title: t('reports.xlTitleMonthly', { org: input.orgName ?? '—' }),
    subtitle: t('reports.xlProducedAt', { month: input.month, at: fmtDateTime(input.generatedAt.toISOString()) }),
    sheets: [
      { name: t('reports.xlSheetReportDetails'), widths: [30, 22, 16, 10], matrix: summaryMatrix },
      ...currencies.map((currency): WorkbookSheet => ({
        name: named(t('reports.xlInvoices'), currency),
        moneyFormat: moneyFormat(currency),
        columns: [
          { header: t('reports.xlSupplier'), key: 'supplier', width: 24 },
          { header: t('reports.xlInvoiceNumber'), key: 'number', width: 16 },
          { header: t('reports.xlDate'), key: 'date', width: 12, type: 'date' },
          { header: t('reports.xlBeforeVatQuoted'), key: 'net', width: 14, type: 'money' },
          { header: t('reports.xlVatQuoted'), key: 'vat', width: 12, type: 'money' },
          { header: t('reports.xlTotalQuoted'), key: 'total', width: 14, type: 'money' },
          { header: t('reports.xlCurrency'), key: 'currency', width: 10 },
          { header: t('reports.xlReviewStatus'), key: 'review', width: 14 },
          { header: t('reports.xlPaymentStatus'), key: 'payment', width: 14 },
        ],
        rows: invoiceRows(currency).map((row) => ({
          supplier: row.supplier.name,
          number: row.invoice_number,
          date: row.invoice_date,
          net: row.amount_before_vat,
          vat: row.vat_amount,
          total: row.total_amount,
          currency: row.currency,
          review: input.labels.invoiceReview[row.review_status],
          payment: input.labels.invoicePayment[row.payment_status],
        })),
      })),
      ...currencies.map((currency): WorkbookSheet => ({
        name: named(t('reports.xlPayments'), currency),
        moneyFormat: moneyFormat(currency),
        columns: [
          { header: t('reports.xlSupplier'), key: 'supplier', width: 24 },
          { header: t('reports.xlDate'), key: 'date', width: 12, type: 'date' },
          { header: t('reports.xlAmount'), key: 'amount', width: 14, type: 'money' },
          { header: t('reports.xlCurrency'), key: 'currency', width: 10 },
          { header: t('reports.xlMethod'), key: 'method', width: 14 },
          { header: t('reports.xlReference'), key: 'reference', width: 18 },
        ],
        rows: paymentRows(currency).map((row) => ({
          supplier: row.supplier.name,
          date: row.paid_date,
          amount: row.amount,
          currency: row.currency,
          method: row.method,
          reference: row.reference,
        })),
      })),
      ...currencies.map((currency): WorkbookSheet => ({
        name: named(t('reports.xlCredits'), currency),
        moneyFormat: moneyFormat(currency),
        columns: [
          { header: t('reports.xlSupplier'), key: 'supplier', width: 24 },
          { header: t('reports.xlReason'), key: 'reason', width: 16 },
          { header: t('reports.xlAmount'), key: 'amount', width: 14, type: 'money' },
          { header: t('reports.xlCurrency'), key: 'currency', width: 10 },
          { header: t('reports.xlStatus'), key: 'status', width: 14 },
        ],
        rows: creditRows(currency).map((row) => ({
          supplier: row.supplier.name,
          reason: input.labels.creditReason[row.reason],
          amount: row.amount,
          currency: row.currency,
          status: input.labels.creditStatus[row.status],
        })),
      })),
      {
        name: t('reports.xlOpenExceptionsNow'),
        columns: [
          { header: t('reports.xlType'), key: 'type', width: 16 },
          { header: t('reports.xlDescription'), key: 'title', width: 40 },
          { header: t('reports.xlSupplier'), key: 'supplier', width: 24 },
        ],
        rows: data.exceptions.map((row) => ({
          type: input.labels.exceptionType[row.type],
          title: row.title,
          supplier: row.supplier?.name ?? '',
        })),
      },
    ],
  };
}

/**
 * The BUILT-IN styled default for the monthly accountant report (owner decision 18.08.2026):
 * used when no custom template is configured, replacing the bare fallback workbook.
 *
 * Styled IN CODE, not from a template file, on purpose. A shipped .xlsx asset would rest on a
 * reader preserving cell styles through a read→write round trip — exactly the debt DEBT-REGISTER
 * §37 tracks, and the reason `workbook.ts` writes these files at all. What this builder adds on
 * top of the base is the summary sheet: the same figures a custom template maps, labeled from the
 * EXPORT_DEFINITIONS registry, so both paths speak one vocabulary.
 *
 * The locked snapshot (buildLockedMonthlyWorkbook) shares the BASE builder's presentation — RTL
 * views, widths, number formats, a heading block — because none of it touches a cell value. It
 * does not share this summary sheet: a version is an evidence artifact and its figures come only
 * from the frozen snapshot rows, never from today's registry or today's live data.
 */
export function buildStyledMonthlyWorkbook(input: Parameters<typeof buildMonthlyWorkbook>[0] & {
  summary: ReportTemplateValues;
}): WorkbookSpec {
  const base = buildMonthlyWorkbook(input);

  const { data, summary, t } = input;
  const currencies = orderedCurrencies([
    ...data.invoices.map((row) => row.currency),
    ...data.payments.map((row) => row.currency),
    ...data.credits.map((row) => row.currency),
  ], input.baseCurrency ?? 'ILS');
  /* A SCALAR TEMPLATE FIELD CANNOT REPRESENT TWO CURRENCIES. `net_total` is one cell and one
     number; in a mixed month there is no honest number to put in it. The base builder has already
     produced the per-currency summary block and the split sheets, so a mixed month keeps that
     sheet rather than gaining a prettier one that adds unlike money. */
  if (currencies.length > 1) return base;
  const reportCurrency = currencies[0] ?? input.baseCurrency ?? 'ILS';
  const definition = exportDefinition('accountant_monthly_report');
  const commonKeys = new Set(['org_name', 'period_label', 'period_from', 'period_to', 'generated_at']);
  const moneyKeys = new Set(['net_total', 'vat_total', 'gross_total', 'credits_recognized', 'net_expense']);
  // A missing value stays an empty cell — never 0 (constitution: אפס הוא גם טענה על המציאות).
  const fieldRows: WorkbookMatrixRow[] = (definition?.fields ?? [])
    .filter((field) => !commonKeys.has(field.key))
    .map((field) => (moneyKeys.has(field.key)
      ? {
        cells: [t(field.labelKey), summary[field.key] ?? null, reportCurrency],
        types: [undefined, 'money'] as const,
        moneyFormat: moneyFormat(reportCurrency),
      }
      : pair(t(field.labelKey), summary[field.key] ?? null, 'number')));

  const summarySheet: WorkbookMatrixSheet = {
    name: t('reports.xlSheetReportDetails'),
    widths: [28, 20, 16],
    moneyFormat: moneyFormat(reportCurrency),
    matrix: [
      { cells: [t('reports.xlField'), t('reports.xlValue'), t('reports.xlCurrency')], header: true },
      ...fieldRows,
      { cells: [] },
      { cells: [t('reports.xlMeasure'), t('reports.xlRecordCount')], header: true },
      { cells: [t('reports.xlInvoices'), data.invoices.length], types: [undefined, 'number'] },
      { cells: [t('reports.xlPayments'), data.payments.length], types: [undefined, 'number'] },
      { cells: [t('reports.xlCredits'), data.credits.length], types: [undefined, 'number'] },
      { cells: [t('reports.xlOpenExceptionsNow'), data.exceptions.length], types: [undefined, 'number'] },
      { cells: [] },
      pair(t('reports.xlNote'), t('reports.xlNoteLive')),
    ],
  };

  // The data sheets are already described by the base builder; only the summary sheet is replaced.
  return {
    title: base.title,
    subtitle: t('reports.xlStyledSubtitle', {
      label: summary.period_label ?? input.month,
      from: summary.period_from ?? '',
      to: summary.period_to ?? '',
      at: summary.generated_at ?? fmtDateTime(input.generatedAt.toISOString()),
    }),
    sheets: base.sheets.map((sheet) => sheet.name === t('reports.xlSheetReportDetails') ? summarySheet : sheet),
  };
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
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  snapshot: MonthlyReportSnapshot;
}): WorkbookSpec {
  const { snapshot, t } = input;
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
  const mixed = currencies.length > 1;
  // v2 stores every row label beside the raw enum. Older local v1 artifacts remain readable
  // without consulting today's label maps: their frozen raw value is the conservative fallback.
  const frozenLabels: MonthlyReportLabels = {
    invoiceReview: Object.fromEntries(invoiceRows.map((row) => [
      row.review_status, row.review_status_label ?? row.review_status,
    ])),
    invoicePayment: Object.fromEntries(invoiceRows.map((row) => [
      row.payment_status, row.payment_status_label ?? row.payment_status,
    ])),
    creditReason: Object.fromEntries(creditRows.map((row) => [
      row.reason, row.reason_label ?? row.reason,
    ])),
    creditStatus: Object.fromEntries(creditRows.map((row) => [
      row.status, row.status_label ?? row.status,
    ])),
    exceptionType: Object.fromEntries(snapshot.exception_rows.map((row) => [
      row.type, row.type_label ?? row.type,
    ])),
  };
  const base = buildMonthlyWorkbook({
    t,
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

  const sum = <T>(rows: readonly T[], value: (row: T) => number) =>
    rows.reduce((total, row) => total + value(row), 0);
  const summaryMatrix: WorkbookMatrixRow[] = [
    pair(t('reports.xlReportKind'), t('reports.xlLockedFinalReport')),
    pair(t('reports.xlOrgName'), snapshot.organization_name),
    pair(t('reports.xlLegalEntity'), snapshot.legal_entity_name),
    pair(t('reports.xlMonth'), snapshot.report_month.slice(0, 7)),
    pair(t('reports.xlSnapshotVersion'), snapshot.version, 'number'),
    pair(t('reports.xlReportLayoutVersion'), snapshot.report_version),
    pair(t('reports.xlCreatedOn'), snapshot.created_at, 'date'),
    pair(t('reports.xlCreatedBy'), snapshot.created_by_name),
    pair('Snapshot ID', snapshot.id),
    pair('Checksum', snapshot.content_hash),
    pair(t('reports.xlNote'), t('reports.xlNoteLocked')),
    { cells: [] },
    { cells: [t('reports.xlMeasure'), t('reports.xlRecordCount'), t('reports.xlAmount'), t('reports.xlCurrency')], header: true },
  ];
  /* THE FROZEN FIGURES, READ PER CURRENCY FROM THE FROZEN ROWS. `snapshot.totals` still carries
     the scalar v1/v2 sums, and they are deliberately NOT used for the money columns here: a
     combined `invoice_total` across two currencies is the one number #287 forbids. The counts and
     the per-currency sums both come from the snapshot's own rows, so this stays evidence. */
  for (const currency of currencies) {
    const invoices = invoiceRows.filter((row) => row.currency === currency);
    const payments = paymentRows.filter((row) => row.currency === currency);
    const credits = creditRows.filter((row) => row.currency === currency);
    const bank = bankRows.filter((row) => row.currency === currency);
    const line = (label: string, count: number, amount: number): WorkbookMatrixRow => ({
      cells: [label, count, amount, currency],
      types: [undefined, 'number', 'money'],
      moneyFormat: moneyFormat(currency),
    });
    summaryMatrix.push(
      line(t('reports.xlInvoices'), invoices.length, sum(invoices, (row) => row.total_amount)),
      line(t('reports.xlBeforeVat'), invoices.length, sum(invoices, (row) => row.amount_before_vat)),
      line(t('reports.xlVat'), invoices.length, sum(invoices, (row) => row.vat_amount)),
      line(t('reports.xlPayments'), payments.length, sum(payments, (row) => row.amount)),
      line(t('reports.xlCredits'), credits.length, sum(credits, (row) => row.amount)),
      line(t('reports.xlBankTransactions'), bank.length, sum(bank, (row) => row.amount)),
    );
  }
  summaryMatrix.push({
    cells: [t('reports.xlOpenExceptionsAtCreation'), snapshot.totals.exception_count, null, null],
    types: [undefined, 'number', 'money'],
  });

  const summarySheet: WorkbookMatrixSheet = {
    name: t('reports.xlSheetReportDetails'),
    widths: [30, 34, 16, 10],
    matrix: summaryMatrix,
  };

  return {
    title: t('reports.xlTitleLocked', { org: snapshot.organization_name, entity: snapshot.legal_entity_name }),
    subtitle: t('reports.xlLockedSubtitle', {
      month: snapshot.report_month.slice(0, 7),
      version: snapshot.version,
      at: fmtDateTime(snapshot.created_at),
    }),
    sheets: [
      ...base.sheets.map((sheet) => sheet.name === t('reports.xlSheetReportDetails') ? summarySheet : sheet),
      ...currencies.map((currency): WorkbookSheet => ({
        name: namedSheet(t('reports.xlBankTransactions'), currency, mixed),
        moneyFormat: moneyFormat(currency),
        columns: [
          { header: t('reports.xlDate'), key: 'date', width: 12, type: 'date' },
          { header: t('reports.xlDescription'), key: 'description', width: 40 },
          { header: t('reports.xlAmount'), key: 'amount', width: 14, type: 'money' },
          { header: t('reports.xlCurrency'), key: 'currency', width: 10 },
          { header: t('reports.xlType'), key: 'direction', width: 10 },
          { header: t('reports.xlReference'), key: 'reference', width: 18 },
          { header: t('reports.xlStatus'), key: 'status', width: 14 },
        ],
        rows: bankRows.filter((row) => row.currency === currency).map((row) => ({
          date: row.tx_date,
          description: row.description,
          amount: row.amount,
          currency: row.currency,
          direction: row.direction_label ?? (row.is_debit ? 'debit' : 'credit'),
          reference: row.reference,
          status: row.status_label ?? row.status,
        })),
      })),
    ],
  };
}
