import { ArrowRight, RefreshCw } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { DocumentReviewWorkspace } from '../components/document-review/DocumentReviewWorkspace';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { useDocumentProcessing } from '../lib/useDocumentProcessing';

export default function DocumentReview() {
  const { documentId } = useParams<{ documentId: string }>();
  const [params] = useSearchParams();
  const { profile } = useAuth();
  const processing = useDocumentProcessing(documentId ? [documentId] : [], { details: true });
  const snapshot = documentId ? processing.snapshots[documentId] : null;

  if (!documentId) return <ErrorNote message="מזהה המסמך חסר." />;
  if (processing.loading || !profile) return <PageLoader />;
  if (processing.error && !snapshot) return <ErrorNote message={processing.error} />;
  if (!snapshot) return <ErrorNote message="המסמך אינו זמין או שאין לך הרשאה לצפות בו." />;

  const returnPath = profile.role === 'supplier' ? '/my-prices' : '/documents';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link className="btn-ghost" to={returnPath}>
          <ArrowRight size={18} aria-hidden="true" /> חזרה למסמכים
        </Link>
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

      <DocumentReviewWorkspace
        snapshot={snapshot}
        role={profile.role}
        actorId={profile.id}
        onRefetch={processing.refetch}
        initialPanel={params.get('panel')}
      />
    </div>
  );
}
