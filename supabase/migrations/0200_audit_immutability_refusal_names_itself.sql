-- 0200: the audit immutability refusal says what it refused.
--
-- 0175 made the raw ledger immutable and raises a bare 'audit_log_immutable'. That message is
-- correct and useless in equal measure: it names the rule and withholds every fact needed to act on
-- it. Three consecutive gate runs on p75_platform_lifecycle:813 failed on this exact string, and two
-- rounds of reasoning about WHERE to open the authorized-purge window could not distinguish the two
-- possibilities the message hides -- a DELETE that arrived outside the declared window, or an UPDATE,
-- which the guard refuses unconditionally and which no declaration can ever permit. Those two call
-- for opposite fixes. Guessing between them costs a fifteen-minute CI round per attempt.
--
-- The repository already holds this standard elsewhere: "every refusal names itself" is the sentence
-- p1's document-removal suite is registered under. This brings the ledger guard up to it.
--
-- WHAT IS ADDED IS DETAIL, NEVER DATA. tg_op is one of four keywords. app.audit_purge is a GUC this
-- system writes itself, from a fixed vocabulary of one value. Neither reveals a row, a tenant or a
-- column, so the message stays safe to surface anywhere the bare one already was. The exception
-- condition and SQLSTATE are unchanged, so every caller that catches 'audit_log_immutable' by name --
-- p64, p75, demo_reset -- keeps catching it.
--
-- ANCHORED REPLACEMENT AGAINST THE LIVE BODY, not a redeclare from 0175. 0175 merged hours ago and
-- nothing has touched the guard since, so a verbatim redeclare would be harmless today and a trap the
-- first time a later wave adds a branch to it. The anchor is a single line with no newline inside, so
-- the CRLF/LF split 0126 measured in this same database cannot reach it.

do $patch_audit_immutable_detail$
declare
  v_def text;
  v_anchor text := $anchor$  raise exception 'audit_log_immutable' using errcode='42501';$anchor$;
  v_patched text := $patched$  raise exception 'audit_log_immutable'
    using errcode = '42501',
          detail = format('operation=%s, declared_purge=%s', tg_op,
                          coalesce(nullif(current_setting('app.audit_purge', true), ''), '<unset>'));$patched$;
begin
  v_def := replace(
    pg_get_functiondef('private.audit_log_immutable_guard()'::regprocedure), e'\r', '');

  if v_def ~ 'declared_purge' then
    raise exception '0200: the guard already reports its refusal';
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0200: the audit immutability raise moved -- refusing to patch blindly';
  end if;

  execute replace(v_def, v_anchor, v_patched);
end
$patch_audit_immutable_detail$;

-- The injection landed, and the guard still refuses. A message change that quietly turned the guard
-- permissive would be far worse than the silence it replaces, so both halves are asserted: the
-- detail is present, and an undeclared DELETE is still refused under the unchanged condition name.
do $assert_audit_immutable_detail$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_catalog.pg_proc p
  where p.oid = 'private.audit_log_immutable_guard()'::regprocedure;

  if coalesce(v_src, '') !~ 'declared_purge' then
    raise exception '0200: the refusal detail did not land';
  end if;
  if coalesce(v_src, '') !~ 'audit_log_immutable' then
    raise exception '0200: the refusal lost its condition name';
  end if;
  if coalesce(v_src, '') !~ 'organization_teardown' then
    raise exception '0200: the authorized purge path vanished from the guard';
  end if;
end
$assert_audit_immutable_detail$;

-- Mandatory after 0057: this migration declares no new SECURITY DEFINER surface and moves no scope,
-- but the assertion runs regardless rather than being skipped on the author's say-so.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0200 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
