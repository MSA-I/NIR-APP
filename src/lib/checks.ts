import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { addCalendarDays, fmtDate, todayISO } from './format';
import { fetchAll, fetchInChunks } from './supabasePaging';

export type CheckSeverity = 'info' | 'warning' | 'critical';
export interface CheckResult {
  code: string;
  severity: CheckSeverity;
  message: string;
}

const AMOUNT_TOLERANCE = 1; // ₪ — treat sub-shekel gaps as rounding

/** Automatic invoice checks required by the spec (duplicates, order/receipt gaps, existing payment paths). */
export async function runInvoiceChecks(inv: {
  id?: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  linkedOrderIds?: string[];
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  if (!inv.supplier_id || !inv.invoice_number) return results;

  // 1. exact duplicate: same supplier + invoice number
  const dups = await fetchAll<{ id: string; invoice_date: string; total_amount: number; payment_status: string }>((from, to) => {
    let query = supabase.from('invoices').select('id, invoice_date, total_amount, payment_status')
      .eq('supplier_id', inv.supplier_id).eq('invoice_number', inv.invoice_number).is('deleted_at', null);
    if (inv.id) query = query.neq('id', inv.id);
    return query.order('id').range(from, to);
  });
  for (const d of dups) {
    results.push({
      code: 'duplicate_number',
      severity: 'critical',
      message: `קיימת חשבונית עם אותו מספר לאותו ספק (מ־${fmtDate(d.invoice_date)}, ₪${d.total_amount.toLocaleString()}${d.payment_status === 'paid' ? ', שולמה' : ''})`,
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
        message: `סכום החשבונית (₪${inv.total_amount.toLocaleString()}) שונה מסכום ההזמנה (₪${orderTotal.toLocaleString()}) — פער של ₪${Math.abs(inv.total_amount - orderTotal).toLocaleString()}`,
      });
    }
    if (Math.abs(receivedTotal - inv.total_amount) > AMOUNT_TOLERANCE && Math.abs(receivedTotal - orderTotal) > AMOUNT_TOLERANCE) {
      results.push({
        code: 'receipt_mismatch',
        severity: 'warning',
        message: `שווי הסחורה שהתקבלה בפועל (₪${receivedTotal.toLocaleString()}) שונה מסכום החשבונית — ייתכן שנדרש זיכוי`,
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

    // 5. matching bank transaction already confirmed
    const bank = await fetchAll<{ id: string; confirmed: boolean }>((from, to) => supabase.from('bank_allocations')
      .select('id, confirmed').eq('invoice_id', inv.id!).order('id').range(from, to));
    if (bank.some((b) => b.confirmed)) {
      results.push({ code: 'bank_matched', severity: 'info', message: 'קיימת תנועת בנק מותאמת לחשבונית זו' });
    }

    // 6. already paid
    const bal = unwrap(await supabase.from('invoice_balances').select('*').eq('invoice_id', inv.id).maybeSingle()) as
      { paid_amount: number; balance: number } | null;
    if (bal && bal.balance <= 0) {
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
      message: `לספק זה ${credits.length} זיכויים פתוחים בסך ₪${sum.toLocaleString()} — כדאי לקזז לפני תשלום`,
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

  // 1. linked invoices already paid / balances
  if (pr.invoiceIds.length) {
    const bals = await fetchInChunks(pr.invoiceIds, (ids) =>
      fetchAll<{ invoice_id: string; balance: number; paid_amount: number }>((from, to) => supabase.from('invoice_balances')
        .select('invoice_id, balance, paid_amount').in('invoice_id', ids).order('invoice_id').range(from, to)));
    const paid = bals.filter((b) => b.balance <= 0);
    if (paid.length) {
      results.push({ code: 'invoice_paid', severity: 'critical', message: `${paid.length} מהחשבוניות המקושרות כבר שולמו במלואן` });
    }
    const totalBalance = bals.reduce((s, b) => s + Math.max(0, b.balance), 0);
    if (Math.abs(totalBalance - pr.amount) > AMOUNT_TOLERANCE) {
      results.push({
        code: 'amount_vs_balance',
        severity: 'warning',
        message: `סכום הדרישה (₪${pr.amount.toLocaleString()}) שונה מיתרת החשבוניות המקושרות (₪${totalBalance.toLocaleString()})`,
      });
    }
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

  // 3. similar bank transaction (same supplier, same amount, last 45 days)
  const since = addCalendarDays(todayISO(), -45);
  const txs = await fetchAll<{ id: string; tx_date: string }>((from, to) => supabase.from('bank_transactions').select('id, tx_date')
    .eq('supplier_id', pr.supplier_id).eq('amount', pr.amount).eq('is_debit', true)
    .gte('tx_date', since).order('tx_date').order('id').range(from, to));
  if (txs.length) {
    results.push({
      code: 'similar_bank_tx',
      severity: 'warning',
      message: `קיימת העברה בנקאית באותו סכום לספק זה (${txs.map((t) => fmtDate(t.tx_date)).join(', ')}) — ודא שלא שולם כבר`,
    });
  }

  // 4. open credits to deduct
  const credits = await fetchAll<{ id: string; amount: number }>((from, to) => supabase.from('credit_requests').select('id, amount')
    .eq('supplier_id', pr.supplier_id).in('status', ['open', 'requested', 'received']).order('id').range(from, to));
  if (credits.length) {
    const sum = credits.reduce((s, c) => s + c.amount, 0);
    results.push({ code: 'open_credit', severity: 'warning', message: `זיכויים פתוחים בסך ₪${sum.toLocaleString()} טרם קוזזו מהדרישה` });
  }

  return results;
}

/** Recompute an invoice's payment_status server-side (works for every role incl. payer). */
export async function refreshInvoicePaymentStatus(invoiceId: string) {
  await supabase.rpc('refresh_invoice_payment_status', { inv_id: invoiceId });
}
