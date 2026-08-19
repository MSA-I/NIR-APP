/**
 * Which status transitions owe the ledger an explanation, and which are just the next step.
 *
 * The owner's complaint (owner review, defect 5): every status change — including "העברה לבדיקה"
 * and "שליחה לאישור" — stopped to ask why. Moving a document one rung up the ladder it was already
 * on is not a decision that needs defending; it *is* the work. Asking there teaches people that the
 * box is noise, and once the box is noise the answers stop being read on the transitions that do
 * matter.
 *
 * So the question this file answers is narrow: **does this particular move need a human sentence?**
 * A move needs one when it undoes, diverts or overrides — cancelling, going backwards, opening an
 * investigation, or approving past a warning the system raised. Everything else is an ordinary
 * forward step and goes through with a toast.
 *
 * It never becomes a licence to write nothing to `audit_logs`. The ledger still gets a reason on
 * every transition — on the silent path the caller builds it with `reasonOr`, which names the action
 * and says plainly that nobody added a note (see `src/lib/reason.ts`). Both server commands reject a
 * blank reason outright (`invoice_review_fields_required` in 0023, `payment_request_transition_invalid`
 * in 0073), so "silent" here means *no dialog*, never *no audit line*.
 *
 * This is a **question about the move, not about permission**. Whether the transition is legal at
 * all stays where it belongs: `read_allowed_transitions` / `set_invoice_review_status` for invoices
 * and `p1_transition_payment_request` for payment requests. A status this file does not recognise
 * falls to the cautious side and asks.
 */

export type TransitionEntity = 'invoice_review' | 'payment_request';

/**
 * `null` = an ordinary forward step, no dialog. Anything else names *why* a sentence is owed.
 *
 * `'override'` is the one variant this function never returns: the two override dialogs — the
 * 3-way-match override in `InvoiceDetail` and the credit override in `PaymentRequests` — are not
 * status transitions and carry their own reason box, their own re-authentication and their own
 * server command. The variant is here so the vocabulary of "reasons a reason is demanded" stays
 * whole, not because this table decides those two.
 */
export type ReasonDemand = null | 'cancel' | 'backward' | 'investigation' | 'override' | 'exceptional_approval';

/**
 * The forward ladder per entity, in order. "Forward" means later in this list — nothing more.
 *
 * These are the happy-path rungs only. The statuses that are *not* here (`investigation`,
 * `suspected_duplicate`, `cancelled`) are off-ladder on purpose: arriving at one, or leaving one,
 * is by definition not an ordinary step forward.
 *
 * The `payment_request` ladder keeps `executed` and `matched` even though no button in the app
 * moves a request into them (the server graph in 0073 does not accept them from the client either).
 * They are the real end of the lifecycle, and leaving them out would rank a hypothetical
 * `executed → matched` as backwards.
 */
const FORWARD_LADDER: Record<TransitionEntity, readonly string[]> = {
  invoice_review: ['received', 'in_review', 'pending_approval', 'approved'],
  payment_request: ['draft', 'pending_approval', 'approved', 'sent_for_execution', 'executed', 'matched'],
};

/**
 * Destinations that always owe a sentence, whatever they came from.
 *
 * An invoice has no cancelled review status — a review that goes wrong goes to `investigation` —
 * so its map has the one entry. A payment request can be cancelled from almost anywhere, and that
 * is the single most consequential thing this screen can do to one.
 */
const ALWAYS_REASONED: Record<TransitionEntity, Readonly<Record<string, ReasonDemand>>> = {
  invoice_review: { investigation: 'investigation' },
  payment_request: { investigation: 'investigation', cancelled: 'cancel' },
};

export function reasonDemandFor(
  entity: TransitionEntity,
  from: string,
  to: string,
  flags?: { exceptional?: boolean },
): ReasonDemand {
  // An approval that proceeds past a warning the system raised is the whole reason the warning
  // exists. It asks first, before anything else here gets a say.
  if (flags?.exceptional) return 'exceptional_approval';

  const always = ALWAYS_REASONED[entity][to];
  if (always) return always;

  const ladder = FORWARD_LADDER[entity];
  const fromRank = ladder.indexOf(from);
  const toRank = ladder.indexOf(to);

  // Leaving an off-ladder status (investigation, suspected duplicate, cancelled) is a return to the
  // normal flow after something went wrong — the one place where "what did you find?" is worth
  // asking. An unrecognised source lands here too, and asking is the safe answer.
  if (fromRank === -1) return 'backward';

  // Equal rank cannot happen through the UI (both commands answer a no-op transition idempotently),
  // but it is not a step forward either, so it is not treated as one.
  if (toRank <= fromRank) return 'backward';

  return null;
}
