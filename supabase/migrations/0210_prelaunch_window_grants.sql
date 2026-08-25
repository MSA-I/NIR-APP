-- 0210: the pre-launch window -- while every organisation is a demo, every organisation gets the
-- assistant and the premium plan, and the grant knows when to stop.
--
-- OWNER RULING 25.08.2026. Asked why a new account does not see the assistant, the answer was that
-- `assistant.ui` is born off (0164) and only one organisation has it configured. The owner asked
-- for the opposite default until the launch date, on the stated ground that no real customer has
-- signed up yet and every account today is a demo. The alternative offered -- close signup behind
-- an invite code so the grant reaches only people the owner let in -- was declined in favour of
-- leaving signup open. That choice is recorded here because it is the reason this file exists.
--
-- WHAT THIS DOES NOT DO. It does not touch `assistant.drafts`, which is medium risk and whose
-- execution road needs the `assistant.confirmed_actions` policy (0164 §6), and it does not touch
-- the five governance rows. A flag makes the panel visible; the DPA gate still decides whether the
-- provider may be called at all, and that gate lives in the Edge function, not here. Turning the
-- switch on without the exception gives a new tenant a panel that refuses -- which is the correct
-- failure, and the reason the two layers are separate.
--
-- WHY A WINDOW AND NOT A FLIP. `default_state` is global and has no clock: raising it would grant
-- the assistant to every organisation for ever, and the day the DPA is signed nobody would be able
-- to tell a deliberate grant from a forgotten one. The rollout window that 0059 already stores in
-- `targeting.ends_at` expires by itself and is visible in the row, so the grant is legible.

-- ===== 1. One date, in one place =====
-- 2026-12-31 inclusive, which is the same day AI_ASSISTANT_PRELAUNCH_EXCEPTION carries as its
-- `until`. Two copies of a deadline is how the two halves drift apart, so callers read this.
create or replace function private.prelaunch_window_end() returns timestamptz
language sql immutable set search_path = public, pg_temp as $$
  select '2027-01-01T00:00:00+00'::timestamptz
$$;
revoke all on function private.prelaunch_window_end() from public, anon, authenticated;

comment on function private.prelaunch_window_end() is
  'End of the pre-launch demo window, exclusive. Through 2026-12-31 an organisation is created on '
  'premium with the assistant switched on; after it, on free with the assistant off. Must stay '
  'equal to the `until` in AI_ASSISTANT_PRELAUNCH_EXCEPTION.';

-- ===== 2. The plan a new organisation is created on =====
-- 0154's shape, with one branch added. Security properties are re-stated in full rather than
-- inherited: this is the only definition of this function in the tree, so what is written here is
-- what production gets.
create or replace function private.organizations_default_subscription() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into organization_subscriptions (org_id, plan_key, provider)
  values (
    new.id,
    -- After the window this is `free` again with no further migration: the branch reads the clock,
    -- it does not read a row somebody has to remember to change.
    case when clock_timestamp() < private.prelaunch_window_end() then 'premium' else 'free' end,
    'manual')
  on conflict (org_id) do nothing;
  return new;
end
$$;
revoke all on function private.organizations_default_subscription()
  from public, anon, authenticated;

-- ===== 3. The assistant switches a new organisation is created with =====
-- Separate function and separate trigger, because the plan and the assistant are separate
-- decisions that will stop being made together the moment the DPA is signed.
--
-- `targeting.ends_at` is 0059's own rollout window and is evaluated inside resolve_feature_flags:
-- past the date the row still exists, still reads `state = true`, and resolves to OFF. That is the
-- property being bought here -- the grant expires without anybody revoking it, and the row remains
-- as the record of what was granted and until when.
create or replace function private.organizations_prelaunch_assistant() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_end timestamptz := private.prelaunch_window_end();
begin
  if clock_timestamp() >= v_end then
    return new;
  end if;
  insert into org_flag_configurations (org_id, flag_key, state, targeting)
  select new.id, k, true, jsonb_build_object('ends_at', to_char(v_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00"'))
  from unnest(array['assistant.ui', 'assistant.history']) as k
  on conflict (org_id, flag_key) where unit_id is null do nothing;
  return new;
end
$$;
revoke all on function private.organizations_prelaunch_assistant()
  from public, anon, authenticated;

-- `zzz_` like 0154's, for the same reason: this must run after anything that could still reject
-- the organisation row.
create trigger zzz_organizations_prelaunch_assistant
  after insert on public.organizations
  for each row execute function private.organizations_prelaunch_assistant();

-- ===== 3b. A grant the SYSTEM wrote is not the tenant doing business =====
-- `private.organization_has_business_activity` walks every public table carrying `org_id` and
-- treats any unregistered one as evidence. Section 3 gives every new organisation two
-- `org_flag_configurations` rows, so without this the predicate would answer TRUE for an
-- organisation that has never had a supplier, a document or a user -- and the lifecycle would
-- lose the ability to classify an account as empty at all. That is not a test detail: nothing
-- would ever be cleanable again, and the failure would look like caution rather than a bug.
--
-- `organization_subscriptions` is already registered `not_evidence` on exactly this reasoning,
-- and a flag configuration is the same kind of row: written by us, about our rollout, at a moment
-- the tenant did nothing.
--
-- THIS ONE OVERWRITES, WHICH THE REGISTRY'S OTHER WRITERS DELIBERATELY DO NOT. The convention is
-- `do nothing`, so a migration cannot silently reverse a disposition somebody reconsidered. The
-- exception is earned here because the row being replaced is not a reconsidered judgement: it
-- carries the generic default rationale, "a row here exists only because somebody used the
-- product" -- and section 3 above is precisely what makes that sentence untrue for this table.
-- Updating it is answering the old reasoning, not ignoring it.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
values (
  'org_flag_configurations',
  'not_evidence',
  'A feature-flag configuration is written by the platform -- by the pre-launch grant in 0210 at '
  || 'creation, or by platform_set_org_flag -- and never by the tenant working. Same reasoning as '
  || 'organization_subscriptions.'
)
on conflict (table_name) do update
  set disposition = excluded.disposition, rationale = excluded.rationale;

-- ===== 4. The organisations that already exist =====
-- Every one of them is a demo today, which is the premise the owner stated. The plan move is
-- deliberately narrow -- only a row that is still on the seeded `free`/`manual` pair, so a
-- subscription anybody actually configured is never overwritten by this file.
update organization_subscriptions
   set plan_key = 'premium', updated_at = now()
 where plan_key = 'free'
   and provider = 'manual';

insert into org_flag_configurations (org_id, flag_key, state, targeting)
select o.id, k, true,
       jsonb_build_object('ends_at', to_char(private.prelaunch_window_end() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00"'))
from organizations o
cross join unnest(array['assistant.ui', 'assistant.history']) as k
on conflict (org_id, flag_key) where unit_id is null
do update set state = true, targeting = excluded.targeting, updated_at = now();

-- ===== 5. Proof, and the 0058 re-assertion duty =====
do $$
declare
  v_violations text;
  v_free       integer;
  v_ui         integer;
  v_orgs       integer;
  v_end        timestamptz := private.prelaunch_window_end();
begin
  -- The window has to be in the future, or this whole file is a no-op that reads as a grant.
  if v_end <= clock_timestamp() then
    raise exception '0210: the pre-launch window ends at % which is not in the future', v_end;
  end if;

  select count(*) into v_orgs from organizations;
  select count(*) into v_free from organization_subscriptions
   where plan_key = 'free' and provider = 'manual';
  if v_free <> 0 then
    raise exception '0210: % organisation(s) are still on the seeded free plan', v_free;
  end if;

  select count(*) into v_ui from org_flag_configurations
   where flag_key = 'assistant.ui' and unit_id is null and state
     and (targeting ->> 'ends_at')::timestamptz = v_end;
  if v_ui <> v_orgs then
    raise exception '0210: % organisation(s) but % assistant.ui grant(s)', v_orgs, v_ui;
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0210 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
