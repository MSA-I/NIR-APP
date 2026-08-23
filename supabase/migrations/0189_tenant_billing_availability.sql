-- Integration migration (primary agent) -- the one fact a tenant may learn about the merchant of
-- record, and nothing else.
--
-- WHY THIS EXISTS. 0186 gave my_subscription() a `billing_provider_enabled` column and filled it
-- with the constant `false`. That was derived truth, not a placeholder: 0187 seeds
-- private.billing_provider_boundary with every merchant of record DISABLED and nothing in the
-- database can write it. But 0186 sorts BELOW 0187, so that table does not exist when 0186 runs
-- and the constant could not read it. This migration sorts above both and closes that.
--
-- WHY NOT JUST READ THE BOUNDARY FROM THE CLIENT. 0188's platform_billing_boundary() is gated on
-- is_platform_admin() and the billing.view capability, and p71 pins that a tenant owner reads ZERO
-- rows from it. A customer surface wired to that read would receive an empty result and render it
-- as "billing unavailable" -- a silent failure indistinguishable from a healthy refusal. This
-- function is the tenant-safe read that removes the temptation.
--
-- THE INFORMATION BOUNDARY IS THE DESIGN. It returns ONE boolean. Not the provider's name, not the
-- readiness string, not the decision reference. A customer may know WHETHER it can buy a plan; it
-- may not learn that Paddle was chosen, that its KYC is unproven, or which decision governs it.
-- Everything the operator surface exposes stays behind the platform gate where 0188 put it.
--
-- THE KEY IS ALWAYS PRESENT AND NEVER NULL, on purpose. "We do not know" must never reach the
-- client as an absent key that a caller coalesces into `false`, because that renders an outage as
-- a permanent refusal to sell. A transport failure is the caller's to detect and say so; an empty
-- result is not a state this function can produce.

create or replace function public.my_billing_availability()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'self_serve_billing_available',
    exists (
      select 1 from private.billing_provider_boundary boundary
      where boundary.role = 'merchant_of_record' and boundary.enabled
    ))
$$;
revoke all on function public.my_billing_availability() from public, anon;
grant execute on function public.my_billing_availability() to authenticated;

comment on function public.my_billing_availability() is
  'Whether self-serve billing can be transacted at all (0189). One boolean and nothing else: a '
  'tenant may know WHETHER it can buy a plan, never which merchant of record was chosen or why it '
  'is unavailable. Takes no argument, so it cannot be aimed at another tenant.';

-- ===== The 0186 constant becomes a read =====
-- Anchored replacement against the LIVE body rather than a rewrite from the migration text: a
-- rewrite would silently revert anything 0186 gained after I last read it. The body is normalized
-- with the repo's A5 formula, replace(..., e'\r', ''), because a CRLF checkout and an LF one
-- produce different bytes for identical source and a raw compare would fail on one of them.
do $patch_0189$
declare
  v_def    text;
  v_anchor text := $anchor$-- that boundary; the column exists now so the client contract does not change when it does.
         false
  from organization_subscriptions subscription$anchor$;
  v_patch  text := $patch$-- that boundary. 0189 replaced the constant with that read; the column and its meaning are
         -- unchanged, so no client contract moved.
         (public.my_billing_availability() ->> 'self_serve_billing_available')::boolean
  from organization_subscriptions subscription$patch$;
begin
  select replace(pg_get_functiondef(p.oid), e'\r', '') into v_def
  from pg_catalog.pg_proc p
  where p.oid = 'public.my_subscription()'::regprocedure;

  if v_def is null then
    raise exception '0189: my_subscription() not found';
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0189: my_subscription() billing anchor moved -- refusing to patch blindly';
  end if;
  execute replace(v_def, v_anchor, v_patch);
end
$patch_0189$;

-- ===== Structural re-assertion =====
do $assert_0189$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0189 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0189$;

-- ===== Anchors =====
do $anchor_0189$
declare
  v_result jsonb;
begin
  -- No argument, ever. A parameter is a thing an attacker can change, and this function's whole
  -- safety is that it has nothing to aim. Same pin p51 puts on my_entitlements().
  if (select pronargs from pg_proc
      where oid = to_regprocedure('public.my_billing_availability()')) <> 0 then
    raise exception '0189: my_billing_availability() grew a parameter';
  end if;

  -- The key is present and non-null, so a caller can never mistake absence for `false`.
  v_result := public.my_billing_availability();
  if v_result is null or not (v_result ? 'self_serve_billing_available')
     or jsonb_typeof(v_result -> 'self_serve_billing_available') <> 'boolean' then
    raise exception '0189: my_billing_availability() did not return a present, non-null boolean';
  end if;

  -- #213: every merchant of record is unproven, so the honest answer today is false. If this ever
  -- raises, a provider was enabled and that is a commercial event, not a migration detail.
  if (v_result ->> 'self_serve_billing_available')::boolean then
    raise exception '0189: a merchant of record is enabled but none has been proven';
  end if;

  -- A browser role must not reach the boundary table itself, only this answer.
  if has_table_privilege('anon', 'private.billing_provider_boundary', 'SELECT')
     or has_table_privilege('authenticated', 'private.billing_provider_boundary', 'SELECT') then
    raise exception '0189: a browser role can read the provider boundary directly';
  end if;

  -- The patch landed: my_subscription() delegates rather than carrying its own constant.
  if not exists (
    select 1 from pg_proc
    where oid = to_regprocedure('public.my_subscription()')
      and prosrc like '%my_billing_availability%'
  ) then
    raise exception '0189: my_subscription() still reports billing availability as a constant';
  end if;
end
$anchor_0189$;
