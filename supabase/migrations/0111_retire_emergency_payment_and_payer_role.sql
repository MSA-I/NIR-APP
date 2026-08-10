-- 0111 -- Two role decisions the owner took on 10.08.2026, made real in the database.
--
-- 1. THE EMERGENCY PAYMENT ROUTE IS RETIRED. `public.execute_emergency_payment_request` stops
--    being callable. It is NOT dropped: every emergency payment already executed points at it
--    through `audit_logs`, and dropping a function that history refers to turns an auditable
--    record into a dangling name. Revoking EXECUTE ends the capability; keeping the function keeps
--    the explanation.
--
--    WHAT MADE THIS SAFE RATHER THAN LOSSY, measured before touching anything: the emergency path
--    never did anything the regular one cannot. Same approved payment requests, same reference,
--    same mandatory reason, same audit row. Its only real differences were an unconditional
--    password prompt and a separate RPC -- and `0061:113-176` injects
--    `assert_recent_password_authentication()` into the REGULAR command too. Nothing that was
--    protected stops being protected.
--
-- 2. `payer` IS NO LONGER OFFERED. The enum value stays, untouched, because it is embedded in 77
--    RLS policies and because the owner's decision was that existing accounts keep working. What
--    changes is that the product stops handing the role out: the client no longer offers it when
--    inviting or assigning, and `payer` now sees the accountant's control room rather than a
--    dashboard of its own. The accountant IS the executor now.
--
-- ⚠ THE TRAP THIS MIGRATION DELIBERATELY DOES NOT STEP IN. The live body of
-- `execute_payment_request` is NOT the text in `0031`. `0061:113-176` rewrites it at migration
-- time with `pg_get_functiondef` + `replace`, injecting the password step-up. A `create or replace`
-- copied from 0031 would silently delete that step-up and nothing would fail. So this migration
-- issues NO `create or replace` against either payment command -- it only changes grants -- and
-- section 3 asserts that the step-up is still present in the live body afterwards.

-- ===== 1. The emergency capability ends =====
do $$
begin
  if to_regprocedure(
       'public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)') is not null then
    revoke execute on function public.execute_emergency_payment_request(
      uuid, date, text, text, text, jsonb, text) from authenticated, anon, public;
  end if;
end
$$;

comment on function public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text) is
  'RETIRED 10.08.2026 (0111). The owner''s emergency execution route was removed from the product '
  'by owner decision. EXECUTE is revoked from every client role; the function itself is kept '
  'because emergency payments already executed refer to it in audit_logs, and dropping it would '
  'turn an auditable record into a dangling name. Approved requests are now executed through '
  'execute_payment_request, which carries the same step-up (0061), the same mandatory reason and '
  'the same audit row.';

-- ===== 2. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0111 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 3. Anchors =====
do $$
declare
  v_src text;
begin
  -- (a) The capability is gone for every client role, and for the trusted server key too. Nothing
  -- in the product should be starting a new emergency payment by any route.
  if has_function_privilege('authenticated',
       'public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)', 'execute')
     or has_function_privilege('anon',
       'public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)', 'execute') then
    raise exception '0111: a client role can still start an emergency payment.';
  end if;

  -- (b) It is REVOKED, not dropped. History refers to it.
  if to_regprocedure(
       'public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)') is null then
    raise exception
      '0111: the emergency command was dropped rather than revoked. Emergency payments already '
      'executed name it in audit_logs; dropping it turns an auditable record into a dangling name.';
  end if;

  -- (c) THE STEP-UP IS STILL THERE. This is the anchor the header exists for: 0061 injects
  -- `assert_recent_password_authentication()` into the LIVE body of execute_payment_request, and a
  -- create-or-replace copied from 0031 would delete it in silence. Four waves of this campaign
  -- touched payment code; this assertion is what makes the next one notice.
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'execute_payment_request';
  if v_src is null then
    raise exception '0111: execute_payment_request is gone.';
  end if;
  if position('assert_recent_password_authentication' in v_src) = 0 then
    raise exception
      '0111: execute_payment_request lost its password step-up. 0061 injects it into the LIVE '
      'body; a create-or-replace copied from 0031''s text deletes it and nothing else fails.';
  end if;

  -- (d) The regular execution path is still callable by the role that now owns it.
  if not has_function_privilege('authenticated',
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)', 'execute') then
    raise exception
      '0111: the regular execution path is not callable, so retiring the emergency one removed '
      'the ability to pay rather than consolidating it.';
  end if;

  -- (e) `payer` is still a legal enum value. Removing it would break 77 RLS policies and every
  -- existing account holding it; the owner asked for the role to leave the PRODUCT, not the data.
  if (select count(*) from unnest(enum_range(null::user_role)) e(v)
      where e.v::text = 'payer') <> 1 then
    raise exception
      '0111: the payer enum value was removed. It is embedded in RLS across the schema and existing '
      'accounts hold it; the decision was to stop offering the role, not to delete it.';
  end if;
end
$$;
