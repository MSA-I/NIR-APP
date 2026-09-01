import type { ReactNode } from 'react';
import { Building, Building2, Check, Landmark, Sprout, Store } from 'lucide-react';
import { Skeleton } from './ui';
import { PlanShader } from './PlanShader';
import { useT } from '../lib/i18n/LocaleProvider';
import presentation from '../data/plan-presentation.json';

/**
 * ONE RUNG OF THE LADDER — the marketing site's plan card, brought into the product.
 *
 * Owner ruling 27.08.2026 (OPEN-DECISIONS #296): «קח את המנגנון הקיים שיש בדף נחיתה וגם את העיצוב
 * שלו». A visitor who signed up used to meet a different-looking ladder on the other side of the
 * login screen than the one that convinced them. This component is that card, and it is
 * deliberately NOT a second interpretation of it: every class name below is the marketing site's
 * own, and every rule behind those names lives in `src/styles/plan-card.css`.
 *
 * ─── RE-TRANSCRIBED 31.08.2026 ────────────────────────────────────────────────────────────────
 * The first transcription copied the TICKET — perforations, a printed serial, a drawn barcode.
 * The marketing site replaced it on 28.08.2026 with a rectangular card on a step of colour, and
 * this component went on drawing the ticket for three days (`DEBT §30` there). Owner, 31.08.2026:
 * «הכרטיס של דף הנחיתה — תעביר אותו לאפליקציה», and asked whether the two moving parts came with
 * it, «1» — everything 1:1, the gloss and the shader field included.
 *
 * The anatomy below is `PlansChapter.tsx:300-430` in `LANDING-PAGE-NIR`: head, name, pricing,
 * billed, rule, list, action. The serial, the barcode and the perforation spans are GONE, because
 * the card they belonged to is gone.
 *
 * ─── WHAT THIS COMPONENT OWNS, AND WHAT IT REFUSES TO OWN ─────────────────────────────────────
 * It owns SHAPE. It owns NO FACT: every string it prints arrives as a prop, because the two
 * surfaces are allowed to say different things and the difference is the whole point of there
 * being two:
 *   * `/pricing` publishes no amount at all (owner decision 25.08.2026 / #267) — a public visitor
 *     has no verified billing country, so #208's currency rule cannot even decide which catalogue
 *     applies to them. Its figure slot carries the documents quota instead.
 *   * `/settings/subscription` knows the organization's country and publishes the price.
 *   * `/pricing` renders no action on a card at all: a "בחרו מסלול" button would be a selection
 *     control for a selection that does not exist (#217/#224).
 *
 * ─── AND IT DRAWS NO PLAN THE SERVER DID NOT SEND ─────────────────────────────────────────────
 * `LOOK` covers `business`, and that is not a way for a public surface to start showing it:
 * `get_public_plan_catalogue()` excludes Business in the SERVER (#194/#201), so `/pricing` never
 * receives a row to draw. The entry exists so that the one surface which does receive it — the
 * authenticated panel — draws the same card as every other rung rather than a fallback.
 */

/**
 * THE ONE QUOTA A CARD PUTS AT FIGURE SIZE, and the same key on both surfaces.
 *
 * #266 makes documents-per-usage-period the single metric a tenant card may publish: OCR pages are
 * derived from it (ten per document) and deliberately unpublished, and users and suppliers have no
 * counter behind them at all (DEBT §56). The public page may list the rest of the ladder's rows
 * beside it — it is a comparison — but the number that ANCHORS a rung is this one on both, or the
 * two screens would headline different things about the same plan.
 */
export const HEADLINE_QUOTA_KEY = 'documents.monthly';

/** The lucide glyph in the head chip, by the name the shared presentation file records. */
const GLYPHS = { Sprout, Store, Building2, Building, Landmark } as const;

/**
 * The five faces, named by the owner on 28.08.2026 and transcribed with the stylesheet.
 *
 * `plain` and `lift` are not colours: they are the page's ground and that ground raised a step, so
 * they follow whatever surface the card is dropped onto. The other three are objects and keep
 * their colour anywhere. Only `azure` carries the gloss and only `deep` carries the shader field —
 * that pairing is the owner's, not a default.
 */
type Face = 'plain' | 'lift' | 'pointed' | 'azure' | 'deep';

interface PlanLook {
  face: Face;
  icon: keyof typeof GLYPHS;
}

const LOOK = presentation.plans as Record<string, PlanLook>;

/**
 * The rung the vendor points at, read from the shared file rather than from a position in a list.
 *
 * The marketing site keys it to an INDEX (`RECOMMENDED = 2`), which is only correct while the
 * catalogue has exactly five plans in exactly that order — and the two surfaces do not even
 * receive the same number of rows, because Business is filtered in the server for one of them. A
 * plan key survives both.
 */
export const RECOMMENDED_PLAN: string = presentation.recommended;

/**
 * A rung the presentation file has no look for wears the plain face, rather than borrowing
 * another rung's. The same rule `planTierClass` already follows for the tier mark: a mark that is
 * wrong is worse than a mark that is missing, because `legacy` advertised as the free plan is a
 * claim about what somebody is paying for.
 */
const lookOf = (planKey: string): PlanLook | null => LOOK[planKey] ?? null;

export interface PlanTicketFeature {
  key: string;
  /** Free-form so a caller can put a `.num` figure inside it. */
  text: ReactNode;
  /**
   * A check mark ASSERTS that the rung includes this. A row that asserts nothing keeps its line
   * and loses its emphasis — `.is-absent` rules it through — which is what makes an absence
   * visible at all rather than simply missing.
   */
  affirmative: boolean;
}

export function PlanTicket({
  planKey, label, who, figure, figureIsWords = false, term,
  action, quotaLabel, quota, features = [], badgeLabel, current = false,
}: {
  /** Emitted as `data-plan`, which is how both spec files and the browser gate address a rung. */
  planKey: string;
  label: string;
  /**
   * The quiet line under the figure — the marketing site's `.plan-card__billed`, which says
   * «חיוב חודשי» there. The authenticated panel has something truer to put in that slot: which
   * rung this is RELATIVE TO YOURS, and whether it costs money.
   */
  who?: string;
  /** Already formatted by its caller (money through `src/lib/format.ts`). */
  figure: string;
  /**
   * Words in the figure slot rather than a number. «דברו איתנו» and «ללא עלות» set at the display
   * size read as a headline rather than as a figure, so they take the smaller of the two sizes.
   */
  figureIsWords?: boolean;
  /** The period beside the figure — the marketing site's `.plan-card__per`. */
  term?: string;
  /** The full-width action. `/pricing` passes none, and passes none on EVERY card equally. */
  action?: ReactNode;
  /**
   * The headline quota's label and value — the one number #266 lets a card publish.
   *
   * It is the FIRST ROW OF THE LIST here, not a block of its own. The marketing site prints that
   * row without its figure, because it has a comparison table under the cards to hold the
   * numbers; this product has no such table, and `.plan-card__row { flex: 1 1 auto }` exists in
   * the shared stylesheet precisely so a figure can sit at the far edge of a row. Same anatomy,
   * one slot used that the other surface leaves empty.
   */
  quotaLabel?: string;
  quota?: string;
  features?: readonly PlanTicketFeature[];
  /** The badge riding the head row. Only the recommended rung gets one, and only from #202. */
  badgeLabel?: string;
  /**
   * The rung this organization stands on — a REPORT, never a selection, because nothing on that
   * screen can be chosen (#217/#224). Always false on `/pricing`: a stranger holds no rung.
   */
  current?: boolean;
}) {
  const look = lookOf(planKey);
  const Glyph = look ? GLYPHS[look.icon] : Sprout;
  const face: Face = look?.face ?? 'plain';

  return (
    <li
      className={`plan-card plan-card--${face}`}
      data-plan={planKey}
      data-face={face}
      data-current={current ? 'true' : 'false'}
      data-state={current ? 'current' : badgeLabel ? 'featured' : 'default'}
    >
      {/* The gloss. One element, so a card that does not carry it costs nothing, and it sits
          behind everything the card says. */}
      {face === 'azure' && <span className="plan-card__gloss" aria-hidden="true" />}
      {/* The field. Its own gradient is under it either way, so a browser with no GL context
          shows the card the shader was painted to sit on rather than a hole. */}
      {face === 'deep' && <PlanShader className="plan-card__field" />}

      <span className="plan-card__head">
        <span className="plan-card__icon" aria-hidden="true">
          <Glyph className="size-[1.15rem]" strokeWidth={1.7} />
        </span>
        {badgeLabel && <span className="plan-card__badge">{badgeLabel}</span>}
      </span>

      <h3 className="plan-card__name">{label}</h3>

      <p className="plan-card__pricing">
        <span
          data-testid="plan-figure"
          data-plan-figure={figure}
          className={`plan-card__price ${figureIsWords ? 'plan-card__price--words' : 'num'}`}
        >
          {figure}
        </span>
        {term && <span className="plan-card__per">{term}</span>}
      </p>
      {/* The slot holds its height even when empty, or five cards in a row would start their rules
          at five different offsets. */}
      <p className="plan-card__billed">{who ?? ''}</p>

      <span className="plan-card__rule" aria-hidden="true" />

      <ul className="plan-card__list">
        {quota !== undefined && (
          <li>
            <span className="plan-card__tick">
              <Check className="size-3" strokeWidth={2.5} />
            </span>
            <span className="plan-card__row">{quotaLabel}</span>
            <span data-plan-docs={quota} className="num">{quota}</span>
          </li>
        )}
        {features.map((row) => (
          <li key={row.key} className={row.affirmative ? undefined : 'is-absent'}>
            <span className="plan-card__tick">
              <Check className="size-3" strokeWidth={2.5} />
            </span>
            <span className="plan-card__row">{row.text}</span>
          </li>
        ))}
      </ul>

      {action && <div className="plan-card__action">{action}</div>}
    </li>
  );
}

/**
 * THE TRAY. One class, both surfaces, and the owner's layout ruling of 27.08.2026 lives inside it
 * rather than at each call site: «באפליקציה באתר הרגיל זה כשורה ובמובייל זה רשימה» — a row of
 * cards on the wide viewport, a vertical list on the phone.
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
 * It draws a REAL `.plan-card`, not a box guessed to be about the right height, and its blocks are
 * the card's own parts in the card's own order. A `h-[29rem]` here would be correct exactly until
 * someone changed the padding.
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
          <li key={index} className="plan-card plan-card--plain">
            <span className="plan-card__head">
              <Skeleton className="size-[2.6rem] rounded-[12px]" />
            </span>
            <Skeleton className="h-7 w-28" />
            <div className="plan-card__pricing">
              <Skeleton className="h-9 w-24" />
            </div>
            <p className="plan-card__billed">
              <Skeleton className="h-3 w-32" />
            </p>
            <span className="plan-card__rule" aria-hidden="true" />
            <ul className="plan-card__list">
              {Array.from({ length: 5 }, (__, row) => (
                <li key={row}>
                  <Skeleton className="size-[1.15rem] rounded-full" />
                  <Skeleton className="h-3 w-full" />
                </li>
              ))}
            </ul>
            {action && (
              <div className="plan-card__action">
                <Skeleton className="h-11 w-full rounded-full" />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
