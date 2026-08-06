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
 *   4. **Gate it where the suppliers screen gates it.** `Suppliers.tsx:87,152` shows its own
 *      "ספק חדש" button to `owner`/`office` only. A shortcut to that screen's action must not be a
 *      way around that screen's rule — `kitchen` reaches /invoices/new and /products, and must see
 *      the select without the button.
 *
 * Written once rather than three times because it is the same four points three times, and because
 * a fourth screen (E3's audit) is expected to want it. What is *not* here is the per-screen shape:
 * the wrapper class, the disabled condition, the placeholder sentence and the field id all stay at
 * the call site, where they differ, and where the browser scenarios' `#invoice-new-supplier` and
 * `#payment-request-supplier` selectors already point.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { QuickCreateSupplier, type QuickCreatedSupplier } from './QuickCreateSupplier';

/** All any supplier `<option>` needs. Every caller's row type is a superset of it. */
export type SupplierOption = { id: string; name: string };

/**
 * The two sentences a screen-reader user hears, exported so the spec asserts what is said and not
 * merely that something is.
 *
 * The field's own hint is the one that matters: the user who is stuck is the one sitting on the
 * select, and "the button is right there" is a claim only a sighted user can verify. The button's
 * hint then answers the other half — pressing it does not navigate away, it fills this field.
 */
export const SUPPLIER_FIELD_QUICK_CREATE_HINT = 'אין ספק מתאים ברשימה? הכפתור ״ספק חדש״ שליד יוצר ספק ובוחר אותו כאן.';
export const QUICK_CREATE_SUPPLIER_HINT = 'הספק החדש ייווצר וייבחר מיד בשדה זה';

/**
 * The fetched list, plus anything created here that the fetch has not caught up with yet.
 *
 * Matched on `id`: once the refetch carries the row, the server's copy wins and the local one
 * disappears without a second option and without the selection moving. Sorting only happens when
 * something was actually added, so a list already ordered by the server is returned untouched.
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
  const { profile } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<QuickCreatedSupplier[]>([]);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

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
 * Select and button live in one `role="group"`, so the button is announced as part of the field
 * rather than as a loose control that happens to follow one. The group is named *around* the
 * field's label instead of repeating it: `qa/deterministic/invoice-linked-context.spec.ts` locates
 * this select with Playwright's `getByLabel('ספק *', { exact: true })`, which also matches
 * `aria-labelledby`, so a group carrying the identical name would resolve to two elements and put
 * that suite into a strict-mode violation.
 *
 * `disabled` covers both controls on purpose: a supplier field the user may not change is not a
 * field they may add to (the linked-invoice case on /invoices/new). The button stays visible while
 * disabled — a greyed control explains the state; a vanished one reads as the old dead end.
 */
export function SupplierSelectField({
  picker, id, label, value, placeholder, disabled, describedBy, className,
}: {
  picker: QuickSupplierPicker;
  id: string;
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const fieldHintId = `${id}-quick-create-field-hint`;
  const buttonHintId = `${id}-quick-create-hint`;
  // Pointing the select at the hint while the field is locked would advertise a button that
  // cannot be pressed, so the hint follows the affordance rather than the permission.
  const offered = picker.canCreate && !disabled;
  const selectDescribedBy = [describedBy, offered ? fieldHintId : null].filter(Boolean).join(' ');
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2" role="group"
        aria-label={`${label.replace(/\s*\*\s*$/, '')} — בחירה או יצירה`}>
        <select id={id} className="input min-w-0" value={value} disabled={disabled}
          aria-describedby={selectDescribedBy || undefined}
          onChange={(event) => picker.select(event.target.value)}>
          <option value="">{placeholder}</option>
          {picker.suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        {picker.canCreate && (
          <button type="button" className="btn-secondary shrink-0" disabled={disabled}
            aria-describedby={buttonHintId} onClick={picker.openDialog}>
            <Plus size={16} aria-hidden="true" /> ספק חדש
          </button>
        )}
      </div>
      {picker.canCreate && (
        <>
          {offered && <span id={fieldHintId} className="sr-only">{SUPPLIER_FIELD_QUICK_CREATE_HINT}</span>}
          <span id={buttonHintId} className="sr-only">{QUICK_CREATE_SUPPLIER_HINT}</span>
        </>
      )}
      {picker.dialogOpen && (
        <QuickCreateSupplier onClose={picker.closeDialog} onCreated={picker.acceptCreated} />
      )}
    </div>
  );
}
