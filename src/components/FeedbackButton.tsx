import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Camera, Loader2, MessageSquarePlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { NOTE_MAX_LENGTH, submitFeedbackNote } from '../lib/feedback';
import { captureViewport, type ScreenshotCapture } from '../lib/screenshot';
import { Modal, Note, useToast } from './ui';

/**
 * The design partner's note, from any screen, straight to the vendor.
 *
 * Available to every active product account. It used to be hidden behind `feedback.notes`; a slow
 * or failed flag read therefore made the screenshot option disappear even though the note channel
 * itself was healthy. The database remains the permission boundary.
 *
 * Placement is the top bar beside the bell, on both viewports. It is the one slot that exists in
 * phone mode and on desktop without colliding with the bottom action bar or the speed dial.
 *
 * ponytail: a 30-second cooldown after a send, no queue and no retry. The row is the record and
 * the operator console is the fallback view; wire a real retry in only if notes start getting
 * lost. (That console left the tenant app on 19.08.2026 — it is `/operator`, not `/admin`.)
 *
 * THE SCREENSHOT IS TAKEN BEFORE THE DIALOG OPENS (package L, owner decision 11.08.2026), and the
 * order is the whole trick. Capturing after would photograph the feedback box sitting on top of the
 * screen the person is complaining about — which is both useless and a way to show somebody their
 * own half-written sentence back. So the click captures first and opens second.
 *
 * The person then SEES what would be sent, is told in Hebrew that whatever is on that screen goes
 * with it, and can take it out or take it again. Attached by default, because a bug report with a
 * picture is worth several without one — but never attached silently.
 */

const COOLDOWN_MS = 30_000;

export default function FeedbackButton({ onShell = false }: { onShell?: boolean }) {
  const { profile } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const noteId = useId();

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<ScreenshotCapture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [includeShot, setIncludeShot] = useState(true);
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

  // An object URL held past its blob is a leak that lasts as long as the tab does.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.previewUrl); }, [shot]);

  const capture = useCallback(async () => {
    setCapturing(true);
    const next = await captureViewport();
    setCapturing(false);
    setShot((previous) => {
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      return next;
    });
    setIncludeShot(Boolean(next));
  }, []);

  /**
   * Capture, THEN open. The dialog is not on screen yet, so it cannot be in the picture — which is
   * a stronger guarantee than asking html2canvas to skip it, and the skip stays anyway for the
   * "capture again" case where the dialog IS open.
   */
  const openWithCapture = useCallback(async () => {
    await capture();
    setOpen(true);
  }, [capture]);

  const send = useCallback(async () => {
    if (!profile) return;
    setBusy(true);
    const outcome = await submitFeedbackNote(note, profile.org_id, profile.id, {
      route: location.pathname,
      role: profile.role,
      viewportWidth: typeof window === 'undefined' ? null : window.innerWidth,
      appRelease: (import.meta.env.VITE_RELEASE as string | undefined) ?? null,
      // The state the report is actually about. A filtered list's query string is the difference
      // between "the table is wrong" and a reproducible case.
      pageTitle: typeof document === 'undefined' ? null : document.title || null,
      routeQuery: location.search || null,
      routeHash: location.hash || null,
    }, includeShot ? shot : null);
    setBusy(false);

    toast(outcome.message, outcome.delivered ? 'success' : 'error');

    // The note is stored: closing is safe, and a second click must not send it twice.
    if (outcome.saved) {
      setNote('');
      setShot((previous) => { if (previous) URL.revokeObjectURL(previous.previewUrl); return null; });
      setOpen(false);
      setCooldownUntil(Date.now() + COOLDOWN_MS);
      return;
    }
    // Nothing was stored — keep the dialog and the text exactly as written. Losing what somebody
    // took the trouble to type is the one failure this feature must never have.
  }, [profile, note, location.pathname, location.search, location.hash, includeShot, shot, toast]);

  if (!profile) return null;

  const cooling = cooldownUntil > Date.now();
  const label = cooling ? 'ההערה נשלחה — אפשר לשלוח עוד אחת בעוד רגע' : 'שליחת הערה';

  return (
    <>
      <button type="button" onClick={() => void openWithCapture()} disabled={cooling || capturing}
        aria-label={label} title={label}
        className={`grid size-[44px] shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${
          onShell
            ? 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
            : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
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

          {/* The picture, shown rather than described. A person deciding whether to send business
              data needs to look at the business data. */}
          {shot && (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink-body">
                  <input type="checkbox" checked={includeShot} disabled={busy}
                    onChange={(event) => setIncludeShot(event.target.checked)} />
                  <span>לצרף צילום של המסך</span>
                </label>
                <button type="button" className="btn-ghost min-h-11 text-sm"
                  disabled={busy || capturing} onClick={() => void capture()}>
                  <Camera size={16} aria-hidden="true" /> צילום מחדש
                </button>
              </div>
              {includeShot && (
                <>
                  <img src={shot.previewUrl} alt="תצוגה מקדימה של הצילום שיישלח"
                    className="max-h-48 w-full rounded-lg border border-line object-contain object-top" />
                  {/* The disclosure the plan requires, in the words it needs to be in: this is a
                      picture of the screen, so whatever is on the screen is in it. */}
                  <p className="mt-2 text-xs text-await-fg">
                    הצילום כולל את כל מה שמוצג על המסך כרגע — כולל שמות ספקים, סכומים ומספרי מסמכים.
                    אפשר להסיר אותו, או לסגור, לסדר את המסך ולצלם מחדש.
                  </p>
                </>
              )}
            </div>
          )}
          {!shot && !capturing && (
            <Note tone="info" role="status">
              לא ניתן היה לצלם את המסך בדפדפן הזה. ההערה תישלח בלי צילום.
            </Note>
          )}

          {/* Stated, not hidden: the person can see exactly what travels with their words. */}
          <p className="text-xs text-ink-muted">
            נשלחים גם: המסך שאתה נמצא בו (<span dir="ltr" className="num">{location.pathname}</span>),
            כותרת העמוד, הסינון שבחרת, התפקיד שלך, רוחב המסך וגרסת המערכת.
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
