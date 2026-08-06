-- p13 -- the autonomy switch and the number behind it (migration 0076).
--
-- Run against a freshly reset disposable local database after 0076. Everything is rolled
-- back; the suite never leaves business data behind.
--
-- WHY THIS IS NOT IN p4_flags_identity.sql, and why it is not a feature flag at all.
--
--   The owner granted the system permission to write a financial record without a human,
--   above a confidence threshold. The obvious home was the 0059 flag infrastructure. It is
--   the wrong home, and the gate already says so:
--
--     * SECURITY-MODEL §8 -- "a flag can only turn a capability OFF, never grant one ... so a
--       flag switched on by mistake cannot open a door." A switch whose ON state lets a model
--       author an invoice is the definition of a switch that opens a door when flipped by
--       mistake. Decision #104 wrote the same sentence from the other side: configuration
--       that can loosen is "a permission grant wearing a configuration costume".
--     * p4_flags_identity.sql:162-167 asserts that NO routine in public/private other than
--       resolve_feature_flags itself mentions resolve_feature_flags. The moment the future
--       apply_document_interpretation reads the switch through the flag evaluator, THAT
--       EXISTING ASSERTION FAILS. The flag route is not merely discouraged, it is closed.
--     * org_flag_configurations.state is boolean. The only non-boolean it carries is
--       `targeting`, which is rollout-only (unit_ids / percentage / starts_at / ends_at),
--       evaluated solely inside resolve_feature_flags, and which IGNORES UNKNOWN KEYS -- so a
--       threshold parked there would be stored, never validated and never read.
--
--   So 0076 follows 0070 (approval policies) instead: a per-organization POLICY, one reasoned
--   platform command, a tighten-only law, and an evaluator. This suite defends that shape.
--
-- What it proves, one area per paragraph:
--
--   (a) OFF is the state of the world. No organization anywhere is born with autonomy, the
--       baseline says false, and a tenant that was never configured evaluates to disabled with
--       a NULL threshold -- a mark, not a zero (the 0070:199 rule).
--   (b) The browser cannot write either setting, table-level or column-level, nor read the
--       private baseline. It MAY read its own configuration (Shape-1, the 0059:41-44 reason).
--   (c) The one write path demands platform membership, a reason, a known key and a real
--       organization, and audits to the TARGET organization -- platform_set_org_flag exactly.
--   (d) The number is fenced twice and cannot mean "always": null, 0, 2 and a negative are all
--       refused BY NAME, and 0.80 is refused as a loosening of the documented floor. A tenant
--       may demand MORE confidence (0.95) and never less.
--   (e) "Autonomy on, no threshold" is structurally unrepresentable -- NOT NULL plus a range
--       CHECK -- so the silent reading "on means always" has nowhere to live.
--   (f) Tenant isolation, and the off-only kill switch (0059:29-32 semantics: it forces off
--       everywhere and has no force-on counterpart).
--   (g) Two mutation proofs: strip the tighten-only floor and 0.80 lands, showing the floor is
--       the ONLY thing standing there; drop the range CHECK and a 2.0 threshold lands, showing
--       the constraint is what refuses once the command guard is gone. Both restore by
--       savepoint rollback (the p11/p5 idiom).
--
-- One deliberate difference from the flag law, stated so nobody has to guess: the flag
-- evaluator may appear in NO other routine. THIS evaluator exists precisely to be called by
-- one future command (apply_document_interpretation, C2). What it must never do is appear in
-- an RLS USING/WITH CHECK expression or decide what a HUMAN may do -- human permission stays
-- in RLS and in the commands' own role checks, unconditioned on this setting. Only the policy
-- arm is asserted below, and that is the whole difference.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p13_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P13 autonomy config assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p11_document_filing.sql:60-70 idiom. Role is switched with set_config
-- rather than SET LOCAL ROLE so the same helper works inside PL/pgSQL, where an aborted
-- subtransaction also rolls the GUC back for us.
create function pg_temp.p13_become(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub::text)::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function pg_temp.p13_untrusted_off()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
end
$$;

-- Platform operators have no profile at all: platform work is cross-tenant and auth_org()
-- answers NULL for them (the p4_flags_identity.sql:84-85 fixture shape). They act as the
-- trusted session, not as the browser role.
create function pg_temp.p13_become_operator(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub::text)::text, true);
  perform set_config('role', 'none', true);
end
$$;

create function pg_temp.p13_trusted()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end
$$;

-- Runs a statement as one actor and returns the message it raised, or null on success. Keeps
-- every negative assertion NAMING the error it expects rather than merely observing failure.
create function pg_temp.p13_error(p_sub uuid, p_sql text, p_operator boolean default false)
returns text
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    if p_operator then
      perform pg_temp.p13_become_operator(p_sub);
    else
      perform pg_temp.p13_become(p_sub);
    end if;
    execute p_sql;
    perform pg_temp.p13_untrusted_off();
    return null;
  exception when others then
    v_message := sqlerrm;
    perform pg_temp.p13_untrusted_off();
    return v_message;
  end;
end
$$;

-- The evaluated answer for one actor, flattened to 'configured|enabled|min|kill'. A NULL
-- threshold renders as the literal 'null' so the dash-not-zero rule is assertable.
create function pg_temp.p13_evaluate(p_sub uuid, p_key text default 'document.interpretation')
returns text
language plpgsql
as $$
declare
  v_row record;
  v_out text;
begin
  perform pg_temp.p13_become(p_sub);
  select * into v_row from public.evaluate_autonomy_policy(p_key);
  v_out := coalesce(v_row.configured::text, '?') || '|'
        || coalesce(v_row.autonomy_enabled::text, '?') || '|'
        || coalesce(v_row.min_confidence::text, 'null') || '|'
        || coalesce(v_row.kill_switch::text, '?');
  perform pg_temp.p13_untrusted_off();
  return v_out;
end
$$;

-- What ONE actor can actually see of the configuration table, under RLS.
create function pg_temp.p13_visible_policies(p_sub uuid)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  perform pg_temp.p13_become(p_sub);
  select count(*) into v_count from public.org_autonomy_policies;
  perform pg_temp.p13_untrusted_off();
  return v_count;
end
$$;

-- ===== (a) OFF is the state of the world =====
-- Asserted BEFORE any fixture exists: whatever this database already contains -- the demo
-- tenant, every migration that ran -- nothing switched autonomy on anywhere. This is the
-- assertion that would catch a future migration "helpfully" enabling it for existing tenants.
select pg_temp.p13_assert(
  (select count(*) from public.org_autonomy_policies where autonomy_enabled) = 0,
  'no organization anywhere may be born with autonomy enabled -- a migration that turns it '
  || 'on for existing tenants is exactly what must not happen');

select pg_temp.p13_assert(
  exists (
    select 1 from private.autonomy_policy_definitions
    where policy_key = 'document.interpretation'
      and baseline_enabled = false
      and baseline_min_confidence = 0.900
      and kill_switch = false),
  'the baseline must be OFF at 0.900 with no kill switch raised');

-- The decision, pinned so it cannot drift back. A future agent handed the same brief will be
-- told to build this "on the 0059 flag infrastructure"; this assertion is the note that
-- catches it. If autonomy ever becomes a flag key, the reasoning at the top of this file was
-- lost and the p4 assertion about resolve_feature_flags is about to fail somewhere else.
select pg_temp.p13_assert(
  not exists (
    select 1 from private.flag_definitions where flag_key ~ 'autonomy')
  and not exists (
    select 1 from public.org_flag_configurations where flag_key ~ 'autonomy'),
  'autonomy must never be modelled as a feature flag -- a flag may only turn a capability '
  || 'off, and this one grants the authority to write a financial record (SECURITY-MODEL §8)');

-- ===== Fixtures =====
insert into organizations (id, name, status) values
  ('13000000-0000-4000-8000-000000000001', 'P13 autonomy tenant A', 'active'),
  ('13000000-0000-4000-8000-000000000002', 'P13 autonomy tenant B', 'active');

insert into auth.users (id, email) values
  ('23000000-0000-4000-8000-000000000001', 'p13-owner-a@example.test'),
  ('23000000-0000-4000-8000-000000000002', 'p13-owner-b@example.test'),
  ('23000000-0000-4000-8000-000000000010', 'p13-platform-op@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001',
   'P13 Owner A', 'owner'),
  ('23000000-0000-4000-8000-000000000002', '13000000-0000-4000-8000-000000000002',
   'P13 Owner B', 'owner');

insert into platform_admins (user_id, note) values
  ('23000000-0000-4000-8000-000000000010', 'P13 platform operator fixture');

-- A tenant nobody configured evaluates to disabled, and its threshold is a MARK, not a zero.
-- Zero would be a claim about the world -- and the worst possible one here, because a reader
-- comparing `confidence >= 0` would auto-apply everything.
select pg_temp.p13_assert(
  pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'false|false|null|false',
  'an unconfigured tenant must evaluate to unconfigured, disabled, threshold NULL');

-- ===== (b) The browser writes nothing, and reads no baseline =====
-- Structural first: "the RPC is the only write path" must be TRUE, not intended. A permissive
-- policy plus a column grant IS a write path (the pre-0061 bank_details lesson), so both are
-- scanned -- the p4_flags_identity.sql:882-895 idiom.
-- service_role is in this list because the message says "the only writer", and review found
-- the gap the shorter list hid: Supabase grants service_role full DML on every new public
-- table, so `set role service_role` + a plain INSERT stored a threshold BELOW the floor with
-- no reason and no audit. A scan whose predicate is narrower than its claim is how that passed
-- unnoticed. The claim is the writer, so the scan is every non-superuser role that could be one.
select pg_temp.p13_assert(
  not exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) r(role_name)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where has_table_privilege(r.role_name, 'public.org_autonomy_policies'::regclass, p.privilege)
       or (p.privilege in ('INSERT', 'UPDATE')
           and has_any_column_privilege(
                 r.role_name, 'public.org_autonomy_policies'::regclass, p.privilege))),
  'org_autonomy_policies exposes DML to a non-superuser role -- the reasoned command, a '
  || 'SECURITY DEFINER owned by postgres, must be the only writer');

-- Behavioural, because a grant table is not a demonstration. This is the exact call review
-- used to store 0.050 under the 0.900 floor.
select pg_temp.p13_trusted();
do $$
begin
  set local role service_role;
  insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values ('13000000-0000-4000-8000-000000000002', 'document.interpretation', true, 0.050);
  raise exception 'P13 autonomy config assertion failed: service_role wrote past the floor, '
    'the reason and the audit';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p13_trusted();
do $$
begin
  set local role service_role;
  update public.org_autonomy_policies set min_confidence = 0.050;
  raise exception 'P13 autonomy config assertion failed: service_role lowered a threshold '
    'directly';
exception when insufficient_privilege then
  null;
end
$$;

-- SELECT deliberately survives: a trusted server reading its own tenant's configuration is
-- legitimate, and revoking it would push a future reader toward re-deriving the answer.
select pg_temp.p13_assert(
  has_table_privilege('service_role', 'public.org_autonomy_policies'::regclass, 'SELECT'),
  'service_role must keep SELECT -- only its write path is closed');

select pg_temp.p13_assert(
  has_table_privilege('authenticated', 'public.org_autonomy_policies'::regclass, 'SELECT')
  and not has_table_privilege('anon', 'public.org_autonomy_policies'::regclass, 'SELECT'),
  'Shape-1: a tenant member may SEE the configuration that governs them, anon may not');

select pg_temp.p13_assert(
  not has_table_privilege(
        'authenticated', 'private.autonomy_policy_definitions'::regclass, 'SELECT')
  and not has_table_privilege(
        'anon', 'private.autonomy_policy_definitions'::regclass, 'SELECT'),
  'the private baseline is platform vocabulary and carries no browser privilege');

-- Behavioural: the same two writes the browser would attempt.
select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000001',
    $$insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled)
      values ('13000000-0000-4000-8000-000000000001', 'document.interpretation', true)$$
  ) is not null,
  'the browser role must not INSERT an autonomy policy directly');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000001',
    $$update public.org_autonomy_policies set autonomy_enabled = true$$
  ) is not null,
  'the browser role must not UPDATE an autonomy policy directly');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000001',
    $$select count(*) from private.autonomy_policy_definitions$$
  ) is not null,
  'the browser role must not read the private baseline');

-- ===== (c) The one write path =====
-- A tenant owner is not a platform operator. This is the whole point of #86: the owner of the
-- business does not get to grant a model the right to author their invoices from a screen.
select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000001',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.90, 'P13: owner attempt')$$
  ) like '%not_platform_admin%',
  'a tenant owner must not configure autonomy');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.90, '   ')$$, true
  ) like '%autonomy_policy_reason_required%',
  'a change without a reason must be refused by name');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'no.such.policy',
        true, 0.90, 'P13: undefined key')$$, true
  ) like '%autonomy_policy_unknown%',
  'an undefined policy key must be refused by name');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-00000000dead', 'document.interpretation',
        true, 0.90, 'P13: unknown organization')$$, true
  ) like '%organization_unknown%',
  'an unknown organization must be refused by name');

-- ===== (d) The number cannot mean "always" =====
-- Four shapes of "no real threshold", each refused BY NAME. A null, a zero and a negative all
-- read as "apply to everything"; a 2 reads as "apply to nothing" and would silently disable a
-- switch the operator believes they turned on. Neither silence is acceptable.
select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, null, 'P13: null threshold')$$, true
  ) like '%autonomy_policy_invalid%',
  'a NULL threshold must be refused -- it must never silently mean always');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0, 'P13: zero threshold')$$, true
  ) like '%autonomy_policy_invalid%',
  'a zero threshold must be refused -- it must never silently mean always');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, -0.5, 'P13: negative threshold')$$, true
  ) like '%autonomy_policy_invalid%',
  'a negative threshold must be refused');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 2, 'P13: threshold above one')$$, true
  ) like '%autonomy_policy_invalid%',
  'a threshold above 1 must be refused -- a confidence is a fraction, not a score');

-- The tighten-only law (#104 reasoning, applied to a number): a tenant may demand MORE
-- confidence than the documented floor and never less. Lowering the floor is a platform act
-- on the private baseline, out-of-band, exactly like raising a kill switch.
select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.80, 'P13: below the documented floor')$$, true
  ) like '%autonomy_policy_not_tightening%',
  'a threshold below the documented floor must be refused as a loosening');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.95, 'P13: tenant A demands more confidence than the floor')$$, true
  ) is null,
  'a threshold above the floor must be accepted -- tightening is always allowed');

-- ===== (c continued) The audit trail =====
select pg_temp.p13_assert(
  exists (
    select 1 from audit_logs
    where org_id = '13000000-0000-4000-8000-000000000001'
      and action = 'autonomy_policy_configured'
      and entity_type = 'org_autonomy_policies'
      and new_values ->> 'policy_key' = 'document.interpretation'
      and (new_values ->> 'autonomy_enabled')::boolean
      and (new_values ->> 'min_confidence')::numeric = 0.95
      and reason = 'P13: tenant A demands more confidence than the floor'),
  'the change must write a reasoned audit row for the TARGET organization');

select pg_temp.p13_assert(
  exists (
    select 1 from audit_logs
    where org_id = '13000000-0000-4000-8000-000000000001'
      and action = 'insert'
      and entity_type = 'org_autonomy_policies'),
  'the generic row trigger must also record the write, as on every other configured table');

-- The tenant may now READ what governs it, and only that.
select pg_temp.p13_assert(
  pg_temp.p13_visible_policies('23000000-0000-4000-8000-000000000001') = 1
  and pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'true|true|0.950|false',
  'the configured tenant must see exactly its own row and evaluate to enabled at 0.950');

-- ===== (f) Tenant isolation =====
select pg_temp.p13_assert(
  pg_temp.p13_visible_policies('23000000-0000-4000-8000-000000000002') = 0
  and pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000002') = 'false|false|null|false',
  'tenant A''s autonomy must never resolve, or be visible, for tenant B');

-- ===== The trusted-server door -- what the automation will actually call =====
-- apply_document_interpretation runs as a definer granted to service_role, invoked with no
-- user JWT: auth_org() is NULL for it. A tenant-scoped reader alone would have answered
-- "disabled" to the only caller that matters, and the gap would have been closed later by that
-- caller reading the table directly and reimplementing the precedence without the kill switch.
-- private.autonomy_policy_for_org takes the organization explicitly and is the SAME resolution
-- the browser reader delegates to -- one implementation, two doors.
select pg_temp.p13_trusted();
select pg_temp.p13_assert(
  (select configured and autonomy_enabled and min_confidence = 0.950 and not kill_switch
     from private.autonomy_policy_for_org(
       '13000000-0000-4000-8000-000000000001', 'document.interpretation')),
  'the trusted-server door must resolve tenant A with no JWT at all');

select pg_temp.p13_assert(
  (select not configured and not autonomy_enabled and min_confidence is null
     from private.autonomy_policy_for_org(
       '13000000-0000-4000-8000-000000000002', 'document.interpretation')),
  'the trusted-server door must resolve an unconfigured tenant to disabled with a NULL '
  || 'threshold, never a zero');

select pg_temp.p13_assert(
  (select not configured and not autonomy_enabled and min_confidence is null
     from private.autonomy_policy_for_org(null, 'document.interpretation')),
  'a NULL organization must resolve to disabled -- never to "whichever tenant matches"');

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000001',
    $$select * from private.autonomy_policy_for_org(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation')$$
  ) is not null,
  'the browser role must not reach the trusted-server door directly');

-- ===== (e) "On with no threshold" is unrepresentable =====
-- Not "refused by the command" -- UNREPRESENTABLE. The command is one guard; a future second
-- writer, a data fix, a restore, must all hit the same wall. This is the
-- document_filings_reversal_shape idiom of #110 applied to a number.
select pg_temp.p13_trusted();
do $$
begin
  insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values ('13000000-0000-4000-8000-000000000002', 'document.interpretation', true, null);
  raise exception 'P13 autonomy config assertion failed: autonomy on with a null threshold was stored';
exception when not_null_violation then
  null;
end
$$;

do $$
begin
  insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values ('13000000-0000-4000-8000-000000000002', 'document.interpretation', true, 0);
  raise exception 'P13 autonomy config assertion failed: a zero threshold was stored';
exception when check_violation then
  if sqlerrm not like '%org_autonomy_policies_confidence_range%' then raise; end if;
end
$$;

-- And the default, if a writer names no threshold at all, is the documented floor -- not null,
-- not zero.
select pg_temp.p13_assert(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'org_autonomy_policies'
      and column_name = 'min_confidence') like '0.900%',
  'the column default must be the documented floor, so a writer that omits it cannot mean always');

-- ===== (f) The kill switch, off-only =====
-- Raised out-of-band on the private baseline, exactly like platform_admins membership and the
-- 0059 flag kill switch. It forces autonomy OFF for every tenant regardless of configuration,
-- and there is deliberately no force-on counterpart: the only direction a platform lever may
-- move authority is down.
update private.autonomy_policy_definitions
set kill_switch = true where policy_key = 'document.interpretation';

select pg_temp.p13_assert(
  pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'true|false|0.950|true',
  'a raised kill switch must force autonomy off despite an enabling configuration, while '
  || 'still reporting what was configured');

-- And through the trusted-server door too -- the whole point of one implementation: the kill
-- switch cannot be bypassed by the caller that actually writes the records.
select pg_temp.p13_trusted();
select pg_temp.p13_assert(
  (select not autonomy_enabled and kill_switch and configured
     from private.autonomy_policy_for_org(
       '13000000-0000-4000-8000-000000000001', 'document.interpretation')),
  'the kill switch must force off on the trusted-server door as well');

select pg_temp.p13_trusted();
update private.autonomy_policy_definitions
set kill_switch = false where policy_key = 'document.interpretation';

select pg_temp.p13_assert(
  pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'true|true|0.950|false',
  'lowering the kill switch must restore the tenant''s own configuration, unchanged');

-- ===== The baseline is not a lever -- "no force-on" as schema, not as comment =====
-- baseline_enabled sits in the same table, the same row and the same privilege as the kill
-- switch. Review showed that without a constraint it WAS the force-on counterpart the file
-- claimed did not exist: one UPDATE turned autonomy on for every tenant that had never been
-- configured -- all of them, since unconfigured is the default -- with no reason, no audit and
-- no per-tenant decision. Measured before the fix: an unconfigured organization answered
-- `configured=false, enabled=TRUE, min=NULL`.
select pg_temp.p13_trusted();
do $$
begin
  update private.autonomy_policy_definitions
  set baseline_enabled = true where policy_key = 'document.interpretation';
  raise exception 'P13 autonomy config assertion failed: baseline_enabled was flipped on -- '
    'that is a force-on lever, and the file promises none exists';
exception when check_violation then
  if sqlerrm not like '%autonomy_definitions_baseline_off%' then raise; end if;
end
$$;

-- Layered, and this is the half that matters most: the NOT NULL column protects the ROW, but a
-- caller acts on the ANSWER. `enabled=true, min_confidence=null` was reachable through the
-- unconfigured branch, and it does not stay harmless downstream -- `confidence >= null` is
-- NULL in SQL, but `0.42 >= null` in TypeScript after PostgREST is TRUE, because null coerces
-- to 0. So: drop the row fence, flip the baseline, and the answer must STILL be off.
savepoint p13_baseline_mutation;

alter table private.autonomy_policy_definitions
  drop constraint autonomy_definitions_baseline_off;
update private.autonomy_policy_definitions
set baseline_enabled = true where policy_key = 'document.interpretation';

select pg_temp.p13_assert(
  pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000002') = 'false|false|null|false',
  'P13 mutation proof: with the row fence dropped and the baseline flipped ON, an unconfigured '
  || 'tenant must STILL evaluate to disabled -- the answer carries the invariant, not just the row');

select pg_temp.p13_trusted();
select pg_temp.p13_assert(
  (select not autonomy_enabled and min_confidence is null
     from private.autonomy_policy_for_org(
       '13000000-0000-4000-8000-000000000002', 'document.interpretation')),
  'P13 mutation proof: the trusted-server door must hold the same line');

-- And prove that second fence is what is holding it: restore the pre-review evaluator body,
-- which decided `enabled` from the baseline alone, and watch the unsafe state reappear. This
-- stub is a stand-in, not a copy -- its only difference is the missing null guard.
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
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_definition private.autonomy_policy_definitions;
begin
  select * into v_definition
  from private.autonomy_policy_definitions d where d.policy_key = p_policy_key;
  return query
  select p_policy_key,
         c.id is not null,
         not v_definition.kill_switch
           and coalesce(c.autonomy_enabled, v_definition.baseline_enabled),
         c.min_confidence::numeric,
         v_definition.kill_switch
  from (select 1) probe
  left join org_autonomy_policies c
    on p_org_id is not null and c.org_id = p_org_id and c.policy_key = p_policy_key;
end
$$;

select pg_temp.p13_assert(
  (select autonomy_enabled and min_confidence is null
     from private.autonomy_policy_for_org(
       '13000000-0000-4000-8000-000000000002', 'document.interpretation')),
  'P13 mutation proof: without the null guard the answer really is enabled-with-no-threshold '
  || '-- the guard is load-bearing, not decorative');

rollback to savepoint p13_baseline_mutation;

select pg_temp.p13_trusted();
select pg_temp.p13_assert(
  pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000002') = 'false|false|null|false'
  and (select baseline_enabled = false
         from private.autonomy_policy_definitions
        where policy_key = 'document.interpretation'),
  'P13 mutation proof: rolling back must restore both the baseline and the guard');

-- The two keys are one vocabulary: a definition key the tenant table would reject must not be
-- storable, or it would be undefeatably unconfigurable (fails as a constraint violation inside
-- the command instead of by name).
do $$
begin
  insert into private.autonomy_policy_definitions (policy_key, description)
  values ('Document Interpretation', 'a key the tenant table would refuse');
  raise exception 'P13 autonomy config assertion failed: a definition key was accepted that '
    'the tenant configuration table would reject';
exception when check_violation then
  null;
end
$$;

-- ===== The evaluator is not a permission surface =====
-- It may be called by a command (that is its purpose, unlike the flag evaluator). It may NOT
-- appear in an RLS expression: a policy that consulted it would make a row's visibility depend
-- on an autonomy setting, which is the §8 failure in a different costume.
select pg_temp.p13_assert(
  not exists (
    select 1 from pg_catalog.pg_policy pol
    where coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '')
            ~ 'evaluate_autonomy_policy'
       or coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
            ~ 'evaluate_autonomy_policy'),
  'evaluate_autonomy_policy leaked into an RLS expression');

-- The autonomy setting must not have become a condition on any HUMAN''s permission either:
-- no policy anywhere consults the configuration table.
select pg_temp.p13_assert(
  not exists (
    select 1 from pg_catalog.pg_policy pol
    join pg_catalog.pg_class c on c.oid = pol.polrelid
    where c.relname <> 'org_autonomy_policies'
      and (coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '')
             ~ 'org_autonomy_policies'
        or coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
             ~ 'org_autonomy_policies')),
  'an RLS policy conditioned a human''s access on the autonomy configuration');

-- ===== (g) Mutation proof 1: the tighten-only floor has exactly one defender =====
-- The stub below is NOT a copy of the live command with a line removed -- it is a deliberately
-- minimal stand-in whose only job is to perform the same write WITHOUT the floor check. If
-- 0.80 then lands, the floor is proven load-bearing and proven to be the ONLY thing standing
-- there: no constraint catches it, because 0.80 is a perfectly valid confidence.
savepoint p13_floor_mutation;

create or replace function public.platform_set_autonomy_policy(
  p_org_id           uuid,
  p_policy_key       text,
  p_autonomy_enabled boolean,
  p_min_confidence   numeric,
  p_reason           text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values (p_org_id, p_policy_key, p_autonomy_enabled, p_min_confidence)
  on conflict (org_id, policy_key) do update
    set autonomy_enabled = excluded.autonomy_enabled,
        min_confidence = excluded.min_confidence
  returning id into v_id;
  return v_id;
end
$$;

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.80, 'P13 mutation: floor removed')$$, true
  ) is null
  and pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'true|true|0.800|false',
  'P13 mutation proof: with the floor gone, 0.80 lands -- the floor is the only defender and '
  || 'no constraint would have caught it');

rollback to savepoint p13_floor_mutation;

select pg_temp.p13_assert(
  pg_temp.p13_error(
    '23000000-0000-4000-8000-000000000010',
    $$select public.platform_set_autonomy_policy(
        '13000000-0000-4000-8000-000000000001', 'document.interpretation',
        true, 0.80, 'P13: below the documented floor, again')$$, true
  ) like '%autonomy_policy_not_tightening%'
  and pg_temp.p13_evaluate('23000000-0000-4000-8000-000000000001') = 'true|true|0.950|false',
  'P13 mutation proof: rolling the mutation back must restore the floor and the tenant value');

-- ===== (g) Mutation proof 2: the range CHECK is what refuses once the guard is gone =====
savepoint p13_range_mutation;

alter table public.org_autonomy_policies
  drop constraint org_autonomy_policies_confidence_range;

select pg_temp.p13_trusted();
insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
values ('13000000-0000-4000-8000-000000000002', 'document.interpretation', true, 2);

select pg_temp.p13_assert(
  (select min_confidence = 2 from public.org_autonomy_policies
    where org_id = '13000000-0000-4000-8000-000000000002'),
  'P13 mutation proof: with the range CHECK dropped an impossible threshold is storable -- '
  || 'the constraint, not the command, is the second fence');

rollback to savepoint p13_range_mutation;

select pg_temp.p13_trusted();
do $$
begin
  insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence)
  values ('13000000-0000-4000-8000-000000000002', 'document.interpretation', true, 2);
  raise exception 'P13 autonomy config assertion failed: the restored CHECK did not refuse';
exception when check_violation then
  if sqlerrm not like '%org_autonomy_policies_confidence_range%' then raise; end if;
end
$$;

rollback;

\echo 'p13_document_autonomy_config_passed'
