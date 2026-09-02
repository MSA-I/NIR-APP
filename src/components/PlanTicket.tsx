import type { ReactNode } from 'react';
import { Building, Building2, Check, Clock, Landmark, Lock, Sparkles, Sprout, Store, Wallet, X } from 'lucide-react';
import { Skeleton } from './ui';
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
 * ─── RE-TRANSCRIBED 02.09.2026, THE THIRD TIME ──────────────────────────────────────────────
 * 27.08 the ticket; 28.08 the marketing site replaced it; 31.08 re-transcribed to the five-face
 * card; 01.09 the marketing site rebuilt the chapter again ("ROUND 20", read off four
 * higgsfield.ai screenshots) and this component went stale the same afternoon. Measured 02.09.2026:
 * of the 37 classes that card renders, TWENTY-NINE did not exist here.
 *
 * Owner, 02.09.2026, asked which side wins on each axis: «מלל ותוכן — קוד ואפליקציה קובעים.
 * נראות UI קארדים קומפוננטות ונראות במובייל — אתר נחיתה קובע.» So the SHAPE below is that card's,
 * part for part, and every STRING is still this product's and still arrives as a prop.
 *
 * The anatomy is `PlansChapter.tsx:513-640` in `LANDING-PAGE-NIR` at `28d36b5`: a slot carrying a
 * label strip, then head (name, who, phone price chip), the quota panel, the figure, the billed
 * line, the action, and the two capability blocks.
 *
 * ─── WHAT THIS COMPONENT OWNS, AND WHAT IT REFUSES TO OWN ───────────────────────────────────
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
 * ─── THE FOUR PARTS OF THAT CARD THIS ONE DOES NOT DRAW, AND WHY ────────────────────────────
 * Each is a part whose CONTENT this product does not have, not a part of the look that was
 * dropped for taste — the distinction the owner's ruling turns on.
 *   1. `.plan-pick`, the phone's select circle. It selects a plan for ONE action pinned under the
 *      list. Neither surface here has that action (#217/#224), and a control that selects nothing
 *      is not a control.
 *   2. `.plan-card__save` and `.plan-card__badge--save`, the yearly saving. Both surfaces bill
 *      monthly and neither offers an interval toggle, so the saving is arithmetic over a second
 *      catalogue that is not on the screen.
 *   3. `.plan-card__was`, the struck monthly total. Same reason: it is the other interval.
 *   4. `.plan-card__more` / `.plan-card__ladder`, the phone expander. It holds the WHOLE fifteen-row
 *      comparison table for one plan, and that table is the marketing page's own chapter. This card
 *      already lists every row it received inline, at every width, so the expander would hide what
 *      is already there and then offer to show it again.
 * All four keep their rules in the stylesheet, because that file is a transcription and stays one.
 *
 * ─── AND IT DRAWS NO PLAN THE SERVER DID NOT SEND ───────────────────────────────────────────
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
 * The five faces, renamed with the card on 01.09.2026 and transcribed here on 02.09.2026.
 *
 * `plain` and `lift` are not colours: they are the page's ground and that ground raised a step, so
 * they follow whatever surface the card is dropped onto. The other three are objects and keep
 * their colour anywhere — `framed` is פרו's slate body inside its grey surround, `magenta` is
 * פרימיום, `slate` is ביזנס's quiet dark plate.
 *
 * `pointed`, `azure` and `deep` are GONE, and with them the gloss and the WebGL field. The
 * marketing site's own note on removing the field: «a second GL context for one card in a closed
 * tab is a cost with no reader.»
 */
type Face = 'plain' | 'lift' | 'framed' | 'magenta' | 'slate';

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

/**
 * WHICH ROWS FALL IN THE MONEY BLOCK — the marketing site's `GROUPS.money`, by entitlement key.
 *
 * The partition is the reference's and it is a fact about the catalogue rather than a layout
 * choice, which is why it is a set of keys here and not a flag on each row: a row added to `0213`
 * should reach both surfaces by existing, not by someone remembering to tag it twice.
 *
 * Anything not in this set is work. That direction is deliberate — a new capability is far more
 * likely to be something the product DOES than something it charges through, and an unrecognised
 * key landing in the money block would tell a reader the plan opens a payment door it does not.
 */
const MONEY_KEYS = new Set([
  'bank.reconciliation',
  'payments.accountant_queue',
  'invoices.consolidated',
  'integrations.api',
  'support.premium',
]);

export interface PlanTicketFeature {
  key: string;
  /** Free-form so a caller can put a `.num` figure inside it. */
  text: ReactNode;
  /**
   * A check mark ASSERTS that the rung includes this. A row that asserts nothing keeps its line
   * and loses its emphasis, which is what makes an absence visible at all rather than simply
   * missing.
   */
  affirmative: boolean;
  /**
   * Held for a window and then lost — the free plan's thirty days. Drawn as a CLOCK rather than a
   * tick, with the duration beside it.
   *
   * The marketing site learned this the hard way and wrote down why: with a plain tick «the free
   * card then read as the FULLEST card on the page: five ticks for five capabilities it loses on
   * day thirty-one. A tick that expires is not a tick.»
   */
  intro?: boolean;
}

/** One row of a block. Not exported: the blocks are this component's own anatomy. */
function BlockRow({ row, introTag }: { row: PlanTicketFeature; introTag: string }) {
  const intro = !row.affirmative && row.intro === true;
  const on = row.affirmative;
  return (
    <li className={`plan-row ${on ? '' : intro ? 'plan-row--intro' : 'plan-row--off'}`}>
      <span className="plan-row__mark" aria-hidden="true">
        {on ? <Check className="size-3.5" strokeWidth={2.6} />
          : intro ? <Clock className="size-3.5" strokeWidth={2.4} />
            : <X className="size-3.5" strokeWidth={2.6} />}
      </span>
      <span className="plan-row__label">{row.text}</span>
      {intro && <span className="plan-row__tag">{introTag}</span>}
    </li>
  );
}

export function PlanTicket({
  planKey, label, who, figure, figureIsWords = false, term,
  action, quotaLabel, quota, quotaLines = [], quotaChip, features = [], badgeLabel,
  moneyFromLabel, current = false,
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
   * THE QUOTA PANEL — new with ROUND 20, and the part of that card this product fits best.
   *
   * `quotaLabel` is its headline sentence and `quotaLines` the two under it, which on the
   * marketing site are the ladder's users and branches rows written out. They are WRITTEN OUT
   * there rather than composed, and the reason is a fact about Hebrew: a noun agrees with its
   * number, so a template concatenating a figure to a plural label prints «1 משתמשים פעילים» on
   * exactly the cards that hold the number one.
   *
   * `quota` still rides the panel as `data-plan-docs`, because a gate reads the published quota as
   * an attribute and never as text.
   */
  quotaLabel?: string;
  quota?: string;
  quotaLines?: readonly string[];
  /** The chip closing the panel — «מכסה קבועה, בלי חיוב לפי שימוש» there. */
  quotaChip?: string;
  features?: readonly PlanTicketFeature[];
  /** The badge riding the slot's strip. Only the recommended rung gets one, and only from #202. */
  badgeLabel?: string;
  /**
   * The name of the rung the money block opens on, for the grey twin's note. Absent means the
   * caller has nothing to name, and the note is then left off rather than guessed at.
   */
  moneyFromLabel?: string;
  /**
   * The rung this organization stands on — a REPORT, never a selection, because nothing on that
   * screen can be chosen (#217/#224). Always false on `/pricing`: a stranger holds no rung.
   */
  current?: boolean;
}) {
  const { t } = useT();
  const look = lookOf(planKey);
  const Glyph = look ? GLYPHS[look.icon] : Sprout;
  const face: Face = look?.face ?? 'plain';

  const money = features.filter((row) => MONEY_KEYS.has(row.key));
  const work = features.filter((row) => !MONEY_KEYS.has(row.key));
  const carriesMoney = money.some((row) => row.affirmative);
  const introTag = t('planCard.introTag');

  return (
    /* THE SLOT. The strip is the card's own label bar and the card tucks under it, so the two read
       as one object rather than as a label sitting on a card. A rung with no pointer keeps the
       strip's HEIGHT and says nothing in it, which is what puts every head on one line. */
    <li className={`plan-slot plan-slot--${face}`} data-plan-slot={planKey} data-face={face}>
      <span className={`plan-slot__strip ${badgeLabel ? '' : 'plan-slot__strip--blank'}`}>
        {badgeLabel}
      </span>

      {/* `data-plan` STAYS ON THE CARD, not on the slot the card now sits in. Both spec files and
          the browser gate address a rung with it, and a rung is the card; the slot is the frame
          the strip and the card share. The slot carries `data-plan-slot` so a caller that needs
          the frame can still reach it. */}
      <div
        className={`plan-card plan-card--${face}`}
        data-plan={planKey}
        data-current={current ? 'true' : 'false'}
        data-state={current ? 'current' : badgeLabel ? 'featured' : 'default'}
      >
        <div className="plan-card__head">
          <span className="plan-card__headtext">
            <span className="plan-card__title-row">
              <h3 className="plan-card__name">{label}</h3>
            </span>
            {who && <p className="plan-card__who">{who}</p>}
          </span>

          {/* The phone's figure chip, at the far edge of the head. Same figure as the block below;
              the card publishes the catalogue once, on the panel, so nothing is repeated here as
              an attribute. */}
          <span className="plan-card__chip" aria-hidden="true">
            <span className={`plan-card__price ${figureIsWords ? 'plan-card__price--words' : 'num'}`}>
              {figure}
            </span>
            {term && <span className="plan-card__per">{term}</span>}
          </span>
        </div>

        {quotaLabel !== undefined && (
          <div className="plan-quota" data-plan-docs={quota}>
            {/* THE NUMBER IS IN THE SENTENCE, not only in the attribute. The marketing site writes
                its head out whole — «20 מסמכים בחודש» — because it has no other slot for the
                figure; this product hands the figure and its label in separately, so they are put
                back together HERE rather than in each caller. A panel that printed the label alone
                would publish the quota to a gate and hide it from the reader. */}
            <p className="plan-quota__head">
              <Sparkles className="plan-quota__glyph size-4" strokeWidth={1.8} aria-hidden="true" />
              {quota !== undefined && <span className="num">{quota}</span>}
              {quotaLabel}
            </p>
            {quotaLines.length > 0 && (
              <ul className="plan-quota__lines">
                {quotaLines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            {quotaChip && (
              <p className="plan-quota__chip">
                <Check className="size-3.5" strokeWidth={2.6} aria-hidden="true" />
                {quotaChip}
              </p>
            )}
          </div>
        )}

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
        {/* The slot holds its height even when empty, or five cards in a row would start their
            blocks at five different offsets. */}
        <p className="plan-card__billed">{who ?? ''}</p>

        {action && <div className="plan-card__action">{action}</div>}

        {/* The head chip moved onto the work block on 02.09.2026: ROUND 20 has no icon slot in the
            card's head, and a glyph with nowhere to sit is not a transcription. The plan's mark is
            still drawn — by `.plan-badge-*`, wherever a plan is named. */}
        {work.length > 0 && (
          <div className="plan-block">
            <div className="plan-block__head">
              <Lock className="size-3.5" strokeWidth={2} aria-hidden="true" />
              <span className="plan-block__title">{t('planCard.blockWork')}</span>
            </div>
            <p className="plan-block__note">{t('planCard.blockWorkNote')}</p>
            <ul className="plan-block__rows">
              {work.map((row) => <BlockRow key={row.key} row={row} introTag={introTag} />)}
            </ul>
          </div>
        )}

        {money.length > 0 && (
          /* The grey twin. A group the plan does not carry is drawn as the same block in a quieter
             ink and NAMES the rung it opens on, rather than being left out — an absence with a
             door on it, instead of a gap the reader has to notice. */
          <div className={`plan-block ${carriesMoney ? 'plan-block--money' : 'plan-block--none'}`}>
            <div className="plan-block__head">
              <Wallet className="size-3.5" strokeWidth={2} aria-hidden="true" />
              <span className="plan-block__title">
                {carriesMoney ? t('planCard.blockMoney') : t('planCard.blockMoneyNone')}
              </span>
            </div>
            <p className="plan-block__note">
              {carriesMoney
                ? t('planCard.blockMoneyNote')
                : moneyFromLabel
                  ? t('planCard.blockMoneyFrom').replace('{name}', moneyFromLabel)
                  : ''}
            </p>
            <ul className="plan-block__rows">
              {money.map((row) => <BlockRow key={row.key} row={row} introTag={introTag} />)}
            </ul>
          </div>
        )}

        {/* The glyph the presentation file records, kept reachable for assistive text even though
            ROUND 20 gives it no visible chip. It names the rung, which is the one thing the card's
            own heading cannot do for a reader who meets the tray out of order. */}
        <span className="sr-only" data-plan-icon={look?.icon ?? 'Sprout'}>
          <Glyph aria-hidden="true" />
        </span>
      </div>
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
 * Owner ruling 26.08.2026: «אם יש לי כבר שלד אין צורך בספינר במסך הזה» — where a skeleton can hold
 * the real shape, a spinner has no job. The difference is measurable rather than stylistic: a
 * centred spinner has NO ladder under it, so the page throws away its own height while it loads and
 * jumps by the full height of five cards the moment the catalogue lands.
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
          <li key={index} className="plan-slot plan-slot--plain">
            <span className="plan-slot__strip plan-slot__strip--blank" />
            <div className="plan-card plan-card--plain">
              <div className="plan-card__head">
                <span className="plan-card__headtext">
                  <Skeleton className="h-6 w-24" />
                </span>
              </div>
              <div className="plan-quota">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="plan-card__pricing">
                <Skeleton className="h-9 w-24" />
              </div>
              <p className="plan-card__billed">
                <Skeleton className="h-3 w-32" />
              </p>
              {action && (
                <div className="plan-card__action">
                  <Skeleton className="h-11 w-full rounded-full" />
                </div>
              )}
              <div className="plan-block">
                <ul className="plan-block__rows">
                  {Array.from({ length: 5 }, (__, row) => (
                    <li key={row} className="plan-row">
                      <Skeleton className="size-[1.15rem] rounded-full" />
                      <Skeleton className="h-3 w-full" />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
