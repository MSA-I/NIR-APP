// The source viewer shows the document and nothing the engine wrote on top of it.
//
// The owner named this surface twice: "כשאני מעלה מסמך אנחנו לא אמורים לראות את כל הprocess של
// ה-OCR", and then, pointing at the bbox boxes themselves, "בפירוש אין צורך לראות את הקווים
// הכחולים הללו". So the assertions here are mostly negative — a suite that only checked the page
// picker would stay green if someone reintroduced the overlay tomorrow.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

/**
 * pdf.js is mocked at the react-pdf module boundary: jsdom has no canvas and the suite must never
 * reach the network (MSW fails loudly on unhandled requests), so the real engine cannot run here.
 * What IS under test is the wiring around it: the page picker driving the rendered page — the
 * PLAN-00 gap, which the bare-iframe era ignored entirely.
 */
vi.mock('./pdfWorker', () => ({}));

vi.mock('react-pdf', async () => {
  const { createElement } = await import('react');
  function Document({ file, children }: { file: unknown; children?: unknown }) {
    return createElement('div', { 'data-testid': 'pdf-document', 'data-file': String(file) }, children as never);
  }
  function Page({ pageNumber }: { pageNumber: number }) {
    return createElement('div', { 'data-testid': 'pdf-page', 'data-page-number': String(pageNumber) });
  }
  return { Document, Page, pdfjs: { GlobalWorkerOptions: {} } };
});

import { DocumentSourceViewer } from './DocumentSourceViewer';

/** The same wiring DocumentReviewWorkspace provides: picker state in, picker state back out. */
function Harness({ mimeType, pageCount = 2 }: { mimeType: string; pageCount?: number }) {
  const [page, setPage] = useState(1);
  const [opened, setOpened] = useState(false);
  return (
    <>
      <DocumentSourceViewer
        fileName={mimeType === 'application/pdf' ? 'invoice.pdf' : 'invoice.png'}
        mimeType={mimeType}
        sourceUrl="https://files.example.test/preview"
        sourceError={null}
        openingSource={false}
        pageCount={pageCount}
        page={page}
        onPageChange={setPage}
        onOpenSource={() => setOpened(true)}
      />
      {opened && <span>fresh source requested</span>}
    </>
  );
}

describe('the engine does not draw on the document', () => {
  it('renders an image with no overlay boxes over it', () => {
    render(<Harness mimeType="image/png" />);

    expect(screen.getByAltText('המסמך המקורי invoice.png')).toBeInTheDocument();
    // The overlay was a role="group" of absolutely-positioned buttons, one per block and mark.
    expect(screen.queryByRole('group', { name: 'קיצורי בחירה באמצעות מצביע' })).toBeNull();
    // Nothing on this surface is a selection target any more. The picker is a <select>, not a
    // button, so "no buttons except the source link" is the honest form of that claim.
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/בחירת/);
    }
  });

  it('drops the per-block lists, the grades and the page coordinates', () => {
    render(<Harness mimeType="image/png" />);

    for (const gone of ['בחירה נגישה לפי עמוד', 'קטעי טקסט', 'סימונים']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByTestId('document-annotations-keyboard')).toBeNull();
    // Confidence grades and bbox descriptions both left with the lists.
    expect(screen.queryByText(/זוהה בבירור|לא ודאי|רמת הזיהוי אינה ידועה/)).toBeNull();
    expect(screen.queryByText(/מיקום בעמוד|פרוס על פני כל העמוד/)).toBeNull();
  });
});

describe('reading a document that has more than one page', () => {
  it('drives the rendered PDF page from the picker', async () => {
    render(<Harness mimeType="application/pdf" />);

    const initialPage = await screen.findByTestId('pdf-page');
    expect(initialPage).toHaveAttribute('data-page-number', '1');

    await userEvent.selectOptions(screen.getByLabelText('עמוד'), '2');

    expect(await screen.findByTestId('pdf-page')).toHaveAttribute('data-page-number', '2');
  });

  it('hides the picker when there is nowhere to go', () => {
    render(<Harness mimeType="image/png" pageCount={1} />);
    // A lone "עמוד 1" is a control that does nothing; a single-page document gets no picker.
    expect(screen.queryByLabelText('עמוד')).toBeNull();
  });

  it('requests a fresh source URL when the original file is opened', async () => {
    render(<Harness mimeType="application/pdf" />);
    await screen.findByTestId('pdf-page');
    expect(screen.getByTestId('document-source-viewer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /פתיחת המקור/ }));
    expect(screen.getByText('fresh source requested')).toBeInTheDocument();
  });
});
