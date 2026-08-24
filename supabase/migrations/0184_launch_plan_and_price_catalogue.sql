-- OWNER DECISIONS #194, #195, #196, #197, #201, #208, #214, #215, #164 -- the launch plan ladder,
-- the versioned price catalogues, the billing-period ledger, and the machinery that retires Legacy.
--
-- This file is the 0161 pattern at full size: the NUMBERS are a commercial decision expressed as
-- data, the MECHANISM was built in 0154/0155 and is not touched. What is new here is a ladder with
-- five rungs instead of four, a price that finally has somewhere to live, and a cutover the owner
-- can read before running.
--
-- ===== WHAT CHANGES, AND WHY EACH NUMBER IS NOT INVENTED =====
--
--   #194  The ladder is `חינם` -> `בסיס` -> `פרו` -> `פרימיום` -> `ביזנס`. `basic` and `premium` do
--         not exist today, and tier_order is UNIQUE and NOT deferrable, so the four existing rows
--         are pushed into a disjoint band first and then re-landed on a spaced scale (0/10/20/30/
--         40/50). The spacing is not decoration: the next rung inserted between two others must not
--         require a second renumber of a table other code orders by.
--
--   #197  documents per usage period: free 25, basic 50, pro 200, premium 500. OCR pages: free 250,
--         basic 500, pro 2,000, premium 5,000. Business is contractual (#201) and keeps answering
--         "we do not count that".
--
--   WHAT THE x10 IS AND IS NOT. 0163 derived every page quota as `document quota x 20` from
--   `ExtractionLimits.max_ai_pages = 20` in worker/ocr/src/limits.py, and its anchor enforced that
--   multiple. #197 replaces the COMMERCIAL ratio with TEN, and this file supersedes 0163's
--   derivation deliberately and re-asserts the new one below.
--
--   What it does NOT do is touch the twenty. #197 says in the same row that the 20-AI-pages-per
--   document cap remains a separate FILE limit, and it does: it is still the truncation in the
--   worker that stops one document ever costing more than twenty billed pages. Removing it because
--   the commercial ratio moved would delete a live cost control. Only the plan-level
--   pages:documents ratio changes here.
--
--   THREE OF THE EIGHT ARE REDUCTIONS AGAINST WHAT IS LIVE, AND THE OWNER RULED THEY APPLY
--   IMMEDIATELY AT CUTOVER (23.08.2026):
--
--       free  ocr_pages.monthly   500 -> 250
--       pro   documents.monthly   300 -> 200
--       pro   ocr_pages.monthly  6000 -> 2000
--
--   #164 decides only Legacy->Free, #215 decides how a PRICE change reaches an existing
--   subscription and #216 decides tier and interval changes; none of them covers a reduced QUOTA
--   reaching an organization already on that plan. The owner closed that question directly: it
--   lands with the migration, not at the next renewal and not at the next usage period.
--
--   That makes an organization that was compliant the minute before this migration over its ceiling
--   the minute after, and it is the reason `platform_plan_cutover_report()` is a DELIVERABLE rather
--   than a courtesy. It names, per organization, exactly who can no longer process a new document
--   the moment this applies -- which limit they cross, what they have used in their current usage
--   period, the ceiling they had and the ceiling they now have. `private.plan_quota_decisions`
--   keeps every decided figure next to the figure it replaced, so "what changed and by how much" is
--   answerable from the database rather than from this comment.
--
--   #196  No capability is gated by plan. Every boolean entitlement stays on for every rung; only
--         volume differs. A boolean that is false for one plan would reverse #196 through a side
--         door, and the anchor below refuses it.
--
--   #195/#208/#215  Price is versioned catalogue data, not a column on a plan. Israel bills in ILS
--         and everywhere else in USD, chosen from the merchant of record's VERIFIED billing country
--         and never from an IP address or a free currency picker (#208). Prices are pre-tax; the
--         MoR computes, collects and reports the local tax. A subscription that was sold on a
--         catalogue version keeps that version for the period it paid for (#215), which is why the
--         version travels on the billing period rather than being looked up fresh.
--         The annual price is TEN months of the monthly price, and the anchor checks that
--         derivation rather than trusting four transcribed figures.
--
--   #201  Business has no price row at all. `דברו איתנו` is the whole public answer, and the
--         internal minimum and setup fee are commercial negotiating positions that must never
--         reach a table a browser can read. They are deliberately absent from this schema.
--
-- ===== WHAT THIS FILE DELIBERATELY DOES NOT DO =====
--
--   * assistant_runs.monthly keeps the explicit UNKNOWN state 0164 gave it, for the two new rungs
--     as well. #198 decides the steady-state numbers (20/40/100/250) but #209 puts 50 runs inside a
--     30-day introduction window measured from the owner's first email verification -- a DIFFERENT
--     anchor from the signup anchor of #242, and neither decision says which of the two windows a
--     run counts against when the introduction window straddles a usage period boundary. Seeding
--     the steady-state number alone would under-grant every new organization for its first month.
--     Unknown refuses; that is the honest state until the gap is closed.
--
--   * users.max, suppliers.max and storage.bytes are untouched. #199 decides 3/5/15/30 users and
--     #200 decides the storage ceilings, and BOTH say in the same row that these are not measured
--     and must not be published or enforced before they are. A limit nothing counts is a number
--     with no effect that a pricing page would nonetheless print.
--
--   * There is no numeric entitlement for units/branches. #199 decides 1/1/3/10, but the
--     vocabulary has only the boolean `org.multi_unit`, and #196 forbids gating a capability by
--     plan. Adding the numeric key without a counter would repeat the users.max mistake.
--
--   * The Legacy cutover is NOT executed here. #164 requires a dry run that names who is blocked on
--     day one, an idempotent apply, an audited ledger and a postflight. This file ships all four as
--     operator surfaces; running them against real customers is a production act with its own
--     authorization, not a side effect of applying a migration.

-- ===== 1. The ladder =====
-- tier_order is UNIQUE and not deferrable, so a single arithmetic update would collide mid
-- statement. Two passes through a disjoint negative band cannot.
update subscription_plans set tier_order = -1000 - tier_order;

update subscription_plans set tier_order = decided.tier_order, label = decided.label
from (values
  ('legacy',    0, 'לקוח ותיק'),
  ('free',     10, 'חינם'),
  ('pro',      30, 'פרו'),
  ('business', 50, 'ביזנס')
) as decided(plan_key, tier_order, label)
where subscription_plans.plan_key = decided.plan_key;

insert into subscription_plans (plan_key, label, tier_order, active) values
  ('basic',   'בסיס',    20, true),
  ('premium', 'פרימיום', 40, true);

-- Seed the two new rungs exactly as 0154 seeded the first four: permissive, so their arrival
-- cannot block anybody, with the single exception 0164 introduced. `assistant_runs.monthly` is
-- seeded UNKNOWN rather than unlimited, because unknown refuses and nobody has priced the feature.
insert into plan_entitlements (
  plan_key, entitlement_key, kind, unlimited, numeric_limit, boolean_value
)
select plan.plan_key,
       definition.entitlement_key,
       definition.kind,
       definition.kind = 'numeric' and definition.entitlement_key <> 'assistant_runs.monthly',
       null,
       case when definition.kind = 'boolean' then true end
from subscription_plans plan
cross join private.entitlement_definitions definition
where plan.plan_key in ('basic', 'premium')
on conflict (plan_key, entitlement_key) do nothing;

-- ===== 2. The decided volumes (#197) =====
-- The record is kept as well as applied. A migration that simply UPDATEs eight numbers leaves no
-- way to answer "what was it before, and by how much did it move" -- which is exactly the question
-- the cutover report has to answer per organization when a ceiling drops beneath somebody.
create table private.plan_quota_decisions (
  plan_key        text not null references subscription_plans(plan_key) on delete restrict,
  entitlement_key text not null,
  decided_limit   numeric not null check (decided_limit >= 0),
  -- What the plan allowed immediately before this migration. Null for a rung that did not exist,
  -- which is a different thing from a rung that allowed nothing.
  previous_limit  numeric check (previous_limit >= 0),
  previous_unlimited boolean not null default false,
  decision_ref    text not null check (length(btrim(decision_ref)) > 0),
  recorded_at     timestamptz not null default now(),
  primary key (plan_key, entitlement_key),
  constraint plan_quota_decisions_definition_fk
    foreign key (entitlement_key)
    references private.entitlement_definitions(entitlement_key) on delete restrict
);
revoke all on table private.plan_quota_decisions
  from public, anon, authenticated, service_role;

comment on table private.plan_quota_decisions is
  'Every figure #197 decided, beside the figure it replaced (0184). Three of the eight are '
  'reductions and the owner ruled they apply at cutover, so this table is how the size of each '
  'move stays answerable from the database rather than from a migration comment.';

insert into private.plan_quota_decisions
  (plan_key, entitlement_key, decided_limit, previous_limit, previous_unlimited, decision_ref)
select decided.plan_key, decided.entitlement_key, decided.quota,
       existing.numeric_limit, coalesce(existing.unlimited, false), 'OPEN-DECISIONS #197'
from (values
  ('free',    'documents.monthly',   25),
  ('basic',   'documents.monthly',   50),
  ('pro',     'documents.monthly',  200),
  ('premium', 'documents.monthly',  500),
  ('free',    'ocr_pages.monthly',  250),
  ('basic',   'ocr_pages.monthly',  500),
  ('pro',     'ocr_pages.monthly', 2000),
  ('premium', 'ocr_pages.monthly', 5000)
) as decided(plan_key, entitlement_key, quota)
left join plan_entitlements existing
  on existing.plan_key = decided.plan_key
 and existing.entitlement_key = decided.entitlement_key;

update plan_entitlements
   set unlimited = false, numeric_limit = decision.decided_limit, updated_at = now()
from private.plan_quota_decisions decision
where plan_entitlements.plan_key = decision.plan_key
  and plan_entitlements.entitlement_key = decision.entitlement_key;

-- ===== 3. Price catalogues (#195, #208, #215) =====
create table plan_price_catalogues (
  catalogue_version     text primary key check (catalogue_version ~ '^[a-z0-9][a-z0-9-]*$'),
  -- The MoR's verified billing country picks the catalogue (#208). `IL` and `ROW` are the only two
  -- scopes the owner decided; a third would be a new commercial decision, not a new row.
  billing_country_scope text not null check (billing_country_scope in ('IL', 'ROW')),
  currency              text not null check (currency in ('ILS', 'USD')),
  -- Every decided figure is pre-tax; the merchant of record computes and remits the local tax.
  tax_mode              text not null default 'exclusive' check (tax_mode = 'exclusive'),
  effective_from        timestamptz not null,
  -- #215: a new price applies at the first renewal at least 30 days after a DOCUMENTED notice.
  -- Null means "never announced", which is what a catalogue that has not superseded anything is.
  notice_published_at   timestamptz,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  constraint plan_price_catalogues_currency_scope check (
    (billing_country_scope = 'IL'  and currency = 'ILS')
    or (billing_country_scope = 'ROW' and currency = 'USD')),
  unique (billing_country_scope, effective_from)
);

create table plan_prices (
  catalogue_version text not null
                    references plan_price_catalogues(catalogue_version) on delete restrict,
  plan_key          text not null references subscription_plans(plan_key) on delete restrict,
  billing_interval  text not null check (billing_interval in ('monthly', 'yearly')),
  -- Pre-tax, in the catalogue's currency. `numeric` with two decimals, the house money shape.
  amount            numeric(12, 2) not null check (amount >= 0),
  -- How much calendar the price buys. The annual row buys twelve months at ten months' price
  -- (#195); storing both halves lets the anchor check the derivation instead of trusting figures.
  months_covered    integer not null check (months_covered in (1, 12)),
  created_at        timestamptz not null default now(),
  primary key (catalogue_version, plan_key, billing_interval),
  constraint plan_prices_interval_months check (
    (billing_interval = 'monthly' and months_covered = 1)
    or (billing_interval = 'yearly' and months_covered = 12))
);

insert into plan_price_catalogues
  (catalogue_version, billing_country_scope, currency, effective_from) values
  ('launch-il',  'IL',  'ILS', timestamptz '2026-08-23 00:00:00+03'),
  ('launch-row', 'ROW', 'USD', timestamptz '2026-08-23 00:00:00+03');

-- #195 verbatim. Global monthly $0/$20/$79/$149 and annual $0/$200/$790/$1,490; Israel monthly
-- 0/69/249/449 and annual 0/690/2,490/4,490, all before tax. Business is absent on purpose (#201).
insert into plan_prices (catalogue_version, plan_key, billing_interval, amount, months_covered)
values
  ('launch-row', 'free',    'monthly',    0, 1),
  ('launch-row', 'basic',   'monthly',   20, 1),
  ('launch-row', 'pro',     'monthly',   79, 1),
  ('launch-row', 'premium', 'monthly',  149, 1),
  ('launch-row', 'free',    'yearly',     0, 12),
  ('launch-row', 'basic',   'yearly',   200, 12),
  ('launch-row', 'pro',     'yearly',   790, 12),
  ('launch-row', 'premium', 'yearly',  1490, 12),
  ('launch-il',  'free',    'monthly',    0, 1),
  ('launch-il',  'basic',   'monthly',   69, 1),
  ('launch-il',  'pro',     'monthly',  249, 1),
  ('launch-il',  'premium', 'monthly',  449, 1),
  ('launch-il',  'free',    'yearly',     0, 12),
  ('launch-il',  'basic',   'yearly',   690, 12),
  ('launch-il',  'pro',     'yearly',  2490, 12),
  ('launch-il',  'premium', 'yearly',  4490, 12);

alter table plan_price_catalogues enable row level security;
alter table plan_prices           enable row level security;

-- NOT granted to a browser role, deliberately, and this is the one place it is worth arguing.
-- 0154/0169 made the PLAN catalogue anon-readable so a pricing page would not hardcode figures,
-- and that instinct is right -- but these two tables carry more than a price list.
-- `notice_published_at` is #215 price-change-notice operations timing, `effective_from` and
-- `active` are catalogue lifecycle, and a prospect who can read them is reading our calendar. The
-- public page therefore goes through a read model that returns the columns a price list actually
-- consists of; 0186 defines it.
revoke all on table plan_price_catalogues from public, anon, authenticated;
revoke all on table plan_prices           from public, anon, authenticated;

comment on table plan_price_catalogues is
  'Versioned, pre-tax price catalogues (0184, #195/#208/#215). One per billing-country scope: '
  'Israel in ILS, everywhere else in USD, chosen from the merchant of record''s verified billing '
  'country and never from an IP address.';
comment on table plan_prices is
  'What each plan costs in a catalogue version (0184, #195). The annual row buys twelve months at '
  'ten months'' price; Business has no row at all, because its answer is a conversation (#201).';

-- #208 as a function rather than a comment: the country comes from the merchant of record, and
-- this is the one place that turns it into a catalogue scope.
--
-- It classifies a COUNTRY -- the verified fact -- and never decides which country anybody is in.
-- No browser role gets execute: nothing in a browser holds a verified country to classify, and a
-- pricing surface that accepts a scope from its caller is a free currency picker with a different
-- name, which is the half of #208 that is easiest to build by accident. The customer-facing reads
-- in 0186 are SECURITY DEFINER and call this internally after reading the verified country.
create or replace function public.billing_catalogue_scope(p_country_code text)
returns text language sql immutable as $$
  select case when upper(btrim(coalesce(p_country_code, ''))) = 'IL' then 'IL' else 'ROW' end
$$;
revoke all on function public.billing_catalogue_scope(text) from public, anon, authenticated;

-- ===== 4. The billing period ledger (#215, #216, #223, #242) =====
-- A BILLING period is what the customer paid for. A USAGE period is what quotas are measured in,
-- and 0185 anchors it to signup for the organization's whole life. #242 makes the separation
-- absolute, so they get separate tables rather than separate columns on one row.
create table organization_billing_periods (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete restrict,
  plan_key          text not null references subscription_plans(plan_key) on delete restrict,
  billing_interval  text not null check (billing_interval in ('monthly', 'yearly')),
  catalogue_version text not null
                    references plan_price_catalogues(catalogue_version) on delete restrict,
  amount            numeric(12, 2) not null check (amount >= 0),
  currency          text not null check (currency in ('ILS', 'USD')),
  period_start      timestamptz not null,
  period_end        timestamptz not null,
  -- private.billing_events.id, when the period was opened by a verified provider event (0157).
  -- Deliberately NOT a foreign key: that ledger belongs to the provider boundary and this table
  -- must not become a reason its shape cannot change.
  provider_event_id uuid,
  opened_reason     text not null check (length(btrim(opened_reason)) > 0),
  created_at        timestamptz not null default now(),
  constraint organization_billing_periods_order check (period_end > period_start),
  unique (org_id, period_start)
);
create index organization_billing_periods_org_idx
  on organization_billing_periods (org_id, period_start desc);

alter table organization_billing_periods enable row level security;
-- The customer's own commercial state is not table-readable, exactly as 0154 decided for
-- organization_subscriptions. It is read through the scoped functions and nothing else.
revoke all on table organization_billing_periods from public, anon, authenticated;

create trigger zz_organization_write_guard
  before insert or update or delete on public.organization_billing_periods
  for each row execute function private.organization_row_write_guard();

comment on table organization_billing_periods is
  'What a customer actually paid for, and on which catalogue version (0184, #215/#223). Separate '
  'from the usage period by construction: #242 makes signup the permanent usage anchor and a '
  'billing event must never move it.';

-- Opening a billing period is idempotent on (org_id, period_start): #223 says a repeated recovery
-- event must not open a second one, and a webhook that arrives twice is the normal case.
create or replace function private.record_billing_period(
  p_org_id            uuid,
  p_plan_key          text,
  p_billing_interval  text,
  p_catalogue_version text,
  p_period_start      timestamptz,
  p_period_end        timestamptz,
  p_reason            text,
  p_provider_event_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_price plan_prices;
  v_currency text;
  v_id uuid;
begin
  select * into v_price from plan_prices
  where catalogue_version = p_catalogue_version
    and plan_key = p_plan_key
    and billing_interval = p_billing_interval;
  if not found then
    -- A plan with no row in the catalogue version has no stated price, and charging for a period
    -- whose price nobody wrote down is the money-shaped version of an unstated limit.
    raise exception 'billing_price_unknown' using errcode = 'P0002';
  end if;

  select currency into v_currency from plan_price_catalogues
  where catalogue_version = p_catalogue_version;

  insert into organization_billing_periods (
    org_id, plan_key, billing_interval, catalogue_version, amount, currency,
    period_start, period_end, provider_event_id, opened_reason
  ) values (
    p_org_id, p_plan_key, p_billing_interval, p_catalogue_version, v_price.amount, v_currency,
    p_period_start, p_period_end, p_provider_event_id, p_reason
  )
  on conflict (org_id, period_start) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from organization_billing_periods
    where org_id = p_org_id and period_start = p_period_start;
    return jsonb_build_object('billing_period_id', v_id, 'opened', false, 'idempotent', true);
  end if;
  return jsonb_build_object('billing_period_id', v_id, 'opened', true, 'idempotent', false);
end
$$;
revoke all on function private.record_billing_period(
  uuid, text, text, text, timestamptz, timestamptz, text, uuid) from public, anon, authenticated;

-- ===== 5. The cutover report (#164, and the quota reduction #197 applies) =====
-- One report answers both questions, because they are the same question: for every organization,
-- what plan is it held to after this migration, and is it ALREADY past that plan's ceiling in the
-- usage period it is currently in? #164 demands exactly this for Legacy. #197 needs it just as
-- badly and for more organizations: three ceilings drop, so an organization that was compliant the
-- minute before this migration can be over quota the minute after, on `free` or `pro`, without
-- having done anything.
--
-- It is per-organization and per-metric on purpose. An aggregate count answers "how bad is it";
-- the owner needs "who", "which limit", "how much have they used", "what was the ceiling" and
-- "what is it now" -- which is one row per organization per metered quota, and is what this
-- returns.
create or replace function private.plan_cutover_rows()
returns table (
  org_id uuid, org_name text, org_status text,
  current_plan_key text, target_plan_key text,
  metric_key text, metric_label text,
  used numeric, target_limit numeric, target_unlimited boolean, target_measured boolean,
  over_target boolean, writes_blocked boolean,
  previous_limit numeric, previous_unlimited boolean, ceiling_dropped boolean,
  newly_over_target boolean,
  period_start timestamptz, period_end timestamptz
)
language sql stable security definer set search_path = public as $$
  select org.id,
         org.name,
         org.status::text,
         subscription.plan_key,
         target.plan_key,
         definition.entitlement_key,
         definition.label,
         coalesce(counter.quantity, 0),
         target.numeric_limit,
         target.unlimited,
         target.unlimited or target.numeric_limit is not null,
         not target.unlimited
           and target.numeric_limit is not null
           and coalesce(counter.quantity, 0) > target.numeric_limit,
         -- An organization the write guard already refuses is moved through the operator handshake
         -- rather than skipped, but the run should still say how many took that path.
         org.status::text <> 'active',
         decision.previous_limit,
         decision.previous_unlimited,
         -- Did this migration lower the ceiling for this plan and metric at all?
         decision.plan_key is not null
           and (decision.previous_unlimited
                or (decision.previous_limit is not null
                    and decision.previous_limit > decision.decided_limit)),
         -- The row the owner is actually looking for: compliant a minute ago, over quota now,
         -- purely because the ceiling moved underneath them.
         not target.unlimited
           and target.numeric_limit is not null
           and coalesce(counter.quantity, 0) > target.numeric_limit
           and (decision.previous_unlimited
                or (decision.previous_limit is not null
                    and coalesce(counter.quantity, 0) <= decision.previous_limit)),
         period.period_start,
         period.period_end
  from organizations org
  join organization_subscriptions subscription on subscription.org_id = org.id
  cross join lateral private.usage_period(org.id) period
  join private.entitlement_definitions definition
    on definition.kind = 'numeric' and definition.measure = 'per_period'
  join plan_entitlements target
    on target.plan_key = case when subscription.plan_key = 'legacy'
                              then 'free' else subscription.plan_key end
   and target.entitlement_key = definition.entitlement_key
  left join private.plan_quota_decisions decision
    on decision.plan_key = target.plan_key
   and decision.entitlement_key = definition.entitlement_key
  left join private.usage_counters counter
    on counter.org_id = org.id
   and counter.metric_key = definition.entitlement_key
   and counter.period_start = period.period_start
  order by org.name, definition.entitlement_key
$$;
revoke all on function private.plan_cutover_rows() from public, anon, authenticated;

create or replace function public.platform_plan_cutover_report()
returns table (
  org_id uuid, org_name text, org_status text,
  current_plan_key text, target_plan_key text,
  metric_key text, metric_label text,
  used numeric, target_limit numeric, target_unlimited boolean, target_measured boolean,
  over_target boolean, writes_blocked boolean,
  previous_limit numeric, previous_unlimited boolean, ceiling_dropped boolean,
  newly_over_target boolean,
  period_start timestamptz, period_end timestamptz
)
language sql stable security definer set search_path = public as $$
  select * from private.plan_cutover_rows()
  where is_platform_admin() and public.platform_has_capability('billing.view')
$$;
revoke all on function public.platform_plan_cutover_report() from public, anon;
grant execute on function public.platform_plan_cutover_report() to authenticated;

comment on function public.platform_plan_cutover_report() is
  'The dry run #164 requires, widened to cover the quota reduction #197 causes (0184). Names every '
  'organization already past the ceiling it is about to be held to, in the usage period it is '
  'currently in, before anybody is refused.';

-- ===== 6. The Legacy cutover itself (#164) =====
-- Idempotent, reasoned, audited, and it touches ONE column. It must not go near
-- current_period_start, current_period_end or any counter: #242 says a plan change never moves the
-- usage period, and #164 says this particular plan change is no exception.
create or replace function public.platform_legacy_cutover(p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor         uuid := auth.uid();
  v_org           record;
  v_reason        text;
  v_moved         integer := 0;
  v_moved_frozen  integer := 0;
  v_frozen_orgs   uuid[] := '{}';
begin
  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if not public.platform_has_capability('subscription.edit') then
    raise exception 'not_platform_capability' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  for v_org in
    select subscription.org_id, org.status::text as status
    from organization_subscriptions subscription
    join organizations org on org.id = subscription.org_id
    where subscription.plan_key = 'legacy'
    order by subscription.org_id
    for update of subscription
  loop
    -- #164 leaves nobody behind, including a tenant that is currently read-only: the postflight it
    -- demands is ZERO active Legacy, and a skipped organization would fail it forever. The
    -- handshake private.assert_platform_command() sets is exactly the sanctioned way a proven
    -- operator writes to a tenant the write guard would otherwise refuse; the count is reported so
    -- the run is honest about how many rows took that path.
    v_reason := private.assert_platform_command(v_org.org_id, 'subscription.edit', p_reason);
    if v_org.status <> 'active' then
      v_moved_frozen := v_moved_frozen + 1;
      v_frozen_orgs := v_frozen_orgs || v_org.org_id;
    end if;

    update organization_subscriptions
       set plan_key = 'free', updated_at = now()
     where org_id = v_org.org_id;

    perform private.record_platform_lifecycle_event(
      v_org.org_id, v_actor, 'subscription_set', 'organization_subscriptions', v_org.org_id,
      jsonb_build_object('plan_key', 'legacy'),
      jsonb_build_object('plan_key', 'free', 'cutover', 'legacy_retirement'),
      v_reason);

    v_moved := v_moved + 1;
  end loop;

  -- Idempotent by shape rather than by a flag: a second run finds no rows and reports zero moved.
  return jsonb_build_object(
    'moved', v_moved,
    'moved_while_read_only', v_moved_frozen,
    'read_only_org_ids', to_jsonb(v_frozen_orgs),
    'remaining_legacy', (select count(*) from organization_subscriptions where plan_key = 'legacy'));
end
$$;
revoke all on function public.platform_legacy_cutover(text) from public, anon;
grant execute on function public.platform_legacy_cutover(text) to authenticated;

comment on function public.platform_legacy_cutover(text) is
  'Retires Legacy to Free (0184, #164). Idempotent, reasoned and audited per organization, and it '
  'touches one column: the usage period and every counter are left exactly where they were, '
  'because #242 says a plan change never moves them.';

-- ===== 7. Registry duties =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('plan_price_catalogues',          'system', false),
  ('plan_prices',                    'system', false),
  ('organization_billing_periods',   'system', false);

-- A6. What the customer paid, and when, is their record. The provider event that produced it is
-- ours, and so is the internal reason an operator typed.
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('organization_billing_periods', 'include',
   array['provider_event_id', 'opened_reason'],
   'The tenant''s own billing periods, plan, interval, price and catalogue version, without our '
   'payment processor''s event identifiers or the operator note that opened the period.')
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
where registry.table_name = 'organization_billing_periods';

-- ===== 8. Structural re-assertion =====
do $assert_0184$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0184 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0184 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0184$;

-- ===== 9. Anchors =====
do $anchor_0184$
declare
  v_ladder text;
  v_count  integer;
  v_plan   record;
begin
  -- #194, checked as an ORDER rather than as five numbers, so a later renumber that inverts the
  -- ladder fails here instead of being discovered by a customer who was sold the wrong tier.
  select string_agg(plan_key, '<' order by tier_order) into v_ladder
  from subscription_plans where active;
  if v_ladder <> 'free<basic<pro<premium<business' then
    raise exception '0184: the active ladder is "%" rather than free<basic<pro<premium<business', v_ladder;
  end if;
  if exists (select 1 from subscription_plans where plan_key = 'legacy' and active) then
    raise exception '0184: legacy became selectable again -- #164 retires it, it does not revive it';
  end if;

  -- #197 as stated, and #197's ratio re-asserted at TEN in place of 0163's twenty. A plan that
  -- limits documents must limit pages at exactly ten times; a plan that limits neither must limit
  -- neither, or the page quota silently becomes the only ceiling.
  for v_plan in
    select docs.plan_key,
           docs.unlimited      as docs_unlimited,
           docs.numeric_limit  as docs_limit,
           pages.unlimited     as pages_unlimited,
           pages.numeric_limit as pages_limit
    from plan_entitlements docs
    join plan_entitlements pages on pages.plan_key = docs.plan_key
    where docs.entitlement_key = 'documents.monthly'
      and pages.entitlement_key = 'ocr_pages.monthly'
  loop
    if v_plan.docs_unlimited then
      if not v_plan.pages_unlimited then
        raise exception '0184: plan % limits pages but not documents', v_plan.plan_key;
      end if;
    elsif v_plan.pages_unlimited
       or v_plan.pages_limit is distinct from v_plan.docs_limit * 10 then
      raise exception '0184: plan % pages (%) is not its documents (%) times ten',
        v_plan.plan_key, v_plan.pages_limit, v_plan.docs_limit;
    end if;
  end loop;

  -- The eight decided figures, named one at a time rather than counted, so a wrong number fails
  -- here and not in front of a customer.
  select count(*) into v_count
  from (values
    ('free',    'documents.monthly',   25),
    ('free',    'ocr_pages.monthly',  250),
    ('basic',   'documents.monthly',   50),
    ('basic',   'ocr_pages.monthly',  500),
    ('pro',     'documents.monthly',  200),
    ('pro',     'ocr_pages.monthly', 2000),
    ('premium', 'documents.monthly',  500),
    ('premium', 'ocr_pages.monthly', 5000)
  ) as expected(plan_key, entitlement_key, quota)
  join plan_entitlements entitlement
    on entitlement.plan_key = expected.plan_key
   and entitlement.entitlement_key = expected.entitlement_key
   and not entitlement.unlimited
   and entitlement.numeric_limit = expected.quota;
  if v_count <> 8 then
    raise exception '0184: only % of the eight decided metered quotas landed', v_count;
  end if;

  -- Business and legacy still stop counting: #197 and #201 make Business contractual, and a number
  -- here would be a commercial promise nobody made.
  if exists (
    select 1 from plan_entitlements
    where plan_key in ('business', 'legacy')
      and entitlement_key in ('documents.monthly', 'ocr_pages.monthly')
      and not unlimited
  ) then
    raise exception '0184: a metered quota was applied to a plan whose answer is a conversation';
  end if;

  -- Every decision reached the catalogue, and every one of them is on record beside the figure it
  -- replaced. A decision applied without a record leaves the cutover report unable to say what
  -- moved; a record without the application is a number nobody is actually held to.
  select count(*) into v_count
  from private.plan_quota_decisions decision
  join plan_entitlements entitlement
    on entitlement.plan_key = decision.plan_key
   and entitlement.entitlement_key = decision.entitlement_key
  where entitlement.unlimited
     or entitlement.numeric_limit is distinct from decision.decided_limit;
  if v_count > 0 then
    raise exception '0184: % decided quota(s) did not reach the catalogue', v_count;
  end if;
  if (select count(*) from private.plan_quota_decisions) <> 8 then
    raise exception '0184: #197 decided eight figures and % are recorded',
      (select count(*) from private.plan_quota_decisions);
  end if;

  -- The three reductions are recorded AS reductions, so the report can name who they drop beneath.
  select count(*) into v_count from private.plan_quota_decisions
  where previous_limit is not null and previous_limit > decided_limit;
  if v_count <> 3 then
    raise exception '0184: % of the three expected ceiling reductions are on record', v_count;
  end if;

  -- #196: volume differs, capability does not. A boolean that is false anywhere would gate a
  -- feature by plan through a side door.
  if exists (select 1 from plan_entitlements where kind = 'boolean' and boolean_value is not true) then
    raise exception '0184: a capability was gated by plan -- #196 forbids it';
  end if;

  -- Every plan/entitlement pair seeded, or effective_entitlement() answers `unavailable` for the
  -- new rungs and 0155 reads that as a refusal.
  select count(*) into v_count
  from subscription_plans plan
  cross join private.entitlement_definitions definition
  where not exists (
    select 1 from plan_entitlements entitlement
    where entitlement.plan_key = plan.plan_key
      and entitlement.entitlement_key = definition.entitlement_key);
  if v_count > 0 then
    raise exception '0184: % plan/entitlement pair(s) unseeded', v_count;
  end if;

  -- The unknown-that-refuses state stays confined to the one metric nobody has priced (#198/#209).
  if exists (
    select 1 from plan_entitlements
    where kind = 'numeric' and not unlimited and numeric_limit is null
      and entitlement_key <> 'assistant_runs.monthly'
  ) then
    raise exception '0184: a metric other than the assistant quota entered the unknown state';
  end if;

  -- #195: the annual price is ten months of the monthly one, checked rather than transcribed.
  for v_plan in
    select monthly.catalogue_version, monthly.plan_key,
           monthly.amount as monthly_amount, yearly.amount as yearly_amount
    from plan_prices monthly
    join plan_prices yearly
      on yearly.catalogue_version = monthly.catalogue_version
     and yearly.plan_key = monthly.plan_key
     and yearly.billing_interval = 'yearly'
    where monthly.billing_interval = 'monthly'
  loop
    if v_plan.yearly_amount <> v_plan.monthly_amount * 10 then
      raise exception '0184: % on % is % a year against % a month -- #195 says ten months',
        v_plan.plan_key, v_plan.catalogue_version, v_plan.yearly_amount, v_plan.monthly_amount;
    end if;
  end loop;

  -- #201: Business has no price anywhere, and the internal minimum is not in this schema at all.
  if exists (select 1 from plan_prices where plan_key in ('business', 'legacy')) then
    raise exception '0184: a plan whose answer is a conversation acquired a published price';
  end if;

  -- Both catalogues cover the same four priced plans, or one region silently sells less.
  select count(*) into v_count from (
    select catalogue_version, count(*) as rows_present from plan_prices group by catalogue_version
  ) coverage where coverage.rows_present <> 8;
  if v_count > 0 then
    raise exception '0184: a price catalogue does not cover four plans on both intervals';
  end if;

  -- The dry run #164 demands actually answers, for every organization, on every metered quota.
  select count(*) into v_count from private.plan_cutover_rows();
  if v_count <> (select count(*) from organization_subscriptions)
                * (select count(*) from private.entitlement_definitions
                   where kind = 'numeric' and measure = 'per_period') then
    raise exception '0184: the cutover report does not cover every organization on every metered quota';
  end if;

  -- And it never proposes moving anybody ONTO the retired plan.
  if exists (select 1 from private.plan_cutover_rows() where target_plan_key = 'legacy') then
    raise exception '0184: the cutover report proposed a move onto the retired plan';
  end if;

  -- A browser role reaches neither the billing periods nor the write side of the price catalogue.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and (
        (table_name = 'organization_billing_periods' and grantee in ('anon', 'authenticated'))
        or (table_name in ('plan_price_catalogues', 'plan_prices')
            and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'))
  ) then
    raise exception '0184: a browser role holds a grant it should not on the billing surfaces';
  end if;
end
$anchor_0184$;
