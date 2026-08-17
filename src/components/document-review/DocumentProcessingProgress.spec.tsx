// The strip exists because the status badge answered the wrong question. Production jobs waited
// 523, 614, 615 and 746 seconds to be claimed and the screen called all of it "בעיבוד", so a
// document that was simply behind a busy queue looked identical to a broken upload.
//
// Two things are asserted here and neither is cosmetic: that queue time and read time are
// different steps, and that a page counter appears ONLY when the server actually reported one.
// The second is the constitution's rule about invented values, applied to a progress bar — an
// empty bar at 0% is a claim that no page is done, which is not the same fact as "nobody has
// reported yet", and it is the one a person watching would act on.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReviewSnapshot } from './model';
import { DocumentProcessingProgress } from './DocumentProcessingProgress';

type JobOverrides = Partial<ReviewSnapshot['job'] & Record<string, unknown>>;

function snapshot(job: JobOverrides | null, extra: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    documentId: 'document',
    stage: 'processing',
    document: null,
    job: job === null ? null : ({
      id: 'job-1',
      status: 'queued',
      attempt_count: 0,
      created_at: new Date('2026-08-17T12:00:00Z').toISOString(),
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

/** The `<li>` carrying aria-current, whatever markup sits between it and the label. */
function currentStepLabel(): string {
  const marked = document.querySelector('li[aria-current="step"]');
  return marked?.textContent ?? '';
}

describe('רצועת שלבי העיבוד', () => {
  it('מפרידה המתנה בתור מקריאה בפועל', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'queued', queue_age_seconds: 523 })}
      now={Date.parse('2026-08-17T12:08:43Z')}
    />);
    expect(currentStepLabel()).toContain('ממתין בתור');
    expect(screen.getByText(/ממתין 8 דק׳ לעובד פנוי/)).toBeTruthy();
    // The queue is not the work, so nothing here may look like measured progress.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('מציגה מונה עמודים אמיתי בזמן קריאה', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: 7, progress_total: 27 })}
    />);
    expect(currentStepLabel()).toContain('קריאת המסמך');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('7');
    expect(bar.getAttribute('aria-valuemax')).toBe('27');
    expect(bar.getAttribute('aria-valuetext')).toBe('עמוד 7 מתוך 27');
    expect(screen.getByText('עמוד 7 מתוך 27')).toBeTruthy();
  });

  it('לא ממציאה בר כשהעובד עדיין לא דיווח עמודים', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'leased', attempt_count: 1, progress_done: null, progress_total: null })}
    />);
    expect(currentStepLabel()).toContain('קריאת המסמך');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/מספר העמודים טרם דווח/)).toBeTruthy();
  });

  it('מסמנת את שלב הפירוש כשנכשל אחרי שהחילוץ הצליח', () => {
    const withExtraction = snapshot(
      { status: 'failed', attempt_count: 1, last_error_code: 'provider_timeout' },
      { extraction: { id: 'extraction-1' } as ReviewSnapshot['extraction'] },
    );
    render(<DocumentProcessingProgress snapshot={withExtraction} />);
    expect(currentStepLabel()).toContain('פירוש הנתונים');
    expect(screen.getByText('— השלב שנעצר', { exact: false })).toBeTruthy();
    // A failed job has no live work to measure, whatever the last reported counter said.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('מסמנת את שלב הקריאה כשנכשל לפני שהיה חילוץ', () => {
    render(<DocumentProcessingProgress
      snapshot={snapshot({ status: 'failed', attempt_count: 3, last_error_code: 'processing_timeout' })}
    />);
    expect(currentStepLabel()).toContain('קריאת המסמך');
  });

  it('אינה מציגה דבר כשאין ג׳וב', () => {
    const { container } = render(<DocumentProcessingProgress snapshot={snapshot(null)} />);
    expect(container.textContent).toBe('');
  });
});
