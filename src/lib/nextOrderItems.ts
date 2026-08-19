import type { Product } from './types';
import { supabase } from './supabase';
import { unwrap } from './useQuery';

export interface NextOrderItem {
  id: string;
  product_id: string;
  qty: number;
  source_request_id: string | null;
  created_at: string;
  product: Pick<Product, 'id' | 'name' | 'display_name' | 'unit' | 'active'>;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export async function listNextOrderItems(orgId: string): Promise<NextOrderItem[]> {
  const cutoff = new Date(Date.now() - NINETY_DAYS_MS).toISOString();
  return unwrap(await supabase.from('next_order_items')
    .select('id, product_id, qty, source_request_id, created_at, product:products!next_order_items_product_tenant_fk!inner(id, name, display_name, unit, active)')
    .eq('org_id', orgId)
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })) as NextOrderItem[];
}

export async function deferProduct(
  orgId: string,
  productId: string,
  qty: number,
  sourceRequestId: string | null,
): Promise<void> {
  unwrap(await supabase.from('next_order_items').upsert({
    org_id: orgId,
    product_id: productId,
    qty,
    source_request_id: sourceRequestId,
  }, { onConflict: 'user_id,product_id' }));
}

export async function dismissNextOrderItem(id: string): Promise<void> {
  unwrap(await supabase.from('next_order_items').delete().eq('id', id));
}
