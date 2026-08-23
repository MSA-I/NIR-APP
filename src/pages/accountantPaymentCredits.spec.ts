import { describe, expect, it } from 'vitest';
import { buildPaymentAllocations } from './AccountantPaymentQueue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('credit allocations in the accountant payment queue', () => {
  const invoices = [
    { invoice_id: 'invoice-a', amount_allocated: 60 },
    { invoice_id: 'invoice-b', amount_allocated: 40 },
  ];

  it('replaces part of the approved amount with credit and leaves cash as the payment amount', () => {
    expect(buildPaymentAllocations(invoices, [{ credit_id: 'credit-1', amount: 30, remaining: 50 }]))
      .toEqual({
        cashAmount: 70,
        creditAmount: 30,
        allocations: [
          { invoice_id: 'invoice-a', credit_id: null, amount: 60 },
          { invoice_id: 'invoice-b', credit_id: null, amount: 10 },
          { invoice_id: null, credit_id: 'credit-1', amount: 30 },
        ],
      });
  });

  it('refuses a selection above the server-reported remaining credit', () => {
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-1', amount: 50.01, remaining: 50 }],
    )).toThrow('credit_allocation_exceeds_remaining');
  });

  it('keeps at least one agora as a real bank transfer', () => {
    expect(() => buildPaymentAllocations(
      invoices, [{ credit_id: 'credit-1', amount: 100, remaining: 100 }],
    )).toThrow('payment_cash_amount_required');
  });

  it('labels remaining credit, status and cash transfer without calling the approved total cash', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'pages', 'AccountantPaymentQueue.tsx'), 'utf8');
    expect(source).toContain('זמין לקיזוז');
    expect(source).toContain('יתרה זמינה');
    expect(source).toContain('סכום להעברה בפועל');
    expect(source).not.toContain('סכום מאושר להעברה');
  });
});
