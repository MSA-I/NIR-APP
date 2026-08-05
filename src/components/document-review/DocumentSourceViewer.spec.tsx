import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ExtractionContract } from '../../lib/types';
import type { ReviewTarget } from './model';

/**
 * pdf.js is mocked at the react-pdf module boundary: jsdom has no canvas and the suite must never
 * reach the network (MSW fails loudly on unhandled requests), so the real engine cannot run here.
 * What IS under test is everything this wave wired around it: the page picker driving the rendered
 * page (the PLAN-00 gap), the bbox overlay living inside the rendered page box, the §13 rotation
 * mapping reaching the styles, and the physical-`left` direction pin from the mirror-bug fix.
 */
const pdfMock = vi.hoisted(() => ({ rotate: 0 }));

// The worker wiring imports `?url` from pdfjs-dist and mutates pdfjs globals — side effects the
// mocked engine neither needs nor should exercise.
vi.mock('./pdfWorker', () => ({}));

vi.mock('react-pdf', async () => {
  const { createElement, useEffect } = await import('react');
  function Document({ file, children }: { file: unknown; children?: unknown }) {
    return createElement('div', { 'data-testid': 'pdf-document', 'data-file': String(file) }, children as never);
  }
  function Page({ pageNumber, onLoadSuccess }: {
    pageNumber: number;
    onLoadSuccess?: (page: { rotate: number }) => void;
  }) {
    useEffect(() => {
      onLoadSuccess?.({ rotate: pdfMock.rotate });
    }, [pageNumber, onLoadSuccess]);
    return createElement('div', { 'data-testid': 'pdf-page', 'data-page-number': String(pageNumber) });
  }
  return { Document, Page, pdfjs: { GlobalWorkerOptions: {} } };
});

import { DocumentSourceViewer } from './DocumentSourceViewer';

const extraction: ExtractionContract = {
  schema_version: '1',
  document: { page_count: 2, detected_languages: ['heb'], plain_text: '', partial: false },
  blocks: [
    // Asymmetric on purpose (width 0.3, height 0.6): symmetric boxes render identically under
    // several wrong mappings, which is how the insetInlineStart mirror bug survived unseen.
    { id: 'block-1', page: 1, type: 'text', bbox: [0.1, 0.2, 0.4, 0.8], text: 'שורה ראשונה', confidence: 0.9 },
    { id: 'block-2', page: 2, type: 'text', bbox: [0.2, 0.1, 0.5, 0.3], text: 'שורה בעמוד שני', confidence: 0.9 },
  ],
  tables: [],
  marks: [],
};

/** The same wiring DocumentReviewWorkspace provides: picker state in, picker state back out. */
function Harness({ mimeType }: { mimeType: string }) {
  const [page, setPage] = useState(1);
  const [selectedTarget, setSelectedTarget] = useState<ReviewTarget | null>(null);
  return (
    <DocumentSourceViewer
      fileName={mimeType === 'application/pdf' ? 'invoice.pdf' : 'invoice.png'}
      mimeType={mimeType}
      sourceUrl="https://files.example.test/source"
      sourceError={null}
      extraction={extraction}
      page={page}
      selectedTarget={selectedTarget}
      onPageChange={setPage}
      onSelectTarget={(target) => setSelectedTarget(target)}
      resolveBlockText={(block) => ({ text: block.text, corrected: false })}
      resolveCellText={(_tableId, _rowIndex, _columnIndex, original) => ({ text: original, corrected: false })}
    />
  );
}

beforeEach(() => {
  pdfMock.rotate = 0;
});

describe('bbox direction pin — the mirror-bug fix', () => {
  it('positions an image overlay with physical left, never right', () => {
    render(<Harness mimeType="image/png" />);
    const overlay = screen.getByRole('button', { name: /בחירת קטע טקסט: שורה ראשונה/ });
    // bbox xMin 0.1 measured from the page's LEFT edge must render as left:10%. Under dir="rtl"
    // the old insetInlineStart resolved to right:10% and mirrored every box horizontally
    // (01-ADVERSARIAL-REVIEW-FINDINGS.md §10). If someone "fixes" this back to a logical
    // property, `left` comes out empty and this pin fails.
    expect(overlay.style.left).toBe('10%');
    expect(overlay.style.right).toBe('');
  });
});

describe('PDF rendering through react-pdf', () => {
  it('drives the rendered page from the review page picker', async () => {
    render(<Harness mimeType="application/pdf" />);

    // The bare-iframe era ignored the picker entirely (the PLAN-00 gap): assert the picker value
    // is what react-pdf is asked to render, both initially and after a change.
    const initialPage = await screen.findByTestId('pdf-page');
    expect(initialPage).toHaveAttribute('data-page-number', '1');
    expect(await screen.findByRole('button', { name: /בחירת קטע טקסט: שורה ראשונה/ })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('עמוד'), '2');

    expect(await screen.findByTestId('pdf-page')).toHaveAttribute('data-page-number', '2');
    // The overlay follows the page: page 2's block appears, page 1's is gone.
    expect(await screen.findByRole('button', { name: /בחירת קטע טקסט: שורה בעמוד שני/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /בחירת קטע טקסט: שורה ראשונה/ })).not.toBeInTheDocument();
  });

  it('renders the overlay inside the rendered page box, mapped through the page rotation', async () => {
    pdfMock.rotate = 90;
    render(<Harness mimeType="application/pdf" />);

    const page = await screen.findByTestId('pdf-page');
    const pageBox = page.parentElement as HTMLElement;
    // Child of the page box: that is what makes zoom and resize free — percentages of the box.
    const group = within(pageBox).getByRole('group', { name: 'קיצורי בחירה באמצעות מצביע' });
    const overlay = within(group).getByRole('button', { name: /בחירת קטע טקסט: שורה ראשונה/ });

    // §13, rotation 90 as (left, top, w, h) = (1−y1, x0, y1−y0, x1−x0) for bbox [0.1,0.2,0.4,0.8].
    expect(overlay.style.left).toBe('20%');
    expect(overlay.style.right).toBe('');
    expect(overlay.style.getPropertyValue('inline-size')).toBe('60%');
    expect(overlay.style.getPropertyValue('block-size')).toBe('30%');
  });

  it('keeps the viewer testids and the accessible keyboard path intact around the PDF', async () => {
    render(<Harness mimeType="application/pdf" />);
    await screen.findByTestId('pdf-page');
    expect(screen.getByTestId('document-source-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('document-annotations-keyboard')).toBeInTheDocument();
  });
});
