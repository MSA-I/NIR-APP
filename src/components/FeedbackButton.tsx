import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useFeatureFlags } from '../lib/flags';
import { FEEDBACK_FLAG, NOTE_MAX_LENGTH, submitFeedbackNote } from '../lib/feedback';
import { Modal, useToast } from './ui';

/**
 * The design partner's note, from any screen, straight to the vendor.
 *
 * Self-gating, exactly like NotificationBell: the flag decides whether the surface exists, and the
 * lookup is fail-closed (an unknown or still-loading flag reads as off — src/lib/flags.ts). Layout
 * renders this unconditionally; nothing upstream has to know the flag.
 *
 * Placement is the top bar beside the bell, on both viewports. It is the one slot that exists in
 * phone mode and on desktop without colliding with the bottom action bar or the speed dial.
 *
 * ponytail: a 30-second cooldown after a send, no queue and no retry. The row is the record and
 * /admin is the fallback view; wire a real retry in only if notes start getting lost.
 */

const COOLDOWN_MS = 30_000;

export default function FeedbackButton({ onShell = false }: { onShell?: boolean }) {
  const { profile } = useAuth();
  const { isEnabled } = useFeatureFlags();
  const location = useLocation();
  const toast = useToast();
  const noteId = useId();

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, setTick] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-render once when the cooldown lapses so the trigger re-enables itself.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = setTimeout(() => setTick((n) => n + 1), cooldownUntil - Date.now());
    return () => clearTimeout(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  const send = useCallback(async () => {
    if (!profile) return;
    setBusy(true);
    const outcome = await submitFeedbackNote(note, profile.org_id, profile.id, {
      route: location.pathname,
      role: profile.role,
      viewportWidth: typeof window === 'undefined' ? null : window.innerWidth,
      appRelease: (import.meta.env.VITE_RELEASE as string | undefined) ?? null,
    });
    setBusy(false);

    toast(outcome.message, outcome.delivered ? 'success' : 'error');

    // The note is stored: closing is safe, and a second click must not send it twice.
    if (outcome.saved) {
      setNote('');
      setOpen(false);
      setCooldownUntil(Date.now() + COOLDOWN_MS);
      return;
    }
    // Nothing was stored — keep the dialog and the text exactly as written. Losing what somebody
    // took the trouble to type is the one failure this feature must never have.
  }, [profile, note, location.pathname, toast]);

  if (!profile || !isEnabled(FEEDBACK_FLAG)) return null;

  const cooling = cooldownUntil > Date.now();
  const label = cooling ? 'ההערה נשלחה — אפשר לשלוח עוד אחת בעוד רגע' : 'שליחת הערה';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={cooling}
        aria-label={label} title={label}
        className={`grid size-[44px] shrink-0 place-items-center border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${
          onShell
            ? 'border-shell-ink/15 text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
            : 'border-line text-ink-soft hover:bg-surface-sunken hover:text-ink'
        }`}>
        <MessageSquarePlus size={19} aria-hidden="true" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="שליחת הערה" busy={busy}
        description="מה לא עבד, מה חסר, או מה היה מבלבל. ההערה מגיעה ישר אליי.">
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor={noteId}>ההערה</label>
            <textarea id={noteId} ref={textareaRef} className="input" rows={5}
              maxLength={NOTE_MAX_LENGTH} value={note} disabled={busy}
              onChange={(e) => setNote(e.target.value)} />
          </div>

          {/* Stated, not hidden: the person can see exactly what travels with their words. */}
          <p className="text-xs text-ink-muted">
            נשלחים גם: המסך שאתה נמצא בו (<span dir="ltr" className="num">{location.pathname}</span>),
            התפקיד שלך, רוחב המסך וגרסת המערכת. תוכן המסך עצמו אינו נשלח.
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => setOpen(false)}>ביטול</button>
            <button type="button" className="btn-primary" disabled={busy || !note.trim()}
              onClick={() => void send()}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : 'שליחה'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
