import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ConsolidatedInvoices from './ConsolidatedInvoices';
import { he } from '../lib/i18n/dictionaries/he';

const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ConsolidatedInvoices.tsx'), 'utf8');
const service = readFileSync(join(process.cwd(), 'src', 'lib', 'consolidatedInvoices.ts'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const operations = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');

describe('consolidated supplier invoice route and intake contract', () => {
  it('loads the page module', () => {
    expect(ConsolidatedInvoices).toBeTypeOf('function');
  });

  it('allows all readers into one route while keeping mutations behind owner/office checks', () => {
    expect(app).toContain('path="/documents/consolidated-invoices" element={<Guard roles={READERS}><ConsolidatedInvoices /></Guard>}');
    expect(page).toContain("profile?.role === 'owner' || profile?.role === 'office'");
    expect(page).toContain('!canWrite');
  });

  it('keeps supplier and legal entity mandatory and the previous Jerusalem month read-only', () => {
    // The copy moved into the dictionary, so each claim splits in two: the screen renders that
    // key, and the key carries that exact wording. Either half alone would pass while the other
    // was wrong — a screen pointing at the right key with the wrong sentence behind it looks
    // identical to a correct one from source.
    expect(page).toContain("label={t('consolidated.label')}");
    expect(he.consolidated.label).toBe('ספק קנוני *');
    expect(page).toContain("t('consolidated.text_10')");
    expect(he.consolidated.text_10).toContain('ישות משפטית *');
    expect(page).toContain("t('consolidated.lockedMonthLabel'");
    expect(he.consolidated.lockedMonthLabel).toContain('חודש נעול:');
    expect(he.consolidated.text_13).toContain('לא ניתן לשינוי');
    expect(service).toContain("timeZone: 'Asia/Jerusalem'");
    expect(service).toContain("supabase.rpc('list_consolidated_invoice_legal_entities'");
  });

  it('models camera and file upload as one multi-page intake', () => {
    expect(page).toContain('capture="environment" multiple');
    expect(page.match(/type="file"/g)).toHaveLength(2);
    expect(page.match(/multiple/g)?.length).toBeGreaterThanOrEqual(2);
    expect(service).toContain("supabase.rpc('open_consolidated_invoice_intake'");
    expect(service).toContain("supabase.rpc('register_consolidated_invoice_page'");
    expect(service).toContain("supabase.rpc('complete_consolidated_invoice_intake'");
    expect(service).toContain("for (const documentId of completed.document_ids)");
    expect(service).toContain("supabase.rpc('enqueue_document_processing'");
    expect(service).toContain('/consolidated-invoices/${input.intakeId}/page-${input.pageNumber}/');
  });

  it('renders the three reconciliation channels and all operational groups as mobile cards', () => {
    for (const channel of ['anchor_vs_interim', 'anchor_vs_receipts', 'interim_vs_receipts']) {
      expect(page).toContain(channel);
    }
    // The five group names are one sentence in the dictionary now, so the claim moves with it:
    // the screen renders that key, and the key still names every group.
    expect(page).toContain("t('consolidated.text_41')");
    for (const group of ['מותאם', 'חסר מקור', 'מקור שלא הופיע', 'עמום', 'פערי כמות ומחיר']) {
      expect(he.consolidated.text_41).toContain(group);
    }
    expect(page).toContain('mobile="cards"');
    expect(page).toContain('aria-live="polite"');
  });

  it('adds the separate document-control section without changing the bottom action catalogue', () => {
    expect(operations).toContain('id="consolidated-invoices-title"');
    expect(operations).toContain('צילום מסמכים');
    expect(operations).toContain('העלאת מסמכים');
    expect(operations).toContain('צפייה בהתאמות');
    expect(operations).not.toContain('intent=');
  });
});
