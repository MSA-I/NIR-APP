import * as XLSX from 'xlsx';

export interface MonthlyReportData {
  invoices: { supplier: { name: string }; invoice_number: string; invoice_date: string; amount_before_vat: number; vat_amount: number; total_amount: number; review_status: string; payment_status: string }[];
  payments: { supplier: { name: string }; paid_date: string; amount: number; method: string | null; reference: string | null }[];
  credits: { supplier: { name: string }; reason: string; amount: number; status: string }[];
  exceptions: { type: string; title: string; supplier: { name: string } | null }[];
}

export function buildMonthlyWorkbook(input: {
  orgName: string | null | undefined;
  month: string;
  generatedAt: Date;
  data: MonthlyReportData;
  labels: {
    invoiceReview: Record<string, { label: string } | undefined>;
    invoicePayment: Record<string, { label: string } | undefined>;
    creditReason: Record<string, string | undefined>;
    creditStatus: Record<string, { label: string } | undefined>;
    exceptionType: Record<string, string | undefined>;
  };
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
