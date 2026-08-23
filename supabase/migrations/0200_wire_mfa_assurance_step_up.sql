-- 0200: wire MFA assurance into the one step-up primitive (#88).
--
-- REDECLARATION LAW. This does NOT redeclare assert_recent_password_authentication from
-- 0061. It fetches the LIVE body with pg_get_functiondef against an explicit
-- ::regprocedure, refuses if the function is missing, refuses if the anchor is not present
-- exactly once, and patches that -- the 0168:44-69 idiom. A verbatim redeclare from 0061
-- would silently revert anything a later wave added to the primitive, and the primitive is
-- the one place where losing a line costs every wired command at once.
--
-- PLACEMENT is the security decision here. The assurance call goes AFTER the password
-- block and immediately BEFORE the success event, so password step-up keeps raising FIRST.
-- #88 keeps password step-up in force until MFA is live and proven; if assurance were
-- evaluated first, a stale-password session would begin reporting an MFA error instead of
-- fresh_authentication_required, silently changing an error contract that three existing
-- gate assertions already pin.
--
-- Because every wired command already calls this primitive, this single patch reaches all
-- of them at once -- including the two whose live bodies are themselves the product of
-- in-place rewrites (execute_payment_request, mark_month_export_sent) and which therefore
-- must never be redeclared to add anything.

do $$
declare
  v_def text;
  v_anchor text := $anchor$  perform private.record_security_event(v_org, v_actor, 'step_up_success', '{}'::jsonb);$anchor$;
  v_patched text := $patched$  perform assert_mfa_assurance();

  perform private.record_security_event(v_org, v_actor, 'step_up_success', '{}'::jsonb);$patched$;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  where p.oid = 'public.assert_recent_password_authentication()'::regprocedure;

  if v_def is null then
    raise exception '0200: assert_recent_password_authentication not found';
  end if;

  if v_def ~ 'assert_mfa_assurance' then
    raise exception '0200: the step-up primitive already carries an assurance call';
  end if;

  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0200: step-up success anchor moved -- refusing to patch blindly';
  end if;

  execute replace(v_def, v_anchor, v_patched);
end
$$;

-- The injection must have landed. Body comparison is by regex on prosrc, never by line
-- slicing: line ranges do not survive this repository's CRLF history.
do $$
begin
  if coalesce(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.assert_recent_password_authentication()'::regprocedure),
       '') !~ 'assert_mfa_assurance' then
    raise exception '0200: assurance injection did not land';
  end if;
end
$$;

-- The primitive stays revoked from the browser roles after the replace. CREATE OR REPLACE
-- preserves privileges, so this is a restatement of the 0061 posture rather than a change;
-- it is here so that a future reader cannot mistake the patch for a grant-widening step.
revoke all on function assert_recent_password_authentication()
  from public, anon, authenticated;
