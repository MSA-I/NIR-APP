import type { TKey } from './i18n/t.ts';

/**
 * The reason an audited action carries, when nobody typed one.
 *
 * The owner's ruling on 11.08.2026: "if there are places asking for a reason for the action — it is
 * simply not relevant, nobody reads or will read these notes." That is a statement about the
 * TYPING, and it is a fair one: a required box that a person must fill before a legitimate action
 * proceeds does not produce reasons, it produces "asdf" — and a ledger of "asdf" is worse than one
 * that honestly says nothing was written.
 *
 * It is not a statement about the ledger. `audit_logs` with a reason is one of this project's iron
 * rules, roughly fifty server commands raise `reason_required` on their own, and the reason column
 * is what makes a soft-deleted invoice explicable a year later. Removing it would be a different
 * and much larger decision than the one that was made.
 *
 * So the box becomes optional and the ledger keeps a sentence. What goes in when the box is empty
 * is deliberately not "—" or "לא צוינה סיבה": it names the action and says plainly that nobody
 * added a note, which is a true and useful audit line. An auditor reading it learns exactly as much
 * as they should — what happened, and that no one explained it.
 */
export function reasonOr(typed: string | null | undefined, action: string): string {
  const trimmed = (typed ?? '').trim();
  if (trimmed) return trimmed;
  return `${action} — ללא הערה מהמשתמש`;
}

/**
 * The label for a reason box that no longer blocks the button.
 *
 * A key, unlike the clause above it: this one is read on a screen, while the clause is written
 * into `p_reason` and lands in `audit_logs`, where a wording that followed the reader would make
 * the ledger unsearchable.
 */
export const OPTIONAL_REASON_LABEL_KEY: TKey = 'reason.optionalLabel';
