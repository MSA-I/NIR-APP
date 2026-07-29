import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, FileCheck2, ScanText } from 'lucide-react';
import type { ExtractionContract, Role } from '../../lib/types';
import { supabase } from '../../lib/supabase';
import { DOCUMENT_PROCESSING_STAGE_META } from '../../lib/useDocumentProcessing';
import { Note } from '../ui';
import { DocumentExportPreview } from './DocumentExportPreview';
import { DocumentReviewProposals } from './DocumentReviewProposals';
import { DocumentSourceViewer } from './DocumentSourceViewer';
import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';
import { ReviewTargetEditor } from './ReviewTargetEditor';
import { latestCorrections, resolvedText, type ReviewSnapshot, type ReviewTarget } from './model';

interface DocumentReviewWorkspaceProps {
  snapshot: ReviewSnapshot;
  role: Role;
  actorId: string;
  onRefetch: () => Promise<boolean>;
  initialPanel: string | null;
}

export function DocumentReviewWorkspace({ snapshot, role, actorId, onRefetch, initialPanel }: DocumentReviewWorkspaceProps) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedTarget, setSelectedTarget] = useState<ReviewTarget | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const extraction = snapshot.extraction?.payload ?? null;
  const correctionMap = useMemo(() => latestCorrections(snapshot.reviewCorrections), [snapshot.reviewCorrections]);
  const stageMeta = DOCUMENT_PROCESSING_STAGE_META[snapshot.stage];

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

  useEffect(() => {
    if (!extraction) return;
    setPage((current) => Math.min(Math.max(current, 1), Math.max(1, extraction.document.page_count)));
  }, [extraction]);

  function selectTarget(target: ReviewTarget, returnFocus: HTMLButtonElement) {
    setPage(target.page);
    setSelectedTarget(target);
    returnFocusRef.current = returnFocus;
    window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'nearest',
    }));
  }

  function closeEditor() {
    const returnFocus = returnFocusRef.current;
    setSelectedTarget(null);
    returnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocus?.focus());
  }

  function changePage(nextPage: number) {
    setSelectedTarget(null);
    returnFocusRef.current = null;
    setPage(nextPage);
  }

  function resolveBlockText(block: ExtractionContract['blocks'][number]) {
    return resolvedText(block.text, correctionMap, 'block', block.id);
  }

  function resolveCellText(tableId: string, rowIndex: number, columnIndex: number, original: string) {
    return resolvedText(original, correctionMap, 'table_cell', tableId, rowIndex, columnIndex);
  }

  if (!snapshot.document) {
    return <Note tone="alert" role="alert">המסמך אינו זמין או שאין לך הרשאה לצפות בו.</Note>;
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="document-review-page">
      <section className="card card-pad">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title break-words">בדיקת מסמך</h1>
              <span className={`badge-${stageMeta.tone}`}>{stageMeta.label}</span>
            </div>
            <p className="mt-1 break-words text-sm text-ink-muted">{snapshot.document.file_name}</p>
          </div>
          {snapshot.job && <span className="num max-w-full break-all text-xs text-ink-faint">Job {snapshot.job.id}</span>}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><ScanText size={17} aria-hidden="true" /> חילוץ</div>
            <p className="mt-1 break-words text-sm text-ink-body">{snapshot.extraction ? `${snapshot.extraction.engine} · ${snapshot.extraction.model} ${snapshot.extraction.model_version}` : 'טרם זמין'}</p>
          </div>
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><Cpu size={17} aria-hidden="true" /> פירוש</div>
            <p className="mt-1 break-words text-sm text-ink-body">{snapshot.interpretation ? `${snapshot.interpretation.provider} · ${snapshot.interpretation.model}` : 'טרם זמין'}</p>
          </div>
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><FileCheck2 size={17} aria-hidden="true" /> שכבות בדיקה</div>
            <p className="mt-1 text-sm text-ink-body"><span className="num">{snapshot.reviewCorrections.length}</span> תיקונים · <span className="num">{snapshot.annotations.length}</span> annotations</p>
          </div>
        </div>

        {snapshot.extraction && snapshot.job && (
          <p className="mt-3 break-all text-xs text-ink-faint">
            מקור מאומת: <span dir="ltr" className="num">{snapshot.extraction.input_checksum}</span> · חוזה {snapshot.extraction.contract_version}
          </p>
        )}
      </section>

      {snapshot.stage === 'failed' && (
        <Note tone="alert" role="alert">
          העיבוד נכשל{snapshot.job?.last_error_message ? `: ${snapshot.job.last_error_message}` : '.'} אפשר לחזור לגלריה ולשלוח את המסמך מחדש לתור.
        </Note>
      )}
      {snapshot.stage !== 'review' && snapshot.stage !== 'failed' && (
        <Note tone="info" role="status">המסמך מוצג לקריאה בלבד כל עוד אינו במצב „דורש בדיקה”. הסטטוס מתרענן אוטומטית.</Note>
      )}
      {snapshot.extraction?.payload.document.partial && (
        <Note tone="await" role="status">החילוץ חלקי. יש להשוות כל ערך למקור לפני מתן משוב.</Note>
      )}

      {!snapshot.job && <Note tone="idle">המסמך טרם נשלח לעיבוד.</Note>}
      {snapshot.job && !snapshot.extraction && snapshot.stage !== 'failed' && <Note tone="info">החילוץ עדיין אינו זמין. המסך יתעדכן כאשר תתקבל תוצאה.</Note>}
      {snapshot.extraction && !snapshot.interpretation && snapshot.stage !== 'failed' && <Note tone="info">החילוץ התקבל והפירוש הסמנטי עדיין בעיבוד.</Note>}

      {extraction && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <DocumentSourceViewer
            fileName={snapshot.document.file_name}
            mimeType={snapshot.document.mime_type}
            sourceUrl={sourceUrl}
            sourceError={sourceError}
            extraction={extraction}
            page={page}
            selectedTarget={selectedTarget}
            onPageChange={changePage}
            onSelectTarget={selectTarget}
            resolveBlockText={resolveBlockText}
            resolveCellText={resolveCellText}
          />

          <div className="min-w-0 space-y-5">
            <div ref={editorRef}>
              {selectedTarget ? (
                <ReviewTargetEditor snapshot={snapshot} role={role} target={selectedTarget} onClose={closeEditor} onRefetch={onRefetch} />
              ) : (
                <Note tone="idle">בחר קטע, סימון או תא דרך רשימת המקלדת. אם המקור הוא תמונה, אפשר גם לבחור ישירות מעליו כקיצור מצביע.</Note>
              )}
            </div>
            {snapshot.interpretation && <DocumentReviewProposals snapshot={snapshot} role={role} onRefetch={onRefetch} />}
            {snapshot.document.document_kind === 'price_list'
              && snapshot.interpretation?.payload.document_type === 'price_list'
              && <PriceListReviewConfirmation snapshot={snapshot} role={role} actorId={actorId} onRefetch={onRefetch} />}
            {snapshot.interpretation && role !== 'supplier' && <DocumentExportPreview snapshot={snapshot} actorId={actorId} autoFocus={initialPanel === 'export'} />}
          </div>
        </div>
      )}
    </div>
  );
}
