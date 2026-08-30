import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';

const source = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');

describe('invoice three-way match UI contract', () => {
  it('renders the server assessment without hiding an invoice that has no order', () => {
    expect(source).toContain("supabase.rpc('get_invoice_three_way_match'");
    // The sentence moved into the dictionary, so the claim splits in two rather than weakening:
    // the screen maps the server's code to a key, and the key carries that exact wording. One
    // assertion alone would pass while the other half was broken.
    expect(source).toContain("no_order_not_comparable: 'invoices.reason_no_order_not_comparable'");
    expect(he.invoices.reason_no_order_not_comparable).toBe('לחשבונית זו אין הזמנת רכש להשוואה');
    expect(source).toContain('difference_amount');
    expect(source).toContain('difference_percent');
  });

  it('keeps owner override reasoned, step-up authenticated and unavailable for a definite duplicate', () => {
    expect(source).toContain("supabase.rpc('override_invoice_three_way_match'");
    expect(source).toContain('<ReauthModal open={overrideReauthOpen}');
    expect(source).toContain('!data.threeWay.definite_duplicate_invoice');
    expect(source).toContain('requireReason');
  });

  it('connects human line correction and ambiguous-order allocation to the audited RPCs', () => {
    expect(source).toContain('<InvoiceLineReviewModal');
    const modal = readFileSync(resolve(process.cwd(), 'src/components/InvoiceLineReviewModal.tsx'), 'utf8');
    expect(modal).toContain("supabase.rpc('record_invoice_line_evidence'");
    expect(modal).toContain("supabase.rpc('record_invoice_line_matches'");
    // Same split as the claim above: the modal renders the key, and the key still carries the
    // sentence that tells a reviewer a name is not an identifier.
    expect(modal).toContain("t('invoiceLineReview.text_4')");
    expect(he.invoiceLineReview.text_4).toContain('שם אינו מזהה מוצר');
  });
});
