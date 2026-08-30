-- 0254: the controlled purge. Every guard that refuses a tenant teardown gets the SAME declared
-- window 0175 gave the audit ledger, the residue the foreign-key graph cannot see is removed, and
-- the executor stops being able to call a tenant "purged" while its files are still on disk.
--
-- WHAT WAS BROKEN (DEBT §66, measured 26.08.2026). private.delete_tenant_rows (0196:474) derives
-- its delete order from the live foreign-key graph, which is right, and then walks straight into
-- evidence tables that refuse DELETE outright. Two of them were proven by running it:
-- organization_external_egress_evidence_immutable and invoice_three_way_evidence_immutable. The
-- consequence is not a fixture problem: deleting a customer works only on an account that never
-- used the product. p75's purge fixtures are a supplier, a product and a comment, which is exactly
-- why the gate stayed green while a real tenant fails.
--
-- THE PATTERN IS NOT NEW; IT WAS SIMPLY NOT FINISHED. 0175:347 gave audit_logs identical
-- immutability WITH a declared purge window: `app.audit_purge = 'organization_teardown'`, a
-- transaction-local GUC, a NAME test rather than a role test, DELETE only. delete_tenant_rows
-- satisfies two further guards the same way (app.p1_financial_writer,
-- app.organization_lifecycle_writer, 0196:495-510). The design intent was already there. The
-- guards below were never enrolled in it.
--
-- MEASURED SCOPE, not read scope. The §66 query -- a BEFORE DELETE trigger, on a table with
-- org_id, whose function raises, carrying none of the three declarations -- returns 33 functions
-- at 0241 and 34 at 0253 (0252 added private.plan_capability_write_guard on six tables). This
-- migration opens the window in 33 of them. The one deliberately left is
-- private.reject_purge_ledger_change: its four tables are in private.tenant_delete_exclusions
-- (0197:127-134) because the purge ledger is meant to OUTLIVE the tenant it records. After this
-- migration the §66 query returns that one function and nothing else, and section 6 asserts it --
-- so the next evidence table that refuses DELETE shows up as a failure instead of as silence.
--
-- WHY EVERY CANDIDATE AND NOT ONLY THE ONES THAT PROVABLY BLOCK TODAY. Four of the 33
-- (delivery_note_interpretation_guard, delivery_note_interpretation_lines_guard,
-- price_list_interpretation_guard, price_list_interpretation_lines_guard) let a teardown DELETE
-- through today, but only by accident: their refusal reads
-- `current_setting('app.<x>_writer', true) not in (...)`, an unset GUC is NULL, `NULL not in (…)`
-- is NULL, and plpgsql treats a NULL condition as false. The guard is bypassed by the absence of
-- a setting rather than by a decision. Anyone who "fixes" that with a coalesce() -- correctly --
-- breaks tenant deletion silently. Two more (purchase_requests_guard_draft_rpc,
-- purchase_request_items_guard_draft_rpc) refuse only when auth.uid() is not null, which is
-- precisely the case in the one production path that matters: execute_organization_purge_batch
-- requires a signed-in platform admin. A draft purchase request would stop the purge.
-- consolidated_invoice_ledger_guard refuses DELETE on four of its six tables outright. Making the
-- window depend on which of those subtleties holds this month is how the gap comes back.
--
-- UPDATE STAYS REFUSED UNCONDITIONALLY. The window tests tg_op = 'DELETE' and returns OLD. No
-- edit of an evidence row becomes possible under any GUC; a purge removes history, it never
-- rewrites it. Section 2 asserts that shape on every patched function.
--
-- ANCHORED REPLACEMENT AGAINST THE LIVE BODY, never a redeclare from the migration that created
-- the function. A redeclare copies whatever the original file said, which silently reverts every
-- security property a later migration added -- and pg_get_functiondef carries SECURITY DEFINER,
-- the search_path and the volatility forward on its own. The read strips CR first
-- (`replace(pg_get_functiondef(…), e'\r', '')`): a body applied from Windows stores CRLF and one
-- applied on CI stores LF, and an anchor built with e'\n' matches only one of them. That is how
-- the 0171-0205 rollout aborted at 0181, with production 58.8% CRLF and CI never seeing one.
--
-- THE ANCHOR IS THE FUNCTION'S OWN `begin`, and it was verified to occur exactly once in all 34
-- bodies before this file was written. It is also the only correct position: the window has to be
-- the first thing the guard considers, before any refusal it would otherwise reach.

-- =====================================================================================
-- 1. The window, one anchored replacement per guard
-- =====================================================================================
do $teardown_window$
declare
  v_sig    text;
  v_def    text;
  v_count  integer;
  v_anchor text := e'\nbegin\n';
  v_window text := e'\nbegin\n' || $window$  -- 0254: the declared organization-teardown window (0175:347). Transaction-local GUC, a
  -- name test rather than a role test, and DELETE only -- UPDATE stays refused unconditionally.
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
$window$;
begin
  foreach v_sig in array array[
    -- private
    'private.customer_internal_notes_guard()',
    'private.email_delivery_event_guard()',
    'private.plan_capability_write_guard()',
    'private.platform_lifecycle_events_guard()',
    'private.reject_organization_export_access_event_change()',
    'private.reject_organization_external_egress_evidence_change()',
    'private.supplier_order_link_guard()',
    'private.supplier_order_proposal_guard()',
    'private.supplier_order_proposal_line_guard()',
    -- public
    'public.consolidated_invoice_ledger_guard()',
    'public.delivery_note_interpretation_guard()',
    'public.delivery_note_interpretation_lines_guard()',
    'public.document_auto_actions_guard_columns()',
    'public.document_filings_guard_columns()',
    'public.guard_document_annotation()',
    'public.guard_document_export_template()',
    'public.guard_document_export_template_version()',
    'public.guard_document_learning_rule()',
    'public.invoice_three_way_immutable_guard()',
    'public.p1b_price_submission_immutable()',
    'public.price_list_interpretation_guard()',
    'public.price_list_interpretation_lines_guard()',
    'public.purchase_request_items_guard_draft_rpc()',
    'public.purchase_requests_guard_draft_rpc()',
    'public.reject_document_export_mutation()',
    'public.reject_document_extraction_mutation()',
    'public.reject_document_learning_ledger_mutation()',
    'public.reject_document_review_application_mutation()',
    'public.reject_document_scan_evidence_mutation()',
    'public.reject_inventory_movement_mutation()',
    'public.reject_monthly_report_snapshot_mutation()',
    'public.reject_price_list_measurement_mutation()',
    'public.reject_product_name_repair_ledger_mutation()'
  ]
  loop
    v_def := replace(pg_get_functiondef(v_sig::regprocedure), e'\r', '');

    if position('organization_teardown' in v_def) > 0 then
      raise exception '0254: % already declares a purge window -- refusing to patch it twice', v_sig;
    end if;

    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_count <> 1 then
      raise exception '0254: the body of % carries % candidate anchors, not one -- refusing to '
                      'patch blindly', v_sig, v_count;
    end if;

    execute replace(v_def, v_anchor, v_window);
  end loop;
end
$teardown_window$;

-- =====================================================================================
-- 2. The window landed, exactly once, in the DELETE-only shape, and nothing stopped refusing
-- =====================================================================================
-- A window that quietly turned a guard permissive would be far worse than the refusal it
-- replaces, so all four halves are asserted per function: the declaration is present, it is
-- present ONCE, it is the exact DELETE-gated literal this file wrote (not some other mention of
-- the word), and the guard still raises. The window literal is rebuilt here from the same source
-- text rather than referenced -- if the two ever drift, all 33 fail at once and loudly.
do $assert_teardown_window$
declare
  v_sig    text;
  v_src    text;
  v_count  integer;
  v_window text := $window$  -- 0254: the declared organization-teardown window (0175:347). Transaction-local GUC, a
  -- name test rather than a role test, and DELETE only -- UPDATE stays refused unconditionally.
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
$window$;
begin
  foreach v_sig in array array[
    'private.customer_internal_notes_guard()',
    'private.email_delivery_event_guard()',
    'private.plan_capability_write_guard()',
    'private.platform_lifecycle_events_guard()',
    'private.reject_organization_export_access_event_change()',
    'private.reject_organization_external_egress_evidence_change()',
    'private.supplier_order_link_guard()',
    'private.supplier_order_proposal_guard()',
    'private.supplier_order_proposal_line_guard()',
    'public.consolidated_invoice_ledger_guard()',
    'public.delivery_note_interpretation_guard()',
    'public.delivery_note_interpretation_lines_guard()',
    'public.document_auto_actions_guard_columns()',
    'public.document_filings_guard_columns()',
    'public.guard_document_annotation()',
    'public.guard_document_export_template()',
    'public.guard_document_export_template_version()',
    'public.guard_document_learning_rule()',
    'public.invoice_three_way_immutable_guard()',
    'public.p1b_price_submission_immutable()',
    'public.price_list_interpretation_guard()',
    'public.price_list_interpretation_lines_guard()',
    'public.purchase_request_items_guard_draft_rpc()',
    'public.purchase_requests_guard_draft_rpc()',
    'public.reject_document_export_mutation()',
    'public.reject_document_extraction_mutation()',
    'public.reject_document_learning_ledger_mutation()',
    'public.reject_document_review_application_mutation()',
    'public.reject_document_scan_evidence_mutation()',
    'public.reject_inventory_movement_mutation()',
    'public.reject_monthly_report_snapshot_mutation()',
    'public.reject_price_list_measurement_mutation()',
    'public.reject_product_name_repair_ledger_mutation()'
  ]
  loop
    select replace(p.prosrc, e'\r', '') into v_src
    from pg_catalog.pg_proc p
    where p.oid = v_sig::regprocedure;

    v_count := (length(v_src) - length(replace(v_src, 'organization_teardown', '')))
               / length('organization_teardown');
    if v_count <> 1 then
      raise exception '0254: % declares the teardown window % times, not once', v_sig, v_count;
    end if;
    if position(v_window in v_src) = 0 then
      raise exception '0254: the window in % is not the DELETE-gated form this migration wrote', v_sig;
    end if;
    if position('raise exception' in v_src) = 0 then
      raise exception '0254: % stopped refusing anything at all', v_sig;
    end if;
    -- UPDATE must remain unreachable through the window: the only new return is guarded by
    -- tg_op = 'DELETE', so an UPDATE cannot fall into it whatever the GUC says.
    if position($update$if tg_op = 'DELETE'$update$ in v_src) = 0 then
      raise exception '0254: the window in % is no longer gated on tg_op = DELETE -- UPDATE would '
                      'become permitted', v_sig;
    end if;
  end loop;
end
$assert_teardown_window$;

-- The purge ledger is NOT enrolled, and that is a decision rather than an omission. Its four
-- tables are excluded from the staged delete on purpose (0197:127-134): the record of who deleted
-- which tenant, when and why has to survive the tenant. Asserted, so nobody adds it "for
-- symmetry" later.
do $assert_ledger_still_refuses$
begin
  if position('organization_teardown' in
              replace(pg_get_functiondef('private.reject_purge_ledger_change()'::regprocedure),
                      e'\r', '')) > 0 then
    raise exception '0254: the purge ledger guard was given a teardown window -- the ledger is '
                    'meant to outlive the tenant it records';
  end if;
end
$assert_ledger_still_refuses$;

-- =====================================================================================
-- 3. The residue the foreign-key graph cannot see
-- =====================================================================================
-- private.tenant_delete_stages() lists tables that carry org_id. Six private tables hold tenant
-- rows keyed by something else -- an event, an outbox row, or another organization -- and are
-- therefore invisible to it. They do not merely survive a purge:
--
--   * private.idempotency_keys and private.dead_letter_records hold NO ACTION keys into
--     public.domain_events, and private.integration_deliveries and private.dead_letter_records
--     hold one into private.integration_outbox. Both parents ARE in the staged delete, so a
--     surviving child turns the purge into a foreign-key error.
--   * private.organization_referrals (both columns) and private.referral_grants
--     (beneficiary_org_id) hold ON DELETE RESTRICT keys straight into public.organizations. A
--     tenant that referred anyone, was referred by anyone, or received a referral grant can
--     NEVER have its organizations row deleted while those rows stand.
--
-- supabase/demo/demo_reset.sql:73-79 deletes three of them by hand before delegating; the
-- executor and the abandoned-signup cleanup delete none. Doing it here means all three teardown
-- paths get it from one place and the hand-written copy becomes redundant rather than load
-- bearing.
--
-- THREE MORE ORG-LESS PRIVATE TABLES ARE DELIBERATELY NOT TOUCHED, because they cannot be
-- attributed to a tenant at all: private.signup_attempts stores only an IP hash and an email
-- hash (0159 stores hashes precisely so no readable address survives),
-- private.supplier_portal_lookup_failures stores a token prefix, and
-- private.supplier_portal_rate_limits a fingerprint. None of the three carries a key back to an
-- organization, so "delete this tenant's rows" is not a question they can answer. They hold no
-- personal data in readable form and no key into anything the purge removes.
--
-- SECURITY INVOKER on purpose. The callers are all SECURITY DEFINER functions owned by postgres,
-- so this runs with their privileges anyway -- and as an invoker it stays outside the A5 definer
-- surface, which matters because one of its predicates has to name a scope-enforced table.
create or replace function private.delete_tenant_residue_rows(p_org_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rows   bigint;
  v_result jsonb := '{}'::jsonb;
begin
  if p_org_id is null then
    raise exception 'tenant_residue_target_missing' using errcode = '22023';
  end if;

  delete from private.integration_deliveries delivery
   where delivery.outbox_id in (
     select outbox.id from private.integration_outbox outbox where outbox.org_id = p_org_id);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.integration_deliveries', v_rows);
  end if;

  delete from private.dead_letter_records dead_letter
   where dead_letter.outbox_id in (
           select outbox.id from private.integration_outbox outbox where outbox.org_id = p_org_id)
      or dead_letter.event_id in (
           select emitted.id from public.domain_events emitted where emitted.org_id = p_org_id);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.dead_letter_records', v_rows);
  end if;

  delete from private.idempotency_keys idem
   where idem.event_id in (
     select emitted.id from public.domain_events emitted where emitted.org_id = p_org_id);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.idempotency_keys', v_rows);
  end if;

  delete from private.whatsapp_sent_transition_guards sent_guard
   where sent_guard.order_id in (
     select purchase_order.id
     from public.purchase_orders purchase_order
     where purchase_order.org_id = p_org_id);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.whatsapp_sent_transition_guards', v_rows);
  end if;

  delete from private.referral_grants grant_row
   where grant_row.referred_org_id = p_org_id or grant_row.beneficiary_org_id = p_org_id;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.referral_grants', v_rows);
  end if;

  delete from private.organization_referrals referral
   where referral.referred_org_id = p_org_id or referral.referrer_org_id = p_org_id;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_result := v_result || jsonb_build_object('private.organization_referrals', v_rows);
  end if;

  return v_result;
end
$$;
revoke all on function private.delete_tenant_residue_rows(uuid)
  from public, anon, authenticated, service_role;

comment on function private.delete_tenant_residue_rows(uuid) is
  'Removes the tenant rows that private.tenant_delete_stages() cannot see because they carry no '
  'org_id of their own (0254, DEBT §66). Four of the six hold foreign keys that would otherwise '
  'turn a purge into an error rather than a leftover. Returns table -> count, merged into the '
  'staged result.';

-- Wired into the shared teardown by anchored replacement, so all three callers -- the offboarding
-- executor (0197:481), the abandoned-signup cleanup (0196:1022) and the demo reset -- get it
-- without a line of change of their own. It runs BEFORE the staged delete on purpose: two of the
-- six are children of tables the first pass removes.
do $wire_residue$
declare
  v_def    text;
  v_count  integer;
  v_anchor text :=
    '  -- Break reference cycles first: null the nullable side, then the stages become deletable.';
  v_patch  text := $residue$  -- 0254: the residue the derived graph cannot see -- private tables that carry tenant rows
  -- keyed by an event, an outbox row or another organization rather than by org_id, so
  -- tenant_delete_stages() never lists them. Four of the six hold foreign keys into rows this
  -- function is about to remove, or into the organization row itself: left behind they do not
  -- merely survive the purge, they stop it.
  v_result := v_result || private.delete_tenant_residue_rows(p_org_id);

  -- Break reference cycles first: null the nullable side, then the stages become deletable.$residue$;
begin
  v_def := replace(
    pg_get_functiondef('private.delete_tenant_rows(uuid)'::regprocedure), e'\r', '');

  if position('delete_tenant_residue_rows' in v_def) > 0 then
    raise exception '0254: the staged teardown already sweeps the residue';
  end if;
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception '0254: the cycle-breaker anchor in delete_tenant_rows occurs % times, not '
                    'once -- refusing to patch blindly', v_count;
  end if;

  execute replace(v_def, v_anchor, v_patch);
end
$wire_residue$;

do $assert_residue$
declare
  v_src text;
begin
  select replace(p.prosrc, e'\r', '') into v_src
  from pg_catalog.pg_proc p
  where p.oid = 'private.delete_tenant_rows(uuid)'::regprocedure;

  if position('delete_tenant_residue_rows' in v_src) = 0 then
    raise exception '0254: the residue sweep did not land in the staged teardown';
  end if;
  -- The sweep has to precede the staged delete; behind it the foreign keys have already fired.
  if position('delete_tenant_residue_rows' in v_src)
     > position('tenant_delete_stages' in v_src) then
    raise exception '0254: the residue sweep landed after the staged delete, where it is too late';
  end if;
  if not (select p.prosecdef from pg_catalog.pg_proc p
          where p.oid = 'private.delete_tenant_rows(uuid)'::regprocedure) then
    raise exception '0254: the staged teardown lost SECURITY DEFINER in the patch';
  end if;
end
$assert_residue$;

-- =====================================================================================
-- 4. Storage: the bytes are not in this database
-- =====================================================================================
-- MEASURED ON THE LOCAL STACK, not assumed. Two independent facts, either of which alone settles
-- it:
--
--   1. storage.objects carries no org_id and lives outside public/private, so
--      private.tenant_delete_stages() has never listed it. A purge does not touch it at all.
--   2. Supabase's own storage.protect_delete() is a BEFORE DELETE trigger on storage.objects that
--      raises 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
--      unless storage.allow_delete_query is 'true'. And even past that, the row is only the index:
--      the bytes live in the storage backend (a file volume locally, object storage in
--      production), where a deleted row leaves them orphaned rather than removed. The local stack
--      shows the split directly -- a handful of rows in storage.objects against 1249 files still
--      on the backend volume.
--
-- SO SQL CANNOT PURGE STORAGE, AND NOTHING HERE PRETENDS TO. What SQL can do is refuse to lie
-- about it. Because the API is the ONLY thing that can empty a prefix, an empty prefix is proof
-- that the service-role step ran -- not a proxy for it. The executor is patched below to skip,
-- by name, any tenant whose files are still there, so a tenant is never recorded as purged while
-- its documents are still downloadable.
--
-- EVERY BUCKET, not a list of seven. The owner's decision names the seven that exist today
-- (documents, price-submissions, organization-branding, tenant-exports, feedback,
-- export-templates, document-scans) and all seven are keyed {org_id}/. A hard-coded list would
-- silently exempt the eighth, which is the same shape of gap §66 is about, so the residue reader
-- scans storage.buckets itself and the assertion below only checks that the seven known ones are
-- still there.
create or replace function private.organization_storage_residue(p_org_id uuid)
returns table (bucket text, objects_remaining bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select object.bucket_id, count(*)
  from storage.objects object
  where p_org_id is not null
    and starts_with(object.name, p_org_id::text || '/')
  group by object.bucket_id
  order by object.bucket_id
$$;
revoke all on function private.organization_storage_residue(uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_storage_residue(uuid) is
  'What is still stored under {org_id}/ , per bucket (0254, DEBT §66). Storage bytes are not in '
  'this database and SQL cannot remove them: storage.protect_delete() refuses a direct DELETE and '
  'the row is only an index into the backend. Because the Storage API is the only thing that can '
  'empty the prefix, an empty result is proof the service-role purge step ran.';

-- The one door the service-role step reads its work through. It exists so the Edge function does
-- not have to walk the Storage API's one-level listing recursively and hope it saw everything:
-- storage.objects IS the index, so the exact set of paths comes from here and the API is asked to
-- remove precisely those. Authorised with the same two predicates platform_purge_candidates()
-- uses, so no new authority path is invented for deletion -- an operator who cannot see a purge
-- candidate cannot enumerate its files either.
create or replace function public.platform_organization_storage_objects(p_org_id uuid)
returns table (bucket text, object_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select object.bucket_id, object.name
  from storage.objects object
  where public.is_platform_admin()
    and public.platform_has_capability('offboarding.handle')
    and p_org_id is not null
    and starts_with(object.name, p_org_id::text || '/')
  order by object.bucket_id, object.name
$$;
revoke all on function public.platform_organization_storage_objects(uuid)
  from public, anon, service_role;
grant execute on function public.platform_organization_storage_objects(uuid) to authenticated;

comment on function public.platform_organization_storage_objects(uuid) is
  'Every stored object under {org_id}/ , for the service-role purge step to remove through the '
  'Storage API (0254, DEBT §66). Platform Admin with offboarding.handle only, the same pair '
  'platform_purge_candidates() requires. Reads; deletes nothing -- SQL cannot.';

do $assert_buckets$
declare
  v_missing text;
begin
  select string_agg(expected.id, ', ' order by expected.id) into v_missing
  from (values ('documents'), ('price-submissions'), ('organization-branding'),
               ('tenant-exports'), ('feedback'), ('export-templates'), ('document-scans'))
       as expected(id)
  where not exists (select 1 from storage.buckets bucket where bucket.id = expected.id);
  if v_missing is not null then
    raise exception '0254: a bucket the purge is defined over is missing: %', v_missing;
  end if;
  -- The refusal this design leans on has to actually be there.
  if not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_proc guard on guard.oid = trigger_row.tgfoid
    where trigger_row.tgrelid = 'storage.objects'::regclass
      and not trigger_row.tgisinternal
      and guard.proname = 'protect_delete'
  ) then
    raise exception '0254: storage.protect_delete is gone -- an empty prefix would no longer be '
                    'proof that the Storage API ran, and the executor check below would become a '
                    'formality';
  end if;
  -- The enumerator is a platform-operator door, not a service one. A service role holding it
  -- would make every tenant's file list reachable from a key with no human behind it.
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'platform_organization_storage_objects'
      and grantee in ('anon', 'service_role', 'PUBLIC')
  ) then
    raise exception '0254: the storage enumerator is reachable by an anonymous or service role';
  end if;
end
$assert_buckets$;

-- The executor refuses to record a purge it did not complete. Inserted BEFORE the forensic
-- security event, so a skipped tenant does not carry a 'purge_executed' event for a purge that
-- never happened.
do $wire_storage_check$
declare
  v_def    text;
  v_count  integer;
  v_anchor text := '    perform private.record_security_event(';
  v_patch  text := $storage$    -- 0254: the bytes are not in this database. storage.objects carries no org_id, so the
    -- staged delete never sees it, and Supabase's own protect_delete() refuses a direct SQL
    -- DELETE outright -- which is exactly why an empty prefix is PROOF that the service-role
    -- Storage API step ran, rather than a proxy for it. A tenant whose files are still there is
    -- skipped by name instead of being recorded as purged.
    if exists (select 1 from private.organization_storage_residue(v_item.org_id)) then
      insert into private.organization_purge_executions (batch_id, org_id, outcome, skip_reason)
      values (v_batch.id, v_item.org_id, 'skipped',
              'storage_not_cleared: ' || coalesce((
                select string_agg(residue.bucket || '=' || residue.objects_remaining::text, ', '
                                  order by residue.bucket)
                from private.organization_storage_residue(v_item.org_id) residue), 'unknown'));
      v_skipped := v_skipped + 1;
      continue;
    end if;

    perform private.record_security_event($storage$;
begin
  v_def := replace(
    pg_get_functiondef('public.execute_organization_purge_batch(uuid)'::regprocedure), e'\r', '');

  if position('organization_storage_residue' in v_def) > 0 then
    raise exception '0254: the executor already checks storage residue';
  end if;
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception '0254: the forensic-event anchor in the purge executor occurs % times, not '
                    'once -- refusing to patch blindly', v_count;
  end if;

  execute replace(v_def, v_anchor, v_patch);
end
$wire_storage_check$;

do $assert_storage_check$
declare
  v_src text;
begin
  select replace(p.prosrc, e'\r', '') into v_src
  from pg_catalog.pg_proc p
  where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure;

  if position('organization_storage_residue' in v_src) = 0 then
    raise exception '0254: the storage residue check did not land in the purge executor';
  end if;
  if position('storage_not_cleared' in v_src) = 0 then
    raise exception '0254: the executor no longer names storage as the reason it skipped';
  end if;
  -- It has to run before the teardown, not after it: a purge that already removed the rows and
  -- then noticed the files would have nothing left to reconcile them against.
  if position('organization_storage_residue' in v_src)
     > position('delete_tenant_rows' in v_src) then
    raise exception '0254: the storage check landed after the teardown, where it decides nothing';
  end if;
  if position('assert_recent_password_authentication' in v_src) = 0 then
    raise exception '0254: the purge executor lost its step-up assertion in the patch';
  end if;
  if (select p.pronargs from pg_catalog.pg_proc p
      where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure) <> 1 then
    raise exception '0254: the purge executor grew an argument';
  end if;
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'execute_organization_purge_batch'
      and grantee in ('anon', 'service_role')
  ) then
    raise exception '0254: the patch handed the purge executor to a role a scheduler can hold';
  end if;
end
$assert_storage_check$;

-- =====================================================================================
-- 5. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0254 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- =====================================================================================
-- 6. The §66 register query, run as an assertion
-- =====================================================================================
-- This is the whole point of the file. §66's query is re-runnable by design; here it becomes a
-- post-condition. After this migration exactly one guard may still refuse a declared teardown --
-- the purge ledger, which is meant to. Anything else means a guard was added, or missed, and it
-- fails here instead of failing on the first real customer deletion.
do $assert_no_undeclared_guard$
declare
  v_left text;
begin
  with del_trig as (
    select distinct guard_schema.nspname || '.' || guard.proname as fn,
           replace(pg_get_functiondef(guard.oid), e'\r', '') as def
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class guarded on guarded.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace guarded_schema on guarded_schema.oid = guarded.relnamespace
    join pg_catalog.pg_proc guard on guard.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace guard_schema on guard_schema.oid = guard.pronamespace
    join pg_catalog.pg_attribute tenant_key on tenant_key.attrelid = guarded.oid
      and tenant_key.attname = 'org_id'
      and tenant_key.attnum > 0 and not tenant_key.attisdropped
    where not trigger_row.tgisinternal
      and guarded_schema.nspname in ('public', 'private')
      and (trigger_row.tgtype & 8) > 0
      and (trigger_row.tgtype & 2) > 0
  )
  select string_agg(fn, ', ' order by fn) into v_left
  from del_trig
  where position('organization_teardown' in def) = 0
    and position('raise exception' in def) > 0
    and position('p1_financial_writer' in def) = 0
    and position('organization_lifecycle_writer' in def) = 0
    and fn <> 'private.reject_purge_ledger_change';

  if v_left is not null then
    raise exception '0254: % still refuses a declared organization teardown -- a tenant that used '
                    'the product cannot be deleted', v_left;
  end if;
end
$assert_no_undeclared_guard$;
