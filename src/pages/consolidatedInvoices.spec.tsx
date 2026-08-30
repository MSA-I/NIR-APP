import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ConsolidatedInvoices from './ConsolidatedInvoices';

const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ConsolidatedInvoices.tsx'), 'utf8');
const service = readFileSync(join(process.cwd(), 'src', 'lib', 'consolidatedInvoices.ts'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const operations = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');

describe('consolidated supplier invoice route and intake contract', () => {
  it('loads the page module', () => {
    expect(ConsolidatedInvoices).toBeTypeOf('function');
  });

  it('allows all readers into one route while keeping mutations behind owner/office checks', () => {
    expect(app).toContain('path="/documents/consolidated-invoices" element={<Guard roles={READERS} capability="invoices.consolidated"><ConsolidatedInvoices /></Guard>}');
    expect(page).toContain("profile?.role === 'owner' || profile?.role === 'office'");
    expect(page).toContain('!canWrite');
  });

  it('keeps supplier and legal entity mandatory and the previous Jerusalem month read-only', () => {
    expect(page).toContain('label="ספק קנוני *"');
    expect(page).toContain('ישות משפטית *');
    expect(page).toContain('חודש נעול:');
    expect(page).toContain('לא ניתן לשינוי');
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
    for (const group of ['מותאם', 'חסר מקור', 'מקור שלא הופיע', 'עמום', 'פערי כמות ומחיר']) {
      expect(page).toContain(group);
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
