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
  /** The currency this supplier quotes in (0217). Offers in another are not comparable to it. */
  currency: string;
  minQty: number | null;
}

export interface LineComparison {
  status: LineComparisonStatus;
  /**
   * The currency the comparison was made in — the SELECTED offer's own. Offers quoted in any other
   * currency take no part: "choosing this supplier saved X against the next-cheapest" is a
   * sentence about one kind of money, and a $12 quote is not a runner-up to a ₪40 one, it is a
   * different question (OPEN-DECISIONS #277).
   */
  currency: string | null;
  /** Gap up to the next-cheapest usable offer. Non-null only when a runner-up exists. */
  savedVsNext: number | null;
  /** Gap down to the cheapest usable offer. Non-null only while `status` is 'overpaying'. */
  extraVsCheapest: number | null;
}

export interface ComparisonSummary {
  /** One entry per currency. RENAMED from `saved`: a basket that compares in two currencies has
   *  two savings and no third, and a reader still asking for one number should not compile. */
  savedByCurrency: { currency: string; amount: number }[] | null;
  extraByCurrency: { currency: string; amount: number }[] | null;
  overpayingCount: number;
}

const NO_BASIS: LineComparison = { status: 'no_basis', currency: null, savedVsNext: null, extraVsCheapest: null };
const singleOffer = (currency: string): LineComparison => (
  { status: 'single_offer', currency, savedVsNext: null, extraVsCheapest: null }
);

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
  const meetsMinimum = offers.filter((offer) => offer.minQty == null || qty >= offer.minQty);
  if (!selectedSupplierId || !meetsMinimum.length) return NO_BASIS;
  const chosen = meetsMinimum.find((offer) => offer.supplierId === selectedSupplierId);
  // A pinned supplier that no longer clears the line's min_qty is not a comparison, it is a block.
  // The blocked surface says so; here the honest answer is that there is no basis.
  if (!chosen) return NO_BASIS;

  // The comparison happens inside the chosen offer's currency. An offer in another currency is
  // neither cheaper nor dearer than it — it answers a different question — so it is left out
  // rather than sorted against it.
  const usable = meetsMinimum
    .filter((offer) => offer.currency === chosen.currency)
    .sort((a, b) => a.unitPrice - b.unitPrice
      || (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0));
  const selected = chosen;
  if (usable.length === 1) return singleOffer(chosen.currency);

  const selectedCents = lineCents(qty, selected.unitPrice);
  const cheapestCents = lineCents(qty, usable[0].unitPrice);

  if (selectedCents > cheapestCents) {
    return {
      status: 'overpaying',
      currency: selected.currency,
      savedVsNext: null,
      extraVsCheapest: moneyFromCents(selectedCents - cheapestCents),
    };
  }

  // Selected costs no more than the cheapest, so it IS the cheapest — by index when it is the sole
  // holder of that price, and by money when another supplier ties it. The runner-up is then the
  // best remaining option, which in a tie is the offer at the same price: "same price next door".
  const runnerUp = usable.find((offer) => offer.supplierId !== selectedSupplierId);
  if (!runnerUp) return singleOffer(selected.currency);
  const savedVsNext = moneyFromCents(lineCents(qty, runnerUp.unitPrice) - selectedCents);
  return {
    status: savedVsNext > 0 ? 'saved' : 'same_price',
    currency: selected.currency,
    savedVsNext,
    extraVsCheapest: null,
  };
}

export function summarizeComparison(lines: readonly LineComparison[]): ComparisonSummary {
  const savedCents = new Map<string, bigint>();
  const extraCents = new Map<string, bigint>();
  let hasRunnerUp = false;
  let overpayingCount = 0;

  const add = (totals: Map<string, bigint>, currency: string, value: number) => {
    totals.set(currency, (totals.get(currency) ?? 0n) + hundredths(value));
  };

  for (const line of lines) {
    if (line.savedVsNext != null) {
      hasRunnerUp = true;
      // Summed WITHIN each currency. A basket holding a shekel line and a dollar line saved money
      // twice over, in two kinds of money, and one figure covering both is neither of them.
      if (line.status === 'saved' && line.currency) add(savedCents, line.currency, line.savedVsNext);
    }
    if (line.status === 'overpaying') {
      overpayingCount += 1;
      if (line.extraVsCheapest != null && line.currency) add(extraCents, line.currency, line.extraVsCheapest);
    }
  }

  const asEntries = (totals: Map<string, bigint>) => [...totals]
    .map(([currency, cents]) => ({ currency, amount: moneyFromCents(cents) }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  // `—`, not `0`: with no runner-up anywhere there is nothing the basket was compared against, and
  // a zero would be a claim about reality rather than the absence of one.
  return {
    savedByCurrency: hasRunnerUp ? asEntries(savedCents) : null,
    extraByCurrency: overpayingCount ? asEntries(extraCents) : null,
    overpayingCount,
  };
}
