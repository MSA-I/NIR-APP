import { RefreshCw } from 'lucide-react';
import { BackAction } from '../components/BackAction';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { DocumentReviewWorkspace } from '../components/document-review/DocumentReviewWorkspace';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { useDocumentProcessing } from '../lib/useDocumentProcessing';

// interpret-document maps every failure to a Hebrew message server-side, so the body is the
// message. Only a transport failure needs the generic mapping.
async function interpretErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: { message?: string } };
      if (body.error?.message) return body.error.message;
    } catch { /* fall through to the generic mapping */ }
  }
  return toHebrewError(error);
}

export default function DocumentReview() {
  const { documentId } = useParams<{ documentId: string }>();
  const [params] = useSearchParams();
  const { profile, organizationAccess } = useAuth();
  const canWrite = organizationAccess?.canWrite ?? true;
  const processing = useDocumentProcessing(documentId ? [documentId] : [], { details: true });
  const snapshot = documentId ? processing.snapshots[documentId] : null;

  // Nothing else in the app calls interpret-document, so without this a job stays at 'extracted'
  // for ever. Triggering on the review screen is also the cheapest cost control there is: nobody
  // pays to interpret a document nobody opened.
  const jobId = canWrite && snapshot?.job?.status === 'extracted' && !snapshot.interpretation
    ? snapshot.job.id
    : null;
  const startedFor = useRef<string | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [interpretError, setInterpretError] = useState<string | null>(null);
  const { refetch } = processing;

  const interpret = useCallback(async (id: string) => {
    setInterpreting(true);
    setInterpretError(null);
    try {
      // The handler is idempotent and short-circuits before the provider call, so a duplicate
      // invocation costs one round trip and zero tokens.
      const response = await supabase.functions.invoke('interpret-document', { body: { jobId: id } });
      if (response.error) setInterpretError(await interpretErrorMessage(response.error));
    } catch (error) {
      setInterpretError(toHebrewError(error));
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

  if (!documentId) return <ErrorNote message="מזהה המסמך חסר." />;
  if (processing.loading || !profile) return <PageLoader />;
  if (processing.error && !snapshot) return <ErrorNote message={processing.error} />;
  if (!snapshot) return <ErrorNote message="המסמך אינו זמין או שאין לך הרשאה לצפות בו." />;

  const returnPath = profile.role === 'supplier' ? '/my-prices' : '/documents';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackAction fallback={returnPath} label="חזרה למסמכים" carrySearch />
        {processing.fetching && (
          <span className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-muted" role="status">
            <RefreshCw className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> מעדכן נתונים
          </span>
        )}
      </div>

      {processing.error && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">{processing.error} הנתונים האחרונים נשארו מוצגים.</span>
          <button type="button" className="btn-secondary" onClick={() => void processing.refetch()}>
            ניסיון נוסף
          </button>
        </Note>
      )}

      {interpreting && (
        <Note tone="info" role="status" className="flex items-center gap-2">
          <RefreshCw className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" />
          <span>מפרש את המסמך…</span>
        </Note>
      )}

      {interpretError && !interpreting && (
        <Note tone="alert" role="alert" className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">{interpretError}</span>
          {/* A retry only makes sense while the job is still 'extracted'. Once the server has
              recorded the failure the job is 'failed', and re-queuing it is the inbox's job. */}
          {jobId ? (
            <button type="button" className="btn-secondary" onClick={() => void interpret(jobId)}>
              ניסיון נוסף
            </button>
          ) : (
            <span className="text-sm">אפשר לשלוח את המסמך לעיבוד מחדש ממסך המסמכים.</span>
          )}
        </Note>
      )}

      <DocumentReviewWorkspace
        snapshot={snapshot}
        role={profile.role}
        actorId={profile.id}
        onRefetch={processing.refetch}
        initialPanel={params.get('panel')}
        readOnly={!canWrite}
      />
    </div>
  );
}
