/**
 * QuickCreateSupplier — create a supplier without leaving the form that needs one.
 *
 * Every screen that asks "which supplier?" offers a `<select>` fed from the existing rows, so a
 * user whose supplier is not in that list has to abandon the task, go to /suppliers, create the
 * row, come back and start over. The same price-list dialog that forces this detour will happily
 * create new *products* on the fly. There is no product/supplier distinction behind that — it is
 * simply what got built. This component is the missing door: name, ח.פ, done, and the caller gets
 * the new row back so it can select it on the spot.
 *
 * ── The one field that is deliberately absent ──────────────────────────────────────────────────
 *
 * `bank_details` is NOT here, and must never be added.
 *
 * `docs/DEBT-REGISTER.md` §11 and OPEN-DECISIONS #106: migration `0061:469` revoked the UPDATE
 * grant on `suppliers.bank_details` and routed changes through `update_supplier_bank_details`
 * (step-up + mandatory reason + audit) — but the INSERT grant survived deliberately
 * (`0061:463-468`, "entering details while *creating* a supplier is onboarding, and a new row
 * diverts nothing"), and the client uses it (`src/pages/Suppliers.tsx:244`). So an owner or office
 * user can today create a *new* supplier row — `ACME בע״מ (2)` — carrying an attacker's bank
 * details, with no step-up, no operator reason and no `security_event`. That is the canonical
 * invoice-fraud pattern, and it is a recorded, deliberately-unresolved decision.
 *
 * One screen with that hole is a known debt. Four screens with it is a spread. Until #106 is
 * decided, bank details are entered in exactly one place — the full supplier form — where at least
 * the decision is written down next to the code. Anyone "completing" this form will fail
 * `QuickCreateSupplier.spec.tsx`, which asserts the absence structurally rather than trusting
 * this comment to be read.
 *
 * The rest of the supplier record (contact, terms, delivery days, rating, notes) is absent for a
 * plainer reason: a quick create exists to unblock a task, and every extra field is a reason to
 * abandon it. They are all editable afterwards in the suppliers screen.
 */

import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { ok, toHebrewError } from '../lib/errors';
import { fetchAll } from '../lib/supabasePaging';
import { nameKey } from '../lib/nameKey';
import { SUPPLIER_STATUS } from '../lib/status';
import { ErrorNote, Modal, Note, useToast } from './ui';
import type { Supplier } from '../lib/types';

/**
 * What the caller gets back. `id` is what a `<select>` binds to; `name` is what it has to render
 * before any refetch lands, which is the whole point of not navigating away. Exactly the shape the
 * supplier pickers already hold (`supabase.from('suppliers').select('id, name')`).
 */
export type QuickCreatedSupplier = Pick<Supplier, 'id' | 'name'>;

/**
 * The complete set of columns this surface writes — closed on purpose. No index signature and no
 * optional members, so a caller-supplied `defaults`/`prefill` object cannot be widened into the
 * payload without editing this type and the call site below, which is what the spec watches.
 */
export interface QuickSupplierColumns {
  org_id: string;
  name: string;
  tax_id: string | null;
}

/**
 * The only row this component may insert, as a pure function so the spec can drive it with
 * arbitrary input instead of inferring the payload from whichever scenario a UI test happens to
 * exercise — the hole that let a `{...defaults}` spread pass four green assertions in review.
 */
export function quickSupplierRow(orgId: string, name: string, taxId: string): QuickSupplierColumns {
  return { org_id: orgId, name: name.trim(), tax_id: taxId.trim() || null };
}

/** The full supplier form's wording for the same mistake — not a second sentence for one meaning. */
const NAME_REQUIRED = 'שם ספק הוא שדה חובה';

/** Enough of the existing row to tell the user WHICH supplier it already has. */
type ExistingSupplier = Pick<Supplier, 'id' | 'name' | 'tax_id' | 'status'>;

/**
 * Says what the duplicate is, not merely that one exists — a bare name is weak evidence when the
 * name is the thing that collided. ח.פ is the identity claim; status is shown because it is a real
 * property of the row the user is about to duplicate. A missing ח.פ is stated rather than padded
 * over: "no tax id recorded" is itself information.
 *
 * **Corrected in G1 (finding 3).** This comment used to say an inactive supplier "is missing from
 * most pickers", offering that as the reason the user could not find it. The code says the
 * opposite: `/orders/new` is the ONLY picker that filters on `status` (NewOrder.tsx:206); the other
 * nine filter on `deleted_at` alone, so an inactive supplier is present in almost all of them. A
 * wrong comment on a shared component is worse than none — the next agent reads it as the contract.
 */
function describeExisting(row: ExistingSupplier) {
  return [
    row.name,
    row.tax_id ? `ח.פ ${row.tax_id}` : 'ללא ח.פ רשום',
    SUPPLIER_STATUS[row.status]?.label ?? row.status,
  ].join(' · ');
}

/**
 * Mounted conditionally by the caller, like `SupplierForm` and `PriceListUploadModal`: mounting is
 * what resets the fields. It nests safely inside another dialog — `useDialogLayer` keeps a stack,
 * so Escape and Tab belong to this layer until it closes.
 */
export function QuickCreateSupplier({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (supplier: QuickCreatedSupplier) => void;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The row exists; this form is spent. `suppliers` has NO unique constraint on `name`
   * (`0001_init.sql:59-79`; the only unique is `(org_id, id)` in `0021:180`), so a second click
   * before the caller closes would silently create the duplicate half of the #106 fraud pattern
   * under a "הספק נוצר" toast. Disabling the controls is what prevents it.
   *
   * Deliberately not "leave `busy` true": `Modal` refuses to close while busy, which would trap a
   * user in an uncloseable dialog if a caller ever forgot to unmount on `onCreated`. This blocks
   * the second write without taking the exit away.
   */
  const [created, setCreated] = useState(false);
  /**
   * The existing supplier whose name matches, once found. Owner decision: a name collision
   * **warns, it does not block** — a real business does sometimes have two genuinely similar
   * supplier names, and refusing would create a new dead end, which is the thing this component
   * exists to remove. Set = the warning is on screen and the next press is the deliberate one.
   */
  const [duplicate, setDuplicate] = useState<ExistingSupplier | null>(null);
  const spent = busy || created;

  async function save() {
    // Validated here, before any request: a name of spaces is not the server's problem to explain,
    // and the sentence is the one the full supplier form already uses for the same mistake.
    if (!name.trim()) { setError(NAME_REQUIRED); return; }
    // No org means no tenant to write into. `not_authorized` is the honest existing mapping —
    // and it keeps a null profile from becoming an unhandled TypeError mid-save.
    if (!profile?.org_id) { setError(toHebrewError(new Error('not_authorized'))); return; }

    setBusy(true);
    setError(null);
    try {
      // The duplicate half of the #106 fraud pattern is a duplicate supplier row; this is the
      // cheap non-blocking guard on it, using the same `nameKey` and the same sentence as the
      // sibling bulk path (`Onboarding.tsx:759`) rather than minting a second dialect. Skipped on
      // the second press, which is the user proceeding deliberately. If the check itself fails we
      // cannot say the name is free, so it throws and nothing is inserted — the same call
      // `Suppliers.tsx:106` makes when its delete guard cannot prove what it needs.
      if (!duplicate) {
        const existing = await fetchAll<ExistingSupplier>((from, to) => supabase.from('suppliers')
          .select('id, name, tax_id, status').is('deleted_at', null).order('id').range(from, to));
        const key = nameKey(name);
        const match = existing.find((row) => nameKey(row.name) === key);
        if (match) { setDuplicate(match); return; }
      }
      const inserted = ok(await supabase.from('suppliers')
        .insert(quickSupplierRow(profile.org_id, name, taxId))
        .select('id, name')
        .single());
      const row = inserted.data as QuickCreatedSupplier | null;
      // The one place the "never tell the caller a supplier exists when it does not" promise was a
      // claim rather than a check: an insert that answers with no row is a failure, not a success.
      if (!row?.id) throw new Error('supplier_insert_no_row');
      setCreated(true);
      toast('הספק נוצר');
      onCreated(row);
    } catch (failure) {
      setError(toHebrewError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="ספק חדש" busy={busy}
      description="יצירה מהירה — שם וח.פ בלבד, כדי לא לעזוב את המסך. את שאר פרטי הספק משלימים במסך הספקים."
      statusMessage={busy ? 'יוצר את הספק' : undefined}>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}
        {duplicate && (
          <Note tone="await" role="alert">
            <div className="font-medium">ספק בשם זה כבר קיים במערכת</div>
            <div className="mt-1 text-sm">{describeExisting(duplicate)}</div>
          </Note>
        )}
        <div>
          <label className="label" htmlFor="quick-supplier-name">שם הספק *</label>
          {/* Only the field's own refusal marks the field invalid — a network or permission
              failure is not something wrong with what the user typed. */}
          <input id="quick-supplier-name" className="input" value={name} disabled={spent}
            aria-invalid={error === NAME_REQUIRED || undefined}
            /* Editing the name retires the warning, so the next press re-checks the new name
               instead of waving through a collision the user never saw. */
            onChange={(event) => { setName(event.target.value); setDuplicate(null); }} />
        </div>
        <div>
          <label className="label" htmlFor="quick-supplier-tax-id">ח.פ / עוסק</label>
          <input id="quick-supplier-tax-id" className="input" dir="ltr" value={taxId} disabled={spent}
            onChange={(event) => setTaxId(event.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        {/* Cancel stays live after a create: the exit is never taken away. */}
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button type="button" className="btn-primary" disabled={spent} onClick={() => void save()}>
          {created ? 'נוצר' : busy ? 'שומר…' : duplicate ? 'צור בכל זאת' : 'שמירה'}
        </button>
      </div>
    </Modal>
  );
}
