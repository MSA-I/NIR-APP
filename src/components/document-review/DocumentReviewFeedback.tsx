import { useRef, useState } from 'react';
import { Loader2, MessageSquareWarning } from 'lucide-react';
import { useT } from '../../lib/i18n/LocaleProvider';
import { supabase } from '../../lib/supabase';
import { ICON, Note, useToast } from '../ui';

export type DocumentReviewFeedbackRow = {
  id: string;
  note: string;
  created_at: string;
};

export function DocumentReviewFeedback({
  documentId,
  interpretationId,
  existing,
  onRefetch,
}: {
  documentId: string;
  interpretationId: string;
  existing: DocumentReviewFeedbackRow | null;
  onRefetch: () => Promise<boolean>;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());

  async function submit() {
    const clean = note.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const result = await supabase.rpc('add_document_review_feedback', {
        p_document_id: documentId,
        p_interpretation_id: interpretationId,
        p_note: clean,
        p_idempotency_key: idempotencyKey.current,
        p_reason: clean,
      });
      if (result.error) throw result.error;
      const refreshed = await onRefetch();
      toast(refreshed ? t('docReview.documentFeedbackSaved') : t('docReview.documentFeedbackRefreshFailed'),
        refreshed ? 'success' : 'error');
      if (refreshed) {
        setNote('');
        setOpen(false);
      }
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (existing) {
    return (
      <Note tone="info" data-testid="document-review-feedback-recorded">
        <div className="font-medium">{t('docReview.documentFeedbackRecorded')}</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{existing.note}</p>
      </Note>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <MessageSquareWarning size={ICON.sm} aria-hidden="true" />
        {t('docReview.documentFeedbackOpen')}
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-line p-3" data-testid="document-review-feedback-form">
      <label className="label" htmlFor="document-review-feedback-note">
        {t('docReview.documentFeedbackQuestion')}
      </label>
      <textarea id="document-review-feedback-note" className="input" rows={3} maxLength={1500}
        value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy || !note.trim()}
          onClick={() => void submit()}>
          {busy && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />}
          {t('docReview.documentFeedbackSave')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy}
          onClick={() => { setOpen(false); setNote(''); }}>
          {t('docReview.documentFeedbackCancel')}
        </button>
      </div>
    </div>
  );
}
