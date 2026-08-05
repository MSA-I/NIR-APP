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
  report_month: '2026-08-01',
  version: 2,
  report_version: 'monthly-accountant-v1',
  organization_name: 'עסק בדיקה',
  created_by: '20000000-0000-0000-0000-000000000001',
  created_by_name: 'רואה חשבון בדיקה',
  created_at: '2026-08-05T09:10:11.000Z',
  invoice_rows: [{
    supplier: { name: 'ספק נעול' }, invoice_number: 'INV-10', invoice_date: '2026-08-02',
    amount_before_vat: 100, vat_amount: 18, total_amount: 118,
    review_status: 'approved', payment_status: 'unpaid',
  }],
  payment_rows: [{
    supplier: { name: 'ספק נעול' }, paid_date: '2026-08-03', amount: 40,
    method: 'העברה בנקאית', reference: 'REF-1',
  }],
  credit_rows: [{
    supplier: { name: 'ספק נעול' }, reason: 'wrong_price', amount: 10, status: 'open',
  }],
  exception_rows: [{
    type: 'amount_mismatch', title: '=NOW()', supplier: { name: 'ספק נעול' },
  }],
  bank_rows: [],
  totals: {
    invoice_count: 1, invoice_total: 118, before_vat_total: 100, vat_total: 18,
    payment_count: 1, payment_total: 40, credit_count: 1, credit_total: 10,
    exception_count: 1, unpaid_invoice_count: 1, unmatched_bank_count: 0,
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

test('locked workbook opens, uses stored rows and totals, and contains immutable metadata', () => {
  const bytes = XLSX.write(buildLockedMonthlyWorkbook({ snapshot, labels }), {
    type: 'buffer', bookType: 'xlsx',
  });
  const reopened = XLSX.read(bytes, { type: 'buffer' });
  const summary = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['פרטי הדוח']!, { header: 1 });
  const invoices = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopened.Sheets['חשבוניות']!);

  assert.equal(summary[0]?.[1], 'דוח סופי נעול');
  assert.equal(summary[3]?.[1], 2);
  assert.equal(summary[5]?.[1], snapshot.created_at);
  assert.equal(summary[6]?.[1], snapshot.created_by_name);
  assert.equal(summary[7]?.[1], snapshot.content_hash);
  assert.equal(summary[11]?.[2], snapshot.totals.invoice_total);
  assert.equal(summary[14]?.[2], snapshot.totals.payment_total);
  assert.equal(invoices[0]?.['ספק'], 'ספק נעול');
  assert.equal(invoices[0]?.['סה"כ'], 118);
});

test('re-downloading one snapshot produces equivalent, formula-free workbook content', () => {
  const first = buildLockedMonthlyWorkbook({ snapshot, labels });
  const second = buildLockedMonthlyWorkbook({ snapshot: structuredClone(snapshot), labels });
  assert.deepEqual(workbookValues(second), workbookValues(first));

  for (const sheet of Object.values(first.Sheets)) {
    for (const cell of Object.values(sheet)) {
      if (cell && typeof cell === 'object' && 'f' in cell) assert.fail('snapshot export contains a formula');
    }
  }
});
