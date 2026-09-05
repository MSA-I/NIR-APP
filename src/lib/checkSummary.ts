import type { CheckCode, CheckResult } from './checks';
import type { TKey } from './i18n/t';

/**
 * One reading of an automatic-check run: what blocks, what is only a warning, what is context,
 * and — when the blocking code has a known remedy — the single step that clears it.
 *
 * This lives outside the screen because the partition is a decision about money, not about
 * layout. `critical` is the severity the server also refuses on (`payment_request_checks_failed`,
 * 0073:650-656), and everything under it is advisory. The screen renders this; this module
 * decides it, and a test can pin it without mounting a modal.
 */
export interface ChecksSummary {
  /** Severity `critical` — the approval routes close on these. */
  blocking: CheckResult[];
  /** Severity `warning` — worth reading before approving, never a reason to refuse. */
  warnings: CheckResult[];
  /** Severity `info` — context the user did not ask for and cannot act on. */
  info: CheckResult[];
  /**
   * The next step that clears the block, or `null` when none is known.
   *
   * `null` is the honest answer far more often than it looks. Inventing a next step on a screen
   * that moves money is worse than saying nothing: the user follows it, it does not work, and the
   * screen has now lied about what the system can do. A code earns a line in `REQUIRED_ACTION_KEY`
   * only when the remedy is already established somewhere in the product, not when it is merely
   * plausible.
   *
   * One step, not a list: when several blocking checks each have a remedy, the first is returned.
   * Two simultaneous remedies have never occurred, and guessing their order of operations would be
   * exactly the invention this field refuses to make.
   */
  actionKey: TKey | null;
}

/**
 * Check code → the step that clears it.
 *
 * Only the two `allocation_vs_balance_*` codes qualify today, because the product already
 * settled it: `amount_allocated` is frozen at creation, no screen can edit an allocation, and the
 * server refuses the request at approval AND at execution — so cancelling and re-opening is not
 * advice, it is the only route the state machine leaves open (checks.ts:169-180).
 *
 * The other `critical` codes (`duplicate_number`, `already_paid`, `invoice_visibility`,
 * `invoice_paid_*`, `invoice_unapproved`, `similar_pr`) are deliberately absent. Each has a
 * plausible-sounding remedy and not one of them has a decided one — approving past a duplicate
 * suspicion is a judgement call, and "ask someone who can see the invoice" is a sentence nobody
 * signed off on. They block, they say why, and they leave the next move to a person.
 */
const REQUIRED_ACTION_KEY: Readonly<Partial<Record<CheckCode, TKey>>> = {
  allocation_vs_balance_one: 'checks.actionAllocationVsBalance',
  allocation_vs_balance_many: 'checks.actionAllocationVsBalance',
  // `allocation_over_open_balance_*` is deliberately NOT here, and not because it has no remedy —
  // it has the clearest one in the file. It carries that remedy inside its own message instead,
  // the way the two codes above once did, because the only screen that produces it renders
  // `CheckList` and not this summary. An entry here would be a line of configuration that cannot
  // fire, which is worse than no entry: it reads as covered.
};

/** Partition a check run by severity and resolve the one action, if any, that clears the block. */
export function summarizeChecks(checks: readonly CheckResult[]): ChecksSummary {
  const blocking = checks.filter((check) => check.severity === 'critical');
  return {
    blocking,
    warnings: checks.filter((check) => check.severity === 'warning'),
    info: checks.filter((check) => check.severity === 'info'),
    actionKey: blocking.map((check) => REQUIRED_ACTION_KEY[check.code]).find((key) => key != null) ?? null,
  };
}
