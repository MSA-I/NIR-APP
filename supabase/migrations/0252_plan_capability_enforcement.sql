-- 0252 -- the capability ladder the owner decided on 28.08.2026, and the server half that makes it
-- a lock rather than a claim.
--
-- ===== WHAT THIS SUPERSEDES, AND BY WHOSE WORD =====
--
-- `#274`/`#276` put the accountant report, the Excel export, the supplier-performance board and
-- five users at `בסיס`, leaving `פרו` as the accountant layer alone. On 28.08.2026 the owner was
-- shown that ladder beside his own answer of the same day and ruled: "ההכרעה האחרונה גוברת" — the
-- later ruling wins. `#298` records it. Everything on the list moves to `פרו`:
--
--     reports.advanced   -- the accountant report and the supplier-performance board
--     bank.reconciliation-- unchanged; it was `פרו` in #274 and stays there
--     exports.custom     -- the export templates and their workbooks
--     users.max          -- `בסיס` goes from five members to one, i.e. adding a user is `פרו`
--
-- `#276`'s introduction window is NOT cancelled and is not re-decided here. It grants a new
-- organisation "the `בסיס` layer" for thirty days, and what `בסיס` CONTAINS is exactly what this
-- file changes -- so the window now opens a smaller set, without a second date and without a
-- second grant. Anything else would be inventing a decision.
--
-- ===== WHY THE SERVER HALF IS IN THE SAME FILE =====
--
-- `#274` fixes the order: "סדר מימוש מחייב: שרת לפני מסך … מסך שמסתיר בזמן שהשרת מרשה אינו
-- נעילה." The menu already hides these destinations (28.08.2026, `entitlements.ts`), and a hidden
-- link over an open route is a claim the address bar disproves. Turning a capability off without
-- the enforcement in the same migration would be exactly that.
--
-- ===== WHAT IS ENFORCED, AND THE ONE THING THAT CANNOT BE =====
--
-- Enforcement is a SELECT predicate on the tables a capability owns, plus a write guard trigger on
-- the same tables. Triggers rather than restated command bodies: nine SECURITY DEFINER commands
-- write these tables, and re-declaring nine bodies to insert one check each is nine chances to
-- silently drop a security property (`DEBT` — "redeclaring from the creating migration reverts
-- security properties"). A guard trigger fires whatever the command does, and adds one predicate
-- to one place per table.
--
-- `bank_allocations` is deliberately NOT gated. It is the N:M table a bank transaction shares with
-- an invoice, and definer readers outside this feature consult it -- `0174` reverses approval
-- consumption through it. A predicate there would change what an invoice balance says for a
-- free-plan tenant, which is a financial claim and not a menu.
--
-- `/analytics` (ביצועי ספקים) is NOT lockable and this file does not pretend otherwise. It renders
-- `supplier_metrics`, a security-invoker view that `/suppliers` — an ungated screen — renders too.
-- The capability there is the BOARD, not the data behind it; a server gate would take away numbers
-- the customer can already see one screen over. It stays menu-level disclosure, recorded in
-- `DEBT §79`.
--
-- ===== NOBODY LOSES ANYTHING TODAY =====
--
-- Every organisation in production is on `premium` inside the pre-launch window (`0210`), so the
-- rows this file writes bind on nothing until that window ends and an organisation lands on `free`
-- again. That is the same premise `0210` recorded, checked here rather than assumed.

-- ===== 1. The brake #274 asks for: a capability may not be switched off in silence =====
-- `private.plan_quota_decisions` (0184/0208) does this for the numeric dials. Booleans had no
-- equivalent, which is precisely how a capability could disappear from a plan with nothing on the
-- record saying who decided it or against what. Same duty, and by now the same table: `0246`
-- created `private.plan_capability_decisions` and `0248` widened it, so this file writes rows into
-- the ledger that exists rather than declaring a second one beside it.
comment on table private.plan_capability_decisions is
  'Why a boolean capability is off for a plan (0246/0248/0252, #274/#276/#297/#298). The assertion '
  'at the end of this file refuses any plan_entitlements row set to false without a matching '
  'decision here -- the boolean counterpart of private.plan_quota_decisions, and the brake #274 '
  'requires.';

insert into private.plan_capability_decisions
  (plan_key, entitlement_key, decided_value, decision_ref, note)
values
  ('free',  'reports.advanced',    false, 'OPEN-DECISIONS #298',
   'הדוח לרואה חשבון ולוח ביצועי הספקים נפתחים במסלול פרו (הכרעת בעלים 28.08.2026, גוברת על #274)'),
  ('basic', 'reports.advanced',    false, 'OPEN-DECISIONS #298',
   'הדוח לרואה חשבון ולוח ביצועי הספקים נפתחים במסלול פרו (הכרעת בעלים 28.08.2026, גוברת על #274)'),
  ('free',  'bank.reconciliation', false, 'OPEN-DECISIONS #298',
   'התאמות בנק הן שכבת רואה החשבון ונשארות פרו, כפי ש-#274 כבר קבע'),
  ('basic', 'bank.reconciliation', false, 'OPEN-DECISIONS #298',
   'התאמות בנק הן שכבת רואה החשבון ונשארות פרו, כפי ש-#274 כבר קבע'),
  ('free',  'exports.custom',      false, 'OPEN-DECISIONS #298',
   'תבניות הייצוא וחוברות ה-Excel נפתחות במסלול פרו (הכרעת בעלים 28.08.2026, גוברת על #274)'),
  ('basic', 'exports.custom',      false, 'OPEN-DECISIONS #298',
   'תבניות הייצוא וחוברות ה-Excel נפתחות במסלול פרו (הכרעת בעלים 28.08.2026, גוברת על #274)')
on conflict (plan_key, entitlement_key) do update
  set decided_value = excluded.decided_value,
      decision_ref = excluded.decision_ref,
      note = excluded.note,
      decided_at = current_date;

-- ===== 2. The ladder =====
-- Written plan by plan rather than "everything except pro and up", so a rung added later inherits
-- nothing by accident. `legacy` keeps everything: it is the pre-cutover holding pen (#164), and a
-- customer parked there never agreed to a reduction.
update plan_entitlements
   set boolean_value = false, updated_at = now()
 where kind = 'boolean'
   and plan_key in ('free', 'basic')
   and entitlement_key in ('reports.advanced', 'bank.reconciliation', 'exports.custom');

update plan_entitlements
   set boolean_value = true, updated_at = now()
 where kind = 'boolean'
   and plan_key in ('pro', 'premium', 'business', 'legacy')
   and entitlement_key in ('reports.advanced', 'bank.reconciliation', 'exports.custom');

-- `users.max`. #274 published 1/5/15/30; the owner's later ruling moves `basic` to one member, so
-- adding a user is what `פרו` opens. The two numbers #274 decided above `basic` are NOT touched --
-- he did not contradict them, and rewriting them here would be a decision nobody made.
update plan_entitlements
   set unlimited = false, numeric_limit = 1, updated_at = now()
 where entitlement_key = 'users.max' and kind = 'numeric' and plan_key in ('free', 'basic');

update plan_entitlements
   set unlimited = false, numeric_limit = 15, updated_at = now()
 where entitlement_key = 'users.max' and kind = 'numeric' and plan_key = 'pro';

update plan_entitlements
   set unlimited = false, numeric_limit = 30, updated_at = now()
 where entitlement_key = 'users.max' and kind = 'numeric' and plan_key = 'premium';

update plan_entitlements
   set unlimited = true, numeric_limit = null, updated_at = now()
 where entitlement_key = 'users.max' and kind = 'numeric' and plan_key in ('business', 'legacy');

update private.entitlement_definitions
   set enforced_since = '0252'
 where entitlement_key in ('reports.advanced', 'bank.reconciliation', 'exports.custom', 'users.max');

-- ===== 3. One resolver, and it answers the same way the menu does =====
-- No organisation argument: the tenant comes from `auth_org()`, which is what lets the planner
-- treat this as a constant inside a row-security predicate instead of calling it per row.
--
-- UNMEASURED IS NOT A REFUSAL, and that is the same rule `src/lib/entitlements.ts` follows, on
-- purpose: the two must agree exactly, or the menu and the server start telling a customer
-- different things about the same plan. `measured = false` in 0154 means "we cannot state what
-- this customer is entitled to" -- a configuration gap on our side. Refusing service on a gap of
-- ours would turn a missing row into an outage, and the customer could not tell it from a bug.
create or replace function private.auth_org_allows(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    -- A live, unexpired override outranks the plan -- the same precedence effective_entitlement()
    -- applies, restated here rather than borrowed, because that function returns jsonb and this
    -- one has to be cheap enough to sit in a policy.
    (select override.boolean_value
       from organization_entitlement_overrides override
      where override.org_id = auth_org()
        and override.entitlement_key = p_key
        and override.kind = 'boolean'
        and override.revoked_at is null
        and (override.expires_at is null or override.expires_at > now())),
    (select entitlement.boolean_value
       from organization_subscriptions subscription
       join plan_entitlements entitlement
         on entitlement.plan_key = subscription.plan_key
        and entitlement.entitlement_key = p_key
        and entitlement.kind = 'boolean'
      where subscription.org_id = auth_org()),
    true)
$$;
revoke all on function private.auth_org_allows(text) from public, anon;
grant execute on function private.auth_org_allows(text) to authenticated;

comment on function private.auth_org_allows(text) is
  'Whether the caller''s own plan includes a boolean capability (0252, #278). A live override wins '
  'over the plan. An entitlement nothing states resolves TRUE: an unmeasured answer is our gap, '
  'never a refusal, and src/lib/entitlements.ts follows the identical rule so the menu and the '
  'server can never disagree about the same plan.';

-- ===== 4. The write guard =====
-- One function, the capability named per trigger, so a new gated table costs one CREATE TRIGGER.
--
-- IT GATES THE TENANT PATH AND ONLY THE TENANT PATH. With no `auth_org()` there is no plan to read
-- -- that is a migration, an operator command, the offboarding purge or a background job, none of
-- which is a customer using a feature. Refusing those would break tenant deletion and backfills to
-- enforce a commercial rule against nobody.
create or replace function private.plan_capability_write_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth_org() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not private.auth_org_allows(tg_argv[0]) then
    raise exception 'capability_not_in_plan' using errcode = '42501',
      detail = tg_argv[0],
      hint = 'the organization''s plan does not include this capability';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function private.plan_capability_write_guard()
  from public, anon, authenticated, service_role;

comment on function private.plan_capability_write_guard() is
  'Refuses a tenant write to a table whose capability the plan does not include (0252, #278). '
  'Named per trigger through tg_argv[0]. A statement with no auth_org() -- migration, operator '
  'command, purge, background job -- passes: there is no plan to read and no customer to gate.';

-- A5, AND THE SAME NARROW SHAPE 0092 ARGUED FOR `organization_row_write_guard()`. This trigger
-- inspects only the NEW/OLD row the caller's own statement selected. It reads no table, returns
-- no row it was not handed, and can leak nothing across tenants or units -- so `auth_scopes()`
-- has nothing to filter here, and adding the marker would be exactly the "marker that changes no
-- result" 0095 refuses to accept as proof. SECURITY DEFINER is required for the opposite reason
-- it usually is: the capability gate must also bind service_role and definer writers, which an
-- INVOKER trigger would let straight through.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'private.plan_capability_write_guard()'::regprocedure::text,
  'trigger-new-old-rows -- cannot be invoker: the plan gate must also govern service_role and '
    || 'SECURITY DEFINER writers, and the function reads no row of its own to scope.',
  'multi-unit enablement wave'
);

-- ----- bank.reconciliation -----
-- `bank_allocations` is absent on purpose; see the header.
drop policy if exists bank_tx_select on public.bank_transactions;
create policy bank_tx_select on public.bank_transactions for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
  and private.auth_org_allows('bank.reconciliation')
);

drop policy if exists bank_imports_select on public.bank_imports;
create policy bank_imports_select on public.bank_imports for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
  and private.auth_org_allows('bank.reconciliation')
);

drop trigger if exists zz_plan_capability_bank_transactions on public.bank_transactions;
create trigger zz_plan_capability_bank_transactions
  before insert or update or delete on public.bank_transactions
  for each row execute function private.plan_capability_write_guard('bank.reconciliation');

drop trigger if exists zz_plan_capability_bank_imports on public.bank_imports;
create trigger zz_plan_capability_bank_imports
  before insert or update or delete on public.bank_imports
  for each row execute function private.plan_capability_write_guard('bank.reconciliation');

-- ----- reports.advanced -----
drop policy if exists monthly_report_snapshots_select on public.monthly_report_snapshots;
create policy monthly_report_snapshots_select
  on public.monthly_report_snapshots
  for select to authenticated
  using (
    org_id = auth_org() and auth_role() in ('owner', 'accountant')
    and private.auth_org_allows('reports.advanced')
  );

drop policy if exists monthly_report_snapshot_deliveries_select
  on public.monthly_report_snapshot_deliveries;
create policy monthly_report_snapshot_deliveries_select
  on public.monthly_report_snapshot_deliveries
  for select to authenticated
  using (
    org_id = auth_org() and auth_role() in ('owner', 'accountant')
    and private.auth_org_allows('reports.advanced')
  );

drop trigger if exists zz_plan_capability_monthly_report_snapshots
  on public.monthly_report_snapshots;
create trigger zz_plan_capability_monthly_report_snapshots
  before insert or update or delete on public.monthly_report_snapshots
  for each row execute function private.plan_capability_write_guard('reports.advanced');

drop trigger if exists zz_plan_capability_monthly_report_snapshot_deliveries
  on public.monthly_report_snapshot_deliveries;
create trigger zz_plan_capability_monthly_report_snapshot_deliveries
  before insert or update or delete on public.monthly_report_snapshot_deliveries
  for each row execute function private.plan_capability_write_guard('reports.advanced');

-- ----- exports.custom -----
drop policy if exists document_export_templates_select on public.document_export_templates;
create policy document_export_templates_select on public.document_export_templates
  for select to authenticated using (
    org_id = auth_org()
    and auth_role() in ('owner', 'office', 'kitchen')
    and (owner_user_id is null or owner_user_id = auth.uid())
    and private.auth_org_allows('exports.custom')
  );

drop trigger if exists zz_plan_capability_document_export_templates
  on public.document_export_templates;
create trigger zz_plan_capability_document_export_templates
  before insert or update or delete on public.document_export_templates
  for each row execute function private.plan_capability_write_guard('exports.custom');

drop trigger if exists zz_plan_capability_document_export_template_versions
  on public.document_export_template_versions;
create trigger zz_plan_capability_document_export_template_versions
  before insert or update or delete on public.document_export_template_versions
  for each row execute function private.plan_capability_write_guard('exports.custom');

-- The version and export policies are left as they are: both already require a readable parent
-- template through an EXISTS, so the predicate above reaches them without a second copy of it.

-- ===== 5. users.max, where a number becomes a refusal =====
-- DEBT §56 records that this entitlement was defined and never measured. This is the measurement:
-- active members plus invitations that have not been accepted, revoked or expired -- an invitation
-- outstanding is a seat already spent, or a plan of one could be handed out five times over.
--
-- A trigger rather than a restated `create_invitation` (0025), for the reason in the header: that
-- body is 90 lines of security-relevant logic and this check is two.
create or replace function private.invitation_seat_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit     numeric;
  v_unlimited boolean;
  v_used      integer;
begin
  if auth_org() is null then
    return new;
  end if;

  select coalesce(override.unlimited, entitlement.unlimited, true),
         coalesce(override.numeric_limit, entitlement.numeric_limit)
    into v_unlimited, v_limit
  from (select 1) probe
  left join organization_subscriptions subscription on subscription.org_id = new.org_id
  left join plan_entitlements entitlement
    on entitlement.plan_key = subscription.plan_key
   and entitlement.entitlement_key = 'users.max'
   and entitlement.kind = 'numeric'
  left join organization_entitlement_overrides override
    on override.org_id = new.org_id
   and override.entitlement_key = 'users.max'
   and override.kind = 'numeric'
   and override.revoked_at is null
   and (override.expires_at is null or override.expires_at > now());

  -- Unlimited, or a plan that states no number at all: an unmeasured limit is our gap and never a
  -- refusal, exactly as private.auth_org_allows() treats a boolean.
  if coalesce(v_unlimited, true) or v_limit is null then
    return new;
  end if;

  select (select count(*) from profiles member
           where member.org_id = new.org_id and member.active)
       + (select count(*) from invitations invitation
           where invitation.org_id = new.org_id
             and invitation.accepted_at is null
             and invitation.revoked_at is null
             and invitation.expires_at > now()
             and invitation.id is distinct from new.id)
    into v_used;

  if v_used >= v_limit then
    raise exception 'user_seats_exhausted' using errcode = '42501',
      detail = v_used::text || '/' || v_limit::text,
      hint = 'the organization''s plan does not include another member';
  end if;
  return new;
end
$$;
revoke all on function private.invitation_seat_guard()
  from public, anon, authenticated, service_role;

comment on function private.invitation_seat_guard() is
  'Refuses an invitation that would take an organization past its users.max (0252, #278; closes '
  'the measurement half of DEBT §56). Counts active members plus outstanding invitations, because '
  'an unaccepted invitation is a seat already spent. Unlimited or unstated passes.';

drop trigger if exists zz_invitation_seat_guard on public.invitations;
create trigger zz_invitation_seat_guard
  before insert on public.invitations
  for each row execute function private.invitation_seat_guard();

-- ===== 6. Proof =====
do $assert_0252$
declare
  v_violations text;
  v_undecided  integer;
  v_break      text;
  v_free_bank  boolean;
  v_pro_bank   boolean;
begin
  -- 6a. The brake. Every boolean a plan does NOT include has a decision row naming who decided it.
  select count(*) into v_undecided
    from plan_entitlements entitlement
   where entitlement.kind = 'boolean'
     and entitlement.boolean_value = false
     and not exists (select 1 from private.plan_capability_decisions decision
                     where decision.plan_key = entitlement.plan_key
                       and decision.entitlement_key = entitlement.entitlement_key);
  if v_undecided <> 0 then
    raise exception '0252: % capability(ies) are off for a plan with no decision row', v_undecided;
  end if;

  -- 6b. Monotonicity (#274). A capability open on a rung must be open on every rung above it, or
  -- an upgrade could take something away and the customer would find out by paying for it.
  --
  -- ASKED OF `0248`'s FUNCTION RATHER THAN RE-WRITTEN HERE. This file first carried its own copy
  -- of the query, and the copy compared EVERY rung -- `legacy` included. That is wrong for the
  -- reason `0248` states: `legacy` is the pre-cutover holding pen (#164). It is inactive, no new
  -- customer can reach it, and nobody upgrades through it. `0246` opens everything on it exactly
  -- so a parked customer loses nothing, and a whole-ladder comparison reads that promise as a
  -- break. One definition, in private.plan_capability_violations(), and this migration and both
  -- suites ask it the same question.
  select string_agg(assertion || ' -- ' || detail, e'
' order by assertion, detail)
    into v_break
  from private.plan_capability_violations();
  if v_break is not null then
    raise exception e'0252 capability assertions failed:
%', v_break;
  end if;

  -- 6c. The ladder landed where the owner put it, read back rather than assumed.
  select boolean_value into v_free_bank
    from plan_entitlements where plan_key = 'free' and entitlement_key = 'bank.reconciliation';
  select boolean_value into v_pro_bank
    from plan_entitlements where plan_key = 'pro' and entitlement_key = 'bank.reconciliation';
  if v_free_bank is not false or v_pro_bank is not true then
    raise exception '0252: bank.reconciliation resolved free=%, pro=%', v_free_bank, v_pro_bank;
  end if;
  if (select numeric_limit from plan_entitlements
       where plan_key = 'basic' and entitlement_key = 'users.max') <> 1 then
    raise exception '0252: basic still carries more than one member seat';
  end if;

  -- 6d. Nobody in this database loses anything today. 0210 put every organisation on a granted
  -- rung inside the pre-launch window; if one is already below it, the file is landing on a live
  -- tenant and that is worth stopping for rather than discovering from a support call.
  if exists (
    select 1
      from organization_subscriptions subscription
      join plan_entitlements entitlement
        on entitlement.plan_key = subscription.plan_key
       and entitlement.entitlement_key = 'bank.reconciliation'
       and entitlement.kind = 'boolean'
     where entitlement.boolean_value is false
       and not exists (select 1 from organization_entitlement_overrides override
                       where override.org_id = subscription.org_id
                         and override.entitlement_key = 'bank.reconciliation'
                         and override.revoked_at is null
                         and (override.expires_at is null or override.expires_at > now())
                         and override.boolean_value is true)
  ) then
    raise exception '0252: an existing organisation would lose bank reconciliation on apply';
  end if;

  -- 0058:207-218 -- the scope contract is re-asserted here rather than three hours later.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0252 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0252$;
