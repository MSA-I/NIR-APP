// Row types matching supabase/migrations/0001_init.sql (hand-maintained, pragmatic subset)

export type Role = 'owner' | 'kitchen' | 'office' | 'payer' | 'accountant' | 'supplier';

export interface Profile {
  id: string;
  org_id: string;
  full_name: string;
  role: Role;
  phone: string | null;
  active: boolean;
  supplier_id: string | null; // set only for supplier agent logins
}

export type OrgStatus = 'trial' | 'active' | 'suspended';

export interface Organization {
  id: string;
  name: string;
  vat_rate: number;
  status: OrgStatus;
  trial_ends_at: string | null;
  settings: {
    bank_match_days: number;
    bank_match_amount_tolerance: number;
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
  trial_ends_at: string | null;
  created_at: string;
  user_count: number;
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
  open_credits_amount: number;
  credits_window: number;
  credits_lifetime: number;
  priced_items: number;
  price_changes_window: number;
  last_price_change: string | null;
}

export type SearchEntity = 'supplier' | 'product' | 'invoice' | 'order' | 'payment' | 'credit';

/** One row of the global_search() RPC (migration 0011). */
export interface SearchHit {
  entity: SearchEntity;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  amount: number | null;
  occurred_at: string | null;
  rank: number;
}

export interface Category { id: string; org_id: string; name: string; sort: number }

export type SupplierStatus = 'active' | 'inactive' | 'problematic' | 'pending';
export interface Supplier {
  id: string; org_id: string; name: string;
  tax_id: string | null; contact_name: string | null; phone: string | null;
  whatsapp: string | null; email: string | null; address: string | null;
  delivery_days: number[]; cutoff_time: string | null;
  min_order_amount: number | null; payment_terms: string | null;
  bank_details: string | null; notes: string | null;
  status: SupplierStatus; deleted_at: string | null;
}

export interface Product {
  id: string; org_id: string; name: string; category_id: string | null;
  unit: string; sku: string | null; barcode: string | null; notes: string | null;
  active: boolean; min_stock: number | null;
  category?: { id: string; name: string } | null;
}

export interface SupplierProduct {
  id: string; org_id: string; supplier_id: string; product_id: string;
  current_price: number; previous_price: number | null; price_effective_date: string;
  available: boolean; supplier_sku: string | null; min_qty: number | null;
  package_size: number | null; updated_at: string;
  supplier?: Supplier; product?: Product;
}

export interface PriceHistory { id: string; supplier_product_id: string; price: number; effective_date: string }

export type SupplierPriceSubmissionStatus = 'accepted' | 'accepted_with_rejections' | 'rejected';
export interface SupplierPriceRejection {
  row: number;
  product?: string | null;
  reason: 'unknown_product' | 'invalid_price' | 'duplicate_product' | 'invalid_row';
  message: string;
}
export interface SupplierPriceSubmission {
  id: string; org_id: string; supplier_id: string; target_month: string; revision: number;
  file_name: string; storage_path: string; file_checksum: string;
  status: SupplierPriceSubmissionStatus;
  accepted_count: number; rejected_count: number; unchanged_count: number;
  rejections: SupplierPriceRejection[];
  submitted_by: string; submitted_at: string; processed_at: string;
}

export type RequestStatus = 'draft' | 'split' | 'cancelled';
export interface PurchaseRequest {
  id: string; org_id: string; number: number; status: RequestStatus;
  notes: string | null; expected_date: string | null; editor_step: 1 | 2;
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
  created_by: string | null; sent_at: string | null; created_at: string;
  confirmed_at: string | null; confirmation_note: string | null;
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
export interface Invoice {
  id: string; org_id: string; supplier_id: string; invoice_number: string;
  invoice_date: string; received_date: string; received_by: string | null;
  amount_before_vat: number; vat_amount: number; total_amount: number;
  review_status: InvoiceReviewStatus; payment_status: InvoicePaymentStatus; export_status: InvoiceExportStatus;
  notes: string | null; deleted_at: string | null; created_at: string;
  supplier?: Supplier;
}
export interface InvoiceBalance { invoice_id: string; total_amount: number; paid_amount: number; credited_amount: number; balance: number }

export type CreditReason = 'missing' | 'damaged' | 'returned' | 'wrong_price' | 'duplicate_charge' | 'other';
export type CreditStatus = 'open' | 'requested' | 'received' | 'offset' | 'closed';
export interface CreditRequest {
  id: string; org_id: string; number: number; supplier_id: string;
  invoice_id: string | null; receipt_item_id: string | null;
  reason: CreditReason; amount: number; status: CreditStatus; notes: string | null;
  created_by: string | null; created_at: string; resolved_at: string | null;
  supplier?: Supplier; invoice?: Invoice;
}

export type PaymentRequestStatus = 'draft' | 'pending_approval' | 'approved' | 'sent_for_execution' | 'executed' | 'matched' | 'investigation' | 'suspected_duplicate' | 'cancelled';
export interface PaymentRequest {
  id: string; org_id: string; number: number; supplier_id: string; amount: number;
  due_date: string | null; status: PaymentRequestStatus; notes: string | null;
  created_by: string | null; approved_by: string | null; approved_at: string | null;
  executor_notes: string | null; created_at: string;
  supplier?: Supplier;
}

export interface Payment {
  id: string; org_id: string; number: number; supplier_id: string; payment_request_id: string | null;
  amount: number; paid_date: string; method: string | null; reference: string | null;
  executed_by: string | null; notes: string | null; created_at: string;
  supplier?: Supplier;
}

export type BankTxStatus = 'unmatched' | 'suggested' | 'matched' | 'ignored';
export interface BankImport {
  id: string; org_id: string; filename: string; file_hash: string;
  column_mapping: Record<string, string>; row_count: number; imported_at: string;
}
export interface BankTransaction {
  id: string; org_id: string; import_id: string; tx_date: string; description: string;
  amount: number; is_debit: boolean; reference: string | null; raw: Record<string, string>;
  supplier_id: string | null; status: BankTxStatus; row_hash: string;
  supplier?: Supplier;
}
export interface BankAllocation {
  id: string; bank_transaction_id: string; invoice_id: string | null; payment_id: string | null;
  amount: number; confidence: number | null; confirmed: boolean;
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

export type DocumentKind = 'invoice' | 'delivery_note' | 'credit' | 'quote' | 'payment_confirmation' | 'other';
export interface DocumentRow {
  id: string; org_id: string; entity_type: string;
  entity_id: string | null; // null only while entity_type='inbox' — captured, not yet filed (0014)
  storage_path: string; file_name: string; mime_type: string | null;
  document_kind: DocumentKind; supplier_id: string | null; document_date: string | null;
  uploaded_by: string | null; created_at: string;
  deleted_at: string | null; deleted_by: string | null; // 0010 — soft delete; the stored file is kept
}

export interface AuditLog {
  id: string; org_id: string | null; user_id: string | null; action: string;
  entity_type: string; entity_id: string | null;
  old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null;
  reason: string | null; created_at: string;
}

export interface MonthlyExport {
  id: string; org_id: string; month: string; status: 'open' | 'sent';
  sent_at: string | null; sent_by: string | null; notes: string | null;
}
