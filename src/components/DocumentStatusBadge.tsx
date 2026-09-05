import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useT } from '../lib/i18n/LocaleProvider';
import type { DocumentUiStatus } from '../lib/documentStatus';
import { ICON } from './ui';

export function DocumentStatusBadge({ status, ...attributes }: {
  status: DocumentUiStatus;
} & Omit<React.ComponentPropsWithoutRef<'span'>, 'children'>) {
  const { t } = useT();
  if (!status.badgeVisible) return null;
  // The badge is where a status stops being a decision and becomes words, so it is where the keys
  // resolve. `documentStatus.ts` decides WHICH state this is; it no longer decides in what
  // language, which is what let the same module be read by a screen, a spec and a spreadsheet.
  const description = status.descriptionKey ? t(status.descriptionKey, status.descriptionVars) : '';
  return (
    <>
      <span {...attributes} className={`badge-${status.tone} inline-flex items-center gap-1 ${attributes.className ?? ''}`.trim()}
        title={description || undefined} role={status.loading ? 'status' : undefined}
        aria-live={status.loading ? 'polite' : undefined} aria-busy={status.loading || undefined}>
          {/* The one spinner in the app that STOPS under reduced motion rather than slowing, and it
            predates this sweep: `documentStatus.spec.tsx` pins it as "makes reduced motion static".
            The general rule (index.css, reduced-motion block) keeps a spinner turning because it is
            the only thing saying the app is alive, and a frozen one reads as a hang. Here it is not:
            the badge prints "ממתין לעיבוד" beside it in words, so the glyph is decoration and may
            stop. The label is what carries the meaning. */}
        {status.loading && <LoaderCircle size={ICON.xs} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {status.state === 'stuck' && <AlertTriangle size={ICON.xs} className="shrink-0" aria-hidden="true" />}
        {t(status.labelKey)}
      </span>
      {/* Only when there is a second fact to carry. A state whose description merely repeated the
          badge shipped that repetition to every screen-reader user, on every row. */}
      {description ? <span className="sr-only">{description}</span> : null}
    </>
  );
}
