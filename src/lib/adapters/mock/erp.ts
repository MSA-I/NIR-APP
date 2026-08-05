/**
 * MockErpAdapter (wave 7). ZERO IMPORTERS BY DESIGN outside the specs — the mock exists
 * so the ErpAdapter contract is exercised on every gate without a real provider
 * (INTEGRATION-ARCHITECTURE.md §4:81-82). Failures and conflicts are injected through
 * the shared harness.
 */
import type {
  ErpAdapter,
  GoodsReceiptSnapshot,
  OrgUnitSnapshot,
  ProductSnapshot,
  PurchaseOrderSnapshot,
  SupplierSnapshot,
} from '../erp';
import type {
  AdapterError,
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from '../types';
import { MockAdapterHarness } from './harness';

export class MockErpAdapter implements ErpAdapter {
  readonly provider = 'mock-erp';

  private readonly harness: MockAdapterHarness;

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

  private sync(entityType: string, internalId: string): Promise<AdapterResult<ExternalReference>> {
    const reference = this.harness.reference(entityType, internalId);
    return Promise.resolve(this.harness.run(() => reference, reference));
  }

  syncSupplier(supplier: SupplierSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('supplier', supplier.id);
  }

  syncProduct(product: ProductSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('product', product.id);
  }

  syncOrgUnit(unit: OrgUnitSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync(unit.unitType === 'warehouse' ? 'warehouse' : 'branch', unit.id);
  }

  pushPurchaseOrder(order: PurchaseOrderSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('purchase_order', order.id);
  }

  pushGoodsReceipt(receipt: GoodsReceiptSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('goods_receipt', receipt.id);
  }

  resolveExternalId(
    entityType: string,
    externalId: string,
  ): Promise<AdapterResult<ExternalReference | null>> {
    return Promise.resolve(
      this.harness.run(() => this.harness.findByExternalId(entityType, externalId)),
    );
  }

  resolveConflict(
    reference: ExternalReference,
    _resolution: ConflictResolution,
  ): Promise<AdapterResult<ExternalReference>> {
    return Promise.resolve(this.harness.run(() => reference, reference));
  }

  retrieveSyncStatus(): Promise<SyncStatus> {
    return Promise.resolve(this.harness.status());
  }
}
