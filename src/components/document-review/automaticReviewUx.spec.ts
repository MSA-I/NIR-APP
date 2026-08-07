import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const reviewDir = join(process.cwd(), 'src', 'components', 'document-review');
const proposals = readFileSync(join(reviewDir, 'DocumentReviewProposals.tsx'), 'utf8');
const workspace = readFileSync(join(reviewDir, 'DocumentReviewWorkspace.tsx'), 'utf8');

describe('automatic document review UX', () => {
  it('does not ask for type approval and puts price-list results before generic review panels', () => {
    expect(proposals).toContain('אין צורך באישור ידני');
    expect(proposals).not.toContain('אישור הסוג המוצע');
    expect(proposals).not.toContain('דחיית ההצעה');
    expect(workspace).toContain("const isPriceList = snapshot.interpretation?.payload.document_type === 'price_list'");
    expect(workspace).toMatch(/isPriceList\r?\n\s+\? <PriceListReviewConfirmation/);
  });
});
