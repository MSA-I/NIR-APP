/**
 * QuickCreateProduct — put a product the catalogue never heard of into the order you are writing.
 *
 * The dead end this removes (owner report, 19.08.2026): `/orders/new` filters a catalogue loaded
 * up front, and when nothing matches it says `לא נמצאו מוצרים` and offers nothing. The buyer's
 * only route was to leave the wizard, create the product in `/products`, upload or edit a price
 * list so the product has an offer, and start the order again — for every item the system had not
 * yet been taught. So the same items got re-typed order after order.
 *
 * ── Why a product alone is not enough ─────────────────────────────────────────────────────────
 *
 * A free-text order line does not exist in this schema and cannot be made to exist:
 * `purchase_order_items.product_id` is NOT NULL with a composite tenant FK (`0001_init.sql:166`,
 * `0021:210`), and `p0_set_purchase_order_item_unit_snapshot` (`0099:15-37`) raises
 * `purchase_order_item_unit_snapshot_required` for a line whose product cannot be read — a line
 * without a product is refused even to service_role. The draft is fenced the same way
 * (`0043:80-108`).
 *
 * And "which supplier does this product belong to" has exactly one representation: a
 * `supplier_products` row. There is no `products.supplier_id`. So the answer to the owner's ask —
 * pick the supplier, use it now, keep it for next time — is two writes, in this order:
 *
 *   1. `products` INSERT from the browser. Deliberately allowed: `0036:74-75` re-granted a narrow
 *      column list to `authenticated` after revoking the rest, and RLS limits it to owner/office
 *      (`0022:131-132`). Three screens already do exactly this insert.
 *   2. `import_supplier_prices`, the SECURITY DEFINER command that owns every `supplier_products`
 *      write (`0023:176` revoked direct DML). Given a pair it has never seen it creates the price
 *      row (`0023:2405-2419`) and writes `price_history` plus a reasoned `audit_logs` row.
 *
 * That is the same two-step `PriceListUpload.tsx:319-341` and `PriceListReviewConfirmation.tsx`
 * already perform; this is that pair behind one dialog instead of a spreadsheet.
 *
 * ── The honest limit ──────────────────────────────────────────────────────────────────────────
 *
 * The two writes are not one transaction, and no RPC exists that would make them one. If the price
 * command fails after the product row lands, the product exists in the catalogue with no offer.
 * That is stated to the user with the next step (`/prices`), and the created row is remembered so a
 * second press prices the SAME product instead of minting a duplicate — it is not silently rolled
 * back, because a browser cannot roll back a committed insert and pretending otherwise would be
 * the more dangerous lie.
 */

import { useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { ok, toHebrewError } from '../lib/errors';
import { unwrap } from '../lib/useQuery';
import { fetchAll } from '../lib/supabasePaging';
import { nameKey } from '../lib/nameKey';
import { normalizeUnitInput, todayISO } from '../lib/format';
import { reasonOr } from '../lib/reason';
import { ErrorNote, Modal, Note, useToast } from './ui';
import { SupplierSelectField, useQuickSupplier, type SupplierOption } from './QuickSupplierPicker';
import type { Product } from '../lib/types';

/** The columns this surface writes. Closed on purpose — see `quickSupplierRow`'s reasoning. */
export interface QuickProductColumns {
  org_id: string;
  name: string;
  unit: string;
  active: true;
}

/**
 * The only product row this component may insert, as a pure function so a spec can drive it
 * directly instead of inferring the payload from whichever scenario a UI test happens to run.
 *
 * `active: true` is literal, not a parameter: a product created to be ordered in the next click is
 * active by definition, and `active` is insertable but NOT updatable from the browser
 * (`0036:76-77` + the `p0_product_active_guard` trigger), so getting it wrong here would need
 * `set_product_active` to undo.
 */
export function quickProductRow(orgId: string, name: string, unit: string): QuickProductColumns {
  return { org_id: orgId, name: name.trim(), unit: normalizeUnitInput(unit), active: true };
}

const NAME_REQUIRED = 'שם מוצר הוא שדה חובה';
const SUPPLIER_REQUIRED = 'יש לבחור ספק — בלי מחירון לספק לא ניתן להזמין את המוצר';
/** `import_supplier_prices` refuses above 1,000,000 (`0023`); say the limit before the round trip. */
const PRICE_REQUIRED = 'יש להזין מחיר גדול מאפס ולא גבוה ממיליון';

type ExistingProduct = Pick<Product, 'id' | 'name' | 'unit' | 'active'>;

/** What the duplicate IS, not merely that one exists — the name is the thing that collided. */
function describeExisting(row: ExistingProduct) {
  return [row.name, row.unit, row.active ? 'פעיל' : 'לא פעיל'].join(' · ');
}

export function QuickCreateProduct({ suppliers, initialName, onClose, onCreated }: {
  /** The order screen's already-loaded supplier rows; any superset of `{ id, name }`. */
  suppliers: readonly SupplierOption[];
  /** Whatever the user had typed in the product search, so the dialog opens half-filled. */
  initialName?: string;
  onClose: () => void;
  /** Fires after BOTH writes succeed. The product is real and it has a price for `supplierId`. */
  onCreated: (product: Product) => void | Promise<void>;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(initialName ?? '');
  const [unit, setUnit] = useState('יח׳');
  const [supplierId, setSupplierId] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const [duplicate, setDuplicate] = useState<ExistingProduct | null>(null);
  /**
   * The product row from a previous press whose price command failed. Retrying must price THAT
   * product, not insert a second one under the same name — `products` has no unique constraint on
   * name (`0001_init.sql:87-100`), so a retry would otherwise quietly fork the catalogue.
   */
  const pendingProduct = useRef<Product | null>(null);
  const picker = useQuickSupplier(suppliers, setSupplierId);
  const spent = busy || created;

  async function save() {
    if (!name.trim()) { setError(NAME_REQUIRED); return; }
    if (!supplierId) { setError(SUPPLIER_REQUIRED); return; }
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice > 1_000_000) {
      setError(PRICE_REQUIRED); return;
    }
    if (!profile?.org_id) { setError(toHebrewError(new Error('not_authorized'))); return; }

    setBusy(true);
    setError(null);
    try {
      // Warns, never blocks — same rule as the supplier door. Two genuinely similar product names
      // do occur, and refusing would rebuild the dead end this dialog exists to remove. Skipped
      // once the warning is on screen (the next press is the deliberate one) and once a product
      // row already exists from a half-failed attempt.
      if (!duplicate && !pendingProduct.current) {
        const existing = await fetchAll<ExistingProduct>((from, to) => supabase.from('products')
          .select('id, name, unit, active').order('id').range(from, to));
        const key = nameKey(name);
        const match = existing.find((row) => nameKey(row.name) === key);
        if (match) { setDuplicate(match); return; }
      }

      let product = pendingProduct.current;
      if (!product) {
        const inserted = ok(await supabase.from('products')
          .insert(quickProductRow(profile.org_id, name, unit))
          .select('*')
          .single());
        product = inserted.data as Product | null;
        // An insert that answers with no row is a failure, not a success.
        if (!product?.id) throw new Error('product_insert_no_row');
        pendingProduct.current = product;
      }

      unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: [{
          supplier_id: supplierId,
          product_id: product.id,
          price: parsedPrice,
          available: true,
        }],
        p_effective_date: todayISO(),
        p_reason: reasonOr(reason, 'הוספת מוצר ומחיר מתוך הזמנה חדשה'),
      }));

      pendingProduct.current = null;
      setCreated(true);
      toast('המוצר נוצר ושויך לספק');
      await onCreated(product);
    } catch (failure) {
      setError(pendingProduct.current
        ? `${toHebrewError(failure)} — המוצר נוצר בקטלוג אך עדיין ללא מחיר לספק. אפשר לנסות שוב, או להשלים את המחיר במסך המחירונים.`
        : toHebrewError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="מוצר חדש" busy={busy}
      description="המוצר ייווצר בקטלוג, יקבל מחיר אצל הספק שנבחר, ויתווסף להזמנה הזו — ויופיע גם בהזמנות הבאות."
      statusMessage={busy ? 'יוצר את המוצר' : undefined}>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}
        {duplicate && (
          <Note tone="await" role="alert">
            <div className="font-medium">מוצר בשם זה כבר קיים בקטלוג</div>
            <div className="mt-1 text-sm">{describeExisting(duplicate)}</div>
          </Note>
        )}
        <div>
          <label className="label" htmlFor="quick-product-name">שם המוצר *</label>
          <input id="quick-product-name" className="input" value={name} disabled={spent}
            aria-invalid={error === NAME_REQUIRED || undefined}
            onChange={(event) => { setName(event.target.value); setDuplicate(null); }} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="quick-product-unit">יחידת מידה</label>
            <input id="quick-product-unit" className="input" value={unit} disabled={spent}
              onChange={(event) => setUnit(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="quick-product-price">מחיר ליחידה *</label>
            <input id="quick-product-price" className="input num" type="number" min="0" step="0.01"
              dir="ltr" value={price} disabled={spent}
              aria-invalid={error === PRICE_REQUIRED || undefined}
              onChange={(event) => setPrice(event.target.value)} />
          </div>
        </div>
        <SupplierSelectField picker={picker} id="quick-product-supplier" label="ספק *"
          value={supplierId} placeholder="בחר ספק" disabled={spent} />
        <div>
          <label className="label" htmlFor="quick-product-reason">סיבה (רשות)</label>
          <input id="quick-product-reason" className="input" value={reason} disabled={spent}
            onChange={(event) => setReason(event.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button type="button" className="btn-primary" disabled={spent} onClick={() => void save()}>
          {created ? 'נוצר' : busy ? 'שומר…' : duplicate ? 'צור בכל זאת' : 'הוספה להזמנה'}
        </button>
      </div>
    </Modal>
  );
}
