-- 0199: role-based MFA assurance (#88) -- the server-side half, and only that half.
--
-- WHAT THIS DOES NOT DO, deliberately. It does not enroll a factor, issue a challenge,
-- mint a recovery code or implement lost-device recovery, and it does not present MFA as
-- active anywhere. Supabase Auth exposes no backup-code primitive at all, and #88 has not
-- decided recovery-code parameters or the admin-recovery actor. Those stay in front of the
-- owner. This migration is the refusal half: a session that has not reached aal2 cannot
-- execute a sensitive command. It is inert for any tenant whose users are all `office`,
-- and it is a hard refusal for owner and accountant.
--
-- DEPLOYMENT PRECONDITION, load-bearing. Applying this before TOTP enrollment is actually
-- reachable locks owner and accountant out of every wired command, because no one can
-- reach aal2 without enrolling. It must not be applied to an environment until TOTP
-- enroll+verify is confirmed live there AND the owner/accountant identities have enrolled.
-- That ordering is a rollout decision, not something this migration can enforce.
--
-- WHY THIS IS NOT A SECOND STEP-UP PRIMITIVE (SECURITY-MODEL 6, threat model 0).
-- assert_mfa_assurance() is not called by any command. It is called by
-- assert_recent_password_authentication() -- wired in 0200 -- which stays the single entry
-- point every sensitive command already calls. One mechanism, extended in place. Adding a
-- second primitive that commands had to remember to call separately is exactly the failure
-- the named-path registry exists to catch.
--
-- NO FLAG READS THIS. Section 8: a flag may only turn capability off, never widen
-- permission, and is never read from an authorization decision. The requirement is derived
-- from the caller's role alone, so there is no switch that can accidentally open the gate.
--
-- NO NEW COLUMN, NO NEW TABLE, NO ENUM CHANGE. profiles keeps its five-column allowlist
-- (0020:34-38), user_role is untouched, and enrollment state is read from the JWT's `aal`
-- claim, which GoTrue already derives from the verified factors it holds.

create or replace function assert_mfa_assurance() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_org uuid;
begin
  if v_actor is null then
    return;
  end if;

  -- The 0133 gate comes first. Retired personas resolve no role at all, so assurance forms
  -- no opinion about them and the caller's own authorization gate is what rejects them.
  -- Inverting this order would report a retired persona as an MFA problem, which reads to
  -- the user as "enroll a factor and you are in".
  v_role := auth_role();
  if v_role is null then
    return;
  end if;

  -- #88: required for owner and accountant, optional for office.
  if v_role not in ('owner', 'accountant') then
    return;
  end if;

  v_org := auth_org();

  -- Fail closed on shape. jsonb_typeof() of an absent key is SQL NULL, so a plain
  -- `<> 'string'` evaluates to NULL and the guard silently does not fire -- the same
  -- amr-shaped bug that section 6 attribute 1 exists to prevent. `is distinct from`
  -- closes it, and covers absent, JSON null, number, boolean, array and object together.
  if jsonb_typeof(auth.jwt() -> 'aal') is distinct from 'string' then
    perform private.record_security_event(
      v_org, v_actor, 'step_up_failure', jsonb_build_object('cause', 'aal_shape'));
    raise exception 'mfa_assurance_required' using errcode = '42501';
  end if;

  -- Monotone by intent: a level above aal2 satisfies a demand for aal2. Pinning equality
  -- to 'aal2' would lock out a stronger session if GoTrue ever issues one.
  if (auth.jwt() ->> 'aal') not in ('aal2', 'aal3') then
    perform private.record_security_event(
      v_org, v_actor, 'step_up_failure', jsonb_build_object('cause', 'aal_insufficient'));
    raise exception 'mfa_assurance_required' using errcode = '42501';
  end if;
end
$$;

-- Same posture as the primitive that calls it: the browser never invokes this directly.
-- Note that calling a function a role lacks EXECUTE on crashes this stack, so the p74
-- suite exercises this as the owning role and never through `set local role`.
revoke all on function assert_mfa_assurance() from public, anon, authenticated;

comment on function assert_mfa_assurance() is
  'Raises mfa_assurance_required/42501 when an owner or accountant session has not reached '
  'aal2. Optional for office, silent for a caller with no resolvable role (0133). Called '
  'only from assert_recent_password_authentication (0200), never directly by a command.';
