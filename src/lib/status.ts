// Hebrew labels + badge tones for every status enum in the system.
export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'violet';
export interface StatusMeta { label: string; tone: Tone }

const m = (label: string, tone: Tone): StatusMeta => ({ label, tone });

export const ORG_STATUS: Record<string, StatusMeta> = {
  trial: m('תקופת ניסיון', 'amber'),
  active: m('פעיל', 'green'),
  suspended: m('מושהה', 'red'),
};

export const INVITATION_STATUS: Record<string, StatusMeta> = {
  pending: m('ממתינה', 'amber'),
  accepted: m('התקבלה', 'green'),
  expired: m('פגה', 'slate'),
  revoked: m('בוטלה', 'red'),
};

export const SUPPLIER_STATUS: Record<string, StatusMeta> = {
  active: m('פעיל', 'green'),
  inactive: m('לא פעיל', 'slate'),
  problematic: m('בעייתי', 'red'),
  pending: m('ממתין לאישור', 'amber'),
};

export const PO_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'slate'),
  ready: m('מוכנה', 'blue'),
  sent: m('נשלחה', 'violet'),
  confirmed: m('אושרה', 'blue'),
  partial: m('התקבלה חלקית', 'amber'),
  received: m('התקבלה', 'green'),
  cancelled: m('בוטלה', 'slate'),
};

export const REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'slate'),
  split: m('פוצלה להזמנות', 'green'),
  cancelled: m('בוטלה', 'slate'),
};

export const RECEIPT_LINE_STATUS: Record<string, StatusMeta> = {
  full: m('התקבל מלא', 'green'),
  partial: m('התקבל חלקית', 'amber'),
  missing: m('חסר', 'red'),
  damaged: m('פגום', 'red'),
  returned: m('הוחזר', 'violet'),
};

export const INVOICE_REVIEW_STATUS: Record<string, StatusMeta> = {
  received: m('התקבלה', 'slate'),
  in_review: m('בבדיקה', 'blue'),
  pending_approval: m('ממתינה לאישור', 'amber'),
  approved: m('מאושרת', 'green'),
  investigation: m('דורשת בירור', 'red'),
};

export const INVOICE_PAYMENT_STATUS: Record<string, StatusMeta> = {
  unpaid: m('לא שולמה', 'amber'),
  partial: m('שולמה חלקית', 'blue'),
  paid: m('שולמה', 'green'),
};

export const INVOICE_EXPORT_STATUS: Record<string, StatusMeta> = {
  not_sent: m('טרם הועברה לרו״ח', 'slate'),
  sent: m('הועברה לרו״ח', 'green'),
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
  open: m('פתוח', 'amber'),
  requested: m('נדרש מהספק', 'blue'),
  received: m('התקבל', 'green'),
  offset: m('קוזז בתשלום', 'violet'),
  closed: m('נסגר', 'slate'),
};

export const PAYMENT_REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('טיוטה', 'slate'),
  pending_approval: m('ממתינה לאישור', 'amber'),
  approved: m('מאושרת', 'green'),
  sent_for_execution: m('הועברה לביצוע', 'violet'),
  executed: m('הועברה בוצעה', 'blue'),
  matched: m('הותאמה לבנק', 'green'),
  investigation: m('דורשת בירור', 'red'),
  suspected_duplicate: m('חשד לכפילות', 'red'),
  cancelled: m('בוטלה', 'slate'),
};

export const BANK_TX_STATUS: Record<string, StatusMeta> = {
  unmatched: m('לא מותאמת', 'amber'),
  suggested: m('הצעת התאמה', 'blue'),
  matched: m('מותאמת', 'green'),
  ignored: m('לא רלוונטית', 'slate'),
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
  open: m('פתוח', 'red'),
  in_progress: m('בטיפול', 'amber'),
  resolved: m('טופל', 'green'),
  dismissed: m('נדחה', 'slate'),
};

export const SEVERITY: Record<string, StatusMeta> = {
  low: m('נמוכה', 'slate'),
  medium: m('בינונית', 'amber'),
  high: m('גבוהה', 'red'),
};

/**
 * Default role labels. The `user_role` enum values themselves are frozen — they are
 * baked into 77 RLS policies — so a tenant whose vocabulary differs (a garage has no
 * "מנהל מטבח") overrides the *display* label only. Defaults stay events-venue-neutral
 * where they can, and are simply the fallback where they cannot.
 */
export const ROLE_LABEL: Record<string, string> = {
  owner: 'הנהלה',
  kitchen: 'מנהל מטבח',
  office: 'מזכירות',
  payer: 'מבצע העברות',
  accountant: 'רואה חשבון',
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
