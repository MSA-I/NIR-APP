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
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Info, Pencil, RotateCcw, SkipForward } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ICON, useToast } from '../components/ui';
import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from '../lib/reason';
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

const BLOCKED_KEY: Record<DisplayNameBlocked['reason'], TKey> = {
  suspected_visual_order: 'productNameReview.blockedVisualOrder',
  too_short: 'productNameReview.blockedTooShort',
};

/** The state in words, so the meaning never rests on the badge's hue alone. */
const VERDICT_KEY: Record<DisplayNameVerdict['kind'], TKey> = {
  proposal: 'productNameReview.verdictProposal',
  conflict: 'productNameReview.verdictConflict',
  blocked: 'productNameReview.verdictBlocked',
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
function conflictKey(verdict: DisplayNameConflict): TKey {
  return verdict.candidates.length > 1
    ? 'productNameReview.conflictSizes'
    : 'productNameReview.conflictTooLong';
}

const candidatesKey = (verdict: DisplayNameConflict): TKey =>
  (verdict.candidates.length > 1 ? 'productNameReview.candidatesSizes' : 'productNameReview.candidatesComposed');

export function ProductNameReview({ queue, onApproved }: {
  /**
   * Products whose `display_name` is null. `null` means the catalogue itself is unknown — the
   * screen then says so instead of rendering an empty queue, which would read as "nothing left".
   */
  queue: Product[] | null;
  /** Fires with the id of a product that now carries a canonical name. */
  onApproved: (productId: string) => void;
}) {
  const { t } = useT();
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
          {t('productNameReview.text')}
        </h2>
        <p className="text-sm text-ink-soft">
          {t('productNameReview.intro')}
        </p>
      </div>

      {queue === null ? (
        <div className="note-idle" role="status">
          <Info size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>{t('productNameReview.text_4')}</p>
        </div>
      ) : pending.length === 0 ? (
        <div className="note-done" role="status">
          <Check size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            {skipped.size > 0
              ? t('productNameReview.text_5')
              : t('productNameReview.text_6')}
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
            {t('productNameReview.skippedNote', { count: skipped.size })}
          </p>
          <button type="button" className="btn-ghost" onClick={() => setSkipped(new Set())}>
            <RotateCcw size={ICON.sm} aria-hidden="true" /> {t('productNameReview.restoreSkipped')}
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
  const { errorText, t } = useT();
  const toast = useToast();
  const fieldId = useId();
  const [busy, setBusy] = useState(false);
  /** Non-null while the inline editor is open. Per card: the queue is worked one row at a time. */
  const [draft, setDraft] = useState<{ value: string; reason: string } | null>(null);

  async function commit(displayName: string, action: string, typedReason?: string) {
    const value = displayName.trim();
    // The two shapes `set_product_display_name` refuses (0149), answered here so the reviewer is
    // told before a round trip rather than by a translated server error afterwards.
    if (!value) { toast(t('productNameReview.toast'), 'error'); return; }
    if (value.length > MAX_DISPLAY_NAME_LENGTH) {
      toast(t('productNameReview.nameTooLong', { max: MAX_DISPLAY_NAME_LENGTH }), 'error');
      return;
    }

    setBusy(true);
    const res = await supabase.rpc('set_product_display_name', {
      p_product_id: product.id,
      p_display_name: value,
      p_reason: reasonOr(typedReason, action),
    });
    setBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('productNameReview.toast_2'));
    onApproved(product.id);
  }

  const unchanged = verdict.kind === 'proposal' && verdict.displayName === product.name.trim();

  return (
    <Card as="li" className="space-y-4" data-testid={`review-${product.id}`}
      data-verdict={verdict.kind}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-muted">{t('productNameReview.text_8')}</p>
          {/* bdi on every name: the catalogue mixes Hebrew, Latin and digits, and some rows are
              malformed outright — without isolation one bad name reorders the line around it. */}
          <h3 className="text-sm font-medium text-ink-mid break-words"><bdi>{product.name}</bdi></h3>
        </div>
        <span className={VERDICT_BADGE[verdict.kind]}>{t(VERDICT_KEY[verdict.kind])}</span>
      </div>

      {verdict.kind === 'proposal' && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-ink-muted">{t('productNameReview.text_9')}</p>
            <p className="text-base font-medium text-ink break-words" data-testid="review-proposal">
              <bdi>{verdict.displayName}</bdi>
            </p>
            {unchanged && (
              <p className="text-xs text-ink-faint">
                {t('productNameReview.text_10')}
              </p>
            )}
          </div>
          <div data-testid="review-dropped">
            {verdict.dropped.length > 0 ? (
              <>
                <p className="text-xs text-ink-muted mb-1">{t('productNameReview.text_11')}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {verdict.dropped.map((token, index) => (
                    <li key={`${token}-${index}`} className="badge-idle"><bdi>{token}</bdi></li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-ink-faint">{t('productNameReview.text_12')}</p>
            )}
          </div>
        </div>
      )}

      {verdict.kind === 'conflict' && (
        <div className="note-await" data-testid="review-conflict">
          <AlertTriangle size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p>{t(conflictKey(verdict), { max: MAX_DISPLAY_NAME_LENGTH })}</p>
            <div>
              <p className="text-xs mb-1">{t(candidatesKey(verdict))}</p>
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
          <p>{t(BLOCKED_KEY[verdict.reason])}</p>
        </div>
      )}

      {draft ? (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor={`${fieldId}-name`}>{t('productNameReview.canonicalNameLabel')}</label>
            <input id={`${fieldId}-name`} className="input" value={draft.value}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`${fieldId}-reason`}>{t(OPTIONAL_REASON_LABEL_KEY)}</label>
            <textarea id={`${fieldId}-reason`} className="input" rows={2} maxLength={1000}
              value={draft.reason}
              onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => void commit(draft.value, MANUAL_ACTION, draft.reason)}>
              {t('productNameReview.text_13')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => setDraft(null)}>{t('productNameReview.setDraft')}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* Only a proposal gets one press. A conflict reaching this branch would be the system
              choosing between two sizes on the reviewer's behalf — the one thing it must not do. */}
          {verdict.kind === 'proposal' && (
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => void commit(verdict.displayName, APPROVE_ACTION)}>
              <Check size={ICON.sm} aria-hidden="true" /> {t('productNameReview.approve')}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy}
            onClick={() => setDraft({
              value: verdict.kind === 'proposal' ? verdict.displayName : '',
              reason: '',
            })}>
            <Pencil size={ICON.sm} aria-hidden="true" /> {t('productNameReview.editAndApprove')}
          </button>
          <button type="button" className="btn-ghost" disabled={busy}
            onClick={() => onSkip(product.id)}>
            <SkipForward size={ICON.sm} aria-hidden="true" /> {t('productNameReview.skip')}
          </button>
        </div>
      )}
    </Card>
  );
}
