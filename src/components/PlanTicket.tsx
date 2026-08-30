import type { ReactNode } from 'react';
import { Building, Building2, Check, Landmark, Sprout, Store } from 'lucide-react';
import { Skeleton } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import presentation from '../data/plan-presentation.json';

/**
 * ONE RUNG OF THE LADDER, AS A TICKET — the marketing site's plan card, brought into the product.
 *
 * Owner ruling 27.08.2026 (OPEN-DECISIONS #296): «קח את המנגנון הקיים שיש בדף נחיתה וגם את העיצוב
 * שלו». The card the owner approved against a reference image on 26.08.2026 was built on the
 * marketing site and never reached the product, so a visitor who signed up met a different-looking
 * ladder on the other side of the login screen than the one that convinced them. This component is
 * that card, and it is deliberately NOT a second interpretation of it: every class name below is
 * the marketing site's own, and every rule behind those names lives in `src/styles/plan-card.css`,
 * which both surfaces load from the same authored copy.
 *
 * ─── WHAT THIS COMPONENT OWNS, AND WHAT IT REFUSES TO OWN ─────────────────────────────────────
 * It owns SHAPE: the head row, the three dotted rules, the figure block, the quota line, the
 * entitlement list, the barcode, and which of the four faces the ticket wears.
 *
 * It owns NO FACT. Every string it prints arrives as a prop, because the two surfaces are allowed
 * to say different things and the difference is the whole point of there being two:
 *   * `/pricing` publishes no amount at all (owner decision 25.08.2026 / #267) — a public visitor
 *     has no verified billing country, so #208's currency rule cannot even decide which catalogue
 *     applies to them. Its figure slot carries the documents quota instead.
 *   * `/settings/subscription` knows the organization's country and publishes the price.
 *   * `/pricing` renders no action on a card at all: a "בחרו מסלול" button would be a selection
 *     control for a selection that does not exist (#217/#224).
 * A component that reached for the catalogue itself would have to decide which of those it is, and
 * it would decide once, for both.
 *
 * ─── AND IT DRAWS NO PLAN THE SERVER DID NOT SEND ─────────────────────────────────────────────
 * `PLAN_FACE` covers `business`, and that is not a way for a public surface to start showing it:
 * `get_public_plan_catalogue()` excludes Business in the SERVER (#194/#201), so `/pricing` never
 * receives a row to draw. The entry exists so that the one surface which does receive it — the
 * authenticated panel — draws the same ticket as every other rung rather than a fallback.
 */

/**
 * THE ONE QUOTA A CARD PUTS AT FIGURE SIZE, and the same key on both surfaces.
 *
 * #266 makes documents-per-usage-period the single metric a tenant card may publish: OCR pages are
 * derived from it (ten per document) and deliberately unpublished, and users and suppliers have no
 * counter behind them at all (DEBT §56). The public page may list the rest of the ladder's rows
 * beside it — it is a comparison — but the number that ANCHORS a rung is this one on both, or the
 * two screens would headline different things about the same plan.
 *
 * It moved here from `PlanCard.tsx` when that component was replaced, unchanged.
 */
export const HEADLINE_QUOTA_KEY = 'documents.monthly';

/** The lucide glyph in the head chip, by the name the shared presentation file records. */
const GLYPHS = { Sprout, Store, Building2, Building, Landmark } as const;

interface PlanLook {
  code: string;
  face: 'default' | 'paper' | 'violet' | 'gloss';
  icon: keyof typeof GLYPHS;
}

const LOOK = presentation.plans as Record<string, PlanLook>;

/**
 * The rung the vendor points at, read from the shared file rather than from a position in a list.
 *
 * The marketing site keyed it to an INDEX (`RECOMMENDED = 2`), which is only correct while the
 * catalogue has exactly five plans in exactly that order — and the two surfaces do not even
 * receive the same number of rows, because Business is filtered in the server for one of them. A
 * plan key survives both.
 */
export const RECOMMENDED_PLAN: string = presentation.recommended;

/**
 * A rung the presentation file has no look for wears the default face and no printed code, rather
 * than borrowing another rung's. The same rule `planTierClass` already follows for the tier mark:
 * a mark that is wrong is worse than a mark that is missing, because `legacy` advertised as the
 * free plan is a claim about what somebody is paying for.
 */
const lookOf = (planKey: string): PlanLook | null => LOOK[planKey] ?? null;

const FACE_CLASS: Record<PlanLook['face'], string> = {
  default: '',
  paper: 'plan-card--paper',
  violet: 'plan-card--violet',
  gloss: 'plan-card--gloss',
};

/**
 * The barcode along the bottom edge.
 *
 * Drawn, not fetched: a barcode is a run of bars at three widths, and the widths come from the
 * plan's own key, so the same plan draws the same code every render and no two cards carry the
 * same one. An `<img>` would be a network request per card for a texture nobody scans.
 *
 * Seeded by `planKey` and NOT by the label, which is the one deliberate change from the marketing
 * site's copy: the label is translated on that site and would draw a different barcode per
 * language, so the same plan would not be the same ticket across three locales.
 */
function Barcode({ seed }: { seed: string }) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < 46; i += 1) {
    h = (h * 1664525 + 1013904223) >>> 0;
    bars.push(1 + ((h >>> 16) % 3));
  }
  return (
    <span className="plan-card__barcode" aria-hidden="true">
      {bars.map((width, index) => (
        <span key={index} style={{ inlineSize: `${width}px`, opacity: index % 2 ? 0.16 : 1 }} />
      ))}
    </span>
  );
}

export interface PlanTicketFeature {
  key: string;
  /** Free-form so a caller can put a `.num` figure inside it. */
  text: ReactNode;
  /**
   * A check mark ASSERTS that the rung includes this. A row whose value is «—» asserts nothing —
   * it is the honest state of a quota nothing measures (DEBT §56) — so it gets an EMPTY slot of
   * the tick's own width. Not a dash glyph: the row already prints «—» as its value, and the two
   * together rendered the mark twice, «— משתמשים —», which reads as a typo.
   */
  affirmative: boolean;
}

export function PlanTicket({
  planKey, label, who, priceLabel, figure, figureIsWords = false, term,
  action, quotaLabel, quota, featuresLabel, features = [], badgeLabel, current = false,
}: {
  /** Emitted as `data-plan`, which is how both spec files and the browser gate address a rung. */
  planKey: string;
  label: string;
  /** One line on what kind of rung this is. Omitted rather than padded when nothing is true. */
  who?: string;
  /** The small label above the figure — «מחיר» signed in, the quota's own name on the public page. */
  priceLabel: string;
  /** Already formatted by its caller (money through `src/lib/format.ts`). */
  figure: string;
  /**
   * Words in the figure slot rather than a number. «דברו איתנו» and «ללא עלות» set at 2.3rem read
   * as a headline rather than as a figure, so they take the smaller of the two sizes.
   */
  figureIsWords?: boolean;
  /** The period or unit under the figure. A blank line holds the slot so cards stay in step. */
  term?: string;
  /** The full-width action. `/pricing` passes none, and passes none on EVERY card equally. */
  action?: ReactNode;
  /** The headline quota's label and value — the one number #266 lets a card publish. */
  quotaLabel?: string;
  quota?: string;
  featuresLabel?: string;
  features?: readonly PlanTicketFeature[];
  /** The badge riding the top edge. Only the recommended rung gets one, and only from #202. */
  badgeLabel?: string;
  /**
   * The rung this organization stands on — a REPORT, never a selection, because nothing on that
   * screen can be chosen (#217/#224). Always false on `/pricing`: a stranger holds no rung.
   */
  current?: boolean;
}) {
  const look = lookOf(planKey);
  const Glyph = look ? GLYPHS[look.icon] : Sprout;
  const face = look ? FACE_CLASS[look.face] : '';

  return (
    <li
      className={`plan-card ${face}`}
      data-plan={planKey}
      data-face={look?.face ?? 'default'}
      data-current={current ? 'true' : 'false'}
      data-state={current ? 'current' : badgeLabel ? 'featured' : 'default'}
    >
      {/* The sweep. One element, so a card that does not carry it costs nothing, and it sits
          behind everything the card says. */}
      {look?.face === 'gloss' && <span className="plan-card__sweep" aria-hidden="true" />}

      {badgeLabel && <span className="plan-card__badge">{badgeLabel}</span>}

      <span className="plan-card__head">
        <span className="plan-card__code">{look?.code ?? ''}</span>
        <span className="plan-card__icon" aria-hidden="true">
          <Glyph className="size-[1.15rem]" strokeWidth={1.7} />
        </span>
      </span>

      <h3 className="plan-card__name">{label}</h3>
      {/* The description holds its height even when empty, or five tickets in a row would start
          their price blocks at five different offsets. */}
      <p className="plan-card__who">{who ?? ''}</p>

      <span className="plan-card__perf" aria-hidden="true" />

      <p className="plan-card__label">{priceLabel}</p>
      <p
        data-testid="plan-figure"
        data-plan-figure={figure}
        className={`plan-card__price ${figureIsWords ? 'plan-card__price--words' : 'num'}`}
      >
        {figure}
      </p>
      {/* A non-breaking space rather than nothing: the term line reserves its own height so a card
          without a period does not pull its action 1.1em up past its neighbours'. */}
      <p className="plan-card__term">{term ?? ' '}</p>

      {action && <div className="plan-card__action">{action}</div>}

      {quota !== undefined && (
        <>
          <span className="plan-card__perf" aria-hidden="true" />
          <p className="plan-card__label">{quotaLabel}</p>
          <p className="plan-card__quota">
            <span className="plan-card__tick">
              <Check className="size-3.5" strokeWidth={2.5} />
            </span>
            <span data-plan-docs={quota} className="num">{quota}</span>
          </p>
        </>
      )}

      {features.length > 0 && (
        <>
          {featuresLabel && (
            <p className="plan-card__label plan-card__label--gap">{featuresLabel}</p>
          )}
          <ul className="plan-card__list">
            {features.map((row) => (
              <li key={row.key}>
                {row.affirmative
                  ? (
                    <span className="plan-card__tick plan-card__tick--sm">
                      <Check className="size-3" strokeWidth={2.5} />
                    </span>
                  )
                  : <span aria-hidden className="plan-card__tick plan-card__tick--sm opacity-0" />}
                <span>{row.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="plan-card__perf plan-card__perf--last" aria-hidden="true" />
      <Barcode seed={planKey} />
    </li>
  );
}

/**
 * THE TRAY. One class, both surfaces, and the owner's layout ruling of 27.08.2026 lives inside it
 * rather than at each call site: «באפליקציה באתר הרגיל זה כשורה ובמובייל זה רשימה» — a row of
 * tickets on the wide viewport, a vertical list on the phone.
 *
 * It is a plain class name and not a Tailwind string because the rule is in `plan-card.css`, where
 * the marketing site can read it too. That is also why it survives: a `xl:grid-cols-5` written here
 * would be invisible to the other repository and the two would drift again on the first change.
 */
export const PLAN_TRAY = 'plan-tray';

/**
 * THE LADDER'S OWN LOADING SHAPE, for both surfaces that draw it.
 *
 * Owner ruling 26.08.2026: «אם יש לי כבר שלד אין צורך בסמל הזה» — where a skeleton can hold the
 * real shape, a spinner has no job. The difference is measurable rather than stylistic: a centred
 * spinner has NO ladder under it, so the page throws away its own height while it loads and jumps
 * by the full height of five cards the moment the catalogue lands.
 *
 * It draws a REAL `.plan-card`, not a box guessed to be about the right height. The ticket's height
 * comes from its own padding and from the run of blocks inside it, so the only way for a
 * placeholder to hold that height through a redesign is to be built out of the same parts. A
 * `h-[29rem]` here would be correct exactly until someone changed the padding.
 *
 * The two surfaces differ in three facts, so those are the three props: `/pricing` shows the four
 * plans the server returns and NO action (its cards carry none, so an action bar would promise a
 * control the loaded page does not have), while the authenticated panel shows five and an action on
 * each, plus a heading inside the loading region.
 */
export function PlanTicketSkeleton({
  rows = 5, action = true, heading = false, testId,
}: {
  rows?: number;
  action?: boolean;
  heading?: boolean;
  testId?: string;
}) {
  const { t } = useT();
  return (
    <div role="status" aria-busy="true" className="space-y-4" data-testid={testId}>
      {/* One accessible name for the whole region — a screen reader meets the loading
          announcement, not a wall of empty boxes. Every `Skeleton` below is `aria-hidden`. */}
      <span className="sr-only">{t('planCard.loading')}</span>
      {heading && <Skeleton className="h-6 w-28" />}
      <ul className={PLAN_TRAY}>
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="plan-card">
            <span className="plan-card__head">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="size-10 rounded-[10px]" />
            </span>
            <Skeleton className="mx-auto h-6 w-24" />
            <div className="plan-card__who flex flex-col items-center gap-1.5">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="h-3 w-28" />
            </div>
            <span className="plan-card__perf" aria-hidden="true" />
            <Skeleton className="mx-auto h-2.5 w-10" />
            <Skeleton className="mx-auto mt-1.5 h-9 w-28" />
            <Skeleton className="mx-auto mt-1.5 h-3 w-12" />
            {action && (
              <div className="plan-card__action">
                <Skeleton className="h-11 w-full rounded-full" />
              </div>
            )}
            <span className="plan-card__perf" aria-hidden="true" />
            <Skeleton className="mx-auto h-2.5 w-14" />
            <Skeleton className="mx-auto mt-1.5 h-6 w-20" />
            <span className="plan-card__perf plan-card__perf--last" aria-hidden="true" />
            <Skeleton className="mt-auto h-[2.2rem] w-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}
