/**
 * What one supplier choice bought you, per line.
 *
 * The comparison panel used to headline "חיסכון אפשרי בבחירה הזולה" — the distance from what is
 * selected down to the cheapest offer. Once the cheapest offer is selected, which is the normal
 * case, every one of those distances is zero and the headline read ₪0.00 (owner report, 19.08.2026).
 * The figure was arithmetically true and told the manager nothing.
 *
 * This module answers the question the manager was actually asking: having picked the cheapest
 * offer, how much did that choice save against the NEXT-cheapest one. Not against the dearest —
 * that inflates the number by comparing a real decision with one nobody was going to make.
 *
 * Two claims, never netted. "You saved X" and "you are paying X more than you had to" are
 * different statements about the basket; a single number that subtracts one from the other is
 * true of neither, so `saved` and `extra` are summed separately and reported separately.
 *
 * Distinct from `calculateOrderSavings` in ./orderSavings — that one prices consolidating the
 * whole basket onto a single supplier. Same screen, different question.
 */
// Explicit extension, the same reason ./orderSplit.ts gives for its own: Vite accepts either, and
// `allowImportingTsExtensions` type-checks this form, but a direct Node or Deno resolver does not
// guess. Deno matters here now — supabase/functions/assistant/tools/getPurchaseComparison.ts
// imports compareLine/summarizeComparison from this file so the saving formula has exactly one
// implementation across the screen and the assistant.
import { centsFromUnits, hundredths, lineUnits, moneyFromCents } from './orderSavings.ts';

export type LineComparisonStatus = 'saved' | 'same_price' | 'overpaying' | 'single_offer' | 'no_basis';

export interface OfferQuote {
  supplierId: string;
  unitPrice: number;
  minQty: number | null;
}

export interface LineComparison {
  status: LineComparisonStatus;
  /** Gap up to the next-cheapest usable offer. Non-null only when a runner-up exists. */
  savedVsNext: number | null;
  /** Gap down to the cheapest usable offer. Non-null only while `status` is 'overpaying'. */
  extraVsCheapest: number | null;
}

export interface ComparisonSummary {
  saved: number | null;
  extra: number | null;
  overpayingCount: number;
}

const NO_BASIS: LineComparison = { status: 'no_basis', savedVsNext: null, extraVsCheapest: null };
const SINGLE_OFFER: LineComparison = { status: 'single_offer', savedVsNext: null, extraVsCheapest: null };

/** Line total in exact cents — the integer-hundredths path documented in ./orderSavings. */
const lineCents = (qty: number, unitPrice: number) => centsFromUnits(lineUnits(qty, unitPrice));

export function compareLine(
  qty: number,
  offers: readonly OfferQuote[],
  selectedSupplierId: string | null,
): LineComparison {
  // Sorted here as well as by the caller. `NewOrder.tsx` already hands offers over cheapest-first
  // with a supplierId tiebreak, so this changes nothing for the screen — it only stops the whole
  // claim from depending on an ordering that lives in another file.
  const usable = offers
    .filter((offer) => offer.minQty == null || qty >= offer.minQty)
    .sort((a, b) => a.unitPrice - b.unitPrice
      || (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0));

  if (!selectedSupplierId || !usable.length) return NO_BASIS;
  const selected = usable.find((offer) => offer.supplierId === selectedSupplierId);
  // A pinned supplier that no longer clears the line's min_qty is not a comparison, it is a block.
  // The blocked surface says so; here the honest answer is that there is no basis.
  if (!selected) return NO_BASIS;
  if (usable.length === 1) return SINGLE_OFFER;

  const selectedCents = lineCents(qty, selected.unitPrice);
  const cheapestCents = lineCents(qty, usable[0].unitPrice);

  if (selectedCents > cheapestCents) {
    return {
      status: 'overpaying',
      savedVsNext: null,
      extraVsCheapest: moneyFromCents(selectedCents - cheapestCents),
    };
  }

  // Selected costs no more than the cheapest, so it IS the cheapest — by index when it is the sole
  // holder of that price, and by money when another supplier ties it. The runner-up is then the
  // best remaining option, which in a tie is the offer at the same price: "same price next door".
  const runnerUp = usable.find((offer) => offer.supplierId !== selectedSupplierId);
  if (!runnerUp) return SINGLE_OFFER;
  const savedVsNext = moneyFromCents(lineCents(qty, runnerUp.unitPrice) - selectedCents);
  return { status: savedVsNext > 0 ? 'saved' : 'same_price', savedVsNext, extraVsCheapest: null };
}

export function summarizeComparison(lines: readonly LineComparison[]): ComparisonSummary {
  let savedCents = 0n;
  let extraCents = 0n;
  let hasRunnerUp = false;
  let overpayingCount = 0;

  for (const line of lines) {
    if (line.savedVsNext != null) {
      hasRunnerUp = true;
      if (line.status === 'saved') savedCents += hundredths(line.savedVsNext);
    }
    if (line.status === 'overpaying') {
      overpayingCount += 1;
      if (line.extraVsCheapest != null) extraCents += hundredths(line.extraVsCheapest);
    }
  }

  // `—`, not `0`: with no runner-up anywhere there is nothing the basket was compared against, and
  // a zero would be a claim about reality rather than the absence of one.
  return {
    saved: hasRunnerUp ? moneyFromCents(savedCents) : null,
    extra: overpayingCount ? moneyFromCents(extraCents) : null,
    overpayingCount,
  };
}
