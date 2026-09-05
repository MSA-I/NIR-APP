import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../ui';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc } }));

import { DocumentReviewFeedback } from './DocumentReviewFeedback';

function renderFeedback(existing: {
  id: string;
  note: string;
  created_at: string;
} | null = null, onRefetch = vi.fn(async () => true)) {
  render(
    <ToastProvider>
      <DocumentReviewFeedback
        documentId="document-1"
        interpretationId="interpretation-1"
        existing={existing}
        onRefetch={onRefetch}
      />
    </ToastProvider>,
  );
  return onRefetch;
}

describe('document-level review feedback', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { feedback_id: 'feedback-1', idempotent: false }, error: null });
  });

  it('starts as one action and persists one note through the protected command', async () => {
    const onRefetch = renderFeedback();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('textbox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'זה לא נכון' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'מה לא נכון במסמך?' }), 'הספק במסמך שונה');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת המשוב' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('add_document_review_feedback', {
      p_document_id: 'document-1',
      p_interpretation_id: 'interpretation-1',
      p_note: 'הספק במסמך שונה',
      p_idempotency_key: expect.any(String),
      p_reason: 'הספק במסמך שונה',
    }));
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('rereads the stored document note instead of showing training controls again', () => {
    renderFeedback({
      id: 'feedback-1',
      note: 'סכום המע״מ לא נכון',
      created_at: '2026-09-05T12:00:00Z',
    });

    expect(screen.getByText('סכום המע״מ לא נכון')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'זה לא נכון' })).toBeNull();
    expect(screen.queryByText(/annotation/i)).toBeNull();
  });
});
