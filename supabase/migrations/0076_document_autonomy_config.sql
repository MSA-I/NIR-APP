-- 0076 -- The autonomy switch, and the number behind it (wave 11, task C1; OPEN-DECISIONS #109).
--
-- ==========================================================================================
-- WHAT THE OWNER DECIDED, AND WHAT THIS FILE IS.
--
-- Asked what the system may do without human approval when the model identifies a supplier
-- charge, the owner chose the most permissive of three options: above a confidence threshold
-- the system may create the record, link it to the order, and update a missing item. The risk
-- -- a model authoring financial records -- was stated before the choice and again after.
--
-- This migration is NOT that automation (that is 0077 and its siblings). It is the SWITCH and
-- the NUMBER, built so the automation has something honest to read.
--
-- DEFAULT FALSE IS PART OF THE SCOPE, NOT CAUTION. Option B grants an authority. It does not
-- say "every existing tenant, from today, without being told." A tenant is switched on
-- deliberately, by an operator, with a reason, in the audit trail. Nothing in this file turns
-- it on anywhere, and supabase/tests/p13_document_autonomy_config.sql asserts that as its
-- FIRST assertion, before it creates a single fixture.
-- ==========================================================================================
--
-- ==========================================================================================
-- WHY THIS IS NOT A FEATURE FLAG. Read this before "simplifying" it onto 0059.
--
-- The task that produced this file said to build it on the 0059 flag infrastructure. That is
-- the wrong infrastructure, for three reasons -- and the third is not an opinion, it is a
-- gate assertion that would fail.
--
--   1. THE FLAG LAW FORBIDS IT. ENTERPRISE-SECURITY-MODEL.md §8: "a flag can only turn a
--      capability OFF, never grant one ... so a flag switched on by mistake cannot open a
--      door." A switch whose ON state lets a model author an invoice is exactly a switch that
--      opens a door when flipped by mistake. OPEN-DECISIONS #104 wrote the same sentence from
--      the other side: a configuration that can loosen is "a permission grant wearing a
--      configuration costume." That is why a flag kill switch is off-only with no force-on
--      counterpart (0059:29-32).
--
--   2. 0059 CANNOT STORE THE NUMBER. org_flag_configurations.state is boolean. Its only
--      non-boolean column, `targeting`, is rollout-only (unit_ids / percentage / starts_at /
--      ends_at), is evaluated solely inside resolve_feature_flags, and IGNORES UNKNOWN KEYS.
--      A threshold parked there would be accepted, never validated, and never read -- a
--      number forced through a boolean-shaped door.
--
--   3. THE GATE ALREADY CLOSES THAT ROUTE. p4_flags_identity.sql:162-167 asserts that no
--      routine in public or private, other than resolve_feature_flags itself, mentions
--      resolve_feature_flags. The moment the future apply_document_interpretation reads the
--      switch through the flag evaluator, THAT ASSERTION FAILS. Routing this through 0059
--      does not bend a rule; it breaks a running test.
--
-- So this file follows 0070 (approval policies) instead, which is the same shape one wave
-- earlier: a per-organization POLICY, a private baseline, one reasoned platform command, a
-- tighten-only law, and an evaluator. The write path is platform_set_org_flag's contract to
-- the letter -- platform admin + mandatory reason + audit to the target organization, no
-- browser write path -- via its own function, because redeclaring platform_set_org_flag to
-- carry a numeric would both force the number and violate the rule against redeclaring an
-- older migration's function from its text.
-- ==========================================================================================
--
-- ==========================================================================================
-- THE THRESHOLD IS A DOCUMENTED GUESS. IT IS NOT CALIBRATED (OPEN-DECISIONS #109).
--
-- 0.90 has not been measured against a real corpus. Nobody has compared the automatic decision
-- to a human's on a body of real supplier paperwork. It is a default written down so that it
-- can be argued with, not a number that earned its place. The cheapest step that would earn it
-- is 50 real documents with the automatic decision compared against a human's; until that runs
-- the number stays a guess and this file says so. See docs/DEBT-REGISTER.md -- this is the one
-- risk the wave leaves deliberately open.
-- ==========================================================================================

-- ===== 0. Ancestry anchor: the audit escape this file depends on must still be live =====
-- org_autonomy_policies is written by a platform operator on behalf of an ARBITRARY
-- organization, by someone who typically has no profile at all (auth_org() IS NULL).
-- audit_row_change rejects exactly that shape unless the actor is a verified platform operator
-- -- the escape 0059:90-114 added. This migration does NOT redeclare that function (rule: read
-- the live definition, never copy an older migration's text forward). It anchors on it: if a
-- later migration ever redeclared audit_row_change without the escape, every reasoned write
-- below would die at runtime with audit_source_org_mismatch, and the failure would surface in
-- production rather than here.
do $$
declare
  v_body text;
  v_definer boolean;
begin
  select p.prosrc, p.prosecdef into v_body, v_definer
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'audit_row_change';

  if v_body is null then
    raise exception '0076 ancestry: public.audit_row_change() is missing';
  end if;
  if not v_definer then
    raise exception '0076 ancestry: public.audit_row_change() is no longer SECURITY DEFINER';
  end if;
  if v_body !~ 'is_platform_admin' then
    raise exception '0076 ancestry: the live audit_row_change() no longer carries the '
      'platform-operator escape (0059:111-114). A platform write on behalf of another tenant '
      'would be rejected as audit_source_org_mismatch. Restore the escape before 0076.';
  end if;
end
$$;

-- ===== 1. Global vocabulary + baselines =====
-- Schema `private`, the flag_definitions / approval_policy_definitions shape (0059:24,
-- 0070:37): platform vocabulary, owned by no tenant, no org_id -- and therefore no
-- scope_registry row, because A1 scans public base tables only (the 0059:21-23 note).
--
-- The baseline IS today's behaviour: autonomy off. So an organization with no configuration
-- row finds exactly the rule that holds now -- a human decides. The schema cannot change
-- behaviour merely by existing.
create table private.autonomy_policy_definitions (
  -- Same shape as the tenant table's key, deliberately: a definition whose key this pattern
  -- rejects would be UNCONFIGURABLE per tenant, and would fail as a raw constraint violation
  -- inside the command rather than by name. The two keys are one vocabulary.
  policy_key             text primary key check (policy_key ~ '^[a-z0-9_.-]+$'),
  description            text not null,
  -- Off. Always off -- and the CHECK is what makes that sentence true rather than merely
  -- intended. The column exists so the fallback answer has ONE home instead of being a literal
  -- in three readers; it is not a lever.
  --
  -- WITHOUT THE CHECK THIS COLUMN WAS A FORCE-ON SWITCH, and review proved it: one
  -- `update ... set baseline_enabled = true` turned autonomy on for every tenant that had
  -- never been configured -- which is all of them, since unconfigured is the default -- with
  -- no reason, no audit row and no per-tenant decision. Measured answer for an unconfigured
  -- organization after that single UPDATE: `configured=false, enabled=TRUE, min=NULL`. That is
  -- the exact inversion of the owner's ruling that default-off is scope rather than caution,
  -- and it sat in the same table, same row and same privilege as the kill switch while the
  -- comment below claimed no force-on counterpart existed.
  baseline_enabled       boolean not null default false
    constraint autonomy_definitions_baseline_off check (baseline_enabled = false),
  -- The documented floor. A tenant configuration may sit ABOVE it and never below (§3). This
  -- is the number OPEN-DECISIONS #109 calls a guess.
  --
  -- THE ASYMMETRY WORTH NAMING, now that baseline_enabled is locked off: this column is the
  -- one remaining loosening lever in this table. The switch cannot be flipped on, but the
  -- number can still be walked down to 0.001 by the same actor and the same UPDATE, and every
  -- tenant floor moves with it. That is INTENDED, not an oversight -- #109 states that
  -- lowering the floor is a deliberate out-of-band platform act, the escape hatch for the day
  -- calibration finally runs. It is deliberately not constrained, because constraining it
  -- would leave no way to act on a measurement. The protection it has is procedural, not
  -- structural: #109 says it must not be lowered before the 50-document calibration has
  -- actually run. A reader should know which of these two columns is a fence and which is a
  -- documented promise.
  baseline_min_confidence numeric(4,3) not null default 0.900
    check (baseline_min_confidence > 0 and baseline_min_confidence <= 1),
  -- Off-only, the 0059:29-32 semantics: a raised kill switch forces autonomy OFF for every
  -- organization regardless of configuration. There is deliberately NO force-on counterpart --
  -- and with the constraint above, that is now a property of the schema instead of a promise
  -- in a comment. The only direction a platform lever may move authority is down.
  kill_switch            boolean not null default false
);
revoke all on table private.autonomy_policy_definitions from public, anon, authenticated;

-- One key, because there is one decision. Naming a decision point is not deciding it.
insert into private.autonomy_policy_definitions
  (policy_key, description, baseline_enabled, baseline_min_confidence, kill_switch)
values
  ('document.interpretation',
   'May the system act on a model interpretation of an uploaded document -- creating the '
   'financial record, linking it, and correcting a missing line -- without a human approving '
   'it first. Baseline is the live rule: no, a human decides. The floor 0.900 applies to BOTH '
   'the document-type confidence and the supplier-match confidence, and is an UNCALIBRATED '
   'default (OPEN-DECISIONS #109), not a measured one.',
   false, 0.900, false);

-- ===== 2. Per-organization configuration =====
-- Shape-1 (browser-readable), the org_flag_configurations reasoning (0059:41-44): tenant
-- members may SEE the rule that governs them, the table holds no secret, and writes are
-- RPC-only.
--
-- ONE ROW, TWO COLUMNS -- not two independent settings. The switch and the number are one
-- decision: a threshold without a switch governs nothing, and a switch without a threshold is
-- "always". Storing them as two rows that can drift apart would make the second state
-- representable, which is precisely the silent reading this wave must not permit. NOT NULL
-- plus the range CHECK makes "on, no threshold" impossible to write at all -- the same
-- structural-fence idiom as document_filings_reversal_shape (0075, decision #110).
create table org_autonomy_policies (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  policy_key       text not null check (policy_key ~ '^[a-z0-9_.-]+$'),
  autonomy_enabled boolean not null default false,
  -- A confidence is a fraction. 0 would mean "apply to everything", 2 would mean "apply to
  -- nothing" while the operator believed they had switched it on. Both are refused here and
  -- again, by name, in the command.
  min_confidence   numeric(4,3) not null default 0.900
    constraint org_autonomy_policies_confidence_range
      check (min_confidence > 0 and min_confidence <= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- One row per (organization, policy): a reader resolves one answer, not a stack.
  constraint org_autonomy_policies_org_key unique (org_id, policy_key)
  -- No FK to private.autonomy_policy_definitions ON PURPOSE, the 0059:66-68 / 0070:77-80
  -- reasoning: an orphaned configuration row must surface as a preflight anomaly rather than
  -- as a broken cascade the day a definition retires.
);

create trigger org_autonomy_policies_touch
  before update on org_autonomy_policies
  for each row execute function set_updated_at();

alter table org_autonomy_policies enable row level security;
create policy org_autonomy_policies_select on org_autonomy_policies
  for select to authenticated using (org_id = auth_org());
revoke all on table org_autonomy_policies from public, anon, authenticated;
grant select on table org_autonomy_policies to authenticated;

-- service_role IS a writer unless it is told otherwise: Supabase grants it full DML on every
-- new public table by default (measured here as `service_role=arwdDxtm/postgres`). Review
-- proved what that means for this table specifically -- `set role service_role` then a plain
-- INSERT stored min_confidence = 0.050, BELOW the documented floor, with zero reasoned audit
-- rows. The tighten-only law and the mandatory reason both live inside the command body, so a
-- writer that skips the command skips both.
--
-- Revoking costs nothing here, which is why this is not the "Supabase default, same as
-- org_flag_configurations" shrug: the ONLY legitimate writer is a SECURITY DEFINER owned by
-- postgres, which writes as postgres regardless of the caller's own grants. The future
-- apply-interpretation command is likewise a definer and is unaffected. SELECT stays, because
-- a trusted server reading its own tenant's configuration is legitimate.
--
-- TRUNCATE is in the list for a reason that is easy to miss: it is not DELETE and it fires NO
-- ROW TRIGGER, so `truncate org_autonomy_policies` empties every tenant's configuration and
-- audit_logs records NOTHING (measured in review: audit rows before = 1, after = 1). The
-- direction is safe -- everyone becomes unconfigured, which resolves to OFF -- so it grants no
-- authority. But a silent wipe of the table that governs whether a model may write financial
-- records is not something to leave reachable when closing it costs one word.
--
-- This revoke makes org_autonomy_policies the ONLY public table in the schema without
-- service_role CRUD, which contradicts a shipped assertion. That is resolved by naming this
-- table as an explicit, reasoned exception in supabase/tests/p0_client_dml_acl.sql -- not by
-- restoring the grant, which would reopen the bypass above.
revoke insert, update, delete, truncate on table org_autonomy_policies from service_role;

create trigger org_autonomy_policies_audit
  after insert or update or delete on org_autonomy_policies
  for each row execute function audit_row_change();

-- ===== 3. The one reasoned write command =====
-- Platform operator + mandatory reason + audit to the TARGET organization, in one transaction
-- -- platform_set_org_flag exactly (0059:232) and platform_set_approval_policy exactly
-- (0070:108), and the same #86 answer to "who writes this": the operator, not the owner. The
-- owner of a business does not get to grant a model the right to author their own ledger from
-- a settings screen. A future owner-facing surface needs no schema change, only a new reasoned
-- RPC that carries its own argument for why an owner may do this.
--
-- THE TIGHTEN-ONLY LAW APPLIED TO A NUMBER (#104): a configuration may demand MORE confidence
-- than the documented floor and never less. A configuration that could lower the floor would
-- let an unvalidated guess be quietly walked down toward zero, one reasoned call at a time,
-- until a model is authoring records at coin-flip confidence. Lowering the floor is a
-- deliberate platform act on the private baseline, out-of-band, exactly like raising a kill
-- switch or adding a platform admin -- and it should not happen before the calibration in
-- OPEN-DECISIONS #109 has actually been run.
--
-- The body names no enforced table, so A5 needs no exemption row -- the registry stays at 57.
create or replace function platform_set_autonomy_policy(
  p_org_id           uuid,
  p_policy_key       text,
  p_autonomy_enabled boolean,
  p_min_confidence   numeric,
  p_reason           text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_policy_key, '')), '');
  v_definition private.autonomy_policy_definitions;
  v_id uuid;
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'autonomy_policy_reason_required' using errcode = '22023';
  end if;
  -- A null, a zero, a negative and anything above 1 are all refused HERE and by name, not left
  -- to a constraint. "The threshold was null so everything qualified" must not be reachable,
  -- and an operator who mistyped deserves to be told which rule they broke.
  if p_org_id is null or v_key is null or p_autonomy_enabled is null
     or p_min_confidence is null
     or p_min_confidence <= 0 or p_min_confidence > 1 then
    raise exception 'autonomy_policy_invalid' using errcode = '22023';
  end if;

  select * into v_definition
  from private.autonomy_policy_definitions d
  where d.policy_key = v_key;
  if not found then
    raise exception 'autonomy_policy_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  if p_min_confidence < v_definition.baseline_min_confidence then
    raise exception 'autonomy_policy_not_tightening' using errcode = '22023';
  end if;

  insert into org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values (p_org_id, v_key, p_autonomy_enabled, p_min_confidence)
  on conflict (org_id, policy_key) do update
    set autonomy_enabled = excluded.autonomy_enabled,
        min_confidence = excluded.min_confidence,
        updated_at = now()
  returning id into v_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    p_org_id, v_actor, 'autonomy_policy_configured', 'org_autonomy_policies', v_id,
    jsonb_build_object(
      'policy_key', v_key,
      'autonomy_enabled', p_autonomy_enabled,
      'min_confidence', p_min_confidence),
    v_reason
  );
  return v_id;
end
$$;

revoke all on function platform_set_autonomy_policy(uuid, text, boolean, numeric, text)
  from public, anon;
grant execute on function platform_set_autonomy_policy(uuid, text, boolean, numeric, text)
  to authenticated;

-- ===== 4. The evaluator -- the honest thing the automation reads =====
-- ONE implementation, TWO doors, and the reason is not tidiness.
--
-- The command that will consume this (apply_document_interpretation) runs on the trusted
-- server: SECURITY DEFINER, granted to service_role, invoked by an Edge Function that carries
-- no user JWT. For that caller auth_org() is NULL. A single tenant-scoped reader would
-- therefore have answered "disabled" to the ONLY caller that matters -- fail-closed in the
-- most useless possible way, and the kind of gap that gets closed later by the consumer
-- reading the table directly and quietly reimplementing the precedence without the kill
-- switch. So the resolution lives in `private`, takes its organization EXPLICITLY, and the
-- browser-facing reader is a two-line wrapper over it.
--
-- Fail-closed in every direction: an unconfigured tenant is disabled; a NULL organization is
-- disabled; a raised kill switch forces disabled; and an unconfigured tenant's threshold comes
-- back NULL -- a mark, not a zero (the 0070:199 rule). Zero would be the worst possible
-- fallback here, because a caller comparing `confidence >= threshold` against 0 would
-- auto-apply everything.
--
-- SECURITY DEFINER because the kill switch lives in `private`, which the browser role cannot
-- read. The tenant boundary is therefore pinned EXPLICITLY by the passed organization, never
-- implicitly by RLS -- and this function is revoked from every browser role and reachable only
-- from another definer or a superuser session (the private.record_integration_failure
-- precedent, 0066).
create or replace function private.autonomy_policy_for_org(
  p_org_id     uuid,
  p_policy_key text
) returns table (
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
  v_key text := nullif(btrim(coalesce(p_policy_key, '')), '');
  v_definition private.autonomy_policy_definitions;
begin
  if v_key is null then
    raise exception 'autonomy_policy_key_invalid' using errcode = '22023';
  end if;

  select * into v_definition
  from private.autonomy_policy_definitions d
  where d.policy_key = v_key;
  if not found then
    raise exception 'autonomy_policy_unknown' using errcode = 'P0002';
  end if;

  -- `and c.min_confidence is not null` is the SAME invariant as the NOT NULL column, restated
  -- where it is actually consumed. The column protects the ROW; this protects the ANSWER, and
  -- the answer is what a caller acts on. Enabled-with-no-threshold was reachable through the
  -- unconfigured branch (a NULL join row supplies a NULL threshold, and only the baseline
  -- decided `enabled`), and it does NOT stay safe on the way out: `confidence >= null` is NULL
  -- in SQL and fails closed, but the same comparison in TypeScript after PostgREST is
  -- `0.42 >= null` -> null coerces to 0 -> TRUE. That is auto-apply-everything, which is the
  -- precise outcome the threshold exists to prevent.
  --
  -- The range is restated here for the SAME reason and by the same argument: if a later
  -- migration drops org_autonomy_policies_confidence_range, `min_confidence = 0` becomes
  -- storable and the answer would be `enabled=true, min=0.000` -- apply-to-everything, which a
  -- NULL check alone does not catch because 0 is not NULL. An invariant worth restating once
  -- is worth restating completely.
  --
  -- Two fences for one invariant on purpose: if a later migration ever drops the baseline-off
  -- constraint or the range CHECK, the answer stays coherent instead of turning every
  -- unconfigured tenant on with no threshold. p13 proves both layerings by dropping the
  -- constraint and checking the answer, then removing the guard and watching the unsafe state
  -- reappear.
  return query
  select v_key,
         c.id is not null,
         not v_definition.kill_switch
           and coalesce(c.autonomy_enabled, v_definition.baseline_enabled)
           and c.min_confidence is not null
           and c.min_confidence > 0 and c.min_confidence <= 1,
         c.min_confidence::numeric,
         v_definition.kill_switch
  from (select 1) probe
  left join org_autonomy_policies c
    on p_org_id is not null and c.org_id = p_org_id and c.policy_key = v_key;
end
$$;
revoke all on function private.autonomy_policy_for_org(uuid, text)
  from public, anon, authenticated;

-- HOW THIS DIFFERS FROM THE FLAG EVALUATOR, stated so nobody has to infer it. The flag
-- evaluator may appear in no other routine at all. This one exists precisely to be called by
-- one future command. What it must NEVER do is appear in an RLS USING / WITH CHECK expression,
-- or decide what a HUMAN may do: role permission stays in RLS and in the commands' own checks,
-- unconditioned on this setting, so a tenant switched on gains no new human privileges and a
-- tenant switched off loses none. p13_document_autonomy_config.sql asserts the policy arm
-- structurally, and asserts that no policy on any other table consults the configuration.
create or replace function evaluate_autonomy_policy(p_policy_key text)
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
begin
  return query select * from private.autonomy_policy_for_org(auth_org(), p_policy_key);
end
$$;

revoke all on function evaluate_autonomy_policy(text) from public, anon;
grant execute on function evaluate_autonomy_policy(text) to authenticated;

comment on function evaluate_autonomy_policy(text) is
  'The calling organization''s autonomy rule for one policy key: is the system permitted to '
  'write a financial record without a human, and above which confidence. Fail-closed -- '
  'unconfigured and killed both resolve to disabled, and an unconfigured threshold is NULL, '
  'never 0. It exists to be read by the apply-interpretation command; it must never appear in '
  'an RLS USING/WITH CHECK expression and must never gate a human''s permission '
  '(ENTERPRISE-SECURITY-MODEL.md:246-251). The 0.900 floor is an UNCALIBRATED documented '
  'default (OPEN-DECISIONS #109), not a measured one.';

-- ===== 5. Registry (A1) + re-assert (the 0058:207-218 idiom, literal 0076) =====
-- org_global: whether a model may author this organization's records is a rule of the
-- organization, not of a branch or a warehouse. A per-legal-entity autonomy setting would be a
-- real product decision, and it is not this one.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('org_autonomy_policies', 'org_global', false);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0076 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
