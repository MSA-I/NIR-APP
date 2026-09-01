-- 0282 -- An invitation is redeemed by proving the address it was sent to, not by owning a password.
--
-- Owner decision 31.08.2026, amending `#265` (24.08.2026). `0205` wrote the rule as "the invitation
-- path is a password path" and enforced it by refusing any caller whose identity provider is not
-- `email`. That rule was one implementation of a correct instinct, and it was the cruder one.
--
-- WHAT WAS ALREADY TRUE, and is the reason this is a removal rather than a new security model.
-- `accept_invitation` has refused a mismatched address since `0007`:
--
--     if v_email is null or v_email <> inv.email then
--       raise exception 'email_mismatch' using errcode = '42501';
--
-- `v_email` is `lower(auth.jwt() ->> 'email')` -- the top-level GoTrue claim, taken from
-- `auth.users`, NOT from `user_metadata`, which is self-asserted and must never decide an
-- authorization question. So the binding the whole industry uses -- an invitation belongs to an
-- ADDRESS, and any identity that proves that address may redeem it -- was already enforced here.
-- `0205`'s guard sat on top of it and added no property it did not already have; it only outlawed
-- one way of proving the address, and the way it outlawed is the stronger one. An emailed link can
-- be forwarded. A provider's assertion of the address cannot.
--
-- WHAT WAS MISSING, and why this migration is not purely a deletion. The address comparison was a
-- string comparison. It never asked whether the address had been CONFIRMED. That is the opening for
-- the pre-account-takeover pattern: register the invited address with a password, never confirm it,
-- and redeem the invitation as somebody else. Adding `email_confirmed_at is not null` closes it --
-- and it closes it for the password path too, which carried the same hole the whole time. That is
-- why the net rule here is STRICTER than the one it replaces, not looser.
--
-- WHAT IS NEW: a tokenless redemption. `AcceptInvite` still passes its token and nothing about that
-- path changes. But an employee who signs in with a provider never receives a token -- the token
-- lives in an email that, per `DEBT §25`, this deployment cannot yet deliver. With a null token the
-- command resolves the invitation from the caller's own confirmed address instead. Everything after
-- the lookup -- revocation, expiry, role, suspension, supplier, profile creation, the audit row --
-- is the same code on both paths, because the lookup is the only thing that differs and duplicating
-- the rest is how two paths drift into disagreeing.
--
-- Every anchor below is CR-stripped as well as the body it is matched against. A literal that git
-- checks out with CRLF would otherwise never match a definition normalised to LF -- the failure
-- that aborted the 0171-0205 rollout at 0181, and the reason `check:anchored-replacements` exists.

do $patch_accept_invitation$
declare
  v_signature regprocedure := 'public.accept_invitation(text,text,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');

  -- Anchor 1: the declaration block, so the tokenless lookup has somewhere to count into.
  v_declare_anchor text := replace($anchor1$  v_name text := trim(coalesce(p_full_name, ''));
begin$anchor1$, e'\r', '');
  v_declare_replacement text := replace($replacement1$  v_name text := trim(coalesce(p_full_name, ''));
  v_live int;
begin$replacement1$, e'\r', '');

  -- Anchor 2: the token gate and the lookup it guards.
  v_lookup_anchor text := replace($anchor2$  if p_token is null or length(p_token) <> 64 then
    raise exception 'invitation_unknown' using errcode = 'P0002';
  end if;

  select * into inv from invitations
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;$anchor2$, e'\r', '');
  v_lookup_replacement text := replace($replacement2$  if p_token is not null and length(p_token) <> 64 then
    raise exception 'invitation_unknown' using errcode = 'P0002';
  end if;

  if p_token is null then
    if v_email is null then
      raise exception 'invitation_unknown' using errcode = 'P0002';
    end if;
    select count(*) into v_live from invitations
    where email = v_email
      and accepted_at is null and revoked_at is null and expires_at > now();
    if v_live > 1 then
      raise exception 'invitation_ambiguous' using errcode = 'P0002';
    end if;
    select * into inv from invitations
    where email = v_email
      and accepted_at is null and revoked_at is null and expires_at > now()
    for update;
  else
    select * into inv from invitations
    where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    for update;
  end if;$replacement2$, e'\r', '');

  -- Anchor 3: the address comparison, which gains the confirmation it never had.
  v_confirm_anchor text := replace($anchor3$  if v_email is null or v_email <> inv.email then
    raise exception 'email_mismatch' using errcode = '42501';
  end if;$anchor3$, e'\r', '');
  v_confirm_replacement text := replace($replacement3$  if v_email is null or v_email <> inv.email then
    raise exception 'email_mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = v_uid and u.email_confirmed_at is not null
  ) then
    raise exception 'invite_requires_confirmed_address' using errcode = '42501';
  end if;$replacement3$, e'\r', '');
begin
  -- Each sentinel is what this patch CREATES, never a string that also occurs in what it reads.
  if position('invitation_ambiguous' in v_definition) > 0 then
    raise exception '0282: accept_invitation tokenless lookup already applied';
  end if;
  if position(v_declare_anchor in v_definition) = 0 then
    raise exception '0282: accept_invitation declaration anchor moved';
  end if;
  if position(v_lookup_anchor in v_definition) = 0 then
    raise exception '0282: accept_invitation token lookup anchor moved';
  end if;
  if position(v_confirm_anchor in v_definition) = 0 then
    raise exception '0282: accept_invitation address anchor moved';
  end if;
  -- 0133 put the retired-role refusal in this body. Refusing to patch a body that lost it keeps
  -- the two from drifting apart silently, exactly as 0205 did for 0089's consent ancestry.
  if position('account_role_retired' in v_definition) = 0 then
    raise exception '0282: refusing to patch accept_invitation without its 0133 role ancestry';
  end if;

  v_definition := replace(v_definition, v_declare_anchor, v_declare_replacement);
  v_definition := replace(v_definition, v_lookup_anchor, v_lookup_replacement);
  v_definition := replace(v_definition, v_confirm_anchor, v_confirm_replacement);
  execute v_definition;
end
$patch_accept_invitation$;

-- ===== The four-argument wrapper stops asking which provider signed the caller in =====
--
-- This is the half of `#265` the owner amended. The wrapper keeps everything else it does: it still
-- refuses without a consented terms version, still delegates rather than restating, and still
-- stamps the consent into `audit_logs` in the same transaction that created the profile.
do $unpatch_identity_guard$
declare
  v_signature regprocedure := 'public.accept_invitation(text,text,text,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_guard text := replace($guard$
  -- Owner decision 24.08.2026: an invitation is accepted with a password. A federated identity
  -- may only ever be the owner of an organization it created, so it cannot be talked into
  -- joining an existing one -- not through the screen, and not by calling this command directly.
  if coalesce(private.auth_identity_provider(), 'email') <> 'email' then
    raise exception 'invite_requires_password_identity' using errcode = '42501';
  end if;$guard$, e'\r', '');
begin
  if position(v_guard in v_definition) = 0 then
    raise exception '0282: the 0205 identity guard is not where it was left';
  end if;
  execute replace(v_definition, v_guard, '');
end
$unpatch_identity_guard$;

-- `private.auth_identity_provider()` is deliberately NOT dropped. `public-signup` still reads the
-- provider to decide which branch a caller is on, and `#269`'s token-over-body rule depends on it.
-- What changed is that it no longer decides who may join an organization.

do $verify_0282$
declare
  v_three text := replace(pg_get_functiondef('public.accept_invitation(text,text,text)'::regprocedure), e'\r', '');
  v_four text := replace(pg_get_functiondef('public.accept_invitation(text,text,text,text)'::regprocedure), e'\r', '');
  v_violations text;
begin
  if position('invite_requires_password_identity' in v_four) > 0 then
    raise exception '0282: the identity guard survived the patch';
  end if;
  if position('invite_requires_confirmed_address' in v_three) = 0 then
    raise exception '0282: the confirmed-address requirement did not land';
  end if;
  if position('invitation_ambiguous' in v_three) = 0 then
    raise exception '0282: the tokenless lookup did not land';
  end if;
  if position('email_mismatch' in v_three) = 0 then
    raise exception '0282: the address comparison went missing';
  end if;
  if position('account_role_retired' in v_three) = 0 then
    raise exception '0282: 0133 role ancestry went missing';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0282 scope assertions failed: %', v_violations;
  end if;
end
$verify_0282$;
