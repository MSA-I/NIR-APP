/**
 * Every column of the two account tables a client may read, named once.
 *
 * `profiles` and `organizations` were both read with `select('*')` — the account bootstrap on
 * every sign-in, and the settings roster on every visit. `*` is not a shorthand for "the columns
 * this screen renders"; it is a request for **every column the table will ever have**, and
 * PostgREST answers it in full. Measured against production on 05.09.2026 with a real read as
 * each role: office and accountant received all six colleague rows including five phone numbers,
 * the whole `organizations` row, and — because `*` cannot know what it is asking for —
 * `profiles.backup_email`, the address a person nominates so they can get their ACCOUNT BACK.
 *
 * So the lists live here, and they are exactly the fields `Profile` and `Organization` declare in
 * `./types`. Two columns that exist in the database are deliberately absent from
 * `ORGANIZATION_COLUMNS` — `created_at` and `trial_ends_at` — because no tenant screen renders
 * either; an operator reads them through the platform RPCs in `./platform`, which are
 * `SECURITY DEFINER` and carry their own operator predicate. `profiles.backup_email` is absent for
 * the same reason: the only screen that needs it is the person's own, and `my_backup_email()`
 * (migration 0255) answers that for the caller alone.
 *
 * `check:profile-columns` fails the build on any new `select('*')` against either table, because
 * the failure this prevents is invisible where it is written: once a column privilege is revoked,
 * PostgREST's `*` expansion asks for a column the client role may not read and PostgreSQL refuses
 * the WHOLE statement — the sibling case is `suppliers.bank_details` and
 * `src/lib/supplierColumns.ts`, where it surfaced as three browser scenarios timing out on a
 * missing heading twenty minutes into CI.
 */
// A single literal each, not a joined array: supabase-js parses the select string at the TYPE
// level, and a runtime-built string collapses the row type to GenericStringError[].
export const PROFILE_COLUMNS =
  'id, org_id, full_name, role, phone, active, supplier_id, locale, theme' as const;

export const ORGANIZATION_COLUMNS =
  'id, name, vat_rate, base_currency, country_code, status, logo_path, logo_updated_at, onboarding_completed_at, settings' as const;
