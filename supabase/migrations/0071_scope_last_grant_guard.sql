-- The last-grant guard on revoke_user_scope (wave 10, 10-FINAL-AUDIT §G / Finding 1).
--
-- WHAT WAS TRUE BEFORE THIS MIGRATION, as one composed chain -- every link individually
-- correct, the composition a wrong number on a financial screen:
--
--   1. revoke_user_scope (0054:404, redeclared 0061:347) checks the actor is an owner, that
--      a reason was given, that the unit exists and that the grant exists. It does NOT check
--      whether the grant it is about to remove is the user's LAST one.
--   2. p0_recompute_scope_closure (0054:239) DELETES the closure row when the recomputation
--      yields NULL -- which is exactly what zero grants yield.
--   3. auth_scopes() (0054:321) coalesces a missing closure row to '{}'::uuid[], silently.
--   4. The 0057 RESTRICTIVE rider is ((unit_id IS NULL) OR (unit_id = ANY (auth_scopes()))).
--      With an empty array the second arm is false for every row, and the first arm cannot
--      rescue five of the six enforced tables: the 0055 p0_*_set_unit BEFORE-INSERT triggers
--      stamp a NON-NULL unit from p0_default_unit() on every new row. Only the sixth table
--      (no default-unit trigger) keeps NULL and stays visible.
--   5. The two balance functions carry the same scope condition in their live bodies (0057),
--      correctly -- so every balance and every aggregate built on one returns 0.
--   6. And `0` is the one thing the project constitution forbids: "מדד שאין לו נתונים מציג
--      `—`, לא `0` — אפס הוא גם טענה על המציאות." A zero-row RLS result is indistinguishable
--      from "there are no rows". No error is raised, nothing is thrown, the screen renders
--      ₪0 with full confidence.
--
-- Neither existing defence reaches it. p0_seed_profile_scope guarantees every NEW profile a
-- root grant and says nothing about a later revoke; users_without_scope_grant and
-- stale_user_scope_closure DO catch the resulting state, but they are read-only arms of a
-- manual local gate with no CI -- nothing evaluates them in production.
--
-- THE FIX, deliberately the cheapest of the three the audit named (§3): a floor inside the
-- command itself, in the same shape as the guards already in 0061. An owner may narrow a
-- live member's scope all the way down to one unit; the command refuses to take the last
-- one. Narrowing to zero is not a scope change, it is a lockout, and a lockout that renders
-- as ₪0 is not an authorization decision the system may make silently.
--
-- What the guard deliberately does NOT block: revoking the grants of a user whose profile is
-- no longer active. Deactivating a member and then removing their grants is legitimate
-- housekeeping, and the deactivated user has no session to be lied to.
--
-- Ordering, and why it is post-delete: 'scope_grant_unknown' must keep its exact meaning, so
-- the delete runs first and the guard reads the remainder. The raise aborts the transaction,
-- which rolls the delete and its closure trigger back -- the same mechanism every other
-- post-write guard in this schema relies on. The AFTER ROW closure trigger has already fired
-- by then, so the check reads the true post-revoke grant set.
--
-- A5 (0057:321-349) note: this body references only user_scope_grants and profiles -- both
-- classified org_global/not-enforced -- and no enforced table name appears anywhere in it,
-- comments included. The exemption registry gains ZERO rows, and CREATE OR REPLACE preserves
-- the oid, so nothing keyed on it moves.

-- ===== 1. Ancestry guard =====
-- Redeclaring a body that lives only in pg_proc is the campaign's documented silent-revert
-- mine (0061:96-112). Assert the LIVE definition is the 0061 one before replacing it: the
-- step-up call, the security event and the audit action must all be present, and the guard
-- must not already exist. Any drift fails the reset here instead of reverting wave 4 quietly.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.revoke_user_scope(uuid,uuid,text)'::regprocedure::oid)
    into v_definition;
  if position('assert_recent_password_authentication' in v_definition) = 0 then
    raise exception '0071 ancestry mismatch: revoke_user_scope lost its 0061 step-up call';
  end if;
  if position('scope_grant_change' in v_definition) = 0 then
    raise exception '0071 ancestry mismatch: revoke_user_scope lost its 0061 security event';
  end if;
  if position('user_scope_revoked' in v_definition) = 0 then
    raise exception '0071 ancestry mismatch: revoke_user_scope lost its reasoned audit row';
  end if;
  if position('scope_last_grant_required' in v_definition) > 0 then
    raise exception '0071 already applied: revoke_user_scope already carries the guard';
  end if;
end
$$;

-- ===== 2. The redeclaration =====
-- Verbatim 0061:347-387 with ONE addition, marked below. Owner gate, step-up call, reason
-- requirement, unit lookup, delete, unknown-grant error, reasoned audit row and
-- scope_grant_change security event are byte-identical; the closure resync stays synchronous
-- through the 0054 grant trigger.
create or replace function revoke_user_scope(p_user_id uuid, p_unit_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_unit org_units;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'scope_reason_required' using errcode = '22023';
  end if;
  select * into v_unit from org_units where id = p_unit_id and org_id = v_org;
  if not found then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;

  delete from user_scope_grants
  where org_id = v_org and user_id = p_user_id and unit_id = p_unit_id;
  if not found then
    raise exception 'scope_grant_unknown' using errcode = 'P0002';
  end if;

  -- ===== the only addition to 0061:347-387 (wave 10, audit §G) =====
  -- A live member may be narrowed to one unit, never to none: zero grants empties the
  -- closure, which empties auth_scopes(), which turns the RESTRICTIVE rider into a deny-all
  -- and every derived total into a confident zero.
  if not exists (
       select 1 from user_scope_grants g
       where g.org_id = v_org and g.user_id = p_user_id)
     and exists (
       select 1 from profiles p
       where p.id = p_user_id and p.org_id = v_org and p.active) then
    raise exception 'scope_last_grant_required' using errcode = '42501';
  end if;
  -- ===== end of the addition =====

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, reason)
  values (
    v_org, v_actor, 'user_scope_revoked', 'user_scope_grants', p_user_id,
    jsonb_build_object(
      'user_id', p_user_id, 'unit_id', p_unit_id,
      'unit_type', v_unit.unit_type, 'unit_name', v_unit.name),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_actor, 'scope_grant_change',
    jsonb_build_object('change', 'revoked', 'user_id', p_user_id, 'unit_id', p_unit_id));
end
$$;

-- CREATE OR REPLACE preserves ACLs; re-asserted anyway so the contract is visible here.
revoke all on function revoke_user_scope(uuid, uuid, text) from public, anon;
grant execute on function revoke_user_scope(uuid, uuid, text) to authenticated;

-- ===== 3. The guard actually landed =====
do $$
begin
  if (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'public.revoke_user_scope(uuid,uuid,text)'::regprocedure::oid)
     !~ 'scope_last_grant_required' then
    raise exception '0071 redeclaration did not land: the last-grant guard is absent';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'public.revoke_user_scope(uuid,uuid,text)'::regprocedure::oid)
     !~ 'assert_recent_password_authentication' then
    raise exception '0071 redeclaration dropped the step-up call';
  end if;
end
$$;

-- ===== 4. Registry (A1) + re-assert (the 0058:207-218 idiom, literal 0066:549-569) =====
-- No new table and no new definer that touches an enforced one, so the registry gains no
-- row. The re-assert runs regardless: 0067 skipped this block and proved the invariant is
-- enforced by memory rather than by structure (audit Finding 10), so this migration pays it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0071 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
