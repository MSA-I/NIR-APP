import { useEffect, useState } from 'react';
import { FileCheck2, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { openReservedPopup } from '../../lib/popup';
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
    void supabase.storage.from('documents').createSignedUrl(snapshot.document.storage_path, 600).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.signedUrl) {
        console.error('[document-review-source]', error?.message ?? 'signed URL missing');
        setSourceError('לא ניתן לטעון תצוגה מאובטחת של המקור. אפשר לנסות לרענן את המסך.');
        return;
      }
      setSourceUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [snapshot.document?.storage_path]);

  async function openSource() {
    const storagePath = snapshot.document?.storage_path;
    if (!storagePath) return;
    setOpeningSource(true);
    const result = await openReservedPopup(async () => {
      const { data, error } = await supabase.storage
        .from('documents')
        .createSignedUrl(storagePath, 300);
      if (error || !data?.signedUrl) throw error ?? new Error('signed URL missing');
      return data.signedUrl;
    });
    setOpeningSource(false);
    if (result === 'blocked') toast('הדפדפן חסם את פתיחת המסמך. יש לאפשר חלונות קופצים ולנסות שוב.', 'error');
    if (result === 'error') toast('לא ניתן ליצור קישור מאובטח חדש למסמך. יש לנסות שוב.', 'error');
  }

  useEffect(() => {
    if (!extraction) return;
    setPage((current) => Math.min(Math.max(current, 1), Math.max(1, extraction.document.page_count)));
  }, [extraction]);

  if (!snapshot.document) {
    return <Note tone="alert" role="alert">המסמך אינו זמין או שאין לך הרשאה לצפות בו.</Note>;
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="document-review-page">
      <section className="card card-pad">
        {/* One h1 per page, and it belongs to the page. `DocumentReview` renders "בדיקת מסמך" and
            the file name above this card, and renders them even while a scan is still waiting and
            this workspace does not mount at all — so the copy here was the second h1 and the
            second file name on the same screen. This card owns one thing: where the document is. */}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title">מצב המסמך</h2>
          {/* The strip below is the single place this screen says how far the document got. While
              a job is in flight the badge said it again, and `DocumentStatusBadge` carries the page
              counter for the surfaces that have no strip (the folder, the upload centre) — so
              "עמוד 7 מתוך 27" was rendered twice, from two code paths, a few pixels apart. The
              badge stays for every state the strip cannot express: not sent yet, stuck, failed,
              filed, archived. It steps aside only while the strip is telling the story. */}
          {!uiStatus.loading && <DocumentStatusBadge status={uiStatus} data-stage={snapshot.stage} />}
        </div>

        {/* Above the review layers on purpose: while a document is still being read there is
            nothing to review, and "where is it now" is the only question the screen can answer. */}
        <div className="mt-4">
          <DocumentProcessingProgress snapshot={snapshot} />
        </div>

        {/* "0 תיקונים · 0 הערות" is the ordinary case, and it took a box on the first screen of
            every review to say that nothing happened. The tile now appears once there is a layer
            to report; its absence carries the same information without spending the space. */}
        {(snapshot.reviewCorrections.length > 0 || snapshot.annotations.length > 0) && (
          <div className="mt-4 rounded-lg bg-surface-sunken p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><FileCheck2 size={ICON.md} aria-hidden="true" /> שכבות בדיקה</div>
            <p className="mt-1 text-sm text-ink-body"><span className="num">{snapshot.reviewCorrections.length}</span> תיקונים · <span className="num">{snapshot.annotations.length}</span> הערות</p>
          </div>
        )}
      </section>

      {snapshot.stage === 'failed' && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">
            <strong>העיבוד נכשל.</strong>{' '}
            {t(documentProcessingFailureKey(snapshot.job?.last_error_code, snapshot.job?.last_error_message))}
          </span>
          {!readOnly && onReprocess && (
            <button type="button" className="btn-secondary" disabled={reprocessing} onClick={onReprocess}>
              <RefreshCw className={reprocessing ? 'animate-spin ' : ''} size={ICON.md} aria-hidden="true" />
              {reprocessing ? 'שולח מחדש…' : 'עיבוד מחדש'}
            </button>
          )}
        </Note>
      )}
      {/* The old wording narrated the heuristic ("לפי הגיל ומספר הניסיונות שנשמרו בשרת").
          documentUiStatus already carries the reason; the alert only has to name the next move. */}
      {uiStatus.state === 'stuck' && (
        <Note tone="alert" role="alert">העיבוד נעצר. אפשר לטפל בו במרכז תפעול המסמכים.</Note>
      )}
      {snapshot.extraction?.payload.document.partial && (
        <Note tone="await" role="status">החילוץ חלקי. יש להשוות כל ערך למקור לפני מתן משוב.</Note>
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

      {/* Below `xl` the decision column comes first, for every document kind — not only for a price
          list, which is how this started.
          On a phone the two columns are one column, and the source viewer is a full-width page
          image with no height cap: an invoice review opened onto ~750px of scan before the first
          word about what the machine concluded. The findings, the supplier, the order and "מה יקרה
          באישור" are what a reviewer reads first; the document is what they consult when one of
          those makes them doubt, and it is still on the same screen, one scroll down.
          DOM order is unchanged — only the visual order moves — so `order` is applied to the grid
          children and the reading order a screen reader follows stays source-then-decision. */}
      {extraction && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <div className="order-2 min-w-0 xl:order-1">
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

          <div className="order-1 min-w-0 space-y-5 xl:order-2">
            {snapshot.packet ? (
              <DocumentPacketReview snapshot={snapshot} readOnly={readOnly} onRefetch={onRefetch} />
            ) : readOnly ? (
              <Note tone="idle">המסמך ותוצאות העיבוד זמינים לצפייה. פעולות בדיקה ועדכון אינן זמינות במצב קריאה בלבד.</Note>
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
