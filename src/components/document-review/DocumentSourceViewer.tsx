import { lazy, Suspense } from 'react';
import { ExternalLink, FileText, Loader2 } from 'lucide-react';
import { ICON, Note } from '../ui';
import { useT } from '../../lib/i18n/LocaleProvider';

// Lazy on purpose: pdf.js is ~1MB of rendering engine that image documents never need. The
// import happens only when a PDF actually reaches the viewer, and lands in its own chunk.
const PdfSourceView = lazy(() => import('./PdfSourceView'));

/**
 * The document, as the person uploaded it — and nothing the machine wrote on top of it.
 *
 * This surface used to carry the extraction: a translucent box per OCR block and mark drawn over
 * the page, a per-page list of those blocks and marks with a confidence grade and a bounding-box
 * position on each, and the visual tables. The owner named it directly, twice: "כשאני מעלה מסמך
 * אנחנו לא אמורים לראות את כל הprocess של ה-OCR", and then, pointing at the boxes themselves,
 * "בפירוש אין צורך לראות את הקווים הכחולים הללו". A bookkeeper checking an invoice compares the
 * proposal against the document with their own eyes; block ids and page coordinates are the
 * engine talking about itself.
 *
 * What went with the overlay, and is worth stating plainly rather than discovering later: the
 * block-by-block raw-text correction (ReviewTargetEditor) had no other entry point, so it is gone
 * too — a deliberate trade the owner accepted, not an oversight. Deciding on the interpretation —
 * supplier, document type, fields, approve/correct/reject — never lived here; it lives in
 * DocumentReviewProposals and is untouched. The numbers themselves are still reachable, folded,
 * inside "פרטים טכניים" on the workspace, which is where support needs them.
 *
 * The page picker stayed. It is not extraction data: a two-page PDF whose second page cannot be
 * reached is a document the reviewer cannot read. It appears only when there is more than one
 * page to move between.
 */
interface DocumentSourceViewerProps {
  fileName: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sourceError: string | null;
  openingSource: boolean;
  pageCount: number;
  page: number;
  onPageChange: (page: number) => void;
  onOpenSource: () => void;
}

export function DocumentSourceViewer({
  fileName,
  mimeType,
  sourceUrl,
  sourceError,
  openingSource,
  pageCount,
  page,
  onPageChange,
  onOpenSource,
}: DocumentSourceViewerProps) {
  const { t } = useT();
  const isImage = mimeType?.startsWith('image/') ?? false;
  const isPdf = mimeType === 'application/pdf';
  const hasPages = pageCount > 1;

  return (
    <section className="min-w-0 space-y-4" data-testid="document-source-viewer" aria-labelledby="document-source-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="document-source-title" className="section-title">{t('documentSourceViewer.title')}</h2>
          <p className="mt-1 break-words text-sm text-ink-muted">{fileName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Only when there is somewhere to go. A lone "עמוד 1" is a control that does nothing. */}
          {hasPages && (
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-soft">
              <span>{t('documentSourceViewer.page')}</span>
              <select
                className="input min-w-0 sm:min-w-24"
                value={page}
                onChange={(event) => onPageChange(Number(event.target.value))}
              >
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
                  <option key={number} value={number}>{t('documentSourceViewer.pageOf', { page: number, count: pageCount })}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn-secondary" disabled={openingSource} onClick={onOpenSource}>
            {openingSource
            ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />
              : <ExternalLink size={ICON.md} aria-hidden="true" />}
            {openingSource ? t('documentSourceViewer.opening') : t('documentSourceViewer.openSource')}
          </button>
        </div>
      </div>

      {sourceError && <Note tone="alert" role="alert">{sourceError}</Note>}

      <div className="card overflow-hidden">
        {sourceUrl && isImage ? (
          <div className="mx-auto w-full max-w-4xl bg-surface-sunken">
            <img className="block h-auto w-full" src={sourceUrl} alt={t('documentSourceViewer.imageAlt', { fileName })} />
          </div>
        ) : sourceUrl && isPdf ? (
          <Suspense
            fallback={
              <div className="flex min-h-64 items-center justify-center p-6 text-sm text-ink-muted" role="status">
                {t('documentSourceViewer.loadingPdf')}
              </div>
            }
          >
            <PdfSourceView sourceUrl={sourceUrl} page={page} />
          </Suspense>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-ink-muted">
            <FileText size={ICON.hero} aria-hidden="true" />
            <p>{sourceUrl ? t('documentSourceViewer.noPreview') : t('documentSourceViewer.loadingSource')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
