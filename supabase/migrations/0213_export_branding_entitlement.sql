-- 0213: the exported PDF learns which plan it belongs to.
--
-- WHAT ARRIVED IN THE PRODUCT, AND WHY IT NEEDS A RUNG. Until 28.08.2026 there was no PDF
-- generator: every "PDF" button in the client called `window.print()` and handed the reader to the
-- browser's own dialog. `src/lib/pdf.ts` replaces that with a generated document carrying the
-- organisation's uploaded logo. The owner's ruling in the same session: the free rung exports that
-- document with the InPlace mark stamped across it, and every paid rung exports it clean.
--
-- WHY A BOOLEAN ENTITLEMENT AND NOT A PLAN-NAME TEST IN THE CLIENT. 0154 built exactly one place
-- where "what does this plan include" is answered, and a `plan_key = 'free'` comparison in a React
-- component would be a second one — invisible to the platform screens, invisible to an override,
-- and wrong the day a rung is added. It is also what makes the promise VISIBLE: the plan cards on
-- `/pricing` and `/settings/subscription` render every entitlement the catalogue returns, so this
-- row appears on both ladders, in both languages of the product, without a line of copy being
-- written. The owner asked for the watermark to be stated in the plan description; this is that
-- statement, and it cannot drift from the behaviour because it IS the behaviour.
--
-- THE KEY IS PHRASED AS THE GRANT, NOT AS THE PENALTY. `exports.unbranded_pdf` is true for a plan
-- that exports clean. A key named for the watermark would have read "true = you get a watermark",
-- which is a feature nobody buys, and would have inverted the 0154 doctrine that an unknown
-- entitlement REFUSES: refusing an unstated grant means stamping, which is the safe direction —
-- it withholds a benefit rather than leaking one, and it never blocks the document itself.
--
-- NOBODY LOSES ANYTHING HERE. The seed grants the row to every existing plan including `legacy`,
-- and only `free` is then set false. A free-plan organisation had no generated PDF at all before
-- this file, so the stamp withdraws nothing that existed; it prices something new.
--
-- WHAT THIS FILE DOES NOT DO. It adds no column, so no tenant-export contract hash moves. It
-- enables no billing and changes no price. And it does not claim the watermark is enforced against
-- a determined reader: the generator runs in the browser, so the stamp is a branding measure and
-- not an access control. That limit is stated in `src/lib/pdf.ts` and belongs in the debt
-- register, not in a comment that implies otherwise.

insert into private.entitlement_definitions
  (entitlement_key, kind, measure, unit, label, description)
values
  ('exports.unbranded_pdf', 'boolean', 'current', null, 'ייצוא PDF ללא סימן מים',
   'Whether generated PDF documents are exported without the InPlace mark.');

-- Granted on every rung first, so this migration cannot take a feature away from anybody, and the
-- one rung that differs is then stated explicitly. This is 0154's own seeding order.
insert into plan_entitlements (plan_key, entitlement_key, kind, unlimited, boolean_value)
select plan.plan_key, 'exports.unbranded_pdf', 'boolean', false, true
from subscription_plans plan;

update plan_entitlements
   set boolean_value = false, updated_at = now()
 where entitlement_key = 'exports.unbranded_pdf'
   and plan_key = 'free';

-- ===== The tenant's own read =====
-- A sibling of `public.my_subscription()` (0186:770) and scoped the same way: definer, no
-- organisation argument, and the caller's own scope as the only row filter. Resolution repeats
-- `public.effective_entitlement`'s precedence — a live override beats the plan — because that
-- function is platform-only by grant and a tenant may not call it.
create or replace function public.my_export_watermark()
returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce(
    (select override.boolean_value
       from organization_entitlement_overrides override
      where override.org_id = auth_org()
        and override.entitlement_key = 'exports.unbranded_pdf'
        and override.revoked_at is null
        and (override.expires_at is null or override.expires_at > now())),
    (select entitlement.boolean_value
       from organization_subscriptions subscription
       join plan_entitlements entitlement on entitlement.plan_key = subscription.plan_key
      where subscription.org_id = auth_org()
        and entitlement.entitlement_key = 'exports.unbranded_pdf'),
    -- Unknown refuses (0154/0155). Refusing the GRANT means the mark is applied, which withholds
    -- a benefit instead of leaking one and never stops a document from being produced.
    false)
  where auth_org() is not null
$$;
revoke all on function public.my_export_watermark() from public, anon;
grant execute on function public.my_export_watermark() to authenticated;

comment on function public.my_export_watermark() is
  'Whether the caller''s own organisation exports generated PDF documents with the InPlace mark '
  '(0213). Resolves the exports.unbranded_pdf entitlement through override then plan, and refuses '
  'an unstated grant by stamping. Branding, not access control: the generator runs in the browser.';

do $assert_0213$
declare
  v_violations text;
  v_free boolean;
  v_paid integer;
begin
  select boolean_value into v_free
  from plan_entitlements
  where plan_key = 'free' and entitlement_key = 'exports.unbranded_pdf';
  if v_free is distinct from false then
    raise exception '0213: the free rung must not be granted an unbranded export';
  end if;

  select count(*) into v_paid
  from plan_entitlements
  where entitlement_key = 'exports.unbranded_pdf'
    and plan_key <> 'free'
    and boolean_value is distinct from true;
  if v_paid > 0 then
    raise exception '0213: % rung(s) other than free lost the unbranded export grant', v_paid;
  end if;

  -- 0058:207-218: a migration that adds a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0213 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0213 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0213$;
