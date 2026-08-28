import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ConfirmDialog, ICON, Modal, Note, SubPanel, useToast } from './ui';

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
 *
 * Two surfaces, on purpose (convergence sweep 26.08.2026). This dialog is the DECISION — what the
 * removal takes with it, which blockers stand, which of the two modes. The COMMITMENT is the shared
 * `ConfirmDialog`, which owns the audit reason, the busy spinner and — for the derived mode — the
 * `btn-danger` colour DESIGN.md:552 requires of anything that undoes financial records. It used to
 * be one bespoke modal with its own reason textarea and a `btn-primary` on the destructive branch.
 * The reason still reaches `remove_document` with the same two fallback sentences: they are the
 * ConfirmDialog titles, and `ConfirmDialog` falls back to its title.
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
  const { errorText, t } = useT();
  const [impact, setImpact] = useState<RemovalImpact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'document_only' | 'document_and_derived'>('document_only');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const destructive = mode === 'document_and_derived';

  const load = useCallback(async () => {
    const result = await supabase.rpc('get_document_removal_impact', {
      p_document_id: documentId,
    });
    if (result.error) { setLoadError(errorText(result.error)); return; }
    setLoadError(null);
    setImpact(result.data as RemovalImpact);
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    setImpact(null);
    setMode('document_only');
    setConfirming(false);
    void load();
  }, [open, load]);

  const submit = useCallback(async (reason?: string) => {
    setBusy(true);
    const result = await supabase.rpc('remove_document', {
      p_document_id: documentId, p_mode: mode, p_reason: reason,
    });
    setBusy(false);
    setConfirming(false);
    if (result.error) { toast(errorText(result.error), 'error'); return; }
    const answer = result.data as { already_removed?: boolean; undone_count?: number };
    toast(answer.already_removed
      ? t('docRemoval.text')
      : mode === 'document_and_derived'
        ? t('docRemoval.removedWithUndone', { count: answer.undone_count ?? 0 })
        : t('docRemoval.text_2'), 'success');
    onClose();
    onRemoved();
  }, [documentId, mode, toast, onClose, onRemoved]);

  return (
    <Modal open={open} onClose={onClose} title={t('docRemoval.title')} busy={busy}>
      {loadError && <Note tone="alert" role="alert">{loadError}</Note>}
      {!impact && !loadError && (
        <Note tone="info" role="status">{t('docRemoval.text_3')}</Note>
      )}

      {impact && (
        <div className="space-y-4">
          {/* Always true, and said before anything else. A person about to press remove is exactly
              who needs to know the file itself survives. */}
          <p className="flex items-start gap-2 text-sm text-ink-body">
            <Check size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{t('docRemoval.text_4')}</span>
          </p>

          {impact.effects.length > 0 && (
            <SubPanel>
              <h3 className="text-sm font-medium text-ink">
                {t('docRemoval.text_5')}
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-ink-body">
                {impact.effects.map((effect, index) => (
                  <li key={index}>· {effect.description}</li>
                ))}
              </ul>
            </SubPanel>
          )}

          {impact.blockers.length > 0 && (
            <Note tone="alert" role="status">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t('docRemoval.text_6')}</p>
                <ul className="mt-2 space-y-1">
                  {impact.blockers.map((blocker, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm">
                      <ShieldAlert size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
                      <span>{blocker.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Note>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t('docRemoval.text_7')}</legend>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink-body">
              <input type="radio" name="removal-mode" className="mt-1 shrink-0"
                checked={mode === 'document_only'}
                onChange={() => setMode('document_only')} />
              <span>
                <strong>{t('docRemoval.text_8')}</strong> {t('docRemoval.documentOnlyBody')}
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink-body">
              <input type="radio" name="removal-mode" className="mt-1 shrink-0"
                checked={mode === 'document_and_derived'}
                onChange={() => setMode('document_and_derived')} />
              <span>
                <strong>{t('docRemoval.text_9')}</strong>
                {impact.blockers.length > 0 && (
                  <span className="block text-ink-muted">
                    {t('docRemoval.text_10')}
                  </span>
                )}
              </span>
            </label>
          </fieldset>

          {destructive && impact.blockers.length === 0
            && impact.derived_count > 0 && (
            <Note tone="await" role="status">
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>
                  <span className="num">{impact.derived_count}</span> {t('docRemoval.derivedWillBeUndone')}
                  {t('docRemoval.text_11')}
                </span>
              </p>
            </Note>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={onClose}>{t('docRemoval.text_12')}</button>
            {/* The trigger wears the colour of what it is about to do: undoing derived records is
                destructive, filing the document away is not (DESIGN.md:552, :586). */}
            <button type="button" className={destructive ? 'btn-danger' : 'btn-primary'}
              disabled={busy} onClick={() => setConfirming(true)}>
              {t('docRemoval.text_13')}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={(reason) => void submit(reason)}
        danger={destructive}
        requireReason
        busy={busy}
        confirmLabel={t('docRemoval.confirmLabel')}
        title={destructive ? t('docRemoval.text_14') : t('docRemoval.text_15')}
        message={destructive
          ? t('docRemoval.confirmDestructive', { count: impact?.derived_count ?? 0 })
          : t('docRemoval.text_16')}
      />
    </Modal>
  );
}
