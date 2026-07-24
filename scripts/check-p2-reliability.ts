import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addCalendarDays, currentMonthISO, daysInCalendarMonth, monthInstantRange, monthRange,
  shiftCalendarMonth, startOfCalendarWeek, toTimeZoneISO,
} from '../src/lib/format.ts';
import { fetchAll, fetchInChunks } from '../src/lib/supabasePaging.ts';
import { createRequestGate } from '../src/lib/requestGate.ts';
import { settleAlertScans } from '../src/lib/alertRules.ts';
import { invoiceCheckFingerprint, paymentRequestCheckFingerprint } from '../src/lib/checkFingerprint.ts';
import { openExternalPopup, openReservedPopup } from '../src/lib/popup.ts';
import { mergeUploadBatchSummary, runUploadBatch } from '../src/lib/uploadBatch.ts';
import { buildMonthlyWorkbook } from '../src/lib/monthlyReport.ts';
import * as XLSX from 'xlsx';
import { readExactCount } from '../src/lib/queryResult.ts';

if (process.argv.includes('--timezone-probe')) {
  process.stdout.write(JSON.stringify({
    july: monthRange('2026-07'),
    december: monthRange('2026-12'),
    leap: monthRange('2024-02'),
    regular: monthRange('2025-02'),
  }));
  process.exit(0);
}

assert.deepEqual(monthRange('2026-07'), { start: '2026-07-01', end: '2026-08-01' });
assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-03-01' });
assert.deepEqual(monthRange('2025-02'), { start: '2025-02-01', end: '2025-03-01' });
assert.equal(shiftCalendarMonth('2026-01', -1), '2025-12');
assert.equal(shiftCalendarMonth('2026-12', 1), '2027-01');
assert.equal(daysInCalendarMonth('2024-02'), 29);
assert.equal(daysInCalendarMonth('2025-02'), 28);
assert.equal(startOfCalendarWeek('2026-07-22'), '2026-07-19');
assert.throws(() => monthRange('2026-13'));
assert.throws(() => monthRange('26-07'));
assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
assert.equal(addCalendarDays('2025-02-28', 1), '2025-03-01');
assert.equal(addCalendarDays('2026-07-31', 1), '2026-08-01');
assert.deepEqual(monthInstantRange('2026-07'), {
  start: '2026-06-30T21:00:00.000Z', end: '2026-07-31T21:00:00.000Z',
});
assert.deepEqual(monthInstantRange('2026-12'), {
  start: '2026-11-30T22:00:00.000Z', end: '2026-12-31T22:00:00.000Z',
});
assert.equal(toTimeZoneISO(new Date('2026-06-30T20:59:59.999Z')), '2026-06-30');
assert.equal(toTimeZoneISO(new Date('2026-06-30T21:00:00.000Z')), '2026-07-01');
assert.equal(currentMonthISO(new Date('2026-06-30T21:00:00.000Z')), '2026-07');

const script = fileURLToPath(import.meta.url);
const probe = (tz: string) => spawnSync(process.execPath, [script, '--timezone-probe'], {
  encoding: 'utf8', env: { ...process.env, TZ: tz },
});
const jerusalem = probe('Asia/Jerusalem');
const losAngeles = probe('America/Los_Angeles');
assert.equal(jerusalem.status, 0, jerusalem.stderr);
assert.equal(losAngeles.status, 0, losAngeles.stderr);
assert.equal(jerusalem.stdout, losAngeles.stdout, 'month boundaries must not depend on machine TZ');

const gate = createRequestGate();
gate.mount();
const older = gate.begin();
const newer = gate.begin();
assert.equal(gate.isCurrent(older), false);
assert.equal(gate.isCurrent(newer), true);
gate.invalidate();
assert.equal(gate.isCurrent(newer), false);
const beforeUnmount = gate.begin();
gate.unmount();
assert.equal(gate.isCurrent(beforeUnmount), false);

const source = Array.from({ length: 1501 }, (_, id) => id);
const fetched = await fetchAll(async (from, to) => ({ data: source.slice(from, to + 1), error: null }), 500);
assert.deepEqual(fetched, source, 'pagination must keep every row exactly once');
const chunkSizes: number[] = [];
const chunked = await fetchInChunks(source.slice(0, 351).map(String), async (ids) => {
  chunkSizes.push(ids.length);
  return ids;
}, 150);
assert.deepEqual(chunkSizes, [150, 150, 51]);
assert.deepEqual(chunked, source.slice(0, 351).map(String));

const scaleInvoices = Array.from({ length: 1501 }, (_, index) => ({
  supplier: { name: `ספק ${index}` }, invoice_number: String(index + 1), invoice_date: '2026-07-22',
  amount_before_vat: 100, vat_amount: 18, total_amount: 118,
  review_status: 'received', payment_status: 'unpaid',
}));
const reportWorkbook = buildMonthlyWorkbook({
  orgName: 'ארגון בדיקה', month: '2026-07', generatedAt: new Date('2026-07-22T10:00:00.000Z'),
  data: { invoices: scaleInvoices, payments: [], credits: [], exceptions: [] },
  labels: {
    invoiceReview: { received: { label: 'נקלטה' } },
    invoicePayment: { unpaid: { label: 'לא שולמה' } },
    creditReason: {}, creditStatus: {}, exceptionType: {},
  },
});
const reportBytes = XLSX.write(reportWorkbook, { type: 'buffer', bookType: 'xlsx' });
const reopenedReport = XLSX.read(reportBytes, { type: 'buffer' });
const invoiceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(reopenedReport.Sheets['חשבוניות']);
assert.equal(invoiceRows.length, 1501, 'XLSX must retain every row above the PostgREST cap');
assert.equal(invoiceRows.reduce((sum, row) => sum + Number(row['סה"כ']), 0), 1501 * 118);
const reportMeta = XLSX.utils.sheet_to_json<unknown[]>(reopenedReport.Sheets['פרטי הדוח'], { header: 1 });
assert.deepEqual(reportMeta[0], ['שם ארגון', 'ארגון בדיקה']);

const invoiceFingerprint = invoiceCheckFingerprint({
  supplierId: 'supplier-a', invoiceNumber: ' 42 ', invoiceDate: '2026-07-22', totalAmount: 100,
  linkedOrderIds: ['order-b', 'order-a'],
});
assert.equal(invoiceFingerprint, invoiceCheckFingerprint({
  supplierId: 'supplier-a', invoiceNumber: '42', invoiceDate: '2026-07-22', totalAmount: 100,
  linkedOrderIds: ['order-a', 'order-b'],
}));
assert.notEqual(invoiceFingerprint, invoiceCheckFingerprint({
  supplierId: 'supplier-a', invoiceNumber: '43', invoiceDate: '2026-07-22', totalAmount: 100,
  linkedOrderIds: ['order-a', 'order-b'],
}));
assert.equal(
  paymentRequestCheckFingerprint({ supplierId: 'supplier-a', amount: 100, invoiceIds: ['b', 'a'] }),
  paymentRequestCheckFingerprint({ supplierId: 'supplier-a', amount: 100, invoiceIds: ['a', 'b'] }),
);

let signedUrlRequested = false;
assert.equal(await openReservedPopup(async () => {
  signedUrlRequested = true;
  return 'https://example.test/document';
}, () => null), 'blocked');
assert.equal(signedUrlRequested, false, 'a blocked popup must not make a signed-url request');
let closed = false;
const failedViewer = {
  opener: {} as unknown, closed: false, close: () => { closed = true; }, location: { replace: () => undefined },
};
assert.equal(await openReservedPopup(async () => { throw new Error('network'); }, () => failedViewer), 'error');
assert.equal(closed, true, 'a signed-url failure must close the placeholder');
let replacedWith = '';
const openedViewer = {
  opener: {} as unknown, closed: false, close: () => undefined, location: { replace: (url: string) => { replacedWith = url; } },
};
assert.equal(await openReservedPopup(async () => 'https://example.test/document', () => openedViewer), 'opened');
assert.equal(openedViewer.opener, null);
assert.equal(replacedWith, 'https://example.test/document');
assert.equal(openExternalPopup('https://wa.me/972', () => null), 'blocked');
assert.equal(await readExactCount(Promise.resolve({ count: 0, error: null })), 0);
await assert.rejects(readExactCount(Promise.resolve({ count: null, error: { message: 'network' } })), /network/);
await assert.rejects(readExactCount(Promise.resolve({ count: null, error: null })), /count_unavailable/);

const firstUpload = await runUploadBatch(['first.pdf', 'second.pdf'], async (name) => {
  if (name === 'second.pdf') throw new Error('network');
});
assert.deepEqual(firstUpload.succeeded, ['first.pdf']);
assert.deepEqual(firstUpload.failed.map(({ item }) => item), ['second.pdf']);
const retryUpload = await runUploadBatch(firstUpload.failed.map(({ item }) => item), async () => undefined);
assert.deepEqual(retryUpload.succeeded, ['second.pdf']);
assert.equal(retryUpload.failed.length, 0);
const firstUploadSummary = mergeUploadBatchSummary(null, firstUpload, String);
assert.deepEqual(firstUploadSummary, { succeeded: ['first.pdf'], failed: ['second.pdf'] });
assert.deepEqual(mergeUploadBatchSummary(firstUploadSummary, retryUpload, String), {
  succeeded: ['first.pdf', 'second.pdf'], failed: [],
});

const alert = { code: 'found' };
const scan = await settleAlertScans([
  { code: 'found', label: 'found', run: async () => alert },
  { code: 'empty', label: 'empty', run: async () => null },
  { code: 'failed', label: 'failed', run: async () => { throw new Error('private detail'); } },
]);
assert.deepEqual(scan.alerts, [alert]);
assert.equal(scan.complete, false);
assert.deepEqual(scan.failures, [{ code: 'failed', label: 'failed' }]);

console.log('P2 reliability checks passed');
