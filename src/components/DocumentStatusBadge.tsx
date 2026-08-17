import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { documentStatusElapsedLabel, type DocumentUiStatus } from '../lib/documentStatus';

export function DocumentStatusBadge({ status, ...attributes }: {
  status: DocumentUiStatus;
} & Omit<React.ComponentPropsWithoutRef<'span'>, 'children'>) {
  const elapsed = documentStatusElapsedLabel(status.elapsedSeconds);
  return (
    <>
      <span {...attributes} className={`badge-${status.tone} inline-flex items-center gap-1 ${attributes.className ?? ''}`.trim()}
        title={status.description} role={status.loading ? 'status' : undefined}
        aria-live={status.loading ? 'polite' : undefined} aria-busy={status.loading || undefined}>
        {status.loading && <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {status.state === 'stuck' && <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />}
        {status.label}
      </span>
      {/* The page counter, wherever the badge is. The lifecycle strip that shows it lives on the
          review screen only, so somebody watching an upload from the inbox or the upload centre saw
          "בעיבוד · 4 דק׳" and had no way to tell a busy queue from a stalled read. */}
      {status.progressLabel && (
        <span className="num text-xs text-ink-muted" data-document-status-progress>· {status.progressLabel}</span>
      )}
      {elapsed && (status.loading || status.state === 'stuck') && (
        <span className="num text-xs text-ink-muted" data-document-status-age>· {elapsed}</span>
      )}
      <span className="sr-only">{status.description}</span>
    </>
  );
}
