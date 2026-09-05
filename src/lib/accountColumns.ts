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
 * `./types`. Four columns that exist in the database are deliberately absent, and after migration
 * 0319 no client role may select any of them at all:
 *
 *   `profiles.phone`          the owner reads a colleague's number through
 *                             `ORGANIZATION_PEOPLE_COLUMNS` below, and nobody else reads it.
 *   `profiles.backup_email`   an account-recovery address. A person reads their OWN through
 *                             `my_backup_email()` (migration 0255), which answers for the caller
 *                             alone; the owner's route is the same directory.
 *   `organizations.created_at`
 *   `organizations.trial_ends_at`
 *                             commercial facts no tenant screen draws. An operator reads them
 *                             through the platform RPCs in `./platform`, every one of which is
 *                             `SECURITY DEFINER` and carries its own operator predicate.
 *
 * `check:profile-columns` fails the build on any new `select('*')` against either table, because
 * the failure this prevents is invisible where it is written: PostgREST's `*` expansion asks for a
 * column the client role may not read and PostgreSQL refuses the WHOLE statement — the sibling
 * case is `suppliers.bank_details` and `src/lib/supplierColumns.ts`, where it surfaced as three
 * browser scenarios timing out on a missing heading twenty minutes into CI.
 */
// A single literal each, not a joined array: supabase-js parses the select string at the TYPE
// level, and a runtime-built string collapses the row type to GenericStringError[].
export const PROFILE_COLUMNS =
  'id, org_id, full_name, role, active, supplier_id, locale, theme' as const;

export const ORGANIZATION_COLUMNS =
  'id, name, vat_rate, base_currency, country_code, status, logo_path, logo_updated_at, onboarding_completed_at, settings' as const;

/**
 * The owner's route back to a colleague's telephone number, and the ONLY one.
 *
 * `public.organization_people_directory` (migration 0319) is a view that runs with its owner's
 * privileges, so it can select a column its caller cannot, and it carries `auth_role() = 'owner'`
 * as its own predicate — which is the only way to say "owner yes, office no" when all three
 * product roles are the same database role, `authenticated`. Office and accountant hold SELECT on
 * the view and receive zero rows from it.
 *
 * Two columns and not the whole row, deliberately: the roster already has the person from
 * `profiles`, and this read exists to add the one field that may no longer travel with them.
 */
export const ORGANIZATION_PEOPLE_COLUMNS = 'id, phone' as const;
