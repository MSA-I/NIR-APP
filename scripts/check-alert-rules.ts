/**
 * Self-check for the alert counting rules. No framework — `node` runs this file directly.
 *   npm run check:alerts
 *
 * It exists because both rules are money-adjacent and both have a suppression that is easy
 * to delete by accident: single-supplier products must not be reported as above average, and
 * a duplicate is a repeated key, not a repeated row.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countDuplicateKeys, countAboveAverage } from '../src/lib/alertRules.ts';

/* ---- countDuplicateKeys ---- */

assert.equal(countDuplicateKeys([]), 0, 'empty input finds nothing');

assert.equal(countDuplicateKeys([
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'a', invoice_number: '2' },
]), 0, 'same supplier, different numbers is not a duplicate');

assert.equal(countDuplicateKeys([
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'b', invoice_number: '1' },
]), 0, 'same number from different suppliers is not a duplicate');

assert.equal(countDuplicateKeys([
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'a', invoice_number: '1' },
]), 1, 'a repeated pair counts once, not twice');

assert.equal(countDuplicateKeys([
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'a', invoice_number: '1' },
]), 1, 'three copies are still one duplicated number');

assert.equal(countDuplicateKeys([
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'a', invoice_number: '1' },
  { supplier_id: 'b', invoice_number: '9' },
  { supplier_id: 'b', invoice_number: '9' },
]), 2, 'two distinct duplicated keys');

/* ---- countAboveAverage ---- */

assert.equal(countAboveAverage([], 0.15), 0, 'empty input finds nothing');

assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 100 },
], 0.15), 0, 'a single supplier is never above its own average');

assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 100 },
  { product_id: 'p', current_price: 100 },
], 0.15), 0, 'identical prices are not above average');

// avg = 100. 15% margin puts the bar at 115. Only 200 clears it.
assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 100 },
  { product_id: 'p', current_price: 200 },
  { product_id: 'p', current_price: 0 },
], 0.15), 1, 'only the offer past the margin is flagged');

// avg = 100, bar = 115. 110 is above average but inside the margin.
assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 90 },
  { product_id: 'p', current_price: 110 },
], 0.15), 0, 'above average but within the margin is not flagged');

assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 0 },
  { product_id: 'p', current_price: 0 },
], 0.15), 0, 'a zero average is skipped, not divided by');

assert.equal(countAboveAverage([
  { product_id: 'p', current_price: 100 },
  { product_id: 'p', current_price: 200 },
  { product_id: 'q', current_price: 50 },
  { product_id: 'q', current_price: 500 },
], 0.15), 2, 'products are averaged independently');

/* ---- actionable links and P2 context ---- */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const alertsSource = source('../src/lib/alerts.ts');
const invoicesSource = source('../src/pages/Invoices.tsx');
const paymentsSource = source('../src/pages/PaymentRequests.tsx');
const exceptionsSource = source('../src/pages/Exceptions.tsx');
const bankSource = source('../src/pages/Bank.tsx');
const receivingSource = source('../src/pages/Receiving.tsx');

assert.match(alertsSource, /\/invoices\?attention=duplicates/, 'duplicate alert keeps its invoice filter');
assert.match(alertsSource, /\/invoices\?attention=without-order/, 'unlinked-invoice alert keeps its invoice filter');
assert.match(alertsSource, /\/payment-requests\?status=active&due=soon/, 'due alert keeps its treatment window');
assert.match(alertsSource, /\/prices\?increases=1/, 'price-rise alert keeps its price filter');
assert.match(invoicesSource, /attentionFilter === 'duplicates'/, 'invoice duplicate target consumes its filter');
assert.match(paymentsSource, /dueFilter === 'soon'/, 'payment target consumes the due-soon filter');
assert.match(exceptionsSource, /\/payment-requests\?id=\$\{row\.payment_request_id\}/, 'exception links to its payment request');
assert.match(exceptionsSource, /\/bank\?id=\$\{row\.bank_transaction_id\}/, 'exception links to its bank transaction');
assert.match(bankSource, /transaction\.id === idFilter/, 'bank target consumes a transaction id');
assert.doesNotMatch(exceptionsSource, /`\$\{k\}: /, 'exception metadata keys are not rendered raw');
assert.match(receivingSource, /דורש פעולה/, 'receiving keeps the focused queue');
assert.match(receivingSource, /הצג הכל/, 'receiving keeps mobile disclosure');
assert.match(receivingSource, /type="search"/, 'receiving keeps order search');
assert.doesNotMatch(receivingSource, /receiving-reason/, 'routine receiving does not ask for duplicate audit prose');

console.log('alert rules: all checks passed');
