import { useCallback, useState } from 'react';
import { X, Minus, Info } from 'lucide-react';
import { useT } from '../lib/i18n/LocaleProvider';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useServerClock } from '../lib/serverClock';
import { usePlanCatalogue } from '../lib/planLabels';
import { ICON } from './ui';

/**
 * What this organisation has, until when, and which plan it reopens on.
 *
 * WHY THIS IS ALLOWED TO SHOW REMAINING TIME AT ALL. `#204` forbids a manufactured countdown, and
 * the owner's ruling of 31.08.2026 says what that means: it bans a clock over an INVENTED date, not
 * a window the server enforces. Every figure here comes from `my_benefit_window()` — the boundary
 * and the server's own instant — and the subscription panel's ban on "hurry" language stays exactly
 * where it is. What moves with a ruling is the date; the rule does not move.
 *
 * THE RESOLUTION IS DELIBERATELY COARSE, AND COARSER AS IT GETS CLOSER.
 *   more than 24 hours  → "2 days and 14 hours"
 *   24 hours or less    → the real date and time of `ends_at` in the business timezone
 *   HH:MM:SS            → never, at any range
 * A ticking seconds counter is the pressure the ruling forbids, and it is also what floods a screen
 * reader. The display recomputes once a minute.
 *
 * AND "TODAY AT 23:59" WOULD BE WRONG, not merely coarse. The window ends at `2027-02-01T00:00:00Z`,
 * which in `Asia/Jerusalem` is 02:00 on the 1st — not 23:59 on the 31st. A strip saying "today at
 * 23:59" would state a moment the server does not enforce, which is exactly a manufactured
 * deadline. The time shown is `ends_at` rendered in the business timezone, so a refresh, a sign-out
 * and a second device all say the same words.
 *
 * NOT AN ALERT. A benefit that ends is not an emergency: no `role="alert"`, no `aria-live`, no
 * animation, no colour change. The accessible name carries the DATE as a static sentence and the
 * visual counter is `aria-hidden` — the dot-matrix pattern from `DESIGN.md:963-966`. With no motion
 * anywhere there is no `prefers-reduced-motion` branch to write, and a test asserts that rather
 * than the comment promising it.
 */

export interface BenefitWindow {
  kind: 'prelaunch_grant' | 'free_intro';
  starts_at: string | null;
  ends_at: string;
  plan_key: string;
  reverts_to_plan_key: string;
}

export interface BenefitWindowResponse {
  server_now: string;
  has_paid: boolean;
  eligible: boolean;
  /** From `0269`. Whether THIS window was already answered — a later window is offered again. */
  intent_recorded?: boolean;
  window: BenefitWindow | null;
  /** A role that may not read this gets a refusal, never an empty object. */
  status?: 'not_permitted';
}

/** Whole days and whole hours, or null once the boundary has passed. Never negative, never zero. */
export function remaining(endsAt: string, now: Date): { days: number; hours: number } | null {
  const ms = Date.parse(endsAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalHours = Math.floor(ms / 3_600_000);
  return { days: Math.floor(totalHours / 24), hours: totalHours % 24 };
}

export function BenefitWindowStrip({ data, enabled, isOwner, onResync, onCta }: {
  data: BenefitWindowResponse | null;
  /** `commerce.benefit_countdown`. Off is the default for every tenant. */
  enabled: boolean;
  isOwner: boolean;
  onResync?: () => void;
  onCta?: () => void;
}) {
  const { t } = useT();
  /* The same resolver the plan badge uses: the RPC returns a plan KEY and the dictionary turns it
     into a name. Nothing a person reads here came from the server as text. */
  const { planName } = usePlanCatalogue();
  const [dismissed, setDismissed] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const clock = useServerClock(data?.server_now, onResync);

  const minimize = useCallback(() => setMinimized(true), []);
  const dismiss = useCallback(() => setDismissed(true), []);

  // Every reason not to render, in the order they can be known. A skeleton of a commercial strip
  // is noise, so there is no loading state: nothing renders until there is an answer.
  if (!enabled || !isOwner || dismissed) return null;
  if (!data || data.status === 'not_permitted') return null;
  // Answered already: the strip stops asking for THIS window. A window that later moves is a
  // different window and is offered again, which is why the server keys the intent on the
  // boundary rather than on the organisation.
  if (data.has_paid || data.intent_recorded || !data.window) return null;

  const now = clock.now();
  if (!now) return null;
  const left = remaining(data.window.ends_at, now);
  // A window that has passed is `window: null` from the server; this is the same fact arriving a
  // minute early, and it is rendered the same way — as nothing. Never `00:00`, never a negative.
  if (!left) return null;

  const planLabel = planName(data.window.plan_key, null);
  const revertsLabel = planName(data.window.reverts_to_plan_key, null);

  /* The static sentence a screen reader is given. It carries the DATE, not the counter — a name
     that changed every minute would be a name that is read aloud every minute. */
  const accessibleName = t('countdown.accessibleName', {
    plan: planLabel, date: fmtDate(data.window.ends_at), reverts: revertsLabel,
  });

  const headline = left.days > 0
    ? t('countdown.remainingDaysHours', { days: left.days, hours: left.hours })
    // Inside the last day the counter stops being useful and the real moment is shown instead.
    : t('countdown.endsAt', { at: fmtDateTime(data.window.ends_at) });

  if (minimized) {
    return (
      <section aria-label={accessibleName}
        className="benefit-strip no-print border-b border-line-soft bg-surface-sunken px-4 py-1.5 lg:px-6">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-2">
          <span className="truncate text-xs text-ink-muted">
            {planLabel} · <span aria-hidden="true">{headline}</span>
          </span>
          <button type="button" className="btn-ghost btn-icon min-h-11 min-w-11"
            onClick={() => setMinimized(false)} aria-label={t('countdown.expand')}>
            <Info size={ICON.sm} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={accessibleName}
      className="benefit-strip no-print border-b border-info-line bg-info-wash px-4 py-2.5 lg:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2">
        <Info size={ICON.sm} aria-hidden="true" className="shrink-0 text-info-on-soft" />
        <div className="min-w-0 flex-1">
          {/* aria-hidden on the visual half, because the accessible name above already says the
              same thing with a date instead of a counter. */}
          <p className="text-sm text-info-on-soft" aria-hidden="true">
            {t('countdown.headline', { plan: planLabel })} · <span className="num">{headline}</span>
          </p>
          <p className="text-xs text-ink-muted" aria-hidden="true">
            {t('countdown.reverts', { date: fmtDate(data.window.ends_at), plan: revertsLabel })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onCta && (
            <button type="button" className="btn-primary btn-sm min-h-11" onClick={onCta}>
              {t('countdown.cta')}
            </button>
          )}
          <button type="button" className="btn-ghost btn-icon min-h-11 min-w-11"
            onClick={minimize} aria-label={t('countdown.minimize')}>
            <Minus size={ICON.sm} aria-hidden="true" />
          </button>
          {/* Dismissing does not delete the offer: the same four facts stay on
              /settings/subscription, where the existing `plan-grant-window` note already says them. */}
          <button type="button" className="btn-ghost btn-icon min-h-11 min-w-11"
            onClick={dismiss} aria-label={t('countdown.dismiss')}>
            <X size={ICON.sm} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
