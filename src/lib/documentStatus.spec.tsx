import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import {
  DOCUMENT_STUCK_ATTEMPT_COUNT,
  documentMatchesStatusFilter,
  documentMatchesFilingFilter,
  documentProcessingFailureText,
  documentStatusElapsedLabel,
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

describe('documentUiStatus precedence', () => {
  it('maps every persisted pipeline stage into one canonical UI state', () => {
    const states = [
      documentUiStatus({ status: 'unprocessed', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'queued', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'processing', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'extracted', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'review', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'completed', document: inbox, evaluatedAt: NOW }).state,
      documentUiStatus({ status: 'failed', document: inbox, evaluatedAt: NOW }).state,
    ];
    expect(states).toEqual([
      'unassigned', 'processing', 'processing', 'processing', 'review', 'unassigned', 'failed',
    ]);
  });

  it('keeps never-enqueued and actively queued documents distinct', () => {
    const unprocessed = documentUiStatus({ status: 'unprocessed', document: inbox, evaluatedAt: NOW });
    const queued = documentUiStatus({ status: 'queued', document: inbox, evaluatedAt: NOW });
    expect(unprocessed).toMatchObject({ state: 'unassigned', loading: false, label: 'לא משויך' });
    expect(queued).toMatchObject({ state: 'processing', loading: true, label: 'ממתין לעיבוד' });
  });

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

  it('completed without a filing row reports completion without inventing a target', () => {
    const status = documentUiStatus({ status: 'completed', evaluatedAt: NOW });
    expect(status).toMatchObject({ state: 'completed', label: 'הושלם', countsAsUnassigned: false });
    expect(status.label).not.toContain('שויך');
  });

  it('names both supported business assignment targets', () => {
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
    expect(invoice.label).toBe('שויך לחשבונית');
    expect(receipt.label).toBe('שויך לקבלת סחורה');
  });

  it('archive is a completed no-target decision and never claims a business assignment', () => {
    const status = documentUiStatus({
      job: job('completed'),
      document: { entity_type: 'archive', entity_id: null },
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
    expect(status.label).toBe('אורכב');
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

  it('treats a job superseded by stuck recovery as historical rather than an active failure', () => {
    const status = documentUiStatus({
      job: job('failed', { last_error_code: 'superseded_for_stuck_recovery' }),
      document: inbox,
      evaluatedAt: NOW,
    });
    expect(status.state).toBe('historical');
  });

  it('turns provider error codes into actionable Hebrew without exposing the raw code', () => {
    const gateway = documentProcessingFailureText('gateway_invalid_response');
    const provider = documentProcessingFailureText('provider_output_truncated');
    const unknown = documentProcessingFailureText('unexpected_internal_code');
    expect(gateway).toContain('הקובץ נשמר');
    expect(provider).toContain('תוצאה מלאה');
    expect(unknown).toContain('אפשר לנסות שוב');
    expect(`${gateway} ${provider} ${unknown}`).not.toMatch(/gateway_|provider_|unexpected_/);
  });
});

describe('document status filtering and filing contracts', () => {
  it('accepts only canonical filter tokens and rejects legacy, empty and prototype keys', () => {
    expect(documentStatusFilterFromParam('stuck')).toBe('stuck');
    expect(documentStatusFilterFromParam('assigned')).toBe('assigned');
    for (const value of ['queued', 'completed', 'banana', '', 'toString', '__proto__']) {
      expect(documentStatusFilterFromParam(value)).toBeNull();
    }
    expect(documentStatusFilterFromParam(null)).toBeNull();
  });

  it('never includes archived documents in either active filing bucket', () => {
    const archived = documentUiStatus({
      status: 'completed',
      document: { entity_type: 'archive', entity_id: null },
      evaluatedAt: NOW,
    });
    expect(documentMatchesFilingFilter(archived, 'unfiled')).toBe(false);
    expect(documentMatchesFilingFilter(archived, 'linked')).toBe(false);
    expect(documentMatchesStatusFilter(archived, 'unassigned')).toBe(false);
    expect(documentMatchesStatusFilter(archived, 'assigned')).toBe(false);
  });

  it('formats persisted processing age at the user-facing boundaries', () => {
    expect(documentStatusElapsedLabel(null)).toBeNull();
    expect(documentStatusElapsedLabel(0)).toBe('פחות מדקה');
    expect(documentStatusElapsedLabel(59)).toBe('פחות מדקה');
    expect(documentStatusElapsedLabel(60)).toBe('1 דק׳');
    expect(documentStatusElapsedLabel(3_600)).toBe('1 שע׳');
    expect(documentStatusElapsedLabel(86_400)).toBe('1 ימים');
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
    expect(screen.getByText(/5 דק׳/)).toHaveAttribute('data-document-status-age');

    const review = documentUiStatus({ job: job('review'), document: inbox, evaluatedAt: NOW });
    rerender(<DocumentStatusBadge status={review} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('[data-document-status-age]')).toBeNull();
  });
});
