import { useCallback, useEffect, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { AlertTriangle, Check, Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { Modal, Note, useToast } from './ui';

/**
 * Removing a document, with the consequences computed before the button is pressed (0116 + 0119).
 *
 * The two options are never merged and their names are the promise. "Remove the document only" is
 * always available — filing something away is not destruction, and a person must always be able to
 * say "this does not belong here". "Also undo what it created" is offered ONLY where the server
 * proved a safe reversal, and when it did not, this screen shows the blockers by name.
 *
 * "Cannot be deleted" with no reason is how a person concludes the software is broken and goes
 * looking for another way to do it, so every refusal here carries the server's own sentence.
 *
 * The destructive choice is not disabled on the client's opinion. The server recomputes the blocker
 * list inside its own row lock — an invoice can be approved between reading this dialog and
 * pressing the button — so what this screen renders is guidance, and the refusal is the server's.
 */
export interface RemovalEffect { kind: string; action: string; description: string }
export interface RemovalBlocker { kind: string; description: string }
export interface RemovalImpact {
  found: boolean;
  file_name: string | null;
  original_file_retained: boolean;
  effects: RemovalEffect[];
  blockers: RemovalBlocker[];
  can_remove_document_only: boolean;
  can_remove_derived: boolean;
  derived_count: number;
}

export function DocumentRemovalDialog({ documentId, open, onClose, onRemoved }: {
  documentId: string;
  open: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [impact, setImpact] = useState<RemovalImpact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'document_only' | 'document_and_derived'>('document_only');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    const result = await supabase.rpc('get_document_removal_impact', {
      p_document_id: documentId,
    });
    if (result.error) { setLoadError(toHebrewError(result.error)); return; }
    setLoadError(null);
    setImpact(result.data as RemovalImpact);
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    setImpact(null);
    setMode('document_only');
    setReason('');
    void load();
  }, [open, load]);

  const submit = useCallback(async () => {
    setBusy(true);
    const result = await supabase.rpc('remove_document', {
      p_document_id: documentId, p_mode: mode,
      p_reason: reasonOr(reason, mode === 'document_and_derived'
        ? 'הסרת מסמך וביטול מה שנוצר ממנו'
        : 'הסרת מסמך מתיקיית המסמכים'),
    });
    setBusy(false);
    if (result.error) { toast(toHebrewError(result.error), 'error'); return; }
    const answer = result.data as { already_removed?: boolean; undone_count?: number };
    toast(answer.already_removed
      ? 'המסמך כבר הוסר'
      : mode === 'document_and_derived'
        ? `המסמך הוסר, ובוטלו ${answer.undone_count ?? 0} רשומות שנוצרו ממנו`
        : 'המסמך הוסר. הרשומות שנוצרו ממנו נשארו', 'success');
    onClose();
    onRemoved();
  }, [documentId, mode, reason, toast, onClose, onRemoved]);

  return (
    <Modal open={open} onClose={onClose} title="הסרת מסמך" busy={busy}>
      {loadError && <Note tone="alert" role="alert">{loadError}</Note>}
      {!impact && !loadError && (
        <Note tone="info" role="status">מחשב מה ההסרה תיקח איתה…</Note>
      )}

      {impact && (
        <div className="space-y-4">
          {/* Always true, and said before anything else. A person about to press remove is exactly
              who needs to know the file itself survives. */}
          <p className="flex items-start gap-2 text-sm text-ink-body">
            <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>הקובץ המקורי והראיות נשמרים בכל מקרה — ההסרה אינה מוחקת אותם.</span>
          </p>

          {impact.effects.length > 0 && (
            <div className="rounded-lg border border-line bg-surface p-3">
              <h3 className="text-sm font-medium text-ink-strong">
                מה נוצר מהמסמך הזה
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-ink-body">
                {impact.effects.map((effect, index) => (
                  <li key={index}>· {effect.description}</li>
                ))}
              </ul>
            </div>
          )}

          {impact.blockers.length > 0 && (
            <Note tone="alert" role="status">
              <p className="font-medium">לא ניתן לבטל את מה שנוצר מהמסמך:</p>
              <ul className="mt-2 space-y-1">
                {impact.blockers.map((blocker, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <ShieldAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span>{blocker.description}</span>
                  </li>
                ))}
              </ul>
            </Note>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink-strong">מה להסיר</legend>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink-body">
              <input type="radio" name="removal-mode" className="mt-1"
                checked={mode === 'document_only'}
                onChange={() => setMode('document_only')} />
              <span>
                <strong>את המסמך בלבד.</strong> כל מה שנוצר ממנו נשאר כפי שהוא.
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink-body">
              <input type="radio" name="removal-mode" className="mt-1"
                checked={mode === 'document_and_derived'}
                onChange={() => setMode('document_and_derived')} />
              <span>
                <strong>את המסמך וגם לבטל את מה שנוצר ממנו.</strong>
                {impact.blockers.length > 0 && (
                  <span className="block text-ink-muted">
                    יש חסימות למעלה — השרת יבדוק שוב ויסרב אם הן עדיין קיימות.
                  </span>
                )}
              </span>
            </label>
          </fieldset>

          <div>
            <label className="label" htmlFor="removal-reason">
              סיבה (רשות — נרשמת ביומן הביקורת)
            </label>
            <textarea id="removal-reason" className="input min-h-20" value={reason}
              maxLength={1000} onChange={(event) => setReason(event.target.value)} />
          </div>

          {mode === 'document_and_derived' && impact.blockers.length === 0
            && impact.derived_count > 0 && (
            <Note tone="await" role="status">
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>
                  <span className="num">{impact.derived_count}</span> רשומות יבוטלו. חשבונית תימחק
                  מחיקה רכה וניתן יהיה לראותה ביומן; טיוטת קבלה תבוטל לגמרי.
                </span>
              </p>
            </Note>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary min-h-11" disabled={busy}
              onClick={onClose}>ביטול</button>
            <button type="button" className="btn-primary min-h-11"
              disabled={busy} onClick={() => void submit()}>
              {busy && <Loader2 size={16} aria-hidden="true" className="animate-spin" />}
              הסרה
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
