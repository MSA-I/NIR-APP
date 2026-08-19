-- 0147 -- The operator's read door for autonomy policies (owner review, defect 14).
--
-- ==========================================================================================
-- WHY A NEW FUNCTION, AND WHY NOW.
--
-- The autonomy panel moved out of tenant Settings into the operator application. Its WRITE
-- path was always platform-scoped: platform_set_autonomy_policy(p_org_id, ...) takes the
-- target organization explicitly and raises `not_platform_admin` for anyone else
-- (0076:270-272). Its READ path was not: the panel read through
-- evaluate_autonomy_policy(p_policy_key), whose body resolves auth_org() -- the CALLER's
-- organization. For a platform operator that is either NULL (no tenant profile, the normal
-- operator shape per 0076's own fixture reasoning) or their own tenant -- never the
-- organization they are administering. Inside tenant Settings that mismatch was invisible,
-- because the only rendered case was "operator who happens to be signed into the org being
-- configured". In an operator console it is the whole product: a read door that answers for
-- the wrong organization, or for none.
--
-- So this file adds the read that mirrors the write: same explicit p_org_id, same guard, same
-- resolution. ONE implementation still -- the body iterates the definition vocabulary and
-- delegates every answer to private.autonomy_policy_for_org (0076:349), the single resolver
-- the tenant evaluator and the apply-interpretation command already read. No precedence rule
-- is restated here; a third copy of the kill-switch/baseline/threshold logic would be exactly
-- the drift 0076's "one implementation, two doors" note warns against. This is door three,
-- same implementation.
--
-- WHAT THIS FILE DOES NOT TOUCH:
--   * evaluate_autonomy_policy -- read by apply_document_interpretation; its comment forbids
--     it gating a human's permission, and its tenant-scoped answer is correct for its callers.
--   * private.autonomy_policy_for_org -- the shared resolver, unchanged.
--   * Any table, policy, grant on tables, or the definitions vocabulary.
--
-- A5 / EXEMPTION PIN: this definer references org_autonomy_policies (registered org_global,
-- enforced = false, 0076:458), organizations and the private definitions table -- no
-- scope-ENFORCED table, the same footprint as platform_set_autonomy_policy, which 0076:251
-- records as needing no exemption row. The registry pin in p9_five_domains.sql therefore
-- stays at 89, and check:exemptions agrees by arithmetic.
-- ==========================================================================================

-- The guard is platform_set_autonomy_policy's, word for word (0076:263-272): the read door and
-- the write door beside it must refuse the same callers by the same name. A read is still a
-- cross-tenant disclosure -- which organizations run autonomously, and above which threshold --
-- so it carries the same platform gate, not a softer one.
create or replace function platform_get_autonomy_policies(p_org_id uuid)
returns table (
  policy_key       text,
  configured       boolean,
  autonomy_enabled boolean,
  min_confidence   numeric,
  kill_switch      boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  -- Refused by name, the 0076 idiom: a NULL organization must not quietly resolve to "the
  -- unconfigured answer for nobody" -- the resolver would answer that shape happily, and the
  -- operator would read four healthy-looking OFF switches for an organization that was never
  -- named. An unknown organization is refused separately so a mistyped id reads as what it is.
  if p_org_id is null then
    raise exception 'autonomy_policy_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  -- The definitions table is the vocabulary (one key per decision, 0076:109-113); iterating it
  -- means a policy added by a later migration (as 0081, 0090 and 0140 each did) appears here
  -- with no edit to this function -- and each answer is the SAME resolution every other door
  -- reads, fail-closed rules included.
  return query
  select answer.*
  from private.autonomy_policy_definitions d
  cross join lateral private.autonomy_policy_for_org(p_org_id, d.policy_key) answer
  order by 1;
end
$$;

revoke all on function platform_get_autonomy_policies(uuid) from public, anon;
grant execute on function platform_get_autonomy_policies(uuid) to authenticated;

comment on function platform_get_autonomy_policies(uuid) is
  'The operator console''s read of one organization''s autonomy rules: every defined policy '
  'key, resolved by private.autonomy_policy_for_org for the EXPLICITLY named organization -- '
  'the read mirror of platform_set_autonomy_policy, behind the identical not_platform_admin '
  'guard. It exists because evaluate_autonomy_policy resolves auth_org(), which is the '
  'caller''s organization, never the administered one. Fail-closed exactly as the resolver is: '
  'unconfigured and killed both answer disabled, and an unconfigured threshold is NULL, never '
  '0. Like the evaluator, it must never appear in an RLS USING/WITH CHECK expression and must '
  'never gate a human''s permission (ENTERPRISE-SECURITY-MODEL.md:246-251).';

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0147 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
