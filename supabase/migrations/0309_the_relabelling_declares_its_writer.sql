-- 0309 — the relabelling trigger declares its writer, and the history that predates 0308 keeps
-- its runs. Codex review round 3, findings 2 and 8.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 2 (HIGH) — `0307` ROLLED BACK A REAL SAVE, and my proof of it was worthless.
--
-- `p1_financial_command_guard` refuses any user-driven invoice UPDATE unless the transaction has
-- declared itself: `current_setting('app.p1_financial_writer', true) is not distinct from
-- auth.uid()::text`. `0307`'s trigger called `p1_refresh_invoice_payment_statuses` without
-- setting it, so through the real path — an owner saving the settings screen — the refresh raised
-- `financial_command_rpc_required` and **the entire settings write rolled back**. The tolerance
-- change could not be saved at all.
--
-- I DID NOT CATCH IT BECAUSE I PROVED IT ON THE WRONG PATH. My verification ran as `postgres`
-- with no JWT, where `auth.uid()` is null and the guard does not apply. It printed exactly the
-- result I wanted and told me nothing about the code a customer would run. Reproduced through an
-- authenticated owner, the same fixture fails at `private.organizations_relabel_on_tolerance_change`
-- line 20. That is the second time in this review that "measured" meant "measured somewhere the
-- defect could not appear".
--
-- The fix is the pattern every other financial writer already uses — `match_bank_transaction`
-- declares itself the same way before it touches an allocation. `set_config(..., true)` is
-- transaction-local, so the declaration dies with the statement that made it.
--
-- WHAT IS STILL OPEN, and the reviewer is right about it: finding 3 is a genuine MVCC race
-- between a payment writer and a tolerance change, and this does not close it. Two transactions
-- that never see each other can leave the stored label and the derived answer disagreeing, and
-- the drift query would then report it rather than prevent it. Closing that needs a per-org lock
-- shared by every payment writer, or step 3 of the teardown — the column removed and nothing left
-- to disagree. Recorded here rather than implied, and step 3 is the better answer.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 8 (MEDIUM) — `0308` saved new citations and abandoned the old ones.
--
-- `0308` added `route_params` and taught the writer and the snapshot to carry it. It did not
-- touch the rows already stored. A run recorded before it — `route = '/expenses?from=…&to=…'`
-- with no declaration — now meets a shaped rule that demands one, is refused, and takes its whole
-- run out of the history exactly as the un-persisted case did. The migration fixed the future and
-- left the past holding the same defect.
--
-- The repair is to strip the query string from those rows, not to invent a window for them. The
-- window they were issued with is not recoverable from the route alone — a stored
-- `/expenses?from=2026-01-01&to=2026-01-31` tells us what the LINK said and not what the tool
-- measured, and those two disagreeing is the reason finding 9 exists. So the citation keeps its
-- screen and loses its filter: weaker, honest, and the run survives.

do $patch_relabel_0309$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.organizations_relabel_on_tolerance_change()'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('p1_financial_writer' in v_definition) > 0 then
    return; -- already declared; this migration is being re-applied
  end if;

  v_anchor := $anchor$  perform public.p1_refresh_invoice_payment_statuses(new.id, v_ids);$anchor$;
  v_replacement := $replacement$  -- DECLARE THE WRITER. `p1_financial_command_guard` refuses a user-driven invoice update unless
  -- the transaction says who is making it, so without this line an owner saving the settings
  -- screen got `financial_command_rpc_required` and lost the save entirely. Transaction-local, so
  -- the declaration ends with the statement that made it. `auth.uid()` is null for a migration or
  -- a service caller, and the guard already lets those through, so the empty string is correct
  -- rather than a hole.
  perform set_config('app.p1_financial_writer', coalesce(auth.uid()::text, ''), true);
  perform public.p1_refresh_invoice_payment_statuses(new.id, v_ids);$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0309: relabel refresh anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_relabel_0309$;

-- CORRECTED IN PLACE, 03.09.2026, and the reason is stated because the constitution forbids this
-- by default. The first version stripped the query string from EVERY citation carrying one, and
-- only `/expenses` has a shaped rule that needs a declaration. So it turned a perfectly good
-- `/orders?status=sent` into `/orders` — which is not allowlisted at all, dropping the very run it
-- claimed to save — and `/prices?increases=1` into `/prices`, which still resolves but shows a
-- different and wider population than the claim it cites. Both were found by round 4 of the
-- review; the claim that "the run survives" was false for exactly the rows it touched.
--
-- Forward-only exists to stop an INSTALLED database diverging from the migration set. This one has
-- never been installed anywhere but a developer's local stack, and a follow-up migration cannot
-- repair it: once a query string is stripped it is not recoverable from the row. Leaving the file
-- as written would destroy those citations on every fresh install, including production's first.
-- So the statement is narrowed here, and the local rows it already stripped are demo data whose
-- query strings are gone.
update public.assistant_source_references
set route = split_part(route, '?', 1)
where route_params is null
  and route is not null
  -- ONLY the shaped route. An exact or entity-param route does not read `route_params`, is not
  -- refused for lacking one, and must keep the filter it was issued with.
  and route like '/expenses?%';

do $assert_0309$
declare
  v_violations text;
  v_stranded integer;
begin
  if position('p1_financial_writer' in (select prosrc from pg_proc
       where oid = 'private.organizations_relabel_on_tolerance_change()'::regprocedure)) = 0 then
    raise exception '0309: the relabelling trigger still does not declare its writer';
  end if;

  select count(*) into v_stranded
  from public.assistant_source_references
  where route_params is null and route is not null and route like '/expenses?%';
  if v_stranded <> 0 then
    raise exception '0309: % shaped citation(s) still carry a filter with no declaration',
      v_stranded;
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0309 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0309$;
