import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Document, Page } from 'react-pdf';
import './pdfWorker';
import { Note } from '../ui';
import { normalizePageRotation, type PageRotation } from './bboxGeometry';

/**
 * The PDF branch of the source viewer: real in-app rendering via react-pdf instead of the old
 * bare <iframe>, whose internal viewer ignored the review's page picker entirely (the PLAN-00
 * gap). Here the picker state IS the rendered page: `page` goes straight into <Page pageNumber>.
 *
 * This module is imported lazily from DocumentSourceViewer so pdf.js (~1MB of engine) is paid
 * only when a PDF document is actually opened — image documents keep their existing path and
 * never load it.
 */
interface PdfSourceViewProps {
  sourceUrl: string;
  page: number;
  /**
   * The bbox overlay for the current page. Rendered as an absolutely-positioned child of the
   * page box, so browser zoom and container resizes keep it aligned with zero arithmetic; the
   * rotation is the rendered page's intrinsic /Rotate, which the overlay needs to map raster
   * bbox coordinates onto the rotated render (bboxGeometry.ts).
   */
  renderOverlay: (rotation: PageRotation) => ReactNode;
}

const loadingNode = (
  <div className="flex min-h-64 items-center justify-center p-6 text-sm text-ink-muted" role="status">
    טוען את קובץ ה־PDF…
  </div>
);

/** The rotation of a page that finished loading, keyed by what it was loaded for. */
interface LoadedPage {
  url: string;
  page: number;
  rotation: PageRotation;
}

export default function PdfSourceView({ sourceUrl, page, renderOverlay }: PdfSourceViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  // Per rendered page, not per document: /Rotate is a page attribute. Keyed by (url, page)
  // rather than reset by an effect — a load result for any other page or file simply never
  // matches, so the overlay cannot render with a stale rotation and there is no effect-ordering
  // race between a reset and a load callback.
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const overlayReady = loaded !== null && loaded.url === sourceUrl && loaded.page === page;

  // Stable identity + value-equality bail: a load callback that fired for the state we already
  // hold must be a no-op, or a consumer that re-reports on every render (a mock, a re-render of
  // <Page>) would produce a fresh state object each time and re-render forever.
  const handlePageLoadSuccess = useCallback((loadedPage: { rotate: number }) => {
    setLoaded((current) => {
      const rotation = normalizePageRotation(loadedPage.rotate);
      return current && current.url === sourceUrl && current.page === page && current.rotation === rotation
        ? current
        : { url: sourceUrl, page, rotation };
    });
  }, [sourceUrl, page]);

  // The page canvas is rendered at the container's width — crisp pixels at the size actually
  // shown, and no horizontal overflow at any viewport. Measured before first paint, then kept
  // current by ResizeObserver (absent under jsdom, where the initial measurement is 0 and the
  // canvas is mocked away anyway — <Page> then falls back to its intrinsic width).
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      if (width > 0) setContainerWidth((current) => (current === width ? current : width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-4xl bg-surface-sunken">
      <Document
        file={sourceUrl}
        loading={loadingNode}
        error={
          <div className="p-4">
            <Note tone="alert" role="alert">
              לא ניתן להציג את קובץ ה־PDF בתוך המסך. אפשר לפתוח את המקור בקישור שמעל.
            </Note>
          </div>
        }
        onLoadError={(error) => console.error('[document-review-pdf]', error.message)}
      >
        <div className="relative mx-auto w-fit max-w-full">
          {/* Text and annotation layers stay off on purpose: the selection surface here is the
              bbox overlay plus the accessible keyboard list below, and an enabled layer would sit
              between them and the pointer. Off, the pdfjs stylesheets (raw hex literals,
              THIRD_PARTY_NOTICES.md) are not needed at all — and react-pdf's missing-styles
              console warnings, which the quality gate counts as failures, never fire. */}
          <Page
            pageNumber={page}
            width={containerWidth ?? undefined}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={loadingNode}
            error={
              <div className="p-4">
                <Note tone="alert" role="alert">לא ניתן להציג עמוד זה מתוך הקובץ.</Note>
              </div>
            }
            onLoadSuccess={handlePageLoadSuccess}
          />
          {overlayReady && renderOverlay(loaded.rotation)}
        </div>
      </Document>
    </div>
  );
}
