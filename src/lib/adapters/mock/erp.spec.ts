import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../types';
import { MockErpAdapter } from './erp';

const ORG = '11111111-1111-4111-8111-111111111111';

function expectOk<T>(result: AdapterResult<T>): Extract<AdapterResult<T>, { status: 'ok' }> {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
}

describe('MockErpAdapter', () => {
  it('covers the §4 capability list under the right entity types', async () => {
    const adapter = new MockErpAdapter(ORG);
    expect(
      expectOk(
        await adapter.syncSupplier({ id: 'sup-1', name: 'ספק', taxId: null, active: true }),
      ).reference?.entityType,
    ).toBe('supplier');
    expect(
      expectOk(
        await adapter.syncProduct({
          id: 'prod-1',
          name: 'קמח',
          unit: 'ק"ג',
          categoryId: null,
          active: true,
        }),
      ).reference?.entityType,
    ).toBe('product');
    expect(
      expectOk(
        await adapter.syncOrgUnit({
          id: 'unit-1',
          name: 'סניף ראשי',
          unitType: 'branch',
          parentId: null,
        }),
      ).reference?.entityType,
    ).toBe('branch');
    expect(
      expectOk(
        await adapter.syncOrgUnit({
          id: 'unit-2',
          name: 'מחסן ראשי',
          unitType: 'warehouse',
          parentId: 'unit-1',
        }),
      ).reference?.entityType,
    ).toBe('warehouse');
    expect(
      expectOk(
        await adapter.pushPurchaseOrder({
          id: 'po-1',
          number: 'PO-1001',
          supplierId: 'sup-1',
          status: 'sent',
          expectedDate: null,
          lines: [{ productId: 'prod-1', qty: 10, unitPrice: 12.5 }],
        }),
      ).reference?.entityType,
    ).toBe('purchase_order');
    expect(
      expectOk(
        await adapter.pushGoodsReceipt({
          id: 'gr-1',
          orderId: 'po-1',
          receivedAt: '2026-08-05T08:00:00Z',
          lines: [{ orderItemId: 'poi-1', qtyReceived: 10, status: 'full' }],
        }),
      ).reference?.entityType,
    ).toBe('goods_receipt');
  });

  it('resolveExternalId round-trips a synced entity and answers null for a stranger', async () => {
    const adapter = new MockErpAdapter(ORG);
    const synced = expectOk(
      await adapter.syncSupplier({ id: 'sup-1', name: 'ספק', taxId: null, active: true }),
    );
    const found = expectOk(
      await adapter.resolveExternalId('supplier', synced.reference?.externalId ?? ''),
    );
    expect(found.value).toEqual(synced.reference);
    const unknown = expectOk(await adapter.resolveExternalId('supplier', 'no-such-id'));
    expect(unknown.value).toBeNull();
  });

  it('injected conflict resolves through resolveConflict once settled', async () => {
    const adapter = new MockErpAdapter(ORG);
    const synced = expectOk(
      await adapter.syncSupplier({ id: 'sup-1', name: 'ספק', taxId: null, active: true }),
    );
    adapter.injectConflict('manual_review');
    const conflicted = await adapter.syncSupplier({
      id: 'sup-1',
      name: 'ספק בשם אחר',
      taxId: null,
      active: true,
    });
    expect(conflicted.status).toBe('conflict');
    if (conflicted.status !== 'conflict') throw new Error('unreachable');
    expect(conflicted.suggestedResolution).toBe('manual_review');
    const settled = expectOk(
      await adapter.resolveConflict(synced.reference!, 'local_wins'),
    );
    expect(settled.reference).toEqual(synced.reference);
  });

  it('an injected failure surfaces exactly once', async () => {
    const adapter = new MockErpAdapter(ORG);
    adapter.injectFailure({ code: 'erp_timeout' });
    const failed = await adapter.syncProduct({
      id: 'prod-1',
      name: 'קמח',
      unit: 'ק"ג',
      categoryId: null,
      active: true,
    });
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'erp_timeout' } });
    expectOk(
      await adapter.syncProduct({
        id: 'prod-1',
        name: 'קמח',
        unit: 'ק"ג',
        categoryId: null,
        active: true,
      }),
    );
  });
});
