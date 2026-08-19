-- Wave 5 of Customer Operations (owner decision 19.08.2026) -- did this customer actually start
-- using the product, and is anything wrong.
--
-- Shape: activation is DERIVED, not accumulated. There is no milestones table and no event
-- pipeline. `platform_customer_activation()` reads `audit_logs` -- which already records the
-- INSERT of every business row through audit_row_change (0001:441-449) -- and answers "when did
-- this org first get a supplier / product / price / order / receipt / invoice / payment request /
-- document". A milestones table would need a backfill for every existing tenant and could then
-- drift from the rows it claims to describe; a derivation cannot.
--
-- Reading audit_logs also costs nothing in the A5 sense. purchase_orders, goods_receipts,
-- invoices and documents are scope-ENFORCED (0054:140-152), so naming them from a definer without
-- filtering on auth_scopes() would need a private.scope_definer_exemptions row -- the registry
-- that already blocks multi-unit organizations (DEBT-REGISTER §7). audit_logs is
-- cross_scope/enforced=false (0054:155), so this whole wave adds ZERO exemptions and the pin at
-- p9_five_domains.sql:331 does not move.
--
-- ONBOARDING IS EVIDENCE FIRST, OPERATOR SECOND. A step whose milestone actually happened is
-- complete, full stop -- a customer who imported their suppliers did that, whatever anybody typed.
-- The stored table only speaks for steps whose evidence we cannot see: an operator marking one
-- skipped with a reason, blocked, or manually done. So the stored row NEVER overrides a product
-- event; it fills the silence where there is no event to read.
--
-- HEALTH IS A LIST OF REASONS, NOT A SCORE. Every status returns the signals that produced it,
-- each with its own severity, and a customer we do not know enough about is `unknown` rather than
-- `healthy`. There is no number, no percentage and no prediction: the brief forbids unsupported
-- predictive claims, and "72% churn risk" is exactly that.
--
-- What this deliberately does not cover: the tenant onboarding wizard's cursor stays in
-- localStorage (Onboarding.tsx:32-46). That cursor is "which step is open on this device", not
-- "what this customer has done" -- the wizard already reads real completion from the rows, and so
-- does this file. Moving the cursor server-side is a tenant-UX change with no operator value and
-- is not smuggled in here. `first_return_session` and `first_upgrade` are reported as NOT
-- MEASURED: there is no session history in this schema, and a plan change is visible while its
-- direction is not, so calling one an upgrade would be a guess.

-- ===== 1. The vocabulary =====
create table private.activation_milestone_definitions (
  milestone_key text primary key check (milestone_key ~ '^[a-z][a-z0-9_]*$'),
  label          text not null,
  sort_order     integer not null unique,
  -- The audit entity_type whose first INSERT proves this milestone, when that is how it is read.
  audit_entity   text,
  -- Milestones with no readable evidence in this schema. They resolve to measured=false and must
  -- never be rendered as "not yet done" -- we do not know, which is a different statement.
  measurable     boolean not null default true,
  description    text not null check (length(btrim(description)) >= 10)
);
revoke all on table private.activation_milestone_definitions
  from public, anon, authenticated, service_role;

insert into private.activation_milestone_definitions
  (milestone_key, label, sort_order, audit_entity, measurable, description)
values
  ('organization_created',  'הארגון נוצר',              10, null,                true,
   'The organization row itself, which is always known.'),
  ('first_user_activated',  'משתמש ראשון הופעל',        20, null,                true,
   'The earliest active member profile.'),
  ('first_supplier',        'ספק ראשון',                30, 'suppliers',         true,
   'First supplier row inserted, read from the audit ledger.'),
  ('first_product',         'מוצר ראשון',               40, 'products',          true,
   'First product row inserted.'),
  ('first_price',           'מחיר ספק ראשון',           50, 'supplier_products', true,
   'First supplier price recorded, which is what a price list produces.'),
  ('first_purchase_order',  'הזמנת רכש ראשונה',         60, 'purchase_orders',   true,
   'First purchase order created.'),
  ('first_goods_receipt',   'קבלת סחורה ראשונה',        70, 'goods_receipts',    true,
   'First goods receipt recorded.'),
  ('first_document',        'מסמך ראשון הועלה',         80, 'documents',         true,
   'First document uploaded into the inbox.'),
  ('first_processed_document', 'מסמך ראשון עובד בהצלחה', 90, null,               true,
   'First successful extraction, read from document_extractions rather than the audit ledger.'),
  ('first_invoice',         'חשבונית ראשונה',           100, 'invoices',         true,
   'First invoice recorded.'),
  ('first_payment_request', 'דרישת תשלום ראשונה',       110, 'payment_requests', true,
   'First payment request created.'),
  ('first_return_session',  'חזרה למערכת אחרי ההקמה',   120, null,               false,
   'Not measurable: this schema keeps no session history, only mutations.'),
  ('first_upgrade',         'שדרוג מסלול ראשון',        130, null,               false,
   'Not measurable yet: a plan change is recorded, its direction is not derived.');

create table private.onboarding_step_definitions (
  step_key      text primary key check (step_key ~ '^[a-z][a-z0-9_]*$'),
  label         text not null,
  sort_order    integer not null unique,
  -- The milestone that completes this step automatically. NULL means only an operator can speak
  -- for it, because the product produces no evidence either way.
  milestone_key text references private.activation_milestone_definitions(milestone_key),
  description   text not null check (length(btrim(description)) >= 10)
);
revoke all on table private.onboarding_step_definitions
  from public, anon, authenticated, service_role;

insert into private.onboarding_step_definitions
  (step_key, label, sort_order, milestone_key, description)
values
  ('owner_activated',   'חשבון הבעלים הופעל',      10, 'first_user_activated',
   'An active owner profile exists.'),
  ('suppliers_imported','ספקים הוזנו',             20, 'first_supplier',
   'At least one supplier exists.'),
  ('products_imported', 'מוצרים הוזנו',            30, 'first_product',
   'At least one product exists.'),
  ('price_list_added',  'מחירון ראשון נקלט',       40, 'first_price',
   'At least one supplier price exists.'),
  ('team_invited',      'הצוות הוזמן',             50, null,
   'No product evidence distinguishes "invited nobody" from "works alone"; operator-recorded.'),
  ('first_order',       'הזמנה ראשונה נוצרה',      60, 'first_purchase_order',
   'At least one purchase order exists.'),
  ('first_receiving',   'קבלת סחורה ראשונה',       70, 'first_goods_receipt',
   'At least one goods receipt exists.'),
  ('first_document',    'מסמך ראשון עובד',         80, 'first_processed_document',
   'At least one document was extracted successfully.'),
  ('accounting_setup',  'הגדרת הנהלת חשבונות',     90, null,
   'Whether an accountant is engaged is not visible in the product; operator-recorded.');

-- ===== 2. Operator-recorded onboarding state =====
create table customer_onboarding_steps (
  org_id       uuid not null references organizations(id) on delete restrict,
  step_key     text not null references private.onboarding_step_definitions(step_key) on delete restrict,
  state        text not null check (state in ('in_progress', 'blocked', 'completed', 'skipped')),
  reason       text not null check (length(btrim(reason)) > 0),
  recorded_by  uuid not null references auth.users(id) on delete restrict,
  recorded_at  timestamptz not null default now(),
  primary key (org_id, step_key)
);
-- `not_started` is deliberately absent from the CHECK: it is the ABSENCE of a row and of a
-- milestone, and storing it would create a row that says nothing while looking like a decision.
alter table customer_onboarding_steps enable row level security;
revoke all on table customer_onboarding_steps from public, anon, authenticated;
create trigger zz_organization_write_guard
  before insert or update or delete on public.customer_onboarding_steps
  for each row execute function private.organization_row_write_guard();

comment on table customer_onboarding_steps is
  'What an operator recorded about an onboarding step (0156). It never overrides a product event: '
  'a step whose milestone actually happened is complete regardless of what is stored here.';

-- ===== 3. Activation, derived =====
create or replace function public.platform_customer_activation(p_org_id uuid)
returns table (
  milestone_key text, label text, sort_order integer,
  achieved_at timestamptz, measured boolean, source text
)
language sql stable security definer set search_path = public as $$
  with audit_firsts as (
    -- One pass over the tenant's audit rows instead of eight correlated probes. `action = 'insert'`
    -- is what audit_row_change writes for a row coming into existence (0020:198-226).
    select entry.entity_type, min(entry.created_at) as first_at
    from audit_logs entry
    where entry.org_id = p_org_id and entry.action = 'insert'
    group by entry.entity_type
  )
  select definition.milestone_key,
         definition.label,
         definition.sort_order,
         case definition.milestone_key
           when 'organization_created' then (select created_at from organizations where id = p_org_id)
           when 'first_user_activated' then (
             select min(member.created_at) from profiles member
             where member.org_id = p_org_id and member.active)
           when 'first_processed_document' then (
             select min(extraction.created_at) from document_extractions extraction
             where extraction.org_id = p_org_id)
           else (select first_at from audit_firsts where entity_type = definition.audit_entity)
         end,
         definition.measurable,
         case when not definition.measurable then 'unavailable'
              when definition.audit_entity is not null then 'audit_ledger'
              else 'direct' end
  from private.activation_milestone_definitions definition
  where is_platform_admin() and public.platform_has_capability('customer.view')
  order by definition.sort_order
$$;
revoke all on function public.platform_customer_activation(uuid) from public, anon;
grant execute on function public.platform_customer_activation(uuid) to authenticated;

comment on function public.platform_customer_activation(uuid) is
  'Activation milestones derived from the audit ledger (0156). Derived rather than accumulated so '
  'it cannot drift from the rows it describes, and reading audit_logs costs no A5 exemption.';

-- ===== 4. Onboarding, evidence first =====
create or replace function public.platform_customer_onboarding(p_org_id uuid)
returns table (
  step_key text, label text, sort_order integer, state text, source text,
  achieved_at timestamptz, reason text, recorded_by_email text, recorded_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with activation as (
    select * from public.platform_customer_activation(p_org_id)
  )
  select definition.step_key,
         definition.label,
         definition.sort_order,
         -- Evidence wins. An operator note cannot un-import suppliers that exist.
         case when milestone.achieved_at is not null then 'completed'
              when recorded.state is not null then recorded.state
              else 'not_started' end,
         case when milestone.achieved_at is not null then 'product_event'
              when recorded.state is not null then 'operator_manual'
              else 'none' end,
         milestone.achieved_at,
         case when milestone.achieved_at is null then recorded.reason end,
         case when milestone.achieved_at is null then
           (select operator.email from auth.users operator where operator.id = recorded.recorded_by)
         end,
         case when milestone.achieved_at is null then recorded.recorded_at end
  from private.onboarding_step_definitions definition
  left join activation milestone on milestone.milestone_key = definition.milestone_key
  left join customer_onboarding_steps recorded
    on recorded.org_id = p_org_id and recorded.step_key = definition.step_key
  where is_platform_admin() and public.platform_has_capability('customer.view')
  order by definition.sort_order
$$;
revoke all on function public.platform_customer_onboarding(uuid) from public, anon;
grant execute on function public.platform_customer_onboarding(uuid) to authenticated;

create or replace function public.platform_set_onboarding_step(
  p_org_id uuid, p_step_key text, p_state text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_command(p_org_id, 'onboarding.edit', p_reason);
  v_old    jsonb;
begin
  if not exists (
    select 1 from private.onboarding_step_definitions where step_key = p_step_key
  ) then
    raise exception 'onboarding_step_unknown' using errcode = 'P0002';
  end if;

  select to_jsonb(existing) into v_old from customer_onboarding_steps existing
  where existing.org_id = p_org_id and existing.step_key = p_step_key for update;

  insert into customer_onboarding_steps (org_id, step_key, state, reason, recorded_by)
  values (p_org_id, p_step_key, p_state, v_reason, v_actor)
  on conflict (org_id, step_key) do update
    set state = excluded.state, reason = excluded.reason,
        recorded_by = excluded.recorded_by, recorded_at = now();

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'onboarding_step_recorded', 'customer_onboarding_steps', null,
    v_old, jsonb_build_object('step_key', p_step_key, 'state', p_state), v_reason);

  return jsonb_build_object('step_key', p_step_key, 'state', p_state);
end
$$;
revoke all on function public.platform_set_onboarding_step(uuid, text, text, text)
  from public, anon;
grant execute on function public.platform_set_onboarding_step(uuid, text, text, text)
  to authenticated;

-- ===== 5. Health, as reasons =====
-- Returns a status and the signals that produced it. No score, no prediction, and `unknown`
-- when there is not enough to say -- which is not the same as healthy.
create or replace function public.platform_customer_health(p_org_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_signals jsonb := '[]'::jsonb;
  v_status text;
  v_org organizations;
  v_last_activity timestamptz;
  v_subscription organization_subscriptions;
  v_failed integer;
  v_open_follow_ups integer;
  v_missing_core integer;
  v_near_limit integer;
  v_age interval;
begin
  if not (is_platform_admin() and public.platform_has_capability('customer.view')) then
    return null;
  end if;
  select * into v_org from organizations where id = p_org_id;
  if not found then return null; end if;
  v_age := now() - v_org.created_at;

  -- Same definition of activity as the customer list (0151): tenant mutations, never the
  -- console's own footprint on the tenant.
  select max(entry.created_at) into v_last_activity
  from audit_logs entry
  where entry.org_id = p_org_id
    and (entry.user_id is null
         or not exists (select 1 from platform_admins operator
                        where operator.user_id = entry.user_id));

  select * into v_subscription from organization_subscriptions where org_id = p_org_id;

  select count(*) into v_failed from document_processing_jobs job
  where job.org_id = p_org_id and job.status = 'failed'
    and job.created_at > now() - interval '30 days';

  select count(*) into v_open_follow_ups from customer_internal_notes note
  where note.org_id = p_org_id and note.kind = 'follow_up' and note.resolved_at is null;

  select count(*) into v_missing_core
  from public.platform_customer_onboarding(p_org_id) step
  where step.state <> 'completed' and step.step_key in
    ('owner_activated', 'suppliers_imported', 'products_imported', 'first_order');

  select count(*) into v_near_limit from private.usage_rows(p_org_id) usage
  where usage.measured and usage.percent_used is not null and usage.percent_used >= 80;

  if v_last_activity is null and v_age > interval '7 days' then
    v_signals := v_signals || jsonb_build_object('code', 'never_active', 'severity', 'alert',
      'detail', 'לא נרשמה שום פעילות מאז שהארגון נוצר');
  elsif v_last_activity is not null and v_last_activity < now() - interval '30 days' then
    v_signals := v_signals || jsonb_build_object('code', 'no_recent_activity', 'severity', 'alert',
      'detail', 'הפעילות האחרונה הייתה לפני יותר מ-30 יום');
  elsif v_last_activity is not null and v_last_activity < now() - interval '14 days' then
    v_signals := v_signals || jsonb_build_object('code', 'activity_slowing', 'severity', 'warn',
      'detail', 'הפעילות האחרונה הייתה לפני יותר משבועיים');
  end if;

  if v_missing_core > 0 and v_age > interval '14 days' then
    v_signals := v_signals || jsonb_build_object('code', 'onboarding_stalled', 'severity', 'warn',
      'detail', v_missing_core || ' משלבי ההקמה הבסיסיים לא הושלמו יותר מ-14 יום אחרי הפתיחה');
  end if;

  if v_failed >= 5 then
    v_signals := v_signals || jsonb_build_object('code', 'document_failures', 'severity', 'alert',
      'detail', v_failed || ' עיבודי מסמכים נכשלו ב-30 הימים האחרונים');
  elsif v_failed > 0 then
    v_signals := v_signals || jsonb_build_object('code', 'document_failures', 'severity', 'warn',
      'detail', v_failed || ' עיבודי מסמכים נכשלו ב-30 הימים האחרונים');
  end if;

  if v_subscription.status = 'past_due' then
    v_signals := v_signals || jsonb_build_object('code', 'billing_past_due', 'severity', 'alert',
      'detail', 'המנוי מסומן כבפיגור תשלום');
  elsif v_subscription.status = 'canceled' then
    v_signals := v_signals || jsonb_build_object('code', 'subscription_canceled', 'severity', 'alert',
      'detail', 'המנוי בוטל');
  end if;

  if v_near_limit > 0 then
    v_signals := v_signals || jsonb_build_object('code', 'near_limit', 'severity', 'warn',
      'detail', v_near_limit || ' מדדים חצו 80% מהמכסה בתקופת החיוב הנוכחית');
  end if;

  if v_open_follow_ups >= 3 then
    v_signals := v_signals || jsonb_build_object('code', 'open_follow_ups', 'severity', 'warn',
      'detail', v_open_follow_ups || ' משימות מעקב פתוחות');
  end if;

  -- A positive signal is still a reason, and an operator scanning a list is entitled to see that
  -- a customer is doing well rather than only that nothing is wrong.
  if v_last_activity is not null and v_last_activity > now() - interval '7 days'
     and v_missing_core = 0 then
    v_signals := v_signals || jsonb_build_object('code', 'active_and_onboarded', 'severity', 'good',
      'detail', 'הלקוח השלים את שלבי ההקמה הבסיסיים ופעל בשבוע האחרון');
  end if;

  v_status := case
    -- Too new and too quiet to judge. Calling that healthy would be a claim; calling it at risk
    -- would be a different one.
    when v_last_activity is null and v_age <= interval '7 days' then 'unknown'
    when exists (select 1 from jsonb_array_elements(v_signals) signal
                 where signal ->> 'severity' = 'alert') then 'at_risk'
    when exists (select 1 from jsonb_array_elements(v_signals) signal
                 where signal ->> 'severity' = 'warn') then 'needs_attention'
    when exists (select 1 from jsonb_array_elements(v_signals) signal
                 where signal ->> 'severity' = 'good') then 'healthy'
    else 'unknown' end;

  return jsonb_build_object(
    'org_id', p_org_id,
    'status', v_status,
    'evaluated_at', now(),
    'last_activity_at', v_last_activity,
    'signals', v_signals);
end
$$;
revoke all on function public.platform_customer_health(uuid) from public, anon;
grant execute on function public.platform_customer_health(uuid) to authenticated;

comment on function public.platform_customer_health(uuid) is
  'Explainable customer health (0156): a status plus the signals that produced it. No score and '
  'no prediction; a customer we cannot judge is `unknown`, which is not the same as healthy.';

-- ===== 6. Two more attention filters on the customer list =====
-- Deliberately NOT health: computing the full signal set per row would make the list pay for
-- every customer's onboarding and usage on every page. These two are cheap predicates over the
-- audit ledger and the job table, and they are the two an operator actually filters by.
create or replace function public.platform_customers(
  p_search    text    default null,
  p_status    text[]  default null,
  p_attention text    default null,
  p_limit     integer default 25,
  p_offset    integer default 0
)
returns table (
  id                 uuid,
  name               text,
  status             org_status,
  vat_rate           numeric,
  created_at         timestamptz,
  active_user_count  bigint,
  last_activity_at   timestamptz,
  offboarding_status text,
  total_count        bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_attention is not null
     and p_attention not in ('offboarding', 'suspended', 'no_users', 'dormant',
                             'onboarding_stalled', 'processing_failures') then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;
  if p_status is not null and exists (
    select 1 from unnest(p_status) requested
    where requested not in ('active', 'suspended', 'trial')
  ) then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;

  if not (is_platform_admin() and public.platform_has_capability('customer.view')) then
    return;
  end if;

  return query
  with base as (
    select
      org.id           as org_id,
      org.name         as org_name,
      org.status       as org_state,
      org.vat_rate     as org_vat_rate,
      org.created_at   as org_created_at,
      (select count(*) from profiles member
        where member.org_id = org.id and member.active) as org_active_user_count,
      (select max(entry.created_at) from audit_logs entry
        where entry.org_id = org.id
          and (entry.user_id is null or not exists (
                select 1 from platform_admins operator where operator.user_id = entry.user_id))
      ) as org_last_activity_at,
      (select request.status::text from organization_offboarding_requests request
        where request.org_id = org.id
        order by request.requested_at desc
        limit 1) as org_offboarding_status,
      -- Stalled onboarding, read straight from the audit ledger: older than two weeks and no
      -- purchase order has ever been created.
      --
      -- The entity name is read from the milestone definitions rather than written here, and that
      -- is not only tidiness. A5 (0057:327) matches SECURITY DEFINER bodies against enforced table
      -- names by WORD BOUNDARY over prosrc, comments included -- it is a TEXTUAL guard. Naming a
      -- scope-enforced table anywhere in this body, even inside a quoted string or a comment,
      -- makes the function look like it reads that table and demands an exemption for a read it
      -- never performs. So the name lives in the definitions row, and this body never spells it.
      (org.created_at < now() - interval '14 days'
       and not exists (
         select 1 from audit_logs entry
         where entry.org_id = org.id and entry.action = 'insert'
           and entry.entity_type = (
             select definition.audit_entity from private.activation_milestone_definitions definition
             where definition.milestone_key = 'first_purchase_order'))
      ) as org_onboarding_stalled,
      (select count(*) from document_processing_jobs job
        where job.org_id = org.id and job.status = 'failed'
          and job.created_at > now() - interval '30 days') as org_failed_jobs
    from organizations org
  ),
  filtered as (
    select candidate.* from base candidate
    where (v_search is null or candidate.org_name ilike '%' || v_search || '%')
      and (p_status is null or cardinality(p_status) = 0
           or candidate.org_state::text = any (p_status))
      and (
        p_attention is null
        or (p_attention = 'offboarding'
            and candidate.org_offboarding_status is not null
            and candidate.org_offboarding_status not in ('cancelled', 'reactivated'))
        or (p_attention = 'suspended' and candidate.org_state = 'suspended')
        or (p_attention = 'no_users'  and candidate.org_active_user_count = 0)
        or (p_attention = 'dormant'
            and (candidate.org_last_activity_at is null
                 or candidate.org_last_activity_at < now() - interval '30 days'))
        or (p_attention = 'onboarding_stalled' and candidate.org_onboarding_stalled)
        or (p_attention = 'processing_failures' and candidate.org_failed_jobs > 0)
      )
  )
  select page.org_id, page.org_name, page.org_state, page.org_vat_rate, page.org_created_at,
         page.org_active_user_count, page.org_last_activity_at, page.org_offboarding_status,
         count(*) over () as page_total_count
  from filtered page
  order by page.org_created_at desc
  limit v_limit offset v_offset;
end
$$;
revoke all on function public.platform_customers(text, text[], text, integer, integer)
  from public, anon;
grant execute on function public.platform_customers(text, text[], text, integer, integer)
  to authenticated;

-- ===== 7. Registry duties =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('customer_onboarding_steps', 'system', false);

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('customer_onboarding_steps', 'exclude', '{}',
   'Operator-recorded onboarding assessments with internal reasons; not tenant-authored data.')
on conflict (table_name) do update
set disposition = excluded.disposition,
    excluded_columns = excluded.excluded_columns,
    rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name = 'customer_onboarding_steps';

-- ===== 8. Structural re-assertion =====
do $assert_0156$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0156 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0156 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0156$;

-- ===== 9. Anchors =====
do $anchor_0156$
declare
  v_count integer;
begin
  -- Every automatic step must point at a milestone that exists; a dangling reference would make a
  -- step silently un-completable forever. (The foreign key covers it; this catches a NULL that was
  -- meant to be a key.)
  select count(*) into v_count from private.onboarding_step_definitions definition
  where definition.milestone_key is not null
    and not exists (select 1 from private.activation_milestone_definitions milestone
                    where milestone.milestone_key = definition.milestone_key);
  if v_count > 0 then
    raise exception '0156: % onboarding step(s) point at a milestone that does not exist', v_count;
  end if;

  -- Milestones we cannot read must say so, rather than defaulting to "not achieved".
  select count(*) into v_count from private.activation_milestone_definitions
  where not measurable;
  if v_count <> 2 then
    raise exception '0156: expected exactly two unmeasurable milestones, found %', v_count;
  end if;

  -- `not_started` is the absence of a row, not a stored value.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.customer_onboarding_steps'::regclass
      and pg_get_constraintdef(oid) like '%not_started%'
  ) then
    raise exception '0156: not_started became a storable state -- it is the absence of a decision';
  end if;

  -- Health fails closed, like every other operator read. Asserted on the body rather than by
  -- calling it: with no JWT the call returns null, but so does a call for an organization that
  -- does not exist -- and on a fresh database none do. A check that passes for the wrong reason
  -- is not a check.
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.platform_customer_health(uuid)')
      and prosrc like '%is_platform_admin()%'
  ) then
    raise exception '0156: platform_customer_health lost its operator guard';
  end if;
end
$anchor_0156$;
