-- 0307 — changing the settled-tolerance carries the stored labels with it. Codex round 2,
-- finding 3, and it is a defect in round 1's own fix.
--
-- WHAT THE REVIEW CAUGHT, and my claim was again too strong. `0304` made the writer compute
-- `private.invoice_payment_state(...)` and said the column and the readers "cannot drift apart".
-- They cannot drift apart AT WRITE TIME. But the derived answer reads
-- `private.money_tolerance(org, currency, 'invoice_payment_settled_tolerance')` LIVE, and `0299`
-- put that value on the settings screen so the owner can state it:
--
--   an invoice with 0.75 ILS remaining is written `paid` under a 1.00 threshold. The owner opens
--   settings and lowers the threshold to 0.50. Every derived reader answers `partial` from the
--   next statement onwards; the stored column still says `paid`, and eleven client screens are
--   still reading and filtering on it until step 3 lands.
--
-- So a tolerance the owner is invited to change is a second way to separate the two answers, and
-- it needed the same treatment the writer got: **the change and the relabelling are one act.**
--
-- WHAT THIS ADDS. An AFTER UPDATE trigger on `organizations` that fires only when that one
-- settings key actually moved, and refreshes only the invoices whose label the new threshold
-- actually changes — read from `private.p1_payment_status_drift()`, which is the same measurement
-- step 3 refuses to run without. Two deliberate narrowings:
--
--   * ONLY that key. `organizations.settings` carries a dozen unrelated values and a rename or a
--     logo change must not walk a tenant's invoices.
--   * ONLY the drifted rows. A blanket refresh would rewrite `updated_at` on every invoice in the
--     tenant and turn an audit trail into noise, which `0304` already argued for its own
--     reconciliation.
--
-- IT IS SYNCHRONOUS, and that is the point rather than an oversight. A tolerance change is a rare
-- deliberate act by one person, and the alternative — a queued job — reopens exactly the window
-- this closes: a period in which the screens and the ledger disagree and nothing says so. A
-- tenant with a very large ledger will see the settings save take longer; it will not see a wrong
-- label.
--
-- The trigger is named `zzz_` so it runs after the guards and the audit trigger on the same row,
-- which is the convention the four other `zzz_organizations_*` triggers already follow.

create or replace function private.organizations_relabel_on_tolerance_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_key constant text := 'invoice_payment_settled_tolerance';
  v_ids uuid[];
begin
  -- Only that one key, and only when it MOVED. `is distinct from` rather than `<>` so that
  -- setting a value for the first time, or clearing it back to the derived default, both count.
  if (new.settings -> v_key) is not distinct from (old.settings -> v_key) then
    return null;
  end if;

  select array_agg(drift.invoice_id) into v_ids
  from private.p1_payment_status_drift() drift
  where drift.org_id = new.id;

  if v_ids is null then
    return null;
  end if;

  perform public.p1_refresh_invoice_payment_statuses(new.id, v_ids);
  return null;
end
$function$;

comment on function private.organizations_relabel_on_tolerance_change() is
  'Keeps the stored invoices.payment_status in step with the settled-tolerance the owner just '
  'changed (0307). Without it a threshold change moved every derived reader immediately and left '
  'the column -- which eleven client screens still read -- describing the old threshold. Fires '
  'only when that one settings key moved, and refreshes only the invoices whose label the change '
  'actually alters.';

drop trigger if exists zzz_organizations_settled_tolerance on public.organizations;
create trigger zzz_organizations_settled_tolerance
after update of settings on public.organizations
for each row
execute function private.organizations_relabel_on_tolerance_change();

do $assert_0307$
declare
  v_violations text;
begin
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.organizations'::regclass
      and t.tgname = 'zzz_organizations_settled_tolerance'
      and not t.tgisinternal
  ) then
    raise exception '0307: the relabelling trigger is not on organizations';
  end if;
  -- It must be scoped to the settings column, or every organization write walks the ledger.
  if position('settings' in (
       select pg_get_triggerdef(t.oid) from pg_trigger t
       where t.tgrelid = 'public.organizations'::regclass
         and t.tgname = 'zzz_organizations_settled_tolerance')) = 0 then
    raise exception '0307: the trigger is not scoped to the settings column';
  end if;
  -- And the whole point: after 0304 and 0307 nothing may be left disagreeing.
  if (select count(*) from private.p1_payment_status_drift()) <> 0 then
    raise exception '0307: % invoice(s) disagree before the trigger has even fired',
      (select count(*) from private.p1_payment_status_drift());
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0307 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0307$;
