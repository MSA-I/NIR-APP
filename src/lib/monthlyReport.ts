import { exportDefinition } from './exportTemplates';
import { fmtDateTime } from './format';
import type {
  WorkbookCellType, WorkbookMatrixRow, WorkbookMatrixSheet, WorkbookSpec,
} from './workbook';
import type { ReportTemplateValues } from './reportTemplateExport';

export interface MonthlyReportData {
  invoices: { supplier: { name: string }; invoice_number: string; invoice_date: string; amount_before_vat: number; vat_amount: number; total_amount: number; review_status: string; payment_status: string }[];
  payments: { supplier: { name: string }; paid_date: string; amount: number; method: string | null; reference: string | null }[];
  credits: { supplier: { name: string }; reason: string; amount: number; status: string }[];
  exceptions: { type: string; title: string; supplier: { name: string } | null }[];
}

export interface MonthlyReportSnapshot {
  id: string;
  org_id: string;
  unit_id: string;
  report_month: string;
  version: number;
  report_version: string;
  organization_name: string;
  legal_entity_name: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  invoice_rows: (MonthlyReportData['invoices'][number] & {
    review_status_label?: string;
    payment_status_label?: string;
  })[];
  payment_rows: MonthlyReportData['payments'];
  credit_rows: (MonthlyReportData['credits'][number] & {
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
export function monthlyReportScreenTotals(data: {
  invoices: { total_amount: number; amount_before_vat: number; vat_amount: number; payment_status: string }[];
  payments: { amount: number }[];
  bank: { status: string }[];
}) {
  const hasInvoices = data.invoices.length > 0;
  const hasPayments = data.payments.length > 0;
  return {
    invoices: hasInvoices ? data.invoices.reduce((s, i) => s + i.total_amount, 0) : null,
    beforeVat: hasInvoices ? data.invoices.reduce((s, i) => s + i.amount_before_vat, 0) : null,
    vat: hasInvoices ? data.invoices.reduce((s, i) => s + i.vat_amount, 0) : null,
    paid: hasPayments ? data.payments.reduce((s, p) => s + p.amount, 0) : null,
    unpaidCount: data.invoices.filter((i) => i.payment_status !== 'paid').length,
    unmatchedBank: data.bank.filter((b) => b.status === 'unmatched').length,
    suggestedBank: data.bank.filter((b) => b.status === 'suggested').length,
    hasInvoices,
  };
}

/** A key/value line inside a summary sheet: label in the first column, value in the second. */
const pair = (label: string, value: unknown, type?: WorkbookCellType): WorkbookMatrixRow =>
  ({ cells: [label, value], types: [undefined, type] });

export function buildMonthlyWorkbook(input: {
  orgName: string | null | undefined;
  month: string;
  generatedAt: Date;
  data: MonthlyReportData;
  labels: MonthlyReportLabels;
}): WorkbookSpec {
  const { data } = input;
  const invoiceTotal = data.invoices.reduce((sum, row) => sum + row.total_amount, 0);
  const beforeVatTotal = data.invoices.reduce((sum, row) => sum + row.amount_before_vat, 0);
  const vatTotal = data.invoices.reduce((sum, row) => sum + row.vat_amount, 0);
  const paymentTotal = data.payments.reduce((sum, row) => sum + row.amount, 0);
  const creditTotal = data.credits.reduce((sum, row) => sum + row.amount, 0);

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
    title: `דוח חודשי לרו״ח — ${input.orgName ?? '—'}`,
    subtitle: `${input.month} · הופק ${fmtDateTime(input.generatedAt.toISOString())}`,
    sheets: [
      {
        name: 'פרטי הדוח',
        widths: [30, 22, 16],
        matrix: [
          pair('שם ארגון', input.orgName ?? '—'),
          pair('חודש', input.month),
          pair('נוצר בתאריך', input.generatedAt, 'date'),
          pair('הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'),
          { cells: [] },
          { cells: ['מדד', 'מספר רשומות', 'סכום'], header: true },
          { cells: ['חשבוניות', data.invoices.length, invoiceTotal], types: [undefined, 'number', 'money'] },
          { cells: ['לפני מע״מ', data.invoices.length, beforeVatTotal], types: [undefined, 'number', 'money'] },
          { cells: ['מע״מ', data.invoices.length, vatTotal], types: [undefined, 'number', 'money'] },
          { cells: ['תשלומים', data.payments.length, paymentTotal], types: [undefined, 'number', 'money'] },
          { cells: ['זיכויים', data.credits.length, creditTotal], types: [undefined, 'number', 'money'] },
          { cells: ['חריגים פתוחים כרגע', data.exceptions.length, null], types: [undefined, 'number', 'money'] },
        ],
      },
      {
        name: 'חשבוניות',
        columns: [
          { header: 'ספק', key: 'supplier', width: 24 },
          { header: 'מספר חשבונית', key: 'number', width: 16 },
          { header: 'תאריך', key: 'date', width: 12, type: 'date' },
          { header: 'לפני מע"מ', key: 'net', width: 14, type: 'money' },
          { header: 'מע"מ', key: 'vat', width: 12, type: 'money' },
          { header: 'סה"כ', key: 'total', width: 14, type: 'money' },
          { header: 'סטטוס בדיקה', key: 'review', width: 14 },
          { header: 'סטטוס תשלום', key: 'payment', width: 14 },
        ],
        rows: data.invoices.map((row) => ({
          supplier: row.supplier.name,
          number: row.invoice_number,
          date: row.invoice_date,
          net: row.amount_before_vat,
          vat: row.vat_amount,
          total: row.total_amount,
          review: input.labels.invoiceReview[row.review_status]?.label,
          payment: input.labels.invoicePayment[row.payment_status]?.label,
        })),
      },
      {
        name: 'תשלומים',
        columns: [
          { header: 'ספק', key: 'supplier', width: 24 },
          { header: 'תאריך', key: 'date', width: 12, type: 'date' },
          { header: 'סכום', key: 'amount', width: 14, type: 'money' },
          { header: 'אמצעי', key: 'method', width: 14 },
          { header: 'אסמכתא', key: 'reference', width: 18 },
        ],
        rows: data.payments.map((row) => ({
          supplier: row.supplier.name,
          date: row.paid_date,
          amount: row.amount,
          method: row.method,
          reference: row.reference,
        })),
      },
      {
        name: 'זיכויים',
        columns: [
          { header: 'ספק', key: 'supplier', width: 24 },
          { header: 'סיבה', key: 'reason', width: 16 },
          { header: 'סכום', key: 'amount', width: 14, type: 'money' },
          { header: 'סטטוס', key: 'status', width: 14 },
        ],
        rows: data.credits.map((row) => ({
          supplier: row.supplier.name,
          reason: input.labels.creditReason[row.reason],
          amount: row.amount,
          status: input.labels.creditStatus[row.status]?.label,
        })),
      },
      {
        name: 'חריגים פתוחים כרגע',
        columns: [
          { header: 'סוג', key: 'type', width: 16 },
          { header: 'תיאור', key: 'title', width: 40 },
          { header: 'ספק', key: 'supplier', width: 24 },
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
}): WorkbookSpec {
  const base = buildMonthlyWorkbook(input);

  const { data, summary } = input;
  const definition = exportDefinition('accountant_monthly_report');
  const commonKeys = new Set(['org_name', 'period_label', 'period_from', 'period_to', 'generated_at']);
  const moneyKeys = new Set(['net_total', 'vat_total', 'gross_total', 'credits_recognized', 'net_expense']);
  // A missing value stays an empty cell — never 0 (constitution: אפס הוא גם טענה על המציאות).
  const fieldRows: WorkbookMatrixRow[] = (definition?.fields ?? [])
    .filter((field) => !commonKeys.has(field.key))
    .map((field) => pair(field.label, summary[field.key] ?? null, moneyKeys.has(field.key) ? 'money' : 'number'));

  const summarySheet: WorkbookMatrixSheet = {
    name: 'פרטי הדוח',
    widths: [28, 20, 16],
    matrix: [
      { cells: ['נתון', 'ערך'], header: true },
      ...fieldRows,
      { cells: [] },
      { cells: ['מדד', 'מספר רשומות'], header: true },
      { cells: ['חשבוניות', data.invoices.length], types: [undefined, 'number'] },
      { cells: ['תשלומים', data.payments.length], types: [undefined, 'number'] },
      { cells: ['זיכויים', data.credits.length], types: [undefined, 'number'] },
      { cells: ['חריגים פתוחים כרגע', data.exceptions.length], types: [undefined, 'number'] },
      { cells: [] },
      pair('הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'),
    ],
  };

  // The data sheets are already described by the base builder; only the summary sheet is replaced.
  return {
    title: base.title,
    subtitle: `${summary.period_label ?? input.month} · ${summary.period_from ?? ''}–${summary.period_to ?? ''} · הופק ${summary.generated_at ?? fmtDateTime(input.generatedAt.toISOString())}`,
    sheets: base.sheets.map((sheet) => sheet.name === 'פרטי הדוח' ? summarySheet : sheet),
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
  snapshot: MonthlyReportSnapshot;
}): WorkbookSpec {
  const { snapshot } = input;
  // v2 stores every row label beside the raw enum. Older local v1 artifacts remain readable
  // without consulting today's label maps: their frozen raw value is the conservative fallback.
  const frozenLabels: MonthlyReportLabels = {
    invoiceReview: Object.fromEntries(snapshot.invoice_rows.map((row) => [
      row.review_status, { label: row.review_status_label ?? row.review_status },
    ])),
    invoicePayment: Object.fromEntries(snapshot.invoice_rows.map((row) => [
      row.payment_status, { label: row.payment_status_label ?? row.payment_status },
    ])),
    creditReason: Object.fromEntries(snapshot.credit_rows.map((row) => [
      row.reason, row.reason_label ?? row.reason,
    ])),
    creditStatus: Object.fromEntries(snapshot.credit_rows.map((row) => [
      row.status, { label: row.status_label ?? row.status },
    ])),
    exceptionType: Object.fromEntries(snapshot.exception_rows.map((row) => [
      row.type, row.type_label ?? row.type,
    ])),
  };
  const base = buildMonthlyWorkbook({
    orgName: snapshot.organization_name,
    month: snapshot.report_month.slice(0, 7),
    generatedAt: new Date(snapshot.created_at),
    data: {
      invoices: snapshot.invoice_rows,
      payments: snapshot.payment_rows,
      credits: snapshot.credit_rows,
      exceptions: snapshot.exception_rows,
    },
    labels: frozenLabels,
  });

  const number: readonly (WorkbookCellType | undefined)[] = [undefined, 'number', 'money'];
  const summarySheet: WorkbookMatrixSheet = {
    name: 'פרטי הדוח',
    widths: [30, 34, 16],
    matrix: [
      pair('סוג הדוח', 'דוח סופי נעול'),
      pair('שם ארגון', snapshot.organization_name),
      pair('ישות משפטית', snapshot.legal_entity_name),
      pair('חודש', snapshot.report_month.slice(0, 7)),
      pair('גרסת snapshot', snapshot.version, 'number'),
      pair('גרסת מבנה הדוח', snapshot.report_version),
      pair('נוצר בתאריך', snapshot.created_at, 'date'),
      pair('נוצר על ידי', snapshot.created_by_name),
      pair('Snapshot ID', snapshot.id),
      pair('Checksum', snapshot.content_hash),
      pair('הערה', 'דוח סופי זה נוצר רק מנתוני snapshot נעולים במסד הנתונים ומשקף את גבול הדוח החי במועד היצירה.'),
      { cells: [] },
      { cells: ['מדד', 'מספר רשומות', 'סכום'], header: true },
      { cells: ['חשבוניות', snapshot.totals.invoice_count, snapshot.totals.invoice_total], types: number },
      { cells: ['לפני מע״מ', snapshot.totals.invoice_count, snapshot.totals.before_vat_total], types: number },
      { cells: ['מע״מ', snapshot.totals.invoice_count, snapshot.totals.vat_total], types: number },
      { cells: ['תשלומים', snapshot.totals.payment_count, snapshot.totals.payment_total], types: number },
      { cells: ['זיכויים', snapshot.totals.credit_count, snapshot.totals.credit_total], types: number },
      { cells: ['חריגים פתוחים בעת היצירה', snapshot.totals.exception_count, null], types: number },
      { cells: ['תנועות בנק', snapshot.totals.bank_transaction_count, snapshot.totals.bank_total], types: number },
    ],
  };

  return {
    title: `דוח סופי נעול — ${snapshot.organization_name} · ${snapshot.legal_entity_name}`,
    subtitle: `${snapshot.report_month.slice(0, 7)} · גרסה ${snapshot.version} · נוצר ${fmtDateTime(snapshot.created_at)}`,
    sheets: [
      ...base.sheets.map((sheet) => sheet.name === 'פרטי הדוח' ? summarySheet : sheet),
      {
        name: 'תנועות בנק',
        columns: [
          { header: 'תאריך', key: 'date', width: 12, type: 'date' },
          { header: 'תיאור', key: 'description', width: 40 },
          { header: 'סכום', key: 'amount', width: 14, type: 'money' },
          { header: 'סוג', key: 'direction', width: 10 },
          { header: 'אסמכתא', key: 'reference', width: 18 },
          { header: 'סטטוס', key: 'status', width: 14 },
        ],
        rows: snapshot.bank_rows.map((row) => ({
          date: row.tx_date,
          description: row.description,
          amount: row.amount,
          direction: row.direction_label ?? (row.is_debit ? 'debit' : 'credit'),
          reference: row.reference,
          status: row.status_label ?? row.status,
        })),
      },
    ],
  };
}
