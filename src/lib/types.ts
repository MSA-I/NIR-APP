// Row types matching supabase/migrations/0001_init.sql (hand-maintained, pragmatic subset)
import type { Locale } from './i18n/locale.ts';
// The extension is not optional: `supabase/functions/assistant` type-checks this module under
// Deno, which resolves a bare specifier as a bare module and fails.
import type { ToleranceSetting } from './tolerances.ts';

export type Role = 'owner' | 'kitchen' | 'office' | 'payer' | 'accountant' | 'supplier';

/**
 * The enum above is historical database vocabulary and cannot be narrowed without rewriting the
 * RLS contract. Product accounts are narrower: from 12.08.2026 only these three personas may be
 * active. Keeping the two concepts separate prevents a historical `payer` value from silently
 * becoming a login option again.
 */
export const ACTIVE_ROLES = ['owner', 'office', 'accountant'] as const satisfies readonly Role[];
export type ActiveRole = (typeof ACTIVE_ROLES)[number];

export function isActiveRole(role: string | null | undefined): role is ActiveRole {
  return ACTIVE_ROLES.includes(role as ActiveRole);
}

export interface Profile {
  id: string;
  org_id: string;
  full_name: string;
  role: Role;
  phone: string | null;
  active: boolean;
  supplier_id: string | null; // historical supplier-agent association; never grants an active login
  // Interface language this person chose (0213). `null` is a third state, not Hebrew: it means
  // they never chose, so the browser keeps deciding. See src/lib/i18n/locale.ts.
  locale: Locale | null;
}

export type OrgStatus = 'active' | 'suspended';

export interface Organization {
  id: string;
  name: string;
  vat_rate: number;
  /** The currency this business keeps its books in (0217, #277). Decides display ORDER, never a conversion. */
  base_currency: string;
  /** ISO-3166-1 alpha-2 country of the BUSINESS, which decides the VAT rate (0217, #285). */
  country_code: string;
    status: OrgStatus;
    logo_path: string | null;
    logo_updated_at: string | null;
  /**
   * When the owner said the setup wizard was finished (0258). `null` means they never said so,
   * and `/onboarding` is still offered in the navigation.
   *
   * A statement, not a measurement. Per-STEP completion in the wizard stays derived from live row
   * counts — that is what makes a checkmark honest on a second device — but whether the errand is
   * over is the owner's own call, and an owner may finish deliberately with steps still skipped.
   */
  onboarding_completed_at: string | null;
  settings: {
    bank_match_days: number;
    /**
     * A number OR a map from ISO code to amount (`#288`, `#290`). Both shapes are live: every
     * organisation that predates 0219 holds the bare number, which `private.money_tolerance`
     * reads as the ILS value and as nothing else. Typing this `number` alone is how the client
     * came to invent a shekel-shaped 1 for dollar statement lines the server then refused.
     * Read through `readTolerance`, write through `writeTolerance` — never by hand.
     */
    bank_match_amount_tolerance: ToleranceSetting;
    /** The same two shapes, for the three tolerances that had no screen at all before this one. */
    payment_request_amount_tolerance?: ToleranceSetting;
    invoice_line_amount_tolerance?: ToleranceSetting;
    invoice_document_amount_tolerance?: ToleranceSetting;
    // Per-tenant display names for roles. The user_role enum is fixed (it is baked into the
    // RLS policies); only the label moves. resolveRoleLabels() in status.ts honors a key
    // only if it already exists in ROLE_LABEL, so a settings blob can rename a role but
    // never invent one.
    role_labels?: Partial<Record<Role, string>>;
  };
}

/** Keys match INVITATION_STATUS in status.ts. Derived, not a stored column. */
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

/** Migration 0007. `token_hash` is deliberately absent — it is never read client-side. */
export interface Invitation {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  invited_by: string | null;
  last_sent_at: string;
  send_count: number;
  created_at: string;
}

/** One row of the platform_orgs() RPC (migration 0006). Cross-tenant, operators only. */
export interface PlatformOrg {
  id: string;
  name: string;
  status: OrgStatus;
  vat_rate: number;
  created_at: string;
  user_count: number;
}

/**
 * One row of the platform_customers() RPC (migration 0151) — the operator customer list, with
 * server-side search, filtering and paging.
 *
 * `last_activity_at` is null for a customer that has never done anything, and the screen must
 * render that as `—`. A date would be a claim; zero would be a different claim. `total_count` is
 * the filtered count BEFORE paging, repeated on every row so the pager needs no second request.
 */
export interface PlatformCustomer {
  id: string;
  name: string;
  status: OrgStatus;
  vat_rate: number;
  created_at: string;
  active_user_count: number;
  last_activity_at: string | null;
  offboarding_status: string | null;
  total_count: number;
}

/** One row of the supplier_metrics view (migration 0012). on_time_pct/avg_lead_days are
 *  null (never 0) when there are no promised-date samples. */
export interface SupplierMetrics {
  supplier_id: string;
  otd_samples: number;
  otd_on_time: number;
  on_time_pct: number | null;
  lead_samples: number;
  avg_lead_days: number | null;
  open_exceptions: number;
  exceptions_window: number;
  exceptions_lifetime: number;
  open_credits: number;
  /** `null` for a reader who may not read the allocation ledger the remainder is computed from. */
  open_credits_amount: number | null;
  /**
   * The currency `open_credits_amount` is in (0223), or null when the supplier holds open credits
   * in more than one — in which case the amount is null too, because the view refuses to add them.
   */
  open_credits_currency: string | null;
  credits_window: number;
  credits_lifetime: number;
  priced_items: number;
  price_changes_window: number;
  last_price_change: string | null;
}

export type SearchEntity = 'supplier' | 'product' | 'invoice' | 'order' | 'payment' | 'credit' | 'draft';

/** One row of the global_search() RPC (migration 0011). */
export interface SearchHit {
  entity: SearchEntity;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  amount: number | null;
  /** The currency of `amount` (0224). Null wherever the amount is null — a hit with no figure. */
  currency: string | null;
  occurred_at: string | null;
  rank: number;
}

export interface Category { id: string; org_id: string; name: string; sort: number }

export type SupplierStatus = 'active' | 'inactive' | 'problematic' | 'pending';
export interface SupplierBankDetails {
  supplier_id?: string;
  account_holder: string;
  country_code: string;
  bank_code: string | null;
  branch_code: string | null;
  account_number: string | null;
  iban: string | null;
  bic: string | null;
  migration_pending?: boolean;
}

export interface SupplierBankMigrationItem {
  supplier_id: string;
  legacy_bank_details: string;
  status: 'pending';
}

export interface Supplier {
  id: string; org_id: string; name: string;
  tax_id: string | null; contact_name: string | null; phone: string | null;
  whatsapp: string | null; email: string | null; address: string | null;
  delivery_days: number[]; cutoff_time: string | null;
  min_order_amount: number | null; payment_terms: string | null;
  /** The currency a NEW document for this supplier starts in, and the one min_order_amount is stated in (0217). */
  default_currency: string;
  /** ISO-3166-1 alpha-2, or null for "nobody has said" — resolved on read from the bank account then the organisation (0217, #285). */
  country_code: string | null;
  /** Legacy column. 0171 clears it and keeps review-only text in a private migration queue. */
  bank_details: string | null; notes: string | null;
  status: SupplierStatus; deleted_at: string | null;
}

export interface Product {
  id: string; org_id: string; name: string;
  /**
   * The canonical, human-approved name (0149). NULL means none was approved and readers fall back
   * to `name`. Never used for matching -- `nameKey(name)` stays the sole matching key -- and never
   * sent to a supplier, who recognises their own wording, not one we composed.
   */
  display_name: string | null;
  category_id: string | null;
  unit: string; sku: string | null; barcode: string | null; notes: string | null;
  active: boolean; min_stock: number | null;
  category?: { id: string; name: string } | null;
}

export interface SupplierProduct {
  id: string; org_id: string; supplier_id: string; product_id: string;
  current_price: number; previous_price: number | null; price_effective_date: string;
  /** The currency this supplier quotes this product in (0217). */
  currency: string;
  available: boolean; supplier_sku: string | null; min_qty: number | null;
  package_size: number | null; updated_at: string;
  supplier?: Supplier; product?: Product;
}

export interface PriceHistory { id: string; supplier_product_id: string; price: number; currency: string; effective_date: string }

export type SupplierPriceSubmissionStatus = 'accepted' | 'accepted_with_rejections' | 'rejected';
export interface SupplierPriceRejection {
  row: number;
  product?: string | null;
  reason: 'unknown_product' | 'invalid_price' | 'duplicate_product' | 'invalid_row';
  message: string;
}
export interface SupplierPriceSubmission {
  id: string; org_id: string; supplier_id: string; target_month: string; revision: number;
  file_name: string | null; storage_path: string | null; file_checksum: string | null;
  status: SupplierPriceSubmissionStatus;
  row_count: number; created_count: number; updated_count: number;
  accepted_count: number; rejected_count: number; unchanged_count: number;
  rejections: SupplierPriceRejection[];
  submitted_by: string | null; submitted_at: string; processed_at: string;
}

export type RequestStatus = 'draft' | 'split' | 'cancelled';
export interface PurchaseRequest {
  id: string; org_id: string; number: number; status: RequestStatus;
  notes: string | null; expected_date: string | null; editor_step: 1 | 2 | 3;
  /** The draft's currency (0217). Every price in it is in this one. */
  currency: string;
  created_by: string | null; created_at: string; updated_at: string;
}
export interface PurchaseRequestItem {
  id: string; request_id: string; product_id: string; qty: number;
  recommended_supplier_id: string | null; chosen_supplier_id: string | null; unit_price: number | null;
  product?: Product;
}

export type PoStatus = 'draft' | 'ready' | 'sent' | 'confirmed' | 'partial' | 'received' | 'cancelled';
export interface PurchaseOrder {
  id: string; org_id: string; number: number; supplier_id: string; request_id: string | null;
  status: PoStatus; expected_date: string | null; notes: string | null;
  /**
   * The currency every price on the order is quoted in (0217). The line snapshots in
   * `purchase_order_items.unit_price` are taken in it, so the order total is in it too.
   */
  currency: string;
  created_by: string | null; sent_at: string | null; created_at: string;
  confirmed_at: string | null; confirmation_note: string | null;
  /** 1 for an order created directly; n+1 for a revision created from a supplier proposal (0167). */
  revision_number: number;
  revised_from_order_id: string | null;
}

/** One supplier-portal link (0167). token_hash is column-revoked and never reaches the browser. */
export interface SupplierOrderLink {
  id: string; org_id: string; purchase_order_id: string; supplier_id: string;
  expires_at: string; issued_by: string;
  opened_at: string | null; open_count: number; submitted_at: string | null;
  revoked_at: string | null; revoked_by: string | null; revoked_reason: string | null;
  failed_attempts: number; locked_until: string | null;
  created_at: string; updated_at: string;
}

export type SupplierProposalStatus = 'submitted' | 'accepted' | 'partially_accepted' | 'rejected';

/** A supplier's structured response to one order (0167) — immutable evidence plus the decision. */
export interface SupplierOrderProposal {
  id: string; org_id: string; link_id: string; purchase_order_id: string; supplier_id: string;
  status: SupplierProposalStatus;
  proposed_delivery_date: string | null; supplier_note: string | null;
  total_delta: number; submitted_at: string;
  decided_at: string | null; decided_by: string | null; decision_reason: string | null;
  delivery_date_accepted: boolean | null; revision_order_id: string | null;
  created_at: string;
}

export interface SupplierOrderProposalLine {
  id: string; org_id: string; proposal_id: string; order_item_id: string; position: number;
  product_name: string; unit: string | null;
  original_qty: number; proposed_qty: number | null;
  original_unit_price: number; proposed_unit_price: number | null;
  availability: 'available' | 'unavailable'; replacement_note: string | null;
  line_delta: number; decision: 'pending' | 'accepted' | 'rejected';
  created_at: string;
}
export interface PurchaseOrderItem {
  id: string; order_id: string; product_id: string; qty: number; unit_price: number; received_qty: number;
}

export type ReceiptLineStatus = 'full' | 'partial' | 'missing' | 'damaged' | 'returned';
export interface GoodsReceipt {
  id: string; org_id: string; number: number; order_id: string; status: 'draft' | 'completed';
  received_by: string | null; received_at: string; notes: string | null;
  order?: PurchaseOrder; items?: GoodsReceiptItem[];
}
export interface GoodsReceiptItem {
  id: string; receipt_id: string; order_item_id: string; product_id: string;
  qty_received: number; status: ReceiptLineStatus; notes: string | null;
}

export type InvoiceReviewStatus = 'received' | 'in_review' | 'pending_approval' | 'approved' | 'investigation';
export type InvoicePaymentStatus = 'unpaid' | 'partial' | 'paid';
export type InvoiceExportStatus = 'not_sent' | 'sent';
export type InvoiceFinancialRole = 'payable' | 'supporting_evidence';
export interface Invoice {
  id: string; org_id: string; supplier_id: string; invoice_number: string;
  invoice_date: string; received_date: string; received_by: string | null;
  amount_before_vat: number; vat_amount: number; total_amount: number;
  /**
   * The currency this invoice was PRINTED in (0217, #277). Evidence, not a preference: the server
   * writes it from the recomputed assessment and never from a client payload.
   */
  currency: string;
  review_status: InvoiceReviewStatus; payment_status: InvoicePaymentStatus; export_status: InvoiceExportStatus;
  financial_role: InvoiceFinancialRole;
  notes: string | null; deleted_at: string | null; created_at: string;
  supplier?: Supplier;
}
/**
  * One row of `invoice_balances_by_currency` (0218). `balance` was renamed to
  * `balance_in_currency` on purpose: a field that keeps its name and changes its meaning is
  * exactly what a hand-written cast hides (plan §3.2).
  */
export interface InvoiceBalance {
  invoice_id: string; currency: string;
  total_amount: number; paid_amount: number; credited_amount: number; balance_in_currency: number;
}

/** One row of `supplier_balances_by_currency` (0218) — one per supplier AND currency. */
export interface SupplierBalance {
  supplier_id: string; currency: string;
  open_balance_in_currency: number; open_invoices: number;
}

/** An amount that carries its own unit. The only shape a money figure may travel in. */
export interface MoneyAmount { currency: string; amount: number }

export type CreditReason = 'missing' | 'damaged' | 'returned' | 'wrong_price' | 'duplicate_charge' | 'other';
export type CreditStatus = 'open' | 'requested' | 'received' | 'offset' | 'closed';
export interface CreditRequest {
  id: string; org_id: string; number: number; supplier_id: string;
  invoice_id: string | null; receipt_item_id: string | null;
  reason: CreditReason; amount: number; currency: string; status: CreditStatus; notes: string | null;
  created_by: string | null; created_at: string; resolved_at: string | null;
  supplier?: Supplier; invoice?: Invoice;
}

export type PaymentRequestStatus = 'draft' | 'pending_approval' | 'approved' | 'sent_for_execution' | 'executed' | 'matched' | 'investigation' | 'suspected_duplicate' | 'cancelled';
export interface PaymentRequest {
  id: string; org_id: string; unit_id: string | null; number: number; supplier_id: string; amount: number;
  /** The currency of the debt this request pays (0217). Every invoice under it is in this one. */
  currency: string;
  due_date: string | null; status: PaymentRequestStatus; notes: string | null;
  created_by: string | null; approved_by: string | null; approved_at: string | null;
  open_credit_override_total: number | null; open_credit_override_reason: string | null;
  open_credit_override_at: string | null;
  executor_notes: string | null; created_at: string;
  supplier?: Supplier;
}

export interface Payment {
  id: string; org_id: string; number: number; supplier_id: string; payment_request_id: string | null;
  amount: number; currency: string; paid_date: string; method: string | null; reference: string | null;
  /**
   * What actually left the bank account, when that was in a different currency from the debt
   * (0217, #286). Null for every payment made in the currency of its own debt — which is every
   * payment this product has recorded. The rate is settlement_amount / amount, derived on read.
   */
  settlement_amount: number | null; settlement_currency: string | null;
  executed_by: string | null; notes: string | null; created_at: string;
  supplier?: Supplier;
}

export type BankTxStatus = 'unmatched' | 'suggested' | 'matched' | 'ignored';
export interface BankImport {
  id: string; org_id: string; filename: string; file_hash: string;
  column_mapping: Record<string, string>; row_count: number; imported_at: string;
  /** The statement's currency (0217). A statement is a document of one account. */
  currency: string;
}
export interface BankTransaction {
  id: string; org_id: string; import_id: string; tx_date: string; description: string;
  amount: number; currency: string; is_debit: boolean; reference: string | null; raw: Record<string, unknown>;
  supplier_id: string | null; status: BankTxStatus; row_hash: string;
  supplier?: Supplier;
}
export interface BankAllocation {
  id: string; bank_transaction_id: string; invoice_id: string | null; payment_id: string | null;
  amount: number; currency: string; confidence: number | null; confirmed: boolean;
}

export type ExceptionType = 'payment_without_invoice' | 'invoice_without_payment' | 'amount_mismatch' | 'duplicate_payment' | 'duplicate_invoice' | 'unknown_supplier' | 'unmatched_bank' | 'credit_not_deducted' | 'receipt_mismatch';
export type ExceptionStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export interface ExceptionRow {
  id: string; org_id: string; type: ExceptionType; severity: 'low' | 'medium' | 'high';
  status: ExceptionStatus; title: string; details: Record<string, unknown> | null;
  supplier_id: string | null; invoice_id: string | null; payment_id: string | null;
  payment_request_id: string | null; bank_transaction_id: string | null;
  assigned_role: Role | null; created_at: string; resolved_at: string | null; resolution_note: string | null;
  supplier?: Supplier;
}

// `credit` rather than `credit_note` is deliberate and pre-dates the interpretation contract:
// 0084:14-17 is the bridge that translates between the two spellings. `tax_receipt` is spelled
// the same on both sides and so needs no entry there.
export type DocumentKind = 'invoice' | 'delivery_note' | 'credit' | 'quote' | 'price_list' | 'payment_confirmation' | 'tax_receipt' | 'other';
export interface DocumentRow {
  id: string; org_id: string; entity_type: string;
  // null for exactly two entity_types, and they mean opposite things: 'inbox' is *not yet*
  // filed (0014), 'archive' is *decided to have no target* (0075). Every business entity_type
  // still carries its id — documents_inbox_entity enforces that, and 0075 narrowed it to admit
  // the archive rather than dropping it.
  entity_id: string | null;
  storage_path: string; file_name: string; mime_type: string | null;
  document_kind: DocumentKind; supplier_id: string | null; document_date: string | null;
  uploaded_by: string | null; created_at: string;
  deleted_at: string | null; deleted_by: string | null; // 0010 — soft delete; the stored file is kept
}

export type DocumentProcessingStatus =
  | 'awaiting_scan'
  | 'queued'
  | 'leased'
  | 'extracted'
  | 'interpreting'
  | 'review'
  | 'completed'
  | 'failed';

export type DocumentScanCornersSource = 'automatic' | 'manual' | 'full_frame_fallback';

export type ExtractionBlockType = 'text' | 'heading' | 'table' | 'image' | 'handwriting';
export type ExtractionMarkKind = 'circle' | 'check' | 'cross' | 'underline' | 'star' | 'custom' | 'unknown';
export type ExtractionBoundingBox = [xMin: number, yMin: number, xMax: number, yMax: number];

export type ExtractionContract = {
  schema_version: '1';
  document: {
    page_count: number;
    detected_languages: string[];
    plain_text: string;
    partial: boolean;
  };
  blocks: Array<{
    id: string;
    page: number;
    type: ExtractionBlockType;
    bbox: ExtractionBoundingBox;
    text: string;
    confidence: number | null;
  }>;
  tables: Array<{
    id: string;
    page: number;
    bbox: ExtractionBoundingBox;
    rows: Array<Array<{ text: string; bbox: ExtractionBoundingBox | null }>>;
  }>;
  marks: Array<{
    id: string;
    page: number;
    kind: ExtractionMarkKind;
    bbox: ExtractionBoundingBox;
    nearby_block_ids: string[];
    confidence: number | null;
    fingerprint: string | null;
  }>;
};

export interface DocumentProcessingJob {
  id: string;
  org_id: string;
  document_id: string;
  requested_by: string;
  status: DocumentProcessingStatus;
  input_checksum: string;
  contract_version: string;
  priority: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_until: string | null;
  processing_attempt_id: string | null;
  processing_attempt_started_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  scan_output_id?: string | null;
  /** Server-evaluated health fields returned by get_document_processing_statuses. */
  queue_age_seconds?: number | null;
  is_stuck?: boolean | null;
  stuck_reason?: string | null;
  /**
   * Pages transcribed so far in the attempt that is running right now, or null.
   *
   * Null is the common case and is not a defect: a job that is not leased, a worker that predates
   * the telemetry, and a page that has not finished yet all report nothing. The screen must render
   * that as an unknown, never as zero -- 0140's read model already refuses to return a stale
   * attempt's counters, so a number here is always about work in flight.
   */
  progress_done?: number | null;
  progress_total?: number | null;
}

export interface DocumentExtraction {
  id: string;
  org_id: string;
  job_id: string;
  document_id: string;
  engine: string;
  model: string;
  model_version: string;
  input_checksum: string;
  contract_version: string;
  payload: ExtractionContract;
  duration_ms: number | null;
  resource_metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditLog {
  id: string; org_id: string | null; user_id: string | null; action: string;
  entity_type: string; entity_id: string | null;
  old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null;
  reason: string | null; created_at: string;
  scope_domain?: 'financial_accounting' | 'organization_identity_platform';
  scope_class?: 'legal_entity' | 'cross_scope';
  legal_entity_id?: string | null;
}

export interface MonthlyExport {
  id: string; org_id: string; month: string; status: 'open' | 'sent';
  sent_at: string | null; sent_by: string | null; notes: string | null;
}
