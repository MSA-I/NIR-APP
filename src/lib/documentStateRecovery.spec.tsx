import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import { documentUiStatus, type DocumentStatusState } from './documentStatus';
import { DOCUMENT_STATE_ACTIONS, documentStateAction } from './documentStateRecovery';

describe('document state action matrix', () => {
  it('maps every canonical state to one action or explicit no-action', () => {
    const expected: Record<DocumentStatusState, string> = {
      stuck: 'none',
      failed: 'retry',
      processing: 'wait',
      review: 'review',
      supplier_unresolved: 'review',
      awaiting_scan: 'review',
      unassigned: 'file',
      assigned: 'none',
      completed: 'none',
      historical: 'none',
      unavailable: 'none',
    };

    expect(DOCUMENT_STATE_ACTIONS).toEqual(expected);
    for (const [state, action] of Object.entries(expected)) {
      expect(documentStateAction(state as DocumentStatusState)).toBe(action);
    }
  });

  it('uses one compact assigned label for invoice and receipt rows', () => {
    const invoice = documentUiStatus({ status: 'completed', document: { entity_type: 'invoice', entity_id: 'i-1' } });
    const receipt = documentUiStatus({ status: 'completed', document: { entity_type: 'goods_receipt', entity_id: 'r-1' } });
    expect(invoice.labelKey).toBe('documentStatus.assignedGeneric');
    expect(receipt.labelKey).toBe('documentStatus.assignedGeneric');
  });

  it('draws no badge for loading, unavailable, or a superseded attempt', () => {
    const states = [
      documentUiStatus({ status: null }),
      documentUiStatus({ status: undefined }),
      documentUiStatus({
        job: {
          status: 'failed', attempt_count: 1, lease_until: null,
          created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
          last_error_code: 'superseded_for_reprocess',
        },
      }),
    ];
    for (const status of states) {
      const { container, unmount } = render(<DocumentStatusBadge status={status} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });
});
