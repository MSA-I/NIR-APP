#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = [
  'P4_API_URL',
  'P4_ANON_KEY',
  'P4_SERVICE_ROLE_KEY',
  'P4_PASSWORD_SEED',
  'P4_ARTIFACT_DIR',
];

for (const name of REQUIRED_ENV) {
  assert(process.env[name], `Missing required environment variable: ${name}`);
}

const API_URL = process.env.P4_API_URL;
const ANON_KEY = process.env.P4_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.P4_SERVICE_ROLE_KEY;
const PASSWORD_SEED = process.env.P4_PASSWORD_SEED;
const ARTIFACT_DIR = path.resolve(process.env.P4_ARTIFACT_DIR);
const ARTIFACT_SECRET_VALUES = new Set([ANON_KEY, SERVICE_ROLE_KEY, PASSWORD_SEED]);
const SENSITIVE_ARTIFACT_FIELDS = new Set([
  'access_token', 'refresh_token', 'password', 'password_seed', 'authorization',
  'service_role_key', 'anon_key', 'email', 'raw',
]);

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_ID = 'aa000000-0000-4000-8000-000000000001';
const PRODUCT_ID = 'bb000000-0000-4000-8000-000000000001';
const AMOUNTS = Object.freeze({ order: 300, vat: 54, invoice: 354, payment: 300, credit: 54 });
const ROLES = Object.freeze(['supplier', 'office', 'owner', 'accountant']);

const REASONS = Object.freeze({
  priceSubmission: 'P4 integrated supplier price submission',
  finalizeRequest: 'P4 integrated purchase request finalization',
  sendOrder: 'P4 integrated purchase order sent',
  completeReceipt: 'P4 integrated goods receipt completion',
  createInvoice: 'P4 integrated invoice creation',
  reviewInvoice: 'P4 integrated invoice review started',
  approveInvoice: 'P4 integrated invoice approval',
  createPaymentRequest: 'P4 integrated payment request creation',
  approvePaymentRequest: 'P4 integrated owner payment approval',
  executePayment: 'P4 integrated accountant payment execution',
  importBank: 'P4 integrated bank import',
  matchBank: 'P4 integrated bank match',
  unmatchBank: 'P4 integrated bank unmatch',
  rematchBank: 'P4 integrated bank rematch',
  createCredit: 'P4 integrated invoice credit creation',
  receiveCredit: 'P4 integrated credit received',
  offsetCredit: 'P4 integrated credit offset',
  closeCredit: 'P4 integrated credit closed',
});

function client(key) {
  return createClient(API_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function today(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function normalizedFieldName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[- ]/g, '_').toLowerCase();
}

function rememberArtifactSecret(value) {
  if (typeof value === 'string' && value) ARTIFACT_SECRET_VALUES.add(value);
}

function assertArtifactSafe(value, seen = new Set()) {
  if (typeof value === 'string') {
    for (const secret of ARTIFACT_SECRET_VALUES) {
      if (secret && value.includes(secret)) throw new Error('Artifact contains prohibited secret material');
    }
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
      throw new Error('Artifact contains prohibited secret material');
    }
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertArtifactSafe(item, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_ARTIFACT_FIELDS.has(normalizedFieldName(key))) {
      throw new Error('Artifact contains prohibited secret material');
    }
    assertArtifactSafe(child, seen);
  }
}

function writeArtifact(name, value) {
  assertArtifactSafe(value);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function dataOf(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function countOf(promise, label) {
  const { count, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  assert.notEqual(count, null, `${label}: missing exact count`);
  return count;
}

async function rpc(actor, name, args, label) {
  return dataOf(actor.rpc(name, args), label);
}

function assertMoney(actual, expected, label) {
  assert.equal(Number(actual), expected, label);
}

async function signIn(role) {
  const actor = client(ANON_KEY);
  const signedIn = await actor.auth.signInWithPassword({
    email: `${role}@demo.supplyflow.local`,
    password: `P4!${PASSWORD_SEED}-${role}-Aa7`,
  });
  if (signedIn.error) throw new Error(`Sign in ${role}: ${signedIn.error.message}`);
  assert(signedIn.data.session?.access_token, `Sign in ${role}: missing access token`);
  assert(signedIn.data.user?.id, `Sign in ${role}: missing user id`);
  rememberArtifactSecret(signedIn.data.session.access_token);
  rememberArtifactSecret(signedIn.data.session.refresh_token);
  return {
    client: actor,
    userId: signedIn.data.user.id,
    accessToken: signedIn.data.session.access_token,
  };
}

async function invokePriceList(accessToken, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${API_URL}/functions/v1/submit-price-list`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const transientWorkerRestart = response.status === 502
      && payload?.message === 'An invalid response was received from the upstream server';
    if (!transientWorkerRestart || attempt === 2) return { response, payload };
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('unreachable Edge retry state');
}

async function captureBefore(evidence, ids) {
  const [supplierProduct, submission, receipt, invoice, paymentRequest, creditRequest, counts] = await Promise.all([
    dataOf(evidence.from('supplier_products')
      .select('id,current_price,previous_price,price_effective_date,available')
      .eq('org_id', ORG_ID).eq('supplier_id', SUPPLIER_ID).eq('product_id', PRODUCT_ID).single(),
    'before supplier product'),
    dataOf(evidence.from('supplier_price_submissions').select('id').eq('id', ids.submission).maybeSingle(),
      'before submission'),
    dataOf(evidence.from('goods_receipts').select('id').eq('id', ids.receipt).maybeSingle(),
      'before receipt'),
    dataOf(evidence.from('invoices').select('id').eq('id', ids.invoice).maybeSingle(),
      'before invoice'),
    dataOf(evidence.from('payment_requests').select('id').eq('id', ids.paymentRequest).maybeSingle(),
      'before payment request'),
    dataOf(evidence.from('credit_requests').select('id').eq('id', ids.credit).maybeSingle(),
      'before credit'),
    Promise.all([
      countOf(evidence.from('purchase_requests').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before purchase request count'),
      countOf(evidence.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before purchase order count'),
      countOf(evidence.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before invoice count'),
      countOf(evidence.from('payments').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before payment count'),
      countOf(evidence.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before bank transaction count'),
      countOf(evidence.from('credit_requests').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID),
        'before credit count'),
    ]),
  ]);

  return {
    artifact_schema: 1,
    captured_at: new Date().toISOString(),
    supplier_product: supplierProduct,
    controlled_ids_absent: {
      submission: submission === null,
      receipt: receipt === null,
      invoice: invoice === null,
      payment_request: paymentRequest === null,
      credit_request: creditRequest === null,
    },
    tenant_counts: {
      purchase_requests: counts[0],
      purchase_orders: counts[1],
      invoices: counts[2],
      payments: counts[3],
      bank_transactions: counts[4],
      credit_requests: counts[5],
    },
  };
}

async function captureAfter(evidence, ids) {
  const queries = [
    evidence.from('supplier_products')
      .select('id,current_price,previous_price,price_effective_date,available')
      .eq('org_id', ORG_ID).eq('supplier_id', SUPPLIER_ID).eq('product_id', PRODUCT_ID).single(),
    evidence.from('supplier_price_submissions')
      .select('id,supplier_id,target_month,revision,file_checksum,status,accepted_count,rejected_count,unchanged_count')
      .eq('id', ids.submission).single(),
    evidence.from('purchase_requests').select('id,status,expected_date,editor_step').eq('id', ids.purchaseRequest).single(),
    evidence.from('purchase_orders').select('id,request_id,supplier_id,status,expected_date').eq('id', ids.order).single(),
    evidence.from('purchase_order_items').select('id,order_id,product_id,qty,unit_price,received_qty')
      .eq('id', ids.orderItem).single(),
    evidence.from('goods_receipts').select('id,order_id,status,received_at').eq('id', ids.receipt).single(),
    evidence.from('invoices')
      .select('id,supplier_id,invoice_number,amount_before_vat,vat_amount,total_amount,review_status,payment_status')
      .eq('id', ids.invoice).single(),
    evidence.from('invoice_balances').select('invoice_id,total_amount,paid_amount,credited_amount,balance')
      .eq('invoice_id', ids.invoice).single(),
    evidence.from('payment_requests').select('id,supplier_id,amount,status').eq('id', ids.paymentRequest).single(),
    evidence.from('payment_request_invoices').select('payment_request_id,invoice_id,amount_allocated')
      .eq('payment_request_id', ids.paymentRequest).single(),
    evidence.from('payments').select('id,payment_request_id,supplier_id,amount,paid_date,method')
      .eq('id', ids.payment).single(),
    evidence.from('payment_allocations').select('payment_id,invoice_id,credit_id,amount')
      .eq('payment_id', ids.payment).single(),
    evidence.from('bank_imports').select('id,file_hash,row_count').eq('id', ids.bankImport).single(),
    evidence.from('bank_transactions').select('id,import_id,amount,is_debit,reference,supplier_id,status,row_hash')
      .eq('id', ids.bankTransaction).single(),
    evidence.from('bank_allocations')
      .select('bank_transaction_id,invoice_id,payment_id,amount,confidence,confirmed')
      .eq('bank_transaction_id', ids.bankTransaction).single(),
    evidence.from('credit_requests').select('id,invoice_id,supplier_id,reason,amount,status')
      .eq('id', ids.credit).single(),
  ];
  const labels = [
    'after supplier product', 'after submission', 'after purchase request', 'after purchase order',
    'after purchase order item', 'after receipt', 'after invoice', 'after invoice balance',
    'after payment request', 'after payment request allocation', 'after payment', 'after payment allocation',
    'after bank import', 'after bank transaction', 'after bank allocation', 'after credit',
  ];
  const rows = await Promise.all(queries.map((query, index) => dataOf(query, labels[index])));
  return {
    artifact_schema: 1,
    captured_at: new Date().toISOString(),
    supplier_product: rows[0],
    price_submission: rows[1],
    purchase_request: rows[2],
    purchase_order: rows[3],
    purchase_order_item: rows[4],
    goods_receipt: rows[5],
    invoice: rows[6],
    invoice_balance: rows[7],
    payment_request: rows[8],
    payment_request_allocation: rows[9],
    payment: rows[10],
    payment_allocation: rows[11],
    bank_import: rows[12],
    bank_transaction: rows[13],
    bank_allocation: rows[14],
    credit_request: rows[15],
  };
}

async function readFinancialState(actor, invoiceId, paymentRequestId, label) {
  const [invoice, balances, paymentRequest] = await Promise.all([
    dataOf(actor.from('invoices').select('id,review_status,payment_status')
      .eq('id', invoiceId).single(), `${label} invoice`),
    rpc(actor, 'p0_invoice_balance_rows', {}, `${label} computed balances`),
    dataOf(actor.from('payment_requests').select('id,status').eq('id', paymentRequestId).single(),
      `${label} payment request`),
  ]);
  const balance = balances.find((row) => row.invoice_id === invoiceId);
  assert(balance, `${label}: computed invoice balance row missing`);
  return { invoice, balance, paymentRequest };
}

function assertFinancialState(state, expected, label) {
  assert.equal(state.invoice.review_status, 'approved', `${label}: invoice review status`);
  assert.equal(state.invoice.payment_status, expected.paymentStatus, `${label}: invoice payment status`);
  assert.equal(state.paymentRequest.status, expected.paymentRequestStatus,
    `${label}: payment request status`);
  assertMoney(state.balance.total_amount, AMOUNTS.invoice, `${label}: invoice total`);
  assertMoney(state.balance.paid_amount, AMOUNTS.payment, `${label}: paid amount`);
  assertMoney(state.balance.credited_amount, expected.credited, `${label}: credited amount`);
  assertMoney(state.balance.balance, expected.balance, `${label}: balance`);
}

function auditTransitionSet(rows, oldKey, newKey) {
  return rows.map((row) => `${row.old_values?.[oldKey]}->${row.new_values?.[newKey]}`).sort();
}

function validateAudits(rows, ids, actorRoleById) {
  const expected = [
    ['supplier_price_submission_processed', ids.submission, 1, 'supplier', [REASONS.priceSubmission]],
    ['purchase_request_finalized', ids.purchaseRequest, 1, 'office', [REASONS.finalizeRequest]],
    ['purchase_order_status_changed', ids.order, 1, 'office', [REASONS.sendOrder]],
    ['goods_receipt_completed', ids.receipt, 1, 'office', [REASONS.completeReceipt]],
    ['invoice_created', ids.invoice, 1, 'office', [REASONS.createInvoice]],
    ['invoice_review_status_changed', ids.invoice, 2, 'office', [REASONS.reviewInvoice, REASONS.approveInvoice]],
    ['payment_request_created', ids.paymentRequest, 1, 'office', [REASONS.createPaymentRequest]],
    ['payment_request_transitioned', ids.paymentRequest, 1, 'owner', [REASONS.approvePaymentRequest]],
    ['payment_request_executed', ids.paymentRequest, 1, 'accountant', [REASONS.executePayment]],
    ['bank_import_created', ids.bankImport, 1, 'accountant', [REASONS.importBank]],
    ['bank_match_confirmed', ids.bankTransaction, 2, 'accountant', [REASONS.matchBank, REASONS.rematchBank]],
    ['bank_match_removed', ids.bankTransaction, 1, 'accountant', [REASONS.unmatchBank]],
    ['invoice_credit_requested', ids.credit, 1, 'office', [REASONS.createCredit]],
    ['credit_request_transitioned', ids.credit, 3, 'accountant',
      [REASONS.receiveCredit, REASONS.offsetCredit, REASONS.closeCredit]],
  ];

  for (const [action, entityId, count, actorRole, reasons] of expected) {
    const matching = rows.filter((row) => row.action === action && row.entity_id === entityId);
    assert.equal(matching.length, count, `${action}: expected ${count} semantic audit row(s)`);
    assert(matching.every((row) => actorRoleById.get(row.user_id) === actorRole),
      `${action}: unexpected audit actor`);
    assert.deepEqual(matching.map((row) => row.reason).sort(), [...reasons].sort(),
      `${action}: unexpected audit reason set`);
  }

  const invoiceReviews = rows.filter((row) => row.action === 'invoice_review_status_changed'
    && row.entity_id === ids.invoice);
  assert.deepEqual(auditTransitionSet(invoiceReviews, 'review_status', 'review_status'),
    ['in_review->approved', 'received->in_review']);
  const paymentTransition = rows.filter((row) => row.action === 'payment_request_transitioned'
    && row.entity_id === ids.paymentRequest);
  assert.deepEqual(auditTransitionSet(paymentTransition, 'status', 'status'), ['pending_approval->approved']);
  const orderTransition = rows.filter((row) => row.action === 'purchase_order_status_changed'
    && row.entity_id === ids.order);
  assert.deepEqual(auditTransitionSet(orderTransition, 'status', 'status'), ['ready->sent']);
  const creditTransitions = rows.filter((row) => row.action === 'credit_request_transitioned'
    && row.entity_id === ids.credit);
  assert.deepEqual(auditTransitionSet(creditTransitions, 'status', 'status'),
    ['offset->closed', 'open->received', 'received->offset']);
}

async function main() {
  const evidence = client(SERVICE_ROLE_KEY); // SELECT-only: before/after/audit evidence.
  const ids = {
    submission: crypto.randomUUID(),
    receipt: crypto.randomUUID(),
    invoice: crypto.randomUUID(),
    paymentRequest: crypto.randomUUID(),
    credit: crypto.randomUUID(),
  };
  const before = await captureBefore(evidence, ids);
  assert(Object.values(before.controlled_ids_absent).every(Boolean), 'Controlled journey ids already exist');
  writeArtifact('p4-integrated-before.json', before);

  const roleEntries = await Promise.all(ROLES.map(async (role) => [role, await signIn(role)]));
  const actors = Object.fromEntries(roleEntries);
  const actorRoleById = new Map(roleEntries.map(([role, actor]) => [actor.userId, role]));

  const day = today();
  const dueDate = today(7);
  const targetMonth = `${day.slice(0, 7)}-01`;
  const suffix = crypto.randomUUID().slice(0, 8);

  const priceFileName = `p4-integrated-price-${ids.submission}.csv`;
  const priceBytes = Buffer.from(
    `product_id,price,available\n${PRODUCT_ID},10.00,true\n`,
    'utf8',
  );
  const priceFileHash = sha256(priceBytes);
  const storagePath = `${ORG_ID}/price-submissions/${SUPPLIER_ID}/${ids.submission}/${priceFileName}`;
  await dataOf(actors.supplier.client.storage.from('price-submissions').upload(storagePath, priceBytes, {
    contentType: 'text/csv',
    upsert: false,
  }), 'Supplier price CSV upload');
  const edge = await invokePriceList(actors.supplier.accessToken, {
    submissionId: ids.submission,
    supplierId: SUPPLIER_ID,
    targetMonth,
    fileName: priceFileName,
    storagePath,
    reason: REASONS.priceSubmission,
  });
  assert.equal(edge.response.status, 200,
    `Price-list Edge response: HTTP ${edge.response.status} (${edge.payload?.error?.code ?? edge.payload?.message ?? 'unknown'})`);
  assert.equal(edge.payload?.submission_id, ids.submission);
  assert.equal(edge.payload?.status, 'accepted');
  assert.equal(Number(edge.payload?.accepted_count), 1);
  assert.equal(Number(edge.payload?.rejected_count), 0);
  assert.equal(edge.payload?.idempotent, false);
  const currentPrice = await dataOf(actors.office.client.from('supplier_products').select('current_price')
    .eq('org_id', ORG_ID).eq('supplier_id', SUPPLIER_ID).eq('product_id', PRODUCT_ID).single(),
  'Office current price read');
  assertMoney(currentPrice.current_price, 10, 'Current supplier price after trusted intake');

  const savedDraft = await rpc(actors.office.client, 'save_purchase_request_draft', {
    p_request_id: null,
    p_notes: 'P4 integrated journey',
    p_expected_date: dueDate,
    p_editor_step: 2,
    p_items: [{ product_id: PRODUCT_ID, qty: 30, chosen_supplier_id: SUPPLIER_ID }],
  }, 'Office save purchase request draft');
  ids.purchaseRequest = savedDraft.request_id;
  const draftItem = await dataOf(actors.office.client.from('purchase_request_items')
    .select('id,qty,unit_price,chosen_supplier_id').eq('request_id', ids.purchaseRequest).single(),
  'Office draft item read');
  assertMoney(draftItem.qty, 30, 'Draft quantity');
  assertMoney(draftItem.unit_price, 10, 'Draft price snapshot');
  assert.equal(draftItem.chosen_supplier_id, SUPPLIER_ID);

  const finalized = await rpc(actors.office.client, 'finalize_purchase_request_draft', {
    p_request_id: ids.purchaseRequest,
    p_expected_total: AMOUNTS.order,
    p_reason: REASONS.finalizeRequest,
  }, 'Office finalize purchase request draft');
  assert.equal(finalized.order_count, 1);
  assertMoney(finalized.total, AMOUNTS.order, 'Finalized order total');
  assert(Array.isArray(finalized.order_ids) && finalized.order_ids.length === 1,
    'Finalize did not return one order');
  ids.order = finalized.order_ids[0];
  const orderItem = await dataOf(actors.office.client.from('purchase_order_items')
    .select('id,qty,unit_price,received_qty').eq('order_id', ids.order).single(),
  'Office order item read');
  ids.orderItem = orderItem.id;
  assertMoney(orderItem.qty, 30, 'Order quantity');
  assertMoney(orderItem.unit_price, 10, 'Order price snapshot');

  await rpc(actors.office.client, 'transition_purchase_order_status', {
    p_purchase_order_id: ids.order,
    p_target_status: 'sent',
    p_reason: REASONS.sendOrder,
    p_confirmation_note: null,
    p_expected_date: null,
  }, 'Office send allowlisted purchase order');
  const sentOrder = await dataOf(actors.office.client.from('purchase_orders').select('status')
    .eq('id', ids.order).single(), 'Office sent order read');
  assert.equal(sentOrder.status, 'sent');

  const receipt = await rpc(actors.office.client, 'save_goods_receipt', {
    p_order_id: ids.order,
    p_receipt_id: ids.receipt,
    p_complete: true,
    p_notes: 'P4 integrated receipt',
    p_open_credits: false,
    p_lines: [{ order_item_id: ids.orderItem, qty_received: 30, status: 'full', notes: null }],
    p_reason: REASONS.completeReceipt,
  }, 'Office complete goods receipt');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.order_status, 'received');

  const invoiceNumber = `P4-${suffix}`;
  const createdInvoice = await rpc(actors.office.client, 'create_invoice', {
    p_invoice_id: ids.invoice,
    p_supplier_id: SUPPLIER_ID,
    p_invoice_number: invoiceNumber,
    p_invoice_date: day,
    p_amount_before_vat: AMOUNTS.order,
    p_vat_amount: AMOUNTS.vat,
    p_total_amount: AMOUNTS.invoice,
    p_notes: 'P4 integrated invoice',
    p_order_id: ids.order,
    p_receipt_id: ids.receipt,
    p_override_reason: null,
    p_reason: REASONS.createInvoice,
  }, 'Office create invoice');
  assert.equal(createdInvoice.review_status, 'received');
  assert.equal(createdInvoice.duplicate_detected, false);
  const inReview = await rpc(actors.office.client, 'set_invoice_review_status', {
    p_invoice_id: ids.invoice,
    p_status: 'in_review',
    p_reason: REASONS.reviewInvoice,
  }, 'Office start invoice review');
  assert.equal(inReview.review_status, 'in_review');
  const approvedInvoice = await rpc(actors.office.client, 'set_invoice_review_status', {
    p_invoice_id: ids.invoice,
    p_status: 'approved',
    p_reason: REASONS.approveInvoice,
  }, 'Office approve invoice');
  assert.equal(approvedInvoice.review_status, 'approved');

  const paymentRequest = await rpc(actors.office.client, 'create_payment_request', {
    p_request_id: ids.paymentRequest,
    p_supplier_id: SUPPLIER_ID,
    p_due_date: dueDate,
    p_notes: 'P4 integrated payment request',
    p_requested_status: 'pending_approval',
    p_allocations: [{ invoice_id: ids.invoice, amount: AMOUNTS.payment }],
    p_reason: REASONS.createPaymentRequest,
  }, 'Office create payment request');
  assert.equal(paymentRequest.status, 'pending_approval');
  assertMoney(paymentRequest.amount, AMOUNTS.payment, 'Payment request amount');
  const ownerApproval = await rpc(actors.owner.client, 'transition_payment_request', {
    p_payment_request_id: ids.paymentRequest,
    p_target_status: 'approved',
    p_reason: REASONS.approvePaymentRequest,
  }, 'Owner approve payment request');
  assert.equal(ownerApproval.status, 'approved');

  const paymentReference = `P4-${crypto.randomUUID()}`;
  const execution = await rpc(actors.accountant.client, 'execute_payment_request', {
    p_payment_request_id: ids.paymentRequest,
    p_paid_date: day,
    p_method: 'bank_transfer',
    p_reference: paymentReference,
    p_notes: 'P4 integrated payment execution',
    p_allocations: [{ invoice_id: ids.invoice, credit_id: null, amount: AMOUNTS.payment }],
    p_reason: REASONS.executePayment,
  }, 'Accountant execute payment request');
  assert.equal(execution.status, 'executed');
  ids.payment = execution.payment_id;
  assertFinancialState(
    await readFinancialState(actors.accountant.client, ids.invoice, ids.paymentRequest, 'After payment execution'),
    { balance: AMOUNTS.credit, credited: 0, paymentStatus: 'partial', paymentRequestStatus: 'executed' },
    'After payment execution',
  );

  const bankDescription = 'P4 integrated payment';
  const bankLine = `${day},${bankDescription},${AMOUNTS.payment.toFixed(2)},${paymentReference}\n`;
  const bankBytes = Buffer.from(`date,description,amount,reference\n${bankLine}`, 'utf8');
  const bankFileHash = sha256(bankBytes);
  const bankRowHash = sha256(Buffer.from(bankLine, 'utf8'));
  assert.match(bankFileHash, /^[0-9a-f]{64}$/);
  const bankImport = await rpc(actors.accountant.client, 'import_bank_transactions', {
    p_filename: `p4-integrated-bank-${suffix}.csv`,
    p_file_hash: bankFileHash,
    p_column_mapping: { date: 'date', description: 'description', amount: 'amount', reference: 'reference' },
    p_rows: [{
      tx_date: day,
      description: bankDescription,
      amount: AMOUNTS.payment,
      is_debit: true,
      reference: paymentReference,
      raw: { date: day, description: bankDescription, amount: AMOUNTS.payment.toFixed(2), reference: paymentReference },
      supplier_id: SUPPLIER_ID,
      row_hash: bankRowHash,
    }],
    p_reason: REASONS.importBank,
  }, 'Accountant import bank transactions');
  assert.equal(bankImport.row_count, 1);
  ids.bankImport = bankImport.import_id;
  const importedTransaction = await dataOf(actors.accountant.client.from('bank_transactions')
    .select('id,status,row_hash').eq('import_id', ids.bankImport).eq('row_hash', bankRowHash).single(),
  'Accountant imported bank transaction read');
  assert.equal(importedTransaction.status, 'unmatched');
  ids.bankTransaction = importedTransaction.id;

  const bankMatchArgs = {
    p_bank_transaction_id: ids.bankTransaction,
    p_supplier_id: SUPPLIER_ID,
    p_existing_payment_id: ids.payment,
    p_payment_id: null,
    p_allocations: [],
    p_confidence: 1,
  };
  const firstMatch = await rpc(actors.accountant.client, 'match_bank_transaction', {
    ...bankMatchArgs,
    p_reason: REASONS.matchBank,
  }, 'Accountant match bank transaction');
  assert.equal(firstMatch.status, 'matched');
  assert.equal(firstMatch.payment_id, ids.payment);
  assertFinancialState(
    await readFinancialState(actors.accountant.client, ids.invoice, ids.paymentRequest, 'After bank match'),
    { balance: AMOUNTS.credit, credited: 0, paymentStatus: 'partial', paymentRequestStatus: 'matched' },
    'After bank match',
  );
  const unmatched = await rpc(actors.accountant.client, 'unmatch_bank_transaction', {
    p_bank_transaction_id: ids.bankTransaction,
    p_reason: REASONS.unmatchBank,
  }, 'Accountant unmatch bank transaction');
  assert.equal(unmatched.status, 'unmatched');
  assertFinancialState(
    await readFinancialState(actors.accountant.client, ids.invoice, ids.paymentRequest, 'After bank unmatch'),
    { balance: AMOUNTS.credit, credited: 0, paymentStatus: 'partial', paymentRequestStatus: 'executed' },
    'After bank unmatch',
  );
  const secondMatch = await rpc(actors.accountant.client, 'match_bank_transaction', {
    ...bankMatchArgs,
    p_reason: REASONS.rematchBank,
  }, 'Accountant rematch bank transaction');
  assert.equal(secondMatch.status, 'matched');
  assert.equal(secondMatch.payment_id, ids.payment);
  assertFinancialState(
    await readFinancialState(actors.accountant.client, ids.invoice, ids.paymentRequest, 'After bank rematch'),
    { balance: AMOUNTS.credit, credited: 0, paymentStatus: 'partial', paymentRequestStatus: 'matched' },
    'After bank rematch',
  );

  const credit = await rpc(actors.office.client, 'create_invoice_credit_request', {
    p_credit_request_id: ids.credit,
    p_invoice_id: ids.invoice,
    p_reason: 'wrong_price',
    p_amount: AMOUNTS.credit,
    p_notes: 'P4 integrated VAT credit',
    p_audit_reason: REASONS.createCredit,
  }, 'Office create invoice credit');
  assert.equal(credit.status, 'open');
  for (const [status, reason, expectedFinancialState] of [
    ['received', REASONS.receiveCredit,
      { balance: AMOUNTS.credit, credited: 0, paymentStatus: 'partial', paymentRequestStatus: 'matched' }],
    ['offset', REASONS.offsetCredit,
      { balance: 0, credited: AMOUNTS.credit, paymentStatus: 'paid', paymentRequestStatus: 'matched' }],
    ['closed', REASONS.closeCredit,
      { balance: 0, credited: AMOUNTS.credit, paymentStatus: 'paid', paymentRequestStatus: 'matched' }],
  ]) {
    const transitioned = await rpc(actors.accountant.client, 'transition_credit_request', {
      p_credit_request_id: ids.credit,
      p_status: status,
      p_reason: reason,
    }, `Accountant transition credit to ${status}`);
    assert.equal(transitioned.status, status);
    assertFinancialState(
      await readFinancialState(
        actors.accountant.client,
        ids.invoice,
        ids.paymentRequest,
        `After credit ${status}`,
      ),
      expectedFinancialState,
      `After credit ${status}`,
    );
  }

  const after = await captureAfter(evidence, ids);
  writeArtifact('p4-integrated-after.json', after);
  assertMoney(after.supplier_product.current_price, 10, 'Final current supplier price');
  assert.equal(after.price_submission.status, 'accepted');
  assert.equal(after.price_submission.revision, 1);
  assert.equal(after.price_submission.file_checksum, priceFileHash);
  assert.equal(after.price_submission.accepted_count, 1);
  assert.equal(after.price_submission.rejected_count, 0);
  assert.equal(after.price_submission.unchanged_count, 0);
  assert.equal(after.purchase_request.status, 'split');
  assert.equal(after.purchase_order.status, 'received');
  assertMoney(after.purchase_order_item.qty, 30, 'Final order quantity');
  assertMoney(after.purchase_order_item.unit_price, 10, 'Final order price snapshot');
  assertMoney(after.purchase_order_item.received_qty, 30, 'Final order received quantity');
  assert.equal(after.goods_receipt.status, 'completed');
  assert.equal(after.invoice.review_status, 'approved');
  assert.equal(after.invoice.payment_status, 'paid');
  assertMoney(after.invoice.amount_before_vat, AMOUNTS.order, 'Final invoice pre-VAT amount');
  assertMoney(after.invoice.vat_amount, AMOUNTS.vat, 'Final invoice VAT amount');
  assertMoney(after.invoice.total_amount, AMOUNTS.invoice, 'Final invoice total');
  assertMoney(after.invoice_balance.paid_amount, AMOUNTS.payment, 'Computed invoice paid amount');
  assertMoney(after.invoice_balance.credited_amount, AMOUNTS.credit, 'Computed invoice credited amount');
  assertMoney(after.invoice_balance.balance, 0, 'Computed invoice balance');
  assert.equal(after.payment_request.status, 'matched');
  assertMoney(after.payment_request.amount, AMOUNTS.payment, 'Final payment request amount');
  assertMoney(after.payment.amount, AMOUNTS.payment, 'Final payment amount');
  assert.equal(after.bank_import.file_hash, bankFileHash);
  assert.equal(after.bank_import.row_count, 1);
  assert.equal(after.bank_transaction.status, 'matched');
  assert.equal(after.bank_transaction.row_hash, bankRowHash);
  assertMoney(after.bank_transaction.amount, AMOUNTS.payment, 'Final bank amount');
  assert.equal(after.bank_allocation.payment_id, ids.payment);
  assert.equal(after.bank_allocation.confirmed, true);
  assert.equal(after.credit_request.status, 'closed');
  assertMoney(after.credit_request.amount, AMOUNTS.credit, 'Final credit amount');

  const semanticActions = [
    'supplier_price_submission_processed', 'purchase_request_finalized',
    'purchase_order_status_changed', 'goods_receipt_completed', 'invoice_created',
    'invoice_review_status_changed', 'payment_request_created', 'payment_request_transitioned',
    'payment_request_executed', 'bank_import_created', 'bank_match_confirmed',
    'bank_match_removed', 'invoice_credit_requested', 'credit_request_transitioned',
  ];
  const entityIds = [
    ids.submission, ids.purchaseRequest, ids.order, ids.receipt, ids.invoice,
    ids.paymentRequest, ids.bankImport, ids.bankTransaction, ids.credit,
  ];
  const auditRows = await dataOf(evidence.from('audit_logs')
    .select('id,user_id,action,entity_type,entity_id,old_values,new_values,reason,created_at')
    .eq('org_id', ORG_ID).in('action', semanticActions).in('entity_id', entityIds)
    .order('created_at').order('id'), 'Integrated semantic audit evidence');
  const auditArtifact = {
    artifact_schema: 1,
    captured_at: new Date().toISOString(),
    rows: auditRows.map(({ user_id: userId, ...row }) => ({
      ...row,
      actor_role: actorRoleById.get(userId) ?? 'unknown',
    })),
  };
  writeArtifact('p4-integrated-audit.json', auditArtifact);
  validateAudits(auditRows, ids, actorRoleById);

  const actionCounts = Object.fromEntries(semanticActions.map((action) => [
    action,
    auditRows.filter((row) => row.action === action).length,
  ]));
  writeArtifact('p4-integrated-journey.json', {
    artifact_schema: 1,
    result: 'pass',
    completed_at: new Date().toISOString(),
    roles_authenticated: ROLES,
    ids,
    amounts: AMOUNTS,
    price_file_sha256: priceFileHash,
    bank_file_sha256: bankFileHash,
    bank_row_sha256: bankRowHash,
    semantic_audit_counts: actionCounts,
    final_assertions: {
      current_price: 10,
      purchase_order_status: 'received',
      goods_receipt_status: 'completed',
      invoice_review_status: 'approved',
      invoice_payment_status: 'paid',
      invoice_paid_amount: AMOUNTS.payment,
      invoice_credited_amount: AMOUNTS.credit,
      invoice_balance: 0,
      payment_request_status: 'matched',
      bank_transaction_status: 'matched',
      credit_request_status: 'closed',
    },
  });

  process.stdout.write(`${JSON.stringify({
    result: 'p4_integrated_journey_passed',
    semantic_audit_rows: auditRows.length,
    artifact_dir: ARTIFACT_DIR,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
