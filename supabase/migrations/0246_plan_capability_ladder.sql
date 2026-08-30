-- 0246 — The subscription ladder becomes an enforceable server contract.
--
-- Decisions: OPEN-DECISIONS #274, #276 and #295.
--
-- 0184 installed the five-rung catalogue but deliberately kept every boolean entitlement true;
-- its closing assertion named #196 and refused feature gating. #274 reversed that decision.
-- This forward-only migration does not edit 0184. It records every new false value, requires the
-- ladder to stay monotonic, gives the 30-day Free introduction the Basic capability set by reusing
-- 0202's one immutable timestamp, and installs the first real consumers before any screen may
-- advertise the differences.

-- ===== 1. Missing vocabulary and presentation order =====

insert into private.entitlement_definitions
  (entitlement_key, kind, measure, unit, label, description, enforced_since)
values
  ('branches.max', 'numeric', 'current', 'branches', 'סניפים',
   'How many branch units the organization may hold at once.', '0246'),
  ('documents.automatic_monthly', 'numeric', 'per_period', 'documents', 'מסמכים בקריאה אוטומטית',
   'How many documents may enter automatic interpretation in one usage period.', '0246'),
  ('history.full', 'boolean', 'current', null, 'היסטוריה מלאה',
   'Access to closed operational history older than three months.', '0246'),
  ('notifications.email', 'boolean', 'current', null, 'התראות ואוטומציות במייל',
   'Access to plan-scoped operational email notifications and automations.', '0246'),
  ('payments.accountant_queue', 'boolean', 'current', null, 'תור תשלומים לרואה החשבון',
   'Access to the accountant payment execution queue.', '0246'),
  ('invoices.consolidated', 'boolean', 'current', null, 'חשבוניות מרכזות',
   'Access to consolidated supplier invoice intake and reconciliation.', '0246'),
  ('integrations.api', 'boolean', 'current', null, 'חיבור למערכות אחרות',
   'Access to tenant integration and webhook configuration surfaces.', '0246')
on conflict (entitlement_key) do nothing;

-- Every plan/key pair must exist before a resolver can fail closed honestly.
insert into public.plan_entitlements
  (plan_key, entitlement_key, kind, unlimited, numeric_limit, boolean_value)
select plan.plan_key, definition.entitlement_key, definition.kind,
       definition.kind = 'numeric', null,
       case when definition.kind = 'boolean' then true end
from public.subscription_plans plan
cross join private.entitlement_definitions definition
left join public.plan_entitlements existing
  on existing.plan_key = plan.plan_key
 and existing.entitlement_key = definition.entitlement_key
where existing.plan_key is null;

create table private.plan_feature_presentation (
  entitlement_key text primary key references private.entitlement_definitions(entitlement_key),
  display_order integer not null unique,
  public_label text not null check (length(btrim(public_label)) >= 3),
  intro_for_free boolean not null default false,
  published boolean not null default true
);
revoke all on table private.plan_feature_presentation
  from public, anon, authenticated, service_role;

insert into private.plan_feature_presentation
  (entitlement_key, display_order, public_label, intro_for_free)
values
  ('documents.automation',       10, 'קריאה אוטומטית של מסמכים', true),
  ('history.full',               20, 'היסטוריה מלאה', true),
  ('exports.custom',             30, 'ייצוא Excel ודוחות לרו״ח', true),
  ('reports.advanced',           40, 'לוח ביצועי ספקים', true),
  ('notifications.email',        50, 'התראות ואוטומציות במייל', true),
  ('bank.reconciliation',        60, 'התאמות בנק', false),
  ('payments.accountant_queue',  70, 'תור תשלומים לרואה החשבון', false),
  ('invoices.consolidated',      80, 'חשבוניות מרכזות', false),
  ('org.multi_unit',             90, 'עד 10 סניפים', false),
  ('integrations.api',          100, 'חיבור למערכות אחרות', false),
  ('support.premium',           110, 'תמיכה מורחבת', false);

-- ===== 2. The documented ladder =====

create table private.plan_capability_decisions (
  plan_key text not null references public.subscription_plans(plan_key),
  entitlement_key text not null references private.entitlement_definitions(entitlement_key),
  decided_value boolean not null,
  decision_ref text not null check (decision_ref in ('OPEN-DECISIONS #274', 'OPEN-DECISIONS #276')),
  decided_at date not null default date '2026-08-25',
  primary key (plan_key, entitlement_key)
);
revoke all on table private.plan_capability_decisions
  from public, anon, authenticated, service_role;

insert into private.plan_capability_decisions
  (plan_key, entitlement_key, decided_value, decision_ref)
select plan.plan_key, feature.entitlement_key,
       case
         when plan.plan_key in ('legacy', 'business') then true
         when feature.entitlement_key in (
           'documents.automation', 'history.full', 'exports.custom',
           'reports.advanced', 'notifications.email'
         ) then plan.tier_order >= (select tier_order from public.subscription_plans where plan_key = 'basic')
         when feature.entitlement_key in (
           'bank.reconciliation', 'payments.accountant_queue', 'invoices.consolidated'
         ) then plan.tier_order >= (select tier_order from public.subscription_plans where plan_key = 'pro')
         when feature.entitlement_key in (
           'org.multi_unit', 'integrations.api', 'support.premium'
         ) then plan.tier_order >= (select tier_order from public.subscription_plans where plan_key = 'premium')
         else false
       end,
       'OPEN-DECISIONS #274'
from public.subscription_plans plan
cross join private.plan_feature_presentation feature;

update public.plan_entitlements entitlement
set boolean_value = decision.decided_value,
    updated_at = now()
from private.plan_capability_decisions decision
where entitlement.plan_key = decision.plan_key
  and entitlement.entitlement_key = decision.entitlement_key
  and entitlement.kind = 'boolean';

-- Numeric limits that #274 made publishable only after a real counter/guard exists below.
with decided(plan_key, users_max, branches_max, automatic_documents) as (
  values
    ('free',       1::numeric,  1::numeric,   5::numeric),
    ('basic',      5::numeric,  1::numeric,  40::numeric),
    ('pro',       15::numeric,  1::numeric, 150::numeric),
    ('premium',   30::numeric, 10::numeric, 375::numeric)
)
update public.plan_entitlements entitlement
set unlimited = false,
    numeric_limit = case entitlement.entitlement_key
      when 'users.max' then decided.users_max
      when 'branches.max' then decided.branches_max
      when 'documents.automatic_monthly' then decided.automatic_documents
    end,
    updated_at = now()
from decided
where entitlement.plan_key = decided.plan_key
  and entitlement.entitlement_key in ('users.max', 'branches.max', 'documents.automatic_monthly');

update public.plan_entitlements
set unlimited = true, numeric_limit = null, updated_at = now()
where plan_key in ('business', 'legacy')
  and entitlement_key in ('users.max', 'branches.max', 'documents.automatic_monthly');

-- ===== 3. One clock, one resolution rule =====

-- A Free organization in the 30-day window resolves the five Basic boolean capabilities from the
-- Basic row. Automatic documents are special: the window opens all TWENTY Free documents, not
-- Basic's volume of forty. Numeric plan volume otherwise stays on the actual plan.
create or replace function public.effective_entitlement(p_org_id uuid, p_entitlement_key text)
returns jsonb
language sql stable security definer set search_path = public, private, pg_temp as $$
  with referral_bonus as (
    select coalesce(sum(grant_row.quantity - coalesce(grant_row.revoked_quantity, 0)), 0) as quantity
    from private.referral_grants grant_row
    cross join lateral private.usage_period(p_org_id) grant_period
    where grant_row.beneficiary_org_id = p_org_id
      and grant_row.metric_key = p_entitlement_key
      and grant_row.period_start = grant_period.period_start
  ),
  definition as (
    select * from private.entitlement_definitions
    where entitlement_key = p_entitlement_key
  ),
  live_override as (
    select * from public.organization_entitlement_overrides
    where org_id = p_org_id and entitlement_key = p_entitlement_key
      and revoked_at is null and (expires_at is null or expires_at > now())
  ),
  subscription as (
    select * from public.organization_subscriptions where org_id = p_org_id
  ),
  introduction as (
    select window_row.started_at,
           window_row.started_at + interval '30 days' as ends_at
    from private.assistant_intro_windows window_row
    join subscription on subscription.org_id = window_row.org_id
    where subscription.plan_key = 'free'
      and window_row.started_at <= now()
      and now() < window_row.started_at + interval '30 days'
  ),
  presented as (
    select * from private.plan_feature_presentation
    where entitlement_key = p_entitlement_key and intro_for_free
  ),
  effective_plan as (
    select case when exists (select 1 from introduction)
                      and exists (select 1 from presented)
                then 'basic' else subscription.plan_key end as plan_key
    from subscription
  ),
  from_plan as (
    select entitlement.* from public.plan_entitlements entitlement
    join effective_plan on effective_plan.plan_key = entitlement.plan_key
    where entitlement.entitlement_key = p_entitlement_key
  ),
  intro_automatic_limit as (
    select documents.numeric_limit
    from public.plan_entitlements documents
    where exists (select 1 from introduction)
      and p_entitlement_key = 'documents.automatic_monthly'
      and documents.plan_key = 'free'
      and documents.entitlement_key = 'documents.monthly'
  )
  select jsonb_build_object(
    'entitlement_key', p_entitlement_key,
    'kind', definition.kind,
    'measure', definition.measure,
    'unit', definition.unit,
    'label', definition.label,
    'plan_key', (select plan_key from subscription),
    'subscription_status', (select status from subscription),
    'period_start', (select current_period_start from subscription),
    'period_end', (select current_period_end from subscription),
    'source', case
      when exists (select 1 from live_override) then 'override'
      when exists (select 1 from introduction)
       and (exists (select 1 from presented) or p_entitlement_key = 'documents.automatic_monthly')
        then 'intro'
      when exists (select 1 from from_plan) then 'plan'
      else 'unavailable' end,
    'intro_ends_at', (select ends_at from introduction),
    'override_expires_at', (select expires_at from live_override),
    'unlimited', coalesce((select unlimited from live_override), (select unlimited from from_plan), false),
    'limit', case
      when coalesce(
        (select numeric_limit from live_override),
        (select numeric_limit from intro_automatic_limit),
        (select numeric_limit from from_plan)) is null then null
      else coalesce(
        (select numeric_limit from live_override),
        (select numeric_limit from intro_automatic_limit),
        (select numeric_limit from from_plan))
        + coalesce((select quantity from referral_bonus), 0)
      end,
    'referral_bonus', coalesce((select quantity from referral_bonus), 0),
    'value', coalesce((select boolean_value from live_override), (select boolean_value from from_plan)),
    'measured', case
      when definition.kind is null then false
      when not exists (select 1 from subscription) then false
      when not exists (select 1 from live_override) and not exists (select 1 from from_plan) then false
      when definition.kind = 'boolean'
        then coalesce((select boolean_value from live_override), (select boolean_value from from_plan)) is not null
      else coalesce((select unlimited from live_override), (select unlimited from from_plan), false)
        or coalesce((select numeric_limit from live_override),
                    (select numeric_limit from intro_automatic_limit),
                    (select numeric_limit from from_plan)) is not null
      end
  )
  from definition
$$;

create or replace function public.current_plan_capability(p_entitlement_key text)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp as $$
  select coalesce(
    (resolved ->> 'measured')::boolean and (resolved ->> 'value')::boolean,
    false)
  from public.effective_entitlement(public.auth_org(), p_entitlement_key) resolved
  where public.auth_org() is not null
$$;
revoke all on function public.current_plan_capability(text) from public, anon;
grant execute on function public.current_plan_capability(text) to authenticated;

comment on function public.current_plan_capability(text) is
  'Fail-closed caller-org capability resolver (0246, #274/#276). No organization argument exists.';

-- ===== 4. Publish the same feature facts to both ladders =====

create or replace function private.plan_feature_rows(p_include_business boolean)
returns table (
  plan_key text, entitlement_key text, label text, display_order integer,
  included boolean, intro_included boolean
)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select plan.plan_key,
         presentation.entitlement_key,
         presentation.public_label,
         presentation.display_order,
         entitlement.boolean_value,
         plan.plan_key = 'free' and presentation.intro_for_free
  from public.subscription_plans plan
  join public.plan_entitlements entitlement on entitlement.plan_key = plan.plan_key
  join private.plan_feature_presentation presentation
    on presentation.entitlement_key = entitlement.entitlement_key
  where plan.active and presentation.published
    and (p_include_business or plan.plan_key <> 'business')
  order by plan.tier_order, presentation.display_order
$$;
revoke all on function private.plan_feature_rows(boolean)
  from public, anon, authenticated, service_role;

create or replace function public.get_public_plan_features()
returns table (
  plan_key text, entitlement_key text, label text, display_order integer,
  included boolean, intro_included boolean
)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select * from private.plan_feature_rows(false)
$$;
revoke all on function public.get_public_plan_features() from public;
grant execute on function public.get_public_plan_features() to anon, authenticated;

create or replace function public.my_plan_features()
returns table (
  plan_key text, entitlement_key text, label text, display_order integer,
  included boolean, intro_included boolean
)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select feature.* from private.plan_feature_rows(true) feature
  where public.auth_org() is not null
$$;
revoke all on function public.my_plan_features() from public, anon;
grant execute on function public.my_plan_features() to authenticated;

-- `users.max` and `branches.max` are publishable now because the two guards below measure them.
create or replace function public.get_public_plan_quotas()
returns table (
  plan_key text, entitlement_key text, label text, unit text,
  unlimited boolean, numeric_limit numeric, measured boolean
)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select plan.plan_key,
         definition.entitlement_key,
         definition.label,
         definition.unit,
         entitlement.unlimited,
         entitlement.numeric_limit,
         entitlement.unlimited or entitlement.numeric_limit is not null
  from public.subscription_plans plan
  join public.plan_entitlements entitlement on entitlement.plan_key = plan.plan_key
  join private.entitlement_definitions definition
    on definition.entitlement_key = entitlement.entitlement_key
  where plan.active
    and plan.plan_key <> 'business'
    and definition.kind = 'numeric'
    and definition.entitlement_key in ('documents.monthly', 'users.max', 'branches.max')
  order by plan.tier_order,
           case definition.entitlement_key
             when 'documents.monthly' then 10 when 'users.max' then 20 else 30 end
$$;
revoke all on function public.get_public_plan_quotas() from public;
grant execute on function public.get_public_plan_quotas() to anon, authenticated;

-- ===== 5. Real counters and guards =====

create or replace function private.enforce_active_profile_plan_limit() returns trigger
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_entitlement jsonb;
  v_count integer;
begin
  if not new.active then return new; end if;
  if tg_op = 'UPDATE' and old.active and old.org_id = new.org_id then return new; end if;

  v_entitlement := public.effective_entitlement(new.org_id, 'users.max');
  if v_entitlement is null or not coalesce((v_entitlement ->> 'measured')::boolean, false) then
    raise exception 'plan_user_limit_unknown' using errcode = 'P0001';
  end if;
  if coalesce((v_entitlement ->> 'unlimited')::boolean, false) then return new; end if;

  select count(*) into v_count from public.profiles profile
  where profile.org_id = new.org_id and profile.active and profile.id <> new.id;
  if v_count + 1 > (v_entitlement ->> 'limit')::numeric then
    raise exception 'plan_user_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_active_profile_plan_limit()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_profiles_plan_limit on public.profiles;
create trigger zz_profiles_plan_limit
  before insert or update of active, org_id on public.profiles
  for each row execute function private.enforce_active_profile_plan_limit();

create or replace function private.enforce_branch_plan_limit() returns trigger
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_entitlement jsonb;
  v_count integer;
begin
  if new.unit_type <> 'branch' then return new; end if;
  if tg_op = 'UPDATE' and old.unit_type = 'branch' and old.org_id = new.org_id then return new; end if;

  -- `p0_seed_org_units()` is an AFTER INSERT organization trigger whose name sorts before
  -- `zzz_organizations_default_subscription`. During that one bootstrap chain the first branch is
  -- therefore written before the subscription row exists. The exception is intentionally smaller
  -- than "no subscription": it requires nested trigger execution AND zero existing branches.
  -- Browser roles cannot INSERT org_units, so a direct request cannot manufacture this context.
  if not exists (
    select 1 from public.organization_subscriptions subscription
    where subscription.org_id = new.org_id
  ) then
    if pg_trigger_depth() > 1 and not exists (
      select 1 from public.org_units unit_row
      where unit_row.org_id = new.org_id and unit_row.unit_type = 'branch'
    ) then
      return new;
    end if;
    raise exception 'plan_branch_limit_unknown' using errcode = 'P0001';
  end if;

  v_entitlement := public.effective_entitlement(new.org_id, 'branches.max');
  if v_entitlement is null or not coalesce((v_entitlement ->> 'measured')::boolean, false) then
    raise exception 'plan_branch_limit_unknown' using errcode = 'P0001';
  end if;
  if coalesce((v_entitlement ->> 'unlimited')::boolean, false) then return new; end if;

  select count(*) into v_count from public.org_units unit_row
  where unit_row.org_id = new.org_id and unit_row.unit_type = 'branch' and unit_row.id <> new.id;
  if v_count + 1 > (v_entitlement ->> 'limit')::numeric then
    raise exception 'plan_branch_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_branch_plan_limit()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_org_units_plan_limit on public.org_units;
create trigger zz_org_units_plan_limit
  before insert or update of unit_type, org_id on public.org_units
  for each row execute function private.enforce_branch_plan_limit();

-- The automatic counter is consumed in the one cron claim door. Retries do not spend twice.
create or replace function private.claim_document_interpretation_jobs(
  p_limit integer,
  p_max_starts_per_org_hour integer
) returns table (job_id uuid)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_candidate record;
  v_counter private.usage_counters;
  v_entitlement jsonb;
begin
  if p_limit not between 1 and 100
     or p_max_starts_per_org_hour not between 1 and 100 then
    raise exception 'document_interpretation_dispatch_limit_invalid' using errcode = '22023';
  end if;

  for v_candidate in
    with eligible as (
      select j.id, j.org_id, j.created_at, sent.job_id is null as first_dispatch,
             row_number() over (
               partition by j.org_id order by j.created_at, j.id
             ) as tenant_position
      from public.document_processing_jobs j
      join public.documents d
        on d.org_id = j.org_id and d.id = j.document_id and d.deleted_at is null
      join public.document_extractions e
        on e.org_id = j.org_id and e.job_id = j.id and e.document_id = d.id
       and e.input_checksum = j.input_checksum and e.contract_version = j.contract_version
      join public.profiles p
        on p.org_id = j.org_id and p.id = d.uploaded_by and p.active
       and p.role in ('owner', 'office')
      left join private.document_interpretation_dispatches sent on sent.job_id = j.id
      where private.organization_access_mode(j.org_id) in ('active', 'trial', 'grace')
        and j.status = 'extracted'
        and j.requested_by = d.uploaded_by
        and not exists (
          select 1 from public.document_interpretations i
          where i.org_id = j.org_id and i.job_id = j.id
        )
        and (sent.job_id is null
          or sent.last_dispatched_at <= clock_timestamp() - interval '5 minutes')
        and (
          select count(*) from public.document_processing_jobs recent
          where recent.org_id = j.org_id
            and recent.interpretation_started_at >= clock_timestamp() - interval '1 hour'
        ) < p_max_starts_per_org_hour
    )
    select id, org_id, first_dispatch from eligible
    where tenant_position = 1
    order by created_at, id
    limit p_limit
  loop
    if not coalesce(private.organization_write_allowed_fenced(v_candidate.org_id), false) then
      continue;
    end if;

    if v_candidate.first_dispatch then
      v_entitlement := public.effective_entitlement(
        v_candidate.org_id, 'documents.automatic_monthly');
      if v_entitlement is null
         or not coalesce((v_entitlement ->> 'measured')::boolean, false) then
        continue;
      end if;
      v_counter := private.usage_counter_locked(
        v_candidate.org_id, 'documents.automatic_monthly');
      if not coalesce((v_entitlement ->> 'unlimited')::boolean, false)
         and v_counter.quantity + 1 > (v_entitlement ->> 'limit')::numeric then
        continue;
      end if;
    end if;

    perform 1 from public.document_processing_jobs j
    where j.id = v_candidate.id and j.status = 'extracted'
    for update skip locked;
    if not found then continue; end if;

    insert into private.document_interpretation_dispatches (
      job_id, org_id, last_dispatched_at, attempt_count
    ) values (
      v_candidate.id, v_candidate.org_id, clock_timestamp(), 1
    )
    on conflict on constraint document_interpretation_dispatches_pkey do update
      set last_dispatched_at = excluded.last_dispatched_at,
          attempt_count = private.document_interpretation_dispatches.attempt_count + 1;

    if v_candidate.first_dispatch then
      perform private.record_usage_event(
        v_candidate.org_id, 'documents.automatic_monthly', 1,
        v_candidate.id::text, 'automatic_interpretation_dispatch');
    end if;

    job_id := v_candidate.id;
    return next;
  end loop;
end
$$;
revoke all on function private.claim_document_interpretation_jobs(integer, integer)
  from public, anon, authenticated, service_role;

-- ===== 6. Data API capability fence =====

create table private.plan_api_capability_rules (
  request_path text not null,
  request_method text not null default '*'
    check (request_method in ('*', 'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  entitlement_key text not null references private.entitlement_definitions(entitlement_key),
  actor_role public.user_role,
  primary key (request_path, request_method, entitlement_key)
);
revoke all on table private.plan_api_capability_rules
  from public, anon, authenticated, service_role;

insert into private.plan_api_capability_rules
  (request_path, request_method, entitlement_key, actor_role)
values
  ('bank_imports', '*', 'bank.reconciliation', null),
  ('bank_transactions', '*', 'bank.reconciliation', null),
  ('bank_allocations', '*', 'bank.reconciliation', null),
  ('rpc/import_bank_transactions', '*', 'bank.reconciliation', null),
  ('rpc/unmatch_bank_transaction', '*', 'bank.reconciliation', null),
  ('rpc/match_bank_transaction', '*', 'bank.reconciliation', null),
  ('rpc/assign_bank_transaction_supplier', '*', 'bank.reconciliation', null),
  ('rpc/open_bank_transaction_exception', '*', 'bank.reconciliation', null),
  ('rpc/ignore_bank_transaction', '*', 'bank.reconciliation', null),
  ('payment_requests', 'GET', 'payments.accountant_queue', 'accountant'),
  ('rpc/execute_payment_request', '*', 'payments.accountant_queue', null),
  ('consolidated_invoice_cases', '*', 'invoices.consolidated', null),
  ('consolidated_invoice_intakes', '*', 'invoices.consolidated', null),
  ('consolidated_invoice_intake_pages', '*', 'invoices.consolidated', null),
  ('consolidated_invoice_sources', '*', 'invoices.consolidated', null),
  ('consolidated_invoice_revisions', '*', 'invoices.consolidated', null),
  ('consolidated_invoice_snapshots', '*', 'invoices.consolidated', null),
  ('rpc/list_consolidated_invoice_cases', '*', 'invoices.consolidated', null),
  ('rpc/get_consolidated_invoice_workspace', '*', 'invoices.consolidated', null),
  ('rpc/open_consolidated_invoice_intake', '*', 'invoices.consolidated', null),
  ('rpc/register_consolidated_invoice_page', '*', 'invoices.consolidated', null),
  ('rpc/complete_consolidated_invoice_intake', '*', 'invoices.consolidated', null),
  ('rpc/refresh_consolidated_invoice_reconciliation', '*', 'invoices.consolidated', null),
  ('supplier_metrics', '*', 'reports.advanced', null),
  ('monthly_report_snapshots', '*', 'reports.advanced', null),
  ('monthly_report_snapshot_deliveries', '*', 'reports.advanced', null),
  ('rpc/read_monthly_report_legal_entities', '*', 'reports.advanced', null),
  ('rpc/create_monthly_report_snapshot', '*', 'exports.custom', null),
  ('rpc/mark_monthly_report_snapshot_sent', '*', 'exports.custom', null),
  ('rpc/get_product_purchase_summary', '*', 'reports.advanced', null),
  ('rpc/read_webhook_subscriptions', '*', 'integrations.api', null),
  ('rpc/register_webhook_subscription', '*', 'integrations.api', null),
  ('rpc/set_webhook_subscription_active', '*', 'integrations.api', null);

create or replace function public.check_plan_request() returns void
language plpgsql stable security definer set search_path = public, private, pg_temp as $$
declare
  v_path text := ltrim(coalesce(current_setting('request.path', true), ''), '/');
  v_method text := upper(coalesce(current_setting('request.method', true), ''));
  v_claims jsonb;
  v_role text;
  v_rule record;
begin
  begin
    v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  exception when invalid_text_representation then
    v_claims := '{}'::jsonb;
  end;
  v_role := coalesce(v_claims ->> 'role', current_setting('request.jwt.claim.role', true), '');
  if v_role <> 'authenticated' or public.auth_org() is null then return; end if;

  for v_rule in
    select rule.* from private.plan_api_capability_rules rule
    where rule.request_path = v_path
      and rule.request_method in ('*', v_method)
      and (rule.actor_role is null or rule.actor_role = public.auth_role())
  loop
    if not public.current_plan_capability(v_rule.entitlement_key) then
      raise exception 'plan_capability_required:%', v_rule.entitlement_key using errcode = 'P0001';
    end if;
  end loop;
end
$$;
revoke all on function public.check_plan_request() from public;
grant execute on function public.check_plan_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.check_plan_request';
notify pgrst, 'reload config';

-- ===== 7. Scope registry and assertions =====

-- Both functions read only platform-global catalogue rows. `effective_entitlement` itself is
-- internal-only; `get_public_plan_quotas` intentionally publishes the same global rows to every
-- caller and accepts no organization argument. Register the reviewed reason instead of weakening
-- A5, which correctly noticed that 0246 changed both bodies.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave) values
  ('public.effective_entitlement(uuid,text)'::regprocedure::text,
   'internal-only', '0246 plan capability ladder'),
  ('public.get_public_plan_quotas()'::regprocedure::text,
   'public-global-catalogue', '0246 plan capability ladder');

do $assert_0246$
declare
  v_count integer;
  v_violations text;
begin
  -- Every false is a dated owner decision, and every decision reached the catalogue.
  select count(*) into v_count
  from public.plan_entitlements entitlement
  join public.subscription_plans plan on plan.plan_key = entitlement.plan_key and plan.active
  where entitlement.kind = 'boolean' and entitlement.boolean_value = false
    and not exists (
      select 1 from private.plan_capability_decisions decision
      where decision.plan_key = entitlement.plan_key
        and decision.entitlement_key = entitlement.entitlement_key
        and decision.decided_value = false);
  if v_count <> 0 then
    raise exception '0246: % disabled capability row(s) have no owner decision', v_count;
  end if;

  if exists (
    select 1
    from public.plan_entitlements lower_entitlement
    join public.subscription_plans lower_plan on lower_plan.plan_key = lower_entitlement.plan_key
    join public.plan_entitlements upper_entitlement
      on upper_entitlement.entitlement_key = lower_entitlement.entitlement_key
     and upper_entitlement.kind = 'boolean'
    join public.subscription_plans upper_plan on upper_plan.plan_key = upper_entitlement.plan_key
    where lower_entitlement.kind = 'boolean'
      and lower_plan.active and upper_plan.active
      and lower_plan.tier_order < upper_plan.tier_order
      and lower_entitlement.boolean_value
      and not upper_entitlement.boolean_value
  ) then
    raise exception '0246: the capability ladder is not monotonic';
  end if;

  if (select count(*) from public.get_public_plan_features()) <> 44 then
    raise exception '0246: the public feature catalogue is incomplete';
  end if;

  if exists (
    select 1 from public.get_public_plan_features()
    where plan_key = 'business'
  ) then
    raise exception '0246: Business leaked into the public feature catalogue';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    where relation.relname = 'profiles' and trigger_row.tgname = 'zz_profiles_plan_limit'
      and not trigger_row.tgisinternal
  ) or not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    where relation.relname = 'org_units' and trigger_row.tgname = 'zz_org_units_plan_limit'
      and not trigger_row.tgisinternal
  ) then
    raise exception '0246: a publishable current-count quota has no write guard';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('private.claim_document_interpretation_jobs(integer,integer)')
      and prosrc like '%documents.automatic_monthly%'
      and prosrc like '%record_usage_event%'
  ) then
    raise exception '0246: the automatic document quota has no runtime consumer';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0246 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0246 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0246$;
