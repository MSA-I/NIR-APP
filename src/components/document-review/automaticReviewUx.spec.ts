import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const reviewDir = join(process.cwd(), 'src', 'components', 'document-review');
const proposals = readFileSync(join(reviewDir, 'DocumentReviewProposals.tsx'), 'utf8');
const workspace = readFileSync(join(reviewDir, 'DocumentReviewWorkspace.tsx'), 'utf8');
const priceListReview = readFileSync(join(reviewDir, 'PriceListReviewConfirmation.tsx'), 'utf8');
const documentsInbox = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentsInbox.tsx'), 'utf8');

describe('automatic document review UX', () => {
  it('does not ask for type approval and puts price-list results before generic review panels', () => {
    expect(proposals).toContain('אין צורך באישור ידני');
    expect(proposals).not.toContain('אישור הסוג המוצע');
    expect(proposals).not.toContain('דחיית ההצעה');
    expect(workspace).toContain("const isPriceList = snapshot.interpretation?.payload.document_type === 'price_list'");
    expect(workspace).toMatch(/isPriceList\r?\n\s+\? <PriceListReviewConfirmation/);
  });

  it('keeps price-list row contents closed until the reviewer asks for more details', () => {
    expect(priceListReview).toMatch(/<details[^>]*>[\s\S]*?<summary[^>]*>\s*פרטים נוספים\s*<\/summary>[\s\S]*?Object\.entries\(item\.values\)/);
    expect(priceListReview).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  });

  it('allows a completed price list to be reprocessed without deleting its previous result', () => {
    expect(documentsInbox).toContain("['failed', 'review', 'completed'].includes(snapshot.stage)");
    expect(documentsInbox).toContain('ניסיון חדש שומר את תוצאות העיבוד הקודמות');
  });
});
