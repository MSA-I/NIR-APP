import { Loader2 } from 'lucide-react';
import { useT } from '../../lib/i18n/LocaleProvider';
import { ICON } from '../ui';
import { documentStatusElapsed, isDocumentProcessingStuck } from '../../lib/documentStatus';
import type { DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';

/**
 * What the seven engineering stages look like to the person who uploaded the file.
 *
 * The raw contract in `DOCUMENT_PROCESSING_STAGE_META` does not change and must not: the SQL
 * suites, the browser scenarios and `documentStage.spec.tsx` all measure it, and a reviewer in
 * front of a stuck job still needs `data-stage`. This is a projection of it, and it exists because
 * the badge alone answered the wrong question. Production measurements: jobs waited 523, 614, 615
 * and 746 seconds in the queue before a worker claimed them, and the screen called all of that
 * "בעיבוד" — so an owner watching an 8-minute-old document had no way to tell a busy queue from a
 * broken upload. Splitting the wait from the work is the whole point.
 *
 * REBUILT 04.09.2026 (owner ruling, from a live phone screenshot): three things and no fourth —
 * a bar that keeps moving, a spinner, and one sentence that changes with the work. The four-disc
 * `LifecycleStrip` went with the ruling: it drew a second, step-counting bar directly above the
 * discs, so a reader watching a document being read met two progress indicators and four labels
 * for one fact. `LifecycleStrip` itself is untouched — an order and an invoice both still use it,
 * where the steps ARE the record's states and a person acts between them. Here nobody acts
 * between the steps; they wait. A waiting screen needs to say what is happening, not enumerate
 * what will.
 */
type StepKey = 'queued' | 'reading' | 'interpreting' | 'review';

function activeStep(status: string): StepKey | null {
  if (status === 'queued' || status === 'awaiting_scan') return 'queued';
  if (status === 'leased') return 'reading';
  if (status === 'extracted' || status === 'interpreting') return 'interpreting';
  if (status === 'review' || status === 'completed') return 'review';
  return null;
}

function seconds(from: string | null | undefined, to: number): number | null {
  if (!from) return null;
  const parsed = Date.parse(from);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((to - parsed) / 1000)) : null;
}

export function DocumentProcessingProgress({ snapshot, now = Date.now() }: {
  snapshot: DocumentProcessingSnapshot;
  now?: number;
}) {
  const { t } = useT();
  const job = snapshot.job;
  // No job is not a step-zero state, it is the absence of the process this strip describes.
  if (!job) return null;

  // Stuck is not "still working". The first screenshot of this strip had the badge saying
  // "עיבוד תקוע" while the bar underneath it kept implying live progress on page 7 of 27 — two
  // claims about the same job on the same screen, and the reassuring one was the false one. A
  // moving bar over a stopped job is that same lie in its purest form, so a stopped job renders
  // NOTHING here: `DocumentStatusBadge` above this component and the failure note below it are
  // where a stopped document is already described, and neither of them animates.
  // `evaluatedAt: now` is not test scaffolding. Without it this call reads the wall clock while
  // everything else reads the injected one, so the same snapshot renders differently depending on
  // when it is rendered — which is how CI caught it: two cases passed locally at 13:53 UTC and
  // failed at 14:09, when a fixture job crossed the two-hour stuck threshold.
  if (job.status === 'failed' || isDocumentProcessingStuck({ job, evaluatedAt: now })) return null;

  const current = activeStep(job.status);
  // 'review' is the absence of work, not the last frame of it. A document waiting for a person has
  // the whole review screen below to say so, and a bar still sweeping over it would say otherwise.
  if (!current || current === 'review') return null;

  const done = job.progress_done;
  const total = job.progress_total;
  // Both counters come through the same two fields, and the server returns them only for the stage
  // the job is in (0143) — so which stage is running decides what the number is counting. Reading
  // counts OCR pages, interpreting counts provider chunks, and a text-layer PDF simply has no
  // reading counter to show.
  const hasProgress = typeof done === 'number' && typeof total === 'number' && total > 0;

  // The counter came BACK into the sentence here, and it had to. It used to live in the bar's
  // `aria-valuetext` because the bar was determinate, and owner ruling 25.08.2026 forbade printing
  // the same count twice ("הפרוגרס בר אמור להחליף את המספרים שמראים התקדמות ולא שיהיה גם זה וגם
  // זה"). The bar no longer measures anything, so there is no second voice left to collide with —
  // and a sentence that never changed while a 27-page document was read is exactly what this
  // rebuild was asked to remove.
  let detail: string;
  if (current === 'queued') {
    // Measured from the upload, which is what the person waiting is measuring too.
    const waitedParts = documentStatusElapsed(job.queue_age_seconds ?? seconds(job.created_at, now));
    const waited = waitedParts ? t(waitedParts.key, waitedParts.vars) : null;
    detail = job.status === 'awaiting_scan'
      ? t('documentProcessingProgress.awaitingScanApproval')
      : waited
        ? t('documentProcessingProgress.queuedWaited', { waited })
        : t('documentProcessingProgress.queuedAutomatic');
  } else if (current === 'reading') {
    // An unknown page count stays unknown. A "0 מתוך 0" here would be a claim about the document
    // that nobody has made yet — the constitution's dash rule, applied to a counter.
    detail = hasProgress
      ? t('documentProcessingProgress.pageProgress', { done: done as number, total: total as number })
      : t('documentProcessingProgress.pageCountUnknown');
  } else {
    detail = hasProgress
      ? t('documentProcessingProgress.chunkProgress', { done: done as number, total: total as number })
      : job.status === 'extracted'
        // Says only what is true in every environment. The server dispatcher runs once a minute in
        // production, but its configuration row is written by hand rather than by a migration
        // (0081:21-22 says so on purpose), so an environment can exist where nothing dispatches and
        // only opening the document starts the work. A sentence promising that it "starts by itself
        // shortly" would be a claim about deployment state this component cannot see.
        ? t('documentProcessingProgress.interpretationNotStarted')
        : t('documentProcessingProgress.chunkCountUnknown');
  }

  const stage = current === 'queued'
    ? t('documentProcessingProgress.queued')
    : current === 'reading'
      ? t('documentProcessingProgress.reading')
      : t('documentProcessingProgress.interpreting');

  return (
    <div className="rounded-2xl bg-surface-sunken p-3" data-testid="document-processing-progress"
      data-step={current}>
      {/* aria-hidden: the bar measures nothing, so it has nothing to announce. The live sentence
          below is where this state is spoken, and it is the sentence that carries the counter. */}
      <div className="processing-track" aria-hidden="true"><span /></div>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-body" role="status" aria-live="polite">
        <Loader2 className="shrink-0 animate-spin text-ink-soft" size={ICON.md} aria-hidden="true" />
        <span className="min-w-0">{stage} — {detail}</span>
      </p>
    </div>
  );
}
