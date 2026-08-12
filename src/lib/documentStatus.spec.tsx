import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import {
  DOCUMENT_STUCK_ATTEMPT_COUNT,
  documentMatchesFilingFilter,
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

describe('documentUiStatus precedence', () => {
  it('active + inbox is only processing, never unassigned', () => {
    const status = documentUiStatus({ job: job('leased'), document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('processing');
    expect(status.loading).toBe(true);
    expect(status.countsAsUnassigned).toBe(false);
    expect(documentMatchesFilingFilter(status, 'unfiled')).toBe(false);
    expect(status.elapsedSeconds).toBe(300);
  });

  it('an unread processing query stays unavailable instead of briefly claiming filing state', () => {
    const status = documentUiStatus({ status: null, document: inbox, evaluatedAt: NOW });
    expect(status.state).toBe('unavailable');
    expect(status.countsAsUnassigned).toBe(false);
    expect(documentMatchesFilingFilter(status, 'unfiled')).toBe(false);
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
    expect(status.label).toBe('לא משויך');
    expect(status.countsAsUnassigned).toBe(true);
  });

  it('archive is a completed filing decision and never unassigned', () => {
    const status = documentUiStatus({
      job: job('completed'),
      document: { entity_type: 'archive', entity_id: null },
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('assigned');
    expect(status.countsAsUnassigned).toBe(false);
  });

  it('keeps the supervisory explanation for an automatic assignment', () => {
    const explanation = 'נוצרה ושויכה אוטומטית ללא אישור אדם ברמת ביטחון 92%.';
    const status = documentUiStatus({
      job: job('completed'),
      document: { entity_type: 'invoice', entity_id: 'invoice-1' },
      autoAssigned: true,
      autoAssignmentDescription: explanation,
      evaluatedAt: NOW,
    });
    expect(status.label).toBe('שויך אוטומטית');
    expect(status.description).toBe(explanation);
  });

  it('superseded failed attempt is history, not a current failure', () => {
    const status = documentUiStatus({
      job: job('failed', { last_error_code: 'superseded_for_reprocess' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
    expect(status.tone).toBe('idle');
    expect(status.description).toContain('היסטורי');
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

  it('translates a canonical server stuck reason instead of exposing its code', () => {
    const status = documentUiStatus({
      job: job('leased'), document: inbox, evaluatedAt: NOW,
      isStuck: true, stuckReason: 'lease_expired',
    });
    expect(status.description).toContain('הפסיק להגיב');
    expect(status.description).not.toContain('lease_expired');
  });

  it('an active attempt wins even if a stale superseded code leaks beside it', () => {
    const status = documentUiStatus({
      job: job('leased', { last_error_code: 'superseded_for_reprocess' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('processing');
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
    expect(screen.getByText(/5 דק׳/)).toHaveAttribute('data-document-status-age');

    const review = documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW });
    rerender(<DocumentStatusBadge status={review} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[data-document-status-age]')).toBeNull();
  });
});
