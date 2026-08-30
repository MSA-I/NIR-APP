-- 0255 -- a second address to reach the owner at, before the first one can stop existing.
--
-- OWNER DECISION #270 (`require-backup-email`): a VERIFIED alternate address, so the owner's mail
-- channel does not disappear with the address they signed up with. It is a prerequisite for
-- switching Sign in with Apple on, and the owner attached two rulings to it that bound everything
-- below:
--
--   1. THE REQUIREMENT IS ABOUT THE ADDRESS, NOT ABOUT THE PROVIDER. Only an Apple Private Relay
--      forwarding address is asked for a second one. It is the only address in the product that a
--      third party can switch off while the account keeps working: the person turns forwarding off
--      in their Apple ID settings, and every mail we send afterwards is accepted and discarded. A
--      password signup, and a federated signup that handed over a real mailbox, are asked for
--      nothing. The detection itself lives in `src/lib/backupEmail.ts`, read by both the browser
--      and `public-signup`, because it decides what a FORM shows; this file holds what the
--      database will accept, which is the half that survives someone calling the API directly.
--
--   2. BUILT NOW, ENFORCED WHEN APPLE IS SWITCHED ON. Nothing in this migration refuses a signup.
--      `inplace.digital` is not DNS-verified and Resend is in sandbox (`DEBT §25`), so a
--      verification mail to a customer's own mailbox is accepted by the API and never delivered --
--      the code already measures that as `deliveryLimited`. A hard requirement shipped ON today
--      would make signup unreachable for every real customer. So the challenge machinery exists,
--      is closed, and is exercised by nothing in the product until delivery does.
--
-- WHY THE VERIFICATION STAMP IS NOT A COLUMN ON `profiles`.
-- The obvious shape is `backup_email` plus `backup_email_verified_at` side by side. It was not
-- taken, and the reason is the guard this migration has to open anyway: a stored "this address is
-- verified" flag is a claim the browser must NEVER be able to write, which means the same table
-- would carry one column inside the browser-writable allow-list and one that needs a second
-- writer handshake threaded through `profiles_guard_privileged_columns` -- a function that already
-- carries one (0020) and has already been rewritten twice (0006 -> 0020 -> 0249). The proof lives
-- in the table that HOLDS the proof instead, `public.my_backup_email()` answers the question in
-- one indexed lookup, and re-nominating an address that was verified before is verified again by
-- construction rather than by a trigger somebody has to remember.
--
-- MODELLED ON 0250, which is the closest analogue in the repository: sha256 of a raw token that is
-- returned exactly once and never stored, an explicit expiry, a mandatory reason, email shape and
-- lowercase CHECKs, and RLS enabled with ZERO policies plus `revoke all` so the definer commands
-- are the only doors and the token hash never leaves the database.

-- ===== 1. The nominated address =====
alter table profiles
  add column if not exists backup_email text;

alter table profiles drop constraint if exists profiles_backup_email_shape;
alter table profiles add constraint profiles_backup_email_shape
  check (backup_email is null or (
    backup_email = lower(backup_email)
    and length(backup_email) <= 320
    and backup_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

comment on column profiles.backup_email is
  'A second address this person can be reached at, nominated by them (owner decision #270). '
  'Nomination is NOT proof: the address counts as verified only while a row in '
  'profile_backup_email_verifications carries the same address with verified_at set. Self-service, '
  'like phone and locale -- writable by the person themselves through profiles_self_update and '
  'listed in profiles_guard_privileged_columns'' browser-writable allow-list. Grants nothing.';

-- ===== 2. Gate one: 0020's column guard =====
-- `profiles_guard_privileged_columns` states its own rule -- "A future profile column is
-- privileged by default" -- and enforces it by diffing the whole row minus an allow-list. So
-- `backup_email` is UNWRITABLE from the browser the moment it exists, and a client
-- `update profiles set backup_email = ...` raises `profiles_column_not_browser_writable`.
--
-- It joins the allow-list on the same terms `locale` did in 0253: it is genuinely self-service, it
-- grants nothing, it is bounded by a check constraint, and it is already reachable through
-- `profiles_self_update` (0020:12), scoped to `id = auth.uid() and org_id = auth_org()`. What it
-- does NOT join is the `v_access_change` branch: nominating a second address is not an access
-- change, must not demand owner, and must not go through `manage_profile_access`.
--
-- ANCHORED REPLACEMENT (the 0137/0145/0148/0168/0207/0253 pattern): read the LIVE definition,
-- normalise \r, replace, and fail loudly if the anchor moved. This one DERIVES its anchor with a
-- regexp instead of pasting 0253's literal, which is a deliberate departure: the allow-list has
-- gained a member twice already, the prose beside it counts the members out loud, and a literal
-- anchor makes every future column-adding migration a merge conflict with this one. The loudness
-- is kept -- an anchor that matches zero or three times still aborts.
do $backup_email_guard$
declare
  v_def         text;
  v_array_old   text;
  v_array_new   text;
  v_self_fields text;
  v_hits        int;
begin
  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');

  -- Idempotent: a re-apply, or a later migration that already added the column, must not fail.
  if position('''backup_email''' in v_def) = 0 then

    -- (1) The allow-list itself. It appears twice -- once for `new`, once for `old` -- and both
    -- must move together, because a difference between the two would make the diff always true.
    v_array_old := (regexp_match(v_def, 'array\[''full_name''[^\]]*\]'))[1];
    if v_array_old is null then
      raise exception '0255: the browser-writable allow-list is no longer an array literal '
        'beginning with ''full_name'' in profiles_guard_privileged_columns -- the guard was '
        'rewritten and this replacement must be re-read against the live body, not forced';
    end if;
    v_hits := (length(v_def) - length(replace(v_def, v_array_old, ''))) / length(v_array_old);
    if v_hits <> 2 then
      raise exception '0255: expected the browser-writable allow-list twice in '
        'profiles_guard_privileged_columns, found % -- the guard was rewritten and this '
        'replacement must be re-read against the live body, not forced', v_hits;
    end if;
    v_array_new := left(v_array_old, length(v_array_old) - 1) || ', ''backup_email'']';
    v_def := replace(v_def, v_array_old, v_array_new);

    -- (2) The prose that counts the fields. 0253 learned this the expensive way: the next reader
    -- trusts the comment before they trust the array, so a body that describes a rule it no
    -- longer implements is worse than no comment. Derived from the array just built rather than
    -- typed, so the sentence cannot disagree with the code three lines below it.
    select string_agg(btrim(field, ''''), ', ' order by ord)
      into v_self_fields
    from unnest(string_to_array(
           replace(replace(v_array_new, 'array[', ''), ']', ''), ', ')
         ) with ordinality as listed(field, ord)
    where btrim(field, '''') not in ('role', 'active', 'supplier_id');

    v_hits := (select count(*)::int from regexp_matches(
      v_def, 'Browser writers may only touch the', 'g'));
    if v_hits <> 1 then
      raise exception '0255: expected the allow-list comment once, found % -- re-read the live body',
        v_hits;
    end if;

    -- `\1` and `\2` are backreferences and must stay OUT of the E-string: inside one, `\2` is an
    -- octal escape and would put a control character into the function body instead of the tail
    -- it is standing in for.
    v_def := regexp_replace(
      v_def,
      '(Browser writers may only touch the).*?(access fields owned by manage_profile_access\(\)\.)',
      '\1' || e'\n  -- self-service fields (' || v_self_fields
            || ' -- none of which grant anything) plus the three ' || '\2');

    -- The derived list, not the boilerplate around it: the surrounding sentence is already in the
    -- live body, so asserting on it would pass whether or not the replacement took.
    if position(v_self_fields in v_def) = 0 then
      raise exception '0255: the allow-list comment still does not name [%] -- the replacement did '
        'not take and the body would describe a rule it no longer implements', v_self_fields;
    end if;

    execute v_def;
  end if;
end
$backup_email_guard$;

-- ===== 3. Gate two: 0042's column ACL =====
-- The gate that is easy to miss, and the one 0253 shipped half-saved without. 0042 revokes UPDATE
-- on every column of `profiles` and grants it back to a named few, so a new column is closed TWICE
-- over -- once by the trigger above, once by the ACL -- and satisfying only the trigger produces a
-- write that fails with `42501 permission denied for table profiles` at HTTP 403 while the screen
-- looks like it worked. Additive and narrow: this grants UPDATE on `backup_email` alone.
grant update (backup_email) on table public.profiles to authenticated;

-- ===== 4. The challenge =====
create table profile_backup_email_verifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  email       text not null,
  -- sha256 hex of the raw token, exactly as `invitations.token_hash` (0007:38) and
  -- `platform_operator_invitations.token_hash` (0250:26). The raw token is returned to the caller
  -- of the request command ONCE and is never stored anywhere.
  token_hash  text not null,
  expires_at  timestamptz not null,
  reason      text not null check (length(btrim(reason)) > 0),
  created_at  timestamptz not null default now(),
  verified_at timestamptz,
  constraint profile_backup_email_verifications_email_shape
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint profile_backup_email_verifications_email_lower check (email = lower(email))
);

-- One live challenge per person. The predicate is repeated verbatim in the request command's
-- ON CONFLICT clause -- a partial unique index only arbitrates a conflict when the two match.
create unique index profile_backup_email_verifications_pending_idx
  on profile_backup_email_verifications (profile_id)
  where verified_at is null;
-- The status lookup: "is the address currently on this profile one this person has proved?"
create index profile_backup_email_verifications_profile_email_idx
  on profile_backup_email_verifications (profile_id, email);

alter table profile_backup_email_verifications enable row level security;
-- RLS on with zero policies denies every row to every non-superuser caller, and the revoke says it
-- twice. The definer commands below are the only doors. In particular the token hash never leaves
-- the database: not one read function returns it.
revoke all on table profile_backup_email_verifications from public, anon, authenticated;

-- The tenant read-only latch every org-owned table carries (0092:188-197). p22 asserts that a
-- future org-owned table cannot silently omit it; asserted again at the bottom of this file so a
-- miss costs a migration rather than a gate run.
create trigger zz_organization_write_guard
  before insert or update or delete on public.profile_backup_email_verifications
  for each row execute function private.organization_row_write_guard();

comment on table profile_backup_email_verifications is
  'Mailbox-control challenges for the backup address on profiles.backup_email (0255, owner '
  'decision #270). A row with verified_at set is the ONLY thing that makes a nominated address '
  'count as verified. Closed to the browser: the token hash is never returned by any read.';

-- ===== 5. The window =====
-- Twenty-four hours. Recorded as a function rather than as a literal in three places, because a
-- window that disagrees with itself between the command, the lookup and the screen is the kind of
-- bug nobody reproduces.
--
-- NOT 0250's fifteen minutes, and the difference is the handover. 0250 could afford a window
-- shorter than mail delivery is reliable because its link is COPIED by the inviter and handed over
-- directly; this link can only ever arrive by mail, which is exactly what fifteen minutes does not
-- survive. Twenty-four hours is a documented DEFAULT, not an owner ruling -- the owner ruled on
-- the requirement, not on its expiry -- and it is the number to revisit first when delivery is
-- wired, alongside `DEBT §25`.
create or replace function private.backup_email_verification_window() returns interval
language sql immutable set search_path = public as $$ select interval '24 hours' $$;
revoke all on function private.backup_email_verification_window() from public, anon, authenticated;

-- ===== 6. Requesting a challenge =====
-- Service-role only, and that is the security property rather than an implementation detail. The
-- person being verified IS the person asking, so handing the raw token back to their browser would
-- let them prove control of a mailbox they never opened -- the exact opposite of what the token is
-- for. 0250 can return its token to the caller because the caller is inviting SOMEBODY ELSE. Here
-- the only correct recipient is the mail server, so only a server may ask.
create or replace function public.service_request_backup_email_verification(
  p_user_id uuid,
  p_email   text,
  p_reason  text
) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_person  profiles;
  v_primary text;
  v_raw     text;
  v_expires timestamptz;
  v_id      uuid;
begin
  -- Iron rule: a sensitive action is recorded WITH a reason. A recovery channel is one.
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_email) > 320
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  select * into v_person from profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile_unknown' using errcode = 'P0002';
  end if;

  select lower(account.email) into v_primary from auth.users account where account.id = p_user_id;
  -- The two addresses that look valid and are not a backup at all: the one we are trying to
  -- survive the loss of, and another one with the same failure mode. The relay domain is spelled
  -- out again here rather than read from the bundle -- what the database accepts must not depend
  -- on a JavaScript build -- and `src/lib/backupEmail.ts` holds the other copy for the screen.
  if v_primary is not null and v_email = v_primary then
    raise exception 'backup_email_same_as_primary' using errcode = '22023';
  end if;
  if split_part(v_email, '@', 2) = 'privaterelay.appleid.com' then
    raise exception 'backup_email_is_a_relay' using errcode = '22023';
  end if;

  update profiles set backup_email = v_email where id = p_user_id;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + private.backup_email_verification_window();

  insert into profile_backup_email_verifications
    (org_id, profile_id, email, token_hash, expires_at, reason)
  values (v_person.org_id, p_user_id, v_email,
          encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'), v_expires, v_reason)
  on conflict (profile_id) where verified_at is null
  do update set email      = excluded.email,
                token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                reason     = excluded.reason,
                created_at = now()
  returning id into v_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_person.org_id, auth.uid(), 'backup_email_nominated', 'profiles', p_user_id,
    jsonb_build_object('backup_email', v_person.backup_email),
    jsonb_build_object('backup_email', v_email, 'expires_at', v_expires),
    v_reason
  );

  -- The raw token leaves the database exactly here, exactly once. A later read of this row can
  -- never reproduce it: only its sha256 was stored.
  return jsonb_build_object('id', v_id, 'email', v_email, 'token', v_raw, 'expires_at', v_expires);
end
$$;
revoke all on function public.service_request_backup_email_verification(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_request_backup_email_verification(uuid, text, text)
  to service_role;

-- ===== 7. The verify command =====
-- Callable by `anon` BY NECESSITY, not by omission. The person clicking this link arrives from
-- their mail client, and in the case the decision was written for -- a fresh signup -- they cannot
-- sign in at all yet, because their primary address is still unconfirmed. Holding the token is
-- the proof, which is what the token is; the row says whose mailbox was proved.
--
-- It ANSWERS rather than raises, the `lookup_platform_operator_invitation` shape (0250:202): a
-- malformed or unmatched token is `unknown`, so this is not an oracle for which addresses were
-- nominated, and the screen can say "this link expired" instead of showing a blank error.
create or replace function public.verify_backup_email(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  challenge profile_backup_email_verifications;
  v_current text;
begin
  if p_token is null or length(p_token) <> 64 then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into challenge from profile_backup_email_verifications
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   for update;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if challenge.verified_at is not null then
    return jsonb_build_object('status', 'already_verified', 'email', challenge.email);
  end if;
  if challenge.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'email', challenge.email);
  end if;

  -- Nominated X, asked for a link, then nominated Y, then clicked the link for X. Verifying it
  -- would stamp proof on an address the person has since replaced, and the profile would claim a
  -- verified channel that is not the one it holds.
  select backup_email into v_current from profiles where id = challenge.profile_id;
  if v_current is distinct from challenge.email then
    return jsonb_build_object('status', 'address_changed');
  end if;

  update profile_backup_email_verifications set verified_at = now() where id = challenge.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    challenge.org_id, auth.uid(), 'backup_email_verified', 'profiles', challenge.profile_id,
    jsonb_build_object('backup_email', challenge.email),
    challenge.reason
  );

  return jsonb_build_object('status', 'verified', 'email', challenge.email);
end
$$;
revoke all on function public.verify_backup_email(text) from public;
grant execute on function public.verify_backup_email(text) to anon, authenticated;

-- ===== 8. Reading your own answer =====
-- Without this the feature is write-only: the challenge table denies every row to every browser
-- caller, so nothing could ever tell a person whether the address they nominated is proved.
-- Definer for exactly that reason, and scoped to `auth.uid()` so it can answer for one person and
-- only that person. The token hash is not in the projection.
create or replace function public.my_backup_email()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'backup_email', person.backup_email,
    'verified', person.backup_email is not null and exists (
      select 1 from profile_backup_email_verifications challenge
      where challenge.profile_id = person.id
        and challenge.email = person.backup_email
        and challenge.verified_at is not null),
    'pending', exists (
      select 1 from profile_backup_email_verifications challenge
      where challenge.profile_id = person.id
        and challenge.verified_at is null
        and challenge.expires_at > now()))
  from profiles person
  where person.id = auth.uid()
$$;
revoke all on function public.my_backup_email() from public, anon;
grant execute on function public.my_backup_email() to authenticated;

-- ===== 9. Registry duties (A1, A6) =====
-- 'org_global', the class `profiles` and `invitations` carry: it hangs off a person, a person
-- belongs to one tenant, and there is no scope column to enforce.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('profile_backup_email_verifications', 'org_global', false);

-- A6: a tenant export knows the exact shape of every table it copies. Included -- a person's own
-- recovery channel and its proof are part of what "everything we hold about this tenant" means --
-- with the bearer-token hashes excluded, exactly as `invitations` excludes its own (0103:246).
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values ('profile_backup_email_verifications', 'include', array['token_hash'],
        'Backup-address verification history without the bearer-token hashes that could redeem a challenge.');

-- C1: 0196's fail-safe emptiness predicate. An unclassified public table carrying org_id counts
-- as EVIDENCE, so leaving this one out would make every organization that ever nominated a backup
-- address look "used" -- blocking both the abandoned-signup cleanup #175 decided on and, through
-- the same predicate, the tenant teardown. A pending challenge is signup machinery, not business
-- activity: the same argument `profiles` carries at 0196:49, for the same reason.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
values ('profile_backup_email_verifications', 'not_evidence',
        'A backup-address challenge is created by signup itself; its existence proves nothing was used.');

-- Both tables: the new one for the first time, and `profiles` because adding a column to it is
-- schema drift until someone says what the export does with it. `backup_email` is EXPORTED: it is
-- the person's own stated contact address, neither a secret nor a credential. Re-derived here
-- rather than typed, the 0149/0137/0253 pattern -- a hand-written hash is a hash that drifts.
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
where registry.table_name in ('profiles', 'profile_backup_email_verifications');

-- ===== 10. Anchors =====
do $assert_0255$
declare
  v_violations text;
  v_def        text;
  v_granted    text;
begin
  -- The property this migration creates, proved rather than assumed.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'backup_email'
  ) then
    raise exception '0255: profiles.backup_email was not created';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_backup_email_shape'
  ) then
    raise exception '0255: the backup-address shape constraint is missing';
  end if;

  -- Gate one.
  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');
  if position('''backup_email''' in v_def) = 0 then
    raise exception '0255: the column guard still treats backup_email as privileged, so no browser '
      'could ever write it -- the anchored replacement did not take';
  end if;

  -- Gate two, asserted separately from the first because passing one and failing the other is the
  -- state 0253 shipped in before it was measured. `has_column_privilege` rather than a probe as
  -- the wrong role: reading as a denied role segfaults this backend.
  if not has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'update') then
    raise exception '0255: authenticated cannot UPDATE profiles.backup_email -- 0042''s column ACL '
      'still closes it, so a change would look saved and save nothing';
  end if;

  -- ...and nothing else came along with it. A migration that widened the self-service surface by
  -- accident would pass every check above.
  select string_agg(distinct column_name, ', ') into v_granted
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'profiles'
    and grantee = 'authenticated' and privilege_type = 'UPDATE';
  if v_granted is distinct from
     'active, backup_email, full_name, locale, phone, role, supplier_id' then
    raise exception '0255: the profiles self-service ACL is now [%], not 0042''s five columns plus '
      'locale plus backup_email -- something else was granted along the way, or another migration '
      'added a column and this assertion has to be re-argued with it', v_granted;
  end if;

  -- The challenge table is closed, and closed the way 0250 is closed.
  if not (select relrowsecurity from pg_class
           where oid = 'public.profile_backup_email_verifications'::regclass) then
    raise exception '0255: row level security is not enabled on the challenge table';
  end if;
  if exists (
    select 1 from pg_policy policy_row
    join pg_class table_row on table_row.oid = policy_row.polrelid
    join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = 'profile_backup_email_verifications'
  ) then
    raise exception '0255: the challenge table grew a policy -- the definer commands are meant to '
      'be its only doors';
  end if;
  if has_table_privilege('authenticated', 'public.profile_backup_email_verifications', 'select')
     or has_table_privilege('anon', 'public.profile_backup_email_verifications', 'select') then
    raise exception '0255: a browser role can read the challenge table -- the token hashes must '
      'never leave the database';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.profile_backup_email_verifications'::regclass
      and tgname = 'zz_organization_write_guard' and not tgisinternal
  ) then
    raise exception '0255: the challenge table is missing the tenant read-only write latch';
  end if;

  if private.backup_email_verification_window() <> interval '24 hours' then
    raise exception '0255: the verification window is not the documented twenty-four hours';
  end if;

  -- No JWT subject here, so every door must be shut. A definer that answered during a migration
  -- would answer for anon at runtime.
  if public.my_backup_email() is not null then
    raise exception '0255: the backup-address read answered with no JWT subject';
  end if;
  if (public.verify_backup_email(repeat('a', 64)) ->> 'status') <> 'unknown' then
    raise exception '0255: an unmatched token did not answer unknown';
  end if;
  if (public.verify_backup_email(null::text) ->> 'status') <> 'unknown' then
    raise exception '0255: a null token did not answer unknown';
  end if;
  if (public.verify_backup_email('short') ->> 'status') <> 'unknown' then
    raise exception '0255: a malformed token did not answer unknown';
  end if;

  -- The constraint really refuses a malformed address, tested rather than trusted.
  begin
    begin
      update profiles set backup_email = 'NOT-AN-ADDRESS'
       where id = (select id from profiles limit 1);
      if found then
        raise exception '0255: the constraint accepted a malformed backup address';
      end if;
      raise exception '0255_probe_rollback';
    exception when check_violation then
      raise exception '0255_probe_rollback';
    end;
  exception when others then
    if sqlerrm <> '0255_probe_rollback' then raise; end if;
  end;

  -- 0058:207-218: a migration that touches a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0255 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0255 tenant export assertions failed:\n%', v_violations;
  end if;

  -- The registry duty this file first shipped without: p75 C1 caught it, and an assertion here
  -- catches the next one three hours earlier than the gate does.
  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.org_activity_registry_violations();
  if v_violations is not null then
    raise exception e'0255 activity registry assertions failed:\n%', v_violations;
  end if;
end
$assert_0255$;
