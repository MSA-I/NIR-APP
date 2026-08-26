/**
 * The approval surface for `products.display_name` — the one screen allowed to run the normaliser.
 *
 * `0149` adds a nullable canonical name and exactly one door to it (`set_product_display_name`,
 * owner/office, reason mandatory, audited). Nothing was backfilled: measured against production,
 * 39 of 271 names are stored in visual rather than logical order, so a parser let loose on the
 * catalogue would rename roughly one row in seven to a confident wrong answer, on every screen at
 * once. Each value therefore arrives here, is checked by a person, and is written one row at a time.
 *
 * WHY THIS IS ITS OWN FILE, AND NOT A BLOCK INSIDE `Products.tsx`.
 *
 * `productDisplayName.spec.ts` bans `src/pages` and `src/components` from importing the normaliser,
 * so that a canonical name can never quietly become "whatever the parser believes today". The rule
 * it states is *normalise at intake or approval, never per render* — and this screen is the
 * approval half of that sentence, the very caller the module's docblock names ("The review screen
 * is where that gets settled"). The guard is therefore an allowlist of approval surfaces rather
 * than a blanket ban, and this file is on it. `Products.tsx` deliberately is NOT: it renders a
 * column of product names in a table, which is precisely the hazard the guard exists to stop, so
 * the parser stays out of it and reaches it only through this component.
 *
 * WHAT A REVIEWER IS SHOWN, AND WHY EACH PART IS NON-NEGOTIABLE.
 *
 * The raw name, the proposal, and **what would be dropped** — together, in one card. `dropped` is
 * the whole reason the normaliser reports it: seeing `מותג: חברת דגן` leave the name is what makes
 * pressing אישור a check rather than an act of trust. A `conflict` gets no one-click approve at
 * all, because the owner's rule is that the system must not choose between two contradicting sizes
 * silently, and an approve button on a screen showing two candidates is exactly that choice made
 * by whoever clicks fastest. A `blocked` row says why it is blocked and offers manual entry only —
 * offering a proposal we do not have would be inventing one.
 *
 * WHY NO DIALOG DEMANDS A TYPED REASON.
 *
 * `reason.ts` records the owner's ruling that mandatory reason boxes produce "asdf", and
 * `transitionIntent.ts` narrows the question to *does this move undo, divert or override?*
 * Approving a proposal is neither — it is the ordinary forward step of this queue, repeated a few
 * hundred times, and a dialog on each one would guarantee both empty prose and an unworkable
 * screen. So the ledger gets its sentence from `reasonOr`, which says plainly that nobody added a
 * note, and the audit row carries the raw name beside the approved one (0149) — which is the part
 * that actually makes the decision explicable a year later. Manual entry keeps an *optional* box,
 * because a conflict or a reversed name is the one place a human sentence is worth something.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Info, Pencil, RotateCcw, SkipForward } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ICON, useToast } from '../components/ui';
import { toHebrewError } from '../lib/errors';
import { OPTIONAL_REASON_LABEL, reasonOr } from '../lib/reason';
import {
  MAX_DISPLAY_NAME_LENGTH,
  proposeDisplayName,
  type DisplayNameBlocked,
  type DisplayNameConflict,
  type DisplayNameVerdict,
} from '../lib/productDisplayName';
import type { Product } from '../lib/types';

/** Named in the audit row when the reviewer typed nothing; `reasonOr` completes the sentence. */
const APPROVE_ACTION = 'אישור השם הקנוני שהוצע למוצר';
const MANUAL_ACTION = 'הזנת שם קנוני ידנית למוצר';

const BLOCKED_SENTENCE: Record<DisplayNameBlocked['reason'], string> = {
  suspected_visual_order: 'שם ככל הנראה שמור בסדר הפוך — לא ניתן להציע לו שם קנוני.',
  too_short: 'לא נותר בשם די טקסט כדי להציע ממנו שם קנוני.',
};

/** The state in words, so the meaning never rests on the badge's hue alone. */
const VERDICT_LABEL: Record<DisplayNameVerdict['kind'], string> = {
  proposal: 'הצעה מוכנה',
  conflict: 'דורש הכרעה',
  blocked: 'לא ניתן להציע',
};

const VERDICT_BADGE: Record<DisplayNameVerdict['kind'], string> = {
  proposal: 'badge-info',
  conflict: 'badge-await',
  blocked: 'badge-idle',
};

/**
 * The module's `reasons` are English developer sentences with no code beside them, so they cannot
 * be translated for a Hebrew audience without matching on prose. The Hebrew is derived from the
 * SHAPE of the conflict instead, which distinguishes the two branches exactly: the disagreeing
 * sizes branch lists every size it found (two or more candidates), the over-length branch lists
 * the single name it composed.
 */
function conflictSentence(verdict: DisplayNameConflict): string {
  return verdict.candidates.length > 1
    ? 'השם מציין יותר מגודל אחד, והגדלים אינם מתיישבים זה עם זה. ההכרעה ביניהם שלך — המערכת אינה בוחרת.'
    : `השם הקנוני שנבנה ארוך מ־${MAX_DISPLAY_NAME_LENGTH} התווים שהעמודה מקבלת. קיצור הוא עריכה בשם שכל מסך יראה, ולכן נעשה בידיים.`;
}

const candidatesLabel = (verdict: DisplayNameConflict) =>
  verdict.candidates.length > 1 ? 'הגדלים שנמצאו בשם' : 'השם שנבנה';

export function ProductNameReview({ queue, onApproved }: {
  /**
   * Products whose `display_name` is null. `null` means the catalogue itself is unknown — the
   * screen then says so instead of rendering an empty queue, which would read as "nothing left".
   */
  queue: Product[] | null;
  /** Fires with the id of a product that now carries a canonical name. */
  onApproved: (productId: string) => void;
}) {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // One parse per product per load, not one per paint. `proposeDisplayName` never throws.
  const verdicts = useMemo(
    () => (queue ?? []).map((product) => ({
      product,
      verdict: proposeDisplayName(product.name, product.unit),
    })),
    [queue],
  );

  const pending = verdicts.filter(({ product }) => !skipped.has(product.id));

  function handleApproved(productId: string) {
    onApproved(productId);
    // The card holding focus is about to unmount. Land on the queue heading rather than on
    // <body> — the same recovery `Modal` performs when a step removes the focused control.
    headingRef.current?.focus();
  }

  return (
    <section className="space-y-4" aria-labelledby="name-review-heading">
      <div className="space-y-2">
        <h2 id="name-review-heading" ref={headingRef} tabIndex={-1}
          className="text-lg font-semibold text-ink focus:outline-none">
          שמות לאישור
        </h2>
        <p className="text-sm text-ink-soft">
          לכל מוצר מוצג השם השמור בקטלוג לצד השם הקנוני המוצע ומה יורד ממנו. השם השמור אינו משתנה —
          הוא זה שנשלח לספק ושלפיו מתבצעת ההתאמה למחירונים. כל אישור נרשם ביומן הביקורת.
        </p>
      </div>

      {queue === null ? (
        <div className="note-idle" role="status">
          <Info size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>הקטלוג לא נטען, ולכן לא ידוע כמה שמות ממתינים לאישור.</p>
        </div>
      ) : pending.length === 0 ? (
        <div className="note-done" role="status">
          <Check size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            {skipped.size > 0
              ? 'כל מה שנותר בתור דולג.'
              : 'לכל המוצרים בקטלוג יש שם קנוני מאושר.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map(({ product, verdict }) => (
            <ReviewCard key={product.id} product={product} verdict={verdict}
              onApproved={handleApproved}
              onSkip={(id) => setSkipped((current) => new Set(current).add(id))} />
          ))}
        </ul>
      )}

      {skipped.size > 0 && (
        <div className="note-idle flex-wrap items-center justify-between gap-3">
          <p>
            דולגו במושב הזה: <span className="num">{skipped.size}</span>. הדילוג אינו נשמר בשרת —
            המוצרים האלה יופיעו שוב בכניסה הבאה.
          </p>
          <button type="button" className="btn-ghost" onClick={() => setSkipped(new Set())}>
            <RotateCcw size={ICON.sm} aria-hidden="true" /> החזרת המדולגים לתור
          </button>
        </div>
      )}
    </section>
  );
}

function ReviewCard({ product, verdict, onApproved, onSkip }: {
  product: Product;
  verdict: DisplayNameVerdict;
  onApproved: (productId: string) => void;
  onSkip: (productId: string) => void;
}) {
  const toast = useToast();
  const fieldId = useId();
  const [busy, setBusy] = useState(false);
  /** Non-null while the inline editor is open. Per card: the queue is worked one row at a time. */
  const [draft, setDraft] = useState<{ value: string; reason: string } | null>(null);

  async function commit(displayName: string, action: string, typedReason?: string) {
    const value = displayName.trim();
    // The two shapes `set_product_display_name` refuses (0149), answered here so the reviewer is
    // told before a round trip rather than by a translated server error afterwards.
    if (!value) { toast('יש להזין שם קנוני לפני השמירה', 'error'); return; }
    if (value.length > MAX_DISPLAY_NAME_LENGTH) {
      toast(`השם הקנוני ארוך מ־${MAX_DISPLAY_NAME_LENGTH} תווים`, 'error');
      return;
    }

    setBusy(true);
    const res = await supabase.rpc('set_product_display_name', {
      p_product_id: product.id,
      p_display_name: value,
      p_reason: reasonOr(typedReason, action),
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('השם הקנוני נשמר');
    onApproved(product.id);
  }

  const unchanged = verdict.kind === 'proposal' && verdict.displayName === product.name.trim();

  return (
    <Card as="li" className="space-y-4" data-testid={`review-${product.id}`}
      data-verdict={verdict.kind}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-muted">השם השמור בקטלוג</p>
          {/* bdi on every name: the catalogue mixes Hebrew, Latin and digits, and some rows are
              malformed outright — without isolation one bad name reorders the line around it. */}
          <h3 className="text-sm font-medium text-ink-mid break-words"><bdi>{product.name}</bdi></h3>
        </div>
        <span className={VERDICT_BADGE[verdict.kind]}>{VERDICT_LABEL[verdict.kind]}</span>
      </div>

      {verdict.kind === 'proposal' && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-ink-muted">השם הקנוני המוצע</p>
            <p className="text-base font-medium text-ink break-words" data-testid="review-proposal">
              <bdi>{verdict.displayName}</bdi>
            </p>
            {unchanged && (
              <p className="text-xs text-ink-faint">
                זהה לשם השמור — האישור מסמן שנבדק, ואינו משנה את מה שמוצג.
              </p>
            )}
          </div>
          <div data-testid="review-dropped">
            {verdict.dropped.length > 0 ? (
              <>
                <p className="text-xs text-ink-muted mb-1">יורד מהשם</p>
                <ul className="flex flex-wrap gap-1.5">
                  {verdict.dropped.map((token, index) => (
                    <li key={`${token}-${index}`} className="badge-idle"><bdi>{token}</bdi></li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-ink-faint">לא יורד דבר מהשם השמור.</p>
            )}
          </div>
        </div>
      )}

      {verdict.kind === 'conflict' && (
        <div className="note-await" data-testid="review-conflict">
          <AlertTriangle size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p>{conflictSentence(verdict)}</p>
            <div>
              <p className="text-xs mb-1">{candidatesLabel(verdict)}</p>
              <ul className="flex flex-wrap gap-1.5">
                {verdict.candidates.map((candidate, index) => (
                  <li key={`${candidate}-${index}`} className="badge-await"><bdi>{candidate}</bdi></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {verdict.kind === 'blocked' && (
        <div className="note-idle" data-testid="review-blocked">
          <Info size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>{BLOCKED_SENTENCE[verdict.reason]}</p>
        </div>
      )}

      {draft ? (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor={`${fieldId}-name`}>השם הקנוני</label>
            <input id={`${fieldId}-name`} className="input" value={draft.value}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`${fieldId}-reason`}>{OPTIONAL_REASON_LABEL}</label>
            <textarea id={`${fieldId}-reason`} className="input" rows={2} maxLength={1000}
              value={draft.reason}
              onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => void commit(draft.value, MANUAL_ACTION, draft.reason)}>
              שמירת השם
            </button>
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => setDraft(null)}>ביטול</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* Only a proposal gets one press. A conflict reaching this branch would be the system
              choosing between two sizes on the reviewer's behalf — the one thing it must not do. */}
          {verdict.kind === 'proposal' && (
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => void commit(verdict.displayName, APPROVE_ACTION)}>
              <Check size={ICON.sm} aria-hidden="true" /> אישור
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy}
            onClick={() => setDraft({
              value: verdict.kind === 'proposal' ? verdict.displayName : '',
              reason: '',
            })}>
            <Pencil size={ICON.sm} aria-hidden="true" /> עריכה ואישור
          </button>
          <button type="button" className="btn-ghost" disabled={busy}
            onClick={() => onSkip(product.id)}>
            <SkipForward size={ICON.sm} aria-hidden="true" /> דילוג
          </button>
        </div>
      )}
    </Card>
  );
}
