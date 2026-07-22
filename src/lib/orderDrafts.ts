import { supabase } from './supabase';
import { unwrap } from './useQuery';

export const ORDER_DRAFT_FLUSH_EVENT = 'supplyflow:flush-order-draft';

export interface OrderDraftFlushDetail {
  pending: Promise<boolean>[];
}

export interface DraftItemInput {
  product_id: string;
  qty: number;
  chosen_supplier_id: string | null;
}

export interface SaveDraftInput {
  requestId: string | null;
  notes: string;
  expectedDate: string;
  editorStep: 1 | 2;
  items: DraftItemInput[];
}

export interface FinalizedDraft {
  request_id: string;
  order_ids: string[];
  order_count: number;
  total: number;
}

export async function saveOrderDraft(input: SaveDraftInput): Promise<{ request_id: string; updated_at: string }> {
  return unwrap(await supabase.rpc('save_purchase_request_draft', {
    p_request_id: input.requestId,
    p_notes: input.notes.trim() || null,
    p_expected_date: input.expectedDate || null,
    p_editor_step: input.editorStep,
    p_items: input.items,
  })) as { request_id: string; updated_at: string };
}

export async function cancelOrderDraft(requestId: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_purchase_request_draft', {
    p_request_id: requestId,
    p_reason: reason.trim(),
  }));
}

export async function finalizeOrderDraft(requestId: string, expectedTotal: number): Promise<FinalizedDraft> {
  return unwrap(await supabase.rpc('finalize_purchase_request_draft', {
    p_request_id: requestId,
    p_expected_total: expectedTotal,
  })) as FinalizedDraft;
}
