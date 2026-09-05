-- 0323 — PERM-02: a password change is the holder's own record.
--
-- WHAT WAS MEASURED, and where. Production (`rkftlbctohswhbbiaqin`), read-only, ON THE GUARDED
-- PATH — role `authenticated` carrying `accountant@gamos.demo`'s own subject in
-- `request.jwt.claims`, never as `postgres`, because a read as the superuser skips RLS entirely
-- and would have measured nothing:
--
--     rows_the_accountant_reads     = 2
--     rows_they_are_the_subject_of  = 0
--
-- Both rows name the OWNER (`273d686e-…`), whose password the 04.09 rollout set and then restored
-- (`docs/ROLLOUT-0291-0314-20260904.md:123` — «0 → 1 אחרי שינוי אמיתי → 2 אחרי ההחזרה»). So the
-- accountant reads, in full, the record of when another person's credential changed, twice.
--
-- THE SURFACE IS THE VIEW; THE CAUSE IS THE POLICY. `public.audit_log_read_model` was read live
-- and is byte for byte the `security_invoker`, `security_barrier` view `0175` created: it carries
-- no predicate of its own, so what it returns is exactly what `audit_select` on
-- `public.audit_logs` allows. `audit_select`'s second branch is
-- `scope_class = 'cross_scope' AND scope_domain = 'organization_identity_platform'`, and `0175`
-- files `auth.users` in exactly that class. Every owner and accountant of a tenant therefore reads
-- every identity event of every colleague. `0293` did not open that door; its rows walked through
-- one that had been open since `0175`.
--
-- WHO HAS AN AUDIT SURFACE — established from the code, not from instinct, because that phrase is
-- the whole finding:
--   * `/supplier-log` is the product's ONLY audit-ledger screen and it is `owner`-only
--     (`src/App.tsx:424`), by owner ruling #153, which says in as many words that widening it is
--     «שינוי מדיניות RLS על יומן הביקורת, לא שינוי תצוגה» — a policy decision, not a rendering one.
--   * `/settings`, where identities are administered, is `owner`-only (`src/App.tsx:425`).
--   * The accountant has neither, and nothing in `src/` reads `password_changed` at all: the only
--     readers of that action anywhere in the repository are the QA sweep's raw REST probe and
--     `supabase/tests/p4_flags_identity.sql`.
--
-- WHY THIS IS NOT A BUSINESS ANSWER INVENTED IN CODE. Owner ruling #357 (04.09.2026), decided on
-- `PERM-01` in this same sweep, states the rule this row needs and states it generally:
-- office and accountant are bounced from `/settings`, and «תפקיד שנחסם מהמסך אינו מקבל את מה
-- שמאחוריו». `/supplier-log` bounces the accountant for the reason #153 recorded. The direction
-- was therefore ruled the day before this migration; what is new here is only the row it lands on.
-- If the owner would rather this carried a ruling of its own, this header is the only place that
-- changes — the predicate below is what either wording asks for.
--
-- WHAT IT DOES, AND WHY IT CANNOT WIDEN ANYTHING. The policy gains ONE conjunct. A conjunct can
-- only remove rows; there is no arrangement of `AND (…)` that returns a row the policy did not
-- already return. That property is the reason this shape was chosen over rewriting the branches:
-- «never widen a read to make two numbers agree» is not a rule this change can break even by
-- accident.
--
--     and (action <> 'password_changed'   -- 27,269 of production's 27,533 audit rows: tested
--          or user_id = auth.uid()        --   first, so the other two are never reached for them
--          or auth_role() = 'owner')
--
-- ANCHORED AGAINST THE LIVE POLICY, never re-declared from `0175`. `audit_select` has already been
-- rewritten twice (`0001:641` → `0031:209` → `0175:362`) and each rewrite NARROWED it; a fourth
-- `create policy` typed out from the third would silently discard whatever a later migration had
-- added — the same accident `check:anchored-replacements` exists for on function bodies. This
-- reads `pg_get_expr(polqual, …)` out of `pg_policy` and wraps what is actually installed. It is
-- an `alter policy`, not a drop-and-create, so the `to authenticated` grant and the `SELECT`
-- command cannot be lost in the round trip. No `SECURITY DEFINER` body is touched and no
-- `private.scope_definer_enforcements` hash moves — a policy is a parse tree, not `prosrc`.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH, each named rather than left to be discovered:
--   * The accountant's other identity reads. `profiles`, `invitations`, `user_scope_grants` and
--     the rest of `organization_identity_platform` are exactly as they were. Narrowing them is a
--     different question with different screens behind it, and `PERM-02` did not ask it.
--   * `retired_persona_auth_banned` — 3 rows on production, also `entity_type = 'auth.users'`.
--     That is an administrative act performed ON an account by the platform, not the holder's own
--     credential rotation. The two are not the same event and are not narrowed by one sentence.
--   * The `office` role, which cannot read `audit_logs` AT ALL: `auth_role() in
--     ('owner','accountant')` has excluded it since `0031:209`. The subject clause therefore has
--     no effect for an office subject, and this migration does NOT widen one in. A subject clause
--     that handed office a read it never had would be a privilege leak wearing the finding's own
--     words, and `p116` asserts the absence rather than leaving it to be assumed.

do $patch_audit_select_0323$
declare
  v_qual text;
begin
  -- `pg_get_expr` deparses unqualified — `auth_org()`, `auth_scopes()`, `FROM org_units root`,
  -- `'owner'::user_role`. Re-parsing that text under a different search_path would resolve
  -- different objects, so the path is pinned for the duration of this block rather than inherited
  -- from whoever applied the migration.
  perform set_config('search_path', 'public, pg_temp', true);

  select pg_get_expr(policy.polqual, policy.polrelid)
    into v_qual
  from pg_catalog.pg_policy policy
  where policy.polrelid = 'public.audit_logs'::regclass
    and policy.polname = 'audit_select';

  if v_qual is null then
    raise exception '0323: audit_select is not on public.audit_logs — refusing to invent a read policy';
  end if;

  if position('password_changed' in v_qual) > 0 then
    return; -- already narrowed; this migration is being re-applied
  end if;

  -- The three branches `0175` installed, identified by the literals that survive deparsing (a SQL
  -- comment would not: a policy qual is stored as a parse tree). If any is missing, the live
  -- policy is not the one the reasoning above was written against, and wrapping it would carry a
  -- predicate nobody here read.
  if position('organization_identity_platform' in v_qual) = 0
     or position('financial_accounting' in v_qual) = 0
     or position('legal_entity' in v_qual) = 0 then
    raise exception '0323: the live audit_select does not carry 0175''s three scope branches: %', v_qual;
  end if;

  execute format(
    'alter policy audit_select on public.audit_logs using (%s and (%s))',
    v_qual,
    $narrow$action <> 'password_changed' or user_id = auth.uid() or auth_role() = 'owner'$narrow$);
end
$patch_audit_select_0323$;

comment on policy audit_select on public.audit_logs is
  'Who reads the tenant ledger. 0175 gives owner and accountant three branches by audit scope; '
  '0323 (PERM-02) adds one conjunct on top: a password_changed row is readable by its SUBJECT and '
  'by the owner — the only role with an audit surface (/supplier-log, ruling #153) — and by nobody '
  'else. Patch it by wrapping the live qual, never by re-declaring it from a migration.';

do $assert_0323$
declare
  v_qual text := (select pg_get_expr(policy.polqual, policy.polrelid)
                  from pg_catalog.pg_policy policy
                  where policy.polrelid = 'public.audit_logs'::regclass
                    and policy.polname = 'audit_select');
  v_roles text[];
  v_cmd "char";
  v_violations text;
begin
  if v_qual is null then
    raise exception '0323: audit_select vanished during the patch';
  end if;
  if position('password_changed' in v_qual) = 0 then
    raise exception '0323: the narrowing is not in the live policy — the finding is unchanged';
  end if;
  -- Without the subject clause the row would be readable by the owner alone, and a person could
  -- not see the record of their own credential changing. That is a different policy, not this one.
  if position('uid()' in v_qual) = 0 then
    raise exception '0323: the subject clause is missing — a person cannot read their own record';
  end if;
  -- Nothing was lost in the deparse-and-reparse round trip. This is the assertion that catches a
  -- wrap that quietly dropped a branch and so WIDENED the policy instead of narrowing it.
  if position('organization_identity_platform' in v_qual) = 0
     or position('financial_accounting' in v_qual) = 0
     or position('legal_entity' in v_qual) = 0
     or position('''root''' in v_qual) = 0
     or position('auth_scopes()' in v_qual) = 0 then
    raise exception '0323: a 0175 branch did not survive the wrap: %', v_qual;
  end if;

  select array_agg(role.rolname order by role.rolname)
    into v_roles
  from pg_catalog.pg_policy policy
  join pg_catalog.pg_roles role on role.oid = any(policy.polroles)
  where policy.polrelid = 'public.audit_logs'::regclass
    and policy.polname = 'audit_select';
  if v_roles is distinct from array['authenticated'] then
    raise exception '0323: audit_select no longer applies to authenticated alone: %', v_roles;
  end if;

  select policy.polcmd into v_cmd
  from pg_catalog.pg_policy policy
  where policy.polrelid = 'public.audit_logs'::regclass and policy.polname = 'audit_select';
  if v_cmd <> 'r' then
    raise exception '0323: audit_select is no longer a SELECT policy (polcmd %)', v_cmd;
  end if;

  -- The finding's surface is the view. If it ever stopped being `security_invoker` the policy
  -- would not be consulted on that path at all and this migration would be decoration.
  if not exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = 'public.audit_log_read_model'::regclass
      and c.reloptions @> array['security_invoker=on']
  ) then
    raise exception '0323: audit_log_read_model is not security_invoker — the policy is not in its path';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0323 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0323$;
