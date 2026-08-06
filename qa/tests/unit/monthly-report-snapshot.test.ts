import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  buildLockedMonthlyWorkbook,
  buildMonthlyWorkbook,
  type MonthlyReportLabels,
  type MonthlyReportSnapshot,
} from '../../../src/lib/monthlyReport.ts';

const labels: MonthlyReportLabels = {
  invoiceReview: { approved: { label: 'מאושרת' } },
  invoicePayment: { unpaid: { label: 'טרם שולמה' } },
  creditReason: { wrong_price: 'מחיר שגוי' },
  creditStatus: { open: { label: 'פתוח' } },
  exceptionType: { amount_mismatch: 'פער בסכום' },
};

const snapshot: MonthlyReportSnapshot = {
  id: '10000000-0000-0000-0000-000000000001',
  org_id: '30000000-0000-0000-0000-000000000001',
  unit_id: '40000000-0000-0000-0000-000000000001',
  report_month: '2026-08-01',
  version: 2,
  report_version: 'monthly-accountant-legal-entity-v2',
  organization_name: 'עסק בדיקה',
  legal_entity_name: 'ישות משפטית ירושלים',
  created_by: '20000000-0000-0000-0000-000000000001',
  created_by_name: 'רואה חשבון בדיקה',
  created_at: '2026-08-05T09:10:11.000Z',
  invoice_rows: [{
    supplier: { name: 'ספק נעול' }, invoice_number: 'INV-10', invoice_date: '2026-08-02',
    amount_before_vat: 100, vat_amount: 18, total_amount: 118,
    review_status: 'approved', review_status_label: 'תווית בדיקה נעולה',
    payment_status: 'unpaid', payment_status_label: 'תווית תשלום נעולה',
  }],
  payment_rows: [{
    supplier: { name: 'ספק נעול' }, paid_date: '2026-08-03', amount: 40,
    method: 'העברה בנקאית', reference: 'REF-1',
  }],
  credit_rows: [{
    supplier: { name: 'ספק נעול' }, reason: 'wrong_price', reason_label: 'סיבת זיכוי נעולה',
    amount: 10, status: 'open', status_label: 'סטטוס זיכוי נעול',
  }],
  exception_rows: [{
    type: 'amount_mismatch', type_label: 'סוג חריגה נעול', title: '=NOW()', supplier: { name: 'ספק נעול' },
  }],
  bank_rows: [{
    id: '50000000-0000-0000-0000-000000000001', tx_date: '2026-08-04',
    description: '=HYPERLINK("https://invalid.example")', amount: 40, is_debit: true,
    reference: 'BANK-1', status: 'matched', direction_label: 'כיוון נעול', status_label: 'סטטוס בנק נעול',
  }],
  totals: {
    invoice_count: 1, invoice_total: 118, before_vat_total: 100, vat_total: 18,
    payment_count: 1, payment_total: 40, credit_count: 1, credit_total: 10,
    exception_count: 1, bank_transaction_count: 1, bank_total: 40,
    unpaid_invoice_count: 1,
  },
  content_hash: 'a'.repeat(64),
};

function workbookValues(workbook: XLSX.WorkBook) {
  return Object.fromEntries(workbook.SheetNames.map((name) => [
    name,
    XLSX.utils.sheet_to_json(workbook.Sheets[name]!, { header: 1, raw: true }),
  ]));
}

test('live monthly workbook remains explicitly live and best-effort', () => {
  const workbook = buildMonthlyWorkbook({
    orgName: 'עסק בדיקה',
    month: '2026-08',
    generatedAt: new Date('2026-08-05T09:10:11.000Z'),
    data: { invoices: [], payments: [], credits: [], exceptions: [] },
    labels,
  });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['פרטי הדוח']!, { header: 1 });
  assert.equal(rows[3]?.[1], 'הקובץ משקף את הנתונים שהושלמו בזמן המצוין; הוא אינו snapshot טרנזקציוני.');
});

test('locked workbook uses only stored rows/totals and carries legal-entity metadata', () => {
  const bytes = XLSX.write(buildLockedMonthlyWorkbook({ snapshot }), {
    type: 'buffer', bookType: 'xlsx',
  });
  const reopened = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
  const summary = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['פרטי הדוח']!, { header: 1 });
  const invoices = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopened.Sheets['חשבוניות']!);
  const credits = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopened.Sheets['זיכויים']!);
  const exceptions = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopened.Sheets['חריגים פתוחים כרגע']!);
  const bank = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopened.Sheets['תנועות בנק']!);

  assert.equal(summary[0]?.[1], 'דוח סופי נעול');
  assert.equal(summary[2]?.[1], snapshot.legal_entity_name);
  assert.equal(summary[4]?.[1], snapshot.version);
  assert.equal(summary[5]?.[1], snapshot.report_version);
  assert.equal(summary[6]?.[1], snapshot.created_at);
  assert.equal(summary[7]?.[1], snapshot.created_by_name);
  assert.equal(summary[9]?.[1], snapshot.content_hash);
  assert.equal(summary[13]?.[2], snapshot.totals.invoice_total);
  assert.equal(summary[16]?.[2], snapshot.totals.payment_total);
  assert.equal(summary[19]?.[2], snapshot.totals.bank_total);
  assert.equal(invoices[0]?.['ספק'], 'ספק נעול');
  assert.equal(invoices[0]?.['סה"כ'], 118);
  assert.equal(invoices[0]?.['סטטוס בדיקה'], 'תווית בדיקה נעולה');
  assert.equal(invoices[0]?.['סטטוס תשלום'], 'תווית תשלום נעולה');
  assert.equal(credits[0]?.['סיבה'], 'סיבת זיכוי נעולה');
  assert.equal(credits[0]?.['סטטוס'], 'סטטוס זיכוי נעול');
  assert.equal(exceptions[0]?.['סוג'], 'סוג חריגה נעול');
  assert.equal(bank[0]?.['אסמכתא'], 'BANK-1');
  assert.equal(bank[0]?.['סוג'], 'כיוון נעול');
  assert.equal(bank[0]?.['סטטוס'], 'סטטוס בנק נעול');
});

test('re-downloading one snapshot is equivalent and no workbook sheet contains a formula', () => {
  const first = buildLockedMonthlyWorkbook({ snapshot });
  const second = buildLockedMonthlyWorkbook({ snapshot: structuredClone(snapshot) });
  assert.deepEqual(workbookValues(second), workbookValues(first));

  for (const [sheetName, sheet] of Object.entries(first.Sheets)) {
    for (const [address, cell] of Object.entries(sheet)) {
      if (!address.startsWith('!') && cell && typeof cell === 'object' && 'f' in cell) {
        assert.fail(`snapshot export contains a formula at ${sheetName}!${address}`);
      }
    }
  }
});
