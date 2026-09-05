/**
 * The supplier picker that is not a dead end.
 *
 * `QuickCreateSupplier` (E1) is the door; this is the doorframe every screen with a supplier
 * `<select>` mounts it in. Three screens needed it — the price-list upload dialog the owner
 * complained about, the new-invoice form and the new-payment-request dialog — and the wiring is
 * not "render a button": it is the same four-part contract in each of them.
 *
 *   1. **Select the new row immediately.** `onCreated` hands back `{ id, name }` precisely because
 *      a refetch may not have landed; the caller must add the row to the list it is *rendering*
 *      and set the id, or the `<select>` holds a value it cannot show.
 *   2. **Do not fight the refetch.** Each screen has its own `suppliers` query. The locally created
 *      row is kept apart from the fetched list and merged at render time, matched on `id`, so when
 *      the fetch finally carries the row there is one option and not two, and nothing flickers.
 *   3. **Say it, do not merely place it.** The button sits next to a labelled select. Adjacency is
 *      a visual fact; the `role="group"` carrying the field's own label plus the description below
 *      are what make it a fact for someone reading with a screen reader.
 *   4. **Gate it where the suppliers screen gates it.** `Suppliers.tsx` shows its own
 *      "ספק חדש" button to `owner`/`office` only. The accountant can use supplier context in the
 *      bank workflow, but cannot create a supplier from there.
 *
 * Written once rather than three times because it is the same four points three times, and because
 * a fourth screen (E3's audit) is expected to want it. What is *not* here is the per-screen shape:
 * the wrapper class, the disabled condition, the placeholder sentence and the field id all stay at
 * the call site, where they differ, and where the browser scenarios' `#invoice-new-supplier` and
 * `#payment-request-supplier` selectors already point.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  QuickCreateSupplier,
  type QuickCreatedSupplier,
  type QuickSupplierCreationContext,
} from './QuickCreateSupplier';
import { ICON } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';

/** All any supplier `<option>` needs. Every caller's row type is a superset of it. */
/**
 * `default_currency` is optional because most callers pick a supplier to NAME them and never
 * show money; the ones that preview a supplier's own prices — the price-list upload — need to
 * know which currency those prices are quoted in (0217), and read it from here.
 */
export type SupplierOption = { id: string; name: string; default_currency?: string };

/**
 * The two sentences a screen-reader user hears, exported so the spec asserts what is said and not
 * merely that something is.
 *
 * The field's own hint is the one that matters: the user who is stuck is the one sitting on the
 * select, and "the button is right there" is a claim only a sighted user can verify. The button's
 * hint then answers the other half — pressing it does not navigate away, it fills this field.
 */
export const SUPPLIER_FIELD_QUICK_CREATE_HINT_KEY: TKey = 'quickSupplierPicker.fieldHint';
export const QUICK_CREATE_SUPPLIER_HINT_KEY: TKey = 'quickSupplierPicker.buttonHint';

/**
 * What an accountant sees when a financial workflow needs supplier context but supplier creation
 * remains an owner/office operation. The hint names the next action instead of presenting a silent
 * missing control.
 */
export const SUPPLIER_FIELD_NO_CREATE_HINT_KEY: TKey = 'quickSupplierPicker.noCreateHint';

/**
 * The fetched list, plus anything created here that the fetch has not caught up with yet.
 *
 * Matched on `id`: once a later fetch carries the row, the server's copy wins and the local one
 * disappears without a second option and without the selection moving. Sorting only happens when
 * something was actually added, so a list already ordered by the server is returned untouched —
 * an open `<select>` does not reorder under the user's cursor.
 *
 * **Two honest limits, since a reader could infer more than this does:**
 *
 * 1. `known.has(id)` cannot tell "the fetch has not run yet" from "the row was deleted since". A
 *    supplier soft-deleted between the create and the next fetch would be kept as an option rather
 *    than dropped. Nothing prevents that here; it is unreachable today only because no such fetch
 *    happens (below), and because deleting a supplier one just created is not a real sequence.
 * 2. There is no refetch to collide with yet. All three callers hold key-less `useQuery` with empty
 *    deps, which routes to the legacy per-instance mode: no shared cache, no refetch on focus, and
 *    nothing calls `refetch()` for suppliers on any of the three screens. The collision handling is
 *    for when one of them is converted to a cached key — correct to have, not currently exercised
 *    by production.
 */
export function mergeCreatedSuppliers<T extends SupplierOption>(
  fetched: readonly T[] | null | undefined,
  created: readonly QuickCreatedSupplier[],
): (T | QuickCreatedSupplier)[] {
  const rows: (T | QuickCreatedSupplier)[] = fetched ? [...fetched] : [];
  if (!created.length) return rows;
  const known = new Set(rows.map((row) => row.id));
  const missing = created.filter((row) => !known.has(row.id));
  if (!missing.length) return rows;
  return [...rows, ...missing].sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

/** The state `SupplierSelectField` renders. The hook below is the only thing that builds one. */
export interface QuickSupplierPicker {
  /** The fetched rows merged with anything created in this session. */
  suppliers: readonly SupplierOption[];
  /** Whether this user may create a supplier at all — the suppliers screen's own rule. */
  canCreate: boolean;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** Selection, owned by the caller. The field routes both a manual pick and a create through it. */
  select: (supplierId: string) => void;
  acceptCreated: (supplier: QuickCreatedSupplier) => void;
}

/**
 * Owns the create dialog and the locally created rows; the *value* stays with the caller.
 *
 * `onSelect` is read through a ref so a call site can pass an inline arrow — the callbacks handed
 * back stay stable, and a screen that also has to clear dependent state on a supplier change
 * (`PaymentRequests` drops the chosen invoices) writes that in exactly one place.
 */
export function useQuickSupplier<T extends SupplierOption>(
  fetched: readonly T[] | null | undefined,
  onSelect: (supplierId: string) => void,
): QuickSupplierPicker & { suppliers: (T | QuickCreatedSupplier)[] } {
  const profile = useAuth()?.profile;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<QuickCreatedSupplier[]>([]);
  // Synced in an effect, not during render. A render-phase ref write is harmless while every
  // caller passes a closure over state setters, but it is the shape that fails silently when React
  // discards a concurrent render — the stale callback survives in the ref. One line to not rely on
  // that staying true.
  const selectRef = useRef(onSelect);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);

  const suppliers = useMemo(() => mergeCreatedSuppliers(fetched, created), [fetched, created]);
  const select = useCallback((supplierId: string) => selectRef.current(supplierId), []);
  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const acceptCreated = useCallback((supplier: QuickCreatedSupplier) => {
    // Guarded against a repeat id rather than trusting the dialog's own single-write lock: two
    // options with the same value is a `<select>` that cannot be read, and the guard is one line.
    setCreated((rows) => (rows.some((row) => row.id === supplier.id) ? rows : [...rows, supplier]));
    selectRef.current(supplier.id);
    // Closing is the caller's responsibility (QuickCreateSupplier's contract) — this is the caller.
    setDialogOpen(false);
  }, []);

  // Mirrors Suppliers.tsx:87 verbatim rather than inventing a rule for the shortcut.
  const canCreate = profile?.role === 'owner' || profile?.role === 'office';

  return { suppliers, canCreate, dialogOpen, openDialog, closeDialog, select, acceptCreated };
}

/**
 * Label, select, create button and the dialog it opens — one markup for all three screens.
 *
 * When creation is on offer, select and button live in one `role="group"`, so the button is
 * announced as part of the field rather than as a loose control that happens to follow one. The
 * group is named *around* the field's label instead of repeating it:
 * The invoice-linked browser gate locates this select with Playwright's
 * `getByLabel('ספק *', { exact: true })`, and `getElementLabels` resolves `aria-labelledby` for any
 * element, not only labellable ones — a group carrying the identical name would resolve to two
 * elements and put all four of that suite's page-scoped calls into a strict-mode violation.
 *
 * `disabled` covers both controls on purpose: a supplier field the user may not change is not a
 * field they may add to (the linked-invoice case on /invoices/new). The button stays visible while
 * disabled — a greyed control explains the state; a vanished one reads as the old dead end.
 */
export function SupplierSelectField({
  picker, id, label, value, placeholder, disabled, describedBy, className, createContext,
}: {
  picker: QuickSupplierPicker;
  id: string;
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
  createContext?: QuickSupplierCreationContext;
}) {
  const { t } = useT();
  const fieldHintId = `${id}-quick-create-field-hint`;
  const buttonHintId = `${id}-quick-create-hint`;
  const noCreateHintId = `${id}-no-create-hint`;
  /**
   * Whether creation is actually on offer here and now — not merely permitted.
   *
   * Every announcement below hangs off this one flag, and it has to, because the two ways of
   * getting it wrong are the same mistake pointed at different users:
   *
   *   - `picker.canCreate` alone names the group "בחירה או **יצירה**" for an accountant whose
   *     button is not rendered. A sighted user sees one control and infers correctly; a screen
   *     reader user is told an affordance exists, hunts for it, and finds nothing — a dead end
   *     manufactured by the accessibility layer, in the change whose purpose is removing them.
   *     (It is also a one-control group, which the role does not mean.)
   *   - `!disabled` alone leaves the *button's* own hint promising "ייווצר וייבחר מיד בשדה זה"
   *     on a button that cannot be pressed, on /invoices/new with a linked order.
   *
   * So: no button on offer, no group and no hints. Nothing here says a door exists unless one does.
   */
  const offered = picker.canCreate && !disabled;
  /**
   * The other branch, and it is deliberately NOT `!offered`.
   *
   * `disabled` with `canCreate` (a linked order on /invoices/new) already explains itself: the
   * button is on screen and greyed, and telling that user to "ask the office" would be wrong —
   * they may create suppliers, just not here and now. The sentence belongs only where the door is
   * missing rather than shut, which is exactly `canCreate === false`.
   */
  const noCreate = !picker.canCreate;
  const selectDescribedBy = [describedBy, offered ? fieldHintId : null, noCreate ? noCreateHintId : null]
    .filter(Boolean).join(' ');
  const grouping = offered
    ? { role: 'group', 'aria-label': t('quickSupplierPicker.groupLabel', { label: label.replace(/\s*\*\s*$/, '') }) }
    : {};
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2" {...grouping}>
        <select id={id} className="input min-w-0" value={value} disabled={disabled}
          aria-describedby={selectDescribedBy || undefined}
          onChange={(event) => picker.select(event.target.value)}>
          <option value="">{placeholder}</option>
          {picker.suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        {picker.canCreate && (
          <button type="button" className="btn-secondary shrink-0" disabled={disabled}
            aria-describedby={offered ? buttonHintId : undefined} onClick={picker.openDialog}>
            <Plus size={ICON.sm} aria-hidden="true" /> {t('quickSupplierPicker.newSupplier')}
          </button>
        )}
      </div>
      {offered && (
        <>
          <span id={fieldHintId} className="sr-only">{t(SUPPLIER_FIELD_QUICK_CREATE_HINT_KEY)}</span>
          <span id={buttonHintId} className="sr-only">{t(QUICK_CREATE_SUPPLIER_HINT_KEY)}</span>
        </>
      )}
      {/* Visible and also connected to the select so the same next step reaches screen readers. */}
      {noCreate && (
        <p id={noCreateHintId} className="mt-1 text-xs text-ink-muted">
          {t(SUPPLIER_FIELD_NO_CREATE_HINT_KEY)}
        </p>
      )}
      {picker.dialogOpen && (
        <QuickCreateSupplier onClose={picker.closeDialog} onCreated={picker.acceptCreated}
          context={createContext} />
      )}
    </div>
  );
}
