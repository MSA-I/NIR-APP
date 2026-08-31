-- Owner ruling 31.08.2026 (option ב) -- the Paddle SANDBOX catalogue, mapped, with the merchant of
-- record still switched off everywhere.
--
-- WHAT THIS FILE IS. `0187` created private.billing_provider_price_map and left it deliberately
-- empty, with an anchor that refused a seeded mapping: "a seeded mapping would be an invented
-- pricing decision". That anchor was right about a mapping nobody had derived. It is not right
-- about this one, and this file knowingly succeeds it -- the same way 0187 knowingly overturned
-- 0157's "there will be no `processed` status". The difference is where the numbers come from:
--
--   * The six prices below EXIST at Paddle. They were created by scripts/paddle/sandbox-catalogue.mjs
--     against sandbox-api.paddle.com on 31.08.2026 and read back from Paddle afterwards.
--   * Their amounts are not chosen here and are not chosen there. They are the rows 0184 seeded
--     into plan_prices from owner decision #195, and scripts/paddle/verify-catalogue-matches-db.mjs
--     re-derives that equality from this database against Paddle's live answer rather than trusting
--     either transcription.
--
-- So the mapping is derived, checkable and reversible, which is what the 0187 anchor was protecting.
--
-- WHAT THIS FILE STILL DOES NOT DO, AND THE OWNER CHOSE THAT. It does not enable a provider.
-- private.billing_provider_boundary keeps every merchant of record disabled, nothing here writes it,
-- and 0187's prohibition on a function that can enable one is untouched. The owner was asked on
-- 31.08.2026 how the sandbox round trip should be proven without switching billing on in
-- production, and ruled option ב: the live round trip runs against the LOCAL stack, where p71's
-- existing rolled-back-transaction idiom -- and, for the one end-to-end purchase, a local enable
-- that no migration carries -- turns the provider on and off again. Nothing permanent is added and
-- there is therefore nothing to remove later. A merge of this file is not billing activation, and
-- production reads exactly the same disabled boundary after it as before it.
--
-- WHY SANDBOX PRICE IDS ARE SAFE TO CARRY IN A MIGRATION THAT REACHES PRODUCTION. Paddle price ids
-- are globally unique and an id minted in the sandbox is never minted again in live, so a live
-- event cannot match one of these rows -- it would carry an id absent from this table and take the
-- `plan_unmapped` dead letter 0187 already built and p71 already proves. The rows are inert in
-- production twice over: by that impossibility, and by the disabled boundary above it. What they
-- are NOT is self-explanatory, which is why `environment` exists below.

-- ===== 1. The map records the whole mapping, not a third of it =====
-- 0187 stored provider_price_id -> plan_key, which is everything the TRANSITION needs and less than
-- what a person reconciling a customer's invoice needs. The product id and the interval are facts
-- about the price that Paddle already decided; recording them here makes "which rung and which
-- cycle is this id" answerable from the database instead of from a dashboard login.
alter table private.billing_provider_price_map
  add column provider_product_id text
    check (provider_product_id is null or length(btrim(provider_product_id)) between 1 and 200),
  add column billing_interval text
    check (billing_interval is null or billing_interval in ('monthly', 'yearly')),
  -- Which Paddle account minted the id. NOT a switch and never read by a transition: the id's own
  -- global uniqueness already makes cross-environment collision impossible, so filtering on this
  -- would add a second answer to a question that already has one. It is here so a reader can tell
  -- at a glance that these six rows are test money, and so a future live rollout adds its rows
  -- beside them instead of replacing them.
  add column environment text not null default 'sandbox'
    check (environment in ('sandbox', 'live'));

comment on column private.billing_provider_price_map.environment is
  'Which Paddle account minted this price id (0277). Documentation and reconciliation only -- no '
  'transition reads it, because a Paddle price id is globally unique and cannot collide across '
  'environments. Entitlement is decided by plan_key on the matched row and by nothing else.';

-- ===== 2. The six sandbox prices (created 31.08.2026, read back from Paddle) =====
-- #201 keeps `business` out: its answer is a conversation, and a price row would be the figure that
-- decision refuses to publish. `free` is out because it is the state an organization is already in,
-- not something anybody buys (#165/#217).
--
-- Two rows per plan and one price id per (plan, interval): Paddle's unit_price_overrides carries
-- ILS for Israel and USD everywhere else on ONE price, which is the shape #208 describes -- a
-- separately decided amount per billing country, not a conversion. That keeps this mapping
-- single-valued, which is the property the whole attribution boundary depends on.
insert into private.billing_provider_price_map
  (provider, provider_price_id, plan_key, provider_product_id, billing_interval, environment, note)
values
  ('paddle', 'pri_01m1c3fv4a08jwdvhhj9btmg6j', 'basic',   'pro_01m1c3ftscgby5feen91dvadt3', 'monthly', 'sandbox', '#195 launch-row 20 USD / launch-il 69 ILS'),
  ('paddle', 'pri_01m1c3fvakrj413e0varprm82j', 'basic',   'pro_01m1c3ftscgby5feen91dvadt3', 'yearly',  'sandbox', '#195 launch-row 200 USD / launch-il 690 ILS'),
  ('paddle', 'pri_01m1c3fvr5wm54pw5rkdw09tyd', 'pro',     'pro_01m1c3fvj210yf031vqc7v4m49', 'monthly', 'sandbox', '#195 launch-row 79 USD / launch-il 249 ILS'),
  ('paddle', 'pri_01m1c3fvy7pcje537tyqvcf62q', 'pro',     'pro_01m1c3fvj210yf031vqc7v4m49', 'yearly',  'sandbox', '#195 launch-row 790 USD / launch-il 2490 ILS'),
  ('paddle', 'pri_01m1c3fwbrcb19f18hqh8jpfvn', 'premium', 'pro_01m1c3fw5nsk8n8j11xytw3sz5', 'monthly', 'sandbox', '#195 launch-row 149 USD / launch-il 449 ILS'),
  ('paddle', 'pri_01m1c3fwht8yngektv59d4ys9k', 'premium', 'pro_01m1c3fw5nsk8n8j11xytw3sz5', 'yearly',  'sandbox', '#195 launch-row 1490 USD / launch-il 4490 ILS');

-- ===== 3. Structural re-assertion (required of every post-0057 file) =====
do $assert_0277$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0277 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0277 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0277$;

-- ===== 4. Anchors =====
do $anchor_0277$
declare
  v_count integer;
begin
  -- THE ONE THAT MATTERS MOST. This file adds a mapping; it must not have added a merchant of
  -- record. If a provider is enabled after 0277, the owner's ruling was not honoured.
  if exists (select 1 from private.billing_provider_boundary where enabled) then
    raise exception '0277: a billing provider is enabled -- mapping a catalogue is not activation';
  end if;

  -- 0187's prohibition survives untouched: nothing may be able to enable a provider at run time.
  if exists (
    select 1 from pg_proc
    where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and prosrc ~ '\mbilling_provider_boundary\M'
      and prosrc ~* '\minsert\M|\mupdate\M|\mdelete\M'
  ) then
    raise exception '0277: a function can write the billing provider boundary';
  end if;

  -- Every row this file seeded is complete. A half-recorded mapping is the reconciliation gap the
  -- new columns exist to close, so an incomplete row is a defect rather than a permitted state.
  select count(*) into v_count from private.billing_provider_price_map
  where provider = 'paddle'
    and (provider_product_id is null or billing_interval is null);
  if v_count > 0 then
    raise exception '0277: % paddle price rows carry no product id or no interval', v_count;
  end if;

  -- Exactly one price id per (plan, interval). Two would make "which price is Pro monthly"
  -- ambiguous, which is the same class of defect as an unmapped price pointed the other way.
  if exists (
    select 1 from private.billing_provider_price_map
    where provider = 'paddle' and environment = 'sandbox'
    group by plan_key, billing_interval having count(*) > 1
  ) then
    raise exception '0277: a plan and interval maps to more than one sandbox price';
  end if;

  select count(*) into v_count from private.billing_provider_price_map
  where provider = 'paddle' and environment = 'sandbox';
  if v_count <> 6 then
    raise exception '0277: expected 6 sandbox prices (3 plans x 2 intervals), found %', v_count;
  end if;

  -- #201 and #165: neither rung may acquire a price id. Business's answer is a conversation and
  -- Free is not something anybody buys.
  if exists (
    select 1 from private.billing_provider_price_map
    where provider = 'paddle' and plan_key in ('business', 'free')
  ) then
    raise exception '0277: business or free was given a provider price';
  end if;

  -- No role gained a grant on the map because it grew columns.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'billing_provider_price_map'
      and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception '0277: a role holds a direct grant on the provider price map';
  end if;
end
$anchor_0277$;
