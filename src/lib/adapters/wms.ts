/**
 * WmsAdapter — the vendor-neutral warehouse-management interface
 * (INTEGRATION-ARCHITECTURE.md §4:85-89, wave 7).
 *
 * ZERO IMPORTERS BY DESIGN (the flags.ts precedent): no consumer exists until a real WMS
 * provider ships in a later wave; the mock (./mock/wms.ts) and its spec keep the
 * contract honest on every gate. The surface is the WMS slice of the §4 capability list:
 * warehouse sync, goods receipts, inventory events, external identifiers, conflict
 * handling, and import/export status. Catalog and procurement sync belong to the ERP
 * interface (./erp.ts).
 */
import type { GoodsReceiptSnapshot, OrgUnitSnapshot } from './erp';
import type {
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from './types';

export type { GoodsReceiptSnapshot, OrgUnitSnapshot };

/** One movement of the 0026 inventory ledger, projected for the provider. */
export interface InventoryEventSnapshot {
  id: string;
  warehouseUnitId: string | null;
  productId: string;
  movementType: string;
  qty: number;
  /** ISO timestamp. */
  occurredAt: string;
}

export interface WmsAdapter {
  readonly provider: string;

  /** Warehouses only — a WMS has no business with the rest of the unit chain. */
  syncWarehouse(unit: OrgUnitSnapshot): Promise<AdapterResult<ExternalReference>>;

  pushGoodsReceipt(receipt: GoodsReceiptSnapshot): Promise<AdapterResult<ExternalReference>>;

  pushInventoryEvent(event: InventoryEventSnapshot): Promise<AdapterResult<ExternalReference>>;

  /** Looks up which internal entity an external identity maps to, or null when the
   * provider row is unknown here — null is an answer, not an error. */
  resolveExternalId(
    entityType: string,
    externalId: string,
  ): Promise<AdapterResult<ExternalReference | null>>;

  /** Settles a previously reported conflict for one mapped entity. */
  resolveConflict(
    reference: ExternalReference,
    resolution: ConflictResolution,
  ): Promise<AdapterResult<ExternalReference>>;

  retrieveSyncStatus(): Promise<SyncStatus>;
}
