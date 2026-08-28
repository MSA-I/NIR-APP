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
import { fmtDate, fmtMoneyExact } from './format';

/** What a value looks like when there is nothing there. Scoped to this screen — see the note above. */
const NOT_SET = 'לא הוגדר';

/**
 * The fields a person asks about, and how to say each one. Everything absent from this map is
 * absent from the screen — ids, org_id, timestamps and `*_by` columns are how the database keeps
 * its books, not what changed about a supplier or a price. `money` and `date` also decide the
 * formatting, so a price never renders as `420` and a date never as an ISO string.
 */
const FIELD_LABELS: Record<string, { label: string; kind?: 'money' | 'date' | 'bool' }> = {
  // supplier_products
  current_price: { label: 'מחיר נוכחי', kind: 'money' },
  previous_price: { label: 'מחיר קודם', kind: 'money' },
  price_effective_date: { label: 'בתוקף מ־', kind: 'date' },
  available: { label: 'זמינות', kind: 'bool' },
  min_qty: { label: 'כמות מינימום' },
  package_size: { label: 'גודל אריזה' },
  supplier_sku: { label: 'מק״ט ספק' },
  // suppliers
  name: { label: 'שם' },
  status: { label: 'סטטוס' },
  tax_id: { label: 'ח.פ / עוסק' },
  contact_name: { label: 'איש קשר' },
  phone: { label: 'טלפון' },
  whatsapp: { label: 'וואטסאפ' },
  email: { label: 'אימייל' },
  address: { label: 'כתובת' },
  payment_terms: { label: 'תנאי תשלום' },
  delivery_days: { label: 'ימי אספקה' },
  cutoff_time: { label: 'שעת סגירה' },
  min_order_amount: { label: 'מינימום להזמנה', kind: 'money' },
  rating: { label: 'דירוג' },
  rating_note: { label: 'הערת דירוג' },
  notes: { label: 'הערות' },
  deleted_at: { label: 'נמחק', kind: 'date' },
};

export function renderValue(
  raw: unknown,
  kind?: 'money' | 'date' | 'bool',
  currency?: string | null,
): string {
  if (raw === null || raw === undefined || raw === '') return NOT_SET;
  if (kind === 'bool') return raw ? 'זמין' : 'לא זמין';
  if (kind === 'money') {
    const amount = typeof raw === 'number' ? raw : Number(raw);
    /* A logged money value belongs to the supplier whose row changed, so it is rendered in
       that supplier's own currency — passed in by the caller, because the log line itself only
       remembers the number that was written. */
    return Number.isFinite(amount) ? fmtMoneyExact(amount, currency) : String(raw);
  }
  if (kind === 'date') return fmtDate(String(raw));
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : NOT_SET;
  return String(raw);
}

/** Every tracked field whose value actually moved. Unchanged fields are not news. */
export function fieldChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  /** The supplier's own currency — every money field on their row is a figure in it (0217). */
  currency?: string | null,
) {
  return Object.entries(FIELD_LABELS).flatMap(([field, meta]) => {
    const oldRaw = before?.[field] ?? null;
    const newRaw = after?.[field] ?? null;
    if (JSON.stringify(oldRaw) === JSON.stringify(newRaw)) return [];
    return [{
      field,
      label: meta.label,
      before: renderValue(oldRaw, meta.kind, currency),
      after: renderValue(newRaw, meta.kind, currency),
    }];
  });
}
