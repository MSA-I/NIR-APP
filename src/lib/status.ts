// Hebrew labels + badge tones for every status enum in the system.
//
// Section 6 — the tone is a *claim*, not a hue:
//   done  = הושלם / תקין        await = ממתין לטיפול
//   alert = חריגה / דחוף        info  = מידע כללי
//   idle  = ניטרלי (היעדר טענה)
// The transitional `violet` is gone: the 3 statuses that held it (PO.sent, receipt.returned,
// payment.sent_for_execution) were resolved to info/alert/await (OPEN-DECISIONS #33).
export type Tone = 'done' | 'await' | 'alert' | 'info' | 'idle';
export interface StatusMeta { label: string; tone: Tone }

const m = (label: string, tone: Tone): StatusMeta => ({ label, tone });

export const ORG_STATUS: Record<string, StatusMeta> = {
  trial: m('תקופת ניסיון', 'info'),      // §5: not a task for anyone — trial_ends_at is not enforced (OPEN-DECISIONS #15)
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

export const PO_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'idle'),
  ready: m('מוכנה', 'await'),            // ממתינה לשליחה — יש פעולה מצדנו (OPEN-DECISIONS #33)
  sent: m('נשלחה', 'info'),              // הכדור אצל הספק — מידע
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
  executed: m('הועברה בוצעה', 'done'),            // ההעברה בוצעה
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
 * identical inline logic that was duplicated in PriceLists and SupplierPrices, so
 * both screens now colour availability from a single source through <StatusBadge>.
 * Colours preserve the previous ones (available=green, unavailable=red).
 */
export const PRODUCT_AVAILABILITY: Record<'available' | 'unavailable', StatusMeta> = {
  available: m('זמין', 'done'),
  unavailable: m('לא זמין', 'alert'),
};

/**
 * Default role labels. The `user_role` enum values themselves are frozen — they are
 * baked into 77 RLS policies — so a tenant whose vocabulary differs (a garage has no
 * "מנהל מטבח") overrides the *display* label only. Defaults stay events-venue-neutral
 * where they can, and are simply the fallback where they cannot.
 */
export const ROLE_LABEL: Record<string, string> = {
  owner: 'מנהל/בעלים',
  kitchen: 'מנהל מטבח',
  office: 'מנהל רכש',
  payer: 'מבצע העברות',
  accountant: 'הנהלת חשבונות',
  supplier: 'ספק',
};

/**
 * Per-tenant role labels, resolved from `organizations.settings.role_labels`.
 *
 * `settings` is a jsonb column, so its contents are untrusted at the type level — this
 * reads it defensively and accepts a string override only for a role that actually
 * exists in ROLE_LABEL. Unknown keys are dropped: a settings blob can rename a role,
 * never invent one. Any role the tenant has not customized keeps its Hebrew default.
 *
 * Prefer `useAuth().roleLabels` in components; this is the pure function underneath.
 */
export function resolveRoleLabels(orgSettings: unknown): Record<string, string> {
  const raw = (orgSettings as { role_labels?: unknown } | null | undefined)?.role_labels;
  if (!raw || typeof raw !== 'object') return ROLE_LABEL;
  const overrides = raw as Record<string, unknown>;
  const resolved = { ...ROLE_LABEL };
  for (const role of Object.keys(ROLE_LABEL)) {
    const value = overrides[role];
    if (typeof value === 'string' && value.trim()) resolved[role] = value.trim();
  }
  return resolved;
}
