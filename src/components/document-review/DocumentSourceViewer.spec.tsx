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
 * the original document-viewer gap gap, which the bare-iframe era ignored entirely.
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
function Harness({ mimeType, pageCount = 2, fileName }: { mimeType: string; pageCount?: number; fileName?: string }) {
  const [page, setPage] = useState(1);
  const [opened, setOpened] = useState(false);
  return (
    <>
      <DocumentSourceViewer
        fileName={fileName ?? (mimeType === 'application/pdf' ? 'invoice.pdf' : 'invoice.png')}
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

/**
 * A name whose FIRST STRONG CHARACTER is not Latin. Digits are not strong, so `93_00002007 …`
 * takes its direction from `חלק`, and an un-isolated run renders `pdf.3 קלח — 00002007_93` —
 * measured in the product's own stylesheet by `scripts/filename-bidi-visual-check.cjs`. The
 * extension is torn off and parked at the opposite margin.
 */
const MIXED_SCRIPT_NAME = '93_00002007 — חלק 3.pdf';

describe('the name of the document under review (DOC-07, חוק בידוד השמות)', () => {
  it('draws the file name inside an explicit LTR isolate', () => {
    render(<Harness mimeType="image/png" fileName={MIXED_SCRIPT_NAME} />);

    // `getByText` matches on an element's OWN text nodes, so this is the `<p>` when the name is
    // bare and the `<bdi>` when it is wrapped — one match either way.
    const drawn = screen.getByText(MIXED_SCRIPT_NAME);
    const isolate = drawn.closest('[dir="ltr"]');
    expect(isolate, `the file name is drawn with no explicit LTR isolate above it: ${drawn.outerHTML}`).not.toBeNull();
    // Tight around the name. An isolate that swallowed the surrounding Hebrew would flip THAT.
    expect(isolate?.textContent).toBe(MIXED_SCRIPT_NAME);
  });

  it('CONTROL — the Hebrew section title is not forced LTR, so the assertion above can fail honestly', () => {
    render(<Harness mimeType="image/png" fileName={MIXED_SCRIPT_NAME} />);

    expect(screen.getByRole('heading', { name: 'המסמך המקורי' }).closest('[dir="ltr"]')).toBeNull();
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
