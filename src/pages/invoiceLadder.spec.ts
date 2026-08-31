// The invoice's ladder — the adapter, and the refusal that matters more than the adapter.
//
// `invoiceLadder` renames the invoice read model's rungs into the shape the strip draws. A rename
// is boring; what is not boring is WHEN IT REFUSES. A strip rendered without the server's own
// tolerance would print "checked against 1" beside an invoice the server judged by something else,
// which is the exact failure the per-currency campaign spent `0259` removing. So the refusal is
// pinned first, in every way the server can fail to supply one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoiceLadder, type ThreeWayAssessment } from './InvoiceDetail';

const TOTALS = {
  line_net: 72.5, invoice_net: 72.5, invoice_vat: 13.05, invoice_grand: 85.55,
  line_tolerance: 0.05, invoice_tolerance: 1, currency: 'ILS',
  lines_discount: 7.5, computed_total: 85.55, unexplained_gap: 0,
  lines_vs_header_gap: 0, missing_rungs: [] as string[],
};

function threeWay(over: Partial<ThreeWayAssessment> = {}): ThreeWayAssessment {
  return {
    status: 'matched', approval_blocked: false, approval_allowed: true,
    definite_duplicate_invoice: false, assessment_hash: 'h', override_active: false,
    reasons: [], lines: [], totals: TOTALS,
    ...over,
  } as ThreeWayAssessment;
}

describe('the ladder refuses rather than guess', () => {
  it('renders nothing before the assessment has loaded', () => {
    expect(invoiceLadder(null)).toBeNull();
  });

  /**
   * A deployment where `0261` has not run yet returns the old six-field totals. The screen must
   * show no ladder at all rather than one with undefined rungs — this is the reason every field
   * of `totals` is optional in the type and none of them is optional on the server.
   */
  it('renders nothing against a server that has not published the ladder', () => {
    const { lines_discount: _d, computed_total: _c, unexplained_gap: _g, ...old } = TOTALS;
    expect(invoiceLadder(threeWay({ totals: old }))).toBeNull();
  });

  /**
   * THE ONE THAT MATTERS. Without the tolerance the server enforced there is nothing honest to
   * compare the gap against, and a printed tolerance the product does not enforce is worse than
   * no strip. `0259` returns null for a currency this database does not carry, and raises
   * `amount_check_skipped_no_tolerance` — which the reasons list above the strip already shows.
   */
  it('renders nothing when the server could not derive a tolerance for the currency', () => {
    expect(invoiceLadder(threeWay({ totals: { ...TOTALS, invoice_tolerance: null } }))).toBeNull();
  });

  it('renders nothing when the server did not say which currency the figures are in', () => {
    expect(invoiceLadder(threeWay({ totals: { ...TOTALS, currency: null } }))).toBeNull();
  });
});

describe('the ladder renames and does not calculate', () => {
  it('carries the server’s own computed total, gap and tolerance', () => {
    const ladder = invoiceLadder(threeWay({
      totals: { ...TOTALS, invoice_grand: 97.55, unexplained_gap: 12, computed_total: 85.55 },
    }));
    expect(ladder?.totals.computed_total).toBe(85.55);
    expect(ladder?.totals.unexplained_gap).toBe(12);
    // The tolerance shown is the one the server used, never one the client looked up.
    expect(ladder?.totals.document_tolerance).toBe(1);
    expect(ladder?.totals.currency).toBe('ILS');
  });

  /**
   * The rename is the whole function, so the proof is that no figure was invented on the way
   * through: every rung equals the field it came from, and the source file contains no arithmetic
   * on money at all.
   */
  it('maps every rung without touching a number', () => {
    const ladder = invoiceLadder(threeWay());
    expect(ladder?.totals.lines_net).toBe(TOTALS.line_net);
    expect(ladder?.totals.header_net).toBe(TOTALS.invoice_net);
    expect(ladder?.totals.header_vat).toBe(TOTALS.invoice_vat);
    expect(ladder?.totals.header_total).toBe(TOTALS.invoice_grand);
    expect(ladder?.totals.lines_discount).toBe(TOTALS.lines_discount);

    // And the function itself adds nothing: the computed total and the gap are the server's, so
    // an arithmetic operator on money inside this body would be the second source of truth the
    // whole ladder exists to avoid.
    const file = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');
    const body = file.slice(file.indexOf('export function invoiceLadder'));
    const adapter = body.slice(0, body.indexOf('\n}\n'));
    expect(adapter).not.toMatch(/invoice_net.*[+-].*invoice_vat/);
    expect(adapter).not.toMatch(/invoice_grand.*[+-]/);
    expect(adapter).toContain('computed_total: totals.computed_total');
    expect(adapter).toContain('unexplained_gap: totals.unexplained_gap');
  });

  /** An invoice numbers its lines from one; the strip counts from zero, as the document does. */
  it('converts a reason’s line number into the index the strip speaks', () => {
    const ladder = invoiceLadder(threeWay({
      reasons: [{ code: 'line_arithmetic_discrepancy', severity: 'error', line_number: 3 }],
    }));
    expect(ladder?.findings[0]).toEqual({ code: 'line_arithmetic_discrepancy', line_index: 2 });
  });

  it('leaves an invoice-level reason without a line', () => {
    const ladder = invoiceLadder(threeWay({
      reasons: [{ code: 'invoice_header_arithmetic_discrepancy', severity: 'error' }],
    }));
    expect(ladder?.findings[0]).toEqual({
      code: 'invoice_header_arithmetic_discrepancy', line_index: null,
    });
  });

  /** A rung name a later server invents is dropped rather than drawn without a label. */
  it('keeps only the rungs the strip can name', () => {
    const ladder = invoiceLadder(threeWay({
      totals: { ...TOTALS, missing_rungs: ['lines_net', 'withholding_at_source'] },
    }));
    expect(ladder?.totals.missing_rungs).toEqual(['lines_net']);
  });
});

describe('the gap has a next move', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');

  it('opens the product’s own amount_mismatch exception, with a required reason', () => {
    expect(source).toContain("supabase.rpc('open_manual_exception'");
    expect(source).toContain("p_type: 'amount_mismatch'");
    expect(source).toContain("p_entity_type: 'invoices'");
    // `open_manual_exception` refuses a blank reason with `reason_required` (0087); the dialog
    // demands one rather than letting the server be the first to say so.
    expect(source).toContain('requireReason busy={mismatchBusy}');
  });

  /**
   * Criterion 8. The command is idempotent while an exception of the same type is open, so a
   * second press cannot create a second row — and the screen must SAY that rather than report a
   * success that did not happen.
   */
  it('reports a second press as an exception that already exists', () => {
    expect(source).toContain('amountMismatchAlreadyOpen');
    expect(source).toContain('idempotent');
  });

  /** Owner and office, matching what the server enforces rather than guessing wider. */
  it('offers the exception only to a role the server would accept', () => {
    expect(source).toContain('{ladderOverTolerance && canEdit && (');
    expect(source).toContain("const canEdit = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);");
  });

  /** And only when the gap is actually over the tolerance the SERVER used. */
  it('offers it only over the server’s own tolerance', () => {
    expect(source).toContain('Math.abs(ladder.totals.unexplained_gap) > ladder.totals.document_tolerance');
  });
});
