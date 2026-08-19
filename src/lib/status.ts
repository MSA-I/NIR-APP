// Hebrew labels + badge tones for every status enum in the system.
//
// Section 6 — the tone is a *claim*, not a hue:
//   done  = הושלם / תקין        await = ממתין לטיפול
//   alert = חריגה / דחוף        info  = מידע כללי
//   idle  = ניטרלי (היעדר טענה)
// The transitional `violet` is gone: the 3 statuses that held it (PO.sent, receipt.returned,
// payment.sent_for_execution) were resolved to info/alert/await (OPEN-DECISIONS #33).
import type { ActiveRole, Role } from './types';

export type Tone = 'done' | 'await' | 'alert' | 'info' | 'idle';
export interface StatusMeta { label: string; tone: Tone }

const m = (label: string, tone: Tone): StatusMeta => ({ label, tone });

export const ORG_STATUS: Record<string, StatusMeta> = {
  active: m('פעיל', 'done'),
  suspended: m('מושהה', 'alert'),
};

export const INVITATION_STATUS: Record<string, StatusMeta> = {
  pending: m('ממתינה', 'await'),
  accepted: m('התקבלה', 'done'),
  expired: m('פגה', 'idle'),             // פ (idle vs await) — kept at current colour
  revoked: m('בוטלה', 'idle'),           // §5: an intentional revoke is not an anomaly; red was noise
};

export const SUPPLIER_STATUS: Record<string, StatusMeta> = {
  active: m('פעיל', 'done'),
  inactive: m('לא פעיל', 'idle'),
  problematic: m('בעייתי', 'alert'),
  pending: m('ממתין לאישור', 'await'),
};

/** Inactive/pending suppliers stay visible for history and finance, but cannot start commerce. */
export const NEW_COMMERCE_SUPPLIER_STATUSES = ['active', 'problematic'] as const;

export function canStartSupplierCommerce(status: string): boolean {
  return (NEW_COMMERCE_SUPPLIER_STATUSES as readonly string[]).includes(status);
}

// The two labels say WHO the order is waiting on, because that is the only thing the reader has
// to decide from. "מוכנה" and "נשלחה" left it to be guessed — ready for what, sent to whom — and
// the stored enum values `ready`/`sent` are untouched: they are wired into RLS, the transition
// allowlist and every historical audit row. Display text is the client's, per CLAUDE.md.
export const PO_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'idle'),
  ready: m('מוכנה לשליחה לספק', 'await'), // יש פעולה מצדנו (OPEN-DECISIONS #33)
  sent: m('נשלחה לספק', 'info'),          // הכדור אצל הספק — מידע
  confirmed: m('אושרה', 'done'),         // הספק אישר — הצעד הושלם
  partial: m('התקבלה חלקית', 'await'),
  received: m('התקבלה', 'done'),
  cancelled: m('בוטלה', 'idle'),
};

export const REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'idle'),
  split: m('פוצלה להזמנות', 'done'),
  cancelled: m('בוטלה', 'idle'),
};

export const RECEIPT_LINE_STATUS: Record<string, StatusMeta> = {
  full: m('התקבל מלא', 'done'),
  partial: m('התקבל חלקית', 'await'),
  missing: m('חסר', 'alert'),
  damaged: m('פגום', 'alert'),
  returned: m('הוחזר', 'alert'),         // חריגה שדורשת זיכוי
};

export const RECEIPT_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'idle'),
  completed: m('הושלמה', 'done'),
};

export const INVOICE_REVIEW_STATUS: Record<string, StatusMeta> = {
  received: m('התקבלה', 'await'),        // an untouched received invoice is waiting for review
  in_review: m('בבדיקה', 'await'),       // ממתינה להשלמת בדיקה
  pending_approval: m('ממתינה לאישור', 'await'),
  approved: m('מאושרת', 'done'),
  investigation: m('דורשת בירור', 'alert'),
};

export const INVOICE_PAYMENT_STATUS: Record<string, StatusMeta> = {
  unpaid: m('לא שולמה', 'await'),
  partial: m('שולמה חלקית', 'await'),    // §5: an open balance is open work (aligns with the money-balance idiom)
  paid: m('שולמה', 'done'),
};

export const INVOICE_EXPORT_STATUS: Record<string, StatusMeta> = {
  not_sent: m('טרם הועברה לרו״ח', 'idle'), // פ-5 — kept idle so amber stays a real signal, not most of the month
  sent: m('הועברה לרו״ח', 'done'),
};

export const CREDIT_REASON: Record<string, string> = {
  missing: 'חוסר בסחורה',
  damaged: 'סחורה פגומה',
  returned: 'החזרת סחורה',
  wrong_price: 'טעות מחיר',
  duplicate_charge: 'חיוב כפול',
  other: 'אחר',
};

export const CREDIT_STATUS: Record<string, StatusMeta> = {
  open: m('פתוח', 'await'),
  requested: m('נדרש מהספק', 'await'),   // §5: checks.ts counts it as an open credit awaiting offset
  received: m('התקבל', 'done'),          // פ-6 — kept at current colour (conflicts with checks.ts; see report)
  offset: m('קוזז בתשלום', 'done'),      // §5: checks.ts already treats offset as a final success state
  closed: m('נסגר', 'idle'),
};

export const PAYMENT_REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'idle'),
  pending_approval: m('ממתינה לאישור', 'await'),
  approved: m('מאושרת', 'await'),                 // אושרה אך הכסף טרם הועבר — ממתין לביצוע
  sent_for_execution: m('הועברה לביצוע', 'await'), // ממתין להעברה בפועל
  executed: m('העברה בוצעה', 'done'),             // ההעברה בוצעה
  matched: m('הותאמה לבנק', 'done'),
  investigation: m('דורשת בירור', 'alert'),
  suspected_duplicate: m('חשד לכפילות', 'alert'),
  cancelled: m('בוטלה', 'idle'),
};

export const BANK_TX_STATUS: Record<string, StatusMeta> = {
  unmatched: m('לא מותאמת', 'await'),
  suggested: m('הצעת התאמה', 'await'),   // §5: a suggested match needs human approval — a task, not information
  matched: m('מותאמת', 'done'),
  ignored: m('לא רלוונטית', 'idle'),
};

export const EXCEPTION_TYPE: Record<string, string> = {
  payment_without_invoice: 'תשלום ללא חשבונית',
  invoice_without_payment: 'חשבונית ללא תשלום',
  amount_mismatch: 'אי-התאמת סכומים',
  duplicate_payment: 'חשד לתשלום כפול',
  duplicate_invoice: 'חשד לחשבונית כפולה',
  unknown_supplier: 'ספק לא מזוהה',
  unmatched_bank: 'תנועת בנק לא מותאמת',
  credit_not_deducted: 'זיכוי שלא קוזז',
  receipt_mismatch: 'פער קבלה מול חשבונית',
  // 0086 added the enum value §17 planned. The automatic path (0077) still files under
  // receipt_mismatch with details.code='item_not_ordered' — that injection is §17's
  // remaining step; the manual command (0087) uses the honest type from day one.
  item_not_ordered: 'פריט שלא הוזמן',
};

export const EXCEPTION_STATUS: Record<string, StatusMeta> = {
  open: m('פתוח', 'alert'),              // an open exception is an active deviation
  in_progress: m('בטיפול', 'await'),
  resolved: m('טופל', 'done'),
  dismissed: m('נדחה', 'idle'),
};

// Deliberately a DIFFERENT scale from checks.ts/alerts.ts (info/warning/critical): this one
// is the STORED exceptions.severity enum (low/medium/high, a DB column); those are TRANSIENT
// in-memory results. Two vocabularies, two lifetimes — do not "unify" the strings. They already
// converge where it matters: both map to the same Tone (alert/await/idle|info) for display.
export const SEVERITY: Record<string, StatusMeta> = {
  low: m('נמוכה', 'idle'),
  medium: m('בינונית', 'await'),
  high: m('גבוהה', 'alert'),
};

/**
 * Product availability shown as a status pill (§4.5). One dictionary replaces the
 * identical inline logic that was duplicated across the manager price-list surfaces, so
 * every surface colours availability from a single source through <StatusBadge>.
 * Colours preserve the previous ones (available=green, unavailable=red).
 */
export const PRODUCT_AVAILABILITY: Record<'available' | 'unavailable', StatusMeta> = {
  available: m('זמין', 'done'),
  unavailable: m('לא זמין', 'alert'),
};

/**
 * Default role labels for the three personas the product can still assign. The `user_role`
 * enum values themselves are frozen — they are baked into 77 RLS policies — so a tenant whose
 * vocabulary differs (a garage does not call its buyer "מנהל רכש") overrides the *display*
 * label only. Defaults stay events-venue-neutral where they can, and are simply the fallback
 * where they cannot.
 */
export const ACTIVE_ROLE_LABEL: Record<ActiveRole, string> = {
  owner: 'מנהל/בעלים',
  office: 'מנהל רכש',
  accountant: 'הנהלת חשבונות',
};

/**
 * The three personas that retired from the product (`0133`). A profile still carrying one is
 * history, not a job somebody holds today — `auth_role()` resolves it to NULL, sign-in is
 * refused, and `manage_profile_access` raises `account_role_retired` on any attempt to make one
 * active again. The suffix is what makes an archive row read as a record of the past
 * instead of as a roster entry that quietly stopped working.
 *
 * `Exclude<Role, ActiveRole>` on purpose: the two dictionaries have to partition the enum, and
 * the compiler is a better guard of that than a comment is.
 */
export const HISTORICAL_ROLE_LABEL: Record<Exclude<Role, ActiveRole>, string> = {
  kitchen: 'מנהל מטבח (היסטורי)',
  payer: 'מבצע העברות (היסטורי)',
  supplier: 'ספק (היסטורי)',
};

/** The union of both, so an archived row still renders a name rather than a raw enum value. */
export const ROLE_LABEL: Record<string, string> = { ...ACTIVE_ROLE_LABEL, ...HISTORICAL_ROLE_LABEL };

/**
 * Per-tenant role labels, resolved from `organizations.settings.role_labels`.
 *
 * `settings` is a jsonb column, so its contents are untrusted at the type level — this
 * reads it defensively and accepts a string override only for a role that actually
 * exists in ACTIVE_ROLE_LABEL. Unknown keys are dropped: a settings blob can rename a role,
 * never invent one. Any role the tenant has not customized keeps its Hebrew default.
 *
 * The loop reads ACTIVE_ROLE_LABEL rather than ROLE_LABEL, which tightens that same rule by
 * one turn: a tenant may rename a role they can actually assign, but not one that retired from
 * the product. Renaming `payer` would put a tenant's chosen job title on an archive row and
 * make a closed account look like a current one — and there is no live account left to name.
 *
 * Prefer `useAuth().roleLabels` in components; this is the pure function underneath.
 */
export function resolveRoleLabels(orgSettings: unknown): Record<string, string> {
  const raw = (orgSettings as { role_labels?: unknown } | null | undefined)?.role_labels;
  if (!raw || typeof raw !== 'object') return ROLE_LABEL;
  const overrides = raw as Record<string, unknown>;
  const resolved = { ...ROLE_LABEL };
  for (const role of Object.keys(ACTIVE_ROLE_LABEL)) {
    const value = overrides[role];
    if (typeof value === 'string' && value.trim()) resolved[role] = value.trim();
  }
  return resolved;
}
