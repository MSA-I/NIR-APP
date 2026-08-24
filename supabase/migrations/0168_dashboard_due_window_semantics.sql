-- 0168 -- The due-window tile stops counting drafts, stops spanning eight days, and starts
-- respecting unit scope.
--
-- THREE DEFECTS IN ONE CTE (owner review, 24.08.2026). `payment_request_metrics` feeds the
-- dashboard tile "לתשלום בשבוע הקרוב". Its null-vs-zero handling is the strictest on that
-- screen and is NOT touched here -- the four keys keep riding the `active_due_dated > 0`
-- guard 0148 built, and the `coalesce` that separates "measured zero" from "unknown" stays.
-- What changes is which rows the aggregates see.
--
-- (1) THE WINDOW WAS EIGHT DAYS, THE LABEL SAID SEVEN. `between p_today and p_today + 7` is
--     inclusive at both ends, so it spans today plus seven more -- eight calendar days --
--     while Dashboard.tsx renders "לפירעון בשבעת הימים הקרובים" and the assistant's metric
--     catalogue says the same. `+ 6` makes the measurement match the sentence. The label is
--     the contract a manager reads; the SQL is what moves.
--
-- (2) DRAFTS WERE COUNTED AS MONEY DUE. The excluded set was ('executed','matched',
--     'cancelled'), so a request still being WRITTEN reported its shekels as falling due this
--     week. A draft is not a claim on cash -- nobody has asked to be paid yet -- and the
--     snapshot already publishes `drafts` as its own key for anyone who wants that number.
--
--     WHAT IS DELIBERATELY *NOT* EXCLUDED, and why. 'investigation' and 'suspected_duplicate'
--     stay counted. They are contested demands, not absent ones: somebody has asked for the
--     money and the question is whether we owe it. Hiding contested money from the tile whose
--     whole job is "what could take cash out of the account this week" would be the more
--     expensive error, and CLAUDE.md's dashboard rule cuts the same way -- a figure that
--     omits a real exposure is a claim about reality too. If the owner later decides a
--     contested request should drop out of the headline, that is a business decision for
--     OPEN-DECISIONS, not a predicate to widen quietly here.
--
-- (3) THE ONLY MONEY TILE WITH NO UNIT SCOPE. `payment_requests` is registered
--     ('legal_entity', enforced = false) in private.scope_registry, and the invoice-balance
--     tile immediately above this one on the same screen already filters with
--     `unit_id is null or unit_id = any(public.auth_scopes())` (0137). This CTE did not, so
--     a user granted one legal entity read org-wide money here and scoped money one tile up.
--     The same idiom is applied, character for character. Today every user is anchored to the
--     org root, so auth_scopes() spans the whole tree and no live figure moves; the filter is
--     what keeps that true once a second unit is granted.
--
-- ANCHORED REPLACEMENT, not create-or-replace (the 0137/0145/0148 pattern): the live body is
-- neither 0100's text nor 0148's -- 0137 patched the invoice reader in place to add
-- `and i.financial_role = 'payable'`. Pasting any earlier body back would silently revert that
-- fence. So: read the live definition, normalise \r (the CRLF trap in DEBT-REGISTER), replace
-- named anchors, and fail loudly if any anchor moved OR appears a different number of times
-- than expected -- a count assertion, because two of these anchors are meant to hit exactly
-- two sites each and a silent single hit would leave the CTE self-contradictory.
--
-- The function stays SECURITY INVOKER, so RLS remains the authorization boundary and no
-- definer exemption is added or needed. A5 does not apply here twice over: it inspects
-- SECURITY DEFINER functions only, and payment_requests is registered enforced = false.

do $due_window_semantics$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
  v_hits int;
  v_note constant text :=
    '0168: management_dashboard_snapshot is not where 0100/0148 left it. Fix the anchor '
    'deliberately rather than letting the migration guess.';
begin
  v_def := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure), e'\r', '');

  -- Idempotent (the 0117/0145/0148 lesson): recognise ITS OWN result, and specifically a
  -- string this migration writes that no earlier one could have. The unit-scope predicate on
  -- payment_requests is unique to 0168.
  if position('p.unit_id = any(public.auth_scopes())' in v_def) > 0 then
    return;
  end if;

  -- (A) active_due_dated -- the denominator of the null guard. It must use the same "live
  -- request" wording as the aggregates it guards, or the tile could print a sentence while
  -- holding money, or print money over a denominator that counted rows the money did not.
  v_anchor := '        where due_date is not null and status not in (''executed'', ''matched'', ''cancelled'')';
  v_replacement := '        where due_date is not null and status not in (''draft'', ''executed'', ''matched'', ''cancelled'')';
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '% active_due_dated predicate found % times, expected 1.', v_note, v_hits;
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  -- (B) overdue -- the COUNT (0100) and the AMOUNT (0148) share one predicate line verbatim.
  -- Both must move together; that is why this asserts 2 and not "at least 1".
  v_anchor := '        where due_date < p_today and status not in (''executed'', ''matched'', ''cancelled'')';
  v_replacement := '        where due_date < p_today and status not in (''draft'', ''executed'', ''matched'', ''cancelled'')';
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 2 then
    raise exception '% overdue predicate found % times, expected 2 (count + amount).', v_note, v_hits;
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  -- (C) due_today -- feeds the attention row "תשלומים לביצוע היום". A draft is not a payment
  -- to execute today.
  v_anchor := '        where due_date = p_today and status not in (''executed'', ''matched'', ''cancelled'')';
  v_replacement := '        where due_date = p_today and status not in (''draft'', ''executed'', ''matched'', ''cancelled'')';
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '% due_today predicate found % times, expected 1.', v_note, v_hits;
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  -- (D) the seven-day window -- both the amount and the count, two lines each, replaced as one
  -- pair so the day bound and the status set can never diverge between them. Assembled with an
  -- explicit e'\n' rather than a multi-line literal: this file must not depend on whatever line
  -- endings the checkout produced.
  v_anchor := concat_ws(e'\n',
    '        where due_date between p_today and p_today + 7',
    '          and status not in (''executed'', ''matched'', ''cancelled'')');
  v_replacement := concat_ws(e'\n',
    '        where due_date between p_today and p_today + 6',
    '          and status not in (''draft'', ''executed'', ''matched'', ''cancelled'')');
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 2 then
    raise exception '% seven-day window pair found % times, expected 2 (amount + count).', v_note, v_hits;
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  -- (E) unit scope on the CTE's own source. The join to `actor` already fences the tenant;
  -- this adds the unit fence the sibling money tile has carried since 0137.
  v_anchor := concat_ws(e'\n',
    '    from public.payment_requests p',
    '    join actor a on a.org_id = p.org_id');
  v_replacement := concat_ws(e'\n',
    '    from public.payment_requests p',
    '    join actor a on a.org_id = p.org_id',
    '    where p.unit_id is null or p.unit_id = any(public.auth_scopes())');
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '% payment_requests source clause found % times, expected 1.', v_note, v_hits;
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  execute v_def;
end
$due_window_semantics$;

comment on function public.management_dashboard_snapshot(date) is
  'Owner/office tenant-scoped dashboard snapshot. SECURITY INVOKER; preserves RLS and '
  'null-vs-zero evidence semantics. 0148 added the due-window money; 0168 makes the window '
  'seven days rather than eight, drops draft requests from every due-window aggregate '
  '(contested requests stay counted), and applies the auth_scopes() unit fence.';

-- ===== A1/A3/A5 re-assertion (the 0058:207-218 idiom) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0168 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors -- assert the RESULT, not the intent =====
do $$
declare
  v_def text;
  v_hits int;
begin
  v_def := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure), e'\r', '');

  -- The window is seven days and nothing still spans eight.
  if position('p_today + 7' in v_def) > 0 then
    raise exception '0168 anchor: an eight-day due window survived the replacement.';
  end if;
  v_hits := (length(v_def) - length(replace(v_def, 'p_today + 6', ''))) / length('p_today + 6');
  if v_hits <> 2 then
    raise exception '0168 anchor: expected 2 seven-day windows, found %.', v_hits;
  end if;

  -- Every due-window aggregate excludes drafts, and nothing else in the body was widened:
  -- four predicate lines, two of which (overdue count + overdue amount) are identical, so the
  -- draft-excluding list must appear exactly six times.
  v_hits := (length(v_def) - length(replace(v_def, '''draft'', ''executed'', ''matched'', ''cancelled''', '')))
            / length('''draft'', ''executed'', ''matched'', ''cancelled''');
  if v_hits <> 6 then
    raise exception '0168 anchor: expected 6 draft-excluding predicates, found %.', v_hits;
  end if;

  -- The unit fence is present.
  if position('p.unit_id = any(public.auth_scopes())' in v_def) = 0 then
    raise exception '0168 anchor: the unit-scope fence is missing.';
  end if;

  -- 0137's payable fence and 0148's money keys both had to survive an anchored rewrite of the
  -- same body. This is the check that would have caught a naive create-or-replace.
  if position('i.financial_role = ''payable''' in v_def) = 0 then
    raise exception '0168 anchor: 0137 payable fence was lost.';
  end if;
  if position('''overdueAmount'', case' in v_def) = 0
     or position('''dueWithin7Amount'', case' in v_def) = 0
     or position('''dueWithin7Count'', case' in v_def) = 0 then
    raise exception '0168 anchor: a 0148 due-window money key was lost.';
  end if;

  -- The evidence guard and its coalesce are untouched -- 0148:143-148 refused their removal
  -- and 0168 must not become the migration that quietly undoes that.
  if position('coalesce(pr.overdue_amount, 0)' in v_def) = 0
     or position('coalesce(pr.due_within_7_amount, 0)' in v_def) = 0 then
    raise exception '0168 anchor: the measured-zero coalesce was lost.';
  end if;

  -- SECURITY INVOKER survived; RLS is still the boundary.
  if exists (
    select 1 from pg_proc
    where oid = 'public.management_dashboard_snapshot(date)'::regprocedure and prosecdef
  ) then
    raise exception '0168 anchor: the function became SECURITY DEFINER.';
  end if;
end
$$;
