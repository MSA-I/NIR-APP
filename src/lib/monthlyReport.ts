import * as XLSX from 'xlsx';
import { neutralizeSpreadsheetRow, neutralizeSpreadsheetString } from './documentExport';
import { exportDefinition } from './exportTemplates';
import type { ReportTemplateValues } from './reportTemplateExport';

const neutralize = neutralizeSpreadsheetString;

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

export function buildMonthlyWorkbook(input: {
  orgName: string | null | undefined;
  month: string;
  generatedAt: Date;
  data: MonthlyReportData;
  labels: MonthlyReportLabels;
}) {
  const { data } = input;
  const invoiceTotal = data.invoices.reduce((sum, row) => sum + row.total_amount, 0);
  const beforeVatTotal = data.invoices.reduce((sum, row) => sum + row.amount_before_vat, 0);
  const vatTotal = data.invoices.reduce((sum, row) => sum + row.vat_amount, 0);
  const paymentTotal = data.payments.reduce((sum, row) => sum + row.amount, 0);
  const creditTotal = data.credits.reduce((sum, row) => sum + row.amount, 0);
  const workbook = XLSX.utils.book_new();

  // Everything below that is not a number goes through neutralizeSpreadsheetRow. This workbook
  // LEAVES THE BUILDING — it is the file the accountant opens — and it carries supplier names,
  // exception titles, payment references and payment methods straight from tenant data. A value
  // starting `=` or `@` is a formula to Excel regardless of what we meant by it, and until now
  // this file neutralized nothing while documentExport.ts, which never leaves the app, did.
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['שם ארגון', neutralize(input.orgName ?? '—')],
    ['חודש', input.month],
    ['נוצר בתאריך', input.generatedAt.toISOString()],
    ['הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'],
    [],
    ['מדד', 'מספר רשומות', 'סכום'],
    ['חשבוניות', data.invoices.length, invoiceTotal],
    ['לפני מע״מ', data.invoices.length, beforeVatTotal],
    ['מע״מ', data.invoices.length, vatTotal],
    ['תשלומים', data.payments.length, paymentTotal],
    ['זיכויים', data.credits.length, creditTotal],
    ['חריגים פתוחים כרגע', data.exceptions.length, null],
  ]), 'פרטי הדוח');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.invoices.map((row) => neutralizeSpreadsheetRow({
    'ספק': row.supplier.name, 'מספר חשבונית': row.invoice_number, 'תאריך': row.invoice_date,
    'לפני מע"מ': row.amount_before_vat, 'מע"מ': row.vat_amount, 'סה"כ': row.total_amount,
    'סטטוס בדיקה': input.labels.invoiceReview[row.review_status]?.label,
    'סטטוס תשלום': input.labels.invoicePayment[row.payment_status]?.label,
  }))), 'חשבוניות');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.payments.map((row) => neutralizeSpreadsheetRow({
    'ספק': row.supplier.name, 'תאריך': row.paid_date, 'סכום': row.amount, 'אמצעי': row.method, 'אסמכתא': row.reference,
  }))), 'תשלומים');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.credits.map((row) => neutralizeSpreadsheetRow({
    'ספק': row.supplier.name, 'סיבה': input.labels.creditReason[row.reason], 'סכום': row.amount, 'סטטוס': input.labels.creditStatus[row.status]?.label,
  }))), 'זיכויים');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.exceptions.map((row) => neutralizeSpreadsheetRow({
    'סוג': input.labels.exceptionType[row.type], 'תיאור': row.title, 'ספק': row.supplier?.name ?? '',
  }))), 'חריגים פתוחים כרגע');
  return workbook;
}

const MONEY_FORMAT = '#,##0.00';

/** Column widths + a money number-format pass — the styling SheetJS CE writes reliably. */
function styleSheet(sheet: XLSX.WorkSheet | undefined, widths: number[], moneyCols: number[]) {
  if (!sheet) return;
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = range.s.r + 1; row <= range.e.r; row++) {
    for (const col of moneyCols) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell && cell.t === 'n') cell.z = MONEY_FORMAT;
    }
  }
}

/**
 * The BUILT-IN styled default for the monthly accountant report (owner decision 18.08.2026):
 * used when no custom template is configured, replacing the bare fallback workbook.
 *
 * Styled IN CODE, not from a template file, on purpose. A shipped .xlsx asset would rest on
 * SheetJS CE preserving cell styles through a read→write round trip — exactly the unproven debt
 * DEBT-REGISTER §37 tracks. This builder uses only what CE writes reliably: RTL views (the
 * documentExport.ts:242 recipe), merges, column widths and number formats. The summary sheet
 * presents the same figures a custom template maps, labeled from the EXPORT_DEFINITIONS
 * registry, so both paths speak one vocabulary.
 *
 * The locked snapshot (buildLockedMonthlyWorkbook) deliberately does NOT use this: a version is
 * an evidence artifact, and re-downloading version N must produce the workbook the accountant
 * already archived — restyling it would make identical versions visibly differ.
 */
export function buildStyledMonthlyWorkbook(input: Parameters<typeof buildMonthlyWorkbook>[0] & {
  summary: ReportTemplateValues;
}): XLSX.WorkBook {
  const workbook = buildMonthlyWorkbook(input);
  workbook.Workbook = { Views: [{ RTL: true }] };

  const { data, summary } = input;
  const definition = exportDefinition('accountant_monthly_report');
  const commonKeys = new Set(['org_name', 'period_label', 'period_from', 'period_to', 'generated_at']);
  const moneyKeys = new Set(['net_total', 'vat_total', 'gross_total', 'credits_recognized', 'net_expense']);
  // A missing value stays an empty cell — never 0 (constitution: אפס הוא גם טענה על המציאות).
  const fieldRows = (definition?.fields ?? [])
    .filter((field) => !commonKeys.has(field.key))
    .map((field) => [field.label, summary[field.key] ?? null]);

  const sheet = XLSX.utils.aoa_to_sheet([
    [`דוח חודשי לרו״ח — ${neutralize(input.orgName ?? '—')}`],
    [`${summary.period_label ?? input.month} · ${summary.period_from ?? ''}–${summary.period_to ?? ''} · הופק ${summary.generated_at ?? input.generatedAt.toISOString()}`],
    [],
    ['נתון', 'ערך'],
    ...fieldRows,
    [],
    ['מדד', 'מספר רשומות'],
    ['חשבוניות', data.invoices.length],
    ['תשלומים', data.payments.length],
    ['זיכויים', data.credits.length],
    ['חריגים פתוחים כרגע', data.exceptions.length],
    [],
    ['הערה', 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.'],
  ]);
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },
  ];
  sheet['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 16 }];
  fieldRows.forEach(([label], index) => {
    const field = definition?.fields.find((candidate) => candidate.label === label);
    if (!field || !moneyKeys.has(field.key)) return;
    const cell = sheet[XLSX.utils.encode_cell({ r: 4 + index, c: 1 })];
    if (cell && cell.t === 'n') cell.z = MONEY_FORMAT;
  });
  workbook.Sheets['פרטי הדוח'] = sheet;

  styleSheet(workbook.Sheets['חשבוניות'], [24, 16, 12, 14, 12, 14, 14, 14], [3, 4, 5]);
  styleSheet(workbook.Sheets['תשלומים'], [24, 12, 14, 14, 18], [2]);
  styleSheet(workbook.Sheets['זיכויים'], [24, 16, 14, 14], [2]);
  styleSheet(workbook.Sheets['חריגים פתוחים כרגע'], [16, 40, 24], []);
  return workbook;
}

/**
 * Build an accountant workbook exclusively from an immutable database snapshot.
 *
 * No live query result, external link or formula is consulted here. Re-downloading a version
 * therefore produces equivalent workbook values even when the operational tables later change.
 */
export function buildLockedMonthlyWorkbook(input: {
  snapshot: MonthlyReportSnapshot;
}) {
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
  const workbook = buildMonthlyWorkbook({
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

  workbook.Sheets['פרטי הדוח'] = XLSX.utils.aoa_to_sheet([
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
    ['מדד', 'מספר רשומות', 'סכום'],
    ['חשבוניות', snapshot.totals.invoice_count, snapshot.totals.invoice_total],
    ['לפני מע״מ', snapshot.totals.invoice_count, snapshot.totals.before_vat_total],
    ['מע״מ', snapshot.totals.invoice_count, snapshot.totals.vat_total],
    ['תשלומים', snapshot.totals.payment_count, snapshot.totals.payment_total],
    ['זיכויים', snapshot.totals.credit_count, snapshot.totals.credit_total],
    ['חריגים פתוחים בעת היצירה', snapshot.totals.exception_count, null],
    ['תנועות בנק', snapshot.totals.bank_transaction_count, snapshot.totals.bank_total],
  ]);

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(snapshot.bank_rows.map((row) => neutralizeSpreadsheetRow({
    'תאריך': row.tx_date,
    'תיאור': row.description,
    'סכום': row.amount,
    'סוג': row.direction_label ?? (row.is_debit ? 'debit' : 'credit'),
    'אסמכתא': row.reference,
    'סטטוס': row.status_label ?? row.status,
  }))), 'תנועות בנק');

  return workbook;
}
