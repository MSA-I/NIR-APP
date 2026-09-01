-- 0268 — the two remaining switches the plan seeds, and the pin moves once for both.
--
-- WHY BOTH IN ONE FILE. `p4_flags_identity` pins the number of flags on purpose, with a comment
-- saying that adding one must EDIT that line and argue for it. The plan seeds its flags together
-- so the pin is edited once: seeding them one per pull request would mean 7→8→9, and each
-- intermediate branch would fail the suite of the one after it. `insights.forecast` was already
-- seeded in `0266`, so this file carries the other two and moves the pin from seven to nine.
--
-- `commerce.benefit_countdown` — the launch-benefit strip in the authenticated shell. Owner ruling
--   of 31.08.2026 on `#204`: a clock over an INVENTED date is forbidden, a window the server
--   enforces is not. The strip renders the date `my_benefit_window()` returns and nothing else, so
--   the switch exists to remove a commercial surface from a tenant without a deploy.
--
-- `documents.recurring_expectations` — seeded ahead of the surface that will read it. A flag with
--   `default_state = false` and no consumer is inert: it turns nothing on, it is off for every
--   tenant, and it costs one row. What it buys is that the item building that surface does not
--   have to move this pin a third time.
--
-- ⚠ AND NEITHER SWITCH STOPS A WRITER. No server routine may read `resolve_feature_flags` — the
-- law, enforced by `p4_flags_identity:202-214` — so a flag turns off a SCREEN. Whatever writes on
-- the server keeps writing, and what stops it is its own state: a column, a `cron.unschedule`, or
-- an explicit refusal. Reading "kill switch" as "nothing happens any more" is the mistake this
-- paragraph exists to prevent.

insert into private.flag_definitions (flag_key, description, risk_level, default_state, kill_switch)
values
  ('commerce.benefit_countdown',
   'The launch-benefit strip in the authenticated shell: what the organisation has, until when, '
   || 'and which plan it reopens on. Off for every tenant until an operator turns it on. Turning '
   || 'it off removes the strip and stops no server writer.',
   'low', false, true),
  ('documents.recurring_expectations',
   'The recurring-document expectations surface. Seeded ahead of its consumer so the flag pin in '
   || 'p4_flags_identity moves once rather than three times; inert until something reads it.',
   'low', false, true)
on conflict (flag_key) do update
  set description = excluded.description,
      risk_level = excluded.risk_level,
      default_state = excluded.default_state,
      kill_switch = excluded.kill_switch;

do $assert_0268$
declare
  v_violations text;
begin
  if (select count(*) from private.flag_definitions
      where flag_key in ('commerce.benefit_countdown', 'documents.recurring_expectations')
        and kill_switch and not default_state) <> 2 then
    raise exception '0268: a flag is missing, is not a kill switch, or ships on';
  end if;

  -- THE HALF THAT IS LOAD-BEARING: no flag ships on globally. One `default_state = true` would
  -- defeat the whole law in a single row.
  if exists (select 1 from private.flag_definitions where default_state) then
    raise exception '0268: a flag ships on globally';
  end if;

  -- Nine, and the suite pins the same number. A flag that slipped in without the pin moving is
  -- the thing that pin exists to catch.
  if (select count(*) from private.flag_definitions) <> 9 then
    raise exception '0268: the flag registry is at % rows, not the nine this migration leaves',
      (select count(*) from private.flag_definitions);
  end if;

  -- §8, re-asserted where a flag is added rather than only where one is read: no routine may
  -- consult the resolver, because a flag that can gate a write is a flag that can lose data.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'resolve_feature_flags'
      and replace(p.prosrc, chr(13), '') like '%resolve_feature_flags%') then
    raise exception '0268: a server routine reads resolve_feature_flags';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0268 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0268$;
