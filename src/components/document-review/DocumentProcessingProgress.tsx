import { LifecycleStrip, type LifecycleStep } from '../ui';
import { documentStatusElapsedLabel, isDocumentProcessingStuck } from '../../lib/documentStatus';
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
 * broken upload. Splitting the wait from the work is the whole point of the first two steps.
 */
const STEPS: readonly LifecycleStep[] = [
  { key: 'queued', label: 'ממתין בתור' },
  { key: 'reading', label: 'קריאת המסמך' },
  { key: 'interpreting', label: 'פירוש הנתונים' },
  { key: 'review', label: 'מוכן לבדיקה' },
];

type StepKey = 'queued' | 'reading' | 'interpreting' | 'review';

function activeStep(status: string): StepKey | null {
  if (status === 'queued' || status === 'awaiting_scan') return 'queued';
  if (status === 'leased') return 'reading';
  if (status === 'extracted' || status === 'interpreting') return 'interpreting';
  if (status === 'review' || status === 'completed') return 'review';
  return null;
}

/**
 * Which step a failed job stopped at, from evidence rather than from the error string alone.
 *
 * `status` is flattened to 'failed' on the way down, so the stage is gone. What survives is the
 * extraction row: if the document was read, the failure happened after reading. `attempt_count`
 * covers the third case — a job that failed before any worker ever claimed it never left the queue.
 */
function stoppedStep(snapshot: DocumentProcessingSnapshot): StepKey {
  if (snapshot.extraction) return 'interpreting';
  if ((snapshot.job?.attempt_count ?? 0) === 0) return 'queued';
  return 'reading';
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
  const job = snapshot.job;
  // No job is not a step-zero state, it is the absence of the process this strip describes.
  if (!job) return null;

  // Stuck is not "still working". The first screenshot of this strip had the badge saying
  // "עיבוד תקוע" while the bar underneath it kept implying live progress on page 7 of 27 -- two
  // claims about the same job on the same screen, and the reassuring one was the false one. A
  // stuck job stops the same way a failed one does; only the wording differs, and that wording
  // already lives in the badge and the note beside it.
  // `evaluatedAt: now` is not test scaffolding. Without it this call reads the wall clock while
  // everything else on the strip reads the injected one, so the same snapshot renders differently
  // depending on when it is rendered -- which is how CI caught it: two cases passed locally at
  // 13:53 UTC and failed at 14:09, when a fixture job crossed the two-hour stuck threshold.
  const stopped = job.status === 'failed' || isDocumentProcessingStuck({ job, evaluatedAt: now });
  const current = stopped ? stoppedStep(snapshot) : activeStep(job.status);
  if (!current) return null;

  const done = job.progress_done;
  const total = job.progress_total;
  const hasProgress = current === 'reading' && !stopped
    && typeof done === 'number' && typeof total === 'number' && total > 0;

  let detail: string | null = null;
  if (stopped) {
    detail = null;
  } else if (current === 'queued') {
    // Measured from the upload, which is what the person waiting is measuring too.
    const waited = documentStatusElapsedLabel(
      job.queue_age_seconds ?? seconds(job.created_at, now),
    );
    detail = job.status === 'awaiting_scan'
      ? 'הסריקה ממתינה לאישור לפני שהקריאה מתחילה.'
      : waited
        ? `ממתין ${waited} לעובד פנוי. העבודה מתחילה מאליה.`
        : 'ממתין לעובד פנוי. העבודה מתחילה מאליה.';
  } else if (current === 'reading') {
    // An unknown page count stays unknown. A "0 מתוך 0" here would be a claim about the document
    // that nobody has made yet — the constitution's dash rule, applied to a counter.
    detail = hasProgress
      ? `עמוד ${done} מתוך ${total}`
      : 'קריאת המסמך התחילה. מספר העמודים טרם דווח.';
  } else if (current === 'interpreting') {
    detail = job.status === 'extracted'
      ? 'הטקסט חולץ וממתין לפירוש הסמנטי.'
      : 'הנתונים מתפרשים לשדות ולשורות.';
  }

  return (
    <LifecycleStrip
      steps={STEPS}
      current={current}
      failed={stopped}
      detail={detail}
      progress={hasProgress
        ? { done: done as number, total: total as number, label: `עמוד ${done} מתוך ${total}` }
        : undefined}
    />
  );
}
