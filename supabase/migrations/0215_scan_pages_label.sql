-- 0215: the page quota stops calling itself OCR.
--
-- Owner report 28.08.2026, on a sweep for technical language leaking onto tenant screens: "יש אזור
-- שמראה פרטים טכניים - להסיר את זה, משתמש לא אמור לראות את זה - לבדוק באילו עוד מקומות זה קיים."
-- The sweep found four product sentences naming OCR and one PRICE, and only the four were fixed in
-- the client: `ocr_pages.monthly` carries its label in the database, it is printed on the pricing
-- page and on the subscription screen through `get_public_plan_quotas()` and
-- `organization_usage_snapshot()`, and renaming a priced quota is a commercial wording decision
-- rather than a cleanup. He made it the same day: "להחליף".
--
-- WHAT CHANGES: three words on two screens. The `entitlement_key` is untouched, and that is the
-- point of it being separate from the label — `0161`/`0163` enforce against the key, `0208` derives
-- the ceiling from the key, the SQL suites name the key, and none of them can notice this file.
--
-- WHAT IS DELIBERATELY NOT RENAMED: `worker/ocr/**`, the `ocr_pages.monthly` key itself, and the
-- OCR sentence in `Legal.tsx`. The first two are ours and no customer reads them; the third is a
-- data-processing disclosure, where the exact technique is the thing being disclosed.
--
-- WHY "סריקה" AND NOT "קריאה": the sibling quota is `documents.monthly` — "מסמכים בחודש" — and a
-- page counter called "עמודי קריאה" beside it reads as a second count of the same act. A scanned
-- page is what is actually being metered: a document is one upload, a scan page is one side of
-- paper inside it, and a customer who uploads a 27-page PDF is spending the second on the first.

update private.entitlement_definitions
   set label = 'עמודי סריקה בחודש'
 where entitlement_key = 'ocr_pages.monthly';

comment on table private.entitlement_definitions is
  'What can be limited, in what unit, and what a customer is told it is called (0154). The LABEL is '
  'tenant-facing copy and may be reworded without touching the key anything enforces against '
  '(0215); the key is the contract.';

do $assert_0213$
declare
  v_violations text;
  v_label      text;
begin
  select label into v_label
    from private.entitlement_definitions
   where entitlement_key = 'ocr_pages.monthly';

  if v_label is null then
    raise exception '0215: ocr_pages.monthly is not in the definitions at all';
  end if;
  if v_label <> 'עמודי סריקה בחודש' then
    raise exception '0215: the page quota is still labelled "%"', v_label;
  end if;
  -- The acronym must be gone from every tenant-facing label, not only from the row this file
  -- names. A second definition acquiring it later is the same defect arriving through another door.
  if exists (select 1 from private.entitlement_definitions where label ilike '%OCR%') then
    raise exception '0215: a tenant-facing entitlement label still names OCR';
  end if;

  -- 0058:207-218 — every migration after 0057 re-runs the scope assertions here rather than
  -- discovering three hours later in the gate that something moved under it.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0215 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0213$;
