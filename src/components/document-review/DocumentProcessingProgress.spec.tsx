// The strip exists because the status badge answered the wrong question. Production jobs waited
// 523, 614, 615 and 746 seconds to be claimed and the screen called all of it "בעיבוד", so a
// document that was simply behind a busy queue looked identical to a broken upload.
//
// Three things are asserted here and none is cosmetic.
//
// (1) Queue time and read time are different steps, and the sentence says which one is running.
// (2) A counter appears ONLY when the server actually reported one — the constitution's rule about
//     invented values, applied to a progress indicator. "0 מתוך 0" is a claim that no page is done,
//     which is not the same fact as "nobody has reported yet", and it is the one a person watching
//     would act on.
// (3) The sweeping bar appears ONLY while work is genuinely in flight. This is the load-bearing one
//     after the 04.09.2026 rebuild: the bar no longer measures anything, so the only claim it can
//     still make is "something is happening" — and a stopped, failed, stuck or finished job renders
//     no bar at all rather than animating over a process that is not running.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';
import type { ReviewSnapshot } from './model';
import { DocumentProcessingProgress } from './DocumentProcessingProgress';

type JobOverrides = Partial<ReviewSnapshot['job'] & Record<string, unknown>>;

/**
 * Every case pins the clock. The strip's stuck verdict is time-based -- a job older than two hours
 * is stuck no matter what its status says -- so a fixture with an absolute `created_at` renders
 * differently depending on when the suite runs. That is not hypothetical: two of these cases passed
 * locally and failed in CI sixteen minutes later, on the wrong side of the threshold.
 */
const NOW = Date.parse('2026-08-17T12:09:00Z');
const CREATED_AT = new Date(NOW - 9 * 60 * 1000).toISOString();

function snapshot(job: JobOverrides | null, extra: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    documentId: 'document',
    stage: 'processing',
    document: null,
    job: job === null ? null : ({
      id: 'job-1',
      status: 'queued',
      attempt_count: 0,
      created_at: CREATED_AT,
      ...job,
    } as ReviewSnapshot['job']),
    jobs: [],
    extraction: null,
    extractions: [],
    interpretation: null,
    interpretations: [],
    annotations: [],
    ruleApplications: [],
    learningRules: [],
    reviewCorrections: [],
    typeReviewDecisions: [],
    filings: [],
    priceListDecision: null,
    priceListLines: [],
    feedback: [],
    exportTemplates: [],
    exportTemplateVersions: [],
    exports: [],
    packet: null,
    packetSegments: [],
    actorNames: new Map(),
    ...extra,
  } as ReviewSnapshot;
}

/** The one live sentence, whatever markup sits between the container and the words. */
function sentence(): string {
  return screen.queryByTestId('document-processing-progress')?.textContent ?? '';
}

const sweepingBar = () => document.querySelector('.processing-track');

describe('רצועת שלבי העיבוד', () => {
  it('מפרידה המתנה לתחילת הקריאה מקריאה בפועל', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'queued', queue_age_seconds: 523 })}
      now={NOW}
    />);
    expect(screen.getByTestId('document-processing-progress')).toHaveAttribute('data-step', 'queued');
    expect(sentence()).toContain('ממתין לתחילת הקריאה');
    // The measured wait, and nothing about the worker pool it is waiting on: "לעובד פנוי" named a
    // process the reader cannot see, next to a step already labelled "ממתין בתור".
    expect(sentence()).toContain('ממתין 8 דק׳. העבודה תתחיל מעצמה.');
    expect(document.body.textContent).not.toContain('עובד פנוי');
    expect(document.body.textContent).not.toContain('תור');
  });

  it('מציגה המתנה לאישור סריקה כמצב נפרד', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'awaiting_scan', attempt_count: 1 })}
      now={NOW}
    />);
    expect(screen.getByTestId('document-processing-progress')).toHaveAttribute('data-step', 'scan');
    expect(sentence()).toContain('ממתין לאישור הסריקה');
  });

  /**
   * The whole 04.09.2026 ruling, as one assertion: "צריך להיות רק פרוגרס בר ואנימציית טעינה — ללא
   * עיגולי מלל וללא פרוגרס בר נוסף מתחת". The screen carried a step-counting bar AND four labelled
   * discs AND a sentence, three instruments for one fact. What is left is one sweeping bar, one
   * spinner and one sentence — and the discs may not come back.
   */
  it('מציגה בר אחד שנע, ספינר, ומשפט אחד — בלי עיגולי שלבים ובלי בר שני', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: 7, progress_total: 27 })}
      now={NOW}
    />);
    expect(document.querySelectorAll('.processing-track')).toHaveLength(1);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
    expect(document.querySelectorAll('li[aria-current="step"]')).toHaveLength(0);
    expect(document.querySelectorAll('ol')).toHaveLength(0);
    // Indeterminate by construction: it measures nothing, so it must not pose as a measurement.
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(sweepingBar()).toHaveAttribute('aria-hidden', 'true');
    // One live region, so a screen reader hears the change once.
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('מציגה מונה עמודים אמיתי בזמן קריאה', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: 7, progress_total: 27 })}
      now={NOW}
    />);
    // The counter is BACK in the words, and that is the point of the rebuild rather than a
    // regression of owner ruling 25.08.2026: that ruling forbade printing the count twice while a
    // determinate bar was also drawing it. The bar draws nothing now, so the sentence must.
    expect(screen.getByTestId('document-processing-progress')).toHaveAttribute('data-step', 'reading');
    expect(sentence()).toContain('קריאת המסמך');
    expect(sentence()).toContain('עמוד 7 מתוך 27');
  });

  it('resolves the same measured reading stage in English', () => {
    render(
      <LocaleProvider initialLocale="en">
        <DocumentProcessingProgress
          snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: 7, progress_total: 27 })}
          now={NOW}
        />
      </LocaleProvider>,
    );
    expect(sentence()).toContain('Reading the document');
    expect(sentence()).toContain('Page 7 of 27');
    expect(document.body.textContent).not.toContain('קריאת המסמך');
  });

  it('לא ממציאה מונה כשהעובד עדיין לא דיווח עמודים', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: null, progress_total: null })}
      now={NOW}
    />);
    expect(sentence()).toContain('קריאת המסמך');
    // Still says the count is missing — DESIGN.md §5 requires it rather than silence. What went is
    // the telemetry framing: "טרם דווח" is a field nobody reported, "עדיין לא ידוע" is the fact.
    expect(sentence()).toContain('מספר העמודים עדיין לא ידוע.');
    expect(sentence()).not.toContain('מתוך');
    // The bar keeps moving even with no count: the work is running, which is all it ever claimed.
    expect(sweepingBar()).toBeTruthy();
  });

  it('מציגה מונה מקטעים אמיתי בזמן פירוש', () => {
    // The stage a price list actually waits in. A text-layer PDF needs no OCR page, so the reading
    // counter is silent for it — and the minutes the owner watches are these provider chunks.
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'interpreting', attempt_count: 1, progress_done: 2, progress_total: 4 })}
      now={NOW}
    />);
    expect(screen.getByTestId('document-processing-progress')).toHaveAttribute('data-step', 'interpreting');
    expect(sentence()).toContain('פירוש הנתונים');
    expect(sentence()).toContain('מקטע 2 מתוך 4');
  });

  it('מפרידה בין קריאה שהסתיימה לפירוש שהתחיל', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'extracted', attempt_count: 1 })}
      now={NOW}
    />);
    expect(screen.getByTestId('document-processing-progress')).toHaveAttribute('data-step', 'preparing');
    expect(sentence()).toContain('הקריאה הסתיימה');
    expect(sentence()).toContain('מכין את הנתונים לבדיקה');
  });

  it('לא ממציאה מונה פירוש כשהשרת לא דיווח מקטעים', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'interpreting', attempt_count: 1, progress_done: null, progress_total: null })}
      now={NOW}
    />);
    expect(sentence()).toContain('פירוש הנתונים');
    // The detail may not be the step label again. "הנתונים מתפרשים לשדות ולשורות" was
    // "פירוש הנתונים" a second time; the missing segment count is the fact it did not carry.
    expect(sentence()).toContain('המערכת בודקת את הנתונים שנקראו.');
    expect(sentence()).not.toContain('מקטעים');
    expect(document.body.textContent).not.toContain('מתפרשים לשדות ולשורות');
  });

  it('אינה מציגה דבר לג׳וב תקוע', () => {
    // Caught by the first screenshot of the real screen: the badge said "עיבוד תקוע" while the bar
    // underneath it went on implying live progress on page 7 of 27. Two claims about one job, and
    // the reassuring one was the false one. A bar that now only means "work is running" has exactly
    // one honest rendering for a stopped job, and this is it.
    const { container } = render(<DocumentProcessingProgress
      snapshot={snapshot({
        status: 'leased',
        attempt_count: 1,
        progress_done: 7,
        progress_total: 27,
        is_stuck: true,
        stuck_reason: 'lease_expired',
      })}
      now={NOW}
    />);
    expect(container.textContent).toBe('');
    expect(sweepingBar()).toBeNull();
  });

  it('אינה מציגה דבר לג׳וב שנכשל', () => {
    const withExtraction = snapshot(
      { status: 'failed', attempt_count: 1, last_error_code: 'provider_timeout' },
      { extraction: { id: 'extraction-1' } as ReviewSnapshot['extraction'] },
    );
    const { container } = render(<DocumentProcessingProgress snapshot={withExtraction} now={NOW} />);
    expect(container.textContent).toBe('');
  });

  it('אינה מציגה דבר כשהמסמך כבר ממתין לאדם', () => {
    // 'review' is the absence of work, not its last frame. The review screen below is what a person
    // is meant to look at, and a bar still sweeping above it would say the machine is not finished.
    const { container } = render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'review', attempt_count: 1 })}
      now={NOW}
    />);
    expect(container.textContent).toBe('');
  });

  it('אינה מציגה דבר כשאין ג׳וב', () => {
    const { container } = render(<DocumentProcessingProgress snapshot={snapshot(null)} now={NOW} />);
    expect(container.textContent).toBe('');
  });
});
