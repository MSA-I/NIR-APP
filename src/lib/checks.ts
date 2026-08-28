import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { addCalendarDays, fmtDate, fmtMoneyExact } from './format';
import { fetchAll, fetchInChunks } from './supabasePaging';

export type CheckSeverity = 'info' | 'warning' | 'critical';
export interface CheckResult {
  code: string;
  severity: CheckSeverity;
  message: string;
  amount?: number;
}

const AMOUNT_TOLERANCE = 1; // ₪ — treat sub-shekel gaps as rounding

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
      code: 'duplicate_number',
      severity: 'critical',
      message: `קיימת חשבונית עם אותו מספר לאותו ספק (מ־${fmtDate(d.invoice_date)}, ${fmtMoneyExact(d.total_amount, inv.currency)}${d.payment_status === 'paid' ? ', שולמה' : ''})`,
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
        message: `נמצאה חשבונית דומה (אותו ספק, אותו סכום, טווח תאריכים קרוב): מס׳ ${sims.map((s) => s.invoice_number).join(', ')}`,
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
        message: `סכום החשבונית (${fmtMoneyExact(inv.total_amount, inv.currency)}) שונה מסכום ההזמנה (${fmtMoneyExact(orderTotal, inv.currency)}) — פער של ${fmtMoneyExact(Math.abs(inv.total_amount - orderTotal), inv.currency)}`,
      });
    }
    if (Math.abs(receivedTotal - inv.total_amount) > AMOUNT_TOLERANCE && Math.abs(receivedTotal - orderTotal) > AMOUNT_TOLERANCE) {
      results.push({
        code: 'receipt_mismatch',
        severity: 'warning',
        message: `שווי הסחורה שהתקבלה בפועל (${fmtMoneyExact(receivedTotal, inv.currency)}) שונה מסכום החשבונית — ייתכן שנדרש זיכוי`,
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
        message: `קיימת דרישת תשלום מקושרת לחשבונית זו (#${active.map((p) => p.payment_requests.number).join(', ')})`,
      });
    }

    // 5–6. Narrow server signals preserve bank/payment privacy for procurement managers.
    const financial = unwrap(await supabase.rpc('invoice_financial_check_signals', {
      p_invoice_id: inv.id,
    })) as { bank_match_exists: boolean; already_paid: boolean };
    if (financial.bank_match_exists) {
      results.push({ code: 'bank_matched', severity: 'info', message: 'קיימת תנועת בנק מותאמת לחשבונית זו' });
    }
    if (financial.already_paid) {
      results.push({ code: 'already_paid', severity: 'critical', message: 'החשבונית כבר מסומנת כמשולמת במלואה — תשלום נוסף יהיה כפול' });
    }
  }

  // 7. open credits for this supplier that should be deducted
  const credits = await fetchAll<{ id: string; amount: number; status: string }>((from, to) => supabase.from('credit_requests')
    .select('id, amount, status').eq('supplier_id', inv.supplier_id).in('status', ['open', 'requested', 'received'])
    .order('id').range(from, to));
  if (credits.length) {
    const sum = credits.reduce((s, c) => s + c.amount, 0);
    results.push({
      code: 'open_credit',
      severity: 'info',
      message: `לספק זה ${credits.length} ${credits.length === 1 ? 'זיכוי פתוח' : 'זיכויים פתוחים'} `
        + `בסך ${fmtMoneyExact(sum, inv.currency)} — כדאי לקזז לפני תשלום`,
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
    results.push({ code: 'invoice_visibility', severity: 'critical', message: 'לא ניתן לאמת את כל החשבוניות המקושרות לדרישה' });
  }
  if (financial.paid_invoice_count > 0) {
    results.push({ code: 'invoice_paid', severity: 'critical', message: `${financial.paid_invoice_count} מהחשבוניות המקושרות כבר שולמו במלואן` });
  }
  if (financial.unapproved_invoice_count > 0) {
    results.push({ code: 'invoice_unapproved', severity: 'critical', message: 'הדרישה כוללת חשבונית שטרם אושרה לתשלום' });
  }
  // 0146. amount_allocated is fixed when the request is created and never recomputed, so a credit
  // that was offset afterwards leaves the request allocating more than the invoice still owes.
  // The server rejects that at approval AND at execution and there is no screen that can edit an
  // allocation — so the only honest instruction is to cancel and re-open. Said here, before the
  // button, instead of as a refusal the user cannot act on.
  if (financial.over_allocated_invoice_count > 0) {
    results.push({
      code: 'allocation_vs_balance',
      severity: 'critical',
      message: `${financial.over_allocated_invoice_count === 1 ? 'חשבונית מקושרת אחת מוקצית' : `${financial.over_allocated_invoice_count} מהחשבוניות המקושרות מוקצות`} מעל היתרה שנותרה — ככל הנראה בעקבות זיכוי שקוזז אחרי יצירת הדרישה. יש לבטל את הדרישה ולפתוח דרישה חדשה בסכום המעודכן`,
    });
  }
  if (!financial.amount_matches_open_balance) {
    results.push({
      code: 'amount_vs_balance',
      severity: 'warning',
      message: 'סכום הדרישה שונה מהיתרה הפתוחה של החשבוניות המקושרות',
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
      message: `קיימת דרישת תשלום פעילה לאותו ספק באותו סכום בדיוק (#${sims.map((s) => s.number).join(', ')}) — חשד לכפילות`,
    });
  }

  // 3. Bank data is not legal-entity scoped yet. Keep the check visibly unavailable and
  // non-blocking instead of querying or inferring from organization-wide activity.
  if (financial.similar_bank_transfer_check === 'unavailable') {
    results.push({
      code: 'similar_bank_unavailable',
      severity: 'warning',
      message: 'בדיקת העברה דומה אינה זמינה עד שיוך בנק לישות',
    });
  }

  // 4. Scoped open-credit total from the trusted server check. The browser does not read
  // raw credit rows or aggregate credits from another legal entity.
  // One finding per currency, because a dollar credit does not offset a shekel request and a
  // single line reading their sum would say that it does.
  for (const credit of financial.open_credit_total_by_currency) {
    if (credit.amount <= 0) continue;
    results.push({
      code: 'open_credit',
      severity: 'warning',
      amount: credit.amount,
      message: `זיכויים פתוחים בסך ${fmtMoneyExact(credit.amount, credit.currency)} טרם קוזזו מהדרישה`,
    });
  }

  return results;
}

/** Recompute an invoice's payment status through the server-authoritative command. */
export async function refreshInvoicePaymentStatus(invoiceId: string) {
  await supabase.rpc('refresh_invoice_payment_status', { inv_id: invoiceId });
}
