-- 0286 -- the tenant write latch covers every org-owned table, and says so out loud from now on.
--
-- `zz_organization_write_guard` is the trigger that stops a write to a suspended or expired
-- tenant, and it is the ONLY thing standing in front of a `SECURITY DEFINER` function: those run
-- as `service_role` and bypass RLS entirely. `0092` attached it by iterating every `public` table
-- carrying `org_id`, which was correct on the day it ran and correct for every table that existed
-- then. It is not a rule. It is a loop over a snapshot.
--
-- `0140` then created `document_packets` and `document_packet_segments` with `org_id` and did not
-- mention the trigger. Nothing failed. DEBT §41 records the pair being found by hand during a
-- `0141` preflight -- not by a gate -- and puts coverage at 98 of 100 org-owned tables.
--
-- That figure was true on 17.08.2026 and is not true now: the assertion below refused this
-- migration on its first CI run and named FOURTEEN. Twelve more tables had been created in the
-- intervening fortnight, each by a migration that did not mention the trigger, exactly as `0140`
-- had. Nobody re-counted, and nothing existed to tell them to.
--
-- WHY NO GATE SAW IT, WHICH IS THE HALF THAT MATTERS. The assertion existed. It is still there, in
-- `supabase/tests/p22_trial_read_only.sql`, and it says exactly the right thing: no `public` table
-- with `org_id` may lack this trigger. That suite stopped being run by `04533b85`, which retired
-- the trial the rest of the file tests. The suite was unwired wholesale and this assertion — which
-- has nothing to do with trials — went quiet with it. Two years of migrations later nobody noticed,
-- because a check that is never executed produces no signal at all, not even a red one.
--
-- So the assertion moves HERE, into a migration. That is a deliberate promotion, not a copy:
--   * a suite runs when someone remembers to list it; a migration assertion runs every time the
--     schema is built, in CI and locally, and it fails the build rather than a report;
--   * it fires on the migration that INTRODUCES the gap, naming the table, instead of on a
--     preflight months later;
--   * it is the shape `0057` already established for the scope contract (A1/A3/A5) -- structural
--     assertions that fail the migration on contract regression.
--
-- `security_events` stays excluded for the reason `0092` gives: a platform operator whose own
-- tenant has expired must still be able to step up and recover a customer, and that path writes
-- the security ledger. Business rows and audit rows remain guarded.

-- ---------------------------------------------------------------------------------------------
-- 1. The fourteen tables that were left open. The register knew about two of them.
-- ---------------------------------------------------------------------------------------------
-- DEBT §41 named `document_packets` and `document_packet_segments`, and said coverage was 98 of
-- 100. That was true on 17.08.2026, when somebody last counted by hand. The assertion in section 2
-- was added first and refused this migration on its first CI run, naming TWELVE more tables that
-- had appeared since -- document kind resolution, scan provenance, the email delivery ledger and
-- order messages, price-list calibration preparations, the three product-name repair tables,
-- supplier communication preferences, and the four supplier order portal tables. Nobody had
-- re-measured, and nothing would have told them to.
--
-- That is the argument for the assertion in one paragraph: a number in a document decays from the
-- day it is written, and a check that runs decays never.
--
-- Owner ruling 02.09.2026: latch all fourteen. Every one of them holds tenant data, and the write
-- latch is what stops a SECURITY DEFINER function -- which runs as service_role and bypasses RLS
-- outright -- from writing into a suspended or expired tenant. `email_delivery_events` was put to
-- the owner explicitly, because it is a provider webhook ledger and refusing its writes can make a
-- sender retry: the ruling was to latch it with the rest rather than carve out an exemption on a
-- risk nobody has measured. If production later shows a table that genuinely must accept writes
-- while suspended, it becomes a NAMED exemption with a reason -- the shape `0092` used for
-- `security_events` -- and not a quiet hole.
--
-- Written out rather than looped over on purpose: a loop over a snapshot is exactly what `0092`
-- did, and it is why this list exists at all.

create trigger zz_organization_write_guard before insert or update or delete
  on public.document_kind_resolution_history for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.document_packet_segments for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.document_packets for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.document_scan_derivative_provenance for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.email_delivery_events for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.email_order_messages for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.price_list_calibration_preparations for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.product_name_repair_candidates for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.product_name_repair_decisions for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.product_name_repair_runs for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.supplier_communication_preferences for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.supplier_order_links for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.supplier_order_proposal_lines for each row
  execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete
  on public.supplier_order_proposals for each row
  execute function private.organization_row_write_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. The assertion. It fails THIS migration and every future one.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_uncovered text[];
begin
  select array_agg(c.table_name order by c.table_name)
  into v_uncovered
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'org_id'
    and t.table_type = 'BASE TABLE'
    and c.table_name <> 'security_events'
    and not exists (
      select 1
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace schema_row on schema_row.oid = table_row.relnamespace
      where schema_row.nspname = 'public'
        and table_row.relname = c.table_name
        and trigger_row.tgname = 'zz_organization_write_guard'
        and not trigger_row.tgisinternal
    );

  if v_uncovered is not null then
    raise exception
      'A tenant-owned table is missing zz_organization_write_guard: %. '
      'A table with org_id is writable by SECURITY DEFINER functions, which bypass RLS; this '
      'trigger is the only thing that holds the tenant lifecycle latch in front of them. Attach '
      'it in the same migration that creates the table -- see 0137 lines 513-528 -- or, if the '
      'table genuinely must be exempt, extend this assertion with the reason.',
      array_to_string(v_uncovered, ', ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The standing scope assertion every migration after 0057 re-runs (A1/A3/A5).
-- ---------------------------------------------------------------------------------------------
do $assert_0286$
declare
  v_violations text;
begin
  -- The fourteen triggers above must exist and must be the row-level guard, not something merely
  -- wearing the name. Asserted here as well as in section 2 because section 2 proves coverage
  -- across the schema while this proves what THESE tables actually got.
  if (select count(*)
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace schema_row on schema_row.oid = table_row.relnamespace
      join pg_catalog.pg_proc proc_row on proc_row.oid = trigger_row.tgfoid
      join pg_catalog.pg_namespace proc_schema on proc_schema.oid = proc_row.pronamespace
      where schema_row.nspname = 'public'
        and table_row.relname in ('document_kind_resolution_history',
          'document_packet_segments',
          'document_packets',
          'document_scan_derivative_provenance',
          'email_delivery_events',
          'email_order_messages',
          'price_list_calibration_preparations',
          'product_name_repair_candidates',
          'product_name_repair_decisions',
          'product_name_repair_runs',
          'supplier_communication_preferences',
          'supplier_order_links',
          'supplier_order_proposal_lines',
          'supplier_order_proposals')
        and trigger_row.tgname = 'zz_organization_write_guard'
        and not trigger_row.tgisinternal
        and proc_schema.nspname = 'private'
        and proc_row.proname = 'organization_row_write_guard') <> 14 then
    raise exception '0286: not all fourteen tables received private.organization_row_write_guard';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0286 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0286$;
