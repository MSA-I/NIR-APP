import { useT } from '../lib/i18n/LocaleProvider';
import { RefreshCw } from 'lucide-react';
import { BackAction } from '../components/BackAction';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { DocumentReviewWorkspace } from '../components/document-review/DocumentReviewWorkspace';
import { DocumentScanPreview } from '../components/document-review/DocumentScanPreview';
import { ErrorNote, ICON, Note, RecordHeader, RecordSkeleton } from '../components/ui';
import { supabase } from '../lib/supabase';
import { isActiveRole } from '../lib/types';
import { useDocumentScanning } from '../lib/useDocumentScanning';
import { DOCUMENT_PROCESSING_CHANGED_EVENT, useDocumentProcessing } from '../lib/useDocumentProcessing';
import type { TKey } from '../lib/i18n/t';

const INTERPRET_ERROR_KEY = {
  unauthenticated: 'documentReviewPage.interpretUnauthenticated',
  not_authorized: 'documentReviewPage.interpretNotAuthorized',
  invalid_request: 'documentReviewPage.interpretInvalidRequest',
  job_unknown: 'documentReviewPage.interpretJobUnknown',
  extraction_unknown: 'documentReviewPage.interpretExtractionUnknown',
  interpretation_in_progress: 'documentReviewPage.interpretationInProgress',
  invalid_job_state: 'documentReviewPage.interpretInvalidJobState',
  unsupported_extraction_contract: 'documentReviewPage.interpretUnsupportedContract',
  context_unavailable: 'documentReviewPage.interpretContextUnavailable',
  provider_payload_too_large: 'documentReviewPage.interpretPayloadTooLarge',
  provider_timeout: 'documentReviewPage.interpretProviderTimeout',
  provider_rate_limited: 'documentReviewPage.interpretProviderRateLimited',
  provider_unavailable: 'documentReviewPage.interpretProviderUnavailable',
  provider_rejected: 'documentReviewPage.interpretProviderRejected',
  provider_output_truncated: 'documentReviewPage.interpretProviderOutputTruncated',
  provider_invalid_output: 'documentReviewPage.interpretProviderInvalidOutput',
  interpretation_conflict: 'documentReviewPage.interpretationConflict',
  persistence_failed: 'documentReviewPage.interpretPersistenceFailed',
  service_unavailable: 'documentReviewPage.interpretServiceUnavailable',
} as const satisfies Record<string, TKey>;
type InterpretErrorCode = keyof typeof INTERPRET_ERROR_KEY;

interface InterpretFailure {
  code: InterpretErrorCode | null;
  rawMessage: string | null;
  fallbackError: unknown | null;
}

async function interpretFailure(error: unknown): Promise<InterpretFailure> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: { code?: string; message?: string } };
      const code = body.error?.code;
      if (code && code in INTERPRET_ERROR_KEY) {
        return { code: code as InterpretErrorCode, rawMessage: null, fallbackError: null };
      }
      if (body.error?.message) return { code: null, rawMessage: body.error.message, fallbackError: null };
    } catch { /* fall through to the generic mapping */ }
  }
  return { code: null, rawMessage: null, fallbackError: error };
}

export default function DocumentReview() {
  const { errorText, t } = useT();
  const { documentId } = useParams<{ documentId: string }>();
  const [params] = useSearchParams();
  const { profile, organizationAccess } = useAuth();
  const canWrite = organizationAccess?.canWrite ?? true;
  const processing = useDocumentProcessing(documentId ? [documentId] : [], { details: true });
  const scanning = useDocumentScanning(documentId ? [documentId] : []);
  const snapshot = documentId ? processing.snapshots[documentId] : null;
  const scanState = documentId ? scanning.states[documentId] : null;
  const showExtractedResultFirst = Boolean(scanState?.accepted && snapshot?.interpretation);

  // Nothing else in the app calls interpret-document, so without this a job stays at 'extracted'
  // for ever. Triggering on the review screen is also the cheapest cost control there is: nobody
  // pays to interpret a document nobody opened.
  const jobId = canWrite && snapshot?.job?.status === 'extracted' && !snapshot.interpretation
    ? snapshot.job.id
    : null;
  const startedFor = useRef<string | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  /**
   * The failed attempt, tagged with the job it was about.
   *
   * It used to be a bare string cleared only inside `interpret` and `reprocess`, which meant the
   * alert belonged to no state at all: a refetch that moved the job forward took the retry button
   * away — the old comment beside it admitted as much — and left the sentence standing over a
   * document that had already been read. An alert has to name what it is an alert about, or there
   * is nothing to compare against the server's answer.
   */
  const [interpretError, setInterpretError] = useState<(InterpretFailure & { jobId: string }) | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueError, setEnqueueError] = useState<unknown | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  /** Reprocessing failed as a request. Separate state, because it is not about a job that is
   *  waiting to be read — clearing it on pipeline movement would erase the only report a person
   *  gets that their button did nothing. */
  const [reprocessError, setReprocessError] = useState<unknown | null>(null);
  const { refetch } = processing;

  const enqueue = useCallback(async () => {
    if (!documentId || !canWrite) return;
    setEnqueuing(true);
    setEnqueueError(null);
    try {
      const result = await supabase.rpc('enqueue_document_processing', { p_document_id: documentId });
      if (result.error) throw result.error;
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await refetch();
    } catch (error) {
      setEnqueueError(error);
    } finally {
      setEnqueuing(false);
    }
  }, [canWrite, documentId, refetch]);

  const reprocess = useCallback(async () => {
    if (!documentId || !canWrite) return;
    setReprocessing(true);
    setReprocessError(null);
    try {
      const result = await supabase.rpc('reprocess_document', {
        p_document_id: documentId,
        p_reason: 'עיבוד מחדש ממסך בדיקת המסמך לאחר כשל',
      });
      if (result.error) throw result.error;
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await refetch();
    } catch (error) {
      setReprocessError(error);
    } finally {
      setReprocessing(false);
    }
  }, [canWrite, documentId, refetch]);

  const interpret = useCallback(async (id: string) => {
    setInterpreting(true);
    setInterpretError(null);
    try {
      // The handler is idempotent and short-circuits before the provider call, so a duplicate
      // invocation costs one round trip and zero tokens.
      const response = await supabase.functions.invoke('interpret-document', { body: { jobId: id } });
      if (response.error) setInterpretError({ jobId: id, ...await interpretFailure(response.error) });
    } catch (error) {
      setInterpretError({ jobId: id, code: null, rawMessage: null, fallbackError: error });
    } finally {
      setInterpreting(false);
      await refetch();
    }
  }, [refetch]);

  useEffect(() => {
    // Fire once per job. A failure deliberately does not auto-retry -- the button below is the
    // only way to spend again.
    if (!jobId || startedFor.current === jobId) return;
    startedFor.current = jobId;
    void interpret(jobId);
  }, [jobId, interpret]);

  const currentJob = snapshot?.job ?? null;
  const hasInterpretation = Boolean(snapshot?.interpretation);
  useEffect(() => {
    // The alert describes one attempt to read one job that was waiting at 'extracted'. The moment
    // the server reports that job somewhere else -- a retry landed, the inbox interpreted it, it
    // was sent back for reprocessing, or it failed and the workspace's failure note took over --
    // the sentence is about a state the document has left. It goes with the state it belongs to.
    if (!interpretError) return;
    const stillWaiting = currentJob?.id === interpretError.jobId
      && currentJob.status === 'extracted'
      && !hasInterpretation;
    if (!stillWaiting) setInterpretError(null);
  }, [interpretError, currentJob, hasInterpretation]);

  const interpretErrorText = interpretError
    ? interpretError.code
      ? t(INTERPRET_ERROR_KEY[interpretError.code])
      : interpretError.rawMessage ?? errorText(interpretError.fallbackError)
    : null;

  if (!documentId) return <ErrorNote message={t('documentReviewPage.message')} />;
  if (processing.loading || scanning.loading || !profile) return <RecordSkeleton />;
  if (!isActiveRole(profile.role)) return <ErrorNote message={t('documentReviewPage.message_2')} />;
  if (processing.error && !snapshot) return <ErrorNote message={processing.error} />;
  if (!snapshot) return <ErrorNote message={t('documentReviewPage.message_3')} />;

  const workspace = (
    <DocumentReviewWorkspace
      snapshot={snapshot}
      actorId={profile.id}
      onRefetch={processing.refetch}
      initialPanel={params.get('panel')}
      readOnly={!canWrite}
      reprocessing={reprocessing}
      onReprocess={() => void reprocess()}
    />
  );

  return (
    <div className="min-w-0 space-y-4">
      {/* RecordHeader, not PageHeader: this screen is ONE document, and the file name is the
          record's identity rather than a page subtitle. It also keeps the catalogue description
          out — PageHeader would have added a sentence this header did not have before. */}
      <RecordHeader
        breadcrumbs={
          /* Was `hidden lg:inline-flex`. Below 1024px — the primary target — that left the phone
             with no way out of this screen but the browser's own back gesture, on the one screen
             a person reaches by tapping a row in a list they want to return to. `btn-ghost` is a
             44px inline target at every width, so there was nothing to hide it for. */
          <BackAction fallback="/documents" label={t('documentReviewPage.label')} carrySearch />
        }
        title={t('documentReviewPage.title')}
        meta={<span className="min-w-0 break-words"><bdi>{snapshot.document?.file_name ?? t('documentReviewPage.text_2')}</bdi></span>}
        secondaryActions={processing.fetching ? (
          <span className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-muted" role="status">
            <RefreshCw className="animate-spin" size={ICON.md} aria-hidden="true" /> {t('documentReviewPage.updatingData')}
          </span>
        ) : undefined}
      />

      {processing.error && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">{processing.error}{' '}{t('documentReviewPage.latestDataRemain')}</span>
          <button type="button" className="btn-secondary" onClick={() => void processing.refetch()}>
            {t('documentReviewPage.text_3')}
          </button>
        </Note>
      )}

      {scanning.error && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">{scanning.error}</span>
          <button type="button" className="btn-secondary" onClick={() => void scanning.refetch()}>
            {t('documentReviewPage.text_4')}
          </button>
        </Note>
      )}

      {snapshot.stage === 'unprocessed' && (
        <Note tone={enqueueError ? 'alert' : 'info'} role={enqueueError ? 'alert' : 'status'} className="flex-wrap">
          <span className="min-w-0 flex-1">
            {enqueueError ? errorText(enqueueError) : (canWrite
              ? t('documentReviewPage.text_5')
              : t('documentReviewPage.text_6'))}
          </span>
          {canWrite && (
            <button type="button" className="btn-primary min-h-11" disabled={enqueuing} onClick={() => void enqueue()}>
              <RefreshCw className={enqueuing ? 'animate-spin ' : ''} size={ICON.md} aria-hidden="true" />
              {enqueuing ? t('documentReviewPage.text_7') : t('documentReviewPage.text_8')}
            </button>
          )}
        </Note>
      )}

      {interpreting && (
        <Note tone="info" role="status" className="flex items-center gap-2">
          <RefreshCw className="animate-spin" size={ICON.md} aria-hidden="true" />
          <span>{t('documentReviewPage.text_9')}</span>
        </Note>
      )}

      {reprocessError != null && <Note tone="alert" role="alert">{errorText(reprocessError)}</Note>}

      {interpretError && !interpreting && (
        <Note tone="alert" role="alert" className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">{interpretErrorText}</span>
          {/* The alert and its retry now live and die together: the effect above drops the alert
              as soon as the job stops waiting, which is the same moment `jobId` becomes null. The
              old fallback sentence — "אפשר לשלוח את המסמך לעיבוד מחדש ממסך המסמכים" — existed only
              to cover the gap where the message outlived its button. */}
          {jobId && (
            <button type="button" className="btn-secondary" onClick={() => void interpret(jobId)}>
              {t('documentReviewPage.text_10')}
            </button>
          )}
        </Note>
      )}

      {showExtractedResultFirst && workspace}

      {scanState && snapshot.document && (
        <DocumentScanPreview
          state={scanState}
          originalStoragePath={snapshot.document.storage_path}
          fileName={snapshot.document.file_name}
          readOnly={!canWrite}
          onChanged={async () => {
            await Promise.all([scanning.refetch(), processing.refetch()]);
            return true;
          }}
        />
      )}

      {(!scanState || (scanState.accepted && !showExtractedResultFirst)) && workspace}
    </div>
  );
}
