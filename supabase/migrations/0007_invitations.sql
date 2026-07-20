-- Employee invitations -- an org owner invites their own staff.
--
-- Until now a user could only be created by hand in the Supabase dashboard plus a matching
-- profiles row (OPEN-DECISIONS.md row 12). That does not scale past one customer.
--
-- Two separate things live here:
--   (1) the `invitations` table + RLS, readable only by the owner of its own org;
--   (2) five security definer functions, because the interesting half of the flow happens
--       BEFORE the invitee has a profile -- auth_org() and auth_role() are both null then,
--       so ordinary RLS has nothing to filter on. Same idiom as 0001_init.sql:42-47 and
--       0002_payer_execution.sql:12-35.
--
-- TOKEN SECURITY
--   The row stores sha256(token), never the token. A readable invitations row is therefore
--   not enough to accept an invitation -- an attacker would have to invert sha256 over 32
--   bytes of CSPRNG output. The raw token is returned exactly once, to the caller that will
--   put it in the email link, and is never persisted, logged, or re-derivable.
--   Consequence: a lost link cannot be recovered, only re-issued (resend rotates the token,
--   which also kills the old link -- the safer default).
--
-- PRIVILEGE ESCALATION
--   org_id is never a parameter: create_invitation pins it to auth_org() of the caller.
--   accept_invitation reads org_id and role off the invitation ROW, never off its arguments,
--   so the invitee cannot promote themselves or land in another tenant. The `supplier` role
--   is refused by a table CHECK, not only by the UI -- a supplier agent profile needs a
--   supplier_id (0004) that this flow has no way to supply.

-- gen_random_bytes lives in pgcrypto. sha256() is a builtin (PG 11+), so no extension needed
-- for the hashing itself. If pgcrypto already exists elsewhere this is a no-op.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  email text not null,
  role user_role not null,
  token_hash text not null,               -- sha256 hex of the raw token; not sensitive on its own
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references profiles(id),
  revoked_at timestamptz,                 -- soft-cancel, per the project's soft-delete convention
  revoked_by uuid references profiles(id),
  invited_by uuid references profiles(id),
  last_sent_at timestamptz not null default now(),
  send_count int not null default 1,
  created_at timestamptz not null default now(),
  constraint invitations_role_invitable check (role <> 'supplier')
);

-- org_id needs a LEADING index or the self-check at the end of 0005 fails.
create index invitations_org_idx on invitations (org_id);
create unique index invitations_token_hash_idx on invitations (token_hash);

-- At most one live invitation per address per org. Re-inviting the same person rotates the
-- existing row instead of littering the table with dead tokens.
create unique index invitations_pending_uniq on invitations (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ===== Expiry =====
-- 7 days is the default; overridable per org so it stays a configuration value rather than a
-- number buried in a function body (OPEN-DECISIONS.md).
create or replace function invitation_expiry_days(p_org uuid) returns int
language sql stable set search_path = public as
$$ select coalesce(nullif(o.settings->>'invite_expiry_days', '')::int, 7)
   from organizations o where o.id = p_org $$;

-- ===== Owner-side: issue / resend / revoke =====

-- Returns the raw token to its caller (the send-invite Edge Function) exactly once.
create or replace function create_invitation(p_email text, p_role user_role)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org     uuid := auth_org();
  v_actor   user_role := auth_role();
  v_email   text := lower(trim(p_email));
  v_raw     text;
  v_expires timestamptz;
  v_id      uuid;
  v_name    text;
begin
  if v_org is null or v_actor <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_role = 'supplier' then
    raise exception 'role_not_invitable' using errcode = '42501';
  end if;
  -- already a member of this org? re-inviting would be a no-op at best
  if exists (select 1 from profiles p join auth.users u on u.id = p.id
             where p.org_id = v_org and lower(u.email) = v_email) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));

  insert into invitations (org_id, email, role, token_hash, expires_at, invited_by)
  values (v_org, v_email, p_role, encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'), v_expires, auth.uid())
  on conflict (org_id, lower(email)) where accepted_at is null and revoked_at is null
  do update set role       = excluded.role,
                token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                invited_by = excluded.invited_by,
                last_sent_at = now(),
                send_count = invitations.send_count + 1
  returning id into v_id;

  select o.name into v_name from organizations o where o.id = v_org;

  return jsonb_build_object(
    'invitation_id', v_id, 'token', v_raw, 'email', v_email,
    'role', p_role, 'org_name', v_name, 'expires_at', v_expires);
end $$;

-- Rotates the token: the previously emailed link stops working.
create or replace function resend_invitation(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org     uuid := auth_org();
  v_actor   user_role := auth_role();
  inv       invitations;
  v_raw     text;
  v_expires timestamptz;
  v_name    text;
begin
  if v_org is null or v_actor <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  select * into inv from invitations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;
  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));

  update invitations
     set token_hash   = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
         expires_at   = v_expires,
         last_sent_at = now(),
         send_count   = send_count + 1
   where id = inv.id;

  select o.name into v_name from organizations o where o.id = v_org;

  return jsonb_build_object(
    'invitation_id', inv.id, 'token', v_raw, 'email', inv.email,
    'role', inv.role, 'org_name', v_name, 'expires_at', v_expires);
end $$;

-- Soft-cancel. The reason is recorded app-side via src/lib/audit.ts (logAction).
create or replace function revoke_invitation(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org   uuid := auth_org();
  v_actor user_role := auth_role();
  inv     invitations;
begin
  if v_org is null or v_actor <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  select * into inv from invitations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;

  update invitations set revoked_at = now(), revoked_by = auth.uid()
   where id = inv.id and revoked_at is null;
end $$;

-- ===== Invitee side: happens before a profile exists =====

-- Callable by anon: the token IS the authorisation. Returns nothing without a correct one,
-- and 32 random bytes make enumeration pointless.
create or replace function lookup_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare inv invitations; v_name text; v_labels jsonb;
begin
  if p_token is null or length(p_token) <> 64 then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into inv from invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('status', 'unknown'); end if;

  -- role_labels comes along because the accept screen has to name the invitee's role before
  -- they have a session, so useAuth().roleLabels cannot help it. Without this a tenant that
  -- renamed 'kitchen' would still greet its new hire as "מנהל מטבח".
  select o.name, o.settings->'role_labels' into v_name, v_labels
    from organizations o where o.id = inv.org_id;

  return jsonb_build_object(
    'status', case when inv.revoked_at  is not null then 'revoked'
                   when inv.accepted_at is not null then 'accepted'
                   when inv.expires_at <= now()     then 'expired'
                   else 'valid' end,
    'email', inv.email, 'role', inv.role, 'org_name', v_name,
    'role_labels', v_labels, 'expires_at', inv.expires_at);
end $$;

-- The one privileged write in the flow: creates the profiles row for a caller who has an auth
-- user but no profile yet. org_id and role are read off the invitation, never off the
-- arguments, so nothing here can be steered by the invitee.
create or replace function accept_invitation(p_token text, p_full_name text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  inv     invitations;
  v_uid   uuid := auth.uid();
  v_email text := lower(auth.jwt() ->> 'email');
  v_name  text := trim(coalesce(p_full_name, ''));
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if v_name = ''    then raise exception 'full_name_required' using errcode = '22023'; end if;
  if p_token is null or length(p_token) <> 64 then
    raise exception 'invitation_unknown' using errcode = 'P0002';
  end if;

  select * into inv from invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;

  if not found                        then raise exception 'invitation_unknown'  using errcode = 'P0002'; end if;
  if inv.revoked_at  is not null      then raise exception 'invitation_revoked'  using errcode = 'P0002'; end if;
  if inv.accepted_at is not null      then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;
  if inv.expires_at <= now()          then raise exception 'invitation_expired'  using errcode = 'P0002'; end if;
  -- the signed-in account must be the address the invitation was sent to
  if v_email is null or v_email <> inv.email then
    raise exception 'email_mismatch' using errcode = '42501';
  end if;
  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'profile_exists' using errcode = '23505';
  end if;
  -- Suspension has to be re-checked here explicitly. Everywhere else in the system it is
  -- enforced by auth_org() returning null for a suspended org (0006), but this function
  -- deliberately does NOT consult auth_org() -- the invitee has no profile yet, so it would
  -- be null for an entirely different reason. Without this line an invitation issued before
  -- suspension could still be redeemed after it, quietly adding a member to a frozen tenant.
  if exists (select 1 from organizations o where o.id = inv.org_id and o.status = 'suspended') then
    raise exception 'org_suspended' using errcode = 'P0002';
  end if;

  insert into profiles (id, org_id, full_name, role, phone, active)
  values (v_uid, inv.org_id, v_name, inv.role, nullif(trim(coalesce(p_phone, '')), ''), true);

  update invitations set accepted_at = now(), accepted_by = v_uid where id = inv.id;

  -- logged here rather than app-side: at this instant the client has no profile, so the
  -- audit_insert policy (org_id = auth_org()) could not have passed.
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (inv.org_id, v_uid, 'invitation_accepted', 'invitations', inv.id,
          jsonb_build_object('email', inv.email, 'role', inv.role),
          'קבלת הזמנה והצטרפות לארגון');

  return jsonb_build_object('org_id', inv.org_id, 'role', inv.role);
end $$;

-- ===== Grants =====
revoke all on function create_invitation(text, user_role) from public;
revoke all on function resend_invitation(uuid)            from public;
revoke all on function revoke_invitation(uuid)            from public;
revoke all on function lookup_invitation(text)            from public;
revoke all on function accept_invitation(text, text, text) from public;

grant execute on function create_invitation(text, user_role)  to authenticated;
grant execute on function resend_invitation(uuid)             to authenticated;
grant execute on function revoke_invitation(uuid)             to authenticated;
grant execute on function lookup_invitation(text)             to anon, authenticated;
grant execute on function accept_invitation(text, text, text) to authenticated;

-- ===== RLS =====
-- Read-only for the owner of the row's own org. There is deliberately no insert/update/delete
-- policy: every mutation goes through the functions above, which is what keeps org_id pinned
-- and the role whitelist enforceable in one place.
alter table invitations enable row level security;

create policy invitations_owner_select on invitations for select
  using (org_id = auth_org() and auth_role() = 'owner');

-- ===== Self-check: same invariant 0005 ends with =====
do $$
declare missing text;
begin
  select string_agg(c.table_name, ', ')
    into missing
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.column_name = 'org_id'
    and not exists (
      select 1 from pg_index i
      join pg_class t    on t.oid = i.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where t.relname = c.table_name and a.attname = 'org_id');

  if missing is not null then
    raise exception 'org_id has no leading index on: %', missing;
  end if;
end $$;
