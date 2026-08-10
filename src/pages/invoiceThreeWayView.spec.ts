import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');

describe('invoice three-way match UI contract', () => {
  it('renders the server assessment without hiding an invoice that has no order', () => {
    expect(source).toContain("supabase.rpc('get_invoice_three_way_match'");
    expect(source).toContain('לחשבונית זו אין הזמנת רכש להשוואה');
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
    expect(modal).toContain('שם אינו מזהה מוצר');
  });
});
