import { useLayoutEffect, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import './pdfWorker';
import { Note } from '../ui';
import { useT } from '../../lib/i18n/LocaleProvider';

/**
 * The PDF branch of the source viewer: real in-app rendering via react-pdf instead of the old
 * bare <iframe>, whose internal viewer ignored the review's page picker entirely (the the original document-viewer gap
 * gap). Here the picker state IS the rendered page: `page` goes straight into <Page pageNumber>.
 *
 * This module is imported lazily from DocumentSourceViewer so pdf.js (~1MB of engine) is paid
 * only when a PDF document is actually opened — image documents keep their existing path and
 * never load it.
 *
 * The bbox overlay this component used to host is gone (DocumentSourceViewer's header explains
 * why), and with it the page-rotation plumbing that existed solely to map raster coordinates onto
 * a rotated render. The renderer no longer needs to know which way the page is turned — pdf.js
 * already applies /Rotate when it paints.
 */
interface PdfSourceViewProps {
  sourceUrl: string;
  page: number;
}

/**
 * A component rather than the constant node it used to be: a constant is built once, at module
 * scope, where there is no hook and therefore no reader. react-pdf takes a `ReactNode` for
 * `loading`, so `<PdfLoading />` is the same value with a place to ask what language to speak.
 */
function PdfLoading() {
  const { t } = useT();
  return (
    <div className="flex min-h-64 items-center justify-center p-6 text-sm text-ink-muted" role="status">
      {t('pdfSource.loading')}
    </div>
  );
}

export default function PdfSourceView({ sourceUrl, page }: PdfSourceViewProps) {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

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
        loading={<PdfLoading />}
        error={
          <div className="p-4">
            <Note tone="alert" role="alert">{t('pdfSource.documentError')}</Note>
          </div>
        }
        onLoadError={(error) => console.error('[document-review-pdf]', error.message)}
      >
        <div className="mx-auto w-fit max-w-full">
          {/* Text and annotation layers stay off on purpose: nothing on this surface is selectable
              any more, an enabled layer would only add weight, and with them off the pdfjs
              stylesheets (raw hex literals, THIRD_PARTY_NOTICES.md) are not needed at all — so
              react-pdf's missing-styles console warnings, which the quality gate counts as
              failures, never fire. */}
          <Page
            pageNumber={page}
            width={containerWidth ?? undefined}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<PdfLoading />}
            error={
              <div className="p-4">
                <Note tone="alert" role="alert">{t('pdfSource.pageError')}</Note>
              </div>
            }
          />
        </div>
      </Document>
    </div>
  );
}
