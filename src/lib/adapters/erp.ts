/**
 * ErpAdapter — the vendor-neutral ERP interface (INTEGRATION-ARCHITECTURE.md §4:85-89,
 * wave 7).
 *
 * ZERO IMPORTERS BY DESIGN (the flags.ts precedent): no consumer exists until a real ERP
 * provider ships in a later wave; the mock (./mock/erp.ts) and its spec keep the
 * contract honest on every gate. The surface is the §4 capability list, no more:
 * supplier / product / branch-and-warehouse sync, purchase orders, goods receipts,
 * external identifiers, conflict handling, and import/export status. Inventory events
 * belong to the WMS interface (./wms.ts) — the same §4 sentence covers both.
 *
 * The identity boundary (§4:91-92): every internal<->external pairing an adapter learns
 * is an `external_references` row. Adapters return the tuple; they never write columns
 * onto business tables.
 */
import type { SupplierSnapshot } from './accounting';
import type {
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from './types';

export type { SupplierSnapshot };

export interface ProductSnapshot {
  id: string;
  name: string;
  unit: string;
  categoryId: string | null;
  active: boolean;
}

/** A node of the 0054 unit chain — branches and warehouses both sync through this. */
export interface OrgUnitSnapshot {
  id: string;
  name: string;
  unitType: 'root' | 'legal_entity' | 'branch' | 'warehouse';
  parentId: string | null;
}

export interface PurchaseOrderSnapshot {
  id: string;
  number: string;
  supplierId: string;
  status: string;
  /** ISO date, or null when no delivery date was committed. */
  expectedDate: string | null;
  lines: Array<{
    productId: string;
    qty: number;
    unitPrice: number;
  }>;
}

export interface GoodsReceiptSnapshot {
  id: string;
  orderId: string;
  /** ISO timestamp. */
  receivedAt: string;
  lines: Array<{
    orderItemId: string;
    qtyReceived: number;
    status: string;
  }>;
}

export interface ErpAdapter {
  readonly provider: string;

  syncSupplier(supplier: SupplierSnapshot): Promise<AdapterResult<ExternalReference>>;

  syncProduct(product: ProductSnapshot): Promise<AdapterResult<ExternalReference>>;

  /** Branches and warehouses (the §4 "סניפים ומחסנים" arm). */
  syncOrgUnit(unit: OrgUnitSnapshot): Promise<AdapterResult<ExternalReference>>;

  pushPurchaseOrder(order: PurchaseOrderSnapshot): Promise<AdapterResult<ExternalReference>>;

  pushGoodsReceipt(receipt: GoodsReceiptSnapshot): Promise<AdapterResult<ExternalReference>>;

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
