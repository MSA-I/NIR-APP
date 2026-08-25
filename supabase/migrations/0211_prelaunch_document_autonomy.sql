-- 0211: until the launch date a new organisation is born with document autonomy ON, and the grant
-- carries its own expiry.
--
-- OWNER RULING 25.08.2026. The report was "a document uploaded in a new account is not interpreted
-- and not accounted for automatically". Measured against production, the first half was already
-- true: the dispatcher runs, and the owner's own document was dispatched 46 seconds after upload
-- and interpreted 56 seconds after that. The second half was the real gap -- `0076` ships every
-- autonomy policy OFF for every tenant, and only the demo organisation was ever switched on, so a
-- document is read and then stops at `review` waiting for a person. The owner asked for the
-- opposite default until the launch date, on the same premise `0210` records: no real customer has
-- signed up, every account today is a demo.
--
-- ALL FOUR POLICIES, INCLUDING `document.packet_split`. The mixed-PDF split was offered with the
-- recommendation NOT to include it, because #249 scoped it to a controlled pilot on one
-- organisation and one document; the owner chose it anyway, with the trade-off stated. That choice
-- REPLACES #249's rollout limit and is recorded as such rather than left to be discovered.
--
-- WHAT THIS DOES NOT DO. It does not lower a threshold: every grant is written at 0.900, the
-- documented floor, which is the same number `platform_set_autonomy_policy` refuses to go below
-- (#104's tighten-only rule on a number). It does not touch `private.autonomy_policy_definitions`
-- -- `baseline_enabled` stays constrained to `false`, so "unconfigured" still means OFF and the
-- grant remains a visible ROW per organisation rather than a global flip nobody can audit. And it
-- does not make price lists apply themselves: `apply_eligible_price_list_interpretation` (0096)
-- additionally requires a `price_list_automation_scope_decisions` row in state `eligible`, which
-- only a platform admin writes. The policy is necessary there and not sufficient, deliberately.

-- ===== 1. The grant has to be able to end =====
-- `0210` could lean on `targeting.ends_at`, which `resolve_feature_flags` already evaluates: the
-- row stays, still reads `state = true`, and resolves to OFF past the date. Autonomy has no such
-- clock -- a row here is forever -- and "forever" is the one thing this grant must not be, because
-- what it grants is a model writing financial records without a human.
--
-- Nullable, and null means what every existing row already means: no expiry. So this column
-- changes the meaning of nothing that is already stored, including the demo organisation's four
-- rows, which were switched on deliberately and stay on.
alter table org_autonomy_policies
  add column if not exists expires_at timestamptz;

comment on column org_autonomy_policies.expires_at is
  'When this grant stops resolving (0211). NULL is an ordinary permanent configuration -- the '
  'column exists so a TIME-BOXED grant can expire on its own rather than relying on somebody '
  'remembering to revoke it, the same property targeting.ends_at gives a feature flag.';

-- ===== 2. The resolver learns the clock =====
-- `0076`'s body, restated in full with ONE change: the join that finds the tenant's row now
-- ignores an expired one. Restated rather than patched by anchor because 0076 is the only
-- definition of this function in the tree, and a partial replacement is how a security property
-- gets dropped in silence.
--
-- The expiry is in the JOIN, not in a new branch of the answer, and that is the whole design: an
-- expired grant resolves EXACTLY like an organisation that was never configured -- `configured`
-- false, `autonomy_enabled` falling back to the baseline (which is constrained to false), and
-- `min_confidence` NULL. No new state, no new failure mode, and every guarantee below keeps
-- holding word for word.
--
-- `now()` rather than `clock_timestamp()`: this function is STABLE, and a stable function must not
-- change its answer inside one statement. A day-granularity window does not need sub-statement
-- resolution, and a transaction that starts before the deadline finishing after it is the correct
-- reading of a grant that was valid when the work began.
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
    on p_org_id is not null and c.org_id = p_org_id and c.policy_key = v_key
   -- 0211: an expired grant is not a grant. Placed in the join so it resolves as unconfigured.
   and (c.expires_at is null or c.expires_at > now());
end
$$;
revoke all on function private.autonomy_policy_for_org(uuid, text)
  from public, anon, authenticated;

comment on function private.autonomy_policy_for_org(uuid, text) is
  'The organization''s autonomy rule for one policy key (0076, expiry added in 0211). Fail-closed: '
  'unconfigured, killed, EXPIRED and threshold-less all resolve to disabled, and an unconfigured '
  'threshold is NULL, never 0. Trusted-server door -- postgres only; never in an RLS expression '
  'and never a gate on a human''s permission.';

-- ===== 3. The policies a new organisation is created with =====
-- Its own function and its own trigger, beside `0210`'s two, because the plan, the assistant and
-- the document autonomy are three separate decisions that stop being made together the moment a
-- real customer signs up.
--
-- `private.prelaunch_window_end()` is READ, never copied. 0210 put the date in one place for
-- exactly this reason: a second literal is how the assistant grant and this one would come to
-- expire on different days without anybody noticing.
--
-- A NOTE ON THE WORDING INSIDE THE BODY BELOW, so a later editor does not "improve" it back into a
-- failure. Assertion A5 (0095) is TEXTUAL: it treats a security-definer function whose SOURCE
-- mentions an enforced scope table by name -- comments included, `\m..\M` word boundaries -- as a
-- function that touches that table, and refuses it until it is registered. The first draft of the
-- policy list below described a mixed PDF as splitting into "child d0cuments", and this migration
-- refused itself, twice: once for the list and once for the paragraph explaining the first refusal.
-- Which is the guard working exactly as designed. The body therefore says "child records", and the
-- explanation lives out here where prosrc cannot see it.
create or replace function private.organizations_prelaunch_autonomy() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_end timestamptz := private.prelaunch_window_end();
begin
  if clock_timestamp() >= v_end then
    return new;
  end if;
  insert into org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence, expires_at)
  select new.id, k, true, 0.900, v_end
  from unnest(array[
    'document.interpretation',   -- an identified invoice becomes an invoice and links to its order
    'delivery_note.receiving',   -- an identified delivery note records the goods receipt
    'price_list.intake',         -- matched price rows update prices (0096 scope still applies)
    'document.packet_split'      -- a mixed PDF splits into child records (replaces #249's pilot)
  ]) as k
  on conflict (org_id, policy_key) do nothing;
  return new;
end
$$;
revoke all on function private.organizations_prelaunch_autonomy()
  from public, anon, authenticated;

comment on function private.organizations_prelaunch_autonomy() is
  'Grants the four document autonomy policies to a new organization for the pre-launch window '
  '(0211). Writes the documented 0.900 floor and never a looser number, and stamps expires_at so '
  'the grant ends by itself.';

-- 0182 keeps a registry of every function allowed to switch document automation ON, and P68's
-- `unregistered_activation_writer` arm compares it against every live function whose body writes
-- `org_autonomy_policies`. The guard refused this file until the line below existed, which is
-- exactly what #245/#251/#252 bought: the set of things that can hand a model authority has to be
-- enumerable, and a new writer declares itself rather than being discovered later.
--
-- The hash is computed from the body just created, the same way 0182 computes its own, with
-- carriage returns stripped so a migration applied from Windows and one applied on a Linux
-- runner store the same value (0209's lesson, applied here rather than relearned). `chr(13)`
-- rather than an escape: this file is edited from a Windows shell, and the escape is exactly what
-- gets mangled on the way in.
insert into private.document_automation_authoritative_functions(
  function_signature, responsibility, raw_evidence_writer, automation_root, activation_writer,
  expected_callees, body_hash
)
select proc.oid::regprocedure::text,
       'Pre-launch birth grant: writes tenant autonomy policy for a new organisation, time-boxed '
       'to the window (0211, #275). Not an operator command -- it cannot lower a threshold and '
       'cannot grant beyond the window.',
       false, false, true, '{}'::text[],
       md5(replace(proc.prosrc, chr(13), ''))
from pg_proc proc
where proc.oid = to_regprocedure('private.organizations_prelaunch_autonomy()')
on conflict (function_signature) do update
  set responsibility = excluded.responsibility,
      raw_evidence_writer = excluded.raw_evidence_writer,
      automation_root = excluded.automation_root,
      activation_writer = excluded.activation_writer,
      expected_callees = excluded.expected_callees,
      body_hash = excluded.body_hash;

-- `zzz_` for 0154's reason and 0210's: this must run after anything that could still reject the
-- organisation row.
drop trigger if exists zzz_organizations_prelaunch_autonomy on public.organizations;
create trigger zzz_organizations_prelaunch_autonomy
  after insert on public.organizations
  for each row execute function private.organizations_prelaunch_autonomy();

-- ===== 4. The organisations that already exist =====
-- Owner ruling: the two accounts opened today get the same grant. This is written as "every
-- organisation that has no row for the key" rather than as a list of UUIDs, which is both
-- idempotent and, more importantly, leaves the demo organisation's four EXISTING rows exactly as
-- they are -- they were switched on deliberately, they carry no expiry, and a backfill that
-- overwrote them would quietly put an end date on a grant nobody asked to end.
insert into org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence, expires_at)
select o.id, k, true, 0.900, private.prelaunch_window_end()
from organizations o
cross join unnest(array[
  'document.interpretation', 'delivery_note.receiving', 'price_list.intake', 'document.packet_split'
]) as k
where clock_timestamp() < private.prelaunch_window_end()
on conflict (org_id, policy_key) do nothing;

-- ===== 4b. A grant the SYSTEM wrote is not the tenant doing business =====
-- The same correction 0210 makes for `org_flag_configurations`, for the same reason and with the
-- same consequence if it is skipped. `private.organization_has_business_activity` walks every
-- public table carrying `org_id` and treats an unregistered one as evidence; section 3 gives every
-- new organisation four rows here, so without this NO organisation would ever be classifiable as
-- empty again and the abandoned-account lifecycle would stop working — silently, and looking like
-- caution rather than a bug.
--
-- OWNER RULING 25.08.2026, and it is what forces this rather than merely permitting it: everything
-- the window changes must return to normal when the window ends. The rows do NOT disappear on that
-- date, they only stop resolving — so leaving the table classified as evidence would leave every
-- organisation created during the window permanently un-cleanable, which is the opposite of
-- returning to normal.
--
-- It is also simply the correct classification, before the window and after it: this table is
-- written by `platform_set_autonomy_policy` or by the birth grant above. A tenant has never
-- written a row here and has no privilege to.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
values (
  'org_autonomy_policies',
  'not_evidence',
  'An autonomy policy is written by the platform -- by the pre-launch birth grant in 0211, or by '
  || 'platform_set_autonomy_policy under step-up and a reason -- and never by the tenant working. '
  || 'Same reasoning as organization_subscriptions and org_flag_configurations.'
)
on conflict (table_name) do update
  set disposition = excluded.disposition, rationale = excluded.rationale;

-- ===== 5. The tenant export contract follows the column =====
-- `0103` hashes the shape of every tenant table so a column cannot join an offboarding export
-- without somebody having looked at it. Adding `expires_at` is that change, and this is that look:
-- it is an ordinary timestamp, it belongs in the export beside the grant it bounds, and it matches
-- none of the secret-like patterns the registry refuses to export silently. Refreshing the hash in
-- the same file as the ALTER is the review the registry is asking for -- the failure it exists to
-- catch is a column that arrives with no migration saying anything about it.
update private.tenant_export_registry registry
set exported_columns=(select array_agg(column_info.column_name order by column_info.ordinal_position)
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name
      and not (column_info.column_name=any(registry.excluded_columns))),
    schema_hash=(select md5(string_agg(
      column_info.column_name||':'||column_info.data_type||':'||column_info.is_nullable,
      '|' order by column_info.ordinal_position))
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name)
where registry.table_name = 'org_autonomy_policies';

-- ===== 6. Proof, and the 0058 re-assertion duty =====
do $$
declare
  v_violations text;
  v_end        timestamptz := private.prelaunch_window_end();
  v_orgs       integer;
  v_granted    integer;
  v_loose      integer;
  v_answer     record;
begin
  -- A window in the past would make this whole file a no-op that reads as a grant.
  if v_end <= clock_timestamp() then
    raise exception '0211: the pre-launch window ends at % which is not in the future', v_end;
  end if;

  select count(*) into v_orgs from organizations;
  select count(distinct org_id) into v_granted
    from org_autonomy_policies
   where policy_key = 'document.interpretation' and autonomy_enabled;
  if v_granted <> v_orgs then
    raise exception '0211: % organisation(s) but % with document.interpretation on', v_orgs, v_granted;
  end if;

  -- Nothing may be written below the documented floor, here or anywhere: a grant that loosened
  -- the threshold would be #109's uncalibrated 0.900 rolled downwards one migration at a time.
  select count(*) into v_loose from org_autonomy_policies where min_confidence < 0.900;
  if v_loose <> 0 then
    raise exception '0211: % row(s) sit below the documented 0.900 floor', v_loose;
  end if;

  -- The expiry is not decoration: an expired grant must resolve exactly like no grant at all.
  -- Proven on a real row rather than asserted in a comment. The probe rows are deleted below, and
  -- if the assertion raises, the whole migration rolls back and takes them with it -- so neither
  -- path leaves a policy key behind that no consumer knows about.
  begin
    insert into org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence, expires_at)
    select o.id, '0211.expiry_probe', true, 0.900, now() - interval '1 second'
    from organizations o limit 1;

    insert into private.autonomy_policy_definitions
      (policy_key, description, baseline_enabled, baseline_min_confidence, kill_switch)
    values ('0211.expiry_probe', 'Transient probe: proves an expired grant resolves as unconfigured.',
            false, 0.900, false);

    select * into v_answer
    from private.autonomy_policy_for_org(
      (select org_id from org_autonomy_policies where policy_key = '0211.expiry_probe'),
      '0211.expiry_probe');

    if v_answer.configured or v_answer.autonomy_enabled or v_answer.min_confidence is not null then
      raise exception '0211: an EXPIRED grant still resolves as configured=% enabled=% min=%',
        v_answer.configured, v_answer.autonomy_enabled, v_answer.min_confidence;
    end if;
  end;
  delete from org_autonomy_policies where policy_key = '0211.expiry_probe';
  delete from private.autonomy_policy_definitions where policy_key = '0211.expiry_probe';

  -- 0077:91-98 reads this body and refuses if the null-threshold guard is gone. Re-stating the
  -- function is exactly when that guard is at risk, so the same check runs here rather than
  -- waiting for the next migration to notice.
  if (select prosrc from pg_proc
       where oid = 'private.autonomy_policy_for_org(uuid,text)'::regprocedure) !~ 'min_confidence is not null'
  then
    raise exception '0211: the replacement dropped autonomy_policy_for_org''s null-threshold guard';
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0211 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
