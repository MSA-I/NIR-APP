/**
 * The allocation bound, as a decision rather than as a rendering.
 *
 * `REQ-03` was not that the screen lacked a warning — it had one, amber, keyed on a symmetric
 * tolerance comparison of the SUM. It was that no signal on the create screen could ever be
 * critical for an over-allocation, at any magnitude: `over_allocated_invoice_count` is derived from
 * `payment_request_invoices` rows that do not exist before the request does, and
 * `amount_matches_open_balance` is `true` for office by the 0034 anti-oracle and false for a
 * perfectly legal part-payment. So the comparison moved here, per invoice, against the number the
 * screen printed — and it is pinned here rather than only through a mounted modal, because what it
 * decides is money, not layout.
 */
import { describe, expect, it } from 'vitest';
import { allocationBalanceChecks, type ProposedAllocation } from './checks';

const line = (over: Partial<ProposedAllocation> = {}): ProposedAllocation => ({
  invoiceId: 'inv-1',
  invoiceNumber: '3377',
  amount: 150,
  openBalance: 150,
  currency: 'ILS',
  ...over,
});

describe('allocationBalanceChecks', () => {
  it('says nothing when every allocation is within the balance beside it', () => {
    expect(allocationBalanceChecks([line(), line({ invoiceId: 'inv-2', amount: 40, openBalance: 640 })]))
      .toEqual([]);
  });

  it('is CRITICAL, not a warning, for the measured 999,999.99 against a printed 150.00', () => {
    const [check] = allocationBalanceChecks([line({ amount: 999999.99 })]);
    expect(check.severity).toBe('critical');
    expect(check.code).toBe('allocation_over_open_balance_one');
    // The invoice and the bound it broke, so the reader does not have to hunt the row.
    expect(check.vars).toMatchObject({ invoice: '3377' });
    expect(String(check.vars?.balance)).toContain('150.00');
  });

  it('fires one shekel over, where the tolerance signal returned true', () => {
    // The second measurement in the sweep: 4,721.00 against 4,720.00 produced no balance finding
    // at all, and the server then refused it with payment_request_allocation_invalid.
    const checks = allocationBalanceChecks([line({ invoiceNumber: '7702', amount: 4721, openBalance: 4720 })]);
    expect(checks).toHaveLength(1);
    expect(checks[0].severity).toBe('critical');
  });

  it('leaves a legitimate part-payment alone', () => {
    // 300 against 640 is what #350 explicitly protects: splitting a payment is not an offence.
    expect(allocationBalanceChecks([line({ amount: 300, openBalance: 640 })])).toEqual([]);
  });

  it('accepts the exact balance', () => {
    expect(allocationBalanceChecks([line({ amount: 640, openBalance: 640 })])).toEqual([]);
  });

  it('does not report a float remainder as an over-allocation', () => {
    // 0.1 + 0.2 is 0.30000000000000004. The server compares at the currency's own scale and so
    // does this; without that, ticking three invoices could block a form that is exactly right.
    expect(allocationBalanceChecks([line({ amount: 0.1 + 0.2, openBalance: 0.3 })])).toEqual([]);
  });

  it('names every offending invoice when more than one is over', () => {
    const [check] = allocationBalanceChecks([
      line({ invoiceId: 'a', invoiceNumber: '3377', amount: 200, openBalance: 150 }),
      line({ invoiceId: 'b', invoiceNumber: '7702', amount: 5000, openBalance: 4720 }),
      line({ invoiceId: 'c', invoiceNumber: '9001', amount: 10, openBalance: 640 }),
    ]);
    expect(check.code).toBe('allocation_over_open_balance_many');
    expect(check.vars).toMatchObject({ count: 2, invoices: '3377, 7702' });
  });

  it('measures a JPY allocation at its own scale, not at two decimals', () => {
    // A zero-decimal currency has no cents to round away; 101 against 100 is still over.
    expect(allocationBalanceChecks([line({ currency: 'JPY', amount: 101, openBalance: 100 })]))
      .toHaveLength(1);
    expect(allocationBalanceChecks([line({ currency: 'JPY', amount: 100, openBalance: 100 })]))
      .toEqual([]);
  });
});
