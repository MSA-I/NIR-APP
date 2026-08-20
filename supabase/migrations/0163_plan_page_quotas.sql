-- OWNER DECISION 19.08.2026 -- the monthly OCR page quotas (OPEN-DECISIONS #177).
--
-- The rule, in one line: a plan's page quota is its document quota times the hard per-document
-- page ceiling. Nothing is invented; the number is derived from two facts that already exist.
--
--   ExtractionLimits.max_ai_pages = 20   worker/ocr/src/limits.py:25. `parsers._parse_pdf` sends
--                                        `missing[:20]` to the provider, so ONE document can never
--                                        cost more than twenty billed pages whatever the file
--                                        contains. Note this is a TRUNCATION, not a refusal: a
--                                        27-page PDF has twenty pages read and comes back
--                                        `partial = true` for a human to finish (0144).
--
--   documents.monthly                    0161: free 25, pro 300, business and legacy unlimited.
--
--   free      25 x 20 =   500
--   pro      300 x 20 = 6,000
--   business  unlimited x 20 = unlimited
--   legacy    untouched, unlimited -- these customers predate the plan model and never agreed to
--             a limit of any kind.
--
-- WHAT THIS QUOTA ACTUALLY DOES, stated plainly so nobody later reads it as the main control. It
-- is the worst case the document quota ALREADY permits, so for a normal customer it never binds:
-- production measured 8.1 pages per PDF and 1.0 per image, so a Free customer's 25 documents come
-- to roughly 200 pages against a 500 ceiling, and the document limit is what they meet. The page
-- quota bites exactly one shape of usage -- somebody uploading maximum-size packets, every time --
-- which is the case the document count alone cannot see and the one that costs real money.
--
-- The bounded overshoot from 0162 still applies on top: because a new document's page count is
-- unknown until the provider reads it, a customer can cross by at most one document, so the true
-- worst case is 520 pages for Free rather than 500. That is a fifth of a percent of the ceiling
-- and it is written down rather than rounded away.

update plan_entitlements
   set unlimited = false, numeric_limit = 500, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'ocr_pages.monthly';

update plan_entitlements
   set unlimited = false, numeric_limit = 6000, updated_at = now()
 where plan_key = 'pro' and entitlement_key = 'ocr_pages.monthly';

update private.entitlement_definitions
   set enforced_since = '0163'
 where entitlement_key = 'ocr_pages.monthly';

do $assert_0163$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0163 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0163$;

do $anchor_0163$
declare
  v_ceiling constant numeric := 20;
  v_plan record;
begin
  -- The derivation, checked rather than trusted: every plan that limits documents must limit
  -- pages at exactly the ceiling multiple, and every plan that does not limit documents must not
  -- limit pages either. A page quota below the multiple would refuse a customer who stayed inside
  -- the document quota they were sold.
  for v_plan in
    select documents.plan_key,
           documents.unlimited     as documents_unlimited,
           documents.numeric_limit as documents_limit,
           pages.unlimited         as pages_unlimited,
           pages.numeric_limit     as pages_limit
    from plan_entitlements documents
    join plan_entitlements pages on pages.plan_key = documents.plan_key
    where documents.entitlement_key = 'documents.monthly'
      and pages.entitlement_key = 'ocr_pages.monthly'
  loop
    if v_plan.documents_unlimited then
      if not v_plan.pages_unlimited then
        raise exception
          '0163: plan % does not limit documents but limits pages -- the page quota would be the only ceiling',
          v_plan.plan_key;
      end if;
    else
      if v_plan.pages_unlimited
         or v_plan.pages_limit is distinct from v_plan.documents_limit * v_ceiling then
        raise exception
          '0163: plan % pages (%) is not its documents (%) times the % page ceiling',
          v_plan.plan_key, v_plan.pages_limit, v_plan.documents_limit, v_ceiling;
      end if;
    end if;
  end loop;

  -- Nothing else moved. This file is one decision.
  if exists (
    select 1 from plan_entitlements
    where entitlement_key not in ('documents.monthly', 'ocr_pages.monthly')
      and ((kind = 'numeric' and not unlimited) or (kind = 'boolean' and boolean_value is not true))
  ) then
    raise exception '0163: an entitlement beyond the two decided limits became restrictive';
  end if;
end
$anchor_0163$;
