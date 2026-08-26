import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { documentStatusElapsedLabel, type DocumentUiStatus } from '../lib/documentStatus';
import { ICON } from './ui';

export function DocumentStatusBadge({ status, ...attributes }: {
  status: DocumentUiStatus;
} & Omit<React.ComponentPropsWithoutRef<'span'>, 'children'>) {
  const elapsed = documentStatusElapsedLabel(status.elapsedSeconds);
  return (
    <>
      <span {...attributes} className={`badge-${status.tone} inline-flex items-center gap-1 ${attributes.className ?? ''}`.trim()}
        title={status.description || undefined} role={status.loading ? 'status' : undefined}
        aria-live={status.loading ? 'polite' : undefined} aria-busy={status.loading || undefined}>
          {/* The one spinner in the app that STOPS under reduced motion rather than slowing, and it
            predates this sweep: `documentStatus.spec.tsx` pins it as "makes reduced motion static".
            The general rule (index.css, reduced-motion block) keeps a spinner turning because it is
            the only thing saying the app is alive, and a frozen one reads as a hang. Here it is not:
            the badge prints "ממתין לעיבוד" beside it in words, so the glyph is decoration and may
            stop. The label is what carries the meaning. */}
        {status.loading && <LoaderCircle size={ICON.xs} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {status.state === 'stuck' && <AlertTriangle size={ICON.xs} className="shrink-0" aria-hidden="true" />}
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
      {/* Only when there is a second fact to carry. A state whose description merely repeated the
          badge shipped that repetition to every screen-reader user, on every row. */}
      {status.description ? <span className="sr-only">{status.description}</span> : null}
    </>
  );
}
