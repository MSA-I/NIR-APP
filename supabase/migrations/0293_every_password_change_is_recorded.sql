-- 0293 — owner decision G (03.09.2026): every password change writes an audit row.
--
-- THE CONSTRAINT THE DECISION CARRIES, and why it rules out the obvious implementation. A write
-- placed AFTER `auth.updateUser` is not atomic with it: the password can change while the audit
-- write fails, and the ledger then silently disagrees with reality. So the row must come from a
-- server boundary that owns BOTH effects.
--
-- REJECTED — reconciliation from the identity provider's own log, refuted by measurement rather
-- than preference. `auth.audit_log_entries` records a password change as
-- `{"action":"user_modified","log_type":"user","traits":{user_email,user_id,user_phone}}` with no
-- field naming which attribute changed; a metadata-only update produces the same entry. And two
-- of the three product paths (`/set-password`, `/reset-password`) send the password AND
-- `password_pending:false` in ONE call, so that log cannot separate "the password changed" from
-- "a flag was cleared" even in principle.
--
-- REJECTED — a new Edge Function using the admin API. It is still two effects in two
-- transactions, so it moves decision G's forbidden failure from the browser to a server rather
-- than removing it. It would be the third holder of `service_role`. And it routes the password
-- around GoTrue's own policy: Wave 1 is about to enable `password_hibp_enabled` and raise
-- `password_min_length` from the 6 that W0-G4 measured, and a path that keeps working when those
-- land is a silent bypass, not a feature.
--
-- CHOSEN — a trigger inside GoTrue's own transaction. It is the only option where the password
-- change and its record are one transaction, which is this repository's stated rule for identity
-- changes (`docs/ENTERPRISE-SECURITY-MODEL.md`), and the shape it already settled on:
-- `src/lib/audit.ts` is a disabled stub whose header says browser audit inserts were removed
-- because "a browser cannot be trusted to assert that a mutation happened… Server triggers still
-- record the real row change." A password change is that sentence's case, arriving late. It also
-- covers the paths nobody wrote down — the admin API, Studio, a future SSO-linked change.
--
-- FAIL-CLOSED, ON PURPOSE. If the insert raises, GoTrue's UPDATE rolls back with it and the
-- password does not change. For a ledger that is the correct direction: a real change with no row
-- hides an attacker; a refusal does not. The guard carve-out below exists so that refusal cannot
-- happen for a legitimate reason.
--
-- WHAT THE ROW DELIBERATELY DOES NOT CLAIM. It does not name which screen was used: the screens
-- could mark themselves in the same `updateUser` call, but whether the marker is visible here
-- depends on the order GoTrue issues its statements inside one transaction, and that order was
-- not measured. A design that quietly assumed an order would record the wrong context half the
-- time. `user_id` is the account whose password changed — in every product path that is also the
-- actor, because no screen lets one person change another's password, but a database trigger
-- cannot see who made the HTTP call and this does not pretend otherwise.
--
-- KNOWN GAP, NAMED RATHER THAN HIDDEN. An auth user with no `profiles` row gets no audit row:
-- `zz_organization_write_guard` refuses a NULL org on insert and there is no tenant to record the
-- change against. Locally that population is 3 users, one a platform admin. Platform-operator
-- identity events belong in `platform_lifecycle_events` and are a separate decision.
--
-- PREFLIGHT, measured 03.09.2026 on the local stack before this was written:
-- `has_table_privilege('postgres','auth.users','TRIGGER')` = t, an `auth.users` row is already
-- present in `private.audit_scope_taxonomy` (so no taxonomy change is needed and the insert
-- cannot raise `audit_scope_taxonomy_incomplete`), 3 users without a profile, 0 organizations
-- outside `active`. Re-read it on production before applying.

create or replace function private.audit_auth_password_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_org uuid;
begin
  -- The tenant the change is recorded against. `profiles.org_id` is NOT NULL, so a found profile
  -- always yields an org. This runs as the function owner, which owns `profiles` and whose RLS is
  -- not FORCEd — so no policy can hide the row and turn "no profile" into a silent skip, which
  -- would be the worst failure this function could have.
  select org_id into v_org from public.profiles where id = new.id;

  -- No tenant, no row. See KNOWN GAP above.
  if v_org is null then
    return null;
  end if;

  -- `scope_domain`, `scope_class` and `legal_entity_id` are assigned by `aa_assign_audit_scope`
  -- from the taxonomy entry for `auth.users`, which fires before `zz_organization_write_guard`.
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
-- GoTrue connects as `supabase_auth_admin`; a trigger function is executed with the privileges of
-- the role performing the DML, so without this grant every password change fails with a
-- permission error instead of being recorded.
grant execute on function private.audit_auth_password_change() to supabase_auth_admin;

comment on function private.audit_auth_password_change() is
  'Owner decision G (0293): writes one audit_logs row for a password change, inside GoTrue''s own '
  'transaction, so the record and the change cannot disagree. Records the SUBJECT of the change, '
  'not the HTTP caller, and names no screen — see 0293 for why both are deliberate.';

drop trigger if exists audit_password_change on auth.users;

-- No `update of encrypted_password` column list: the WHEN clause is the real predicate and a
-- column list could only make the trigger fire LESS. Every sign-in updates this table
-- (`last_sign_in_at`), so the WHEN clause is what keeps this off the hot path — it compares two
-- text values and stops.
create trigger audit_password_change
after update on auth.users
for each row
when (old.encrypted_password is distinct from new.encrypted_password)
execute function private.audit_auth_password_change();

-- ---------------------------------------------------------------------------------------------
-- The carve-out, required with the trigger above and not separable from it.
--
-- `zz_organization_write_guard` refuses every write for an organization whose access mode is not
-- `active`/`trial`/`grace`. With the trigger in place and this absent, a member of a suspended or
-- offboarding organization CANNOT CHANGE OR RECOVER THEIR PASSWORD: the guard raises, GoTrue's
-- UPDATE rolls back, and the browser is told only "Database error updating user". That is exactly
-- the population — a lapsed or departing customer — that most needs to get back into the account.
--
-- NARROWER THAN THE ONE THAT WAS PROPOSED. The filed request returned `new` early for any
-- `audit_logs` insert naming `auth.users`, which would also have skipped the guard's
-- missing-org check. This relaxes only the access-mode refusal and leaves
-- `organization_write_guard_missing_org` in force, so a NULL-org identity row is still refused.
--
-- Anchored against the LIVE body with carriage returns stripped, per `check:anchored-replacements`
-- and because this guard has been hardened since it was created; re-declaring it from an ancestor
-- would silently revert that.
-- ---------------------------------------------------------------------------------------------
do $patch_write_guard_0293$
declare
  v_definition text := replace(
    pg_get_functiondef('private.organization_row_write_guard()'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('identity_audit_exempt' in v_definition) > 0 then
    return; -- already carved out; this migration is being re-applied
  end if;

  v_anchor := $anchor$
    if private.organization_access_mode(v_new_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write
       and not (v_offboarding_write and v_offboarding_org = v_new_org) then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;$anchor$;
  v_replacement := $replacement$
    if private.organization_access_mode(v_new_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write
       and not (v_offboarding_write and v_offboarding_org = v_new_org)
       -- identity_audit_exempt (0293): a record ABOUT an auth identity is not a tenant business
       -- write. Refusing it when the organization is frozen would either lose the password-change
       -- ledger entry or lock the account holder out of recovery. Neither is a protection.
       and not (tg_table_schema = 'public'
                and tg_table_name = 'audit_logs'
                and (to_jsonb(new) ->> 'entity_type') = 'auth.users') then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception '0293: write guard insert-branch anchor count %', v_count;
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_write_guard_0293$;

do $assert_0293$
declare
  v_violations text;
  v_guard text := (select prosrc from pg_proc
                   where oid = 'private.organization_row_write_guard()'::regprocedure);
begin
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass
      and t.tgname = 'audit_password_change'
      and not t.tgisinternal
  ) then
    raise exception '0293: the password-change trigger is not on auth.users';
  end if;

  -- A trigger without the WHEN clause would fire on every sign-in and write a false record of a
  -- password change. Assert the predicate is really there, by name.
  if position('encrypted_password' in (
       select pg_get_triggerdef(t.oid) from pg_trigger t
       where t.tgrelid = 'auth.users'::regclass and t.tgname = 'audit_password_change')) = 0 then
    raise exception '0293: the trigger has no encrypted_password predicate — it would fire on sign-in';
  end if;

  if not has_function_privilege(
       'supabase_auth_admin', 'private.audit_auth_password_change()', 'execute') then
    raise exception '0293: GoTrue cannot execute the recorder, so every password change would fail';
  end if;

  if position('identity_audit_exempt' in v_guard) = 0 then
    raise exception '0293: the write guard was not carved out — a frozen tenant cannot recover an account';
  end if;
  -- The carve-out must NOT have swallowed the missing-org refusal.
  if position('organization_write_guard_missing_org' in v_guard) = 0 then
    raise exception '0293: the carve-out removed the missing-org refusal';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0293 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0293$;
