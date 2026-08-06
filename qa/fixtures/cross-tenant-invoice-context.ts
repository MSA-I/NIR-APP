import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertQaLockOwned, type QaLockHandle } from '../runner/lock.ts';

export const QA_FOREIGN_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
export const QA_FOREIGN_SUPPLIER_ID = 'a9000000-0000-4000-8000-000000000001';
export const QA_FOREIGN_ORDER_ID = 'd9000000-0000-4000-8000-000000000001';
export const QA_FOREIGN_RECEIPT_ID = 'e9000000-0000-4000-8000-000000000001';
export const QA_FOREIGN_SUPPLIER_NAME = 'ספק tenant-B שאסור לחשוף';

interface LocalServiceFixtureOptions {
  readonly apiUrl: string;
  readonly serviceRoleKey: string;
  readonly lock: QaLockHandle;
}

const fixtureSignal = (): AbortSignal => AbortSignal.timeout(15_000);

function localServiceClient(options: LocalServiceFixtureOptions): SupabaseClient {
  if (new URL(options.apiUrl).origin !== 'http://127.0.0.1:55431' || !options.serviceRoleKey.trim()) {
    throw new Error('Cross-tenant QA fixture requires the isolated local service client.');
  }
  return createClient(options.apiUrl, options.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireSuccess(
  operation: PromiseLike<{ error: { message: string } | null }>,
  step: string,
): Promise<void> {
  const { error } = await operation;
  if (error) throw new Error(`Cross-tenant QA fixture failed during ${step}.`);
}

/**
 * Installs a minimal real order/receipt pair in the neutral baseline organization.
 * The browser roles belong to the demo organization, so RLS must make these stable IDs
 * indistinguishable from missing rows. The service credential remains inside setup code.
 */
export async function installCrossTenantInvoiceContextFixture(
  options: LocalServiceFixtureOptions,
): Promise<void> {
  const client = localServiceClient(options);
  await assertQaLockOwned(options.lock);
  const organization = await client.from('organizations').select('id')
    .eq('id', QA_FOREIGN_ORGANIZATION_ID).abortSignal(fixtureSignal()).maybeSingle();
  if (organization.error || !organization.data) {
    throw new Error('Cross-tenant QA fixture baseline organization is unavailable.');
  }

  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('suppliers').upsert({
    id: QA_FOREIGN_SUPPLIER_ID,
    org_id: QA_FOREIGN_ORGANIZATION_ID,
    name: QA_FOREIGN_SUPPLIER_NAME,
    status: 'active',
    deleted_at: null,
  }, { onConflict: 'id' }).abortSignal(fixtureSignal()), 'supplier insert');

  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('purchase_orders').upsert({
    id: QA_FOREIGN_ORDER_ID,
    org_id: QA_FOREIGN_ORGANIZATION_ID,
    supplier_id: QA_FOREIGN_SUPPLIER_ID,
    status: 'received',
    expected_date: '2026-06-02',
    notes: 'QA cross-tenant non-disclosure fixture',
    created_by: null,
  }, { onConflict: 'id' }).abortSignal(fixtureSignal()), 'purchase-order insert');

  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('goods_receipts').upsert({
    id: QA_FOREIGN_RECEIPT_ID,
    org_id: QA_FOREIGN_ORGANIZATION_ID,
    order_id: QA_FOREIGN_ORDER_ID,
    status: 'completed',
    received_by: null,
    received_at: '2026-06-02T04:30:00.000Z',
    notes: 'QA cross-tenant non-disclosure fixture',
  }, { onConflict: 'id' }).abortSignal(fixtureSignal()), 'goods-receipt insert');

  await assertQaLockOwned(options.lock);
  const proof = await client.from('goods_receipts').select('id, org_id, order_id')
    .eq('id', QA_FOREIGN_RECEIPT_ID).eq('org_id', QA_FOREIGN_ORGANIZATION_ID)
    .abortSignal(fixtureSignal()).maybeSingle();
  if (proof.error || proof.data?.order_id !== QA_FOREIGN_ORDER_ID) {
    throw new Error('Cross-tenant QA fixture could not verify the receipt boundary.');
  }
}

/** Cleanup is normally provided by the QA runner's verified full database reset. */
export async function removeCrossTenantInvoiceContextFixture(
  options: LocalServiceFixtureOptions,
): Promise<void> {
  const client = localServiceClient(options);
  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('goods_receipts').delete().eq('id', QA_FOREIGN_RECEIPT_ID)
    .eq('org_id', QA_FOREIGN_ORGANIZATION_ID).abortSignal(fixtureSignal()), 'goods-receipt cleanup');
  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('purchase_orders').delete().eq('id', QA_FOREIGN_ORDER_ID)
    .eq('org_id', QA_FOREIGN_ORGANIZATION_ID).abortSignal(fixtureSignal()), 'purchase-order cleanup');
  await assertQaLockOwned(options.lock);
  await requireSuccess(client.from('suppliers').delete().eq('id', QA_FOREIGN_SUPPLIER_ID)
    .eq('org_id', QA_FOREIGN_ORGANIZATION_ID).abortSignal(fixtureSignal()), 'supplier cleanup');
}
