-- 0208 -- One published usage metric, and the volumes the owner decided on 24.08.2026.
--
-- OPEN-DECISIONS #266. The catalogue carried two numeric dials a customer could hit --
-- `documents.monthly` and `ocr_pages.monthly` -- and only one of them was ever the real limit.
-- The measured average is 3.9 pages per document; the page dial sat at ten times the document
-- dial, uniformly. A ceiling 2.6x above the measured mean, applied identically to every plan, is
-- not a second decision. It is the same decision shown twice, and the second showing can only
-- confuse a customer about which number they are buying.
--
-- So documents stay the published number and pages become its derived ceiling. The page dial is
-- not removed -- `0161`/`0163` built enforcement on it and a customer who uploads a 400-page PDF
-- must still be stopped -- it simply stops being a number anyone is sold.
--
-- The volumes come down at every tier. `0184` seeded 25/50/200/500 from #197; the owner's
-- measurement on 24.08 replaced them with 20/40/150/375.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH: `assistant_runs.monthly`. `0184` set it per plan under
-- OPEN-DECISIONS #198 (free 20, basic 40, pro 100, premium 250), and that is a later and separate
-- owner decision than the ladder this file carries. An earlier draft of this work reset those
-- rows to unknown-and-refusing, which was correct against the permissive seed it was written
-- for and is wrong here: it would silently revoke a quota the owner had already decided.

do $volumes$
declare
  -- Ten documents' worth of pages per document sold. Section 3 proves this can never bind for a
  -- customer who stayed inside the document quota, which is the whole point of keeping it.
  v_page_ceiling constant int := 10;
  v_row record;
  v_previous numeric;
  v_previous_unlimited boolean;
begin
  for v_row in
    select * from (values
      ('free', 20), ('basic', 40), ('pro', 150), ('premium', 375)
    ) as ladder(plan_key, docs)
  loop
    select numeric_limit, unlimited into v_previous, v_previous_unlimited
      from plan_entitlements
     where plan_key = v_row.plan_key and entitlement_key = 'documents.monthly';
    if not found then
      raise exception '0208: no documents.monthly row for plan % -- the ladder seed did not land',
        v_row.plan_key;
    end if;

    update plan_entitlements
       set unlimited = false, numeric_limit = v_row.docs::numeric, updated_at = now()
     where plan_key = v_row.plan_key and entitlement_key = 'documents.monthly';

    -- Provenance travels with the number. `0184` built this table so a quota can never change
    -- without saying which decision moved it and what it was before.
    -- One row per quota: the table holds the CURRENT decision and what it replaced, not a log.
    insert into private.plan_quota_decisions
      (plan_key, entitlement_key, decided_limit, previous_limit, previous_unlimited, decision_ref)
    values
      (v_row.plan_key, 'documents.monthly', v_row.docs::numeric, v_previous,
       coalesce(v_previous_unlimited, false), 'OPEN-DECISIONS #266')
    on conflict (plan_key, entitlement_key) do update
       set decided_limit = excluded.decided_limit,
           previous_limit = excluded.previous_limit,
           previous_unlimited = excluded.previous_unlimited,
           decision_ref = excluded.decision_ref,
           recorded_at = now();

    select numeric_limit, unlimited into v_previous, v_previous_unlimited
      from plan_entitlements
     where plan_key = v_row.plan_key and entitlement_key = 'ocr_pages.monthly';
    if not found then
      raise exception '0208: no ocr_pages.monthly row for plan %', v_row.plan_key;
    end if;

    update plan_entitlements
       set unlimited = false,
           numeric_limit = (v_row.docs::numeric * v_page_ceiling),
           updated_at = now()
     where plan_key = v_row.plan_key and entitlement_key = 'ocr_pages.monthly';

    insert into private.plan_quota_decisions
      (plan_key, entitlement_key, decided_limit, previous_limit, previous_unlimited, decision_ref)
    values
      (v_row.plan_key, 'ocr_pages.monthly', (v_row.docs::numeric * v_page_ceiling), v_previous,
       coalesce(v_previous_unlimited, false), 'OPEN-DECISIONS #266 (derived ceiling)')
    on conflict (plan_key, entitlement_key) do update
       set decided_limit = excluded.decided_limit,
           previous_limit = excluded.previous_limit,
           previous_unlimited = excluded.previous_unlimited,
           decision_ref = excluded.decision_ref,
           recorded_at = now();
  end loop;

  -- Business and legacy stay unlimited on both, as 0161/0163/0184 left them.
  update plan_entitlements
     set unlimited = true, numeric_limit = null, updated_at = now()
   where plan_key in ('business', 'legacy')
     and entitlement_key in ('documents.monthly', 'ocr_pages.monthly');
end
$volumes$;

update private.entitlement_definitions
   set enforced_since = '0208'
 where entitlement_key in ('documents.monthly', 'ocr_pages.monthly');

-- ===== The derivation, checked rather than trusted =====
-- This re-asserts what `0163` protected at the old multiple: a customer who stayed inside the
-- document quota they were sold must never be stopped by the page ceiling. Rewritten rather than
-- deleted, because the rule did not change -- only the numbers under it did.
do $assert_pages_never_bind$
declare
  v_plan record;
  v_measured_pages_per_document constant numeric := 3.9;
begin
  for v_plan in
    select documents.plan_key,
           documents.numeric_limit as documents_limit,
           pages.numeric_limit as pages_limit
      from plan_entitlements documents
      join plan_entitlements pages on pages.plan_key = documents.plan_key
     where documents.entitlement_key = 'documents.monthly'
       and pages.entitlement_key = 'ocr_pages.monthly'
       and documents.unlimited = false
       and pages.unlimited = false
  loop
    if v_plan.pages_limit < v_plan.documents_limit * v_measured_pages_per_document then
      raise exception
        '0208: plan % would hit its page ceiling (%) before its document quota (% x % measured '
        'pages) -- the page dial would become the only limit a customer can hit',
        v_plan.plan_key, v_plan.pages_limit, v_plan.documents_limit,
        v_measured_pages_per_document;
    end if;
  end loop;
end
$assert_pages_never_bind$;

do $$
declare v_violations text; v_free numeric; v_premium numeric;
begin
  select numeric_limit into v_free from plan_entitlements
   where plan_key = 'free' and entitlement_key = 'documents.monthly';
  select numeric_limit into v_premium from plan_entitlements
   where plan_key = 'premium' and entitlement_key = 'documents.monthly';
  if v_free is distinct from 20 or v_premium is distinct from 375 then
    raise exception '0208: the decided ladder did not land (free=%, premium=%)', v_free, v_premium;
  end if;
  -- #198's assistant quotas must still be here. This file must not be able to revoke them.
  if not exists (
    select 1 from plan_entitlements
     where entitlement_key = 'assistant_runs.monthly' and numeric_limit is not null
  ) then
    raise exception '0208: the #198 assistant quotas are gone -- this migration must not touch them';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0208 scope assertions failed:\n%',v_violations;
  end if;
end
$$;
