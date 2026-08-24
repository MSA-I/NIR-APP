-- 0205 -- A Google identity may become an owner of a new organization, and nothing else.
--
-- Owner decision 24.08.2026: sign-up with Google is offered to the person creating an
-- organization -- the owner -- and only to them. An employee arrives through an invitation and a
-- password, as they always have.
--
-- The rule cannot live in the browser. Enabling the provider at the project level makes
-- `/auth/v1/authorize?provider=google` reachable by anyone on the internet, so "we did not draw a
-- Google button on the invitation screen" is a statement about our UI, not about who can do what.
-- Two server-side facts carry it instead:
--
--   1. The invitation command refuses a Google-authenticated caller BY NAME. That is this file.
--   2. The only path that turns a Google session into a profile creates `owner` of a NEW
--      organization and refuses a caller who already has a profile. That is public-signup's
--      Google branch, which holds the service key and never joins an existing tenant.
--
-- What this file deliberately does NOT do: block a Google sign-in. A stranger who authenticates
-- with Google and was never invited ends up with a session and no profile, which every RLS policy
-- in this database already treats as nothing -- `auth_org()` has no row to resolve. Refusing the
-- session would need a hook this project does not have; refusing the two commands that grant
-- standing is the same guarantee at the boundary that actually decides.

-- ===== 1. Which identity provider issued the caller's session =====
create or replace function private.auth_identity_provider()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- `app_metadata.provider` is written by GoTrue, never by the user: `user_metadata` is
  -- self-asserted and must not be read for an authorization decision. A session with no claim at
  -- all returns null, and every caller below treats null as "not password", never as "trusted".
  select nullif(trim(coalesce(
    auth.jwt() -> 'app_metadata' ->> 'provider',
    ''
  )), '')
$$;

revoke all on function private.auth_identity_provider() from public, anon;
grant execute on function private.auth_identity_provider() to authenticated, service_role;

comment on function private.auth_identity_provider() is
  'The provider that issued the current session, from app_metadata (GoTrue-written, not '
  'user-settable). Null when the claim is absent. 0205: used to keep a federated identity out of '
  'the invitation path, which is a password path by owner decision 24.08.2026.';

-- ===== 2. The invitation path is a password path =====
do $patch_invitation_identity$
declare
  v_signature regprocedure := 'public.accept_invitation(text,text,text,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text := $anchor$  if v_version is null then
    raise exception 'terms_consent_required' using errcode = '22023';
  end if;$anchor$;
  v_replacement text := $replacement$  if v_version is null then
    raise exception 'terms_consent_required' using errcode = '22023';
  end if;

  -- Owner decision 24.08.2026: an invitation is accepted with a password. A federated identity
  -- may only ever be the owner of an organization it created, so it cannot be talked into
  -- joining an existing one -- not through the screen, and not by calling this command directly.
  if coalesce(private.auth_identity_provider(), 'email') <> 'email' then
    raise exception 'invite_requires_password_identity' using errcode = '42501';
  end if;$replacement$;
begin
  -- The sentinel is what this patch CREATES, never a string that also occurs in what it reads.
  if position('invite_requires_password_identity' in v_definition) > 0 then
    raise exception '0205: accept_invitation identity guard already applied';
  end if;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0205: accept_invitation terms anchor moved';
  end if;
  -- 0089 put the consent record in this wrapper. Refusing to patch a body that lost it keeps the
  -- two from drifting apart silently.
  if position('terms_accepted' in v_definition) = 0 then
    raise exception '0205: refusing to patch accept_invitation without its 0089 consent ancestry';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_invitation_identity$;

-- ===== 3. Does this user already have standing anywhere =====
-- public-signup's Google branch asks this before it creates anything. It holds the service key,
-- so it could read `profiles` directly; a named function keeps the question -- and its answer for
-- a soft-deleted or inactive row -- in one place instead of in an Edge function's WHERE clause.
create or replace function public.service_identity_has_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles where id = p_user_id)
$$;

revoke all on function public.service_identity_has_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.service_identity_has_profile(uuid) to service_role;

comment on function public.service_identity_has_profile(uuid) is
  'Whether an auth user already belongs to any organization, active or not. 0205: the Google '
  'owner sign-up refuses a caller that already has standing, so the federated path can create a '
  'new tenant and can never be used to attach a second profile to an existing one.';

do $$
declare v_violations text; v_definition text;
begin
  select pg_get_functiondef('public.accept_invitation(text,text,text,text)'::regprocedure)
    into v_definition;
  if position('invite_requires_password_identity' in v_definition) = 0 then
    raise exception '0205: the invitation identity guard did not survive the patch';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0205 scope assertions failed:\n%',v_violations;
  end if;
end
$$;
