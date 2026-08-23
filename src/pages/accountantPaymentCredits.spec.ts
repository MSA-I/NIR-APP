import { describe, expect, it } from 'vitest';
import {
  buildPaymentAllocations,
  partitionSupplierCredits,
  type SupplierCreditBalance,
} from './AccountantPaymentQueue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('credit allocations in the accountant payment queue', () => {
  const invoices = [
    { invoice_id: 'invoice-a', amount_allocated: 60 },
    { invoice_id: 'invoice-b', amount_allocated: 40 },
  ];
  const total = (result: ReturnType<typeof buildPaymentAllocations>) =>
    result.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

  it('takes the offset off the invoice the credit belongs to, not off the last invoice in the array', () => {
    const result = buildPaymentAllocations(invoices, [
      { credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 30, remaining: 50 },
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
      { credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 60, remaining: 60 },
    ]);
    expect(result.allocations).toEqual([
      { invoice_id: 'invoice-b', credit_id: null, amount: 40 },
      { invoice_id: null, credit_id: 'credit-1', amount: 60 },
    ]);
    expect(result.cashAmount).toBe(40);
    expect(total(result)).toBe(100);
  });

  it('refuses a credit whose invoice is not in this payment request', () => {
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-x', invoice_id: 'invoice-elsewhere', amount: 30, remaining: 30 }],
    )).toThrow('credit_invoice_not_in_request');
  });

  it('refuses a credit that names no invoice at all — the owner has not ruled where it lands', () => {
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-loose', invoice_id: null, amount: 30, remaining: 30 }],
    )).toThrow('credit_invoice_not_in_request');
  });

  it('refuses an offset bigger than its own invoice instead of silently truncating another', () => {
    // 70 against invoice-a (60). The defect this replaces accepted it: cash fell to 30, invoice-a
    // received 30 and invoice-b received nothing at all, while the credit claimed invoice-a.
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 70, remaining: 100 }],
    )).toThrow('credit_allocation_exceeds_invoice');
  });

  it('refuses a second credit on an invoice its first credit already exhausted', () => {
    expect(() => buildPaymentAllocations(invoices, [
      { credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 50, remaining: 50 },
      { credit_id: 'credit-2', invoice_id: 'invoice-a', amount: 20, remaining: 20 },
    ])).toThrow('credit_allocation_exceeds_invoice');
  });

  it('refuses a selection above the server-reported remaining credit', () => {
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 50.01, remaining: 50 }],
    )).toThrow('credit_allocation_exceeds_remaining');
  });

  it('keeps at least one agora as a real bank transfer', () => {
    expect(() => buildPaymentAllocations(invoices, [
      { credit_id: 'credit-1', invoice_id: 'invoice-a', amount: 60, remaining: 60 },
      { credit_id: 'credit-2', invoice_id: 'invoice-b', amount: 40, remaining: 40 },
    ])).toThrow('payment_cash_amount_required');
  });
});

describe('which supplier credits this request may offset', () => {
  const row = (over: Partial<SupplierCreditBalance>): SupplierCreditBalance => ({
    credit_id: 'credit-1', invoice_id: 'invoice-a', credit_number: 1,
    amount: 50, allocated_amount: 0, remaining_amount: 50, status: 'received', ...over,
  });
  const requestInvoices = new Set(['invoice-a', 'invoice-b']);

  it('offers only credits linked to an invoice of this request', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'mine', invoice_id: 'invoice-b' }),
      row({ credit_id: 'elsewhere', invoice_id: 'invoice-z' }),
      row({ credit_id: 'loose', invoice_id: null }),
    ], requestInvoices);

    expect(partition.available.map((credit) => credit.credit_id)).toEqual(['mine']);
    // Excluded, but not swallowed: the screen has to be able to say why.
    expect(partition.otherRequests.map((credit) => credit.credit_id)).toEqual(['elsewhere']);
    expect(partition.unlinked.map((credit) => credit.credit_id)).toEqual(['loose']);
    expect(partition.open).toHaveLength(3);
  });

  it('excludes consumed and non-received credits from every bucket', () => {
    const partition = partitionSupplierCredits([
      row({ credit_id: 'spent', remaining_amount: 0 }),
      row({ credit_id: 'offset', status: 'offset' }),
      row({ credit_id: 'requested', status: 'requested' }),
    ], requestInvoices);

    expect(partition.open).toEqual([]);
    expect(partition.available).toEqual([]);
    expect(partition.unlinked).toEqual([]);
    expect(partition.otherRequests).toEqual([]);
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
    expect(source).toContain('fmtMoneyExact(allocationPreview?.creditAmount ?? null)');
    expect(source).not.toContain('fmtMoneyExact(allocationPreview?.creditAmount ?? 0)');
  });
});
