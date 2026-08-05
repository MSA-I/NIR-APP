/**
 * AccountingAdapter — the vendor-neutral accounting interface
 * (INTEGRATION-ARCHITECTURE.md §4:84-85, wave 7).
 *
 * ZERO IMPORTERS BY DESIGN (the flags.ts precedent): no consumer exists until a real
 * accounting provider ships in a later wave. The seven methods below are EXACTLY the
 * seven the architecture document mandates — no invented surface. The mock
 * (./mock/accounting.ts) and its spec keep the contract honest on every gate.
 *
 * Snapshots, not live rows: an adapter receives an immutable projection of the business
 * entity at sync time. It never reads the database and never sees soft-deleted history —
 * the caller (a future sync worker consuming outbox events) owns selection and timing.
 */
import type { AdapterResult, ExternalReference, SyncStatus } from './types';

export interface SupplierSnapshot {
  id: string;
  name: string;
  taxId: string | null;
  active: boolean;
}

/** The provider-side ledger account an internal entity posts to. */
export interface AccountMapping {
  entityType: string;
  internalId: string;
  accountCode: string;
  accountName: string | null;
}

export interface VendorInvoiceSnapshot {
  id: string;
  supplierId: string;
  invoiceNumber: string;
  /** ISO date. */
  invoiceDate: string;
  totalAmount: number;
  currency: string;
}

export interface CreditNoteSnapshot {
  id: string;
  supplierId: string;
  invoiceId: string | null;
  amount: number;
  reason: string;
}

export interface PaymentSnapshot {
  id: string;
  supplierId: string;
  /** ISO date. */
  paidDate: string;
  amount: number;
  method: string;
  reference: string | null;
}

/** The provider's view of a posted payment's lifecycle. */
export type RemotePaymentStatus = 'pending' | 'posted' | 'reconciled' | 'cancelled';

/** The seven document-mandated methods (§4:84-85): syncSupplier, postVendorInvoice,
 * postCreditNote, postPayment, updatePaymentStatus, retrieveAccountMapping,
 * retrieveSyncStatus. */
export interface AccountingAdapter {
  readonly provider: string;

  syncSupplier(supplier: SupplierSnapshot): Promise<AdapterResult<ExternalReference>>;

  postVendorInvoice(invoice: VendorInvoiceSnapshot): Promise<AdapterResult<ExternalReference>>;

  postCreditNote(creditNote: CreditNoteSnapshot): Promise<AdapterResult<ExternalReference>>;

  postPayment(payment: PaymentSnapshot): Promise<AdapterResult<ExternalReference>>;

  updatePaymentStatus(
    paymentId: string,
    status: RemotePaymentStatus,
  ): Promise<AdapterResult<RemotePaymentStatus>>;

  /** The provider-side ledger account an internal entity posts to, or null when the
   * provider has no mapping — null is an answer, not an error. */
  retrieveAccountMapping(
    entityType: string,
    internalId: string,
  ): Promise<AdapterResult<AccountMapping | null>>;

  retrieveSyncStatus(): Promise<SyncStatus>;
}
