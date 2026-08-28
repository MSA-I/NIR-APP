-- 0214: the bolt #274 asked for, built. A capability may be locked to a plan — and only with a
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
-- That capability is `exports.unbranded_pdf` (`0213`, `#277`): the free rung exports the generated
-- PDF with the InPlace mark, and every paid rung exports it clean.
--
-- WHAT THIS FILE DOES NOT DO. It does not decide anything. `#274` decided that locking is allowed,
-- `#277` decided this particular lock, and this migration builds the machinery both of them assume
-- exists. It opens no plan, closes none beyond the row `0213` already wrote, and changes no price.

-- ===== 1. The ledger learns to hold a yes/no decision =====
alter table private.plan_quota_decisions
  alter column decided_limit drop not null,
  add column decided_value     boolean,
  -- What the rung allowed immediately before. Null for a capability that had no stated position,
  -- which is a different thing from one that was closed.
  add column previous_value    boolean,
  add constraint plan_quota_decisions_shape check (
    (decided_limit is not null and decided_value is null)
    or (decided_limit is null and decided_value is not null));

comment on column private.plan_quota_decisions.decided_value is
  'The yes/no position an owner decision put a capability in for this plan (0214, #274). Exactly '
  'one of decided_limit and decided_value is present: a row records a volume or a capability, '
  'never both.';

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
      select 1 from private.plan_quota_decisions decision
      where decision.plan_key = entitlement.plan_key
        and decision.entitlement_key = entitlement.entitlement_key
        and decision.decided_value is not null
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
  'The two conditions #274 attached to locking a capability by plan (0214): every closed capability '
  'is backed by a decision row, and no capability is open on a cheaper active rung while closed on '
  'a dearer one. Returns zero rows when both hold. A migration that closes a capability calls this '
  'and raises, which is what "#274 fails the migration" means in practice.';

-- ===== 3. The decision #277 already made, written where the ledger can be asked =====
insert into private.plan_quota_decisions
  (plan_key, entitlement_key, decided_limit, decided_value, previous_value, decision_ref)
values
  -- `previous_value` is true because 0213 seeded every rung open before closing this one: the
  -- grant existed for a moment, and the record says so rather than implying the rung never had it.
  ('free', 'exports.unbranded_pdf', null, false, true, 'OPEN-DECISIONS #277');

do $assert_0214$
declare
  v_violations text;
  v_decided boolean;
begin
  select decided_value into v_decided
  from private.plan_quota_decisions
  where plan_key = 'free' and entitlement_key = 'exports.unbranded_pdf';
  if v_decided is distinct from false then
    raise exception '0214: the free rung decision was not recorded';
  end if;

  -- The bolt, proving itself on the state it was written for.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.plan_capability_violations();
  if v_violations is not null then
    raise exception e'0214 capability assertions failed:\n%', v_violations;
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0214 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0214 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0214$;
