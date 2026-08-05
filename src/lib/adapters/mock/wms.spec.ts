import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../types';
import { MockWmsAdapter } from './wms';

const ORG = '11111111-1111-4111-8111-111111111111';

function expectOk<T>(result: AdapterResult<T>): Extract<AdapterResult<T>, { status: 'ok' }> {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
}

describe('MockWmsAdapter', () => {
  it('syncs warehouses only — any other unit type is an honest failure', async () => {
    const adapter = new MockWmsAdapter(ORG);
    const warehouse = expectOk(
      await adapter.syncWarehouse({
        id: 'unit-2',
        name: 'מחסן ראשי',
        unitType: 'warehouse',
        parentId: 'unit-1',
      }),
    );
    expect(warehouse.reference?.entityType).toBe('warehouse');
    const branch = await adapter.syncWarehouse({
      id: 'unit-1',
      name: 'סניף ראשי',
      unitType: 'branch',
      parentId: null,
    });
    expect(branch).toMatchObject({
      status: 'failed',
      error: { code: 'wms_not_a_warehouse', retryable: false },
    });
  });

  it('pushes receipts and inventory events under their own entity types', async () => {
    const adapter = new MockWmsAdapter(ORG);
    expect(
      expectOk(
        await adapter.pushGoodsReceipt({
          id: 'gr-1',
          orderId: 'po-1',
          receivedAt: '2026-08-05T08:00:00Z',
          lines: [{ orderItemId: 'poi-1', qtyReceived: 6, status: 'partial' }],
        }),
      ).reference?.entityType,
    ).toBe('goods_receipt');
    expect(
      expectOk(
        await adapter.pushInventoryEvent({
          id: 'im-1',
          warehouseUnitId: 'unit-2',
          productId: 'prod-1',
          movementType: 'receipt',
          qty: 6,
          occurredAt: '2026-08-05T08:05:00Z',
        }),
      ).reference?.entityType,
    ).toBe('inventory_event');
  });

  it('round-trips external ids and honors injected failure and conflict', async () => {
    const adapter = new MockWmsAdapter(ORG);
    const pushed = expectOk(
      await adapter.pushInventoryEvent({
        id: 'im-1',
        warehouseUnitId: 'unit-2',
        productId: 'prod-1',
        movementType: 'receipt',
        qty: 6,
        occurredAt: '2026-08-05T08:05:00Z',
      }),
    );
    const found = expectOk(
      await adapter.resolveExternalId('inventory_event', pushed.reference?.externalId ?? ''),
    );
    expect(found.value).toEqual(pushed.reference);

    adapter.injectFailure({ code: 'wms_unreachable' });
    const failed = await adapter.pushInventoryEvent({
      id: 'im-2',
      warehouseUnitId: 'unit-2',
      productId: 'prod-1',
      movementType: 'issue',
      qty: 1,
      occurredAt: '2026-08-05T09:00:00Z',
    });
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'wms_unreachable' } });

    adapter.injectConflict('local_wins');
    const conflicted = await adapter.pushGoodsReceipt({
      id: 'gr-2',
      orderId: 'po-1',
      receivedAt: '2026-08-05T10:00:00Z',
      lines: [],
    });
    expect(conflicted).toMatchObject({ status: 'conflict', suggestedResolution: 'local_wins' });
    const status = await adapter.retrieveSyncStatus();
    expect(status.failedCount).toBe(2);
  });
});
