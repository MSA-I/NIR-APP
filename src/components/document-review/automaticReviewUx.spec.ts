import { he } from '../../lib/i18n/dictionaries/he';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const reviewDir = join(process.cwd(), 'src', 'components', 'document-review');
const proposals = readFileSync(join(reviewDir, 'DocumentReviewProposals.tsx'), 'utf8');
const workspace = readFileSync(join(reviewDir, 'DocumentReviewWorkspace.tsx'), 'utf8');
const priceListReview = readFileSync(join(reviewDir, 'PriceListReviewConfirmation.tsx'), 'utf8');
const documentsInbox = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentsInbox.tsx'), 'utf8');
const documentReview = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentReview.tsx'), 'utf8');
const reprocessMigration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '0085_reprocess_reviewed_document.sql'), 'utf8');

describe('automatic document review UX', () => {
  it('does not ask for type approval and puts price-list results before generic review panels', () => {
    // The default state is now one compact value row and a correction link, not a card explaining
    // that it does not need approval.
    expect(proposals).not.toContain("t('docReview.text_2')");
    expect(proposals).toContain('className="link ms-auto min-h-11"');
    // These two stay whole-repo absence checks. They are about copy that must not EXIST anywhere,
    // so extraction does not weaken them — it only moves where the string could hide, and the
    // dictionary is now one of those places.
    expect(proposals).not.toContain('אישור הסוג המוצע');
    expect(proposals).not.toContain('דחיית ההצעה');
    expect(JSON.stringify(he.docReview)).not.toContain('אישור הסוג המוצע');
    expect(JSON.stringify(he.docReview)).not.toContain('דחיית ההצעה');
    expect(workspace).toContain("const isPriceList = snapshot.interpretation?.payload.document_type === 'price_list'");
    expect(workspace).toMatch(/isPriceList\r?\n\s+\? <PriceListReviewConfirmation/);
  });

  it('opens every price-list row from one summary-level details control', () => {
    // The control changed on 04.09.2026 and the contract did not. There is still exactly ONE
    // summary-level door into the per-line grid — it is now the button that names the lines waiting
    // behind it rather than a generic "פרטים נוספים", and it is offered only while such lines exist.
    expect(priceListReview).toContain('data-testid="price-list-show-unmatched"');
    expect(priceListReview).not.toContain('data-testid="price-list-details-toggle"');
    expect(priceListReview).toContain('aria-controls="price-list-line-details"');
    expect(priceListReview).toMatch(/detailsOpen && lineItems\.length > 0[\s\S]*?pageIndexes\.map[\s\S]*?sourceLineSummary\(item\.values/);
    expect(priceListReview).not.toContain('<details');
  });

  it('allows a completed price list to be reprocessed without deleting its previous result', () => {
    expect(documentsInbox).toContain("['failed', 'review', 'completed'].includes(snapshot.stage)");
    // The sentence moved into the dictionary, so the claim moves with it: the screen renders
    // the key, and the key still carries the promise this contract is about.
    expect(documentsInbox).toContain("t('documents.text_72')");
    expect(he.documents.text_72).toContain('ניסיון חדש שומר את תוצאות העיבוד הקודמות');
    expect(documentsInbox).toContain("p_reason: t('documents.text_31')");
    expect(he.documents.text_31).toBe('עיבוד מחדש ביוזמת המשתמש ממסך המסמכים');
    expect(documentsInbox).not.toContain("requireReason={processing.snapshots[retryDoc?.id ?? '']?.stage !== 'unprocessed'}");
    expect(reprocessMigration).toContain("j.status in ('queued', 'leased', 'extracted', 'interpreting')");
    expect(reprocessMigration).not.toMatch(/j\.status in \([^)]*'review'/);
  });

  it('opens every document row in review while source viewing stays an explicit signed-link action', () => {
    expect(documentsInbox).toContain('onRowClick={(doc) => review(doc)}');
    expect(documentsInbox).toContain('navigate(`/documents/${encodeURIComponent(doc.id)}/review${query}`)');
    expect(documentsInbox).toContain("{ key: 'view', label: t('documents.open')");
    expect(he.documents.open).toBe('צפייה במקור');
    // The signed link is now built by one helper (src/lib/documentSource.ts) so that a document
    // the browser would execute — an HTML price list — is fetched as a download rather than
    // rendered in the Storage origin. The claim this line carries is unchanged: viewing the
    // source is an explicit, signed, short-lived action and never a side effect of the row.
    expect(documentsInbox).toContain('signedDocumentSourceUrl(doc.storage_path, 300, doc.mime_type)');
    expect(documentsInbox).not.toContain('onRowClick={(doc) => void open(doc)}');
  });

  it('keeps an unprocessed document in review with a clear enqueue action', () => {
    expect(documentReview).toContain("snapshot.stage === 'unprocessed'");
    expect(documentReview).toContain("t('documentReviewPage.text_5')");
    expect(he.documentReviewPage.text_5).toContain('הקובץ נשמר, אך טרם נשלח לעיבוד');
    expect(documentReview).toContain("supabase.rpc('enqueue_document_processing'");
    expect(documentReview).toContain("t('documentReviewPage.text_8')");
    expect(he.documentReviewPage.text_8).toBe('שליחה לעיבוד');
    expect(documentReview).toContain('new Event(DOCUMENT_PROCESSING_CHANGED_EVENT)');
  });
});
