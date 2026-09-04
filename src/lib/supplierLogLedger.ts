/**
 * The attribution half of יומן עדכון ספקים (`src/pages/SupplierLog.tsx`).
 *
 * ── The defect this exists to answer ──────────────────────────────────────────────────────────
 *
 * `audit_logs` records ONE price write twice. The reasoned command that owns the write inserts a
 * row of its own with the operator's `reason` — `set_supplier_product_price` (`0023:2246`) and
 * `import_supplier_prices` (`0032:375`) — and the row-level `audit_row_change` trigger
 * (`0001:421-438`) inserts a second row for the same write, with the full before/after image and
 * `reason` NULL, because the trigger has no idea a reason exists.
 *
 * The ledger screen showed both. So the screen printed «לא נרשמה סיבה» beside a price change that
 * an operator HAD given a reason for — measured by the sweep as ~85% of the ledger — and it printed
 * two rows for one write. `OWN-05` is the duplication; `PERM-06` is the false «no reason recorded».
 *
 * ── The link is already in the data, and it is not a guess ────────────────────────────────────
 *
 * Migration `0062` put `correlation_id` on `audit_logs` as a column DEFAULT rather than as an
 * argument, precisely so that it covers every write path without editing any function — and its own
 * comment names `audit_row_change` among them. `src/lib/supabase.ts:41` sends one
 * `x-correlation-id` per `/rest/v1` request, so the command row and every trigger row of the same
 * request carry the SAME id, written by the server. Grouping on it is reading a recorded fact.
 *
 * Two things this deliberately does not do:
 *   - It never infers a link from a shared timestamp or a shared actor. A row whose
 *     `correlation_id` is NULL — written before `0062`, or without the header — is passed through
 *     untouched and still reads «לא נרשמה סיבה», which is then true.
 *   - It never invents a reason where the group disagrees. If one request produced two commands
 *     with two different reasons, no reason-less row in it inherits either.
 *
 * And it changes NOTHING in the ledger. The rows in `audit_logs` are what they were; this is a
 * reader deciding which of the two rows it already holds is worth showing, and which recorded
 * reason belongs to it.
 */

/** The generic verbs the row-level trigger writes (`0001:421-438`); a command never uses them. */
const TRIGGER_ACTIONS = new Set(['insert', 'update', 'delete']);

/** The columns the fold needs. Everything else on the row is carried through untouched. */
interface LedgerRow {
  id: string;
  action: string;
  reason: string | null;
  entity_type: string;
  entity_id: string | null;
  correlation_id: string | null;
}

export interface LedgerEntry<T extends LedgerRow> {
  /** The row that carries the values — the trigger row, wherever one was folded in. */
  row: T;
  /** What to call this entry: the command's action when one owns the write. */
  action: string;
  /** The reason as recorded for this write, on this row or on the command that caused it. */
  reason: string | null;
  /**
   * True when `reason` was recorded on a sibling row of the same request rather than on this row.
   * The screen says so out loud — an inherited reason is a different claim from a recorded one.
   */
  reasonFromCommand: boolean;
}

/**
 * One entry per write.
 *
 * A reasoned command and the single trigger row for the SAME entity in the SAME request are the
 * same write, so they become one entry: the trigger row's values under the command's name and
 * reason. The command row is dropped, not the trigger row — the trigger row is the one that holds
 * `current_price`, and the command's `new_values` uses different key names that the field
 * catalogue does not track (`price`, not `current_price`), so keeping the command instead would
 * have thrown away the diff the reader came for.
 *
 * Trigger rows a command did not merge with — the N price lines one import touched — keep their
 * own before/after and inherit the request's reason, marked as inherited.
 *
 * Input order is preserved, and a merged entry sits where its trigger row sat.
 */
export function foldLedger<T extends LedgerRow>(rows: readonly T[]): LedgerEntry<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.correlation_id) continue;
    const group = groups.get(row.correlation_id);
    if (group) group.push(row); else groups.set(row.correlation_id, [row]);
  }

  /** trigger row id -> the command whose name and reason it should wear. */
  const folded = new Map<string, { action: string; reason: string }>();
  /** command row ids that a trigger row now speaks for. */
  const spokenFor = new Set<string>();
  /** reason-less row id -> the reason recorded elsewhere in the same request. */
  const inherited = new Map<string, string>();

  for (const group of groups.values()) {
    const commands = group.filter((row) => row.reason !== null);
    if (!commands.length) continue;

    for (const command of commands) {
      if (!command.entity_id) continue;
      const twins = group.filter((row) => row.reason === null
        && row.entity_id === command.entity_id
        && row.entity_type === command.entity_type
        && TRIGGER_ACTIONS.has(row.action)
        && !folded.has(row.id));
      // Exactly one, or the pairing is a guess: two trigger rows for one entity in one request
      // mean two writes, and the command names only one of them.
      if (twins.length !== 1) continue;
      folded.set(twins[0].id, { action: command.action, reason: command.reason as string });
      spokenFor.add(command.id);
    }

    const reasons = new Set(commands.map((command) => command.reason as string));
    if (reasons.size !== 1) continue;
    const [only] = [...reasons];
    for (const row of group) {
      if (row.reason !== null || folded.has(row.id)) continue;
      inherited.set(row.id, only);
    }
  }

  return rows
    .filter((row) => !spokenFor.has(row.id))
    .map((row) => {
      const fold = folded.get(row.id);
      if (fold) return { row, action: fold.action, reason: fold.reason, reasonFromCommand: false };
      const reason = inherited.get(row.id);
      if (reason !== undefined) return { row, action: row.action, reason, reasonFromCommand: true };
      return { row, action: row.action, reason: row.reason, reasonFromCommand: false };
    });
}
