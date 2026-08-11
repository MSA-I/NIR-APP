/**
 * Every supplier column a client may read, named once.
 *
 * `select('*')` against `suppliers` returns **HTTP 403** since migration 0112. PostgREST expands
 * `*` to every column, `bank_details` is no longer selectable by any client role — a column
 * privilege, which is the only thing that can hide a column, because RLS cannot — and PostgreSQL
 * refuses the whole statement rather than the one column.
 *
 * That failure is silent in development and loud in the wrong place: it surfaced as three browser
 * scenarios timing out on "main heading did not become visible", twenty minutes into CI, with the
 * 403 buried in a network log. So the list lives here, `check:supplier-columns` fails the build on
 * any new `select('*')` against this table, and a column added later has exactly one place to be
 * added to.
 *
 * `bank_details` is deliberately absent and must never be added. It is read through
 * `financial_supplier_directory` (see `src/lib/financialSuppliers.ts`), which carries its own role
 * predicate, and written through `update_supplier_bank_details`, which requires a reason.
 */
// A single literal, not a joined array: supabase-js parses the select string at the TYPE
// level, and a runtime-built string collapses the row type to GenericStringError[].
export const SUPPLIER_COLUMNS =
  'id, org_id, name, tax_id, contact_name, phone, whatsapp, email, address, delivery_days, cutoff_time, min_order_amount, payment_terms, notes, status, deleted_at, created_at, updated_at, rating, rating_updated_at, rating_note, preferred' as const;
