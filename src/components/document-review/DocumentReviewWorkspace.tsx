import { useEffect, useState } from 'react';
import { FileCheck2, RefreshCw } from 'lucide-react';
import { openReservedPopup } from '../../lib/popup';
import { signedDocumentSourceUrl } from '../../lib/documentSource';
import { useT } from '../../lib/i18n/LocaleProvider';
import { documentProcessingFailureKey, documentUiStatus } from '../../lib/documentStatus';
import { ICON, Note, useToast } from '../ui';
import { DocumentStatusBadge } from '../DocumentStatusBadge';
import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';
import { DocumentExportPreview } from './DocumentExportPreview';
import { DocumentPacketReview } from './DocumentPacketReview';
import { DocumentProcessingProgress } from './DocumentProcessingProgress';
import { DocumentReviewProposals } from './DocumentReviewProposals';
import { DocumentSourceViewer } from './DocumentSourceViewer';
import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';
import type { ReviewSnapshot } from './model';

interface DocumentReviewWorkspaceProps {
  snapshot: ReviewSnapshot;
  actorId: string;
  onRefetch: () => Promise<boolean>;
  initialPanel: string | null;
  readOnly?: boolean;
  reprocessing?: boolean;
  onReprocess?: () => void;
}

export function DocumentReviewWorkspace({ snapshot, actorId, onRefetch, initialPanel, readOnly = false, reprocessing = false, onReprocess }: DocumentReviewWorkspaceProps) {
  const { t } = useT();
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openingSource, setOpeningSource] = useState(false);
  const [page, setPage] = useState(1);
  const toast = useToast();
  const isPriceList = snapshot.interpretation?.payload.document_type === 'price_list';
  const extraction = snapshot.extraction?.payload ?? null;
  const uiStatus = documentUiStatus({ status: snapshot.stage, job: snapshot.job, document: snapshot.document });

  useEffect(() => {
    let cancelled = false;
    setSourceUrl(null);
    setSourceError(null);
    if (!snapshot.document?.storage_path) return;
    void signedDocumentSourceUrl(
      snapshot.document.storage_path,
      600,
      snapshot.document.mime_type,
    ).then((signedUrl) => {
      if (cancelled) return;
      setSourceUrl(signedUrl);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.error('[document-review-source]', error instanceof Error ? error.message : 'signed URL missing');
      setSourceError(t('docWorkspace.setSourceError'));
    });
    return () => { cancelled = true; };
  }, [snapshot.document?.storage_path]);

  async function openSource() {
    const storagePath = snapshot.document?.storage_path;
    if (!storagePath) return;
    setOpeningSource(true);
    const result = await openReservedPopup(async () => {
      return signedDocumentSourceUrl(storagePath, 300, snapshot.document?.mime_type ?? null);
    });
    setOpeningSource(false);
    if (result === 'blocked') toast(t('docWorkspace.toast'), 'error');
    if (result === 'error') toast(t('docWorkspace.toast_2'), 'error');
  }

  useEffect(() => {
    if (!extraction) return;
    setPage((current) => Math.min(Math.max(current, 1), Math.max(1, extraction.document.page_count)));
  }, [extraction]);

  if (!snapshot.document) {
    return <Note tone="alert" role="alert">{t('docWorkspace.text_2')}</Note>;
  }

  return (
    <div className="min-w-0 space-y-4" data-testid="document-review-page">
      {/* A live process and a settled state answer different questions. The live strip names its
          own work and count; adding a "מצב המסמך" heading and badge above it repeats the same fact.
          Settled states need only one compact label/value row, not an otherwise empty card. */}
      {uiStatus.loading ? (
        <div data-testid="document-live-status">
          <DocumentProcessingProgress snapshot={snapshot} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-1" data-testid="document-static-status">
          <span className="text-sm font-medium text-ink-soft">{t('docWorkspace.text_3')}</span>
          <DocumentStatusBadge status={uiStatus} data-stage={snapshot.stage} />
        </div>
      )}

      {/* "0 תיקונים · 0 הערות" is the ordinary case. Render this only when it carries evidence. */}
      {(snapshot.reviewCorrections.length > 0 || snapshot.annotations.length > 0) && (
        <div className="rounded-lg bg-surface-sunken p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><FileCheck2 size={ICON.md} aria-hidden="true" /> {t('docWorkspace.text_4')}</div>
          <p className="mt-1 text-sm text-ink-body"><span className="num">{snapshot.reviewCorrections.length}</span> {t('docWorkspace.text_5')} <span className="num">{snapshot.annotations.length}</span> {t('docWorkspace.text_6')}</p>
        </div>
      )}

      {snapshot.stage === 'failed' && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">
            <strong>{t('docWorkspace.text_29')}</strong>{' '}
            {t(documentProcessingFailureKey(snapshot.job?.last_error_code, snapshot.job?.last_error_message))}
          </span>
          {!readOnly && onReprocess && (
            <button type="button" className="btn-secondary" disabled={reprocessing} onClick={onReprocess}>
              <RefreshCw className={reprocessing ? 'animate-spin ' : ''} size={ICON.md} aria-hidden="true" />
              {reprocessing ? t('docWorkspace.text_30') : t('docWorkspace.text_31')}
            </button>
          )}
        </Note>
      )}
      {/* The old wording narrated the heuristic ("לפי הגיל ומספר הניסיונות שנשמרו בשרת").
          documentUiStatus already carries the reason; the alert only has to name the next move. */}
      {uiStatus.state === 'stuck' && (
        <Note tone="alert" role="alert">{t('docWorkspace.text_32')}</Note>
      )}
      {snapshot.extraction?.payload.document.partial && (
        <Note tone="await" role="status">{t('docWorkspace.text_33')}</Note>
      )}

      {/* Four notes stood here and none of them survived, because each one was the strip's sentence
          said a second time — and each one outlived the state it described:
          · "המסמך בעיבוד ומוצג כרגע לקריאה בלבד" — while a document is being read there is nothing
            on screen to edit, so the read-only half claimed a restriction that does not exist.
          · "המסמך טרם נשלח לעיבוד" — `DocumentReview` already says this above, with the button
            that does something about it.
          · "החילוץ עדיין אינו זמין. המסך יתעדכן כאשר תתקבל תוצאה." — not gated on stuck, so a job
            that had stopped moving showed the alert AND a promise that it would update by itself.
          · "החילוץ התקבל והפירוש הסמנטי עדיין בעיבוד." — not gated on review/completed, so a
            document whose interpretation never arrived kept claiming work was under way.
          The strip above answers all four from the job the server actually reports, and it is the
          only surface on this screen that may claim work is in progress. */}

      {/* The evidence precedes the decision on a phone. The old visual order asked for approval
          before showing the document being approved. Desktop keeps the two columns side by side;
          DOM and visual reading order now agree at every width. */}
      {extraction && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <div className="order-1 min-w-0 xl:order-1">
            <DocumentSourceViewer
              fileName={snapshot.document.file_name}
              mimeType={snapshot.document.mime_type}
              sourceUrl={sourceUrl}
              sourceError={sourceError}
              openingSource={openingSource}
              pageCount={extraction.document.page_count}
              page={page}
              onPageChange={setPage}
              onOpenSource={() => void openSource()}
            />
          </div>

          <div className="order-2 min-w-0 space-y-4 xl:order-2">
            {snapshot.packet ? (
              <DocumentPacketReview snapshot={snapshot} readOnly={readOnly} onRefetch={onRefetch} />
            ) : readOnly ? (
              <Note tone="idle">{t('docWorkspace.text_34')}</Note>
            ) : isPriceList
              ? <PriceListReviewConfirmation snapshot={snapshot} actorId={actorId} onRefetch={onRefetch} />
              : snapshot.interpretation && (
                <>
                  <DocumentAssessmentPanel
                    documentId={snapshot.document.id}
                    onApplied={() => { void onRefetch(); }}
                  />
                  <DocumentReviewProposals snapshot={snapshot} onRefetch={onRefetch} />
                </>
              )}
            {!readOnly && snapshot.interpretation && !isPriceList
              && <DocumentExportPreview snapshot={snapshot} actorId={actorId} autoFocus={initialPanel === 'export'} />}
          </div>
        </div>
      )}
    </div>
  );
}
