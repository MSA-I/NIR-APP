/**
 * Self-check for the alert counting rules. No framework — `node` runs this file directly.
 *   npm run check:alerts
 *
 * It exists because both rules are money-adjacent and both have a suppression that is easy
 * to delete by accident: single-supplier products must not be reported as above average, and
 * a duplicate is a repeated key, not a repeated row.
 */
import assert from 'node:assert/strict';
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

console.log('alert rules: all checks passed');
