// Dictionary KEYS + badge tones for every status enum in the system.
//
// The labels used to live here in Hebrew. They now live in src/lib/i18n/dictionaries under the
// `status` namespace, and this file carries the key that names each one. THE TONE STAYED, and
// that split is the point: a tone is a CLAIM about the state — this one is finished, that one is
// waiting on you — and a claim is true in every language. Moving it into a translation file would
// have let two languages disagree about whether an invoice is a problem.
//
// Section 6 — the tone is a *claim*, not a hue:
//   done  = הושלם / תקין        await = ממתין לטיפול
//   alert = חריגה / דחוף        info  = מידע כללי
//   idle  = ניטרלי (היעדר טענה)
// The transitional `violet` is gone: the 3 statuses that held it (PO.sent, receipt.returned,
// payment.sent_for_execution) were resolved to info/alert/await (OPEN-DECISIONS #33).
import type { ActiveRole, Role } from './types';
import type { Dictionary } from './i18n/dictionaries/he';

export type Tone = 'done' | 'await' | 'alert' | 'info' | 'idle';

/**
 * Every key the `status` namespace actually holds. Derived from the dictionary rather than typed
 * as `string`, so a key with no entry — a typo, or a status added here and forgotten there — is a
 * `tsc` failure instead of a badge that renders its own key at a customer.
 */
export type StatusKey = keyof Dictionary['status'];

export interface StatusMeta { key: StatusKey; tone: Tone }

const m = (key: StatusKey, tone: Tone): StatusMeta => ({ key, tone });

/* ---------- Customer Operations (0152) — the operator console's vocabulary ---------- */

export const CUSTOMER_CONTACT_KIND: Record<string, string> = {
  primary: 'customerContact_primary',
  billing: 'customerContact_billing',
  technical: 'customerContact_technical',
};

export const CONTACT_CHANNEL: Record<string, string> = {
  email: 'channel_email',
  phone: 'channel_phone',
  whatsapp: 'channel_whatsapp',
};

// A follow-up is a promise with a date on it, so it claims attention until it is closed; a
// support interaction is information; a plain note asserts nothing.
export const CUSTOMER_NOTE_KIND: Record<string, StatusMeta> = {
  note: m('customerNote_note', 'idle'),
  support: m('customerNote_support', 'info'),
  follow_up: m('customerNote_follow_up', 'await'),
};

/**
 * Hebrew for the actions recorded in `platform_lifecycle_events`. A reader that met an unknown
 * action must show the raw string rather than an empty cell — the ledger is evidence, and an
 * action this map has not caught up with is still something that happened.
 */
export const PLATFORM_EVENT_ACTION: Record<string, string> = {
  customer_account_set: 'platformEvent_customer_account_set',
  customer_contact_set: 'platformEvent_customer_contact_set',
  customer_contact_removed: 'platformEvent_customer_contact_removed',
  customer_internal_note_added: 'platformEvent_customer_internal_note_added',
  customer_follow_up_resolved: 'platformEvent_customer_follow_up_resolved',
  subscription_set: 'platformEvent_subscription_set',
  entitlement_override_granted: 'platformEvent_entitlement_override_granted',
  entitlement_override_revoked: 'platformEvent_entitlement_override_revoked',
  onboarding_step_recorded: 'platformEvent_onboarding_step_recorded',
};

// `past_due` is a claim that money is owed, not a neutral state; `paused` and `canceled` say the
// relationship stopped without implying which side stopped it.
export const SUBSCRIPTION_STATUS: Record<string, StatusMeta> = {
  active: m('subscription_active', 'done'),
  past_due: m('subscription_past_due', 'alert'),
  paused: m('subscription_paused', 'await'),
  canceled: m('subscription_canceled', 'idle'),
};

// Health is never a score. `unknown` is a real answer -- a customer we cannot judge is not a
// healthy one -- and it is idle rather than green precisely so nobody reads it as reassurance.
export const CUSTOMER_HEALTH: Record<string, StatusMeta> = {
  healthy: m('health_healthy', 'done'),
  needs_attention: m('health_needs_attention', 'await'),
  at_risk: m('health_at_risk', 'alert'),
  unknown: m('health_unknown', 'idle'),
};

export const ONBOARDING_STEP_STATE: Record<string, StatusMeta> = {
  completed: m('onboardingStep_completed', 'done'),
  in_progress: m('onboardingStep_in_progress', 'await'),
  blocked: m('onboardingStep_blocked', 'alert'),
  skipped: m('onboardingStep_skipped', 'idle'),
  not_started: m('onboardingStep_not_started', 'idle'),
};

export const ONBOARDING_SOURCE: Record<string, string> = {
  product_event: 'onboardingSource_product_event',
  operator_manual: 'onboardingSource_operator_manual',
  none: 'onboardingSource_none',
};

export const ORG_STATUS: Record<string, StatusMeta> = {
  active: m('org_active', 'done'),
  suspended: m('org_suspended', 'alert'),
};

export const INVITATION_STATUS: Record<string, StatusMeta> = {
  pending: m('invitation_pending', 'await'),
  accepted: m('invitation_accepted', 'done'),
  expired: m('invitation_expired', 'idle'),             // פ (idle vs await) — kept at current colour
  revoked: m('invitation_revoked', 'idle'),           // §5: an intentional revoke is not an anomaly; red was noise
};

export const SUPPLIER_STATUS: Record<string, StatusMeta> = {
  active: m('supplier_active', 'done'),
  inactive: m('supplier_inactive', 'idle'),
  problematic: m('supplier_problematic', 'alert'),
  pending: m('supplier_pending', 'await'),
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
  draft: m('po_draft', 'idle'),
  ready: m('po_ready', 'await'), // יש פעולה מצדנו (OPEN-DECISIONS #33)
  sent: m('po_sent', 'info'),          // הכדור אצל הספק — מידע
  confirmed: m('po_confirmed', 'done'),         // הספק אישר — הצעד הושלם
  partial: m('po_partial', 'await'),
  received: m('po_received', 'done'),
  cancelled: m('po_cancelled', 'idle'),
};

export const REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('request_draft', 'idle'),
  split: m('request_split', 'done'),
  cancelled: m('request_cancelled', 'idle'),
};

// A supplier's structured response to an order (0167). `submitted` is the one state waiting on
// US — the supplier already acted; everything after it records our decision.
export const SUPPLIER_PROPOSAL_STATUS: Record<string, StatusMeta> = {
  submitted: m('proposal_submitted', 'await'),
  accepted: m('proposal_accepted', 'done'),
  partially_accepted: m('proposal_partially_accepted', 'done'),
  rejected: m('proposal_rejected', 'idle'),
};

// The supplier-portal link lifecycle (0167), derived from timestamps — not a stored enum.
export const SUPPLIER_LINK_STATE: Record<string, StatusMeta> = {
  live: m('supplierLink_live', 'done'),
  submitted: m('supplierLink_submitted', 'info'),
  expired: m('supplierLink_expired', 'idle'),
  revoked: m('supplierLink_revoked', 'idle'),
};

// Email order delivery (0168). `accepted` is the provider's word, not proof of reading;
// `unknown` is an in-flight send whose lease died — frozen for reconciliation, never guessed.
export const EMAIL_MESSAGE_STATUS: Record<string, StatusMeta> = {
  queued: m('email_queued', 'idle'),
  sending: m('email_sending', 'await'),
  unknown: m('email_unknown', 'alert'),
  accepted: m('email_accepted', 'info'),
  delivered: m('email_delivered', 'done'),
  bounced: m('email_bounced', 'alert'),
  failed: m('email_failed', 'alert'),
};

// Supplier communication channel (0168 preferences).
export const COMMUNICATION_CHANNEL: Record<string, StatusMeta> = {
  manual: m('communication_manual', 'idle'),
  email: m('communication_email', 'info'),
  whatsapp: m('communication_whatsapp', 'info'),
  both: m('communication_both', 'info'),
};

export const RECEIPT_LINE_STATUS: Record<string, StatusMeta> = {
  full: m('receiptLine_full', 'done'),
  partial: m('receiptLine_partial', 'await'),
  missing: m('receiptLine_missing', 'alert'),
  damaged: m('receiptLine_damaged', 'alert'),
  returned: m('receiptLine_returned', 'alert'),         // חריגה שדורשת זיכוי
};

export const RECEIPT_STATUS: Record<string, StatusMeta> = {
  draft: m('receipt_draft', 'idle'),
  completed: m('receipt_completed', 'done'),
};

export const INVOICE_REVIEW_STATUS: Record<string, StatusMeta> = {
  received: m('invoiceReview_received', 'await'),        // an untouched received invoice is waiting for review
  in_review: m('invoiceReview_in_review', 'await'),       // ממתינה להשלמת בדיקה
  pending_approval: m('invoiceReview_pending_approval', 'await'),
  approved: m('invoiceReview_approved', 'done'),
  investigation: m('invoiceReview_investigation', 'alert'),
};

export const INVOICE_PAYMENT_STATUS: Record<string, StatusMeta> = {
  unpaid: m('invoicePayment_unpaid', 'await'),
  partial: m('invoicePayment_partial', 'await'),    // §5: an open balance is open work (aligns with the money-balance idiom)
  paid: m('invoicePayment_paid', 'done'),
};

export const INVOICE_EXPORT_STATUS: Record<string, StatusMeta> = {
  not_sent: m('invoiceExport_not_sent', 'idle'), // פ-5 — kept idle so amber stays a real signal, not most of the month
  sent: m('invoiceExport_sent', 'done'),
};

export const CREDIT_REASON: Record<string, string> = {
  missing: 'creditReason_missing',
  damaged: 'creditReason_damaged',
  returned: 'creditReason_returned',
  wrong_price: 'creditReason_wrong_price',
  duplicate_charge: 'creditReason_duplicate_charge',
  other: 'creditReason_other',
};

export const CREDIT_STATUS: Record<string, StatusMeta> = {
  open: m('credit_open', 'await'),
  requested: m('credit_requested', 'await'),   // §5: checks.ts counts it as an open credit awaiting offset
  received: m('credit_received', 'done'),          // פ-6 — kept at current colour (conflicts with checks.ts; see report)
  offset: m('credit_offset', 'done'),      // §5: checks.ts already treats offset as a final success state
  closed: m('credit_closed', 'idle'),
};

export const PAYMENT_REQUEST_STATUS: Record<string, StatusMeta> = {
  draft: m('paymentRequest_draft', 'idle'),
  pending_approval: m('paymentRequest_pending_approval', 'await'),
  approved: m('paymentRequest_approved', 'await'),                 // אושרה אך הכסף טרם הועבר — ממתין לביצוע
  sent_for_execution: m('paymentRequest_sent_for_execution', 'await'), // ממתין להעברה בפועל
  executed: m('paymentRequest_executed', 'done'),             // ההעברה בוצעה
  matched: m('paymentRequest_matched', 'done'),
  investigation: m('paymentRequest_investigation', 'alert'),
  suspected_duplicate: m('paymentRequest_suspected_duplicate', 'alert'),
  cancelled: m('paymentRequest_cancelled', 'idle'),
};

export const BANK_TX_STATUS: Record<string, StatusMeta> = {
  unmatched: m('bankTx_unmatched', 'await'),
  suggested: m('bankTx_suggested', 'await'),   // §5: a suggested match needs human approval — a task, not information
  matched: m('bankTx_matched', 'done'),
  ignored: m('bankTx_ignored', 'idle'),
};

export const EXCEPTION_TYPE: Record<string, string> = {
  payment_without_invoice: 'exceptionType_payment_without_invoice',
  invoice_without_payment: 'exceptionType_invoice_without_payment',
  amount_mismatch: 'exceptionType_amount_mismatch',
  duplicate_payment: 'exceptionType_duplicate_payment',
  duplicate_invoice: 'exceptionType_duplicate_invoice',
  unknown_supplier: 'exceptionType_unknown_supplier',
  unmatched_bank: 'exceptionType_unmatched_bank',
  credit_not_deducted: 'exceptionType_credit_not_deducted',
  receipt_mismatch: 'exceptionType_receipt_mismatch',
  // 0086 added the enum value §17 planned, 0087 gave the manual command the honest type from day
  // one, and 0290 finished the job: the automatic path in apply_document_interpretation raises
  // `item_not_ordered` itself rather than filing under receipt_mismatch with the real name hidden
  // in details.code. Both paths now land in one bucket, so a manager filtering for "פריט שלא
  // הוזמן" sees what the machine found as well as what a person opened. details.code survives —
  // it names the ITEM as well as the kind, and three p14 assertions read it.
  item_not_ordered: 'exceptionType_item_not_ordered',
  // 0273. A document that was expected and never came -- a finding, not the absence of one.
  // It waited here unlabelled: the table rendered an empty cell and the filter on /exceptions
  // is built from THIS map, so the type could not even be selected. check:exception-labels.
  expected_document_missing: 'exceptionType_expected_document_missing',
  // 0291/0292. Money recorded against an invoice nobody approved. The bank door does two jobs --
  // paying through the product, and recording money that already left the account -- and recording
  // is never refused, because refusing it would make the ledger less true. So the control is that
  // it cannot happen QUIETLY: 0292 opens one of these in the same transaction as the allocations.
  // Unlike amount_mismatch, the figures here agree perfectly; what is missing is the authority.
  unapproved_invoice_settled: 'exceptionType_unapproved_invoice_settled',
};

export const EXCEPTION_STATUS: Record<string, StatusMeta> = {
  open: m('exception_open', 'alert'),              // an open exception is an active deviation
  in_progress: m('exception_in_progress', 'await'),
  resolved: m('exception_resolved', 'done'),
  dismissed: m('exception_dismissed', 'idle'),
};

// Deliberately a DIFFERENT scale from checks.ts/alerts.ts (info/warning/critical): this one
// is the STORED exceptions.severity enum (low/medium/high, a DB column); those are TRANSIENT
// in-memory results. Two vocabularies, two lifetimes — do not "unify" the strings. They already
// converge where it matters: both map to the same Tone (alert/await/idle|info) for display.
export const SEVERITY: Record<string, StatusMeta> = {
  low: m('severity_low', 'idle'),
  medium: m('severity_medium', 'await'),
  high: m('severity_high', 'alert'),
};

/**
 * Product availability shown as a status pill (§4.5). One dictionary replaces the
 * identical inline logic that was duplicated across the manager price-list surfaces, so
 * every surface colours availability from a single source through <StatusBadge>.
 * Colours preserve the previous ones (available=green, unavailable=red).
 */
export const PRODUCT_AVAILABILITY: Record<'available' | 'unavailable', StatusMeta> = {
  available: m('availability_available', 'done'),
  unavailable: m('availability_unavailable', 'alert'),
};

/**
 * Default role labels for the three personas the product can still assign. The `user_role`
 * enum values themselves are frozen — they are baked into 77 RLS policies — so a tenant whose
 * vocabulary differs (a garage does not call its buyer "מנהל רכש") overrides the *display*
 * label only. Defaults stay events-venue-neutral where they can, and are simply the fallback
 * where they cannot.
 */
export const ACTIVE_ROLE_LABEL: Record<ActiveRole, string> = {
  owner: 'role_owner',
  office: 'role_office',
  accountant: 'role_accountant',
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
  kitchen: 'role_kitchen',
  payer: 'role_payer',
  supplier: 'role_supplier',
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
export function resolveRoleLabels(
  orgSettings: unknown,
  /**
   * Turns a dictionary key into text. Passed in rather than imported, because this file must stay
   * a pure map of keys and tones — the moment it could resolve a language it would become a second
   * place where one gets chosen.
   */
  statusLabel: (key: string) => string,
): Record<string, string> {
  // A tenant's own word for a role wins over the dictionary in EVERY language. `role_labels` is
  // vocabulary the organisation chose for itself; translating it would be answering a question
  // they already answered.
  const defaults = Object.fromEntries(
    Object.entries(ROLE_LABEL).map(([role, key]) => [role, statusLabel(key) || key]),
  );
  const raw = (orgSettings as { role_labels?: unknown } | null | undefined)?.role_labels;
  if (!raw || typeof raw !== 'object') return defaults;
  const overrides = raw as Record<string, unknown>;
  const resolved = { ...defaults };
  for (const role of Object.keys(ACTIVE_ROLE_LABEL)) {
    const value = overrides[role];
    if (typeof value === 'string' && value.trim()) resolved[role] = value.trim();
  }
  return resolved;
}
