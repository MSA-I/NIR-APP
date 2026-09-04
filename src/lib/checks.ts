import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { addCalendarDays, currencyMinorUnits, fmtDate, fmtMoneyExact } from './format';
import { fetchAll, fetchInChunks } from './supabasePaging';
import type { TKey } from './i18n/t';

export type CheckSeverity = 'info' | 'warning' | 'critical';
export type CheckCode =
  | 'duplicate_number'
  | 'duplicate_number_paid'
  | 'similar_invoice'
  | 'order_mismatch'
  | 'receipt_mismatch'
  | 'existing_pr'
  | 'bank_matched'
  | 'already_paid'
  | 'invoice_open_credit_one'
  | 'invoice_open_credit_many'
  | 'invoice_visibility'
  | 'invoice_paid_one'
  | 'invoice_paid_many'
  | 'invoice_unapproved'
  | 'allocation_vs_balance_one'
  | 'allocation_vs_balance_many'
  | 'allocation_over_open_balance_one'
  | 'allocation_over_open_balance_many'
  | 'amount_vs_balance'
  | 'similar_pr'
  | 'similar_bank_unavailable'
  | 'payment_request_open_credit';
export interface CheckResult {
  code: CheckCode;
  severity: CheckSeverity;
  vars?: Record<string, string | number>;
  amount?: number;
  /**
   * The currency `amount` is in (0217). Present whenever `amount` is, because a caller that reads
   * the figure back — the payment-request screen subtracts the open-credit total from the request
   * — has to know it is looking at the same kind of money before it does the arithmetic.
   */
  currency?: string;
}

export const CHECK_MESSAGE_KEY: Readonly<Record<CheckCode, TKey>> = {
  duplicate_number: 'checks.duplicateNumber',
  duplicate_number_paid: 'checks.duplicateNumberPaid',
  similar_invoice: 'checks.similarInvoice',
  order_mismatch: 'checks.orderMismatch',
  receipt_mismatch: 'checks.receiptMismatch',
  existing_pr: 'checks.existingPaymentRequest',
  bank_matched: 'checks.bankMatched',
  already_paid: 'checks.alreadyPaid',
  invoice_open_credit_one: 'checks.invoiceOpenCreditOne',
  invoice_open_credit_many: 'checks.invoiceOpenCreditMany',
  invoice_visibility: 'checks.invoiceVisibility',
  invoice_paid_one: 'checks.invoicePaidOne',
  invoice_paid_many: 'checks.invoicePaidMany',
  invoice_unapproved: 'checks.invoiceUnapproved',
  allocation_vs_balance_one: 'checks.allocationVsBalanceOne',
  allocation_vs_balance_many: 'checks.allocationVsBalanceMany',
  allocation_over_open_balance_one: 'checks.allocationOverOpenBalanceOne',
  allocation_over_open_balance_many: 'checks.allocationOverOpenBalanceMany',
  amount_vs_balance: 'checks.amountVsBalance',
  similar_pr: 'checks.similarPaymentRequest',
  similar_bank_unavailable: 'checks.similarBankUnavailable',
  payment_request_open_credit: 'checks.paymentRequestOpenCredit',
};

export function checkText(
  check: CheckResult,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string {
  return t(CHECK_MESSAGE_KEY[check.code], check.vars);
}

/**
 * ONE UNIT of the invoice's own currency, and advisory only: this is the gap below which the
 * browser stops raising a warning to a person, not a threshold anything is approved by. The
 * binding tolerance is the server's, per organisation and per currency (`private.money_tolerance`,
 * 0219, decision #288) — every check that actually blocks reads that one.
 */
const AMOUNT_TOLERANCE = 1;

/** Automatic invoice checks required by the spec (duplicates, order/receipt gaps, existing payment paths). */
export async function runInvoiceChecks(inv: {
  id?: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  /**
   * The currency of THIS invoice (0217). Every figure below — the duplicate's total, the order
   * total, the value received, the supplier's open credits — is compared against it and rendered
   * in it. A comparison across two currencies is not a discrepancy, it is a category error, and
   * the server refuses to create one: an order's items are in the order's currency and a credit
   * is tied to its invoice's currency by foreign key.
   */
  currency: string;
  linkedOrderIds?: string[];
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  if (!inv.supplier_id || !inv.invoice_number) return results;

  // 1. exact duplicate: same supplier + invoice number
  const dups = await fetchAll<{ id: string; invoice_date: string; total_amount: number; payment_status: string }>((from, to) => {
    let query = supabase.from('invoices').select('id, invoice_date, total_amount, payment_status')
      .eq('supplier_id', inv.supplier_id).eq('invoice_number', inv.invoice_number)
      .eq('financial_role', 'payable').is('deleted_at', null);
    if (inv.id) query = query.neq('id', inv.id);
    return query.order('id').range(from, to);
  });
  for (const d of dups) {
    results.push({
      code: d.payment_status === 'paid' ? 'duplicate_number_paid' : 'duplicate_number',
      severity: 'critical',
      vars: { date: fmtDate(d.invoice_date), amount: fmtMoneyExact(d.total_amount, inv.currency) },
    });
  }

  // 2. similar: same supplier + same amount within 7 days, different number
  if (inv.invoice_date && inv.total_amount > 0) {
    const dateFrom = addCalendarDays(inv.invoice_date, -7);
    const dateTo = addCalendarDays(inv.invoice_date, 7);
    const sims = await fetchAll<{ id: string; invoice_number: string }>((from, to) => {
      let query = supabase.from('invoices').select('id, invoice_number, invoice_date')
        .eq('supplier_id', inv.supplier_id).eq('total_amount', inv.total_amount)
        .neq('invoice_number', inv.invoice_number)
        .eq('financial_role', 'payable')
        .gte('invoice_date', dateFrom).lte('invoice_date', dateTo)
        .is('deleted_at', null);
      if (inv.id) query = query.neq('id', inv.id);
      return query.order('id').range(from, to);
    });
    if (sims.length) {
      results.push({
        code: 'similar_invoice',
        severity: 'warning',
        vars: { numbers: sims.map((s) => s.invoice_number).join(', ') },
      });
    }
  }

  // 3. order totals vs invoice total
  if (inv.linkedOrderIds?.length) {
    const items = await fetchInChunks(inv.linkedOrderIds, (ids) =>
      fetchAll<{ id: string; qty: number; unit_price: number; received_qty: number }>((from, to) =>
        supabase.from('purchase_order_items').select('id, order_id, qty, unit_price, received_qty')
          .in('order_id', ids).order('id').range(from, to)));
    const orderTotal = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const receivedTotal = items.reduce((s, i) => s + i.received_qty * i.unit_price, 0);
    if (Math.abs(orderTotal - inv.total_amount) > AMOUNT_TOLERANCE) {
      results.push({
        code: 'order_mismatch',
        severity: 'warning',
        vars: {
          invoiceAmount: fmtMoneyExact(inv.total_amount, inv.currency),
          orderAmount: fmtMoneyExact(orderTotal, inv.currency),
          difference: fmtMoneyExact(Math.abs(inv.total_amount - orderTotal), inv.currency),
        },
      });
    }
    if (Math.abs(receivedTotal - inv.total_amount) > AMOUNT_TOLERANCE && Math.abs(receivedTotal - orderTotal) > AMOUNT_TOLERANCE) {
      results.push({
        code: 'receipt_mismatch',
        severity: 'warning',
        vars: { receivedAmount: fmtMoneyExact(receivedTotal, inv.currency) },
      });
    }
  }

  if (inv.id) {
    // 4. existing payment request
    const prs = await fetchAll((from, to) => supabase.from('payment_request_invoices')
      .select('invoice_id, payment_request_id, payment_requests!inner(number, status)').eq('invoice_id', inv.id!)
      .order('payment_request_id').range(from, to)) as unknown as
      { payment_requests: { number: number; status: string } }[];
    const active = prs.filter((p) => !['cancelled'].includes(p.payment_requests.status));
    if (active.length) {
      results.push({
        code: 'existing_pr',
        severity: 'info',
        vars: { numbers: active.map((p) => p.payment_requests.number).join(', ') },
      });
    }

    // 5–6. Narrow server signals preserve bank/payment privacy for procurement managers.
    const financial = unwrap(await supabase.rpc('invoice_financial_check_signals', {
      p_invoice_id: inv.id,
    })) as { bank_match_exists: boolean; already_paid: boolean };
    if (financial.bank_match_exists) {
      results.push({ code: 'bank_matched', severity: 'info' });
    }
    if (financial.already_paid) {
      results.push({ code: 'already_paid', severity: 'critical' });
    }
  }

  // 7. open credits for this supplier that should be deducted
  const credits = await fetchAll<{ id: string; amount: number; status: string }>((from, to) => supabase.from('credit_requests')
    .select('id, amount, status').eq('supplier_id', inv.supplier_id).in('status', ['open', 'requested', 'received'])
    .order('id').range(from, to));
  if (credits.length) {
    const sum = credits.reduce((s, c) => s + c.amount, 0);
    results.push({
      code: credits.length === 1 ? 'invoice_open_credit_one' : 'invoice_open_credit_many',
      severity: 'info',
      vars: { count: credits.length, total: fmtMoneyExact(sum, inv.currency) },
    });
  }

  return results;
}

/** Pre-approval checks for a payment request. */
export async function runPaymentRequestChecks(pr: {
  id?: string;
  supplier_id: string;
  amount: number;
  invoiceIds: string[];
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Server-side financial signals expose decisions, never balances or bank rows.
  const financial = unwrap(await supabase.rpc('payment_request_financial_check_signals', {
    p_supplier_id: pr.supplier_id,
    p_amount: pr.amount,
    p_invoice_ids: pr.invoiceIds,
    p_payment_request_id: pr.id ?? null,
  })) as {
    requested_invoice_count: number;
    visible_invoice_count: number;
    paid_invoice_count: number;
    unapproved_invoice_count: number;
    /** 0219: null — not false — when this organisation has stated no tolerance for this currency. */
    amount_matches_open_balance: boolean | null;
    similar_bank_transfer_check: 'unavailable';
    /** The currency the whole answer is in. The server refuses an invoice set spanning two (0219). */
    currency: string;
    /** 0219: one entry per currency the supplier has an open credit in. Never one sum. */
    open_credit_total_by_currency: { currency: string; amount: number }[];
    over_allocated_invoice_count: number;
  };
  if (financial.visible_invoice_count !== financial.requested_invoice_count) {
    results.push({ code: 'invoice_visibility', severity: 'critical' });
  }
  if (financial.paid_invoice_count > 0) {
    results.push({
      code: financial.paid_invoice_count === 1 ? 'invoice_paid_one' : 'invoice_paid_many',
      severity: 'critical',
      vars: { count: financial.paid_invoice_count },
    });
  }
  if (financial.unapproved_invoice_count > 0) {
    results.push({ code: 'invoice_unapproved', severity: 'critical' });
  }
  // 0146. amount_allocated is fixed when the request is created and never recomputed, so a credit
  // that was offset afterwards leaves the request allocating more than the invoice still owes.
  // The server rejects that at approval AND at execution and there is no screen that can edit an
  // allocation — so the only honest instruction is to cancel and re-open. Said here, before the
  // button, instead of as a refusal the user cannot act on.
  if (financial.over_allocated_invoice_count > 0) {
    results.push({
      code: financial.over_allocated_invoice_count === 1
        ? 'allocation_vs_balance_one'
        : 'allocation_vs_balance_many',
      severity: 'critical',
      vars: { count: financial.over_allocated_invoice_count },
    });
  }
  if (!financial.amount_matches_open_balance) {
    results.push({
      code: 'amount_vs_balance',
      severity: 'warning',
    });
  }

  // 2. similar active payment request
  const sims = await fetchAll<{ id: string; number: number }>((from, to) => {
    let query = supabase.from('payment_requests').select('id, number, status')
      .eq('supplier_id', pr.supplier_id).eq('amount', pr.amount)
      .in('status', ['draft', 'pending_approval', 'approved', 'sent_for_execution', 'executed', 'matched']);
    if (pr.id) query = query.neq('id', pr.id);
    return query.order('id').range(from, to);
  });
  if (sims.length) {
    results.push({
      code: 'similar_pr',
      severity: 'critical',
      vars: { numbers: sims.map((s) => s.number).join(', ') },
    });
  }

  // 3. Bank data is not legal-entity scoped yet. Keep the check visibly unavailable and
  // non-blocking instead of querying or inferring from organization-wide activity.
  if (financial.similar_bank_transfer_check === 'unavailable') {
    results.push({
      code: 'similar_bank_unavailable',
      severity: 'warning',
    });
  }

  // 4. Scoped open-credit total from the trusted server check. The browser does not read
  // raw credit rows or aggregate credits from another legal entity.
  // One finding per currency, because a dollar credit does not offset a shekel request and a
  // single line reading their sum would say that it does.
  for (const credit of financial.open_credit_total_by_currency) {
    if (credit.amount <= 0) continue;
    results.push({
      code: 'payment_request_open_credit',
      severity: 'warning',
      amount: credit.amount,
      currency: credit.currency,
      vars: { total: fmtMoneyExact(credit.amount, credit.currency) },
    });
  }

  return results;
}

/** One line of the create screen: the invoice, what is being asked for it, and what it still owes. */
export interface ProposedAllocation {
  invoiceId: string;
  invoiceNumber: string;
  /** What the person typed into the amount field for this invoice. */
  amount: number;
  /** The open balance THIS SCREEN PRINTED beside that field, in the invoice's own currency. */
  openBalance: number;
  currency: string;
}

/**
 * The allocation bound, measured against the number the screen itself printed.
 *
 * `runPaymentRequestChecks` cannot answer this and never could: its only critical balance signal is
 * `over_allocated_invoice_count`, which the server derives from EXISTING `payment_request_invoices`
 * rows and is therefore structurally 0 for a request that does not exist yet. Its other balance
 * signal, `amount_matches_open_balance`, is a symmetric tolerance comparison on the SUM — false for
 * a perfectly legal part-payment of 300 against 640, and hard-coded `true` for office by the 0034
 * anti-oracle. Neither can say "this invoice is being asked for more than it owes", which is why
 * 999,999.99 against a printed 150.00 was an amber warning under a green enabled button (`REQ-03`).
 *
 * So the comparison is made here, per invoice, against the balance the screen has already shown the
 * reader — no new server surface, no widened query, and nothing revealed that was not on screen a
 * line above the field. For the owner that number is the invoice's live balance from
 * `invoice_balances_by_currency`; for office it is the total of an invoice the list only offers
 * while it is WHOLLY unpaid. Both are what the server will measure the allocation against, so the
 * screen now refuses exactly what `create_payment_request` refuses, before the form is finished
 * rather than after.
 *
 * Rounded to the currency's own scale first, because 0231 made the server's comparison
 * `round(a.amount, v_minor_units) > round(balance, v_minor_units)` and a float remainder of 1e-13
 * is not an over-allocation. A currency the platform cannot scale falls back to comparing the raw
 * figures, which is the conservative direction: it can only report a difference that is really there.
 */
export function allocationBalanceChecks(allocations: readonly ProposedAllocation[]): CheckResult[] {
  const scaled = (value: number, currency: string) => {
    const minorUnits = currencyMinorUnits(currency);
    return minorUnits == null ? value : Math.round(value * 10 ** minorUnits);
  };
  const over = allocations.filter((allocation) =>
    scaled(allocation.amount, allocation.currency) > scaled(allocation.openBalance, allocation.currency));
  if (over.length === 0) return [];
  if (over.length === 1) {
    const [only] = over;
    return [{
      code: 'allocation_over_open_balance_one',
      severity: 'critical',
      vars: {
        invoice: only.invoiceNumber,
        balance: fmtMoneyExact(only.openBalance, only.currency),
      },
    }];
  }
  return [{
    code: 'allocation_over_open_balance_many',
    severity: 'critical',
    vars: {
      count: over.length,
      invoices: over.map((allocation) => allocation.invoiceNumber).join(', '),
    },
  }];
}

/** Recompute an invoice's payment status through the server-authoritative command. */
export async function refreshInvoicePaymentStatus(invoiceId: string) {
  await supabase.rpc('refresh_invoice_payment_status', { inv_id: invoiceId });
}
