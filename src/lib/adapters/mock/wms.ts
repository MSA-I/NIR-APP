/**
 * MockWmsAdapter (wave 7). ZERO IMPORTERS BY DESIGN outside the specs — the mock exists
 * so the WmsAdapter contract is exercised on every gate without a real provider
 * (INTEGRATION-ARCHITECTURE.md §4:81-82). Failures and conflicts are injected through
 * the shared harness.
 */
import type {
  AdapterError,
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from '../types';
import type {
  GoodsReceiptSnapshot,
  InventoryEventSnapshot,
  OrgUnitSnapshot,
  WmsAdapter,
} from '../wms';
import { MockAdapterHarness } from './harness';

export class MockWmsAdapter implements WmsAdapter {
  readonly provider = 'mock-wms';

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

  syncWarehouse(unit: OrgUnitSnapshot): Promise<AdapterResult<ExternalReference>> {
    if (unit.unitType !== 'warehouse') {
      return Promise.resolve({
        status: 'failed',
        error: {
          code: 'wms_not_a_warehouse',
          message: `unit ${unit.id} is ${unit.unitType}, not a warehouse`,
          retryable: false,
        },
      });
    }
    return this.sync('warehouse', unit.id);
  }

  pushGoodsReceipt(receipt: GoodsReceiptSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('goods_receipt', receipt.id);
  }

  pushInventoryEvent(event: InventoryEventSnapshot): Promise<AdapterResult<ExternalReference>> {
    return this.sync('inventory_event', event.id);
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
