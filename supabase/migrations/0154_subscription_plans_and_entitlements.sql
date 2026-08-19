-- Wave 3 of Customer Operations (owner decision 19.08.2026) -- the plan model. What a customer is
-- entitled to becomes a server-side fact with one resolution rule, instead of nothing at all.
--
-- Shape: four layers, deliberately separate, because collapsing any two of them is how plan logic
-- ends up scattered through React components.
--   * private.entitlement_definitions -- the vocabulary. What can be limited, in what unit, and
--     whether it is a running total or resets with the billing period.
--   * subscription_plans + plan_entitlements -- what each plan grants. Readable by every
--     authenticated user on purpose: a customer has to be able to see what their plan includes and
--     what a higher one would give, and the alternative is pricing logic hardcoded in the client,
--     which ARCHITECTURE.md:244 forbids outright.
--   * organization_subscriptions -- which plan this customer is on, and the billing period.
--   * organization_entitlement_overrides -- one auditable, reasoned, revocable exception.
--
-- `effective_entitlement()` is the single resolution: a live override beats the plan, the plan
-- beats nothing, and nothing is `measured: false` rather than a zero or a guess.
--
-- UNLIMITED IS AN EXPLICIT BOOLEAN, never -1 and never a very large number. And "we do not know"
-- is representable and distinct from both: numeric_limit NULL with unlimited false. Wave 4 reads
-- that as a refusal, not as permission -- a limit nobody has stated cannot be silently treated as
-- infinite when the thing being limited costs money.
--
-- THE NUMBERS ARE NOT IN THIS FILE, and that is the point. What Free may process in a month is a
-- business decision about money, and inventing it here would be exactly the silent guess
-- OPEN-DECISIONS.md:3 forbids. Every numeric entitlement is seeded `unlimited`, every boolean
-- seeded on: the machinery exists, is tested and is auditable, and NO customer is blocked or
-- loses a feature by its arrival. Turning a limit on is then one UPDATE against a seeded row,
-- reviewed as the pricing decision it is -- not a migration.
--
-- Existing customers go onto a `legacy` plan, not onto Free. They predate the plan model and are
-- commercial relationships, not self-service signups; parking them on Free would misstate what
-- they are and would hand them Free's limits the day those limits are set. `legacy` is inactive,
-- so it cannot be chosen for anyone new -- it only holds who is already here.
--
-- What this deliberately does not cover: no enforcement anywhere (wave 4 wires the one real
-- limit, at enqueue_document_processing), no usage counting, no billing provider, no checkout.
-- A plan here changes what the database SAYS a customer may do; nothing yet acts on it.

-- ===== 1. The entitlement vocabulary =====
create table private.entitlement_definitions (
  entitlement_key text primary key
                  check (entitlement_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  kind            text not null check (kind in ('numeric', 'boolean')),
  -- `per_period` resets with the billing period (documents processed this month); `current` is a
  -- running total that never resets (how many suppliers exist right now). Wave 4 reads this to
  -- decide whether a counter is scoped to a period at all.
  measure         text not null check (measure in ('per_period', 'current')),
  unit            text,
  label           text not null,
  description     text not null check (length(btrim(description)) >= 10),
  enforced_since  text,
  created_at      timestamptz not null default now(),
  constraint entitlement_definitions_shape check (
    (kind = 'numeric' and unit is not null)
    or (kind = 'boolean' and measure = 'current' and unit is null)),
  -- Lets plan_entitlements and the override table carry `kind` and have the database, rather than
  -- a comment, guarantee the value shape matches the definition.
  unique (entitlement_key, kind)
);
revoke all on table private.entitlement_definitions
  from public, anon, authenticated, service_role;

insert into private.entitlement_definitions
  (entitlement_key, kind, measure, unit, label, description)
values
  ('users.max',            'numeric', 'current',    'users',     'משתמשים פעילים',
   'How many active member profiles the organization may hold at once.'),
  ('suppliers.max',        'numeric', 'current',    'suppliers', 'ספקים',
   'How many suppliers the organization may hold at once.'),
  ('documents.monthly',    'numeric', 'per_period', 'documents', 'מסמכים בחודש',
   'How many documents may enter processing within one billing period.'),
  ('ocr_pages.monthly',    'numeric', 'per_period', 'pages',     'עמודי OCR בחודש',
   'How many pages may be read by the document pipeline within one billing period.'),
  ('storage.bytes',        'numeric', 'current',    'bytes',     'שטח אחסון',
   'How many bytes of stored documents and exports the organization may hold.'),
  ('reports.advanced',     'boolean', 'current',    null,        'דוחות מתקדמים',
   'Access to the advanced reporting surfaces.'),
  ('bank.reconciliation',  'boolean', 'current',    null,        'התאמות בנק',
   'Access to bank import and reconciliation.'),
  ('documents.automation', 'boolean', 'current',    null,        'אוטומציית מסמכים',
   'Access to automatic document interpretation and its apply paths.'),
  ('exports.custom',       'boolean', 'current',    null,        'ייצוא מותאם',
   'Access to custom export templates and workbook exports.'),
  ('org.multi_unit',       'boolean', 'current',    null,        'ריבוי יחידות',
   'Access to the multi-unit organization scope, once that wave enables it.'),
  ('support.premium',      'boolean', 'current',    null,        'תמיכה מורחבת',
   'Entitlement to the premium support response commitment.');

-- ===== 2. Plans =====
create table subscription_plans (
  plan_key   text primary key check (plan_key ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  -- Orders the ladder so "which plan removes this limit" is answerable without hardcoding names.
  tier_order integer not null,
  -- An inactive plan may still hold customers; it may not be chosen for anyone new.
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tier_order)
);

create table plan_entitlements (
  plan_key        text not null references subscription_plans(plan_key) on delete restrict,
  entitlement_key text not null,
  kind            text not null,
  unlimited       boolean not null default false,
  numeric_limit   numeric,
  boolean_value   boolean,
  updated_at      timestamptz not null default now(),
  primary key (plan_key, entitlement_key),
  constraint plan_entitlements_definition_fk
    foreign key (entitlement_key, kind)
    references private.entitlement_definitions(entitlement_key, kind) on delete restrict,
  -- The three states of a numeric entitlement, and only those three: unlimited, a stated number,
  -- or unknown (both null/false) -- which wave 4 must read as a refusal, never as infinity.
  constraint plan_entitlements_numeric_shape check (
    kind <> 'numeric' or (
      boolean_value is null
      and not (unlimited and numeric_limit is not null)
      and (numeric_limit is null or numeric_limit >= 0))),
  constraint plan_entitlements_boolean_shape check (
    kind <> 'boolean' or (
      numeric_limit is null and unlimited = false and boolean_value is not null))
);

insert into subscription_plans (plan_key, label, tier_order, active) values
  ('legacy',   'לקוח ותיק', 0, false),
  ('free',     'Free',      1, true),
  ('pro',      'Pro',       2, true),
  ('business', 'Business',  3, true);

-- Seeded fully permissive, on purpose -- see the header. Every numeric entitlement is unlimited
-- and every boolean is on, for every plan, so this migration cannot block an action or withdraw a
-- feature from anybody. Setting a real limit is an UPDATE on the seeded row.
insert into plan_entitlements (plan_key, entitlement_key, kind, unlimited, boolean_value)
select plan.plan_key,
       definition.entitlement_key,
       definition.kind,
       definition.kind = 'numeric',
       case when definition.kind = 'boolean' then true end
from subscription_plans plan
cross join private.entitlement_definitions definition;

-- ===== 3. Subscriptions and overrides =====
create table organization_subscriptions (
  org_id                   uuid primary key references organizations(id) on delete restrict,
  plan_key                 text not null references subscription_plans(plan_key) on delete restrict,
  status                   text not null default 'active'
                           check (status in ('active', 'past_due', 'canceled', 'paused')),
  billing_interval         text not null default 'monthly'
                           check (billing_interval in ('monthly', 'yearly')),
  started_at               timestamptz not null default now(),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  renews_at                timestamptz,
  canceled_at              timestamptz,
  -- 'manual' is a real provider in this model: an operator setting the plan by hand IS how
  -- billing works today, and naming it beats a null that means "unknown or none, we cannot say".
  provider                 text not null default 'manual',
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint organization_subscriptions_period_order check (
    current_period_start is null or current_period_end is null
    or current_period_end > current_period_start),
  constraint organization_subscriptions_cancel_shape check (
    (status = 'canceled') = (canceled_at is not null))
);

-- Wave 6 resolves an incoming webhook to an organization through this pair and NEVER through the
-- payload's metadata. The unique index is what makes that resolution single-valued, and it is why
-- a manipulated metadata field cannot point at a different tenant.
create unique index organization_subscriptions_provider_customer_idx
  on organization_subscriptions (provider, provider_customer_id)
  where provider_customer_id is not null;

create table organization_entitlement_overrides (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete restrict,
  entitlement_key text not null,
  kind            text not null,
  unlimited       boolean not null default false,
  numeric_limit   numeric,
  boolean_value   boolean,
  expires_at      timestamptz,
  reason          text not null check (length(btrim(reason)) > 0),
  granted_by      uuid not null references auth.users(id) on delete restrict,
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users(id) on delete restrict,
  revoke_reason   text,
  constraint organization_entitlement_overrides_definition_fk
    foreign key (entitlement_key, kind)
    references private.entitlement_definitions(entitlement_key, kind) on delete restrict,
  -- An override must SAY something. Unknown is the absence of an override, not an override that
  -- declines to state a value.
  constraint organization_entitlement_overrides_numeric_shape check (
    kind <> 'numeric' or (
      boolean_value is null
      and (unlimited or (numeric_limit is not null and numeric_limit >= 0))
      and not (unlimited and numeric_limit is not null))),
  constraint organization_entitlement_overrides_boolean_shape check (
    kind <> 'boolean' or (
      numeric_limit is null and unlimited = false and boolean_value is not null)),
  constraint organization_entitlement_overrides_revoke_shape check (
    (revoked_at is null) = (revoked_by is null))
);

-- One live override per entitlement: replacing a concession is an explicit revoke-then-grant, so
-- the ledger never has to guess which of two rows was in force.
create unique index organization_entitlement_overrides_live_idx
  on organization_entitlement_overrides (org_id, entitlement_key) where revoked_at is null;
create index organization_entitlement_overrides_org_idx
  on organization_entitlement_overrides (org_id);

alter table subscription_plans                    enable row level security;
alter table plan_entitlements                     enable row level security;
alter table organization_subscriptions            enable row level security;
alter table organization_entitlement_overrides    enable row level security;

-- The catalogue is public to signed-in users, read-only. A tenant that cannot see what its plan
-- includes cannot be told honestly why an action is about to be blocked, and the alternative is
-- the hardcoded pricing table this project forbids.
revoke all on table subscription_plans from public, anon, authenticated;
revoke all on table plan_entitlements  from public, anon, authenticated;
grant select on table subscription_plans to authenticated;
grant select on table plan_entitlements  to authenticated;
create policy subscription_plans_select on subscription_plans
  for select to authenticated using (true);
create policy plan_entitlements_select on plan_entitlements
  for select to authenticated using (true);

-- The customer's own commercial state is NOT catalogue. It carries provider identifiers and
-- billing status, and it is read through the scoped functions below rather than by table access.
revoke all on table organization_subscriptions         from public, anon, authenticated;
revoke all on table organization_entitlement_overrides from public, anon, authenticated;

comment on table subscription_plans is
  'The plan ladder (0154). tier_order answers "which plan removes this limit" without hardcoding '
  'names; an inactive plan may hold existing customers but cannot be chosen for a new one.';
comment on table plan_entitlements is
  'What each plan grants (0154). Seeded fully permissive: the numbers are an owner decision and '
  'setting one is an UPDATE here, reviewed as pricing, not a migration.';
comment on table organization_entitlement_overrides is
  'One live, reasoned, revocable exception per entitlement (0154). Replacing a concession is an '
  'explicit revoke-then-grant so the ledger never has to guess which row was in force.';

create trigger zz_organization_write_guard
  before insert or update or delete on public.organization_subscriptions
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard
  before insert or update or delete on public.organization_entitlement_overrides
  for each row execute function private.organization_row_write_guard();

-- Existing customers predate the plan model. `legacy` is inactive, so this parks them somewhere
-- honest without putting them on a self-service tier whose limits they never agreed to.
insert into organization_subscriptions (org_id, plan_key, provider)
select org.id, 'legacy', 'manual' from organizations org
on conflict (org_id) do nothing;

-- A backfill covers who is here now. Without this trigger every organization created AFTER this
-- migration would have no subscription row, `effective_entitlement()` would answer `unavailable`
-- for it, and wave 4 -- which must read that as a refusal -- would block every new customer on
-- their first document. New organizations therefore land on `free`, the tier a new account starts
-- on; an operator moves them with platform_set_org_subscription and the move is audited.
create or replace function private.organizations_default_subscription() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into organization_subscriptions (org_id, plan_key, provider)
  values (new.id, 'free', 'manual')
  on conflict (org_id) do nothing;
  return new;
end
$$;
revoke all on function private.organizations_default_subscription()
  from public, anon, authenticated;

create trigger zzz_organizations_default_subscription
  after insert on public.organizations
  for each row execute function private.organizations_default_subscription();

-- ===== 4. The one resolution rule =====
-- Precedence: a live override, then the plan, then nothing. "Nothing" is `measured: false` -- the
-- honest answer when there is no subscription, no plan row, or a numeric limit nobody has stated.
-- Wave 4 must treat that as a refusal; this function only reports it.
create or replace function public.effective_entitlement(p_org_id uuid, p_entitlement_key text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with definition as (
    select * from private.entitlement_definitions
    where entitlement_key = p_entitlement_key
  ),
  live_override as (
    select * from organization_entitlement_overrides
    where org_id = p_org_id and entitlement_key = p_entitlement_key
      and revoked_at is null and (expires_at is null or expires_at > now())
  ),
  subscription as (
    select * from organization_subscriptions where org_id = p_org_id
  ),
  from_plan as (
    select entitlement.* from plan_entitlements entitlement
    join subscription on subscription.plan_key = entitlement.plan_key
    where entitlement.entitlement_key = p_entitlement_key
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
      when exists (select 1 from from_plan) then 'plan'
      else 'unavailable' end,
    'override_expires_at', (select expires_at from live_override),
    'unlimited', coalesce((select unlimited from live_override), (select unlimited from from_plan), false),
    'limit', coalesce((select numeric_limit from live_override), (select numeric_limit from from_plan)),
    'value', coalesce((select boolean_value from live_override), (select boolean_value from from_plan)),
    -- The whole honesty of this layer sits on this one flag: false means we cannot state what the
    -- customer is entitled to, which is a different thing from "entitled to zero".
    'measured', case
      when definition.kind is null then false
      when not exists (select 1 from subscription) then false
      when not exists (select 1 from live_override) and not exists (select 1 from from_plan) then false
      when definition.kind = 'boolean'
        then coalesce((select boolean_value from live_override), (select boolean_value from from_plan)) is not null
      else coalesce((select unlimited from live_override), (select unlimited from from_plan), false)
        or coalesce((select numeric_limit from live_override), (select numeric_limit from from_plan)) is not null
      end
  )
  from definition
$$;
revoke all on function public.effective_entitlement(uuid, text) from public, anon, authenticated;

-- ===== 5. The tenant's own view =====
-- No org argument, deliberately: the caller's organization comes from auth_org(), so this cannot
-- be pointed at somebody else's plan by changing a parameter.
create or replace function public.my_entitlements()
returns table (
  entitlement_key text, kind text, measure text, unit text, label text,
  plan_key text, subscription_status text, source text,
  unlimited boolean, numeric_limit numeric, boolean_value boolean, measured boolean
)
language sql stable security definer set search_path = public as $$
  select definition.entitlement_key,
         resolved ->> 'kind',
         resolved ->> 'measure',
         resolved ->> 'unit',
         resolved ->> 'label',
         resolved ->> 'plan_key',
         resolved ->> 'subscription_status',
         resolved ->> 'source',
         (resolved ->> 'unlimited')::boolean,
         (resolved ->> 'limit')::numeric,
         (resolved ->> 'value')::boolean,
         (resolved ->> 'measured')::boolean
  from private.entitlement_definitions definition
  cross join lateral public.effective_entitlement(auth_org(), definition.entitlement_key) resolved
  where auth_org() is not null
  order by definition.entitlement_key
$$;
revoke all on function public.my_entitlements() from public, anon;
grant execute on function public.my_entitlements() to authenticated;

comment on function public.my_entitlements() is
  'The caller''s own effective entitlements (0154). Takes no organization argument on purpose: '
  'the tenant comes from auth_org(), so it cannot be pointed at another customer''s plan.';

-- ===== 6. Operator reads =====
create or replace function public.platform_org_entitlements(p_org_id uuid)
returns table (
  entitlement_key text, kind text, measure text, unit text, label text,
  source text, unlimited boolean, numeric_limit numeric, boolean_value boolean,
  measured boolean, override_id uuid, override_expires_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select definition.entitlement_key,
         resolved ->> 'kind',
         resolved ->> 'measure',
         resolved ->> 'unit',
         resolved ->> 'label',
         resolved ->> 'source',
         (resolved ->> 'unlimited')::boolean,
         (resolved ->> 'limit')::numeric,
         (resolved ->> 'value')::boolean,
         (resolved ->> 'measured')::boolean,
         live.id,
         live.expires_at
  from private.entitlement_definitions definition
  cross join lateral public.effective_entitlement(p_org_id, definition.entitlement_key) resolved
  left join organization_entitlement_overrides live
    on live.org_id = p_org_id and live.entitlement_key = definition.entitlement_key
   and live.revoked_at is null and (live.expires_at is null or live.expires_at > now())
  where is_platform_admin() and public.platform_has_capability('billing.view')
  order by definition.kind, definition.entitlement_key
$$;
revoke all on function public.platform_org_entitlements(uuid) from public, anon;
grant execute on function public.platform_org_entitlements(uuid) to authenticated;

create or replace function public.platform_org_subscription(p_org_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'org_id', subscription.org_id,
    'plan_key', subscription.plan_key,
    'plan_label', plan.label,
    'plan_active', plan.active,
    'tier_order', plan.tier_order,
    'status', subscription.status,
    'billing_interval', subscription.billing_interval,
    'started_at', subscription.started_at,
    'current_period_start', subscription.current_period_start,
    'current_period_end', subscription.current_period_end,
    'renews_at', subscription.renews_at,
    'canceled_at', subscription.canceled_at,
    'provider', subscription.provider,
    'has_provider_link', subscription.provider_customer_id is not null)
  from organization_subscriptions subscription
  join subscription_plans plan on plan.plan_key = subscription.plan_key
  where subscription.org_id = p_org_id
    and is_platform_admin()
    and public.platform_has_capability('billing.view')
$$;
revoke all on function public.platform_org_subscription(uuid) from public, anon;
grant execute on function public.platform_org_subscription(uuid) to authenticated;

-- ===== 7. Operator commands =====
create or replace function public.platform_set_org_subscription(
  p_org_id   uuid,
  p_plan_key text,
  p_status   text,
  p_interval text,
  p_reason   text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_command(p_org_id, 'subscription.edit', p_reason);
  v_plan   subscription_plans;
  v_old    jsonb;
begin
  -- Changing what a customer is entitled to is a money decision; it re-authenticates like every
  -- other high-impact platform command (0061:51). There is one step-up mechanism; this uses it.
  perform public.assert_recent_password_authentication();

  select * into v_plan from subscription_plans where plan_key = p_plan_key;
  if not found then
    raise exception 'subscription_plan_unknown' using errcode = 'P0002';
  end if;

  select to_jsonb(existing) into v_old
  from organization_subscriptions existing where existing.org_id = p_org_id for update;

  -- An inactive plan holds who is already on it and takes nobody new. Moving a customer ONTO
  -- `legacy` would be inventing history.
  if not v_plan.active and coalesce(v_old ->> 'plan_key', '') <> p_plan_key then
    raise exception 'subscription_plan_inactive' using errcode = '22023';
  end if;

  insert into organization_subscriptions (org_id, plan_key, status, billing_interval, canceled_at)
  values (p_org_id, p_plan_key, p_status, p_interval,
          case when p_status = 'canceled' then now() end)
  on conflict (org_id) do update
    set plan_key = excluded.plan_key,
        status = excluded.status,
        billing_interval = excluded.billing_interval,
        canceled_at = case when excluded.status = 'canceled'
                           then coalesce(organization_subscriptions.canceled_at, now())
                           else null end,
        updated_at = now();

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'subscription_set', 'organization_subscriptions', p_org_id,
    v_old,
    jsonb_build_object('plan_key', p_plan_key, 'status', p_status, 'billing_interval', p_interval),
    v_reason);

  return jsonb_build_object('org_id', p_org_id, 'plan_key', p_plan_key,
                            'previous_plan_key', v_old ->> 'plan_key');
end
$$;
revoke all on function public.platform_set_org_subscription(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.platform_set_org_subscription(uuid, text, text, text, text)
  to authenticated;

create or replace function public.platform_grant_entitlement_override(
  p_org_id          uuid,
  p_entitlement_key text,
  p_unlimited       boolean,
  p_numeric_limit   numeric,
  p_boolean_value   boolean,
  p_expires_at      timestamptz,
  p_reason          text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor      uuid := auth.uid();
  v_reason     text := private.assert_platform_command(p_org_id, 'entitlement.override', p_reason);
  v_definition private.entitlement_definitions;
  v_id         uuid;
begin
  perform public.assert_recent_password_authentication();

  select * into v_definition from private.entitlement_definitions
  where entitlement_key = p_entitlement_key;
  if not found then
    raise exception 'entitlement_unknown' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from organization_entitlement_overrides
    where org_id = p_org_id and entitlement_key = p_entitlement_key and revoked_at is null
  ) then
    -- Replacing a concession is revoke-then-grant, so the ledger never has to guess which of two
    -- rows was in force at the moment something was allowed.
    raise exception 'entitlement_override_exists' using errcode = '23505';
  end if;

  insert into organization_entitlement_overrides (
    org_id, entitlement_key, kind, unlimited, numeric_limit, boolean_value,
    expires_at, reason, granted_by
  ) values (
    p_org_id, p_entitlement_key, v_definition.kind, coalesce(p_unlimited, false),
    p_numeric_limit, p_boolean_value, p_expires_at, v_reason, v_actor
  ) returning id into v_id;

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'entitlement_override_granted', 'organization_entitlement_overrides', v_id,
    null,
    jsonb_build_object('entitlement_key', p_entitlement_key, 'unlimited', coalesce(p_unlimited, false),
                       'numeric_limit', p_numeric_limit, 'boolean_value', p_boolean_value,
                       'expires_at', p_expires_at),
    v_reason);

  return jsonb_build_object('override_id', v_id);
end
$$;
revoke all on function public.platform_grant_entitlement_override(
  uuid, text, boolean, numeric, boolean, timestamptz, text) from public, anon;
grant execute on function public.platform_grant_entitlement_override(
  uuid, text, boolean, numeric, boolean, timestamptz, text) to authenticated;

create or replace function public.platform_revoke_entitlement_override(
  p_override_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := auth.uid();
  v_override organization_entitlement_overrides;
  v_reason   text;
begin
  select * into v_override from organization_entitlement_overrides
  where id = p_override_id for update;
  if not found then
    raise exception 'entitlement_override_unknown' using errcode = 'P0002';
  end if;
  v_reason := private.assert_platform_command(v_override.org_id, 'entitlement.override', p_reason);
  perform public.assert_recent_password_authentication();

  if v_override.revoked_at is not null then
    return jsonb_build_object('override_id', p_override_id, 'idempotent', true);
  end if;

  update organization_entitlement_overrides
     set revoked_at = now(), revoked_by = v_actor, revoke_reason = v_reason
   where id = p_override_id;

  perform private.record_platform_lifecycle_event(
    v_override.org_id, v_actor, 'entitlement_override_revoked',
    'organization_entitlement_overrides', p_override_id,
    to_jsonb(v_override), null, v_reason);

  return jsonb_build_object('override_id', p_override_id, 'idempotent', false);
end
$$;
revoke all on function public.platform_revoke_entitlement_override(uuid, text)
  from public, anon;
grant execute on function public.platform_revoke_entitlement_override(uuid, text)
  to authenticated;

-- ===== 8. Registry duties =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('subscription_plans',                     'system', false),
  ('plan_entitlements',                      'system', false),
  ('organization_subscriptions',             'system', false),
  ('organization_entitlement_overrides',     'system', false);

-- A6. The subscription travels with the tenant minus our billing provider's identifiers -- what
-- plan they were on is their record; the id our processor filed them under is ours. An override
-- does not travel: it carries an operator's reason for a commercial concession, which is an
-- internal note by another name.
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('organization_subscriptions', 'include',
   array['provider_customer_id', 'provider_subscription_id'],
   'The tenant''s own plan and billing period, without our payment processor''s internal identifiers.'),
  ('organization_entitlement_overrides', 'exclude', '{}',
   'Operator-granted commercial concessions with their internal reasons; not tenant-authored data.')
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
where registry.table_name in
  ('organization_subscriptions', 'organization_entitlement_overrides');

-- ===== 9. Structural re-assertion =====
do $assert_0154$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0154 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0154 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0154$;

-- ===== 10. Anchors =====
do $anchor_0154$
declare
  v_count integer;
  v_probe jsonb;
begin
  select count(*) into v_count from organizations org
  where not exists (
    select 1 from organization_subscriptions subscription where subscription.org_id = org.id);
  if v_count > 0 then
    raise exception '0154: % organization(s) left without a subscription -- wave 4 would refuse them', v_count;
  end if;

  select count(*) into v_count
  from subscription_plans plan
  cross join private.entitlement_definitions definition
  where not exists (
    select 1 from plan_entitlements entitlement
    where entitlement.plan_key = plan.plan_key
      and entitlement.entitlement_key = definition.entitlement_key);
  if v_count > 0 then
    raise exception '0154: % plan/entitlement pair(s) unseeded -- an unstated limit fails closed in wave 4', v_count;
  end if;

  -- Nothing this migration seeds may block anything or withdraw a feature.
  select count(*) into v_count from plan_entitlements
  where (kind = 'numeric' and not unlimited) or (kind = 'boolean' and boolean_value is not true);
  if v_count > 0 then
    raise exception '0154: % seeded entitlement(s) are restrictive -- the numbers are an owner decision', v_count;
  end if;

  -- The trigger, not only the backfill: an organization created a minute from now must resolve to
  -- a plan too, or wave 4 refuses it on its first document. Asserted structurally here and
  -- exercised for real in p51 -- creating and then removing a probe organization inside a
  -- migration would have to delete through the cascade and the write guard, which is a lot of
  -- machinery to run against production for a check a rolled-back suite makes better.
  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'organizations'
      and trg.tgname = 'zzz_organizations_default_subscription'
      and not trg.tgisinternal
  ) then
    raise exception '0154: new organizations would be created without a subscription';
  end if;

  -- The resolution rule reports honestly for an organization that has no subscription at all.
  v_probe := public.effective_entitlement('00000000-0000-4000-8000-000000000000', 'documents.monthly');
  if (v_probe ->> 'measured')::boolean or (v_probe ->> 'source') <> 'unavailable' then
    raise exception '0154: an organization with no subscription reported a measured entitlement';
  end if;

  v_probe := public.effective_entitlement('00000000-0000-4000-8000-000000000000', 'nope.nope');
  if v_probe is not null then
    raise exception '0154: an unknown entitlement key resolved to something';
  end if;
end
$anchor_0154$;
