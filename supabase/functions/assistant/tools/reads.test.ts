// The read port: explicit projections (never *, never bank_details or a contact column),
// honest has_more from limit+1 overfetch, and deterministic ordering arguments. Fakes only --
// no live database is touched anywhere in this file.
import assert from "node:assert/strict";
import {
  createSupabaseToolReads,
  hasToolReads,
  type MinimalFilterBuilder,
  type MinimalReadClient,
  TOOL_READ_PROJECTIONS,
} from "./reads.ts";

interface RecordedQuery {
  table: string;
  columns: string;
  filters: { method: string; args: unknown[] }[];
  orders: { column: string; options?: Record<string, unknown> }[];
  limit: number | null;
}

function fakeClient(rows: unknown[]): {
  client: MinimalReadClient;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client: MinimalReadClient = {
    from(table: string) {
      return {
        select(columns: string) {
          const query: RecordedQuery = {
            table,
            columns,
            filters: [],
            orders: [],
            limit: null,
          };
          queries.push(query);
          const builder: MinimalFilterBuilder = {
            eq(column, value) {
              query.filters.push({ method: "eq", args: [column, value] });
              return builder;
            },
            in(column, values) {
              query.filters.push({ method: "in", args: [column, values] });
              return builder;
            },
            gt(column, value) {
              query.filters.push({ method: "gt", args: [column, value] });
              return builder;
            },
            order(column, options) {
              query.orders.push({ column, options });
              return builder;
            },
            limit(count) {
              query.limit = count;
              return builder;
            },
            then(onFulfilled, onRejected) {
              return Promise.resolve({ data: rows, error: null }).then(
                onFulfilled,
                onRejected,
              );
            },
          };
          return builder;
        },
      };
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, queries };
}

Deno.test("every projection is explicit and never selects a forbidden column", () => {
  for (const [name, columns] of Object.entries(TOOL_READ_PROJECTIONS)) {
    assert.ok(!columns.includes("*"), `${name} projects *`);
    for (
      const forbidden of [
        "bank_details",
        "contact_name",
        "phone",
        "whatsapp",
        "email",
        "address",
        "raw",
        "reference",
      ]
    ) {
      assert.ok(
        !columns.includes(forbidden),
        `${name} projects forbidden column ${forbidden}`,
      );
    }
  }
});

Deno.test("has_more comes from the limit+1 overfetch and rows are sliced back", async () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `id-${index}`,
    tx_date: "2026-08-19",
    description: "d",
    amount: 1,
    is_debit: true,
    status: "unmatched",
  }));
  const { client, queries } = fakeClient(rows);
  const reads = createSupabaseToolReads(client);
  const result = await reads.listUnmatchedBankTransactions(3);
  assert.equal(result.error, null);
  assert.equal(result.rows?.length, 3);
  assert.equal(result.hasMore, true);
  assert.equal(queries[0].limit, 4);
});

Deno.test("bank transactions read only its projection with the two open statuses", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  const result = await reads.listUnmatchedBankTransactions(10);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.rows, []);
  const query = queries[0];
  assert.equal(query.table, "bank_transactions");
  assert.equal(query.columns, TOOL_READ_PROJECTIONS.bankTransactions);
  assert.deepEqual(query.filters, [{
    method: "in",
    args: ["status", ["unmatched", "suggested"]],
  }]);
  assert.deepEqual(query.orders.map((order) => order.column), [
    "tx_date",
    "id",
  ]);
});

Deno.test("sent orders filter on status='sent' and order oldest-first deterministically", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  await reads.listSentOrders(5);
  const query = queries[0];
  assert.equal(query.table, "purchase_orders");
  assert.equal(query.columns, TOOL_READ_PROJECTIONS.sentOrders);
  assert.deepEqual(query.filters, [{ method: "eq", args: ["status", "sent"] }]);
  assert.deepEqual(query.orders.map((order) => order.column), [
    "created_at",
    "id",
  ]);
  assert.equal(query.limit, 6);
});

Deno.test("supplier metrics order by supplier id -- the port never ranks", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  await reads.listSupplierMetrics(50);
  const query = queries[0];
  assert.equal(query.table, "supplier_metrics");
  assert.deepEqual(query.orders.map((order) => order.column), ["supplier_id"]);
});

Deno.test("supplier names take an id list and skip the query entirely when empty", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  const empty = await reads.listSupplierNames([]);
  assert.deepEqual(empty, { rows: [], error: null });
  assert.equal(queries.length, 0);
  await reads.listSupplierNames(["a", "b"]);
  assert.equal(queries[0].table, "suppliers");
  assert.equal(queries[0].columns, TOOL_READ_PROJECTIONS.supplierNames);
  assert.deepEqual(queries[0].filters, [{
    method: "in",
    args: ["id", ["a", "b"]],
  }]);
});

Deno.test("inventory risk sorts closest stockout first with unmeasured rows last", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  await reads.listInventoryRisk(20);
  const query = queries[0];
  assert.equal(query.table, "inventory_intelligence");
  assert.deepEqual(query.orders[0], {
    column: "projected_stockout_days",
    options: { ascending: true, nullsFirst: false },
  });
  assert.equal(query.orders[1].column, "product_id");
});

Deno.test("open-credit breakdown filters open_credits > 0 in the database, not in memory", async () => {
  const { client, queries } = fakeClient([]);
  const reads = createSupabaseToolReads(client);
  await reads.listSupplierOpenCredits(50);
  assert.deepEqual(queries[0].filters, [{
    method: "gt",
    args: ["open_credits", 0],
  }]);
});

Deno.test("the full port satisfies hasToolReads; a bare rpc port does not", () => {
  const { client } = fakeClient([]);
  assert.equal(hasToolReads(createSupabaseToolReads(client)), true);
  assert.equal(
    hasToolReads({
      rpc: () => Promise.resolve({ data: null, error: null }),
      countSentOrders: () => Promise.resolve({ count: null, error: null }),
    }),
    false,
  );
});
