/**
 * The value-rendering half of יומן עדכון ספקים (`src/pages/SupplierLog.tsx`).
 *
 * It lives here and not in the page for one reason: the diff of an audit row is pure logic over two
 * plain objects, and a test for it should not have to stand up supabase and react-router inside
 * jsdom just to ask what `12.5 → 14` renders as. The page imports both exports back; this module is
 * not a second home for them.
 *
 * ── Why the empty value says a word ───────────────────────────────────────────────────────────
 *
 * `—` is still the app-wide "no data" glyph, everywhere else, and nobody should change that on the
 * strength of this file. Here, and only in the before/after diff of a supplier change, a dash was
 * doing work a dash cannot do: in `12.50 ← 14.00` the whole claim rested on an arrow, and in a
 * `—` cell the reader had to decide whether the field was cleared, never filled, or simply not
 * recorded. The screen now says it: `לא הוגדר`. Words carry meaning that a glyph only gestures at.
 */
import type { TKey } from './i18n/t';
import { fmtDate, fmtMoneyExact } from './format';

/** What a value looks like when there is nothing there. Scoped to this screen — see the note above. */
const NOT_SET: TKey = 'supplierLog.valueNotSet';

/**
 * The fields a person asks about, and how to say each one. Everything absent from this map is
 * absent from the screen — ids, org_id, timestamps and `*_by` columns are how the database keeps
 * its books, not what changed about a supplier or a price. `money` and `date` also decide the
 * formatting, so a price never renders as `420` and a date never as an ISO string.
 */
const FIELD_LABELS: Record<string, { labelKey: TKey; kind?: 'money' | 'date' | 'bool' }> = {
  // supplier_products
  current_price: { labelKey: 'supplierLog.fieldCurrentPrice', kind: 'money' },
  previous_price: { labelKey: 'supplierLog.fieldPreviousPrice', kind: 'money' },
  price_effective_date: { labelKey: 'supplierLog.fieldPriceEffectiveDate', kind: 'date' },
  available: { labelKey: 'supplierLog.fieldAvailable', kind: 'bool' },
  min_qty: { labelKey: 'supplierLog.fieldMinQty' },
  package_size: { labelKey: 'supplierLog.fieldPackageSize' },
  supplier_sku: { labelKey: 'supplierLog.fieldSupplierSku' },
  // products — the two fields `set_product_display_name` records (0149). The raw `name` shares its
  // label with the supplier one below and is unchanged by that command, so it never renders here;
  // it is in the record so the approved name can be read next to what it was approved instead of.
  display_name: { labelKey: 'supplierLog.fieldDisplayName' },
  // suppliers
  name: { labelKey: 'supplierLog.fieldName' },
  status: { labelKey: 'supplierLog.fieldStatus' },
  tax_id: { labelKey: 'supplierLog.fieldTaxId' },
  contact_name: { labelKey: 'supplierLog.fieldContactName' },
  phone: { labelKey: 'supplierLog.fieldPhone' },
  whatsapp: { labelKey: 'supplierLog.fieldWhatsApp' },
  email: { labelKey: 'supplierLog.fieldEmail' },
  address: { labelKey: 'supplierLog.fieldAddress' },
  payment_terms: { labelKey: 'supplierLog.fieldPaymentTerms' },
  delivery_days: { labelKey: 'supplierLog.fieldDeliveryDays' },
  cutoff_time: { labelKey: 'supplierLog.fieldCutoffTime' },
  min_order_amount: { labelKey: 'supplierLog.fieldMinOrderAmount', kind: 'money' },
  rating: { labelKey: 'supplierLog.fieldRating' },
  rating_note: { labelKey: 'supplierLog.fieldRatingNote' },
  notes: { labelKey: 'supplierLog.fieldNotes' },
  deleted_at: { labelKey: 'supplierLog.fieldDeletedAt', kind: 'date' },
};

export function renderValue(
  raw: unknown,
  t: (key: TKey) => string,
  kind?: 'money' | 'date' | 'bool',
  currency?: string | null,
): string {
  if (raw === null || raw === undefined || raw === '') return t(NOT_SET);
  if (kind === 'bool') return t(raw ? 'supplierLog.valueAvailable' : 'supplierLog.valueUnavailable');
  if (kind === 'money') {
    const amount = typeof raw === 'number' ? raw : Number(raw);
    /* A logged money value belongs to the supplier whose row changed, so it is rendered in
       that supplier's own currency — passed in by the caller, because the log line itself only
       remembers the number that was written. */
    return Number.isFinite(amount) ? fmtMoneyExact(amount, currency) : String(raw);
  }
  if (kind === 'date') return fmtDate(String(raw));
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : t(NOT_SET);
  return String(raw);
}

/** Every tracked field whose value actually moved. Unchanged fields are not news. */
export function fieldChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  t: (key: TKey) => string,
  /** The supplier's own currency — every money field on their row is a figure in it (0217). */
  currency?: string | null,
) {
  return Object.entries(FIELD_LABELS).flatMap(([field, meta]) => {
    const oldRaw = before?.[field] ?? null;
    const newRaw = after?.[field] ?? null;
    if (JSON.stringify(oldRaw) === JSON.stringify(newRaw)) return [];
    return [{
      field,
      label: t(meta.labelKey),
      before: renderValue(oldRaw, t, meta.kind, currency),
      after: renderValue(newRaw, t, meta.kind, currency),
    }];
  });
}
