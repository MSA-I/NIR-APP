import { he as heDict } from './i18n/dictionaries/he';
import type { Dictionary as I18nDictionary } from './i18n/dictionaries/he';
import { translate as i18nTranslate, type TKey as I18nKey } from './i18n/t';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import {
  DOCUMENT_STUCK_ATTEMPT_COUNT,
  documentMatchesStatusFilter,
  documentProcessingFailureKey,
  documentProcessingStuckKey,
  documentStatusElapsed,
  documentStatusFilterFromParam,
  documentUiStatus,
} from './documentStatus';

const NOW = Date.parse('2026-08-12T12:00:00Z');
const inbox = { entity_type: 'inbox', entity_id: null };

const job = (status: 'queued' | 'leased' | 'extracted' | 'interpreting' | 'review' | 'completed' | 'failed', over = {}) => ({
  status,
  attempt_count: 1,
  lease_until: '2026-08-12T12:02:00Z',
  created_at: '2026-08-12T11:55:00Z',
  updated_at: '2026-08-12T11:59:00Z',
  last_error_code: null,
  ...over,
});


/** A key resolved in Hebrew, so every expectation below keeps the exact phrase it asserted. */
const say = (key: I18nKey | null | undefined): string =>
  (key ? i18nTranslate(heDict as unknown as I18nDictionary, key) : '');
describe('documentUiStatus precedence', () => {
  it('maps every persisted pipeline stage into one canonical UI state', () => {
    const states = [
      documentUiStatus({ status: 'unprocessed', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'awaiting_scan', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'queued', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'processing', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'extracted', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'review', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'completed', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'failed', document: inbox, evaluatedAt: NOW }).state,
    ];
    expect(states).toEqual([
      'unassigned', 'processing', 'processing', 'processing', 'processing', 'review', 'unassigned', 'failed',
    ]);
  });

  it('carries the reading page counter, and refuses to invent one', () => {
    const reading = documentUiStatus({
      job: job('leased', { progress_done: 7, progress_total: 27 }),
      document: inbox, evaluatedAt: NOW,
    });
    expect(reading.progress).toEqual({ done: 7, total: 27 });

    // A worker build that does not report, a job that has not been opened yet, and a job already
    // past the pages: three different facts, one honest screen answer.
    expect(documentUiStatus({ job: job('leased'), document: inbox, evaluatedAt: NOW }).progress).toBeNull();
    expect(documentUiStatus({
      job: job('queued', { progress_done: 3, progress_total: 9 }),
      document: inbox, evaluatedAt: NOW,
    }).progress).toBeNull();
    expect(documentUiStatus({
      job: job('interpreting', { progress_done: 9, progress_total: 9 }),
      document: inbox, evaluatedAt: NOW,
    }).progress).toBeNull();
    // Zero pages is not a page count; it would render as "עמוד 0 מתוך 0".
    expect(documentUiStatus({
      job: job('leased', { progress_done: 0, progress_total: 0 }),
      document: inbox, evaluatedAt: NOW,
    }).progress).toBeNull();
  });

  it('keeps row badges compact even when the server reports page progress', () => {
    const { container } = render(<DocumentStatusBadge status={documentUiStatus({
      job: job('leased', { progress_done: 4, progress_total: 12 }),
      document: inbox, evaluatedAt: NOW,
    })} />);
    expect(container.querySelector('[data-document-status-progress]')).toBeNull();
    expect(screen.getByText('בעיבוד')).toBeInTheDocument();
  });

  it('surfaces a batched supplier-unresolved review state in the folder badge', () => {
    const status = documentUiStatus({
      status: 'review',
      reviewState: 'supplier_unresolved',
      document: inbox,
      evaluatedAt: NOW,
    });

    expect(status.state).toBe('supplier_unresolved');
    expect(say(status.labelKey)).toBe('ספק לא מזוהה');
    expect(status.loading).toBe(false);
  });

  it('keeps never-enqueued and actively queued documents distinct', () => {
    const unprocessed = documentUiStatus({ status: 'unprocessed', document: inbox, evaluatedAt: NOW });
    const queued = documentUiStatus({ status: 'queued', document: inbox, evaluatedAt: NOW });
    expect(unprocessed).toMatchObject({ state: 'unassigned', loading: false });
    expect(say(unprocessed.labelKey)).toBe('לא משויך');
    expect(queued).toMatchObject({ state: 'processing', loading: true });
    expect(say(queued.labelKey)).toBe('ממתין לעיבוד');
  });

  it('active + inbox is only processing, never unassigned', () => {
    const status = documentUiStatus({ job: job('leased'), document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('processing');
    expect(status.loading).toBe(true);
    expect(status.countsAsUnassigned).toBe(false);
    expect(status.elapsedSeconds).toBe(300);
  });

  it('an unread processing query stays unavailable instead of briefly claiming filing state', () => {
    const status = documentUiStatus({ status: null, document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('unavailable');
    expect(status.countsAsUnassigned).toBe(false);
  });

  it('review + inbox is only human review', () => {
    const status = documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('review');
    expect(status.loading).toBe(false);
    expect(status.countsAsUnassigned).toBe(false);
  });

  it('completed + inbox becomes unassigned', () => {
    const status = documentUiStatus({ job: job('completed'), document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('unassigned');
    expect(say(status.labelKey)).toBe('לא משויך');
    expect(status.countsAsUnassigned).toBe(true);
  });

  it('completed without a filing row reports completion without inventing a target', () => {
    const status = documentUiStatus({ status: 'completed', evaluatedAt: NOW });
    expect(status).toMatchObject({ state: 'completed', countsAsUnassigned: false });
    expect(say(status.labelKey)).toBe('הושלם');
    expect(say(status.labelKey)).not.toContain('שויך');
  });

  it('keeps both supported business assignment targets under one compact list label', () => {
    const invoice = documentUiStatus({
      status: 'completed',
      document: { entity_type: 'invoice', entity_id: 'invoice-1' },
      evaluatedAt: NOW,
    });
    const receipt = documentUiStatus({
      status: 'completed',
      document: { entity_type: 'goods_receipt', entity_id: 'receipt-1' },
      evaluatedAt: NOW,
    });
    expect(say(invoice.labelKey)).toBe('משויך');
    expect(say(receipt.labelKey)).toBe('משויך');
  });

  it('archive is a completed no-target decision and never claims a business assignment', () => {
    const status = documentUiStatus({
      job: job('completed'),
      document: { entity_type: 'archive', entity_id: null },
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
    expect(say(status.labelKey)).toBe('אורכב');
    expect(status.countsAsUnassigned).toBe(false);
  });

  it('orders alerts and work before completed filing states', () => {
    const inputs = [
      documentUiStatus({ job: job('leased', { is_stuck: true }), document: inbox, evaluatedAt: NOW }),
      documentUiStatus({ job: job('failed'), document: inbox, evaluatedAt: NOW }),
      documentUiStatus({ job: job('queued'), document: inbox, evaluatedAt: NOW }),
      documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW }),
      documentUiStatus({ job: job('completed'), document: inbox, evaluatedAt: NOW }),
      documentUiStatus({ job: job('completed'), document: { entity_type: 'invoice', entity_id: 'i-1' }, evaluatedAt: NOW }),
    ];
    expect(inputs.map(({ state }) => state)).toEqual([
      'stuck', 'failed', 'processing', 'review', 'unassigned', 'assigned',
    ]);
    expect(inputs.map(({ priority }) => priority)).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it('keeps the supervisory explanation for an automatic assignment', () => {
    // The sentence lives in the dictionary now and takes the confidence as a VALUE, so the claim
    // is the same one split in two: the status carries the key and the number, and the key carries
    // the supervisory fact — that nobody approved this.
    const status = documentUiStatus({
      job: job('completed'),
      document: { entity_type: 'invoice', entity_id: 'invoice-1' },
      autoAssigned: true,
      autoAssignmentDescriptionKey: 'documentStatus.autoAssignedByMachine',
      autoAssignmentDescriptionVars: { confidence: '92%' },
      evaluatedAt: NOW,
    });
    expect(say(status.labelKey)).toBe('שויך אוטומטית');
    expect(status.descriptionKey).toBe('documentStatus.autoAssignedByMachine');
    expect(status.descriptionVars).toEqual({ confidence: '92%' });
    expect(heDict.documentStatus.autoAssignedByMachine).toContain('ללא אישור אדם');
  });

  it('superseded failed attempt is history, not a current failure', () => {
    const status = documentUiStatus({
      job: job('failed', { last_error_code: 'superseded_for_reprocess' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
    expect(status.tone).toBe('idle');
    expect(say(status.descriptionKey)).toContain('היסטורי');
  });

  it('a stale server-active attempt is stuck and keeps the persisted age', () => {
    const status = documentUiStatus({
      job: job('leased', {
        attempt_count: DOCUMENT_STUCK_ATTEMPT_COUNT,
        created_at: '2026-08-12T03:00:00Z',
        updated_at: '2026-08-12T03:02:00Z',
        lease_until: '2026-08-12T03:04:00Z',
      }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('stuck');
    expect(status.loading).toBe(false);
    expect(status.countsAsUnassigned).toBe(false);
    expect(status.elapsedSeconds).toBe(9 * 60 * 60);
  });

  it('keeps a live or only-recently-expired worker lease healthy during the five-minute grace', () => {
    const live = documentUiStatus({
      job: job('leased', {
        attempt_count: DOCUMENT_STUCK_ATTEMPT_COUNT,
        created_at: '2026-08-12T03:00:00Z',
        lease_until: '2026-08-12T12:01:00Z',
      }),
      document: inbox,
      evaluatedAt: NOW,
    });
    const recent = documentUiStatus({
      job: job('leased', {
        attempt_count: DOCUMENT_STUCK_ATTEMPT_COUNT,
        created_at: '2026-08-12T03:00:00Z',
        lease_until: '2026-08-12T11:58:00Z',
      }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(live.state).toBe('processing');
    expect(recent.state).toBe('processing');
  });

  it('translates a canonical server stuck reason instead of exposing its code', () => {
    const status = documentUiStatus({
      job: job('leased'), document: inbox, evaluatedAt: NOW,
      isStuck: true, stuckReason: 'lease_expired',
    });
    // Was pinned on "הפסיק להגיב" — the tail of "העובד שעיבד את המסמך הפסיק להגיב וההרשאה הזמנית
    // שלו פגה", which described our worker and its lease to a bookkeeper. The claim worth pinning
    // is the one the reader acts on: it stopped, and it is not coming back by itself.
    expect(say(status.descriptionKey)).toContain('נפסק');
    expect(status.descriptionKey).not.toMatch(/עובד|הרשאה זמנית|lease_expired/);
  });

  it('every stuck reason ends on the fact that waiting will not help', () => {
    // Four codes, one decision: keep waiting or act. A reason that only narrated the heuristic
    // ("לפי הגיל ומספר הניסיונות שנשמרו בשרת") left that decision unmade.
    for (const reason of [null, 'lease_expired', 'no_progress', 'active_over_two_hours',
      'claim_attempt_limit_reached']) {
      const text = say(documentProcessingStuckKey(reason));
      expect(text).toMatch(/לא ימשיך מעצמו|לא התחדש|אינו מתקדם|לא התקדם/);
      expect(text).not.toMatch(/עובד|שרת|ניסיונות שנשמרו/);
    }
  });

  it('an active attempt wins even if a stale superseded code leaks beside it', () => {
    const status = documentUiStatus({
      job: job('leased', { last_error_code: 'superseded_for_reprocess' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('processing');
  });

  it('treats a job superseded by stuck recovery as historical rather than an active failure', () => {
    const status = documentUiStatus({
      job: job('failed', { last_error_code: 'superseded_for_stuck_recovery' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
  });

  it('turns provider error codes into actionable Hebrew without exposing the raw code', () => {
    const gateway = say(documentProcessingFailureKey('gateway_invalid_response'));
    const provider = say(documentProcessingFailureKey('provider_output_truncated'));
    const unknown = say(documentProcessingFailureKey('unexpected_internal_code'));
    expect(gateway).toContain('הקובץ נשמר');
    expect(provider).toContain('תוצאה מלאה');
    expect(unknown).toContain('אפשר לנסות שוב');
    expect(`${gateway} ${provider} ${unknown}`).not.toMatch(/gateway_|provider_|unexpected_/);
  });
});

describe('document status filtering contracts', () => {
  it('maps the legacy unfiled link to the canonical unassigned filter and rejects ambiguous tokens', () => {
    expect(documentStatusFilterFromParam('stuck')).toBe('stuck');
    expect(documentStatusFilterFromParam('assigned')).toBe('assigned');
    expect(documentStatusFilterFromParam('unfiled')).toBe('unassigned');
    for (const value of ['linked', 'queued', 'completed', 'banana', '', 'toString', '__proto__']) {
      expect(documentStatusFilterFromParam(value)).toBeNull();
    }
    expect(documentStatusFilterFromParam(null)).toBeNull();
  });

  it('never includes archived documents in either assignment bucket', () => {
    const archived = documentUiStatus({
      status: 'completed',
      document: { entity_type: 'archive', entity_id: null },
      evaluatedAt: NOW,
    });
    expect(documentMatchesStatusFilter(archived, 'unassigned')).toBe(false);
    expect(documentMatchesStatusFilter(archived, 'assigned')).toBe(false);
  });

  it('formats persisted processing age at the user-facing boundaries', () => {
    // The boundaries are the claim; the phrase is resolved so it stays the exact one asserted.
    const elapsed = (seconds: number | null): string | null => {
      const parts = documentStatusElapsed(seconds);
      return parts ? i18nTranslate(heDict as unknown as I18nDictionary, parts.key, parts.vars) : null;
    };
    expect(documentStatusElapsed(null)).toBeNull();
    expect(elapsed(0)).toBe('פחות מדקה');
    expect(elapsed(59)).toBe('פחות מדקה');
    expect(elapsed(60)).toBe('1 דק׳');
    expect(elapsed(3_600)).toBe('1 שע׳');
    expect(elapsed(86_400)).toBe('1 ימים');
  });
});

describe('one description carries one extra fact, or none at all', () => {
  const cases = [
    documentUiStatus({ job: job('queued'), document: inbox, evaluatedAt: NOW }),
    documentUiStatus({ job: job('leased'), document: inbox, evaluatedAt: NOW }),
    documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW }),
    documentUiStatus({ job: job('failed'), document: inbox, evaluatedAt: NOW }),
    documentUiStatus({ job: job('completed'), document: inbox, evaluatedAt: NOW }),
    documentUiStatus({ status: 'completed', evaluatedAt: NOW }),
    documentUiStatus({ status: 'completed', document: { entity_type: 'invoice', entity_id: 'i-1' }, evaluatedAt: NOW }),
    documentUiStatus({ status: 'completed', document: { entity_type: 'archive', entity_id: null }, evaluatedAt: NOW }),
  ];

  it('never re-reads the label back to the reader', () => {
    // The description ships as `title` AND as sr-only text on every row, so a sentence that
    // rephrases the badge is the same fact twice — once for everyone, twice for a screen reader.
    for (const status of cases) {
      expect(say(status.descriptionKey)).not.toContain(say(status.labelKey));
    }
  });

  it('states with nothing to add carry an empty description rather than filler', () => {
    expect(documentUiStatus({ status: 'completed', evaluatedAt: NOW }).descriptionKey).toBeNull();
    expect(documentUiStatus({ status: null, evaluatedAt: NOW }).descriptionKey).toBeNull();
    expect(documentUiStatus({
      status: 'completed', document: { entity_type: 'invoice', entity_id: 'i-1' }, evaluatedAt: NOW,
    }).descriptionKey).toBeNull();
  });

  it('renders neither an empty title nor an empty sr-only span for those states', () => {
    const { container } = render(<DocumentStatusBadge status={documentUiStatus({
      status: 'completed', document: { entity_type: 'invoice', entity_id: 'i-1' }, evaluatedAt: NOW,
    })} />);
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  it('speaks about invoices and goods receipts, never about an entity_type', () => {
    for (const status of cases) {
      expect(say(status.descriptionKey)).not.toContain('יעד עסקי');
    }
    expect(say(documentUiStatus({ status: 'completed', document: inbox, evaluatedAt: NOW }).descriptionKey))
      .toBe('צריך לשייך אותו לחשבונית או לקבלת סחורה.');
  });
});

describe('DocumentStatusBadge loading contract', () => {
  it('renders a spinner only for a server-active status and makes reduced motion static', () => {
    const active = documentUiStatus({ job: job('queued'), document: inbox, evaluatedAt: NOW });
    const { rerender, container } = render(<DocumentStatusBadge status={active} />);
    const spinner = container.querySelector('svg');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveClass('animate-spin', 'motion-reduce:animate-none');
    expect(screen.getByRole('status')).toHaveTextContent('ממתין לעיבוד');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-document-status-progress]')).toBeNull();
    expect(container.querySelector('[data-document-status-age]')).toBeNull();

    const review = documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW });
    rerender(<DocumentStatusBadge status={review} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('[data-document-status-age]')).toBeNull();
  });

  it('keeps a stuck job identifiable without row-level page and age telemetry', () => {
    const stuck = documentUiStatus({
      job: { ...job('queued'), is_stuck: true, stuck_reason: 'queue_age' },
      document: inbox,
      evaluatedAt: NOW,
    });
    const { container } = render(<DocumentStatusBadge status={stuck} />);
    expect(screen.getByText('עיבוד תקוע')).toBeInTheDocument();
    expect(container.querySelector('.lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('[data-document-status-progress],[data-document-status-age]')).toBeNull();
  });
});
