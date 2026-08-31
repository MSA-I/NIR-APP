-- 0266 — the switch that turns the scheduled-payments card off, and the two things it cannot do.
--
-- The card `0265` feeds is a new surface on a business screen, and a new surface needs a way to
-- disappear without a deploy. `insights.forecast` is that switch: born off for every tenant, a
-- kill switch, and never on globally.
--
-- ⚠ AND IT DOES NOT STOP THE WRITER. No server routine reads `resolve_feature_flags` — that is the
-- law, not an oversight, and it means a flag turns off a SCREEN and never a writer. Turning this
-- one off removes the card and leaves `private.record_forecast_snapshots()` running, which is
-- deliberate: `forecast_snapshots` is the evidence of what was predicted, and without it there is
-- no backtesting to come back to. What stops the writer is `cron.unschedule`, and nothing else.
-- Anyone who reads "kill switch" here and expects the monthly row to stop will be wrong, so it is
-- written down rather than left to be discovered.
--
-- THE FLAG KEY KEEPS THE NAME THE PLAN GAVE IT. `insights.forecast` is an internal identifier and
-- never reaches a screen; the surface it controls says "scheduled payments" in every string a
-- person can see, because it is not a forecast and must not read as one.

insert into private.flag_definitions (flag_key, description, risk_level, default_state, kill_switch)
values (
  'insights.forecast',
  'The scheduled-payments card on the control centre: what carries a due date inside the horizon, '
  || 'with the coverage that figure has. Off for every tenant until an operator turns it on for '
  || 'one. Turning it off removes the card and does NOT stop the monthly snapshot writer, which '
  || 'only cron.unschedule stops.',
  'low',
  false,
  true
)
on conflict (flag_key) do update
  set description = excluded.description,
      risk_level = excluded.risk_level,
      default_state = excluded.default_state,
      kill_switch = excluded.kill_switch;

do $assert_0266$
declare
  v_violations text;
begin
  if not exists (
    select 1 from private.flag_definitions
    where flag_key = 'insights.forecast' and kill_switch and not default_state) then
    raise exception '0266: the flag is missing, is not a kill switch, or ships on';
  end if;

  -- THE HALF THAT IS ACTUALLY LOAD-BEARING, re-asserted here rather than only in the suite: no
  -- flag ships on globally. A `default_state` of true would defeat the whole law in one row.
  if exists (select 1 from private.flag_definitions where default_state) then
    raise exception '0266: a flag ships on globally';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0266 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0266$;
