-- P39 -- kitchen, payer and supplier remain historical enum values, never product accounts.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p39_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P39 retired persona assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('1a390000-0000-4000-8000-000000000001', 'P39 tenant', 'active', 18);

insert into auth.users (id, email) values
  ('2a390000-0000-4000-8000-000000000001', 'owner-p39@example.test'),
  ('2a390000-0000-4000-8000-000000000002', 'retired-p39@example.test'),
  ('2a390000-0000-4000-8000-000000000003', 'office-p39@example.test');

-- Historical fixtures are still representable when loaded by postgres. That is why user_role was
-- not rewritten. The browser/RPC boundary below is what prevents this row becoming a product user.
insert into public.profiles (id, org_id, full_name, role, active) values
  ('2a390000-0000-4000-8000-000000000001', '1a390000-0000-4000-8000-000000000001',
   'P39 owner', 'owner', true),
  ('2a390000-0000-4000-8000-000000000002', '1a390000-0000-4000-8000-000000000001',
   'P39 historical kitchen', 'kitchen', true),
  ('2a390000-0000-4000-8000-000000000003', '1a390000-0000-4000-8000-000000000001',
   'P39 office', 'office', true);

insert into public.suppliers (id, org_id, name) values
  ('3a390000-0000-4000-8000-000000000001', '1a390000-0000-4000-8000-000000000001',
   'P39 supplier');

-- A trusted fixture may also preserve a pending historical invitation. Resending it through the
-- product path must still fail.
insert into public.invitations (
  id, org_id, email, role, token_hash, expires_at, invited_by, last_sent_at, send_count
) values (
  '4a390000-0000-4000-8000-000000000001', '1a390000-0000-4000-8000-000000000001',
  'historical-payer-p39@example.test', 'payer', repeat('a', 64), now() + interval '7 days',
  '2a390000-0000-4000-8000-000000000001', now() - interval '1 day', 1
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '2a390000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '2a390000-0000-4000-8000-000000000001',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password',
    'timestamp', extract(epoch from clock_timestamp())::bigint
  ))
)::text, true);

-- Deactivation is always allowed: the guard must help retirement, not trap an old active row.
select public.manage_profile_access(
  '2a390000-0000-4000-8000-000000000002', 'kitchen', false, null, 'P39 deactivate');

select pg_temp.p39_assert(
  not (select active from public.profiles where id = '2a390000-0000-4000-8000-000000000002'),
  'a retired profile could not be deactivated');

do $$
begin
  perform public.manage_profile_access(
    '2a390000-0000-4000-8000-000000000002', 'kitchen', true, null, 'P39 reactivate');
  raise exception 'P39 retired persona assertion failed: kitchen was reactivated';
exception when sqlstate '42501' then
  if sqlerrm <> 'account_role_retired' then raise; end if;
end
$$;

-- Self-service reassignment would leave the matching Auth identity banned. It must be one atomic,
-- platform-operated recovery instead of a product-owner action that creates a half-active account.
do $$
begin
  perform public.manage_profile_access(
    '2a390000-0000-4000-8000-000000000002', 'office', true, null, 'P39 reassign');
  raise exception 'P39 retired persona assertion failed: retired identity was reassigned in product';
exception when sqlstate '42501' then
  if sqlerrm <> 'retired_identity_requires_platform_reactivation' then raise; end if;
end
$$;

select pg_temp.p39_assert(
  (select role = 'kitchen' and not active from public.profiles
   where id = '2a390000-0000-4000-8000-000000000002'),
  'a rejected reassignment changed the historical profile');

do $$
begin
  perform public.create_invitation('kitchen-p39@example.test', 'kitchen');
  raise exception 'P39 retired persona assertion failed: kitchen invitation was created';
exception when sqlstate '42501' then
  if sqlerrm <> 'account_role_retired' then raise; end if;
end
$$;

do $$
begin
  perform public.create_invitation('payer-p39@example.test', 'payer');
  raise exception 'P39 retired persona assertion failed: payer invitation was created';
exception when sqlstate '42501' then
  if sqlerrm <> 'account_role_retired' then raise; end if;
end
$$;

do $$
begin
  perform public.create_invitation(
    'supplier-p39@example.test', 'supplier', '3a390000-0000-4000-8000-000000000001');
  raise exception 'P39 retired persona assertion failed: supplier invitation was created';
exception when sqlstate '42501' then
  if sqlerrm <> 'account_role_retired' then raise; end if;
end
$$;

do $$
begin
  perform public.resend_invitation('4a390000-0000-4000-8000-000000000001');
  raise exception 'P39 retired persona assertion failed: retired invitation was resent';
exception when sqlstate '42501' then
  if sqlerrm <> 'account_role_retired' then raise; end if;
end
$$;

-- The three live roles still use the same invitation/profile machinery.
select pg_temp.p39_assert(
  (public.create_invitation('office-new-p39@example.test', 'office') ->> 'role') = 'office',
  'an active office invitation stopped working');

reset role;
rollback;
