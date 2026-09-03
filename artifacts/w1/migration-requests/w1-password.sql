-- =====================================================================================
-- Migration request — owner decision G (03.09.2026): every password change is recorded.
--
-- Filed by the Wave 1 RC9 / decision G agent, which does not own supabase/migrations.
-- Pick the number with `npm run next-number -- migration` at authoring time; do NOT
-- copy a number from this file, which deliberately contains none.
--
-- -------------------------------------------------------------------------------------
-- THE BOUNDARY, AND WHY IT IS THIS ONE
--
-- Decision G's constraint: a write placed AFTER `auth.updateUser` is not atomic with it, so
-- the password can change while the audit write fails and the ledger silently disagrees with
-- reality. The row must therefore come from a server boundary that owns both effects.
--
-- Two candidates were named in the plan. Both were examined against the live system.
--
--   REJECTED — reconciliation from the identity provider's own log. Measured, not assumed:
--   `auth.audit_log_entries` records a password change as
--     {"action":"user_modified", "log_type":"user", "traits":{user_email,user_id,user_phone}}
--   with NO field naming which attribute changed. A metadata-only update produces the same
--   entry. Worse, two of the three product paths (`/set-password`, `/reset-password`) send the
--   password AND `password_pending:false` in ONE call, so the provider's log cannot separate
--   "the password changed" from "a flag was cleared" even in principle. Reconciling from it
--   would produce rows we cannot defend. It is also an `auth`-schema table with bounded
--   retention that PostgREST does not expose.
--
--   REJECTED — a new Edge Function that verifies the caller's JWT and changes the password
--   through the admin API. Three concrete costs:
--     1. It is still two effects in two transactions. The admin call can succeed and the audit
--        insert fail — the exact failure decision G forbids, moved from the browser to a server.
--     2. It would be the THIRD holder of the `service_role` key (today: admin-provision and
--        public-signup, and public-signup's own header says so), widening the most dangerous
--        credential in the system to earn a log line.
--     3. It routes the password around GoTrue's own policy. Wave 1 is about to switch
--        `password_hibp_enabled` on and raise `password_min_length` from 6 (measured, W0-G4);
--        `security_update_password_require_current_password` is a platform switch that is off
--        today and may be turned on later. A path that changes passwords through the admin API
--        keeps working when those are enabled — which is a silent bypass, not a feature.
--
--   CHOSEN — a trigger inside GoTrue's own transaction on `auth.users`.
--     * It is the ONLY option where the password change and the audit row are one transaction.
--       That is also this repository's stated rule for identity changes:
--       docs/ENTERPRISE-SECURITY-MODEL.md — "כל שינוי זהות והרשאה נכתב ל-audit_logs עם סיבה,
--       באותה עסקה".
--     * It reuses an existing boundary rather than adding one: the writer of the password is
--       already GoTrue's UPDATE, and `auth.users` is ALREADY classified as an auditable
--       identity entity in `private.audit_scope_taxonomy`
--       (organization_identity_platform / cross_scope), so no taxonomy change is needed.
--     * It covers all three paths decision G names — and every path nobody wrote down: the
--       admin API, Studio, a future SSO-linked change. No client code can skip it.
--     * No new holder of `service_role`; no browser change at all.
--     * It is the shape this repository already settled on for exactly this question.
--       `src/lib/audit.ts` is a disabled stub whose header reads: "P0 removed browser INSERT on
--       audit_logs because a browser cannot be trusted to assert that a mutation happened or to
--       author its old/new values. Server triggers still record the real row change." A password
--       change is that sentence's case, arriving late.
--
-- FAIL-CLOSED, ON PURPOSE. If the audit insert raises, GoTrue's UPDATE rolls back with it and
-- the password does not change. For a ledger that is the correct direction: a false negative
-- (a real change with no row) hides an attacker, a refusal does not. Statement 3 exists so the
-- refusal cannot happen for a legitimate reason.
--
-- WHAT THE ROW DELIBERATELY DOES NOT CLAIM
--   * It does not name WHICH screen was used. The three screens could mark themselves in the
--     same `updateUser` call, but whether the marker is visible to this trigger depends on the
--     order of the statements GoTrue issues inside its transaction (password first, or metadata
--     first). That order was NOT measured — measuring it requires writing to the database, which
--     this agent is not permitted to do — so nothing here depends on it. A design that quietly
--     assumed one order would record the wrong context half the time.
--   * `user_id` is the account whose password changed, which in every product path is also the
--     actor: this product has no screen where one person changes another person's password. A
--     change made through the admin API would still record the SUBJECT, because a database
--     trigger cannot see who made the HTTP call. Stated rather than implied.
--
-- KNOWN GAP, NAMED RATHER THAN HIDDEN. An auth user with no row in `profiles` gets no audit
-- row: `audit_logs.org_id` is nullable in the column definition but `zz_organization_write_guard`
-- refuses a NULL org on INSERT, so there is no tenant to record such a change against. Locally
-- that population is 3 users, one of them a platform admin. Platform-operator identity events
-- belong in `platform_lifecycle_events`, which is a separate decision and is out of this scope.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- STATEMENT 1 — preflight. Read-only; run it and read it before applying anything below.
-- `may_create_trigger` must be true (it is true locally for `postgres`, measured 03.09.2026;
-- production has NOT been probed). `taxonomy_present` must be true or the insert raises
-- `audit_scope_taxonomy_incomplete` and every password change in the system stops.
-- -------------------------------------------------------------------------------------
select
  has_table_privilege('postgres', 'auth.users', 'TRIGGER')                         as may_create_trigger,
  exists (select 1 from private.audit_scope_taxonomy where entity_type = 'auth.users')
                                                                                   as taxonomy_present,
  (select count(*) from auth.users u
     left join public.profiles p on p.id = u.id
    where p.id is null)                                                            as users_without_profile,
  (select count(*) from public.organizations o
    where private.organization_access_mode(o.id) <> 'active')                      as organizations_not_writable;


-- -------------------------------------------------------------------------------------
-- STATEMENT 2 — the recorder, and the trigger that puts it inside GoTrue's transaction.
-- -------------------------------------------------------------------------------------
create or replace function private.audit_auth_password_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_org uuid;
begin
  -- The tenant the change is recorded against. `profiles.org_id` is NOT NULL, so a found
  -- profile always yields an org. This runs as the function owner, which owns `profiles` and
  -- whose RLS is not FORCEd — so a policy can never hide the row and turn "no profile" into a
  -- silent skip, which would be the worst failure this function could have.
  select org_id into v_org from public.profiles where id = new.id;

  -- No tenant, no row: `zz_organization_write_guard` refuses a NULL org and there is nowhere
  -- honest to file a platform identity. See KNOWN GAP in the header.
  if v_org is null then
    return null;
  end if;

  -- One row, one truth: this account's password was replaced, at this moment, in the same
  -- transaction that replaced it. `scope_domain`, `scope_class` and `legal_entity_id` are
  -- assigned by `aa_assign_audit_scope` from the taxonomy entry for `auth.users`.
  insert into public.audit_logs (org_id, user_id, action, entity_type, entity_id, reason)
  values (
    v_org,
    new.id,
    'password_changed',
    'auth.users',
    new.id,
    'הסיסמה של המשתמש הוחלפה'
  );

  return null;
end
$function$;

revoke all on function private.audit_auth_password_change() from public;
grant execute on function private.audit_auth_password_change() to supabase_auth_admin;

drop trigger if exists audit_password_change on auth.users;

-- No `UPDATE OF encrypted_password` column list: the WHEN clause is the real predicate and a
-- column list could only ever make the trigger fire LESS. Every sign-in updates this table
-- (`last_sign_in_at`), so the WHEN clause is what keeps this off the hot path — it compares two
-- text values and stops.
create trigger audit_password_change
after update on auth.users
for each row
when (old.encrypted_password is distinct from new.encrypted_password)
execute function private.audit_auth_password_change();


-- -------------------------------------------------------------------------------------
-- STATEMENT 3 — required with statement 2, and separable only if you accept the consequence.
--
-- `zz_organization_write_guard` refuses every write for an organization whose access mode is
-- not `active` — suspended, or with an open offboarding request. With statement 2 in place and
-- this one absent, a member of such an organization CANNOT CHANGE OR RECOVER THEIR PASSWORD:
-- the guard raises, GoTrue's UPDATE rolls back, and the browser is told only "Database error
-- updating user". That is precisely the population — a lapsed or departing customer — that most
-- needs to get back into the account.
--
-- The carve-out is narrow and precedented. The guard's purpose is that a frozen tenant cannot
-- write business data; an `auth.users` row in `audit_logs` is a record ABOUT an identity, not a
-- tenant business write, and the guard ALREADY carves `audit_logs` out for the offboarding
-- writer. Refusing this row buys nothing and costs either the record or the account.
--
-- Written as an anchored replacement of the LIVE body — per `check:anchored-replacements`, with
-- the carriage returns stripped, because a body applied from Windows carries CRLF and one
-- applied from a Linux runner does not. Do NOT re-declare this function from the migration that
-- created it: it has been hardened since, and copying an ancestor would silently revert that.
-- -------------------------------------------------------------------------------------
do $patch$
declare
  v_source text;
  v_anchor text := 'begin' || e'\n' ||
                   '  if tg_op = ''DELETE'' and tg_table_schema = ''public'' then';
  v_branch text := 'begin' || e'\n' ||
    '  -- identity_audit_exempt: a record ABOUT an auth identity is not a tenant business write.' || e'\n' ||
    '  -- Refusing it when the organization is frozen would either lose the password-change' || e'\n' ||
    '  -- ledger entry or block the account holder from recovering the account. Neither is a' || e'\n' ||
    '  -- protection; both are damage.' || e'\n' ||
    '  if tg_op = ''INSERT''' || e'\n' ||
    '     and tg_table_schema = ''public''' || e'\n' ||
    '     and tg_table_name = ''audit_logs''' || e'\n' ||
    '     and (to_jsonb(new) ->> ''entity_type'') = ''auth.users'' then' || e'\n' ||
    '    return new;' || e'\n' ||
    '  end if;' || e'\n' ||
    '  if tg_op = ''DELETE'' and tg_table_schema = ''public'' then';
begin
  v_source := replace(
    pg_get_functiondef('private.organization_row_write_guard()'::regprocedure), e'\r', '');

  if position('identity_audit_exempt' in v_source) > 0 then
    return; -- already carved out; this migration is being re-applied
  end if;

  if position(v_anchor in v_source) = 0 then
    raise exception
      'organization_row_write_guard: anchor not found — read the LIVE body and re-anchor';
  end if;

  execute replace(v_source, v_anchor, v_branch);
end
$patch$;


-- -------------------------------------------------------------------------------------
-- SUGGESTED SUITE ASSERTIONS (for whoever owns the SQL suite; not executed here)
--
--   1. The trigger exists, is AFTER UPDATE on auth.users, and carries a WHEN clause naming
--      `encrypted_password` — a trigger without it would fire on every sign-in.
--   2. Changing a demo user's password through the auth API leaves exactly ONE new
--      `audit_logs` row with action `password_changed`, entity_type `auth.users`,
--      entity_id = user_id = that user, and the org of their profile.
--   3. A sign-in leaves ZERO such rows.
--   4. An update that changes only `raw_user_meta_data` leaves ZERO such rows.
--   5. With the organization's access mode forced away from `active`, the password change
--      still succeeds and still writes the row (this is what statement 3 buys).
--   6. `audit_log_immutable` still refuses an UPDATE or DELETE of the new row.
-- -------------------------------------------------------------------------------------
