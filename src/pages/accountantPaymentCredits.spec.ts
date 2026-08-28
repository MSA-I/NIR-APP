import { describe, expect, it } from 'vitest';
import {
  buildPaymentAllocations,
  partitionSupplierCredits,
  type SupplierCreditBalance,
} from './AccountantPaymentQueue';
import { ALLOCATION_REFUSAL_MESSAGES, toHebrewError } from '../lib/errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('credit allocations in the accountant payment queue', () => {
  const invoices = [
    { invoice_id: 'invoice-a', amount_allocated: 60 },
    { invoice_id: 'invoice-b', amount_allocated: 40 },
  ];
  /** Every field spelled out at each call site — a defaulted target is the bug under test. */
  const credit = (over: {
    credit_id: string; invoice_id: string | null; target_invoice_id: string | null;
    amount: number; remaining: number;
  }) => over;
  const total = (result: ReturnType<typeof buildPaymentAllocations>) =>
    result.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

  it('uses the request currency minor units instead of assuming agorot', () => {
    const result = buildPaymentAllocations([
      { invoice_id: 'invoice-kwd', amount_allocated: 1.234 },
    ], [], 3);
    expect(result.cashAmount).toBe(1.234);
    expect(result.allocations[0].amount).toBe(1.234);
  });

  it('takes the offset off the invoice the credit belongs to, not off the last invoice in the array', () => {
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 30, remaining: 50 }),
    ]);
    // invoice-b is untouched at its full 40. The defect this replaces produced
    // [invoice-a 60, invoice-b 10] — crediting invoice-a while shorting invoice-b.
    expect(result).toEqual({
      cashAmount: 70,
      creditAmount: 30,
      allocations: [
        { invoice_id: 'invoice-a', credit_id: null, amount: 30 },
        { invoice_id: 'invoice-b', credit_id: null, amount: 40 },
        { invoice_id: null, credit_id: 'credit-1', amount: 30 },
      ],
    });
    expect(total(result)).toBe(100); // still the approved total the executor asserts
  });

  it('drops an invoice that its own credit covers in full instead of paying it cash', () => {
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 60, remaining: 60 }),
    ]);
    expect(result.allocations).toEqual([
      { invoice_id: 'invoice-b', credit_id: null, amount: 40 },
      { invoice_id: null, credit_id: 'credit-1', amount: 60 },
    ]);
    expect(result.cashAmount).toBe(40);
    expect(total(result)).toBe(100);
  });

  it('refuses a credit whose invoice is not in this payment request', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-x', invoice_id: 'invoice-elsewhere', target_invoice_id: null, amount: 30, remaining: 30 }),
    ])).toThrow('credit_invoice_not_in_request');
  });

  // Owner ruling, 23.08.2026 (OPEN-DECISIONS #243, #244): an unlinked credit MAY be offset here,
  // against any invoice of the same supplier, and the link is recorded at the moment of
  // allocation. The three tests below are what that ruling means arithmetically. Until today this
  // file asserted the opposite — that such a credit is refused outright.
  it('applies an unlinked credit to the invoice the accountant chose, and to no other', () => {
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: 'invoice-b', amount: 25, remaining: 40 }),
    ]);
    // invoice-b is the one that ends up short, because invoice-b is the one that was chosen.
    // invoice-a keeps its full 60 — an "any invoice of the supplier" rule that quietly landed on
    // invoice-a would look identical in the totals and be wrong about who was paid what.
    // `credit_invoice_id` is what the executor writes the link from (0173); without it on the
    // wire the server would have no way to know which invoice this offset covered.
    expect(result).toEqual({
      cashAmount: 75,
      creditAmount: 25,
      allocations: [
        { invoice_id: 'invoice-a', credit_id: null, amount: 60 },
        { invoice_id: 'invoice-b', credit_id: null, amount: 15 },
        { invoice_id: null, credit_id: 'credit-loose', amount: 25, credit_invoice_id: 'invoice-b' },
      ],
    });
    expect(total(result)).toBe(100);
  });

  it('sends no target for a credit that already names an invoice', () => {
    // The executor knows that link already, and a second copy on the wire is a second thing that
    // can disagree with the ledger. `toEqual` treats a present-but-undefined key as absent, so
    // the key list is asserted directly.
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 30, remaining: 50 }),
    ]);
    const creditRow = result.allocations.find((a) => a.credit_id === 'credit-1');
    expect(Object.keys(creditRow ?? {})).toEqual(['invoice_id', 'credit_id', 'amount']);
  });

  it('never puts a credit target on a cash row', () => {
    // 0173 raises `allocation_invalid` for a cash row carrying `credit_invoice_id`, and reusing
    // `invoice_id` for a credit's target would count the offset as cash and inflate the payment.
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: 'invoice-b', amount: 25, remaining: 40 }),
    ]);
    for (const row of result.allocations.filter((a) => a.credit_id === null)) {
      expect(Object.keys(row)).toEqual(['invoice_id', 'credit_id', 'amount']);
    }
  });

  it('refuses an unlinked credit with no chosen target instead of picking an invoice for it', () => {
    // The refusal that keeps `invoices[0]` from becoming policy. Which invoice a credit lands on
    // decides which invoice ends up short; array order must never decide it. Same name the
    // executor raises for the same omission.
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: null, amount: 30, remaining: 30 }),
    ])).toThrow('credit_allocation_invoice_required');
  });

  it('refuses a chosen target that is not an invoice of this request, and so not of this supplier', () => {
    // `invoices` is this request's invoices and they are all this request's supplier's, so an
    // invoice outside the map belongs to another request or another supplier. Either way the
    // offset would shrink this transfer while that invoice stays open.
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: 'invoice-of-another-supplier', amount: 30, remaining: 30 }),
    ])).toThrow('credit_invoice_not_in_request');
  });

  it('refuses to move a linked credit onto a different invoice of the same request', () => {
    // The widening is for credits that name NO invoice. A credit note that names invoice-a closes
    // invoice-a; honouring a pick of invoice-b would close an invoice the note never referred to.
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: 'invoice-b', amount: 30, remaining: 50 }),
    ])).toThrow('credit_invoice_link_immutable');
  });

  it('accepts a target that merely restates the credit\'s own link', () => {
    const result = buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: 'invoice-a', amount: 30, remaining: 50 }),
    ]);
    expect(result.cashAmount).toBe(70);
    expect(result.creditAmount).toBe(30);
  });

  it('refuses an offset bigger than its own invoice instead of silently truncating another', () => {
    // 70 against invoice-a (60). The defect this replaces accepted it: cash fell to 30, invoice-a
    // received 30 and invoice-b received nothing at all, while the credit claimed invoice-a.
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 70, remaining: 100 }),
    ])).toThrow('credit_allocation_exceeds_invoice');
  });

  it('refuses an unlinked credit bigger than the invoice it was pointed at', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: 'invoice-b', amount: 41, remaining: 100 }),
    ])).toThrow('credit_allocation_exceeds_invoice');
  });

  it('refuses a second credit on an invoice its first credit already exhausted', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 50, remaining: 50 }),
      credit({ credit_id: 'credit-2', invoice_id: 'invoice-a', target_invoice_id: null, amount: 20, remaining: 20 }),
    ])).toThrow('credit_allocation_exceeds_invoice');
  });

  it('counts a linked and an unlinked credit against the same chosen invoice together', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 50, remaining: 50 }),
      credit({ credit_id: 'credit-loose', invoice_id: null, target_invoice_id: 'invoice-a', amount: 20, remaining: 20 }),
    ])).toThrow('credit_allocation_exceeds_invoice');
  });

  it('refuses a selection above the server-reported remaining credit', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 50.01, remaining: 50 }),
    ])).toThrow('credit_allocation_exceeds_remaining');
  });

  it('keeps at least one agora as a real bank transfer', () => {
    expect(() => buildPaymentAllocations(invoices, [
      credit({ credit_id: 'credit-1', invoice_id: 'invoice-a', target_invoice_id: null, amount: 60, remaining: 60 }),
      credit({ credit_id: 'credit-2', invoice_id: null, target_invoice_id: 'invoice-b', amount: 40, remaining: 40 }),
    ])).toThrow('payment_cash_amount_required');
  });
});

describe('which supplier credits this request may offset', () => {
  const row = (over: Partial<SupplierCreditBalance>): SupplierCreditBalance => ({
    credit_id: 'credit-1', invoice_id: 'invoice-a', credit_number: 1, currency: 'ILS',
    amount: 50, allocated_amount: 0, remaining_amount: 50, status: 'received', ...over,
  });
  const requestInvoices = new Set(['invoice-a', 'invoice-b']);

  it('offers both the credits linked to this request and the credits linked to nothing', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'mine', invoice_id: 'invoice-b' }),
      row({ credit_id: 'elsewhere', invoice_id: 'invoice-z' }),
      row({ credit_id: 'loose', invoice_id: null }),
    ], requestInvoices, 'ILS');

    expect(partition.available.map((c) => c.credit_id)).toEqual(['mine']);
    // On offer since the owner ruled on 23.08.2026, in its own bucket because it is the one that
    // still needs the accountant to name an invoice.
    expect(partition.unlinked.map((c) => c.credit_id)).toEqual(['loose']);
    // The one exclusion the ruling did NOT lift: this credit already closes an invoice that is
    // not in this request. Excluded, but not swallowed — the screen has to say why.
    expect(partition.otherRequests.map((c) => c.credit_id)).toEqual(['elsewhere']);
    expect(partition.open).toHaveLength(3);
  });

  it('excludes consumed and non-received credits from every bucket', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'spent', remaining_amount: 0 }),
      row({ credit_id: 'offset', status: 'offset' }),
      row({ credit_id: 'requested', status: 'requested' }),
      row({ credit_id: 'spent-loose', invoice_id: null, remaining_amount: 0 }),
      row({ credit_id: 'draft-loose', invoice_id: null, status: 'requested' }),
    ], requestInvoices, 'ILS');

    expect(partition.open).toEqual([]);
    expect(partition.available).toEqual([]);
    expect(partition.unlinked).toEqual([]);
    expect(partition.otherRequests).toEqual([]);
  });

  /* OPEN-DECISIONS #277. A credit is money of one kind and the debt it would reduce is money of
     one kind, and offsetting one against the other is only defined when they are the same kind.
     There is no rate in this product to make it defined otherwise, so a dollar credit is refused
     against a shekel transfer — refused BY NAME, not dropped, because the accountant can see the
     credit in the supplier card and a silently shorter list would read as a bug. */
  it('refuses a credit in another currency, and says it holds one', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'shekels', invoice_id: 'invoice-b', currency: 'ILS' }),
      row({ credit_id: 'dollars-linked', invoice_id: 'invoice-a', currency: 'USD' }),
      row({ credit_id: 'dollars-loose', invoice_id: null, currency: 'USD' }),
    ], requestInvoices, 'ILS');

    expect(partition.available.map((c) => c.credit_id)).toEqual(['shekels']);
    expect(partition.unlinked).toEqual([]);
    // Held by the supplier, visible to the screen, and on offer against nothing here.
    expect(partition.otherCurrency.map((c) => c.credit_id))
      .toEqual(['dollars-linked', 'dollars-loose']);
    expect(partition.open).toHaveLength(3);
  });

  it('offers a dollar credit against a dollar transfer — the currency, not the symbol, is the test', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'dollars', invoice_id: 'invoice-b', currency: 'USD' }),
      row({ credit_id: 'shekels', invoice_id: 'invoice-a', currency: 'ILS' }),
    ], requestInvoices, 'USD');

    expect(partition.available.map((c) => c.credit_id)).toEqual(['dollars']);
    expect(partition.otherCurrency.map((c) => c.credit_id)).toEqual(['shekels']);
  });
});

describe('what the payment-execution screen says about credits', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'pages', 'AccountantPaymentQueue.tsx'), 'utf8');

  it('labels remaining credit, its invoice, status and cash without calling the approved total cash', () => {
    expect(source).toContain('זמין לקיזוז');
    expect(source).toContain('יתרה זמינה');
    expect(source).toContain('משויך לחשבונית');
    expect(source).toContain('סכום להעברה בפועל');
    expect(source).not.toContain('סכום מאושר להעברה');
  });

  it('renders an unknown credit offset as — and never as a measured zero', () => {
    // A metric with no data renders `—`; `0` would be a claim that no credit was taken.
    expect(source).toContain('fmtMoneyExact(allocationPreview?.creditAmount ?? null, pr.currency)');
    expect(source).not.toContain('fmtMoneyExact(allocationPreview?.creditAmount ?? 0');
  });

  it('asks the accountant which invoice an unlinked credit lands on, with nothing preselected', () => {
    expect(source).toContain('חשבונית שממנה יקוזז הזיכוי');
    expect(source).toContain('בחר חשבונית…');
    expect(source).toContain('<option value="">');
    // The placeholder the owner\'s ruling replaced: unlinked credits are no longer excluded, and
    // the screen no longer says the question is open.
    expect(source).not.toContain('אינם ניתנים לקיזוז כאן');
    expect(source).not.toContain('טרם הוכרעה');
    // No implicit target may creep back in through array order.
    expect(source).not.toContain('invoices[0]');
    expect(source).not.toContain('pr.invoices[0]');
  });

  it('ties the refusal text to the button it disables', () => {
    expect(source).toContain('aria-describedby={allocationError ? ALLOCATION_ERROR_ID : undefined}');
    expect(source).toContain('id={ALLOCATION_ERROR_ID}');
  });
});

describe('the Hebrew the accountant reads when the credit allocation is refused', () => {
  // Verified against the migrations, not invented: `execute_payment_request` raises these by name
  // (0173, and 0023/0031 for the containment family). A refusal that reaches the fallback text is
  // a refusal the accountant cannot act on.
  const SERVER_REFUSALS = [
    'payment_cash_amount_required',
    'allocation_target_invalid',
    'allocation_invoice_coverage_mismatch',
    'credit_allocation_invoice_required',
    'credit_allocation_supplier_mismatch',
  ];
  const FALLBACK = 'הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה.';

  it.each(SERVER_REFUSALS)('answers %s with its own sentence, not the fallback', (code) => {
    const text = toHebrewError(new Error(code));
    expect(text).not.toBe(FALLBACK);
    expect(text.length).toBeGreaterThan(10);
  });

  it.each(Object.keys(ALLOCATION_REFUSAL_MESSAGES))(
    'says the same thing about %s inline as it does through toHebrewError', (code) => {
      expect(toHebrewError(new Error(code))).toBe(ALLOCATION_REFUSAL_MESSAGES[code]);
    });

  it('no longer maps the refusal 0173 removed', () => {
    // `credit_request_not_linked_to_invoice` was the fail-closed placeholder for exactly the case
    // the owner has now decided. It is gone from the executor, so a sentence for it here would be
    // a sentence for something that cannot happen.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'errors.ts'), 'utf8');
    expect(source).not.toContain('credit_request_not_linked_to_invoice');
  });
});
