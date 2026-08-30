-- 0250 -- Inviting an operator, without inventing a business for them.
--
-- THE HOLE 0249 LEFT, stated plainly because it is the reason this file exists: the roster gained
-- a write path, but `platform_add_operator` grants authority to an identity that ALREADY EXISTS,
-- deliberately — so that the console never becomes a second, weaker signup. And the product's
-- only self-service signup CREATES AN ORGANIZATION (`public-signup`), because the person who
-- signs up is the owner of the business they just registered. A colleague joining our own team
-- therefore had no door at all: either somebody minted their identity by hand in Supabase, or
-- they signed up and left a ghost organization behind them.
--
-- This is the tenant invitation flow (0007) re-cut for the platform axis, and the differences
-- are the whole point:
--   * no `org_id` — the invitee is joining US, not a customer;
--   * `platform_roles`, not `user_role` — a different axis of authority entirely;
--   * acceptance writes `platform_admins`, never `profiles`, so an operator still holds no
--     tenant membership unless somebody deliberately gives them one;
--   * fifteen minutes, not days (owner decision, 28.08.2026). See the window's own note below.

-- ===== 1. The invitation =====
create table platform_operator_invitations (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  role_key     text not null references platform_roles(role_key) on delete restrict,
  -- sha256 hex of the raw token, exactly as `invitations.token_hash` (0007:38). The raw token is
  -- returned to the inviter ONCE, by the command, and is never stored anywhere.
  token_hash   text not null,
  expires_at   timestamptz not null,
  invited_by   uuid references auth.users(id) on delete set null,
  reason       text not null check (length(btrim(reason)) > 0),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz,
  revoked_by   uuid references auth.users(id) on delete set null,
  constraint platform_operator_invitations_email_shape
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint platform_operator_invitations_email_lower check (email = lower(email))
);

-- One live invitation per address. The predicate is repeated verbatim in the command's
-- ON CONFLICT clause — a partial unique index only arbitrates a conflict when the two match.
create unique index platform_operator_invitations_pending_email_idx
  on platform_operator_invitations (email)
  where accepted_at is null and revoked_at is null;
create index platform_operator_invitations_created_idx
  on platform_operator_invitations (created_at desc);

alter table platform_operator_invitations enable row level security;
-- RLS on with zero policies denies every row to every non-superuser caller, and the revoke says
-- it twice. The definer commands below are the only doors. In particular the token hash never
-- leaves the database: not one read function returns it.
revoke all on table platform_operator_invitations from public, anon, authenticated;

comment on table platform_operator_invitations is
  'Pending and historical invitations to join the platform operator roster (0250). No org_id: '
  'the invitee is joining the vendor, not a customer, and acceptance writes platform_admins '
  'rather than profiles.';

-- ===== 2. The window =====
-- Fifteen minutes, owner decision (28.08.2026). Recorded as a function rather than as a literal
-- in three places, because a window that disagrees with itself between the command, the lookup
-- and the screen is the kind of bug nobody reproduces.
--
-- What the number costs, so the next reader does not have to rediscover it: fifteen minutes is
-- shorter than mail delivery is reliable. That is survivable HERE only because the invitation is
-- handed over as a link the inviter copies — the same handover the console already does for a new
-- organization's credentials (`Admin.tsx`) — and not mailed. Wiring email delivery later means
-- revisiting this number first, not after.
create or replace function private.platform_invitation_window() returns interval
language sql immutable set search_path = public as $$ select interval '15 minutes' $$;
revoke all on function private.platform_invitation_window() from public, anon, authenticated;

-- ===== 3. Issuing =====
create or replace function public.platform_invite_operator(
  p_email    text,
  p_role_key text,
  p_reason   text
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := private.assert_platform_staff_command('operator.manage', p_reason);
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_raw     text;
  v_expires timestamptz;
  v_id      uuid;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_role_key is null or not exists (
    select 1 from platform_roles r where r.role_key = p_role_key
  ) then
    raise exception 'platform_role_unknown' using errcode = 'P0002';
  end if;
  -- Already one of us: an invitation would either be a no-op or a second, quieter way to change
  -- somebody's authority. Changing it is `platform_set_operator_roles`, and it says so.
  if exists (
    select 1 from platform_admins roster
    join auth.users account on account.id = roster.user_id
    where lower(account.email) = v_email
  ) then
    raise exception 'operator_already_exists' using errcode = '23505';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + private.platform_invitation_window();

  insert into platform_operator_invitations (email, role_key, token_hash, expires_at, invited_by, reason)
  values (v_email, p_role_key, encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'), v_expires, v_actor, v_reason)
  on conflict (email) where accepted_at is null and revoked_at is null
  do update set role_key   = excluded.role_key,
                token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                invited_by = excluded.invited_by,
                reason     = excluded.reason,
                created_at = now()
  returning id into v_id;

  perform private.record_platform_admin_event(
    v_actor, null, 'operator_invited', null,
    jsonb_build_object('email', v_email, 'role', p_role_key, 'expires_at', v_expires),
    v_reason);

  -- The raw token leaves the database exactly here, exactly once. A later read of this row can
  -- never reproduce it: only its sha256 was stored.
  return jsonb_build_object('id', v_id, 'email', v_email, 'token', v_raw, 'expires_at', v_expires);
end
$$;
revoke all on function public.platform_invite_operator(text, text, text) from public, anon;
grant execute on function public.platform_invite_operator(text, text, text) to authenticated;

create or replace function public.platform_revoke_operator_invitation(
  p_id     uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_staff_command('operator.manage', p_reason);
  v_email  text;
begin
  update platform_operator_invitations
     set revoked_at = now(), revoked_by = v_actor
   where id = p_id and accepted_at is null and revoked_at is null
  returning email into v_email;
  if v_email is null then
    raise exception 'invitation_not_pending' using errcode = 'P0002';
  end if;

  perform private.record_platform_admin_event(
    v_actor, null, 'operator_invitation_revoked',
    jsonb_build_object('email', v_email), null, v_reason);

  return jsonb_build_object('id', p_id, 'email', v_email);
end
$$;
revoke all on function public.platform_revoke_operator_invitation(uuid, text) from public, anon;
grant execute on function public.platform_revoke_operator_invitation(uuid, text) to authenticated;

-- ===== 4. Reading the queue =====
-- Same audience as `platform_operators()` (0153): who holds authority — and who is about to —
-- is part of operating the platform. The token hash is not in the projection.
create or replace function public.platform_operator_invitations()
returns table (
  id           uuid,
  email        text,
  role_key     text,
  role_label   text,
  status       text,
  expires_at   timestamptz,
  created_at   timestamptz,
  invited_by   text
)
language sql stable security definer set search_path = public as $$
  select
    invitation.id,
    invitation.email,
    invitation.role_key,
    role.label,
    case when invitation.revoked_at  is not null then 'revoked'
         when invitation.accepted_at is not null then 'accepted'
         when invitation.expires_at <= now()     then 'expired'
         else 'pending' end,
    invitation.expires_at,
    invitation.created_at,
    inviter.email::text
  from platform_operator_invitations invitation
  join platform_roles role on role.role_key = invitation.role_key
  left join auth.users inviter on inviter.id = invitation.invited_by
  where is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by invitation.created_at desc
$$;
revoke all on function public.platform_operator_invitations() from public, anon;
grant execute on function public.platform_operator_invitations() to authenticated;

-- ===== 5. The invitee's two calls =====
-- Anonymous by necessity: the person holding this link has no account yet, and the screen must be
-- able to say "this invitation expired" instead of a blank form. It answers `unknown` for a
-- malformed or unmatched token, so it is not an oracle for which addresses we invited.
create or replace function public.lookup_platform_operator_invitation(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
  invitation platform_operator_invitations;
  v_label    text;
begin
  if p_token is null or length(p_token) <> 64 then
    return jsonb_build_object('status', 'unknown');
  end if;
  select * into invitation from platform_operator_invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('status', 'unknown'); end if;

  select label into v_label from platform_roles where role_key = invitation.role_key;

  return jsonb_build_object(
    'status', case when invitation.revoked_at  is not null then 'revoked'
                   when invitation.accepted_at is not null then 'accepted'
                   when invitation.expires_at <= now()     then 'expired'
                   else 'valid' end,
    'email', invitation.email,
    'role_key', invitation.role_key,
    'role_label', v_label,
    'expires_at', invitation.expires_at);
end
$$;
revoke all on function public.lookup_platform_operator_invitation(text) from public;
grant execute on function public.lookup_platform_operator_invitation(text) to anon, authenticated;

-- The one privileged write in the flow. The caller already has a session — the accept screen
-- signs them up first, exactly as `AcceptInvite` does on the tenant side — and this turns that
-- session into platform authority. It writes `platform_admins`, never `profiles`: an operator is
-- not a member of any organization, and this is the door that must not quietly make them one.
create or replace function public.accept_platform_operator_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text;
  invitation   platform_operator_invitations;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) <> 64 then
    raise exception 'invitation_unknown' using errcode = 'P0002';
  end if;

  select lower(account.email) into v_email from auth.users account where account.id = v_actor;

  select * into invitation from platform_operator_invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if invitation.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0002';
  end if;
  if invitation.accepted_at is not null then
    raise exception 'invitation_already_accepted' using errcode = '23505';
  end if;
  if invitation.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0002';
  end if;
  -- The link proves nothing about WHO is holding it; the address does. A token that could be
  -- redeemed by any signed-in account would be a way to hand our own authority to a stranger.
  if v_email is distinct from invitation.email then
    raise exception 'invitation_email_mismatch' using errcode = '42501';
  end if;

  insert into platform_admins (user_id, note)
  values (v_actor, 'Joined by invitation ' || invitation.id::text)
  on conflict (user_id) do nothing;
  insert into platform_admin_roles (user_id, role_key, granted_note)
  values (v_actor, invitation.role_key, 'Accepted invitation ' || invitation.id::text)
  on conflict (user_id, role_key) do nothing;

  update platform_operator_invitations
     set accepted_at = now(), accepted_by = v_actor
   where id = invitation.id;

  perform private.record_platform_admin_event(
    invitation.invited_by, v_actor, 'operator_invitation_accepted', null,
    jsonb_build_object('email', invitation.email, 'role', invitation.role_key),
    invitation.reason);

  return jsonb_build_object('role_key', invitation.role_key);
end
$$;
revoke all on function public.accept_platform_operator_invitation(text) from public, anon;
grant execute on function public.accept_platform_operator_invitation(text) to authenticated;

-- ===== 6. Registry duties (A1) =====
-- 'system', the class every operator-machinery table carries: cross-tenant, never scope-enforced,
-- and no org_id, so A6 (the tenant export contract) does not apply — an invitation to join OUR
-- team is not a tenant's row.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('platform_operator_invitations', 'system', false);

-- ===== 7. Structural re-assertion (the 0058:207-218 idiom) =====
do $assert_0250$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0250 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0250$;

-- ===== 8. Anchors =====
do $anchor_0250$
begin
  if private.platform_invitation_window() <> interval '15 minutes' then
    raise exception '0250: the invitation window is not the fifteen minutes the owner decided';
  end if;

  -- No JWT subject here, so every door must be shut. A definer that answered during a migration
  -- would answer for anon at runtime.
  if exists (select 1 from public.platform_operator_invitations()) then
    raise exception '0250: the invitation queue answered with no JWT subject';
  end if;
  if (public.lookup_platform_operator_invitation(repeat('a', 64)) ->> 'status') <> 'unknown' then
    raise exception '0250: an unmatched token did not answer unknown';
  end if;
  if (public.lookup_platform_operator_invitation(null) ->> 'status') <> 'unknown' then
    raise exception '0250: a null token did not answer unknown';
  end if;
end
$anchor_0250$;
