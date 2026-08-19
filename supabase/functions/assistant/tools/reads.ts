// The bounded, projected reads the deterministic business tools need beyond rpc(). Every method
// runs under the CALLER's JWT so RLS and unit scope stay the boundary, projects explicit columns
// (never select('*'), and never a supplier's bank_details), and fetches limit+1 rows instead of
// count:'exact' so has_more is honest without the exact-count cost DEBT-REGISTER §15 names.
import type { ToolDataPort, ToolRpcResult } from "./registry.ts";

export interface ReadError {
  message: string;
}

export interface RowsResult<T> {
  rows: T[] | null;
  /** True when the underlying read returned more rows than the requested limit. */
  hasMore: boolean;
  error: ReadError | null;
}

export interface SentOrderRow {
  id: string;
  number: number;
  status: string;
  expected_date: string | null;
  sent_at: string | null;
  created_at: string;
  supplier_id: string;
  suppliers: { name: string } | null;
  purchase_order_items: { qty: number; unit_price: number }[];
}

export interface BankTransactionRow {
  id: string;
  tx_date: string;
  description: string;
  amount: number;
  is_debit: boolean;
  status: string;
}

export interface SupplierMetricsRow {
  supplier_id: string;
  open_orders: number;
  late_open_orders: number;
  otd_samples: number;
  otd_on_time: number;
  on_time_pct: number | null;
  lead_samples: number;
  avg_lead_days: number | null;
  open_exceptions: number;
  open_credits: number;
  open_credits_amount: number;
  price_changes_window: number;
  last_price_change: string | null;
}

export interface SupplierNameRow {
  id: string;
  name: string;
}

export interface SupplierOpenCreditsRow {
  supplier_id: string;
  open_credits: number;
  open_credits_amount: number;
}

export interface InventoryRiskRow {
  product_id: string;
  product_name: string;
  unit: string;
  min_stock: number | null;
  quantity_on_hand: number | null;
  is_counted: boolean;
  last_counted_at: string | null;
  consumption_sample_count: number | null;
  average_daily_consumption: number | null;
  projected_stockout_days: number | null;
  suggested_reorder_quantity: number | null;
  expected_incoming_quantity: number;
  incoming_without_date_quantity: number;
  next_expected_incoming_date: string | null;
}

/**
 * The full data surface of the deterministic tools. index.ts constructs it with
 * createSupabaseToolReads(callerClient); tests hand in fakes. Tools that receive a narrower port
 * refuse with a named failure instead of crashing -- see hasToolReads().
 */
export interface ToolReads extends ToolDataPort {
  listSentOrders(limit: number): Promise<RowsResult<SentOrderRow>>;
  listUnmatchedBankTransactions(
    limit: number,
  ): Promise<RowsResult<BankTransactionRow>>;
  listSupplierMetrics(limit: number): Promise<RowsResult<SupplierMetricsRow>>;
  listSupplierNames(
    ids: readonly string[],
  ): Promise<{ rows: SupplierNameRow[] | null; error: ReadError | null }>;
  /** supplier_metrics rows filtered to open_credits > 0 -- the per-supplier credit exposure. */
  listSupplierOpenCredits(
    limit: number,
  ): Promise<RowsResult<SupplierOpenCreditsRow>>;
  listInventoryRisk(limit: number): Promise<RowsResult<InventoryRiskRow>>;
}

const READ_METHODS = [
  "listSentOrders",
  "listUnmatchedBankTransactions",
  "listSupplierMetrics",
  "listSupplierNames",
  "listSupplierOpenCredits",
  "listInventoryRisk",
] as const;

export function hasToolReads(db: ToolDataPort): db is ToolReads {
  return READ_METHODS.every((method) =>
    typeof (db as unknown as Record<string, unknown>)[method] === "function"
  );
}

/* ============================================================================
 * Supabase-backed implementation over a minimal structural client
 * ==========================================================================*/

interface QueryResult {
  data: unknown[] | null;
  error: ReadError | null;
}

/** The slice of a PostgREST filter builder these reads use. supabase-js satisfies it. */
export interface MinimalFilterBuilder extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): MinimalFilterBuilder;
  in(column: string, values: readonly unknown[]): MinimalFilterBuilder;
  gt(column: string, value: unknown): MinimalFilterBuilder;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): MinimalFilterBuilder;
  limit(count: number): MinimalFilterBuilder;
}

export interface MinimalReadClient {
  from(table: string): {
    select(columns: string): MinimalFilterBuilder;
  };
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: ReadError | null }>;
}

// Explicit projections, named once. The suppliers projection is id+name only -- bank_details is
// classified bank_restricted and must never enter a tool result even masked; contact columns are
// personal_contact and equally out.
const SENT_ORDER_COLUMNS =
  "id, number, status, expected_date, sent_at, created_at, supplier_id, " +
  "suppliers(name), purchase_order_items(qty, unit_price)";
const BANK_TX_COLUMNS = "id, tx_date, description, amount, is_debit, status";
const SUPPLIER_METRICS_COLUMNS =
  "supplier_id, open_orders, late_open_orders, otd_samples, otd_on_time, on_time_pct, " +
  "lead_samples, avg_lead_days, open_exceptions, open_credits, open_credits_amount, " +
  "price_changes_window, last_price_change";
const SUPPLIER_NAME_COLUMNS = "id, name";
const SUPPLIER_OPEN_CREDITS_COLUMNS =
  "supplier_id, open_credits, open_credits_amount";
const INVENTORY_RISK_COLUMNS =
  "product_id, product_name, unit, min_stock, quantity_on_hand, is_counted, last_counted_at, " +
  "consumption_sample_count, average_daily_consumption, projected_stockout_days, " +
  "suggested_reorder_quantity, expected_incoming_quantity, incoming_without_date_quantity, " +
  "next_expected_incoming_date";

export const TOOL_READ_PROJECTIONS = {
  sentOrders: SENT_ORDER_COLUMNS,
  bankTransactions: BANK_TX_COLUMNS,
  supplierMetrics: SUPPLIER_METRICS_COLUMNS,
  supplierNames: SUPPLIER_NAME_COLUMNS,
  supplierOpenCredits: SUPPLIER_OPEN_CREDITS_COLUMNS,
  inventoryRisk: INVENTORY_RISK_COLUMNS,
} as const;

function overfetch<T>(result: QueryResult, limit: number): RowsResult<T> {
  if (result.error) return { rows: null, hasMore: false, error: result.error };
  const rows = (result.data ?? []) as T[];
  return {
    rows: rows.slice(0, limit),
    hasMore: rows.length > limit,
    error: null,
  };
}

export function createSupabaseToolReads(client: MinimalReadClient): ToolReads {
  return {
    rpc(name: string, args?: Record<string, unknown>): Promise<ToolRpcResult> {
      return Promise.resolve(client.rpc(name, args)).then((result) => ({
        data: result.data,
        error: result.error,
      }));
    },

    async countSentOrders() {
      // Kept for registry compatibility; derived from the same projected read.
      const result = await this.listSentOrders(1);
      if (result.error) return { count: null, error: result.error };
      return { count: result.rows?.length ?? 0, error: null };
    },

    async listSentOrders(limit) {
      const result = await client
        .from("purchase_orders")
        .select(SENT_ORDER_COLUMNS)
        .eq("status", "sent")
        // Oldest first: the operational question is which order has waited longest.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit + 1);
      return overfetch<SentOrderRow>(result, limit);
    },

    async listUnmatchedBankTransactions(limit) {
      const result = await client
        .from("bank_transactions")
        .select(BANK_TX_COLUMNS)
        .in("status", ["unmatched", "suggested"])
        .order("tx_date", { ascending: false })
        .order("id", { ascending: true })
        .limit(limit + 1);
      return overfetch<BankTransactionRow>(result, limit);
    },

    async listSupplierMetrics(limit) {
      const result = await client
        .from("supplier_metrics")
        .select(SUPPLIER_METRICS_COLUMNS)
        // Deterministic, not ranked: ordering by a metric would be the tool taking a ranking
        // decision the model is supposed to make from citable values.
        .order("supplier_id", { ascending: true })
        .limit(limit + 1);
      return overfetch<SupplierMetricsRow>(result, limit);
    },

    async listSupplierNames(ids) {
      if (ids.length === 0) return { rows: [], error: null };
      const result = await client
        .from("suppliers")
        .select(SUPPLIER_NAME_COLUMNS)
        .in("id", ids);
      if (result.error) return { rows: null, error: result.error };
      return { rows: (result.data ?? []) as SupplierNameRow[], error: null };
    },

    async listSupplierOpenCredits(limit) {
      const result = await client
        .from("supplier_metrics")
        .select(SUPPLIER_OPEN_CREDITS_COLUMNS)
        .gt("open_credits", 0)
        .order("supplier_id", { ascending: true })
        .limit(limit + 1);
      return overfetch<SupplierOpenCreditsRow>(result, limit);
    },

    async listInventoryRisk(limit) {
      const result = await client
        .from("inventory_intelligence")
        .select(INVENTORY_RISK_COLUMNS)
        // Closest stockout first; unmeasured rows sort last but are still returned, because
        // "not measured" is an answer the model must be able to state.
        .order("projected_stockout_days", { ascending: true, nullsFirst: false })
        .order("product_id", { ascending: true })
        .limit(limit + 1);
      return overfetch<InventoryRiskRow>(result, limit);
    },
  };
}
