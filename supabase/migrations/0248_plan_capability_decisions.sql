-- 0248: the bolt #274 asked for, built. A capability may be locked to a plan — and only with a
-- recorded decision behind it, and only in a direction that never punishes an upgrade.
--
-- WHAT WAS ACTUALLY WRONG, AND IT WAS NOT THE CODE. `#196` said tiers differ by VOLUME ONLY, and
-- `p70_launch_plans_and_usage_anchor.sql` enforces it literally: no boolean entitlement may be
-- anything other than true, on any rung. **`#274` cancelled `#196` on 25.08.2026** — "האם יכולת
-- נעולה לפי מסלול — הוכרע: כן; #196 מבוטל" — and replaced it with two conditions of its own:
--
--   (a) every switch-off is RECORDED, so "who closed what, and when" is answerable from the
--       database rather than from a migration comment;
--   (b) MONOTONICITY — a capability open on a cheaper rung must be open on every rung above it,
--       because otherwise an upgrade can silently REMOVE something and the customer discovers it
--       after paying.
--
-- Neither was built. The decision ledger `#274` points at can only hold a NUMBER
-- (`decided_limit numeric not null`), so no row can record a yes/no decision at all — `p51`'s own
-- comment says as much: "a boolean turned off still fails because no decision row can back it".
-- So the product kept behaving as if `#196` still applied, and the first capability to be locked
-- by plan hit a wall built for a rule that had already been withdrawn.
--
-- That capability is `exports.unbranded_pdf` (`0247`, `#297`): the free rung exports the generated
-- PDF with the InPlace mark, and every paid rung exports it clean.
--
-- WHAT THIS FILE DOES NOT DO. It does not decide anything. `#274` decided that locking is allowed,
-- `#297` decided this particular lock, and this migration builds the machinery both of them assume
-- exists. It opens no plan, closes none beyond the row `0247` already wrote, and changes no price.

-- ===== 1. ONE ledger for a capability decision, and it already exists =====
-- This file was written against `private.plan_quota_decisions` — the NUMERIC ledger — because when
-- it was written nothing else could hold a yes/no. `0246` landed first and built
-- `private.plan_capability_decisions` for exactly this fact. Teaching the numeric ledger to hold
-- booleans as well would be a second ledger for one fact, which is the thing the constitution
-- forbids, so this migration extends the ledger that exists instead of forking it.
--
-- `previous_value` is what the rung allowed immediately before. Null for a capability that had no
-- stated position, which is a different thing from one that was closed.
alter table private.plan_capability_decisions
  add column if not exists previous_value boolean,
  add column if not exists note           text;

-- `0246` pinned `decision_ref` to the two decisions it knew about. Every later decision that locks
-- a capability has to be recordable in the same row, so the pin becomes a shape rule.
alter table private.plan_capability_decisions
  drop constraint if exists plan_capability_decisions_decision_ref_check;
alter table private.plan_capability_decisions
  add constraint plan_capability_decisions_decision_ref_shape
  check (decision_ref like 'OPEN-DECISIONS #%');

comment on column private.plan_capability_decisions.previous_value is
  'What the rung allowed immediately before this decision (0248, #274). Null means the capability '
  'had no stated position, which is not the same as having been open.';

-- ===== 2. The two conditions #274 named, as one readable answer =====
create or replace function private.plan_capability_violations()
returns table (assertion text, detail text)
language sql stable security definer set search_path = public as $$
  -- (a) A capability that is not open must have a decision row that says so, for that exact plan.
  select 'capability_closed_without_decision'::text,
         format('%s / %s is not open and no decision row records it',
                entitlement.plan_key, entitlement.entitlement_key)
  from plan_entitlements entitlement
  where entitlement.kind = 'boolean'
    and entitlement.boolean_value is not true
    and not exists (
      select 1 from private.plan_capability_decisions decision
      where decision.plan_key = entitlement.plan_key
        and decision.entitlement_key = entitlement.entitlement_key
        and decision.decided_value = entitlement.boolean_value)

  union all

  -- (b) Monotonicity, over the ACTIVE ladder only. `legacy` is an inactive rung that existing
  -- customers sit on and no new customer can reach; it is not a step anybody upgrades through, so
  -- comparing it against the ladder would forbid honouring what those customers already have.
  select 'capability_lost_on_upgrade'::text,
         format('%s is open on %s but closed on %s, which sits above it',
                lower_rung.entitlement_key, lower_rung.plan_key, higher_rung.plan_key)
  from plan_entitlements lower_rung
  join subscription_plans lower_plan on lower_plan.plan_key = lower_rung.plan_key
  join plan_entitlements higher_rung
    on higher_rung.entitlement_key = lower_rung.entitlement_key
   and higher_rung.kind = 'boolean'
  join subscription_plans higher_plan
    on higher_plan.plan_key = higher_rung.plan_key
   and higher_plan.tier_order > lower_plan.tier_order
  where lower_rung.kind = 'boolean'
    and lower_plan.active and higher_plan.active
    and lower_rung.boolean_value is true
    and higher_rung.boolean_value is not true
$$;
revoke all on function private.plan_capability_violations() from public, anon, authenticated;

comment on function private.plan_capability_violations() is
  'The two conditions #274 attached to locking a capability by plan (0248): every closed capability '
  'is backed by a decision row, and no capability is open on a cheaper active rung while closed on '
  'a dearer one. Returns zero rows when both hold. A migration that closes a capability calls this '
  'and raises, which is what "#274 fails the migration" means in practice.';

-- ===== 3. The decision #297 already made, written where the ledger can be asked =====
insert into private.plan_capability_decisions
  (plan_key, entitlement_key, decided_value, previous_value, decision_ref)
values
  -- `previous_value` is true because 0247 seeded every rung open before closing this one: the
  -- grant existed for a moment, and the record says so rather than implying the rung never had it.
  ('free', 'exports.unbranded_pdf', false, true, 'OPEN-DECISIONS #297')
on conflict (plan_key, entitlement_key) do update
  set decided_value = excluded.decided_value,
      previous_value = excluded.previous_value,
      decision_ref = excluded.decision_ref;

do $assert_0248$
declare
  v_violations text;
  v_decided boolean;
begin
  select decided_value into v_decided
  from private.plan_capability_decisions
  where plan_key = 'free' and entitlement_key = 'exports.unbranded_pdf';
  if v_decided is distinct from false then
    raise exception '0248: the free rung decision was not recorded';
  end if;

  -- The bolt, proving itself on the state it was written for.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.plan_capability_violations();
  if v_violations is not null then
    raise exception e'0248 capability assertions failed:\n%', v_violations;
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0248 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0248 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0248$;
