/**
 * MockAccountingAdapter (wave 7). ZERO IMPORTERS BY DESIGN outside the specs — the mock
 * exists so the AccountingAdapter contract is exercised on every gate without a real
 * provider (INTEGRATION-ARCHITECTURE.md §4:81-82). Failures and conflicts are injected
 * through the shared harness.
 */
import type {
  AccountingAdapter,
  AccountMapping,
  CreditNoteSnapshot,
  PaymentSnapshot,
  RemotePaymentStatus,
  SupplierSnapshot,
  VendorInvoiceSnapshot,
} from '../accounting';
import type {
  AdapterError,
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from '../types';
import { MockAdapterHarness } from './harness';

export class MockAccountingAdapter implements AccountingAdapter {
  readonly provider = 'mock-accounting';

  private readonly harness: MockAdapterHarness;
  private readonly paymentStatuses = new Map<string, RemotePaymentStatus>();
  private readonly accountMappings = new Map<string, AccountMapping>();

  constructor(orgId: string) {
    this.harness = new MockAdapterHarness(orgId, this.provider);
  }

  /** The NEXT call fails once with this error, then the mock recovers. */
  injectFailure(error?: Partial<AdapterError>): void {
    this.harness.injectFailure(error);
  }

  /** The NEXT call reports a conflict once, then the mock recovers. */
  injectConflict(resolution?: ConflictResolution, error?: Partial<AdapterError>): void {
    this.harness.injectConflict(resolution, error);
  }

  /** Test hook: pre-register the provider-side ledger account for an entity. */
  setAccountMapping(mapping: AccountMapping): void {
    this.accountMappings.set(`${mapping.entityType}:${mapping.internalId}`, mapping);
  }

  private sync(entityType: string, internalId: string): Promise<AdapterResult<ExternalReference>> {
    const reference = this.harness.reference(entityType, internalId);
    return Promise.resolve(this.harness.run(() => reference, reference));
  }

  syncSupplier(supplier: SupplierSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('supplier', supplier.id);
  }

  postVendorInvoice(invoice: VendorInvoiceSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('invoice', invoice.id);
  }

  postCreditNote(creditNote: CreditNoteSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('credit_note', creditNote.id);
  }

  postPayment(payment: PaymentSnapshot): Promise<AdapterResult<ExternalReference>> {
    this.paymentStatuses.set(payment.id, 'posted');
    return this.sync('payment', payment.id);
  }

  updatePaymentStatus(
    paymentId: string,
    status: RemotePaymentStatus,
  ): Promise<AdapterResult<RemotePaymentStatus>> {
    return Promise.resolve(
      this.harness.run(() => {
        this.paymentStatuses.set(paymentId, status);
        return status;
      }),
    );
  }

  retrieveAccountMapping(
    entityType: string,
    internalId: string,
  ): Promise<AdapterResult<AccountMapping | null>> {
    return Promise.resolve(
      this.harness.run(() => this.accountMappings.get(`${entityType}:${internalId}`) ?? null),
    );
  }

  retrieveSyncStatus(): Promise<SyncStatus> {
    return Promise.resolve(this.harness.status());
  }
}
