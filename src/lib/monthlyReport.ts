import * as XLSX from 'xlsx';

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
  invoice_rows: MonthlyReportData['invoices'];
  payment_rows: MonthlyReportData['payments'];
  credit_rows: MonthlyReportData['credits'];
  exception_rows: MonthlyReportData['exceptions'];
  bank_rows: {
    id: string;
    tx_date: string;
    description: string;
    amount: number;
    is_debit: boolean;
    reference: string | null;
    status: string;
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
    unmatched_bank_count: number;
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

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['שם ארגון', input.orgName ?? '—'],
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
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.invoices.map((row) => ({
    'ספק': row.supplier.name, 'מספר חשבונית': row.invoice_number, 'תאריך': row.invoice_date,
    'לפני מע"מ': row.amount_before_vat, 'מע"מ': row.vat_amount, 'סה"כ': row.total_amount,
    'סטטוס בדיקה': input.labels.invoiceReview[row.review_status]?.label,
    'סטטוס תשלום': input.labels.invoicePayment[row.payment_status]?.label,
  }))), 'חשבוניות');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.payments.map((row) => ({
    'ספק': row.supplier.name, 'תאריך': row.paid_date, 'סכום': row.amount, 'אמצעי': row.method, 'אסמכתא': row.reference,
  }))), 'תשלומים');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.credits.map((row) => ({
    'ספק': row.supplier.name, 'סיבה': input.labels.creditReason[row.reason], 'סכום': row.amount, 'סטטוס': input.labels.creditStatus[row.status]?.label,
  }))), 'זיכויים');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.exceptions.map((row) => ({
    'סוג': input.labels.exceptionType[row.type], 'תיאור': row.title, 'ספק': row.supplier?.name ?? '',
  }))), 'חריגים פתוחים כרגע');
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
  labels: MonthlyReportLabels;
}) {
  const { snapshot } = input;
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
    labels: input.labels,
  });

  workbook.Sheets['פרטי הדוח'] = XLSX.utils.aoa_to_sheet([
    ['סוג הדוח', 'דוח סופי נעול'],
    ['שם ארגון', snapshot.organization_name],
    ['ישות משפטית', snapshot.legal_entity_name],
    ['חודש', snapshot.report_month.slice(0, 7)],
    ['גרסת snapshot', snapshot.version],
    ['גרסת מבנה הדוח', snapshot.report_version],
    ['נוצר בתאריך', snapshot.created_at],
    ['נוצר על ידי', snapshot.created_by_name],
    ['Snapshot ID', snapshot.id],
    ['Checksum', snapshot.content_hash],
    ['הערה', 'דוח סופי זה נוצר רק מנתוני snapshot נעולים במסד הנתונים וכולל חשבוניות מאושרות בלבד.'],
    [],
    ['מדד', 'מספר רשומות', 'סכום'],
    ['חשבוניות', snapshot.totals.invoice_count, snapshot.totals.invoice_total],
    ['לפני מע״מ', snapshot.totals.invoice_count, snapshot.totals.before_vat_total],
    ['מע״מ', snapshot.totals.invoice_count, snapshot.totals.vat_total],
    ['תשלומים', snapshot.totals.payment_count, snapshot.totals.payment_total],
    ['זיכויים', snapshot.totals.credit_count, snapshot.totals.credit_total],
    ['חריגים פתוחים בעת היצירה', snapshot.totals.exception_count, null],
    ['תנועות בנק', snapshot.totals.bank_transaction_count, snapshot.totals.bank_total],
    ['תנועות בנק שדרשו תשומת לב', snapshot.totals.unmatched_bank_count, null],
  ]);

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(snapshot.bank_rows.map((row) => ({
    'תאריך': row.tx_date,
    'תיאור': row.description,
    'סכום': row.amount,
    'סוג': row.is_debit ? 'חיוב' : 'זיכוי',
    'אסמכתא': row.reference,
    'סטטוס': row.status,
  }))), 'תנועות בנק');

  return workbook;
}
