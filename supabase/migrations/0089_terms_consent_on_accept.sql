-- Package 7 (owner decision 09.08.2026: the agent drafts the legal texts) — consent becomes
-- a SERVER precondition of joining, not a checkbox the API can skip.
--
-- Shape: a 4-arg overload of accept_invitation that validates the consented terms version,
-- DELEGATES to the live 3-arg function (a call, never a restatement — the silent-revert
-- discipline), and stamps the consent into audit_logs with the version, in the same
-- transaction that created the profile. The 3-arg door is then closed to authenticated:
-- with it open, "consent required" would be a UI claim, not a fact.
--
-- What this deliberately does not cover (recorded in OPEN-DECISIONS): an owner provisioned
-- by the platform operator consents out of band; trial-expiry behaviour stays undecided.

create or replace function accept_invitation(
  p_token text,
  p_full_name text,
  p_phone text,
  p_terms_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version text := nullif(trim(p_terms_version), '');
  v_result jsonb;
begin
  if v_version is null then
    raise exception 'terms_consent_required' using errcode = '22023';
  end if;

  -- The live function does everything: token checks, email match, suspension re-check,
  -- profile creation, invitation stamping, its own audit row.
  v_result := accept_invitation(p_token, p_full_name, p_phone);

  -- The profile exists now; the consent is recorded against it, version and all. Server-side
  -- on purpose: client-authored audit is disabled (src/lib/audit.ts), and a consent that only
  -- the browser remembers is not a consent record.
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    (v_result->>'org_id')::uuid, auth.uid(), 'terms_accepted', 'profiles', auth.uid(),
    jsonb_build_object('terms_version', v_version),
    'הסכמה לתנאי השימוש ולמדיניות הפרטיות בעת ההצטרפות'
  );

  return v_result;
end
$$;

comment on function accept_invitation(text, text, text, text) is
  'Package 7: joining requires consent to a named terms version; the consent is audited. '
  'Delegates to the 3-arg live function — never restates it.';

-- One door: the consent-free signature stops being callable from the browser. The 4-arg
-- definer still calls it internally (definer functions execute as owner, not as caller).
revoke all on function accept_invitation(text, text, text) from public, anon, authenticated, service_role;
revoke all on function accept_invitation(text, text, text, text) from public, anon, service_role;
grant execute on function accept_invitation(text, text, text, text) to authenticated;

-- Re-assert the 0057 scope-enforcement invariants (DEBT-REGISTER §9).
do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0089 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
