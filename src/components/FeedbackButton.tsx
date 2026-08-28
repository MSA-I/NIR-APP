import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Camera, Loader2, MessageSquarePlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  NOTE_MAX_LENGTH,
  submitFeedbackNote,
  type FeedbackOutcomeCode,
} from '../lib/feedback';
import { captureViewport, type ScreenshotCapture } from '../lib/screenshot';
import { ICON, Modal, Note, useToast } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';

/**
 * The design partner's note, from any screen, straight to the vendor.
 *
 * Available to every active product account. It used to be hidden behind `feedback.notes`; a slow
 * or failed flag read therefore made the screenshot option disappear even though the note channel
 * itself was healthy. The database remains the permission boundary.
 *
 * Placement is the top bar beside the bell on DESKTOP, and a row inside the phone drawer on
 * mobile (owner report 25.08.2026: the phone top bar is four icons wide and the subscription tier
 * had to go somewhere). The drawer placement is why the capture note at the end of this comment
 * exists — the menu is an overlay, and an overlay is exactly what the picture must not be of.
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
 *
 * THE DRAWER DOES NOT CLOSE WHEN THE NOTE OPENS, and the first version of the phone placement got
 * this wrong in a way worth recording. The reasoning looked sound — from a menu, "capture first"
 * would photograph the menu — so the trigger dismissed the drawer and waited for the paint before
 * capturing. But this component is rendered INSIDE the drawer, so closing it unmounted the
 * component mid-click: the capture ran and `setOpen(true)` landed on a corpse. The dialog never
 * appeared. Local checks missed it because they only asserted the row EXISTS; the browser gate
 * caught it by clicking the row, which is the difference between the two kinds of evidence.
 *
 * The drawer never needed closing. `SKIP_SELECTOR` in `lib/screenshot.ts` already skips
 * `[role="dialog"]`, and the drawer is one — so the panel is excluded from the picture while
 * staying mounted. What it did NOT cover is the half-opaque scrim behind it, which would have
 * tinted the whole capture; Layout marks that `data-no-capture`. Exclusion, not removal.
 */

const COOLDOWN_MS = 30_000;
const FEEDBACK_OUTCOME_KEY: Readonly<Record<Exclude<FeedbackOutcomeCode, 'save_failed'>, TKey>> = {
  empty: 'feedbackButton.outcomeEmpty',
  saved_not_delivered: 'feedbackButton.outcomeSavedNotDelivered',
  delivered: 'feedbackButton.outcomeDelivered',
};

/**
 * `onShell` was removed on 26.08.2026 for the same reason as the bell's: it switched this trigger
 * onto the dark Onyx ramp, and T7.3k made every cluster that renders it light. No caller passed it.
 */
export default function FeedbackButton({ variant = 'icon' }: {
  /** `menu` renders a full-width drawer row instead of a round icon target. */
  variant?: 'icon' | 'menu';
} = {}) {
  const { errorText, t } = useT();
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

    const baseMessage = outcome.code === 'save_failed'
      ? errorText(outcome.error)
      : t(FEEDBACK_OUTCOME_KEY[outcome.code]);
    const screenshotRequested = includeShot && shot !== null;
    const outcomeMessage = screenshotRequested && !outcome.screenshotAttached
      ? `${baseMessage} · ${t('feedbackButton.screenshotMissing')}`
      : baseMessage;
    toast(outcomeMessage, outcome.delivered ? 'success' : 'error');

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
  }, [profile, note, location.pathname, location.search, location.hash, includeShot, shot, toast, errorText, t]);

  if (!profile) return null;

  const cooling = cooldownUntil > Date.now();
  /**
   * THE COOLDOWN WORDING MAY NOT CLAIM A DELIVERY, and it used to. "ההערה נשלחה" was written
   * when this was an icon and the string only ever reached `aria-label`, so nothing on screen
   * said it -- but the cooldown starts after a note is STORED, which is not the same as sent, and
   * a failed delivery left the trigger announcing a success. Rendering the label as a drawer row
   * made the latent inaccuracy visible, and the browser gate failed on it by name: "the screen
   * claimed a delivery that failed". The cooldown is about the WAIT; the outcome is the toast's
   * to report, and only it knows which one happened.
   */
  const label = cooling ? t('feedbackButton.text') : t('feedbackButton.text_2');

  return (
    <>
      {/* Same control, two shapes. The drawer row borrows the navigation item's geometry
          (min-h-11, gap-2.5, rounded-lg) so it reads as one list with the destinations above it —
          it is a button and not a Link because it opens a dialog rather than going anywhere. */}
      {variant === 'menu' ? (
        <button type="button" onClick={() => void openWithCapture()} disabled={cooling || capturing}
          title={label}
          className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset disabled:opacity-50">
          <MessageSquarePlus size={ICON.md} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start">{cooling ? label : t('feedbackButton.text_3')}</span>
        </button>
      ) : (
        <button type="button" onClick={() => void openWithCapture()} disabled={cooling || capturing}
          aria-label={label} title={label}
          className="btn-ghost btn-icon rounded-full">
          <MessageSquarePlus size={ICON.xl} aria-hidden="true" />
        </button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('feedbackButton.title')} busy={busy}
        description={t('feedbackButton.description')}>
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor={noteId}>{t('feedbackButton.text_4')}</label>
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
                  <span>{t('feedbackButton.text_5')}</span>
                </label>
                <button type="button" className="btn-ghost min-h-11 text-sm"
                  disabled={busy || capturing} onClick={() => void capture()}>
                  <Camera size={ICON.sm} aria-hidden="true" /> {t('feedbackButton.retakeScreenshot')}
                </button>
              </div>
              {includeShot && (
                <>
                  <img src={shot.previewUrl} alt={t('feedbackButton.alt')}
                    className="max-h-48 w-full rounded-lg border border-line object-contain object-top" />
                  {/* The disclosure the plan requires, in the words it needs to be in: this is a
                      picture of the screen, so whatever is on the screen is in it. */}
                  <p className="mt-2 text-xs text-await-fg">
                    {t('feedbackButton.text_6')}{' '}
                    {t('feedbackButton.text_7')}
                  </p>
                </>
              )}
            </div>
          )}
          {!shot && !capturing && (
            <Note tone="info" role="status">
              {t('feedbackButton.text_8')}
            </Note>
          )}

          {/* Stated, not hidden: the person can see exactly what travels with their words. */}
          <p className="text-xs text-ink-muted">
            {t('feedbackButton.contextPrefix')} (<span dir="ltr" className="num">{location.pathname}</span>),{' '}
            {t('feedbackButton.contextSuffix')}
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => setOpen(false)}>{t('feedbackButton.setOpen')}</button>
            <button type="button" className="btn-primary" disabled={busy || !note.trim()}
              onClick={() => void send()}>
                {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : t('feedbackButton.text_10')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
