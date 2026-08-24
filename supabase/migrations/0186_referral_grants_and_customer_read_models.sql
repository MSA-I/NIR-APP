-- OWNER DECISIONS #212, #227, #228, #229, #230 -- the referral ledger.
--
-- One sentence: a referral code travels in the SIGNUP REQUEST and nowhere else, it binds once and
-- can never be changed, it pays out once -- only after the owner's email is verified AND the
-- organization has really had a document processed -- and when it pays it raises BOTH parties'
-- quota inside THEIR OWN current usage period, never a shared one.
--
-- ===== WHAT IS DELIBERATELY ABSENT, AND WHY THAT IS THE DESIGN =====
--
-- #229 rules out cookies, first/last-click tracking and cross-device attribution. There is
-- therefore no click table, no visit table, no session identifier and no URL column anywhere in
-- this file. Attribution is a field in the signup request or it does not exist. A missing or
-- unknown code does NOT block the signup: it produces an organization with no referrer, and
-- `service_bind_referral` returns a reason rather than raising, because a typo in a share link
-- must never be able to stop somebody opening an account.
--
-- #228 rules out IP, email domain, device and payment method as automatic blocks, and rules out
-- device fingerprinting outright. So there is no IP column -- not hashed, not truncated, not
-- "temporarily". The three hard blocks are exactly the three that were decided: the same
-- organization, the same VERIFIED owner email address, and a cycle between organizations. The
-- email comparison happens inside a function and only its VERDICT is stored: `block_reason` is a
-- code such as `same_verified_owner_email`, never the address that produced it.
--
-- ===== THE CEILING, AND WHY IT CANNOT PAY A PARTIAL BONUS IN PRACTICE =====
--
-- #227: ten per activation, twenty per beneficiary per usage period, no rollover, expiring with
-- that beneficiary's period. #230 adds that a reversed grant STILL counts toward the twenty. The
-- ceiling is therefore measured on the amount ISSUED, not on the amount still live, and because
-- every issue is exactly ten, `issued` is always a multiple of ten: the third activation in one
-- period meets the ceiling exactly at twenty and is issued nothing. The clamp is written as
-- `greatest(ceiling - issued, 0)` so the arithmetic is honest at the boundary rather than relying
-- on that being true, and a zero issue is RECORDED rather than skipped -- an activation that paid
-- nothing because of the ceiling is evidence, and a missing row would look like a bug.
--
-- The numbers are settings data, not literals in a function body, for two reasons. The first is
-- 0161's: a quantity a customer receives is a commercial decision and changing it should be an
-- UPDATE reviewed as such. The second is mechanical and worth stating, because it will bite the
-- next author: the A5 marker guard matches scope-enforced table names as WHOLE WORDS anywhere in a
-- SECURITY DEFINER body, including inside string literals -- and the metric key this program pays
-- in begins with one of them. Reading the key from a settings row keeps every definer body here
-- clear of it.
--
-- ===== HOW A GRANT REACHES A QUOTA =====
--
-- Through `public.effective_entitlement()`, so that ONE resolution rule keeps deciding what a
-- customer may do. The alternative -- teaching the enforcement path and each read model about
-- bonuses separately -- is how a customer ends up being refused at a number the screen does not
-- show. The function is patched in place from its LIVE definition with an anchored replacement
-- rather than retyped, so nothing that was added to it since 0154 can be silently reverted.
--
-- An unstated limit stays a refusal: the bonus is added to a number, and there is no number to add
-- it to when nobody has said what the plan allows. `measured` is untouched.
--
-- ===== WHAT THIS FILE DOES NOT DO =====
--
-- It does not wire the code into the signup request; that is the signup surface's edit, and this
-- file gives it one command to call. Activation, by contrast, IS wired: it fires from the same
-- extraction row that 0155 counts pages on, because "the organization's first successfully
-- processed document" is exactly what that row means.

-- ===== 1. Settings =====
create table private.referral_program_settings (
  singleton      boolean primary key default true check (singleton),
  metric_key     text not null
                 references private.entitlement_definitions(entitlement_key) on delete restrict,
  grant_quantity numeric not null check (grant_quantity > 0),
  period_ceiling numeric not null check (period_ceiling > 0),
  updated_at     timestamptz not null default now(),
  constraint referral_settings_ceiling_shape check (period_ceiling >= grant_quantity)
);
revoke all on table private.referral_program_settings
  from public, anon, authenticated, service_role;

insert into private.referral_program_settings (metric_key, grant_quantity, period_ceiling)
values ('documents.monthly', 10, 20);

comment on table private.referral_program_settings is
  'The #227 quantities as data (0186): ten per activation, twenty per beneficiary per usage '
  'period. Kept out of function bodies both because a quantity a customer receives is a pricing '
  'decision and because the A5 marker guard reads definer bodies as text.';

-- ===== 2. Codes =====
create table private.referral_codes (
  org_id     uuid primary key references organizations(id) on delete restrict,
  code       text not null unique check (code ~ '^[A-Z0-9]{10}$'),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
revoke all on table private.referral_codes from public, anon, authenticated, service_role;

comment on table private.referral_codes is
  'One opaque sharing token per organization (0186, #229). It is meant to be given away, so it is '
  'stored as it is shown; it carries no personal data, encodes nothing about the organization and '
  'is the only identifier the signup request may carry.';

create or replace function private.issue_referral_code(p_org_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
begin
  select code into v_code from private.referral_codes where org_id = p_org_id;
  if v_code is not null then return v_code; end if;

  for v_attempt in 1..8 loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    begin
      insert into private.referral_codes (org_id, code) values (p_org_id, v_code);
      return v_code;
    exception
      when unique_violation then
        -- Either the code collided or the organization already has one. Re-read settles both.
        select code into v_code from private.referral_codes where org_id = p_org_id;
        if v_code is not null then return v_code; end if;
    end;
  end loop;
  raise exception 'referral_code_unavailable' using errcode = '53400';
end
$$;
revoke all on function private.issue_referral_code(uuid) from public, anon, authenticated;

insert into private.referral_codes (org_id, code)
select org.id, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
from organizations org
on conflict (org_id) do nothing;

create or replace function private.organizations_referral_code() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.issue_referral_code(new.id);
  return new;
end
$$;
revoke all on function private.organizations_referral_code() from public, anon, authenticated;

create trigger zzz_organizations_referral_code
  after insert on public.organizations
  for each row execute function private.organizations_referral_code();

-- ===== 3. The binding (#229) =====
create table private.organization_referrals (
  referred_org_id uuid primary key references organizations(id) on delete restrict,
  referrer_org_id uuid not null references organizations(id) on delete restrict,
  referral_code   text not null,
  bound_at        timestamptz not null default now(),
  activated_at    timestamptz,
  -- A decided verdict code (#228). Never an address, never an address fragment, never an IP.
  block_reason    text check (block_reason is null or block_reason ~ '^[a-z][a-z0-9_]*$'),
  constraint organization_referrals_not_self check (referred_org_id <> referrer_org_id)
);
revoke all on table private.organization_referrals
  from public, anon, authenticated, service_role;
create index organization_referrals_referrer_idx
  on private.organization_referrals (referrer_org_id);

comment on table private.organization_referrals is
  'One immutable binding per referred organization (0186, #229). Written in the signup '
  'transaction and never afterwards: there is no cookie, no click history and no cross-device '
  'attribution to reconcile, because attribution that can be added later can be added by anybody.';

create or replace function private.organization_referrals_immutable() returns trigger
language plpgsql as $$
begin
  if new.referred_org_id is distinct from old.referred_org_id
     or new.referrer_org_id is distinct from old.referrer_org_id
     or new.referral_code   is distinct from old.referral_code
     or new.bound_at        is distinct from old.bound_at then
    raise exception 'referral_binding_immutable' using errcode = '42501';
  end if;
  -- Activation happens once. Un-activating would be the beginning of a second payout.
  if old.activated_at is not null and new.activated_at is distinct from old.activated_at then
    raise exception 'referral_activation_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.organization_referrals_immutable() from public, anon, authenticated;

create trigger zz_organization_referrals_immutable
  before update on private.organization_referrals
  for each row execute function private.organization_referrals_immutable();

-- ===== 4. The grants (#227, #230) =====
create table private.referral_grants (
  id                 uuid primary key default gen_random_uuid(),
  referred_org_id    uuid not null
                     references private.organization_referrals(referred_org_id) on delete restrict,
  beneficiary_org_id uuid not null references organizations(id) on delete restrict,
  metric_key         text not null,
  -- The beneficiary's OWN period, not the other party's: #227 says each side is credited inside
  -- its own current usage period, and the two are anchored to two different signup instants.
  period_start       timestamptz not null,
  period_end         timestamptz not null,
  quantity           numeric not null check (quantity >= 0),
  capped_by_ceiling  boolean not null default false,
  granted_at         timestamptz not null default now(),
  revoked_at         timestamptz,
  revoked_by         uuid references auth.users(id) on delete restrict,
  -- How much of the grant was still UNUSED when it was reversed. Never the whole grant when part
  -- of it has been consumed: #230 says consumed usage stays in history and is never charged back.
  revoked_quantity   numeric check (revoked_quantity >= 0),
  revoke_reason      text,
  revoke_evidence    text,
  constraint referral_grants_period_order check (period_end > period_start),
  constraint referral_grants_revoke_shape check (
    (revoked_at is null) = (revoked_by is null)
    and (revoked_at is null) = (revoked_quantity is null)
    and (revoked_at is null) = (revoke_reason is null)
    and (revoked_at is null) = (revoke_evidence is null)),
  constraint referral_grants_revoke_bound check (
    revoked_quantity is null or revoked_quantity <= quantity),
  -- #227's key, exactly. A retried activation lands on the same row and pays once.
  unique (referred_org_id, beneficiary_org_id, period_start)
);
revoke all on table private.referral_grants from public, anon, authenticated, service_role;
create index referral_grants_beneficiary_idx
  on private.referral_grants (beneficiary_org_id, metric_key, period_start);

comment on table private.referral_grants is
  'What a referral actually paid, to whom, and in which of THEIR usage periods (0186, #227/#230). '
  'A reversal marks the row and records only the unused remainder; the full issued amount keeps '
  'counting toward the period ceiling, so a reversal cannot be used to mint a fresh allowance.';

-- ===== 5. Binding, from the signup request and nowhere else (#229) =====
create or replace function public.service_bind_referral(p_org_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code     text := upper(nullif(btrim(coalesce(p_code, '')), ''));
  v_referrer uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_org_id is null or not exists (select 1 from organizations org where org.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  -- A binding that already exists is never replaced. #229 makes it immutable, and returning the
  -- existing state beats a retry looking like a second attribution.
  if exists (select 1 from private.organization_referrals where referred_org_id = p_org_id) then
    return jsonb_build_object('bound', false, 'reason', 'already_bound');
  end if;

  -- A missing or unknown code must never block somebody opening an account. It produces an
  -- organization with no referrer, which is a perfectly ordinary thing to be.
  if v_code is null then
    return jsonb_build_object('bound', false, 'reason', 'code_absent');
  end if;
  select org_id into v_referrer from private.referral_codes
  where code = v_code and active;
  if v_referrer is null then
    return jsonb_build_object('bound', false, 'reason', 'code_unknown');
  end if;
  if v_referrer = p_org_id then
    return jsonb_build_object('bound', false, 'reason', 'same_organization');
  end if;
  if private.referral_same_verified_owner(p_org_id, v_referrer) then
    return jsonb_build_object('bound', false, 'reason', 'same_verified_owner_email');
  end if;

  insert into private.organization_referrals (referred_org_id, referrer_org_id, referral_code)
  values (p_org_id, v_referrer, v_code)
  on conflict (referred_org_id) do nothing;

  return jsonb_build_object('bound', true, 'reason', null);
end
$$;
revoke all on function public.service_bind_referral(uuid, text) from public, anon, authenticated;
grant execute on function public.service_bind_referral(uuid, text) to service_role;

comment on function public.service_bind_referral(uuid, text) is
  'Binds a referral code carried in the signup request (0186, #229). Immutable once written, and '
  'an absent or unknown code returns a reason instead of raising -- a mistyped share link must '
  'never be able to stop somebody opening an account.';

-- #228's second hard block. The address never leaves this function; only the verdict does.
create or replace function private.referral_same_verified_owner(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles profile_a
    join auth.users user_a on user_a.id = profile_a.id
    join public.profiles profile_b on profile_b.org_id = p_b and profile_b.role = 'owner'
    join auth.users user_b on user_b.id = profile_b.id
    where profile_a.org_id = p_a and profile_a.role = 'owner'
      and user_a.email_confirmed_at is not null
      and user_b.email_confirmed_at is not null
      and lower(user_a.email) = lower(user_b.email))
$$;
revoke all on function private.referral_same_verified_owner(uuid, uuid)
  from public, anon, authenticated;

-- #228's third hard block: A referred B, B referred C, C referred A. Bounded depth, because a
-- cycle check that can be made expensive by adding rows is a denial-of-service with extra steps.
create or replace function private.referral_creates_cycle(p_referred uuid, p_referrer uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  with recursive chain as (
    select referral.referrer_org_id as org_id, 1 as depth
    from private.organization_referrals referral
    where referral.referred_org_id = p_referrer
    union all
    select referral.referrer_org_id, chain.depth + 1
    from private.organization_referrals referral
    join chain on referral.referred_org_id = chain.org_id
    where chain.depth < 20
  )
  select p_referred = p_referrer or exists (select 1 from chain where chain.org_id = p_referred)
$$;
revoke all on function private.referral_creates_cycle(uuid, uuid) from public, anon, authenticated;

-- ===== 6. Activation (#212, #227, #228) =====
create or replace function private.try_activate_referral(p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referral   private.organization_referrals;
  v_settings   private.referral_program_settings;
  v_party      uuid;
  v_period     record;
  v_issued     numeric;
  v_amount     numeric;
  v_block      text;
  v_paid       integer := 0;
begin
  select * into v_referral from private.organization_referrals
  where referred_org_id = p_org_id and activated_at is null and block_reason is null
  for update;
  if not found then
    return jsonb_build_object('activated', false, 'reason', 'nothing_pending');
  end if;

  -- #228: exactly three hard blocks, evaluated once and recorded as a code. Evaluated BEFORE the
  -- activation conditions on purpose -- a cycle or a shared verified owner disqualifies a referral
  -- permanently, and it is true whether or not the organization has got as far as processing a
  -- document. Checking prerequisites first would leave a known-bad pair sitting as `pending` until
  -- it happened to do some work, and would only then record what was already knowable.
  v_block := case
    when v_referral.referrer_org_id = p_org_id then 'same_organization'
    when private.referral_same_verified_owner(p_org_id, v_referral.referrer_org_id)
      then 'same_verified_owner_email'
    when private.referral_creates_cycle(p_org_id, v_referral.referrer_org_id)
      then 'referral_cycle'
    end;
  if v_block is not null then
    update private.organization_referrals set block_reason = v_block
    where referred_org_id = p_org_id;
    return jsonb_build_object('activated', false, 'reason', v_block);
  end if;

  -- #212's two conditions, both required, neither assumed. The caller is the extraction row, so
  -- the second is true by construction -- and it is re-read anyway, because a function that only
  -- works when called from one place is a function waiting to be called from a second one.
  if not exists (
    select 1 from public.profiles profile
    join auth.users account on account.id = profile.id
    where profile.org_id = p_org_id and profile.role = 'owner'
      and account.email_confirmed_at is not null
  ) then
    return jsonb_build_object('activated', false, 'reason', 'owner_email_unverified');
  end if;
  if not exists (
    select 1 from public.document_extractions extraction where extraction.org_id = p_org_id
  ) then
    return jsonb_build_object('activated', false, 'reason', 'no_processed_document');
  end if;

  select * into v_settings from private.referral_program_settings;

  foreach v_party in array array[p_org_id, v_referral.referrer_org_id] loop
    select * into v_period from private.usage_period(v_party);

    -- The ceiling is read and written under one lock per beneficiary and period, so two
    -- activations landing together cannot both see room for the last allowance.
    perform pg_advisory_xact_lock(
      hashtextextended(v_party::text || '|' || v_period.period_start::text, 0));

    select coalesce(sum(existing.quantity), 0) into v_issued
    from private.referral_grants existing
    where existing.beneficiary_org_id = v_party
      and existing.metric_key = v_settings.metric_key
      and existing.period_start = v_period.period_start;

    -- #230: a reversed grant still counts here, which is why this sums `quantity` and not the
    -- live remainder. Otherwise a reversal would mint room for a fresh allowance.
    v_amount := greatest(least(v_settings.grant_quantity, v_settings.period_ceiling - v_issued), 0);

    insert into private.referral_grants (
      referred_org_id, beneficiary_org_id, metric_key,
      period_start, period_end, quantity, capped_by_ceiling
    ) values (
      p_org_id, v_party, v_settings.metric_key,
      v_period.period_start, v_period.period_end, v_amount,
      v_amount < v_settings.grant_quantity
    )
    on conflict (referred_org_id, beneficiary_org_id, period_start) do nothing;
    if found then v_paid := v_paid + 1; end if;
  end loop;

  update private.organization_referrals set activated_at = now()
  where referred_org_id = p_org_id;

  return jsonb_build_object('activated', true, 'reason', null, 'grants', v_paid);
end
$$;
revoke all on function private.try_activate_referral(uuid) from public, anon, authenticated;

-- The first successfully processed document IS an extraction row, which is why activation hangs
-- off the same insert 0155 counts pages on rather than off a second definition of "processed".
create or replace function private.referral_activation_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from private.organization_referrals referral
    where referral.referred_org_id = new.org_id
      and referral.activated_at is null and referral.block_reason is null
  ) then
    perform private.try_activate_referral(new.org_id);
  end if;
  return new;
end
$$;
revoke all on function private.referral_activation_trigger() from public, anon, authenticated;

create trigger zzz_referral_activation
  after insert on public.document_extractions
  for each row execute function private.referral_activation_trigger();

-- ===== 7. How a grant reaches the quota =====
-- Patched from the LIVE definition rather than retyped, with both anchors required to appear
-- exactly once, so nothing added to this function since 0154 can be reverted by this file.
do $entitlement_bonus$
declare
  v_def          text;
  v_cte_anchor   constant text := 'with definition as (';
  v_limit_anchor constant text :=
    '''limit'', coalesce((select numeric_limit from live_override), (select numeric_limit from from_plan)),';
  v_cte_patch    constant text :=
    'with referral_bonus as ('
    || ' select coalesce(sum(grant_row.quantity - coalesce(grant_row.revoked_quantity, 0)), 0) as quantity'
    || ' from private.referral_grants grant_row'
    || ' cross join lateral private.usage_period(p_org_id) grant_period'
    || ' where grant_row.beneficiary_org_id = p_org_id'
    || '   and grant_row.metric_key = p_entitlement_key'
    || '   and grant_row.period_start = grant_period.period_start'
    || ' ), definition as (';
  v_limit_patch  constant text :=
    '''limit'', case when coalesce((select numeric_limit from live_override), (select numeric_limit from from_plan)) is null'
    || ' then null'
    || ' else coalesce((select numeric_limit from live_override), (select numeric_limit from from_plan))'
    || '      + coalesce((select quantity from referral_bonus), 0) end,'
    || ' ''referral_bonus'', coalesce((select quantity from referral_bonus), 0),';
  v_cte_hits     integer;
  v_limit_hits   integer;
begin
  select pg_get_functiondef(proc.oid) into v_def
  from pg_catalog.pg_proc proc
  where proc.oid = 'public.effective_entitlement(uuid,text)'::regprocedure;
  if v_def is null then
    raise exception '0186: public.effective_entitlement(uuid,text) not found';
  end if;

  v_cte_hits := (length(v_def) - length(replace(v_def, v_cte_anchor, ''))) / length(v_cte_anchor);
  v_limit_hits :=
    (length(v_def) - length(replace(v_def, v_limit_anchor, ''))) / length(v_limit_anchor);
  if v_cte_hits <> 1 or v_limit_hits <> 1 then
    raise exception
      '0186: effective_entitlement anchor moved (cte %, limit %) -- refusing to patch blindly',
      v_cte_hits, v_limit_hits;
  end if;

  execute replace(replace(v_def, v_cte_anchor, v_cte_patch), v_limit_anchor, v_limit_patch);
end
$entitlement_bonus$;

-- ===== 8. Reads =====
create or replace function public.my_referral_code() returns text
language sql stable security definer set search_path = public as $$
  select code from private.referral_codes
  where org_id = auth_org() and active and auth_org() is not null
$$;
revoke all on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;

create or replace function public.my_referral_bonus()
returns table (
  metric_key text, granted numeric, reversed numeric, effective numeric,
  period_start timestamptz, period_end timestamptz
)
language sql stable security definer set search_path = public as $$
  select grant_row.metric_key,
         sum(grant_row.quantity),
         sum(coalesce(grant_row.revoked_quantity, 0)),
         sum(grant_row.quantity - coalesce(grant_row.revoked_quantity, 0)),
         grant_row.period_start,
         grant_row.period_end
  from private.referral_grants grant_row
  cross join lateral private.usage_period(auth_org()) period
  where auth_org() is not null
    and grant_row.beneficiary_org_id = auth_org()
    and grant_row.period_start = period.period_start
  group by grant_row.metric_key, grant_row.period_start, grant_row.period_end
$$;
revoke all on function public.my_referral_bonus() from public, anon;
grant execute on function public.my_referral_bonus() to authenticated;

create or replace function public.platform_referral_ledger(p_org_id uuid)
returns table (
  referred_org_id uuid, referrer_org_id uuid, bound_at timestamptz,
  activated_at timestamptz, block_reason text,
  beneficiary_org_id uuid, metric_key text, quantity numeric,
  capped_by_ceiling boolean, revoked_at timestamptz, revoked_quantity numeric,
  period_start timestamptz, period_end timestamptz
)
language sql stable security definer set search_path = public as $$
  select referral.referred_org_id, referral.referrer_org_id, referral.bound_at,
         referral.activated_at, referral.block_reason,
         grant_row.beneficiary_org_id, grant_row.metric_key, grant_row.quantity,
         grant_row.capped_by_ceiling, grant_row.revoked_at, grant_row.revoked_quantity,
         grant_row.period_start, grant_row.period_end
  from private.organization_referrals referral
  left join private.referral_grants grant_row
    on grant_row.referred_org_id = referral.referred_org_id
  where (referral.referred_org_id = p_org_id or referral.referrer_org_id = p_org_id)
    and is_platform_admin() and public.platform_has_capability('billing.view')
  order by referral.bound_at, grant_row.beneficiary_org_id
$$;
revoke all on function public.platform_referral_ledger(uuid) from public, anon;
grant execute on function public.platform_referral_ledger(uuid) to authenticated;

-- ===== 9. Reversal of the UNUSED remainder only (#230) =====
create or replace function public.platform_revoke_referral_grant(
  p_referred_org_id uuid, p_reason text, p_evidence text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := auth.uid();
  v_reason   text;
  v_evidence text := nullif(btrim(coalesce(p_evidence, '')), '');
  v_referral private.organization_referrals;
  v_grant    private.referral_grants;
  v_period   record;
  v_used     numeric;
  v_entitle  jsonb;
  v_base     numeric;
  v_live     numeric;
  v_unused   numeric;
  v_take     numeric;
  v_reversed numeric := 0;
  v_rows     integer := 0;
  v_already  integer := 0;
begin
  select * into v_referral from private.organization_referrals
  where referred_org_id = p_referred_org_id for update;
  if not found then
    raise exception 'referral_unknown' using errcode = 'P0002';
  end if;
  v_reason := private.assert_platform_command(
    p_referred_org_id, 'entitlement.override', p_reason);
  perform public.assert_recent_password_authentication();
  if v_evidence is null then
    -- #230 requires evidence, not only a reason. A reversal without it is an assertion.
    raise exception 'referral_reversal_evidence_required' using errcode = '22023';
  end if;

  for v_grant in
    select * from private.referral_grants
    where referred_org_id = p_referred_org_id
    order by beneficiary_org_id
    for update
  loop
    if v_grant.revoked_at is not null then
      -- An identical retry adds no second reversal.
      v_already := v_already + 1;
      continue;
    end if;

    select * into v_period from private.usage_period(v_grant.beneficiary_org_id);
    if v_grant.period_start <> v_period.period_start then
      -- The beneficiary's period has closed. #227 gives the bonus no rollover, so there is no
      -- remainder left to reverse and the row is stamped at zero rather than pretending otherwise.
      v_unused := 0;
    else
      select coalesce(counter.quantity, 0) into v_used
      from private.usage_counters counter
      where counter.org_id = v_grant.beneficiary_org_id
        and counter.metric_key = v_grant.metric_key
        and counter.period_start = v_grant.period_start;
      v_used := coalesce(v_used, 0);

      v_entitle := public.effective_entitlement(v_grant.beneficiary_org_id, v_grant.metric_key);
      v_live := coalesce((v_entitle ->> 'referral_bonus')::numeric, 0);
      v_base := coalesce((v_entitle ->> 'limit')::numeric, 0) - v_live;

      -- Consumption is drawn from the plan allowance first and only then from the pooled bonus,
      -- so a beneficiary who never exceeded the plan allowance has consumed no bonus at all.
      -- What can be taken back is this grant's own live amount, bounded by what the whole pool
      -- still has unspent -- never a unit somebody has already used.
      v_unused := least(
        v_grant.quantity - coalesce(v_grant.revoked_quantity, 0),
        greatest(v_live - greatest(v_used - v_base, 0), 0));
    end if;

    v_take := greatest(v_unused, 0);
    update private.referral_grants
       set revoked_at = now(), revoked_by = v_actor, revoked_quantity = v_take,
           revoke_reason = v_reason, revoke_evidence = v_evidence
     where id = v_grant.id;

    perform private.record_platform_lifecycle_event(
      v_grant.beneficiary_org_id, v_actor, 'referral_grant_revoked',
      'referral_grants', v_grant.id,
      jsonb_build_object('quantity', v_grant.quantity),
      jsonb_build_object('revoked_quantity', v_take, 'evidence', v_evidence),
      v_reason);

    v_reversed := v_reversed + v_take;
    v_rows := v_rows + 1;
  end loop;

  return jsonb_build_object(
    'referred_org_id', p_referred_org_id,
    'grants_revoked', v_rows,
    'already_revoked', v_already,
    'quantity_reversed', v_reversed,
    'idempotent', v_rows = 0);
end
$$;
revoke all on function public.platform_revoke_referral_grant(uuid, text, text)
  from public, anon;
grant execute on function public.platform_revoke_referral_grant(uuid, text, text)
  to authenticated;

comment on function public.platform_revoke_referral_grant(uuid, text, text) is
  'Reverses the UNUSED remainder of a referral bonus for both beneficiaries (0186, #230). Usage '
  'already consumed stays in history and is never charged back or offset against a future period; '
  'the row is marked, never deleted, and the full issued amount keeps counting toward the ceiling.';

-- ===== 10. The read surface the pricing and upgrade screens need =====
--
-- Two concerns share this migration because the allocation for this plan ends at 0186. They are
-- kept in separate sections and neither depends on the other; a later reader should treat the file
-- as two, and the header of each section says which decisions it implements.
--
-- #208 IS THE WHOLE SHAPE OF WHAT FOLLOWS. A customer's currency comes from the billing country
-- the merchant of record VERIFIED -- never from an IP address, never from a picker. Until such a
-- verification exists for an organization, `my_subscription()` and `my_upgrade_options()` return a
-- NULL currency and NULL amounts. That is not a placeholder: it is the correct answer to "what
-- will this customer be charged", asked before anybody has established where they are. The public
-- landing catalogue is different -- it takes no customer at all and simply publishes both
-- catalogues, letting the page show the one it was asked for.
--
-- The verified country needs somewhere to live, and the thing that establishes it is a signed
-- provider event, which belongs to the provider boundary. So the TABLE is here and the WRITER is a
-- private command the provider surface calls; nothing in this file ever sets a country itself.

create table private.organization_billing_country (
  org_id            uuid primary key references organizations(id) on delete restrict,
  country_code      text not null check (country_code ~ '^[A-Z]{2}$'),
  verified_at       timestamptz not null,
  provider_event_id uuid,
  recorded_at       timestamptz not null default now()
);
revoke all on table private.organization_billing_country
  from public, anon, authenticated, service_role;

comment on table private.organization_billing_country is
  'The billing country a merchant of record verified (0186, #208). Absence is meaningful: it is '
  'why a currency is reported as unknown rather than guessed, and #214 makes a change here take '
  'effect only at the next renewal.';

create or replace function private.record_billing_country(
  p_org_id uuid, p_country_code text, p_verified_at timestamptz, p_provider_event_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text := upper(btrim(coalesce(p_country_code, '')));
  v_old  text;
begin
  if v_code !~ '^[A-Z]{2}$' then
    raise exception 'billing_country_invalid' using errcode = '22023';
  end if;
  select country_code into v_old from private.organization_billing_country where org_id = p_org_id;

  insert into private.organization_billing_country
    (org_id, country_code, verified_at, provider_event_id)
  values (p_org_id, v_code, coalesce(p_verified_at, now()), p_provider_event_id)
  on conflict (org_id) do update
    set country_code = excluded.country_code,
        verified_at = excluded.verified_at,
        provider_event_id = excluded.provider_event_id,
        recorded_at = now();

  return jsonb_build_object('org_id', p_org_id, 'country_code', v_code,
                            'previous_country_code', v_old,
                            'changed', v_old is distinct from v_code);
end
$$;
revoke all on function private.record_billing_country(uuid, text, timestamptz, uuid)
  from public, anon, authenticated;

-- The catalogue the landing page publishes. Takes no customer, so it cannot leak one; excludes
-- Business server-side rather than trusting a component to hide it (#194/#201).
create or replace function public.get_public_plan_catalogue()
returns table (
  plan_key text, label text, tier_order integer, currency text,
  catalogue_version text, monthly_amount numeric, yearly_amount numeric
)
language sql stable security definer set search_path = public as $$
  select plan.plan_key, plan.label, plan.tier_order,
         catalogue.currency, catalogue.catalogue_version,
         max(price.amount) filter (where price.billing_interval = 'monthly'),
         max(price.amount) filter (where price.billing_interval = 'yearly')
  from subscription_plans plan
  join plan_prices price on price.plan_key = plan.plan_key
  join plan_price_catalogues catalogue
    on catalogue.catalogue_version = price.catalogue_version and catalogue.active
  where plan.active and plan.plan_key <> 'business'
  group by plan.plan_key, plan.label, plan.tier_order,
           catalogue.currency, catalogue.catalogue_version
  order by plan.tier_order, catalogue.currency
$$;
grant execute on function public.get_public_plan_catalogue() to anon, authenticated;

comment on function public.get_public_plan_catalogue() is
  'The four public plans and what they cost, pre-tax, in both catalogues (0186, #194/#195). '
  'Business is excluded in the server rather than hidden in a component: `דברו איתנו` is the whole '
  'public answer and its internal minimum must never reach a browser (#201).';

-- The publishable quota rows. `measured = false` is the signal that makes a screen print a dash,
-- and the values are SUPPRESSED when it is false, so an unmeasured entitlement cannot be published
-- as a promise by a caller that forgets to read the flag (#199, DEBT §56).
create or replace function public.get_public_plan_quotas()
returns table (
  plan_key text, entitlement_key text, label text, unit text,
  unlimited boolean, numeric_limit numeric, measured boolean
)
language sql stable security definer set search_path = public as $$
  select plan.plan_key,
         definition.entitlement_key,
         definition.label,
         definition.unit,
         case when measurable.measured then entitlement.unlimited else false end,
         case when measurable.measured then entitlement.numeric_limit end,
         measurable.measured
  from subscription_plans plan
  join plan_entitlements entitlement on entitlement.plan_key = plan.plan_key
  join private.entitlement_definitions definition
    on definition.entitlement_key = entitlement.entitlement_key
  cross join lateral (
    select (entitlement.unlimited or entitlement.numeric_limit is not null)
           and definition.measure = 'per_period' as measured
  ) measurable
  where plan.active
    and plan.plan_key <> 'business'
    and definition.kind = 'numeric'
    -- #200: the storage ceilings are internal safety limits and are never published.
    and definition.entitlement_key <> 'storage.bytes'
  order by plan.tier_order, definition.entitlement_key
$$;
revoke all on function public.get_public_plan_quotas() from public;
grant execute on function public.get_public_plan_quotas() to anon, authenticated;

comment on function public.get_public_plan_quotas() is
  'What each public plan includes, with unmeasured entitlements reported as unmeasured AND blanked '
  '(0186, #199/#200). A number nothing counts is not a promise, and the storage ceilings are '
  'internal safety limits that are never published at all.';

-- The caller's own commercial state. No organization argument -- the tenant comes from auth_org(),
-- so it cannot be aimed at somebody else -- and no provider identifier is in the result at all.
create or replace function public.my_subscription()
returns table (
  plan_key text, plan_label text, is_paid_plan boolean, status text,
  billing_interval text, current_period_end timestamptz,
  cancel_at_period_end boolean, scheduled_plan_key text, scheduled_plan_label text,
  scheduled_interval text, scheduled_effective_at timestamptz,
  delinquent boolean, billing_country text, billing_country_verified boolean,
  catalogue_currency text, billing_provider_enabled boolean
)
language sql stable security definer set search_path = public as $$
  select subscription.plan_key,
         plan.label,
         -- Paid is a position on the ladder, not a list of names: a rung added later is paid if it
         -- sits above the free one, without anybody remembering to edit this function.
         plan.tier_order > (select free_plan.tier_order from subscription_plans free_plan
                            where free_plan.plan_key = 'free'),
         subscription.status,
         subscription.billing_interval,
         coalesce(
           (select billing_period.period_end from organization_billing_periods billing_period
            where billing_period.org_id = subscription.org_id
            order by billing_period.period_start desc limit 1),
           subscription.current_period_end),
         -- The four scheduled-change facts are NOT STORED ANYWHERE YET, and these constants are
         -- the honest report of that rather than a placeholder: no command in the database can
         -- currently schedule a plan change or cancel at a period boundary, so there is nothing to
         -- report. The surface that introduces that state must replace these four expressions in
         -- the same migration that does.
         false, null::text, null::text, null::text, null::timestamptz,
         subscription.status = 'past_due',
         country.country_code,
         country.country_code is not null,
         -- #208 exactly: no verified billing country means no currency, not a guessed one.
         (select catalogue.currency from plan_price_catalogues catalogue
          where catalogue.active
            and catalogue.billing_country_scope
                = public.billing_catalogue_scope(country.country_code)
            and country.country_code is not null
          limit 1),
         -- Whether billing can be transacted at all. #213 has Paddle at ACCOUNT_NOT_PROVEN, the
         -- provider boundary is seeded with every merchant of record DISABLED, and nothing in the
         -- database can write it -- so `false` is the derived truth today, not a placeholder. The
         -- migration that first enables a provider must replace this expression with a read of
         -- that boundary; the column exists now so the client contract does not change when it does.
         false
  from organization_subscriptions subscription
  join subscription_plans plan on plan.plan_key = subscription.plan_key
  left join private.organization_billing_country country on country.org_id = subscription.org_id
  where subscription.org_id = auth_org() and auth_org() is not null
$$;
revoke all on function public.my_subscription() from public, anon;
grant execute on function public.my_subscription() to authenticated;

comment on function public.my_subscription() is
  'The caller''s own subscription (0186). No organization argument and no provider identifier. The '
  'currency is null until a merchant of record has VERIFIED a billing country (#208), and the '
  'scheduled-change and checkout fields report the absence of state the database does not yet hold.';

-- The authenticated upgrade surface: all five rungs, because Business is revealed HERE and only
-- here (#194), always without a price (#201).
create or replace function public.my_upgrade_options()
returns table (
  plan_key text, label text, tier_order integer, paid boolean, contact_sales boolean,
  currency text, catalogue_version text, monthly_amount numeric, yearly_amount numeric
)
language sql stable security definer set search_path = public as $$
  select plan.plan_key,
         plan.label,
         plan.tier_order,
         plan.tier_order > (select free_plan.tier_order from subscription_plans free_plan
                            where free_plan.plan_key = 'free'),
         plan.plan_key = 'business',
         catalogue.currency,
         catalogue.catalogue_version,
         case when plan.plan_key = 'business' then null else
           (select price.amount from plan_prices price
            where price.catalogue_version = catalogue.catalogue_version
              and price.plan_key = plan.plan_key and price.billing_interval = 'monthly') end,
         case when plan.plan_key = 'business' then null else
           (select price.amount from plan_prices price
            where price.catalogue_version = catalogue.catalogue_version
              and price.plan_key = plan.plan_key and price.billing_interval = 'yearly') end
  from subscription_plans plan
  left join private.organization_billing_country country on country.org_id = auth_org()
  left join plan_price_catalogues catalogue
    on catalogue.active
   and country.country_code is not null
   and catalogue.billing_country_scope = public.billing_catalogue_scope(country.country_code)
  where plan.active and auth_org() is not null
  order by plan.tier_order
$$;
revoke all on function public.my_upgrade_options() from public, anon;
grant execute on function public.my_upgrade_options() to authenticated;

comment on function public.my_upgrade_options() is
  'Every rung the caller could move to (0186, #194/#201/#208). Business appears with no price, '
  'ever; every other price is null until a verified billing country says which catalogue applies.';

-- ===== 11. The #208 posture these read models depend on =====
--
-- Worth stating where the read models are, because the wrong version of this is persuasive and was
-- briefly built. An earlier draft of 0184 published `plan_pricing(p_billing_country_scope text)`
-- to `anon` and `authenticated`, reasoning that TAKING the scope was the opposite of GUESSING it.
-- It is not. #208 forbids two things -- inferring a currency from an IP address, and letting the
-- customer pick one freely -- and a scope parameter granted to a browser role is the second with a
-- different name, and the worse of the two: the answer is chosen entirely by the caller and comes
-- back wearing the authority of a server response.
--
-- The real alternative to guessing is DERIVING from something verified. That is what the functions
-- above do, and 0184 now ships no scope-taking pricing function at all -- removed by SIGNATURE
-- rather than by revoking a grant, because a parameter that exists will eventually be passed.
-- `billing_catalogue_scope()` survives as a pure classifier of a COUNTRY, callable only by these
-- definer functions, which read the verified country first.

-- ===== 12. Structural re-assertion =====
do $assert_0186$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0186 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0186 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0186$;

-- ===== 13. Anchors =====
do $anchor_0186$
declare
  v_count     integer;
  v_probe     jsonb;
  v_signature text;
begin
  -- The #208 hole stays closed BY SIGNATURE: there is no longer a pricing function that accepts a
  -- scope at all, so no future grant can reopen it.
  if to_regprocedure('public.plan_pricing(text)') is not null then
    raise exception '0186: a pricing function that takes a caller-supplied scope still exists';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('plan_price_catalogues', 'plan_prices')
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception '0186: a browser role still reads the price tables directly';
  end if;

  -- The client boundary, named one contract at a time. A suite that mocks these can be green while
  -- none of them exists; this is the assertion that makes that impossible.
  for v_signature in select unnest(array[
    'public.get_public_plan_catalogue()',
    'public.get_public_plan_quotas()',
    'public.my_subscription()',
    'public.my_upgrade_options()',
    'public.my_referral_code()',
    'public.my_referral_bonus()',
    'public.service_bind_referral(uuid,text)',
    'public.platform_referral_ledger(uuid)',
    'public.platform_revoke_referral_grant(uuid,text,text)'
  ]) loop
    if to_regprocedure(v_signature) is null then
      raise exception '0186: the published contract % does not exist', v_signature;
    end if;
  end loop;
  -- And the customer-facing reads take no scope at all: a parameter is a thing a caller changes.
  if (select pronargs from pg_catalog.pg_proc proc
      join pg_catalog.pg_namespace space on space.oid = proc.pronamespace
      where space.nspname = 'public' and proc.proname = 'my_subscription') <> 0
     or (select pronargs from pg_catalog.pg_proc proc
         join pg_catalog.pg_namespace space on space.oid = proc.pronamespace
         where space.nspname = 'public' and proc.proname = 'my_upgrade_options') <> 0 then
    raise exception '0186: a customer-facing subscription read grew a parameter';
  end if;
  -- #201: no Business price reaches the upgrade surface, in either direction.
  if exists (select 1 from plan_prices where plan_key = 'business') then
    raise exception '0186: Business acquired a price row';
  end if;
  if (select count(*) from private.referral_program_settings) <> 1
     or (select grant_quantity from private.referral_program_settings) <> 10
     or (select period_ceiling from private.referral_program_settings) <> 20 then
    raise exception '0186: the referral quantities are not the ten and twenty #227 decided';
  end if;

  select count(*) into v_count from organizations org
  where not exists (select 1 from private.referral_codes code where code.org_id = org.id);
  if v_count > 0 then
    raise exception '0186: % organization(s) have no referral code to share', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'organizations'
      and trg.tgname = 'zzz_organizations_referral_code' and not trg.tgisinternal
  ) then
    raise exception '0186: an organization created a minute from now would have no referral code';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'document_extractions'
      and trg.tgname = 'zzz_referral_activation' and not trg.tgisinternal
  ) then
    raise exception '0186: a referral would never activate on a first processed document';
  end if;

  -- #228: no column anywhere in this feature may hold an address, a network address or a device
  -- signature. The decision rules those signals out; the schema should make re-adding them a
  -- deliberate act rather than a convenient one.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name in ('referral_codes', 'organization_referrals', 'referral_grants')
      and column_name ~* 'ip|email|device|fingerprint|user_agent|url|referer|referrer_url'
  ) then
    raise exception '0186: the referral schema grew a column #228 rules out';
  end if;

  -- The patched resolution rule still resolves, still reports the bonus, and an unstated limit is
  -- still a refusal rather than becoming measured because a bonus exists.
  v_probe := public.effective_entitlement(
    '00000000-0000-4000-8000-000000000000', 'documents.monthly');
  if v_probe is null or not (v_probe ? 'referral_bonus') then
    raise exception '0186: effective_entitlement no longer reports a referral bonus';
  end if;
  if (v_probe ->> 'measured')::boolean or (v_probe ->> 'source') <> 'unavailable' then
    raise exception '0186: the patched resolution rule started measuring an organization it cannot see';
  end if;
  if public.effective_entitlement('00000000-0000-4000-8000-000000000000', 'nope.nope') is not null then
    raise exception '0186: an unknown entitlement key resolved to something';
  end if;
end
$anchor_0186$;
