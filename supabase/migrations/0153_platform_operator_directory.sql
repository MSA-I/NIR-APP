-- 0153 -- The operator directory: who "our side" is, so the account owner can be chosen rather
-- than typed as a UUID.
--
-- Shape: `customer_accounts.internal_owner` (0152) references auth.users, because an operator
-- need not be a member of any tenant and a `profiles` reference would be unfillable for exactly
-- the people that column is about. auth.users is not readable from the browser, and it must not
-- become readable -- it holds every customer's identity, not only ours. This returns the strict
-- intersection that IS ours: rows of `platform_admins`, joined to their email and the roles they
-- hold. Nobody outside the operator roster appears, so choosing an account owner cannot become a
-- directory of the tenants' users.
--
-- Same read contract as the rest of the console (0006:152): a caller who is not an authorised
-- operator gets zero rows rather than an error, so this is not an oracle for platform membership.
--
-- What this deliberately does not cover: no write path. Membership and role assignment stay
-- out-of-band for the reason 0006:27-31 gives, and this file does not weaken that by one row.

create or replace function public.platform_operators()
returns table (user_id uuid, email text, note text, roles text[])
language sql stable security definer set search_path = public as $$
  select roster.user_id,
         account.email::text,
         roster.note,
         coalesce((
           select array_agg(assignment.role_key order by assignment.role_key)
           from platform_admin_roles assignment
           where assignment.user_id = roster.user_id
         ), '{}'::text[])
  from platform_admins roster
  join auth.users account on account.id = roster.user_id
  where is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by account.email
$$;
revoke all on function public.platform_operators() from public, anon;
grant execute on function public.platform_operators() to authenticated;

comment on function public.platform_operators() is
  'The platform operator roster with emails and roles (0153). Strictly the platform_admins '
  'intersection of auth.users, so picking an internal account owner never becomes a directory '
  'of tenant users. Read-only; assignment stays out-of-band.';

do $assert_0153$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0153 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0153$;

do $anchor_0153$
begin
  -- No JWT subject here, so the directory must be empty. A read door that answered during a
  -- migration would answer for anon at runtime.
  if exists (select 1 from public.platform_operators()) then
    raise exception '0153: platform_operators returned rows with no JWT subject -- it must fail closed';
  end if;
end
$anchor_0153$;
