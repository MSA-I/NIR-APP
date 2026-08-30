import { useT } from '../lib/i18n/LocaleProvider';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Card, ICON, Skeleton } from './ui';
import type { TKey } from '../lib/i18n/t.ts';

/**
 * ONE RUNG OF THE LADDER, AS A ROW. Used by both surfaces that show the ladder.
 *
 * `/pricing` and `/settings/subscription` are the same product seen from two sides of the login
 * screen, and until this file they were not built the same way at all: the public page was a
 * horizontally scrolling comparison TABLE and the authenticated one was five small sunken boxes
 * inside a card. The owner's verdict on the second was blunt — «הכרטיסים של המנויים נראים כאילו
 * ילד בן 3 בנה אותם» — and the honest reading of it is that neither surface had a plan card at
 * all: one had rows, the other had containers.
 *
 * ─── WHY A LIST AND NOT A GRID (owner ruling, 26.08.2026) ─────────────────────────────────────
 * The first rebuild put five cards in a three-column grid. That layout has two faults and the
 * second is the one that decided it:
 *   * five rungs in three columns wrap 3 + 2 and leave a hole, and five columns crush every card
 *     to ~217px, which brings back chip wrapping and mis-aligned rules;
 *   * A GRID IS READ AS A SHELF OF EQUALS. A tier ladder is an ordered thing — the whole point is
 *     that `פרו` is above `בסיס` — and columns say the opposite of that. Rows are read in order,
 *     so the eye climbs.
 * It also collapses the two layouts into one: the grid already became a single column on a phone,
 * so this is the desktop meeting the phone rather than a second design for it.
 *
 * THE ROW USES THE WIDTH, which is the trap the ruling named: a 1100px-wide card with four
 * stacked lines centred in it is worse than the grid was. From `lg` the four blocks sit SIDE BY
 * SIDE — identity · figure · entitlements · action — and below `lg` the same four stack, which is
 * the card layout the previous round arrived at. One component, one order, two arrangements.
 *
 * ─── WHAT SURVIVED FROM THE CARD ROUND, AND WHERE IT CAME FROM ────────────────────────────────
 * FROM THE OWNER'S `PRICING.txt` (a shadcn `GrowthPlans`): the inverted fill on the promoted rung,
 * the figure as a LARGE number with its unit or period on the SAME baseline, generous padding, and
 * the check-glyph entitlement rows. The reading ORDER it fixed — identity, then figure, then what
 * you get, then the action — is unchanged; only the axis it runs along is.
 *
 * FROM ORIGIN UI'S PLAN LADDER (`radio-group/plans`) — and this is the reference the list layout
 * comes from — PER-ROW STATE: the row you are on raises itself, swaps its border and tints its
 * fill, and carries a per-item badge slot next to its label. The mechanism is not its
 * `has-[[data-state=checked]]`, because there is no radio here and there must not be:
 * `OrgSubscriptionPanel` renders NO affordance that could start a payment, and a radio group is a
 * selection control for a selection that does not exist. `data-state` is emitted anyway —
 * `current` / `featured` / `default` — because a state a screen shows should be a state a test can
 * address.
 *
 * FROM COSS-BADGE: one idea, a badge SIZE SCALE. `.plan-badge` is tuned for the 44px header
 * cluster and reads as a fallen-off label at row scale; `.plan-badge-lg` now exists in
 * `index.css` and this is its consumer.
 *
 * ─── AND NO STATUS COLOUR REACHES A PLAN ROW ──────────────────────────────────────────────────
 * `done` / `await` / `alert` / `info` / `idle` are the five claims the product makes about DATA
 * (DESIGN.md, §the wall between the two languages), and a commercial rung is not one of them. The
 * chips this component draws were `badge-idle` ("המסלול הנוכחי") and `badge-info` (the static
 * emphasis); both are now built from structural tokens.
 *
 * ─── THE INVERTED FILL ────────────────────────────────────────────────────────────────────────
 * Onyx, because onyx is already what the top of this ladder wears (`--color-tier-onyx`, and
 * `.plan-badge-premium` on top of it). Nothing here invents a promotion colour. Every text token
 * used on the fill is one of the three the dark shell already owns — `shell-ink` / `-soft` /
 * `-dim` — so the pairing is the one the palette was measured for rather than a fresh guess
 * (13.4:1, 10.0:1 and 6.0:1 against `--color-tier-onyx`).
 */
export interface PlanFeatureRow {
  key: string;
  /** The row's text. Free-form so a caller can put a `.num` figure inside it. */
  text: ReactNode;
  /**
   * A check mark ASSERTS that the rung includes this. A row whose value is «—» asserts nothing —
   * it is the honest state of a quota nothing measures (DEBT §56) — so it gets an EMPTY slot of
   * the tick's own width. Not a `Minus` glyph: the row already prints «—» as its value, and the
   * two together rendered the mark twice, «— משתמשים —», which reads as a typo. The spacer keeps
   * the label column aligned and the missing tick is the whole statement.
   */
  affirmative: boolean;
}

/**
 * HOW THE FIGURE IS SET, named by what it LOOKS like rather than by what it means — the same slot
 * legitimately holds three different kinds of thing across the two surfaces.
 *   * `anchor`  — a number, and the heaviest thing in the row: a price, or the published quota.
 *   * `compact` — words that stand in for a number: «דברו איתנו», «ללא הגבלה». At 36px those read
 *                 as a headline rather than as a figure.
 *   * `quiet`   — a short sentence or a lone dash, at body size and muted. This is the slot when
 *                 there is no figure to give, and it is deliberately NOT the anchor treatment:
 *                 setting an absence in the size reserved for a price is how «—» ended up looking
 *                 like a redaction bar.
 */
export type FigureTone = 'anchor' | 'compact' | 'quiet';

/**
 * THE STATIC ASCENDING EMPHASIS OF #202, AS ONE MAP FOR BOTH SURFACES.
 *
 * It lived in `Pricing.tsx` and the authenticated ladder had no emphasis at all, so the two
 * surfaces disagreed about which rung the product points at — the same class of drift that
 * `planTierClass` was extracted to end.
 *
 * STATIC IS THE WHOLE RULE AND IT IS NOT A STYLE CHOICE. #202: «המסלולים מקבלים הדגשה שיווקית
 * סטטית עולה, ופרימיום הוא הנחשק ביותר. ההדגשה אינה מבוססת על נתוני הדייר», and the same row
 * forbids «המלצה אישית למסלול». An earlier draft of this rebuild promoted "the next rung above
 * the one you are on", which is a better sales screen and is exactly what that sentence bans: it
 * is keyed to the reader's own subscription. Premium is emphasised on both surfaces, for everyone,
 * including an organization already on it — where the promotion simply reads as "you hold the most
 * comprehensive plan", which is true.
 *
 * The wording is provisional under #203, and `business` is deliberately absent: it is a contract
 * (#194/#201), not a marketed rung, and emphasising it would put the internal minimums one click
 * from a tenant screen.
 */
export const PLAN_EMPHASIS_KEY: Record<string, TKey> = { premium: 'planCard.emphasisPremium' };

/**
 * The single fallback: a rung the product does not point at carries no emphasis.
 *
 * `*_KEY`, so the compiler lists every render site. #202 makes this a STATIC marketing emphasis,
 * which means it is copy — and copy that a caller spread straight into a rendered list.
 */
export const planEmphasisKey = (planKey: string): TKey | null => PLAN_EMPHASIS_KEY[planKey] ?? null;

/**
 * THE ONE QUOTA A ROW PUTS AT FIGURE SIZE, and the same key on both surfaces.
 *
 * #266 makes documents-per-usage-period the single metric a tenant card may publish: OCR pages are
 * derived from it (ten per document) and deliberately unpublished, and users and suppliers have no
 * counter behind them at all (DEBT §56). The public page may list the rest of the ladder's rows
 * beside it — it is a comparison — but the number that ANCHORS a rung is this one on both, or the
 * two screens would headline different things about the same plan.
 */
export const HEADLINE_QUOTA_KEY = 'documents.monthly';

/**
 * WHICH OF THE TWO ARRANGEMENTS THIS RUNG IS DRAWN IN (owner ruling, 26.08.2026 — later the same
 * day as the list ruling below, and this is what it changed).
 *
 * The ruling that produced `PLAN_LIST` rejected a grid, and its reasons are still on record in
 * that constant. The owner then gave a reference image and settled the two questions the first
 * grid had got wrong: **grid on the wide viewport, one rung per line on the phone**, and **only on
 * `/settings/subscription`** — the public `/pricing` ladder stays a list, because it is a
 * comparison rather than a place you act.
 *
 * `'row'` is the four blocks side by side from `lg`. `'grid'` keeps the STACKED arrangement at
 * every width — which is exactly what the row already becomes below `lg`, so the phone layout the
 * owner asked to keep is the layout that was already there and no second design exists for it.
 * The only thing `'grid'` adds is what a column needs and a row does not: the card fills its
 * track's height and the action sits at the bottom, so the buttons across five cards of different
 * text lengths land on one line.
 */
export type PlanCardLayout = 'row' | 'grid';

export function PlanCard({
  planKey, label, tierClass, current = false, chips = [],
  standing, figure, figureTone = 'anchor', figureNote, action, features, layout = 'row',
}: {
  layout?: PlanCardLayout;
  /** Emitted as `data-plan`, which is how both spec files and the browser gate address a rung. */
  planKey: string;
  label: string;
  /**
   * `planTierClass(planKey)` — the ONE map, from `PlanBadge.tsx`. `null` for a rung the ladder has
   * no look for, and a rung with no look wears no mark rather than a borrowed one: DESIGN.md:503
   * requires the mark tapped in the header to be the mark found here, and `legacy` advertised as
   * the free plan is exactly how that promise breaks.
   */
  tierClass: string | null;
  /**
   * The rung this organization stands on. Origin UI's checked row, in our vocabulary: raised,
   * outlined and tinted. It is NOT a selection — nothing here can be chosen — it is a report.
   */
  current?: boolean;
  /**
   * The per-item badge slot. `isCurrent` / `isUpgrade` / `isDowngrade` and the static emphasis all
   * land here, in that order, so the chip about YOU precedes the chip about the product. Never a
   * status colour.
   */
  chips?: readonly string[];
  /** One line on what kind of rung this is. Omitted rather than padded when nothing is true. */
  standing?: string;
  /** The figure itself, already formatted by its caller (money through `src/lib/format.ts`). */
  figure: string;
  figureTone?: FigureTone;
  /** The unit or period, small and muted, on the figure's own baseline. */
  figureNote?: string;
  /** The full-width action, or a spacer of its height so the rows below still line up. */
  action?: ReactNode;
  features: readonly PlanFeatureRow[];
}) {
  /**
   * The row is FEATURED when the ladder's static emphasis points at it. Derived here rather than
   * passed, so no caller can promote a rung the emphasis map does not name — which is #202's rule
   * turned into something a second surface cannot get wrong.
   */
  const featured = planEmphasisKey(planKey) !== null;

  /**
   * The two palettes a row can wear, resolved once. Written as a table rather than as a ternary at
   * each of the eleven sites because the failure mode of the second form is one site quietly
   * keeping `text-ink-body` on the dark fill — legible in review, invisible in a diff.
   */
  const tone = featured
    ? {
      name: 'text-shell-ink',
      body: 'text-shell-ink-soft',
      muted: 'text-shell-ink-dim',
      chip: 'bg-on-solid/10 text-shell-ink ring-1 ring-on-solid/25',
      tick: 'text-shell-ink-soft',
      /**
       * Origin UI's `border-ring` on the checked row, light enough to survive the onyx fill.
       *
       * `outline`, NOT `ring`, and that is a measurement rather than a preference: Tailwind's
       * `ring-*` and `shadow-*` both compile into the one `box-shadow` declaration, so on the row
       * that is featured AND current — an organization sitting on `premium`, which is every
       * organization until the pre-launch window closes — `shadow-dialog` overwrote the ring and
       * the current-plan marker silently vanished. `outline` is its own property and cannot
       * collide. The negative offset draws it inside the 24px radius rather than around it.
       */
      currentOutline: 'outline-2 -outline-offset-2 outline-on-solid/50',
    }
    : {
      name: 'text-ink',
      body: 'text-ink-body',
      muted: 'text-ink-muted',
      chip: 'bg-canvas text-ink-soft ring-1 ring-line',
      tick: 'text-action',
      currentOutline: 'outline-2 -outline-offset-2 outline-action',
    };

  const figureClass = {
    anchor: `num leading-none font-semibold text-3xl sm:text-4xl ${tone.name}`,
    compact: `leading-tight font-semibold text-xl ${tone.name}`,
    quiet: `text-sm ${tone.muted}`,
  }[figureTone];

  return (
    <Card
      as="li"
      pad={false}
      /* A 24px radius that its own children can paint over is a rounded rectangle with square
         corners, and `clip` is `Card`'s own answer to that. It also contains any decoration that
         would otherwise scroll the page sideways. The row's outline and shadow are unaffected;
         `overflow` clips descendants, never the element's own box-shadow or outline. */
      clip
      data-plan={planKey}
      data-layout={layout}
      data-state={current ? 'current' : featured ? 'featured' : 'default'}
      className={`relative flex flex-col gap-4 p-5 sm:p-6 ${
        layout === 'grid' ? 'h-full' : 'lg:flex-row lg:items-center lg:gap-8'
      } ${featured ? 'z-10 bg-tier-onyx shadow-dialog' : current ? 'z-10 bg-surface-selected' : ''
      } ${current ? tone.currentOutline : ''}`}
    >
      {/* 1 — WHICH RUNG. Fixed width from `lg` so the marks form a column the eye can run down;
             that column IS the ladder. Below `lg` it is simply the first block in the stack. */}
      <div className={`min-w-0 ${layout === 'grid' ? '' : 'lg:w-60 lg:shrink-0'}`}>
        <div className="flex flex-wrap items-center gap-2">
          {tierClass
            // The header's chip at row scale (`.plan-badge-lg`). On the inverted fill it gains a
            // hairline so a metal does not dissolve into the onyx behind it — a ring is
            // separation, not a second mark.
            ? (
              <span className={`plan-badge plan-badge-lg ${tierClass} ${featured ? 'ring-1 ring-on-solid/30' : ''}`}>
                {label}
              </span>
            )
            : <span className={`text-base font-medium ${tone.name}`}>{label}</span>}
          {chips.map((text) => <span key={text} className={`badge ${tone.chip}`}>{text}</span>)}
        </div>
        {standing && <p className={`mt-2 text-sm ${tone.muted}`}>{standing}</p>}
      </div>

      {/* 2 — WHAT IT COSTS. The figure and its unit share ONE baseline — `items-baseline`, not two
             stacked lines. That pairing is the whole reason the block reads as a price rather than
             as two facts. No count-up: DESIGN.md:1111 bans one outright, and the reference's
             `NumberFlow` is exactly that — a figure that rolls up in a financial system reads as a
             slot machine. */}
      <p data-testid="plan-figure"
        className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 ${
          layout === 'grid' ? '' : 'lg:w-56 lg:shrink-0'}`}>
        <span className={figureClass}>{figure}</span>
        {figureNote && <span className={`text-sm ${tone.muted}`}>{figureNote}</span>}
      </p>

      {/* 3 — WHAT IT INCLUDES. Sized to its content, NOT `flex-1`, and that is the difference
             between a ladder and a spreadsheet. Given the row's slack, a single entitlement — which
             is what the authenticated ladder has, because #266 publishes exactly one quota — sat
             marooned in the middle of 300px of nothing. Held to its content it stays beside the
             price, so a rung reads as one phrase: this is the plan, this is what it costs, this is
             what you get. The slack goes to the margin before the action instead, where an empty
             gap is what separates a statement from a control. */}
      {features.length > 0 && (
        /* In a column the entitlements are a LIST, one per line, which is the reference's own
           check-glyph block and what the extra vertical room is for. In a row they wrap inline
           beside the price — see the note above about a single entitlement marooned in 300px. */
        <ul className={`flex min-w-0 gap-x-6 gap-y-2 ${
          layout === 'grid' ? 'flex-col' : 'flex-wrap'}`}>
          {features.map((row) => (
            <li key={row.key} className={`flex items-start gap-2 text-sm ${tone.body}`}>
              {row.affirmative
                ? <Check size={ICON.sm} aria-hidden className={`mt-1 shrink-0 ${tone.tick}`} />
                : <span aria-hidden className="mt-1 shrink-0" style={{ inlineSize: ICON.sm }} />}
              <span className="min-w-0">{row.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 4 — WHAT YOU CAN DO. Last, and pushed to the row's END by `ms-auto`, which is where a
             control belongs on a line that is read start-to-end. A rung with no action passes a
             spacer of the button's own height so the rows keep an even rhythm rather than one of
             them sitting 44px shorter than its neighbours. */}
      {/* `mt-auto` in a column is the counterpart of `ms-auto` in a row: the same rule — the
          control sits at the far end of the reading direction — and it is what puts five buttons
          on one line when the cards above them are different heights. */}
      {action && (
        <div className={layout === 'grid' ? 'mt-auto' : 'lg:ms-auto lg:w-52 lg:shrink-0'}>{action}</div>
      )}
    </Card>
  );
}

/**
 * THE LADDER ITSELF: a vertical list, one rung per row, in the server's tier order.
 *
 * Not a grid at any width. The gap is what keeps the rungs reading as separate objects rather than
 * as ruled rows in a table — a table would be `-space-y-px` and shared borders, which is exactly
 * what Origin UI's reference does and exactly what this is not: these rows are cards, each with
 * its own fill and elevation, stacked.
 */
export const PLAN_LIST = 'flex flex-col gap-3';

/**
 * THE SAME LADDER AS COLUMNS, for `/settings/subscription` only (owner ruling, 26.08.2026, with a
 * reference image: «רשת באתר המותאם · שורה במובייל · רק מה שבאפליקציה בהגדרות»).
 *
 * ONE COLUMN UNTIL `lg`, which is the phone half of the ruling and costs nothing: a one-column
 * grid IS the stacked list, so there is no second layout to keep in step — the same cards, the
 * same order, the same gap.
 *
 * `xl:grid-cols-5` and not `lg:`, because the first grid's real defect was arithmetic and it is
 * still true: five tracks need room. At `lg` (64rem) five columns are ~11rem each and every chip
 * wraps; the ladder therefore goes 1 → 2 → 5 and skips the widths in between, and the page's own
 * container was widened to `max-w-7xl` so that `xl` actually has 5 × ~14rem to give.
 *
 * `items-stretch` (grid's default, stated because it is load-bearing) plus `h-full` on the card is
 * what lets `mt-auto` line the five actions up: without the stretch each card is only as tall as
 * its own text and the buttons stagger.
 */
export const PLAN_GRID = 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5 xl:gap-4';

/**
 * THE LADDER'S OWN LOADING SHAPE, for BOTH surfaces that draw the ladder.
 *
 * Owner ruling, 26.08.2026: «אם יש לי כבר שלד אין צורך בסמל הזה» — where a skeleton can hold the
 * real shape, a spinner has no job. The two are not interchangeable and the difference is
 * measurable rather than stylistic: `PageLoader` is a centred figure with `py-24` and NO ladder
 * under it, so `/pricing` threw away its own height while it loaded and the page jumped by the
 * full height of five cards the moment the catalogue landed. A skeleton that holds the rows holds
 * the height, and nothing moves.
 *
 * It lives HERE, next to `PLAN_LIST` and `PlanCard`, because a placeholder for a shape is only
 * honest while it tracks that shape: the row geometry below is `PlanCard`'s own — the same
 * `lg:w-60` identity column, the same `p-5 sm:p-6`, the same `lg:gap-8` — and a copy in the other
 * file would be the second answer that drifts the next time the row changes. The two surfaces
 * differ in exactly two facts, so those are the two props:
 *   * `/settings/subscription` shows five rungs and an action on each; `/pricing` shows the
 *     server's four and renders NO action at all (it is a comparison, not an upgrade surface), so
 *     drawing an action bar there would promise a control the loaded page does not have.
 *   * only the authenticated ladder has a section heading inside the loading region («כל
 *     המסלולים»); the public page's `h1` is static text that never leaves the screen, so it is
 *     painted for real rather than faked.
 */
export function PlanLadderSkeleton({
  rows = 5, action = true, heading = false, testId, layout = 'row',
}: {
  rows?: number;
  /** Draw the action-slot bar. False on `/pricing`, whose cards carry no action. */
  action?: boolean;
  /** Stand in for a section title INSIDE the region. The page `h1` is never faked. */
  heading?: boolean;
  testId?: string;
  /** Must match the layout the caller then renders, or the page jumps when the data lands. */
  layout?: PlanCardLayout;
}) {
  const { t } = useT();
  const grid = layout === 'grid';
  return (
    <div role="status" aria-busy="true" className="space-y-4" data-testid={testId}>
      {/* One accessible name for the whole region — a screen reader meets the loading word, not a
          wall of empty boxes. Every `Skeleton` below is `aria-hidden`. */}
      <span className="sr-only">{t('planCard.loading')}</span>
      {heading && <Skeleton className="h-6 w-28" />}
      <ul className={grid ? PLAN_GRID : PLAN_LIST}>
        {Array.from({ length: rows }, (_, index) => (
          <li key={index}
            className={`card flex flex-col gap-4 p-5 sm:p-6 ${
              grid ? 'h-full' : 'lg:flex-row lg:items-center lg:gap-8'}`}>
            <div className={`space-y-2 ${grid ? '' : 'lg:w-60 lg:shrink-0'}`}>
              <Skeleton className="h-7 w-20 rounded-full" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className={`h-9 w-24 ${grid ? '' : 'lg:shrink-0'}`} />
            <Skeleton className={grid ? 'h-4 w-40' : 'h-4 w-40 flex-1'} />
            {action && (
              <Skeleton className={`h-11 w-full rounded-lg ${
                grid ? 'mt-auto' : 'lg:w-52 lg:shrink-0'}`} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
