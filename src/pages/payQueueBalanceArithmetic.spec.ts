/**
 * `FIN-03` — the arithmetic behind the figure /pay now prints, on its own.
 *
 * The rendered oracle next door (`payQueueSettledBalance.spec.tsx`) proves the screen SAYS the
 * balance. It cannot reach the three ways the number itself goes wrong, because a fixture with one
 * invoice exercises none of them, and each one flips a settled request to unsettled or the reverse
 * with no error anywhere:
 *
 *   - a partial answer summed as if it were the whole one,
 *   - an invoice the request names twice counted twice,
 *   - a floating-point remainder no currency can express.
 *
 * Every case here is a money statement on an execution screen, which is why they are pinned rather
 * than trusted to a reading of the body.
 */
import { describe, expect, it } from 'vitest';
import { paymentRequestBalance } from './AccountantPaymentQueue';

describe('paymentRequestBalance', () => {
  it('reports a measured zero as zero and calls the request settled', () => {
    expect(paymentRequestBalance([{ invoice_id: 'a' }], { a: 0 })).toEqual({ total: 0, settled: true });
  });

  it('reports null the moment ONE invoice has no measured balance', () => {
    // Not 150. `invoice_balances_by_currency` returns no row for an invoice the reader's role may
    // not value (0218), and a partial sum printed as "the balance" is a claim about money nobody
    // measured. The em dash is the honest mark, and it is chosen here rather than at the call site.
    expect(paymentRequestBalance([{ invoice_id: 'a' }, { invoice_id: 'b' }], { a: 150 }))
      .toEqual({ total: null, settled: false });
  });

  it('counts an invoice the request names twice only once', () => {
    // `payment_request_invoices` may carry two rows for one invoice — `buildPaymentAllocations`
    // sums them deliberately — and double-counting the BALANCE would report 300 owed on an invoice
    // that owes 150, hiding a settled request behind an invented balance.
    expect(paymentRequestBalance([{ invoice_id: 'a' }, { invoice_id: 'a' }], { a: 150 }))
      .toEqual({ total: 150, settled: false });
  });

  it('does not manufacture a remainder out of floating point', () => {
    // 0.1 + 0.2 - 0.3 is 5.55e-17 in IEEE 754. That is `> 0`, so a naive sum reports a settled
    // request as still owing an amount smaller than any minor unit — and the settled mark, which
    // is the whole of FIN-03's queue half, silently never appears.
    const result = paymentRequestBalance(
      [{ invoice_id: 'a' }, { invoice_id: 'b' }, { invoice_id: 'c' }],
      { a: 0.1, b: 0.2, c: -0.3 },
    );
    expect(result.settled).toBe(true);
    expect(result.total).toBe(0);
  });

  it('reports nothing for a request with no invoices rather than a settled zero', () => {
    expect(paymentRequestBalance([], {})).toEqual({ total: null, settled: false });
  });

  it('honours a currency with no minor units', () => {
    // JPY-shaped: 0 minor units. Rounding to agorot would be arithmetic invented for a currency
    // that has none, and the request carries its own `minor_units` for exactly this reason.
    expect(paymentRequestBalance([{ invoice_id: 'a' }], { a: 1200 }, 0))
      .toEqual({ total: 1200, settled: false });
  });
});
