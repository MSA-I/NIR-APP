-- 0196 -- Abandoned self-signup: a report that writes nothing, a deterministic emptiness
-- predicate, an inert reminder ledger, a locked server-only cleanup for empty organizations and
-- a quarantine queue for organizations that actually did something (OPEN-DECISIONS #175,
-- decided 21.08-22.08.2026).
--
-- WHAT #175 DECIDED, AND WHAT IT DID NOT. Decided: an EMPTY organization whose owner never
-- confirmed their address is removed after 30 days; an organization with business activity is
-- never removed automatically and goes to a Platform Admin queue; reminders on day 7 and three
-- days before; the cleanup locks and re-checks owner and activity; the retained audit is
-- minimal and carries no raw PII. NOT decided, and therefore not invented here: a fourth
-- org_status value. `org_status` is enum ('trial','active','suspended') (0006:34) and `trial` is
-- already retired (0134), so it is a shrinking surface. Quarantine is modelled as its own queue
-- table below.
--
-- THE DANGEROUS PART IS NOT THE DELETE, IT IS THE PREDICATE. "We deleted an empty organization"
-- is fine. "The emptiness predicate did not know about a table" is total, irreversible data
-- loss for a real customer. So the predicate is:
--   * derived from the live catalogue, not from a list someone maintains by hand;
--   * FAIL-SAFE -- a table nobody classified counts as EVIDENCE, so an unreviewed table blocks
--     deletion instead of being skipped;
--   * accompanied by a completeness sweep (p75) that fails loudly when a table is unclassified,
--     so the fail-safe never becomes a quiet habit.
--
-- NO EMAIL PROVIDER EXISTS. Resend is SELECTED / DOMAIN_NOT_VERIFIED / SMTP_NOT_CONFIGURED /
-- NOT_LIVE (#236). The reminder ledger, the due-date arithmetic and the dispatch seam are built;
-- the send is not, and the dispatch command CANNOT record a success. A ledger that can say
-- "sent" when nothing was sent is a lie a later wave will trust.

-- =====================================================================================
-- 1. The activity-evidence registry
-- =====================================================================================
-- Platform vocabulary, schema `private` (the scope_registry precedent, 0054:97-101). Every
-- public table carrying org_id is classified explicitly. `not_evidence` is the short list, and
-- every one of those seven was MEASURED, not assumed: inserting an organization plus one owner
-- profile into this schema populates exactly audit_logs, org_units, organization_subscriptions,
-- profiles, user_scope_closure and user_scope_grants through triggers, and the signup path
-- (supabase/functions/_shared/provision.ts:51,155) seeds one default category. #175 names the
-- seed as part of what a cleanup removes.
create table private.org_activity_evidence_registry (
  table_name  text primary key,
  disposition text not null check (disposition in ('evidence', 'not_evidence')),
  rationale   text not null check (length(trim(rationale)) >= 20)
);
revoke all on table private.org_activity_evidence_registry
  from public, anon, authenticated, service_role;

insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
select entry.table_name, 'not_evidence', entry.rationale
from (values
  ('profiles',
   'The owner profile is created by signup itself; its existence proves nothing was used.'),
  ('org_units',
   'The default unit chain is created by the 0054 trigger at organization creation.'),
  ('user_scope_grants',
   'The root scope grant is created by the same 0054 trigger, not by a person.'),
  ('user_scope_closure',
   'Derived from user_scope_grants and resynced by trigger; never written by a person.'),
  ('organization_subscriptions',
   'The default subscription row is created by the organizations insert trigger.'),
  ('audit_logs',
   'Creation-time rows are written by the platform about the creation, not by the tenant.'),
  ('categories',
   'Signup seeds one default category; #175 names the seed as part of what cleanup removes.')
) as entry(table_name, rationale);

insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
select entry.table_name, 'evidence',
       'Tenant business record: a row here exists only because somebody used the product.'
from (values
  ('approval_policy_configurations'),
  ('assistant_action_proposals'),
  ('assistant_conversations'),
  ('assistant_facts'),
  ('assistant_feedback'),
  ('assistant_messages'),
  ('assistant_runs'),
  ('assistant_source_references'),
  ('assistant_tool_calls'),
  ('bank_allocations'),
  ('bank_imports'),
  ('bank_transactions'),
  ('comments'),
  ('consolidated_invoice_cases'),
  ('consolidated_invoice_intake_pages'),
  ('consolidated_invoice_intakes'),
  ('consolidated_invoice_revisions'),
  ('consolidated_invoice_snapshots'),
  ('consolidated_invoice_sources'),
  ('credit_requests'),
  ('customer_accounts'),
  ('customer_contacts'),
  ('customer_internal_notes'),
  ('customer_onboarding_steps'),
  ('delivery_note_interpretation_decisions'),
  ('delivery_note_interpretation_lines'),
  ('document_annotations'),
  ('document_auto_actions'),
  ('document_export_template_versions'),
  ('document_export_templates'),
  ('document_exports'),
  ('document_extractions'),
  ('document_feedback'),
  ('document_filings'),
  ('document_interpretations'),
  ('document_learning_rules'),
  ('document_packet_segments'),
  ('document_packets'),
  ('document_processing_jobs'),
  ('document_review_applications'),
  ('document_review_corrections'),
  ('document_rule_applications'),
  ('document_scan_decisions'),
  ('document_scan_jobs'),
  ('document_scan_outputs'),
  ('document_type_review_decisions'),
  ('documents'),
  ('domain_events'),
  ('email_order_messages'),
  ('exceptions'),
  ('external_identity_mappings'),
  ('external_references'),
  ('feedback_notes'),
  ('goods_receipt_items'),
  ('goods_receipts'),
  ('identity_provider_settings'),
  ('integration_failures'),
  ('inventory_movements'),
  ('invitations'),
  ('invoice_line_evidence_batches'),
  ('invoice_line_match_sets'),
  ('invoice_line_matches'),
  ('invoice_lines'),
  ('invoice_order_links'),
  ('invoice_receipt_links'),
  ('invoice_three_way_approval_snapshots'),
  ('invoice_three_way_overrides'),
  ('invoices'),
  ('monthly_exports'),
  ('monthly_report_snapshot_deliveries'),
  ('monthly_report_snapshots'),
  ('next_order_items'),
  ('notification_event_states'),
  ('notification_preferences'),
  ('notifications'),
  ('org_assistant_policies'),
  ('org_autonomy_policies'),
  ('org_flag_configurations'),
  ('organization_entitlement_overrides'),
  ('organization_offboarding_requests'),
  ('payment_allocations'),
  ('payment_request_invoices'),
  ('payment_requests'),
  ('payments'),
  ('platform_lifecycle_events'),
  ('price_history'),
  ('price_list_automation_scope_decisions'),
  ('price_list_calibration_reviews'),
  ('price_list_empty_run_reviews'),
  ('price_list_interpretation_decisions'),
  ('price_list_interpretation_lines'),
  ('price_list_shadow_lines'),
  ('price_list_shadow_runs'),
  ('products'),
  ('purchase_order_items'),
  ('purchase_orders'),
  ('purchase_request_items'),
  ('purchase_requests'),
  ('push_subscriptions'),
  ('saved_views'),
  ('security_events'),
  ('supplier_categories'),
  ('supplier_communication_preferences'),
  ('supplier_order_links'),
  ('supplier_order_proposal_lines'),
  ('supplier_order_proposals'),
  ('supplier_price_document_upload_reservations'),
  ('supplier_price_submission_intakes'),
  ('supplier_price_submissions'),
  ('supplier_products'),
  ('suppliers'),
  ('webhook_subscriptions'),
  ('whatsapp_connections'),
  ('whatsapp_order_messages'),
  ('whatsapp_webhook_events')
) as entry(table_name);

comment on table private.org_activity_evidence_registry is
  'Which tables count as evidence that an organization did business (#175). Unclassified is '
  'treated as evidence at runtime -- an unreviewed table blocks deletion rather than being missed.';

-- The completeness sweep. p75 asserts it is empty and proves it fires.
-- Returns the offending table_name as its own column on purpose: a caller must be able to
-- exclude a specific known-foreign name without a pattern (see p75's contamination block).
create function private.org_activity_registry_violations()
returns table (detail text, table_name text)
language sql
stable
set search_path = public, pg_catalog
as $$
  select 'unclassified activity table: ' || table_info.table_name, table_info.table_name::text
  from information_schema.tables table_info
  where table_info.table_schema = 'public' and table_info.table_type = 'BASE TABLE'
    and exists (
      select 1 from information_schema.columns org_column
      where org_column.table_schema = 'public'
        and org_column.table_name = table_info.table_name
        and org_column.column_name = 'org_id')
    and not exists (
      select 1 from private.org_activity_evidence_registry registry
      where registry.table_name = table_info.table_name)
  union all
  select 'stale activity registry row: ' || registry.table_name, registry.table_name
  from private.org_activity_evidence_registry registry
  where not exists (
    select 1 from information_schema.columns org_column
    where org_column.table_schema = 'public'
      and org_column.table_name = registry.table_name
      and org_column.column_name = 'org_id')
$$;
revoke all on function private.org_activity_registry_violations()
  from public, anon, authenticated, service_role;

-- =====================================================================================
-- 2. The predicates
-- =====================================================================================
-- Owner verification is a fact about auth.users, not about anything the tenant can write.
create function private.organization_owner_verified(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles member
    join auth.users account on account.id = member.id
    where member.org_id = p_org_id
      and member.role = 'owner'
      and member.active
      and account.email_confirmed_at is not null
  )
$$;
revoke all on function private.organization_owner_verified(uuid)
  from public, anon, authenticated, service_role;

-- Fail-safe by construction: the disposition of a table nobody classified resolves to
-- 'evidence', so an unreviewed table makes the organization undeletable instead of invisible.
-- Table names live in DATA and reach the query through format(%I) -- keeping them out of this
-- body is the 0063/0066 discipline that also keeps the A5 marker scan honest.
create function private.organization_has_business_activity(p_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_table record;
  v_rows  bigint;
begin
  if p_org_id is null then
    return true;
  end if;
  for v_table in
    select candidate.relname::text as table_name
    from pg_catalog.pg_class candidate
    join pg_catalog.pg_namespace space on space.oid = candidate.relnamespace
    where space.nspname = 'public' and candidate.relkind = 'r'
      and exists (
        select 1 from pg_catalog.pg_attribute column_info
        where column_info.attrelid = candidate.oid and column_info.attname = 'org_id'
          and column_info.attnum > 0 and not column_info.attisdropped)
      and coalesce((
        select registry.disposition
        from private.org_activity_evidence_registry registry
        where registry.table_name = candidate.relname), 'evidence') = 'evidence'
    order by candidate.relname
  loop
    execute format('select count(*) from public.%I where org_id = $1', v_table.table_name)
      into v_rows using p_org_id;
    if v_rows > 0 then
      return true;
    end if;
  end loop;
  return false;
end
$$;
revoke all on function private.organization_has_business_activity(uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_has_business_activity(uuid) is
  'True when the organization holds a row in any table classified as evidence, OR in any table '
  'nobody classified. Unclassified counts as evidence on purpose (#175).';

-- =====================================================================================
-- 3. Staged, dependency-safe tenant deletion (shared with the 0197 purge executor)
-- =====================================================================================
-- A bare `delete from organizations` is not a staged delete; it is an unaudited cascade whose
-- extent nobody recorded. It also does not work: profiles_org_id_fkey is RESTRICT, so the bare
-- form fails immediately (measured 23.08.2026).
--
-- The order is derived from the live foreign-key graph rather than written down, so a table
-- added by a later migration is ordered correctly without anyone remembering. Kahn from the
-- leaves: a table may be emptied once nothing still-unemptied refers to it. Tables left over
-- are in a reference cycle -- there are real ones in this schema (an export template points at
-- its active version and the version points back at the template) -- and they are handled by
-- nulling the nullable side first.
-- Platform evidence that must OUTLIVE the tenant it describes. Every row here is a table that
-- carries org_id and is nevertheless not tenant data: it is the platform's own record of what it
-- did to that tenant, and deleting it with the tenant would destroy the only proof the deletion
-- was authorized and bounded. Explicit, with a rationale, and asserted by name in p75 -- an
-- exclusion is the one mechanism in this file that could quietly retain real tenant data, so it
-- is never a pattern and never a schema-level skip.
create table private.tenant_delete_exclusions (
  schema_name text not null,
  table_name  text not null,
  rationale   text not null check (length(trim(rationale)) >= 20),
  primary key (schema_name, table_name)
);
revoke all on table private.tenant_delete_exclusions
  from public, anon, authenticated, service_role;

insert into private.tenant_delete_exclusions (schema_name, table_name, rationale) values
  ('private', 'abandoned_signup_cleanup_log',
   'The minimal non-PII record #175 requires to be retained after the organization is removed.');

-- The graph, as two pure catalogue reads. No temporary tables: a stable function may not
-- create one, and a helper that leaves state behind between calls in the same transaction is a
-- trap for the second caller.
create function private.tenant_delete_graph_nodes()
returns table (node text, schema_name text, table_name text)
language sql
stable
set search_path = public, pg_catalog
as $$
  select space.nspname || '.' || candidate.relname, space.nspname::text, candidate.relname::text
  from pg_catalog.pg_class candidate
  join pg_catalog.pg_namespace space on space.oid = candidate.relnamespace
  where candidate.relkind = 'r' and space.nspname in ('public', 'private')
    and exists (
      select 1 from pg_catalog.pg_attribute column_info
      where column_info.attrelid = candidate.oid and column_info.attname = 'org_id'
        and column_info.attnum > 0 and not column_info.attisdropped)
    and not exists (
      select 1 from private.tenant_delete_exclusions excluded
      where excluded.schema_name = space.nspname and excluded.table_name = candidate.relname)
$$;
revoke all on function private.tenant_delete_graph_nodes()
  from public, anon, authenticated, service_role;

create function private.tenant_delete_graph_edges()
returns table (child text, parent text)
language sql
stable
set search_path = public, pg_catalog
as $$
  select distinct child_space.nspname || '.' || child_rel.relname,
                  parent_space.nspname || '.' || parent_rel.relname
  from pg_catalog.pg_constraint reference
  join pg_catalog.pg_class child_rel on child_rel.oid = reference.conrelid
  join pg_catalog.pg_namespace child_space on child_space.oid = child_rel.relnamespace
  join pg_catalog.pg_class parent_rel on parent_rel.oid = reference.confrelid
  join pg_catalog.pg_namespace parent_space on parent_space.oid = parent_rel.relnamespace
  where reference.contype = 'f' and reference.conrelid <> reference.confrelid
    and exists (select 1 from private.tenant_delete_graph_nodes() candidate
                where candidate.node = child_space.nspname || '.' || child_rel.relname)
    and exists (select 1 from private.tenant_delete_graph_nodes() candidate
                where candidate.node = parent_space.nspname || '.' || parent_rel.relname)
$$;
revoke all on function private.tenant_delete_graph_edges()
  from public, anon, authenticated, service_role;

create function private.tenant_delete_stages()
returns table (stage integer, schema_name text, table_name text)
language plpgsql
stable
set search_path = public, pg_catalog
as $$
declare
  v_assigned text[] := '{}';
  v_batch    text[];
  v_stage    integer := 0;
begin
  loop
    select array_agg(available.node) into v_batch
    from private.tenant_delete_graph_nodes() available
    where available.node <> all(v_assigned)
      and not exists (
        select 1 from private.tenant_delete_graph_edges() reference
        where reference.parent = available.node
          and reference.child <> all(v_assigned));
    exit when v_batch is null;
    v_stage := v_stage + 1;
    return query
      select v_stage, present.schema_name, present.table_name
      from private.tenant_delete_graph_nodes() present
      where present.node = any(v_batch)
      order by present.node;
    v_assigned := v_assigned || v_batch;
  end loop;

  -- Whatever is left is in a reference cycle -- there are real ones in this schema (an export
  -- template points at its active version and the version points back). One stage, after
  -- everything acyclic, and the nullable side of the cycle is emptied first by the caller.
  v_stage := v_stage + 1;
  return query
    select v_stage, present.schema_name, present.table_name
    from private.tenant_delete_graph_nodes() present
    where present.node <> all(v_assigned)
    order by present.node;
end
$$;
revoke all on function private.tenant_delete_stages()
  from public, anon, authenticated, service_role;

-- The nullable references that let a cycle be broken: a nullable foreign key from one tenant
-- table to another can be emptied without losing anything the delete was not about to destroy.
create function private.tenant_delete_cycle_breakers()
returns table (schema_name text, table_name text, column_names text[])
language sql
stable
set search_path = public, pg_catalog
as $$
  with node as (
    select candidate.oid, space.nspname::text as schema_name, candidate.relname::text as table_name
    from pg_catalog.pg_class candidate
    join pg_catalog.pg_namespace space on space.oid = candidate.relnamespace
    where candidate.relkind = 'r' and space.nspname in ('public', 'private')
      and exists (
        select 1 from pg_catalog.pg_attribute column_info
        where column_info.attrelid = candidate.oid and column_info.attname = 'org_id'
          and column_info.attnum > 0 and not column_info.attisdropped)
  )
  select child.schema_name, child.table_name,
         array_agg(distinct attribute.attname::text) as column_names
  from pg_catalog.pg_constraint reference
  join node child on child.oid = reference.conrelid
  join node parent on parent.oid = reference.confrelid
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = reference.conrelid
   and attribute.attnum = any(reference.conkey)
  where reference.contype = 'f'
  group by child.schema_name, child.table_name, reference.oid
  having bool_and(not attribute.attnotnull)
$$;
revoke all on function private.tenant_delete_cycle_breakers()
  from public, anon, authenticated, service_role;

-- Empties one organization, stage by stage, and returns what it removed as a table -> count
-- map. It does NOT delete the organizations row: the caller owns that decision and the audit
-- around it. It refuses to return at all if any tenant row survives -- an orphan is a bug in
-- the ordering, not something to discover later.
create function private.delete_tenant_rows(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target    record;
  v_rows      bigint;
  v_pass      integer;
  v_pass_rows bigint;
  v_result    jsonb := '{}'::jsonb;
  v_left      text;
begin
  if p_org_id is null then
    raise exception 'tenant_delete_target_missing' using errcode = '22023';
  end if;
  -- THREE EXISTING FENCES HAVE TO BE SATISFIED, and they are satisfied by NAME rather than by
  -- weakening anything. All three are transaction-local and stay set for the caller's own final
  -- `delete from organizations`, which is where the last of them is actually needed.
  --
  -- 1. p1_financial_command_guard (0033:5) -- a BEFORE trigger on eighteen tables that refuses an
  --    end-user write which did not arrive through a named command. This IS a named command.
  perform set_config('app.p1_financial_writer', coalesce(auth.uid()::text, ''), true);
  -- 2. organization_row_write_guard (0103:2227) -- on 116 tenant tables (measured). It refuses
  --    every write to an organization whose access mode is not active, which is EXACTLY the
  --    state a purge target is in. Its existing platform-admin lever is the one a purge belongs
  --    to: set_organization_lifecycle uses the same GUC for the same reason.
  perform set_config('app.organization_lifecycle_writer', coalesce(auth.uid()::text, ''), true);
  -- 3. The same guard again, for the audit row that private.audit_organizations_change writes
  --    AFTER the organizations row is gone: at that instant organization_access_mode reads the
  --    missing row as 'suspended', so the insert into audit_logs is refused. The service-role
  --    lever (0103) covers audit_logs specifically and is the one a service-role cleanup has.
  perform set_config('app.organization_offboarding_writer_org', p_org_id::text, true);

  -- Break reference cycles first: null the nullable side, then the stages become deletable.
  for v_target in
    select breaker.schema_name, breaker.table_name, breaker.column_names
    from private.tenant_delete_cycle_breakers() breaker
    order by breaker.schema_name, breaker.table_name
  loop
    execute format('update %I.%I set %s where org_id = $1',
      v_target.schema_name, v_target.table_name,
      (select string_agg(format('%I = null', column_name), ', ')
       from unnest(v_target.column_names) as column_name))
      using p_org_id;
  end loop;

  -- MEASURED 23.08.2026: one stage pass is not enough. audit_row_change is an AFTER DELETE
  -- trigger on many of these tables, so emptying them WRITES four fresh audit rows after
  -- audit_logs' own stage has already run. The pass therefore repeats until a whole pass
  -- removes nothing -- the ordering is still the foreign-key one, and the loop is bounded so a
  -- trigger that generated rows forever would fail loudly at the orphan check below rather than
  -- spin. This is exactly the condition the orphan check exists to catch, and it caught it.
  for v_pass in 1..8 loop
    v_pass_rows := 0;
    for v_target in
      select stages.stage, stages.schema_name, stages.table_name
      from private.tenant_delete_stages() stages
      order by stages.stage, stages.schema_name, stages.table_name
    loop
      execute format('delete from %I.%I where org_id = $1',
        v_target.schema_name, v_target.table_name) using p_org_id;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        v_pass_rows := v_pass_rows + v_rows;
        v_result := v_result || jsonb_build_object(
          v_target.schema_name || '.' || v_target.table_name,
          coalesce((v_result ->> (v_target.schema_name || '.' || v_target.table_name))::bigint, 0)
            + v_rows);
      end if;
    end loop;
    exit when v_pass_rows = 0;
  end loop;

  -- No stage may leave an orphan.
  for v_target in
    select stages.schema_name, stages.table_name
    from private.tenant_delete_stages() stages
  loop
    execute format('select count(*) from %I.%I where org_id = $1',
      v_target.schema_name, v_target.table_name) into v_rows using p_org_id;
    if v_rows > 0 then
      v_left := coalesce(v_left || ', ', '')
        || v_target.schema_name || '.' || v_target.table_name || '=' || v_rows;
    end if;
  end loop;
  if v_left is not null then
    raise exception 'tenant_delete_orphans_remain: %', v_left using errcode = '23503';
  end if;

  return v_result;
end
$$;
revoke all on function private.delete_tenant_rows(uuid)
  from public, anon, authenticated, service_role;

-- Removing the organization row itself, and the one record that would otherwise outlive it.
-- MEASURED 23.08.2026: private.audit_organizations_change is an AFTER DELETE trigger that writes
-- to_jsonb(old) -- the WHOLE organization row -- into audit_logs, and audit_logs carries no
-- foreign key, so that copy survives the tenant it describes. #175 requires the retained record
-- to be minimal and free of raw personal data, and #261 keeps its evidence in the purge
-- manifest; both callers write their own minimal record BEFORE calling this.
create function private.delete_tenant_organization_row(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.organizations where id = p_org_id;
  delete from public.audit_logs where org_id = p_org_id;
end
$$;
revoke all on function private.delete_tenant_organization_row(uuid)
  from public, anon, authenticated, service_role;

comment on function private.delete_tenant_rows(uuid) is
  'Stage-ordered tenant row deletion derived from the live foreign-key graph (#175, #261). '
  'Never deletes the organizations row; refuses to return while any tenant row survives.';

-- =====================================================================================
-- 4. The reminder ledger -- built, and inert
-- =====================================================================================
-- Holds no address. #173's neutral-answer rule exists because confirming that an address was
-- used to sign up is itself a disclosure; a reminder ledger keyed on the address would be that
-- disclosure sitting in a table. The address is resolved from auth.users at dispatch time and
-- is never copied here.
create table private.abandoned_signup_reminders (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  reminder_kind       text not null check (reminder_kind in ('day_7', 'final_3_days')),
  due_at              timestamptz not null,
  state               text not null default 'pending'
    check (state in ('pending', 'not_sent', 'sent')),
  provider            text,
  provider_message_id text,
  not_sent_reason     text,
  attempted_at        timestamptz,
  created_at          timestamptz not null default statement_timestamp(),
  unique (org_id, reminder_kind),
  -- A success state is unrepresentable without a provider AND an identifier the provider
  -- returned. No provider exists (#236), so no row can honestly reach 'sent'.
  constraint abandoned_signup_reminders_sent_needs_provider check (
    state <> 'sent' or (provider is not null and provider_message_id is not null)),
  constraint abandoned_signup_reminders_not_sent_needs_reason check (
    state <> 'not_sent' or not_sent_reason is not null)
);
revoke all on table private.abandoned_signup_reminders
  from public, anon, authenticated, service_role;
create index abandoned_signup_reminders_due_idx
  on private.abandoned_signup_reminders (state, due_at) where state = 'pending';

comment on table private.abandoned_signup_reminders is
  'Day-7 and three-days-before reminder ledger for unverified signups (#175). No address is '
  'stored. No code path can record a successful send while no provider is configured (#236).';

-- The provider handle. It resolves to NULL today and is expected to: #236 records Resend as
-- SELECTED / DOMAIN_NOT_VERIFIED / SMTP_NOT_CONFIGURED / NOT_LIVE. It exists so the refusal
-- below has something honest to refuse ON, rather than a hardcoded false.
create function private.auth_email_provider()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(trim(coalesce(current_setting('app.auth_email_provider', true), '')), '')
$$;
revoke all on function private.auth_email_provider()
  from public, anon, authenticated, service_role;

create function private.enqueue_abandoned_signup_reminders(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_at timestamptz;
  v_added      integer := 0;
begin
  select created_at into v_created_at from public.organizations where id = p_org_id;
  if v_created_at is null then
    return 0;
  end if;
  -- Day 7, and three days before the thirty-day boundary #175 fixed.
  insert into private.abandoned_signup_reminders (org_id, reminder_kind, due_at)
  values (p_org_id, 'day_7', v_created_at + interval '7 days'),
         (p_org_id, 'final_3_days', v_created_at + interval '27 days')
  on conflict (org_id, reminder_kind) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end
$$;
revoke all on function private.enqueue_abandoned_signup_reminders(uuid)
  from public, anon, authenticated, service_role;

create function public.service_enqueue_abandoned_signup_reminders(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   record;
  v_added integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  for v_org in
    select organization.id
    from public.organizations organization
    where not private.organization_owner_verified(organization.id)
    order by organization.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 1000)
  loop
    v_added := v_added + private.enqueue_abandoned_signup_reminders(v_org.id);
  end loop;
  return v_added;
end
$$;
revoke all on function public.service_enqueue_abandoned_signup_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.service_enqueue_abandoned_signup_reminders(integer)
  to service_role;

-- The dispatch seam. It is deliberately incapable of recording a success: there is no send in
-- this migration, and there is no provider to send through. Both refusals are recorded by name
-- so a later wave can tell "we never had a provider" from "we had one and did not wire it".
create function public.service_dispatch_abandoned_signup_reminder(p_reminder_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reminder private.abandoned_signup_reminders;
  v_reason   text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_reminder from private.abandoned_signup_reminders
  where id = p_reminder_id for update;
  if not found then
    raise exception 'signup_reminder_unknown' using errcode = 'P0002';
  end if;
  if v_reminder.due_at > now() then
    raise exception 'signup_reminder_not_due' using errcode = '22023';
  end if;
  if private.organization_owner_verified(v_reminder.org_id) then
    v_reason := 'owner_verified';
  elsif private.auth_email_provider() is null then
    v_reason := 'provider_unconfigured';
  else
    -- A provider handle exists, and this migration still has no send. Saying so is the only
    -- honest outcome; the alternative is a ledger row claiming a delivery that never happened.
    v_reason := 'provider_send_not_implemented';
  end if;

  update private.abandoned_signup_reminders
  set state = 'not_sent', not_sent_reason = v_reason, attempted_at = statement_timestamp()
  where id = v_reminder.id;

  return jsonb_build_object('state', 'not_sent', 'reason', v_reason);
end
$$;
revoke all on function public.service_dispatch_abandoned_signup_reminder(uuid)
  from public, anon, authenticated;
grant execute on function public.service_dispatch_abandoned_signup_reminder(uuid)
  to service_role;

-- =====================================================================================
-- 5. The quarantine queue -- an organization that DID something is never auto-removed
-- =====================================================================================
create table private.organization_quarantine_queue (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  reason_code  text not null check (reason_code in ('abandoned_signup_with_activity')),
  opened_at    timestamptz not null default statement_timestamp(),
  resolved_at  timestamptz,
  resolved_by  uuid,
  resolution   text check (resolution in ('released', 'escalated')),
  resolution_reason text,
  constraint organization_quarantine_resolution_shape check (
    (resolved_at is null and resolved_by is null and resolution is null
     and resolution_reason is null)
    or (resolved_at is not null and resolved_by is not null and resolution is not null
        and length(trim(coalesce(resolution_reason, ''))) > 0))
);
revoke all on table private.organization_quarantine_queue
  from public, anon, authenticated, service_role;
create unique index organization_quarantine_open_idx
  on private.organization_quarantine_queue (org_id) where resolved_at is null;

comment on table private.organization_quarantine_queue is
  'Organizations whose owner never confirmed but that hold business activity (#175). A queue, '
  'not a fourth org_status: #175 does not authorize extending the enum.';

create function private.open_abandoned_signup_quarantine(p_org_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into private.organization_quarantine_queue (org_id, reason_code)
  select p_org_id, 'abandoned_signup_with_activity'
  where not exists (
    select 1 from private.organization_quarantine_queue existing
    where existing.org_id = p_org_id and existing.resolved_at is null)
$$;
revoke all on function private.open_abandoned_signup_quarantine(uuid)
  from public, anon, authenticated, service_role;

-- The queue filler. An organization past the thirty-day boundary whose owner never confirmed
-- and that holds business activity is a case for a person, not for a delete: this command only
-- opens the entry. It has no delete path at all.
create function public.service_quarantine_abandoned_signups(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    record;
  v_opened integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  for v_org in
    select organization.id
    from public.organizations organization
    where organization.created_at < now() - interval '30 days'
      and not private.organization_owner_verified(organization.id)
    order by organization.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 1000)
  loop
    if private.organization_has_business_activity(v_org.id) then
      perform private.open_abandoned_signup_quarantine(v_org.id);
      v_opened := v_opened + 1;
    end if;
  end loop;
  return v_opened;
end
$$;
revoke all on function public.service_quarantine_abandoned_signups(integer)
  from public, anon, authenticated;
grant execute on function public.service_quarantine_abandoned_signups(integer) to service_role;

-- =====================================================================================
-- 6. The retained cleanup record -- minimal, and free of PII by construction
-- =====================================================================================
-- Everything about the organization dies with it, so the only surviving trace has to live
-- outside the cascade: no organizations foreign key, deliberately. #175 requires the retained
-- audit to be minimal and to carry no raw PII, so this table has no column that could hold a
-- name, an address or a phone number -- what it holds is an identifier, two timestamps and a
-- count map.
create table private.abandoned_signup_cleanup_log (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null,
  org_created_at     timestamptz not null,
  days_since_signup  integer not null check (days_since_signup >= 0),
  deleted_at         timestamptz not null default statement_timestamp(),
  removed_row_counts jsonb not null check (jsonb_typeof(removed_row_counts) = 'object')
);
revoke all on table private.abandoned_signup_cleanup_log
  from public, anon, authenticated, service_role;

comment on table private.abandoned_signup_cleanup_log is
  'The only trace an abandoned-signup cleanup leaves (#175): identifier, dates and row counts. '
  'No name, no address, no phone -- not redacted, structurally absent.';

-- =====================================================================================
-- 7. The report -- read-only by construction
-- =====================================================================================
-- STABLE, not VOLATILE: PostgreSQL refuses INSERT/UPDATE/DELETE inside a non-volatile function
-- at runtime, so "the report cannot write" is a property of the declaration rather than a
-- promise about the body. The platform guard sits inside the WHERE (the 0159:160-166 shape).
create function public.platform_abandoned_signup_candidates(p_older_than_days integer default 30)
returns table (
  org_id            uuid,
  organization_name text,
  created_at        timestamptz,
  days_since_signup integer,
  owner_verified    boolean,
  has_activity      boolean,
  disposition       text,
  quarantined        boolean,
  reminders_pending  bigint,
  reminders_not_sent bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select organization.id,
         organization.name,
         organization.created_at,
         floor(extract(epoch from (now() - organization.created_at)) / 86400)::integer,
         false,
         candidate.activity,
         case when candidate.activity then 'quarantine_required'
              else 'empty_cleanup_eligible' end,
         exists (
           select 1 from private.organization_quarantine_queue queued
           where queued.org_id = organization.id and queued.resolved_at is null),
         coalesce(reminder.pending, 0),
         coalesce(reminder.not_sent, 0)
  from public.organizations organization
  cross join lateral (
    select private.organization_has_business_activity(organization.id) as activity
  ) candidate
  left join lateral (
    -- Deliberately no success counter. There is no provider (#236), so a column claiming
    -- deliveries would be a number nobody can produce honestly; the ledger's own constraint
    -- makes the success state unrepresentable and p75 asserts no routine can write it.
    select count(*) filter (where state = 'pending') as pending,
           count(*) filter (where state = 'not_sent') as not_sent
    from private.abandoned_signup_reminders reminder_row
    where reminder_row.org_id = organization.id
  ) reminder on true
  where public.is_platform_admin()
    and public.platform_has_capability('customer.view')
    and not private.organization_owner_verified(organization.id)
    and organization.created_at
        < now() - make_interval(days => least(greatest(coalesce(p_older_than_days, 30), 1), 3650))
  order by organization.created_at
$$;
revoke all on function public.platform_abandoned_signup_candidates(integer)
  from public, anon, service_role;
grant execute on function public.platform_abandoned_signup_candidates(integer) to authenticated;

create function public.platform_quarantine_queue()
returns table (
  id          uuid,
  org_id      uuid,
  organization_name text,
  reason_code text,
  opened_at   timestamptz,
  resolved_at timestamptz,
  resolution  text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select queued.id, queued.org_id, organization.name, queued.reason_code,
         queued.opened_at, queued.resolved_at, queued.resolution
  from private.organization_quarantine_queue queued
  join public.organizations organization on organization.id = queued.org_id
  where public.is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by queued.opened_at desc
$$;
revoke all on function public.platform_quarantine_queue() from public, anon, service_role;
grant execute on function public.platform_quarantine_queue() to authenticated;

create function public.platform_resolve_quarantine(
  p_queue_id uuid,
  p_resolution text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_actor is null or not public.is_platform_admin()
     or not public.platform_has_capability('customer.edit') then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_resolution not in ('released', 'escalated') or v_reason is null then
    raise exception 'quarantine_resolution_invalid' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();
  update private.organization_quarantine_queue
  set resolved_at = statement_timestamp(), resolved_by = v_actor,
      resolution = p_resolution, resolution_reason = v_reason
  where id = p_queue_id and resolved_at is null;
  if not found then
    raise exception 'quarantine_entry_unknown' using errcode = 'P0002';
  end if;
end
$$;
revoke all on function public.platform_resolve_quarantine(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.platform_resolve_quarantine(uuid, text, text) to authenticated;

-- =====================================================================================
-- 8. The cleanup -- server-only, locked, re-checked inside the deleting transaction
-- =====================================================================================
-- The candidate report is produced at one time and the deletion happens at another. Between
-- them the owner can confirm their address or place a first order, so the report is NOT an
-- authorization: this command re-derives both facts under a row lock, in the same transaction
-- that does the deleting, and refuses by name when either has changed.
create function public.service_cleanup_abandoned_signup(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org     public.organizations;
  v_removed jsonb;
  v_age     integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  v_age := floor(extract(epoch from (now() - v_org.created_at)) / 86400)::integer;
  if v_age < 30 then
    raise exception 'abandoned_signup_not_due' using errcode = '22023';
  end if;

  -- RE-CHECKED HERE, UNDER THE LOCK, NOT WHEN THE REPORT RAN.
  if private.organization_owner_verified(v_org.id) then
    raise exception 'abandoned_signup_owner_verified' using errcode = '42501';
  end if;
  -- The quarantine row is NOT written here. Raising rolls this subtransaction back, so a write
  -- on the refusal path would vanish with the refusal; the queue is filled by
  -- service_quarantine_abandoned_signups below, which commits what it finds.
  if private.organization_has_business_activity(v_org.id) then
    raise exception 'abandoned_signup_has_activity' using errcode = '42501';
  end if;

  v_removed := private.delete_tenant_rows(v_org.id);

  -- Written BEFORE the organization row goes, and outside its cascade, so it survives.
  insert into private.abandoned_signup_cleanup_log
    (org_id, org_created_at, days_since_signup, removed_row_counts)
  values (v_org.id, v_org.created_at, v_age, v_removed);

  perform private.delete_tenant_organization_row(v_org.id);

  return jsonb_build_object('org_id', v_org.id, 'removed', v_removed);
end
$$;
revoke all on function public.service_cleanup_abandoned_signup(uuid)
  from public, anon, authenticated;
grant execute on function public.service_cleanup_abandoned_signup(uuid) to service_role;

comment on function public.service_cleanup_abandoned_signup(uuid) is
  'Removes one empty, unverified, over-30-day organization (#175). Locks the row and re-derives '
  'owner verification and activity inside the deleting transaction; the report is not authority.';

-- =====================================================================================
-- 9. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $assert_0196$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0196 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0196 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0196$;

-- =====================================================================================
-- 10. Anchors
-- =====================================================================================
do $anchor_0196$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('abandoned_signup_reminders', 'abandoned_signup_cleanup_log',
                         'organization_quarantine_queue', 'org_activity_evidence_registry')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception '0196: a browser or service role holds a grant on the signup-cleanup storage';
  end if;

  -- The retained cleanup record must not be able to hold an identity.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'abandoned_signup_cleanup_log'
      and column_name in ('email', 'owner_email', 'name', 'organization_name', 'phone',
                          'full_name', 'ip', 'ip_address')
  ) then
    raise exception '0196: the cleanup record grew a column that identifies a person';
  end if;

  -- The reminder ledger must not be able to hold an address either.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'abandoned_signup_reminders'
      and column_name in ('email', 'recipient', 'address', 'phone')
  ) then
    raise exception '0196: the reminder ledger grew a recipient column';
  end if;

  -- The report cannot write: a non-volatile function may not run DML.
  if (select p.provolatile from pg_catalog.pg_proc p
      where p.oid = 'public.platform_abandoned_signup_candidates(integer)'::regprocedure) = 'v' then
    raise exception '0196: the candidate report is VOLATILE and could therefore write';
  end if;

  -- Deletion is service-role only. A browser role must not reach it.
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('service_cleanup_abandoned_signup',
                           'service_dispatch_abandoned_signup_reminder',
                           'service_enqueue_abandoned_signup_reminders')
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception '0196: a browser role can execute a signup cleanup or reminder command';
  end if;

  -- org_status was not extended. #175 does not authorize a fourth value.
  if (select count(*) from pg_catalog.pg_enum e
      join pg_catalog.pg_type t on t.oid = e.enumtypid
      where t.typname = 'org_status') <> 3 then
    raise exception '0196: org_status was extended -- #175 does not authorize a fourth value';
  end if;
end
$anchor_0196$;
