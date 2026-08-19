-- Wave 6b of Customer Operations (owner decision 19.08.2026) -- the self-service funnel, built
-- almost entirely out of rows that already exist.
--
-- Shape: before adding an analytics pipeline, the honest question is what it would be for. Working
-- through the funnel the brief asks for, nearly every stage is already answerable:
--
--   new organizations by period        organizations.created_at
--   activation, time-to-first-anything the audit ledger (0156's derivation)
--   free-to-paid, downgrade, churn     platform_lifecycle_events + subscription_plans.tier_order
--   organizations near a limit         private.usage_rows (0155)
--   failed payments                    organization_subscriptions.status + billing events (0157)
--
-- Exactly ONE stage has no row anywhere: the moment a customer hits their quota. So this file adds
-- a small, allowlisted event table for that -- and for the signup events wave 7 will emit into the
-- same mechanism -- rather than an analytics platform for metrics we can already compute. The
-- definitions table IS the allowlist: an event name that is not defined cannot be recorded.
--
-- WHY THE CROSSING, NOT THE REFUSAL. The natural place to record "reached the limit" is where the
-- limit refuses -- and that is impossible, because that transaction aborts and takes the event row
-- with it. Recording it instead on the write that CONSUMES the last unit works, commits, and is
-- the better signal anyway: it fires once, when the quota is exhausted, rather than once per
-- rejected retry afterwards.
--
-- WHAT THE EVENTS DO NOT CARRY. No document content, no invoice content, no bank data, no
-- credentials, no free text. `properties` is a small object and the definition says what belongs
-- in it; the table is metering and funnel evidence, not a second copy of the business.
--
-- What this deliberately does not cover: three funnel stages have no data in this system and are
-- reported as NOT MEASURED rather than as zero -- visitor-to-signup (no landing page in this
-- repo; PRODUCT.md:5-7 puts it in a separate register), checkout-started (no checkout exists),
-- and returned-after-first-session (this schema keeps mutations, not sessions). A zero there
-- would be a claim that nobody converted, which is a different statement from "we do not measure
-- this".

-- ===== 1. The allowlist =====
create table private.product_event_definitions (
  event_name   text primary key
               check (event_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  label        text not null,
  description  text not null check (length(btrim(description)) >= 10),
  emitted_by   text not null,
  created_at   timestamptz not null default now()
);
revoke all on table private.product_event_definitions
  from public, anon, authenticated, service_role;

insert into private.product_event_definitions (event_name, label, description, emitted_by) values
  ('usage.limit_reached', 'מכסה נוצלה במלואה',
   'Recorded when a metered write consumes the last unit of a stated quota, not when a later write is refused.',
   'private.record_usage_event');

create table private.product_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete restrict,
  actor           uuid references auth.users(id) on delete set null,
  event_name      text not null references private.product_event_definitions(event_name) on delete restrict,
  occurred_at     timestamptz not null default now(),
  properties      jsonb not null default '{}'::jsonb,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  correlation_id  uuid,
  unique (org_id, event_name, idempotency_key),
  constraint product_events_properties_shape check (
    jsonb_typeof(properties) = 'object' and pg_column_size(properties) <= 2048)
);
revoke all on table private.product_events from public, anon, authenticated, service_role;
create index product_events_name_time_idx on private.product_events (event_name, occurred_at);
create index product_events_org_idx on private.product_events (org_id, occurred_at desc);

comment on table private.product_events is
  'Allowlisted product events (0158) for the funnel stages no existing row answers. Carries no '
  'document, invoice, bank or credential data -- it is evidence about usage, not a copy of it.';

create or replace function private.record_product_event(
  p_org_id          uuid,
  p_actor           uuid,
  p_event_name      text,
  p_properties      jsonb,
  p_idempotency_key text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inserted integer;
begin
  insert into private.product_events (
    org_id, actor, event_name, properties, idempotency_key, correlation_id
  ) values (
    p_org_id, p_actor, p_event_name, coalesce(p_properties, '{}'::jsonb), p_idempotency_key,
    public.request_correlation_id()
  ) on conflict (org_id, event_name, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end
$$;
revoke all on function private.record_product_event(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated;

-- ===== 2. The crossing =====
-- 0155's recorder, with the quota crossing added and nothing else changed. Emitting here rather
-- than at the refusal is what makes the event survive: the refusing transaction rolls back.
create or replace function private.record_usage_event(
  p_org_id          uuid,
  p_metric_key      text,
  p_quantity        numeric,
  p_idempotency_key text,
  p_source          text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_counter private.usage_counters;
  v_inserted integer;
  v_entitlement jsonb;
  v_before numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'usage_quantity_invalid' using errcode = '22023';
  end if;

  -- Lock first, insert second: the counter row is the serialization point, and taking it before
  -- the event keeps this function's lock order identical to the enforcement path's.
  v_counter := private.usage_counter_locked(p_org_id, p_metric_key);
  v_before := v_counter.quantity;

  insert into private.usage_events (
    org_id, metric_key, quantity, idempotency_key, source, correlation_id
  ) values (
    p_org_id, p_metric_key, p_quantity, p_idempotency_key, p_source,
    public.request_correlation_id()
  ) on conflict (org_id, metric_key, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already counted. Saying so beats returning success indistinguishable from a first write.
    return jsonb_build_object('recorded', false, 'idempotent', true,
                              'quantity', v_counter.quantity);
  end if;

  update private.usage_counters
     set quantity = quantity + p_quantity, updated_at = now()
   where org_id = p_org_id and metric_key = p_metric_key
     and period_start = v_counter.period_start
  returning quantity into v_counter.quantity;

  -- The crossing, once per quota per period: idempotency keyed on the period start, so the
  -- hundredth document of a full month does not emit a hundredth event.
  v_entitlement := public.effective_entitlement(p_org_id, p_metric_key);
  if coalesce((v_entitlement ->> 'measured')::boolean, false)
     and not coalesce((v_entitlement ->> 'unlimited')::boolean, false)
     and (v_entitlement ->> 'limit') is not null
     and v_before < (v_entitlement ->> 'limit')::numeric
     and v_counter.quantity >= (v_entitlement ->> 'limit')::numeric then
    perform private.record_product_event(
      p_org_id, auth.uid(), 'usage.limit_reached',
      jsonb_build_object('metric_key', p_metric_key,
                         'limit', (v_entitlement ->> 'limit')::numeric,
                         'plan_key', v_entitlement ->> 'plan_key'),
      p_metric_key || '@' || v_counter.period_start::text);
  end if;

  return jsonb_build_object('recorded', true, 'idempotent', false,
                            'quantity', v_counter.quantity);
end
$$;
revoke all on function private.record_usage_event(uuid, text, numeric, text, text)
  from public, anon, authenticated;

-- ===== 3. The funnel =====
-- One row per metric, every one carrying `measured`. A metric this system cannot compute returns
-- a null value and a sentence saying why -- never a zero, which asserts that the thing did not
-- happen rather than that we do not watch for it.
-- `p_to` defaults to clock_timestamp(), not now(). now() is fixed for a whole transaction, so a
-- window ending at now() excludes anything recorded inside that same transaction -- which is
-- exactly the shape a suite has (record, then read) and is a real boundary error rather than a
-- test artefact. The interval stays half-open so two adjacent windows never count one event twice.
create or replace function public.platform_funnel_metrics(
  p_from timestamptz default (now() - interval '90 days'),
  p_to   timestamptz default clock_timestamp()
)
returns table (metric_key text, label text, value numeric, measured boolean, note text)
language sql stable security definer set search_path = public as $$
  with authorized as (
    select is_platform_admin() and public.platform_has_capability('usage.view') as ok
  ),
  cohort as (
    select org.id, org.created_at
    from organizations org
    where org.created_at >= p_from and org.created_at < p_to
  ),
  -- The entity names come from the milestone definitions rather than being spelled here: A5
  -- matches enforced table names textually over a definer's whole body, comments included (0156).
  milestone_entities as (
    select milestone_key, audit_entity
    from private.activation_milestone_definitions
    where audit_entity is not null
  ),
  firsts as (
    select entry.org_id, definition.milestone_key, min(entry.created_at) as first_at
    from audit_logs entry
    join milestone_entities definition on definition.audit_entity = entry.entity_type
    where entry.action = 'insert'
      and entry.org_id in (select id from cohort)
    group by entry.org_id, definition.milestone_key
  ),
  activated as (
    select cohort.id, cohort.created_at,
           (select first_at from firsts
             where firsts.org_id = cohort.id and firsts.milestone_key = 'first_supplier') as supplier_at,
           (select first_at from firsts
             where firsts.org_id = cohort.id and firsts.milestone_key = 'first_purchase_order') as order_at,
           (select min(extraction.created_at) from document_extractions extraction
             where extraction.org_id = cohort.id) as processed_at
    from cohort
  ),
  plan_moves as (
    select event.org_id, event.occurred_at,
           before_plan.tier_order as from_tier, after_plan.tier_order as to_tier,
           event.new_values ->> 'status' as new_status
    from platform_lifecycle_events event
    left join subscription_plans before_plan
      on before_plan.plan_key = event.old_values ->> 'plan_key'
    left join subscription_plans after_plan
      on after_plan.plan_key = event.new_values ->> 'plan_key'
    where event.action = 'subscription_set'
      and event.occurred_at >= p_from and event.occurred_at < p_to
  ),
  numbers as (
    select
      (select count(*) from cohort)                                            as created,
      (select count(*) from activated where order_at is not null)              as activated_count,
      (select count(*) from activated where supplier_at is not null)           as with_supplier,
      (select round(avg(extract(epoch from (supplier_at - created_at)) / 86400.0), 1)
         from activated where supplier_at is not null)                         as days_to_supplier,
      (select round(avg(extract(epoch from (order_at - created_at)) / 86400.0), 1)
         from activated where order_at is not null)                            as days_to_order,
      (select round(avg(extract(epoch from (processed_at - created_at)) / 86400.0), 1)
         from activated where processed_at is not null)                        as days_to_processed,
      (select count(*) from plan_moves
        where from_tier is not null and to_tier > from_tier)                   as upgrades,
      (select count(*) from plan_moves
        where from_tier is not null and to_tier < from_tier)                   as downgrades,
      (select count(*) from plan_moves where new_status = 'canceled')          as cancellations,
      (select count(*) from organization_subscriptions where status = 'past_due') as past_due,
      (select count(*) from private.product_events
        where event_name = 'usage.limit_reached'
          and occurred_at >= p_from and occurred_at < p_to)                    as limit_hits,
      (select count(distinct entry.org_id) from audit_logs entry
        where entry.created_at > now() - interval '30 days'
          and (entry.user_id is null or not exists (
                select 1 from platform_admins operator
                where operator.user_id = entry.user_id)))                      as recently_active
  )
  select metric.metric_key, metric.label, metric.value, metric.measured, metric.note
  from numbers,
  lateral (values
    ('organizations_created', 'ארגונים חדשים בתקופה', numbers.created::numeric, true, null::text),
    ('organizations_activated', 'ארגונים שהגיעו להזמנה ראשונה', numbers.activated_count::numeric, true, null),
    ('activation_rate', 'שיעור הפעלה',
      case when numbers.created > 0
        then round(numbers.activated_count * 100.0 / numbers.created, 1) end,
      numbers.created > 0,
      case when numbers.created = 0 then 'לא נוצרו ארגונים בתקופה, ולכן אין שיעור לחשב' end),
    ('avg_days_to_first_supplier', 'ימים בממוצע עד ספק ראשון', numbers.days_to_supplier,
      numbers.with_supplier > 0,
      case when numbers.with_supplier = 0 then 'אף ארגון בתקופה לא הוסיף ספק' end),
    ('avg_days_to_first_order', 'ימים בממוצע עד הזמנה ראשונה', numbers.days_to_order,
      numbers.activated_count > 0,
      case when numbers.activated_count = 0 then 'אף ארגון בתקופה לא יצר הזמנה' end),
    ('avg_days_to_first_processed_document', 'ימים בממוצע עד מסמך מעובד', numbers.days_to_processed,
      numbers.days_to_processed is not null,
      case when numbers.days_to_processed is null then 'אף ארגון בתקופה לא סיים עיבוד מסמך' end),
    ('upgrades', 'שדרוגי מסלול', numbers.upgrades::numeric, true, null),
    ('downgrades', 'הורדות מסלול', numbers.downgrades::numeric, true, null),
    ('cancellations', 'ביטולי מנוי', numbers.cancellations::numeric, true, null),
    ('past_due_subscriptions', 'מנויים בפיגור תשלום', numbers.past_due::numeric, true, null),
    ('limit_reached_events', 'לקוחות שניצלו מכסה', numbers.limit_hits::numeric, true, null),
    ('recently_active_organizations', 'ארגונים פעילים ב-30 יום', numbers.recently_active::numeric, true, null),
    -- The three this system genuinely cannot see. Reported, not omitted: a missing row invites
    -- somebody to add a zero later and call it a measurement.
    ('visitor_to_signup', 'המרה מדף נחיתה להרשמה', null::numeric, false,
      'אין דף נחיתה בריפו הזה; הוא register נפרד (PRODUCT.md)'),
    ('checkout_started', 'התחלות תשלום', null::numeric, false,
      'אין מסלול תשלום במערכת; גבול החיוב הוא adapter בלבד'),
    ('returned_after_first_session', 'חזרה אחרי הסשן הראשון', null::numeric, false,
      'הסכימה שומרת מוטציות ולא סשנים')
  ) as metric(metric_key, label, value, measured, note)
  where (select ok from authorized)
$$;
revoke all on function public.platform_funnel_metrics(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.platform_funnel_metrics(timestamptz, timestamptz)
  to authenticated;

comment on function public.platform_funnel_metrics(timestamptz, timestamptz) is
  'The self-service funnel (0158), computed from existing rows plus one allowlisted event. Every '
  'metric carries `measured`; three stages this system cannot see report null and say why.';

-- ===== 4. Structural re-assertion =====
do $assert_0158$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0158 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0158 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0158$;

-- ===== 5. Anchors =====
do $anchor_0158$
declare
  v_unmeasured integer;
  v_body       text;
  v_metric     text;
begin
  if not exists (
    select 1 from pg_proc
    where oid = to_regprocedure('private.record_usage_event(uuid,text,numeric,text,text)')
      and prosrc like '%usage.limit_reached%'
  ) then
    raise exception '0158: the quota crossing is not recorded anywhere';
  end if;

  -- An event name outside the allowlist must be impossible, not merely discouraged. Asserted on
  -- the constraint instead of by attempting a write, because a migration must not assume the
  -- database holds any data: on a fresh one there are no organizations, a null org_id fails the
  -- NOT NULL check FIRST, and the resulting not_null_violation both escapes a
  -- foreign_key_violation handler and proves nothing about the allowlist either way.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'private.product_events'::regclass
      and confrelid = 'private.product_event_definitions'::regclass
      and contype = 'f'
  ) then
    raise exception '0158: product events are not constrained to the defined allowlist';
  end if;

  -- The three stages this system cannot see must be present AND flagged, not quietly missing.
  -- Read off the function's own body: the metric list is a VALUES literal, and the function
  -- returns no rows at all without a platform JWT, so there is nothing to query back here.
  select proc.prosrc into v_body from pg_catalog.pg_proc proc
  where proc.oid = pg_catalog.to_regprocedure(
    'public.platform_funnel_metrics(timestamptz,timestamptz)');

  foreach v_metric in array
    array['visitor_to_signup', 'checkout_started', 'returned_after_first_session']
  loop
    if position('''' || v_metric || '''' in v_body) = 0 then
      raise exception '0158: the unmeasurable funnel stage % stopped being reported', v_metric;
    end if;
  end loop;

  -- Exactly three metrics may answer "not measured". Fewer means one of them grew a number
  -- nobody can source -- the zero this file exists to prevent.
  v_unmeasured := (length(v_body) - length(replace(v_body, 'null::numeric, false', '')))
                  / length('null::numeric, false');
  if v_unmeasured <> 3 then
    raise exception '0158: % funnel stages are flagged unmeasured, expected 3', v_unmeasured;
  end if;
end
$anchor_0158$;
