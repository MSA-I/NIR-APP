-- OWNER DECISION 19.08.2026 -- the monthly document limits (OPEN-DECISIONS #157).
--
-- This file is a PRICING decision expressed as data. 0154 built the machinery and deliberately
-- seeded every plan `unlimited`, saying that turning a limit on would be one UPDATE reviewed as
-- pricing rather than as engineering. This is that UPDATE, in its own migration so it can be read,
-- argued with and reverted as the commercial decision it is -- without touching a line of the
-- mechanism.
--
-- HOW THE NUMBERS WERE CHOSEN, so that a later reader can disagree with the reasoning rather than
-- guess at it. Production was measured on 19.08.2026, the design partner's first sixteen days:
--
--     67 documents over 17 calendar days   ->  ~120 documents per month
--     264 OCR pages                        ->  3.9 pages per document, ~470 pages per month
--     734k input + 144k output tokens      ->  ~11,000 + ~2,150 tokens per document
--
-- That is one real, engaged, single-site customer. n = 1, and the numbers below should be revisited
-- once there are more.
--
--   free      25   A week of genuine use -- enough to walk the whole journey from supplier to
--                  payment request with real documents, not enough to run a business on. The brief
--                  calls Free the product demo, and a demo that cannot show the pipeline is not one.
--   pro      300   Two and a half times the measured customer, so a normal month never approaches
--                  the ceiling and a busy one still does not.
--   business  --   Unlimited. The tier whose answer to "how many" is that we stop counting; an
--                  individual customer who becomes genuinely expensive is a conversation and an
--                  entitlement override, not a number set here for everybody.
--   legacy    --   Untouched, unlimited. Customers who predate the plan model never agreed to a
--                  limit, and applying one now would be changing a deal retroactively.
--
-- WHAT ELSE THE OWNER DECIDED, and where it lives instead of here:
--   * No capability is gated by plan -- tiers differ by volume only (#158). The seeded booleans are
--     already all-on, so that decision needs no change and this file makes none.
--   * A downgrade blocks new actions only; nothing retroactive (#160). Already how 0155 behaves.
--   * ocr_pages.monthly stays unlimited: it is counted, not enforced (DEBT §55), and setting a
--     limit on a metric nothing refuses would be a number with no effect.

update plan_entitlements
   set unlimited = false, numeric_limit = 25, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'documents.monthly';

update plan_entitlements
   set unlimited = false, numeric_limit = 300, updated_at = now()
 where plan_key = 'pro' and entitlement_key = 'documents.monthly';

update private.entitlement_definitions
   set enforced_since = '0161'
 where entitlement_key = 'documents.monthly';

do $assert_0161$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0161 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0161$;

do $anchor_0161$
declare
  v_free numeric;
  v_pro  numeric;
begin
  select numeric_limit into v_free from plan_entitlements
  where plan_key = 'free' and entitlement_key = 'documents.monthly';
  select numeric_limit into v_pro from plan_entitlements
  where plan_key = 'pro' and entitlement_key = 'documents.monthly';

  if v_free is distinct from 25 or v_pro is distinct from 300 then
    raise exception '0161: the decided limits are not what landed (free %, pro %)', v_free, v_pro;
  end if;

  -- The ladder must not invert. A Free customer who may process more than a Pro one is not a
  -- pricing choice, it is a typo, and it would be discovered by a paying customer.
  if v_free >= v_pro then
    raise exception '0161: Free is not below Pro -- the plan ladder inverted';
  end if;

  -- Business and legacy keep answering "we do not count that", and a limit quietly applied to a
  -- customer who predates the plan model would be changing a deal after the fact.
  if exists (
    select 1 from plan_entitlements
    where plan_key in ('business', 'legacy') and entitlement_key = 'documents.monthly'
      and not unlimited
  ) then
    raise exception '0161: a limit was applied to a plan that promises none';
  end if;

  -- Nothing else moved. This file is one decision, not a quiet re-pricing of the catalogue.
  if exists (
    select 1 from plan_entitlements
    where entitlement_key <> 'documents.monthly'
      and ((kind = 'numeric' and not unlimited) or (kind = 'boolean' and boolean_value is not true))
  ) then
    raise exception '0161: an entitlement other than the monthly document limit became restrictive';
  end if;
end
$anchor_0161$;
