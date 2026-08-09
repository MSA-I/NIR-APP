-- 0111 -- Tenant offboarding, full export evidence and conservative retention boundaries.
--
-- Product contract (owner decision, 2026-08-09):
--   * owner requests offboarding with fresh authentication; no free-text reason is required;
--   * the tenant becomes read-only immediately and has 30 days to cancel;
--   * platform approval also requires fresh authentication, but no reason field;
--   * a completed export contains CSV + JSON + original tenant files and is delivered only
--     through a seven-day signed URL minted by the tenant-export Edge Function;
--   * owner cancellation restores the pre-request lifecycle inside the 30-day window;
--   * later reactivation is platform-admin-only and always returns the organization to active;
--   * destructive purge is NOT guessed. Separate operational, security-log and financial
--     retention dates are recorded so a future purge worker can fail closed by data class.

do $guard$
declare
  v_body text;
begin
  select p.prosrc into v_body
  from pg_catalog.pg_proc p
  where p.oid = 'private.organization_access_mode(uuid)'::regprocedure;
  if md5(v_body) <> '01804c827bebb9e42af4bc6494fb84b8' then
    raise exception '0111 ancestry guard failed: organization_access_mode changed';
  end if;

  select p.prosrc into v_body
  from pg_catalog.pg_proc p
  where p.oid = 'private.organization_row_write_guard()'::regprocedure;
  if md5(v_body) <> '9411a628caa7fb69998255dfdb41260c' then
    raise exception '0111 ancestry guard failed: organization_row_write_guard changed';
  end if;
end
$guard$;

create table public.organization_offboarding_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'requested' check (status in (
    'requested', 'approved', 'export_building', 'export_ready', 'export_failed',
    'cancelled', 'reactivated', 'completed'
  )),
  request_idempotency_key uuid not null,
  cancel_idempotency_key uuid,
  requested_by uuid not null,
  requested_at timestamptz not null default statement_timestamp(),
  approved_by uuid,
  approved_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  reactivated_by uuid,
  reactivated_at timestamptz,
  previous_org_status public.org_status not null,
  previous_trial_ends_at timestamptz,
  cancellation_deadline timestamptz not null,
  platform_reactivation_deadline timestamptz not null,
  operational_purge_eligible_at timestamptz not null,
  security_logs_retain_until timestamptz not null,
  financial_records_retain_until timestamptz not null,
  legal_hold boolean not null default true,
  purge_policy_version text,
  purge_started_at timestamptz,
  retention_policy_version text not null default 'israel-conservative-v1'
    check (retention_policy_version = 'israel-conservative-v1'),
  export_attempts integer not null default 0 check (export_attempts >= 0),
  export_generation uuid,
  export_worker_token uuid,
  export_lease_until timestamptz,
  export_started_at timestamptz,
  export_completed_at timestamptz,
  export_object_path text,
  export_sha256 text check (export_sha256 is null or export_sha256 ~ '^[0-9a-f]{64}$'),
  export_size_bytes bigint check (export_size_bytes is null or export_size_bytes >= 0),
  export_file_count integer check (export_file_count is null or export_file_count >= 0),
  last_export_error text,
  download_token_hash text check (
    download_token_hash is null or download_token_hash ~ '^[0-9a-f]{64}$'
  ),
  download_token_issued_at timestamptz,
  download_token_expires_at timestamptz,
  download_count integer not null default 0 check (download_count >= 0),
  last_downloaded_at timestamptz,
  portal_open_count integer not null default 0 check (portal_open_count >= 0),
  artifact_link_issued_count integer not null default 0
    check (artifact_link_issued_count >= 0),
  last_artifact_link_issued_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (org_id, request_idempotency_key),
  check (cancellation_deadline = operational_purge_eligible_at),
  check (cancellation_deadline = requested_at + interval '30 days'),
  check (platform_reactivation_deadline = requested_at + interval '120 days'),
  check (security_logs_retain_until >= requested_at + interval '24 months'),
  check (financial_records_retain_until > requested_at),
  check (
    export_object_path is null
    or export_object_path = org_id::text || '/offboarding/' || id::text || '/'
      || export_generation::text || '/manifest.json'
  ),
  check (
    status <> 'export_ready'
    or (
      export_completed_at is not null
      and export_object_path is not null
      and export_sha256 is not null
      and export_size_bytes is not null
      and export_file_count is not null
    )
  )
);

create unique index organization_offboarding_one_open_idx
  on public.organization_offboarding_requests (org_id)
  where status in (
    'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
  );
create unique index organization_offboarding_cancel_idempotency_idx
  on public.organization_offboarding_requests (org_id, cancel_idempotency_key)
  where cancel_idempotency_key is not null;
create unique index organization_offboarding_download_token_idx
  on public.organization_offboarding_requests (download_token_hash)
  where download_token_hash is not null;
create index organization_offboarding_status_deadline_idx
  on public.organization_offboarding_requests (status, cancellation_deadline);

-- A provider run with no usable subscriptions is terminal, but it is not a successful send.
-- Keep that fact separate from push_sent_at so the outbox neither lies nor retries forever.
alter table public.notifications
  add column push_terminal_at timestamptz,
  add column push_terminal_reason text check (
    push_terminal_reason is null
    or push_terminal_reason in ('delivered', 'partial', 'no_delivery')
  ),
  add constraint notifications_push_terminal_shape check (
    (push_terminal_at is null and push_terminal_reason is null)
    or (
      push_terminal_at is not null
      and push_terminal_reason is not null
      and (
        (push_terminal_reason in ('delivered', 'partial') and push_sent_at is not null)
        or (push_terminal_reason = 'no_delivery' and push_sent_at is null)
      )
    )
  );

drop index public.notifications_push_pending_idx;
create index notifications_push_pending_idx
  on public.notifications (org_id, created_at)
  where push_sent_at is null and push_terminal_at is null;

-- Pending outbound deliveries are operational work, not historical business evidence. Keep them
-- durably parked while a tenant is offboarding so an already-enqueued event cannot be delivered
-- merely because organizations.status remains active underneath the read-only overlay. The
-- request id makes restoration exact: a later cancellation/reactivation may release only work
-- parked by that same offboarding request.
alter table private.integration_outbox
  drop constraint integration_outbox_status_check;
alter table private.integration_outbox
  add constraint integration_outbox_status_check
  check (status in ('pending', 'claimed', 'parked', 'delivered', 'dead_letter'));
alter table private.integration_outbox
  add column offboarding_request_id uuid
    references public.organization_offboarding_requests(id) on delete restrict,
  add column parked_at timestamptz,
  add constraint integration_outbox_parked_state_check check (
    (
      status = 'parked'
      and offboarding_request_id is not null
      and parked_at is not null
      and next_attempt_at = 'infinity'::timestamptz
      and claimed_by is null
      and claimed_at is null
    )
    or (
      status <> 'parked'
      and offboarding_request_id is null
      and parked_at is null
    )
  );
create index integration_outbox_offboarding_request_idx
  on private.integration_outbox (offboarding_request_id, status)
  where offboarding_request_id is not null;

alter table public.organization_offboarding_requests enable row level security;
revoke all on table public.organization_offboarding_requests from public, anon, authenticated;

-- The browser never mutates the table. These read policies support future SQL-console diagnosis;
-- application reads still go through the narrow RPCs below.
create policy organization_offboarding_owner_select
on public.organization_offboarding_requests for select to authenticated
using (org_id = public.auth_org() and public.auth_role() = 'owner');

create policy organization_offboarding_platform_select
on public.organization_offboarding_requests for select to authenticated
using (public.is_platform_admin());

insert into private.scope_registry (table_name, scope_class, enforced)
values ('organization_offboarding_requests', 'org_global', false);

-- A tenant export is a separate disclosure boundary from RLS. Every tenant table is classified
-- explicitly; new tables/columns fail A6 until a migration reviews their export projection.
create table private.tenant_export_registry (
  table_name text primary key,
  disposition text not null check (disposition in ('include', 'exclude')),
  excluded_columns text[] not null default '{}'::text[],
  exported_columns text[] not null default '{}'::text[],
  schema_hash text,
  rationale text not null check (length(trim(rationale)) >= 20)
);
revoke all on table private.tenant_export_registry from public, anon, authenticated, service_role;

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale) values
  ('approval_policy_configurations','include','{}','Approved tenant policy configuration.'),
  ('audit_logs','include','{}','Tenant audit evidence, including soft-delete history.'),
  ('bank_allocations','include','{}','Tenant financial allocation records.'),
  ('bank_imports','include','{}','Tenant bank import evidence.'),
  ('bank_transactions','include','{}','Tenant bank transaction records.'),
  ('categories','include','{}','Tenant catalogue categories.'),
  ('comments','include','{}','Tenant-authored operational comments.'),
  ('credit_requests','include','{}','Tenant credit workflow records.'),
  ('document_annotations','include','{}','Human document annotation evidence.'),
  ('document_auto_actions','include','{}','Auditable document automation decisions.'),
  ('document_export_template_versions','include','{}','Tenant document export contracts.'),
  ('document_export_templates','include','{}','Tenant document export templates.'),
  ('document_exports','include','{}','Tenant document export ledger.'),
  ('document_extractions','include','{}','Tenant OCR extraction evidence.'),
  ('document_feedback','include','{}','Human document correction evidence.'),
  ('document_filings','include','{}','Tenant document filing decisions.'),
  ('document_interpretations','include','{}','Tenant document interpretation evidence.'),
  ('document_learning_rules','include','{}','Reviewed tenant learning rules.'),
  ('document_processing_jobs','include',array['lease_owner','lease_until'],'Job history without transient worker leases.'),
  ('document_review_corrections','include','{}','Tenant document review corrections.'),
  ('document_rule_applications','include','{}','Tenant rule application evidence.'),
  ('document_type_review_decisions','include','{}','Tenant document-type review decisions.'),
  ('documents','include','{}','Tenant document metadata, including soft-deleted rows.'),
  ('domain_events','include','{}','Tenant domain-event ledger.'),
  ('exceptions','include','{}','Tenant exception and resolution history.'),
  ('external_identity_mappings','include','{}','Tenant external identity references.'),
  ('external_references','include','{}','Tenant integration reference mapping.'),
  ('goods_receipt_items','include','{}','Tenant goods receipt line records.'),
  ('goods_receipts','include','{}','Tenant goods receipt records.'),
  ('identity_provider_settings','include',array['secret_config'],'Identity configuration without provider secrets.'),
  ('integration_failures','include',array['raw_error'],'Integration failure codes without untrusted raw errors.'),
  ('inventory_movements','include','{}','Tenant immutable inventory movement ledger.'),
  ('invitations','include',array['token_hash'],'Invitation history without bearer-token hashes.'),
  ('invoice_line_evidence_batches','include','{}','Tenant invoice extraction batch evidence.'),
  ('invoice_line_match_sets','include','{}','Tenant invoice matching snapshots.'),
  ('invoice_line_matches','include','{}','Tenant invoice-line allocations and findings.'),
  ('invoice_lines','include','{}','Tenant invoice line items.'),
  ('invoice_order_links','include','{}','Tenant invoice to order links.'),
  ('invoice_receipt_links','include','{}','Tenant invoice to receipt links.'),
  ('invoice_three_way_approval_snapshots','include','{}','Immutable tenant approval snapshots.'),
  ('invoice_three_way_overrides','include','{}','Reasoned tenant 3-way override evidence.'),
  ('invoices','include','{}','Tenant invoice ledger, including soft-deleted rows.'),
  ('monthly_exports','include','{}','Tenant monthly export history.'),
  ('monthly_report_snapshot_deliveries','include','{}','Tenant report delivery evidence.'),
  ('monthly_report_snapshots','include','{}','Tenant immutable report snapshots.'),
  ('next_order_items','include','{}','Tenant reorder planning records.'),
  ('notification_event_states','include','{}','Tenant notification lifecycle state.'),
  ('notification_preferences','include','{}','Tenant user notification preferences.'),
  ('notifications','include','{}','Tenant in-application notification history.'),
  ('org_autonomy_policies','include','{}','Tenant automation policy configuration.'),
  ('org_flag_configurations','include','{}','Tenant feature configuration.'),
  ('org_units','include','{}','Tenant legal entity and operational unit tree.'),
  ('organization_offboarding_requests','include',array[
    'request_idempotency_key','cancel_idempotency_key','export_worker_token','download_token_hash',
    'download_token_issued_at','download_token_expires_at'
  ],'Offboarding evidence without idempotency or bearer-token material.'),
  ('payment_allocations','include','{}','Tenant payment allocation ledger.'),
  ('payment_request_invoices','include','{}','Tenant payment-request allocations.'),
  ('payment_requests','include','{}','Tenant payment request records.'),
  ('payments','include','{}','Tenant payment records.'),
  ('price_history','include','{}','Tenant historical purchase prices.'),
  ('price_list_automation_scope_decisions','include','{}','Reviewed automation eligibility decisions.'),
  ('price_list_calibration_reviews','include','{}','Human calibration decisions.'),
  ('price_list_empty_run_reviews','include','{}','Human empty-run calibration decisions.'),
  ('price_list_interpretation_decisions','include','{}','Tenant price-list decisions.'),
  ('price_list_interpretation_lines','include','{}','Tenant price-list line evidence.'),
  ('price_list_shadow_lines','include','{}','Tenant shadow prediction evidence.'),
  ('price_list_shadow_runs','include','{}','Tenant shadow-mode runs.'),
  ('products','include','{}','Tenant product catalogue.'),
  ('profiles','include','{}','Tenant member profile and capability records.'),
  ('purchase_order_items','include','{}','Tenant purchase-order line snapshots.'),
  ('purchase_orders','include','{}','Tenant purchase orders.'),
  ('purchase_request_items','include','{}','Tenant purchase request lines.'),
  ('purchase_requests','include','{}','Tenant purchase requests.'),
  ('push_subscriptions','exclude','{}','Web Push endpoints and crypto keys are credentials, not business export data.'),
  ('saved_views','include','{}','Tenant user saved-view configuration.'),
  ('security_events','include','{}','Tenant security-event evidence.'),
  ('supplier_categories','include','{}','Tenant supplier-category mapping.'),
  ('supplier_price_document_upload_reservations','exclude','{}','Expired upload leases are transient worker state.'),
  ('supplier_price_submission_intakes','exclude','{}','Short-lived price-list intake claims are transient worker state, not export evidence.'),
  ('supplier_price_submissions','include','{}','Tenant supplier price-list submissions.'),
  ('supplier_products','include','{}','Tenant supplier-product catalogue and current prices.'),
  ('suppliers','include','{}','Tenant supplier master data.'),
  ('user_scope_closure','include','{}','Tenant effective unit-scope assignments.'),
  ('user_scope_grants','include','{}','Tenant explicit unit-scope grants.'),
  ('webhook_subscriptions','include',array['secret_id'],'Webhook configuration without Vault secret references.'),
  ('whatsapp_connections','include',array['token_secret_id'],'WhatsApp configuration without Vault secret references.'),
  ('whatsapp_order_messages','include',array['confirm_token_hash','lease_expires_at'],'Message history without bearer hashes or worker leases.'),
  ('whatsapp_webhook_events','include','{}','Tenant WhatsApp webhook evidence without raw provider secrets.');

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    );

create function private.tenant_export_registry_violations()
returns table (detail text)
language sql
stable
set search_path = public, pg_catalog
as $$
  select 'unclassified tenant export table: ' || table_info.table_name
  from information_schema.tables table_info
  where table_info.table_schema = 'public' and table_info.table_type = 'BASE TABLE'
    and exists (
      select 1 from information_schema.columns org_column
      where org_column.table_schema = 'public'
        and org_column.table_name = table_info.table_name and org_column.column_name = 'org_id'
    )
    and not exists (
      select 1 from private.tenant_export_registry registry
      where registry.table_name = table_info.table_name
    )
  union all
  select 'stale tenant export registry row: ' || registry.table_name
  from private.tenant_export_registry registry
  where not exists (
    select 1 from information_schema.columns org_column
    where org_column.table_schema = 'public'
      and org_column.table_name = registry.table_name and org_column.column_name = 'org_id'
  )
  union all
  select 'tenant export schema drift: ' || registry.table_name
  from private.tenant_export_registry registry
  where registry.schema_hash is distinct from (
    select md5(string_agg(
      column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
      '|' order by column_info.ordinal_position
    ))
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = registry.table_name
  )
  union all
  select 'secret-like export column not excluded: ' || registry.table_name || '.' || column_info.column_name
  from private.tenant_export_registry registry
  join information_schema.columns column_info
    on column_info.table_schema = 'public' and column_info.table_name = registry.table_name
  where registry.disposition = 'include'
    and column_info.column_name ~* '(secret|token|password|credential|p256dh|^auth$)'
    and not (column_info.column_name = any(registry.excluded_columns))
$$;
revoke all on function private.tenant_export_registry_violations()
  from public, anon, authenticated, service_role;

create table private.organization_export_snapshot_rows (
  request_id uuid not null,
  generation uuid not null,
  org_id uuid not null,
  table_name text not null,
  row_ordinal bigint not null,
  row_data jsonb not null,
  primary key (request_id, generation, table_name, row_ordinal)
);
create index organization_export_snapshot_rows_page_idx
  on private.organization_export_snapshot_rows (request_id, generation, table_name, row_ordinal);

-- Snapshot creation is durable and incremental. A tenant is already read-only while offboarding,
-- so a physical ctid cursor is safe only while the captured relation file and reviewed schema hash
-- remain unchanged; every batch verifies both before advancing.
create table private.organization_export_snapshot_table_states (
  request_id uuid not null references public.organization_offboarding_requests(id) on delete restrict,
  generation uuid not null,
  org_id uuid not null references public.organizations(id) on delete restrict,
  table_name text not null,
  exported_columns text[] not null,
  schema_hash text,
  source_relfilenode oid not null,
  cursor_ctid tid,
  next_ordinal bigint not null default 0 check (next_ordinal >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'copying', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (request_id, generation, table_name),
  check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);
create index organization_export_snapshot_table_states_claim_idx
  on private.organization_export_snapshot_table_states (
    request_id, generation, status, table_name
  );

create table private.organization_export_snapshot_storage_states (
  request_id uuid not null references public.organization_offboarding_requests(id) on delete restrict,
  generation uuid not null,
  org_id uuid not null references public.organizations(id) on delete restrict,
  cursor_bucket_id text,
  cursor_object_name text,
  next_ordinal bigint not null default 0 check (next_ordinal >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'copying', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (request_id, generation),
  check (
    (cursor_bucket_id is null and cursor_object_name is null)
    or (cursor_bucket_id is not null and cursor_object_name is not null)
  ),
  check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create table private.organization_export_snapshot_objects (
  request_id uuid not null,
  generation uuid not null,
  org_id uuid not null,
  bucket_id text not null,
  object_name text not null,
  size_bytes bigint not null,
  mime_type text,
  updated_at timestamptz not null,
  primary key (request_id, generation, bucket_id, object_name)
);

-- A full tenant export may be far larger than one Edge invocation. Every independently retryable
-- artifact is therefore a durable part with its own fencing token and lease. JSON/CSV table pages
-- contain at most 500 snapshotted rows; source-object and auth-account parts are likewise explicit
-- checkpoints. The final manifest may be accepted only after every part in its generation is complete.
create table private.organization_export_parts (
  request_id uuid not null references public.organization_offboarding_requests(id) on delete restrict,
  generation uuid not null,
  part_id uuid not null default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (
    kind in (
      'table_json', 'table_csv', 'source_object', 'auth_accounts',
      'manifest_page', 'manifest'
    )
  ),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  mime_type text not null check (
    (kind in ('table_json', 'auth_accounts', 'manifest_page', 'manifest')
      and mime_type = 'application/json')
    or (kind = 'table_csv' and mime_type = 'text/csv')
    or (kind = 'source_object' and mime_type = 'application/octet-stream')
  ),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
  claim_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  object_path text,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  last_error_code text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (request_id, generation, part_id),
  check (
    (status = 'claimed' and claim_token is not null and lease_until is not null)
    or (status <> 'claimed' and claim_token is null and lease_until is null)
  ),
  check (
    (status = 'completed' and object_path is not null and sha256 is not null and size_bytes is not null)
    or (status <> 'completed')
  ),
  check (
    object_path is null
    or (
      kind = 'manifest'
      and object_path = org_id::text || '/offboarding/' || request_id::text || '/'
        || generation::text || '/manifest.json'
    )
    or (
      kind <> 'manifest'
      and object_path = org_id::text || '/offboarding/' || request_id::text || '/'
        || generation::text || '/parts/' || part_id::text || '.part'
    )
  )
);
create index organization_export_parts_claim_idx
  on private.organization_export_parts (request_id, generation, status, lease_until, created_at);
create index organization_export_parts_status_idx
  on private.organization_export_parts (request_id, generation, status);
create unique index organization_export_parts_table_batch_uidx
  on private.organization_export_parts (
    request_id, generation, kind,
    (payload ->> 'table_name'), ((payload ->> 'batch_index')::integer)
  ) where kind in ('table_json', 'table_csv');
create unique index organization_export_parts_auth_batch_uidx
  on private.organization_export_parts (
    request_id, generation, kind, ((payload ->> 'batch_index')::integer)
  ) where kind = 'auth_accounts';
create unique index organization_export_parts_manifest_page_uidx
  on private.organization_export_parts (
    request_id, generation, kind, ((payload ->> 'page_index')::integer)
  ) where kind = 'manifest_page';
create unique index organization_export_parts_manifest_uidx
  on private.organization_export_parts (request_id, generation)
  where kind = 'manifest';

create table private.organization_export_manifest_states (
  request_id uuid not null references public.organization_offboarding_requests(id) on delete restrict,
  generation uuid not null,
  org_id uuid not null references public.organizations(id) on delete restrict,
  cursor_part_id uuid,
  page_count integer not null default 0 check (page_count between 0 and 1000),
  artifact_count bigint not null default 0 check (artifact_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'building', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (request_id, generation),
  check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

-- Token resolution is intentionally read-only. These immutable events are written only after the
-- Edge broker has actually prepared the portal/manifest response or minted and revalidated an
-- artifact URL. The caller supplies an idempotency key so a transport retry cannot inflate counts.
create table private.organization_export_access_events (
  request_id uuid not null references public.organization_offboarding_requests(id) on delete restrict,
  generation uuid not null,
  org_id uuid not null references public.organizations(id) on delete restrict,
  idempotency_key uuid not null,
  access_kind text not null check (
    access_kind in (
      'portal_opened', 'manifest_downloaded',
      'manifest_page_downloaded', 'artifact_link_issued'
    )
  ),
  artifact_name text,
  artifact_path text,
  artifact_sha256 text check (
    artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz not null default statement_timestamp(),
  primary key (request_id, generation, idempotency_key),
  check (
    (access_kind = 'portal_opened'
      and artifact_name is null and artifact_path is null and artifact_sha256 is null)
    or
    (access_kind in (
        'manifest_downloaded', 'manifest_page_downloaded', 'artifact_link_issued'
      )
      and nullif(trim(artifact_name), '') is not null
      and nullif(trim(artifact_path), '') is not null
      and artifact_sha256 is not null)
  )
);

create function private.reject_organization_export_access_event_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'organization_export_access_event_immutable' using errcode = '55000';
end
$$;
create trigger organization_export_access_events_immutable
before update or delete on private.organization_export_access_events
for each row execute function private.reject_organization_export_access_event_change();

-- External providers sit outside the database transaction. A short, fenced lease closes the
-- otherwise unavoidable gap between the final lifecycle check and the network request: an
-- offboarding request waits behind the KEY SHARE holder and then refuses to start while the
-- committed lease is still live. Leases are durable evidence, not a scheduler; expiry merely
-- abandons the right to start/continue egress and never asserts that a provider did nothing.
create table private.organization_external_egress_leases (
  lease_id uuid primary key default gen_random_uuid(),
  lease_token uuid not null unique default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (kind in (
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage'
  )),
  correlation_id uuid not null,
  status text not null default 'active' check (status in ('active', 'settled')),
  outcome text check (outcome in ('delivered', 'failed', 'denied', 'ambiguous')),
  evidence_code text check (
    evidence_code is null or evidence_code ~ '^[a-z0-9_:-]{1,100}$'
  ),
  provider_status integer check (provider_status is null or provider_status between 100 and 599),
  reserved_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by text,
  settled_at timestamptz,
  reservation_count integer not null default 1 check (reservation_count > 0),
  unique (org_id, kind, correlation_id),
  constraint organization_external_egress_expiry_check check (
    expires_at > reserved_at
    and (
      (
        acknowledged_at is null
        and acknowledged_by is null
        and expires_at <= reserved_at + interval '120 seconds'
      )
      or (
        kind = 'document_signed_url'
        and acknowledged_at is not null
        and acknowledged_by is not null
        and length(trim(acknowledged_by)) between 1 and 200
        and acknowledged_at >= reserved_at
        -- Canonical OCR_JOB_TIMEOUT_SECONDS maximum (3600s) plus the canonical
        -- OCR_REQUEST_TIMEOUT_SECONDS maximum (120s) leaves bounded gateway settlement time.
        and expires_at <= acknowledged_at + interval '3720 seconds'
      )
    )
  ),
  check (
    (status = 'active' and outcome is null and settled_at is null)
    or (status = 'settled' and outcome is not null and settled_at is not null)
  )
);
create index organization_external_egress_active_idx
  on private.organization_external_egress_leases (org_id, expires_at)
  where status = 'active';

-- Full provider responses are immutable recovery evidence. They deliberately live outside public
-- business tables, so a lifecycle flip after network egress can preserve the response without
-- reopening any financial, catalogue or notification mutation boundary.
create table private.organization_external_egress_evidence (
  lease_id uuid primary key
    references private.organization_external_egress_leases(lease_id) on delete restrict,
  org_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null,
  correlation_id uuid not null,
  outcome text not null check (outcome in ('delivered', 'failed', 'denied', 'ambiguous')),
  evidence_code text check (
    evidence_code is null or evidence_code ~ '^[a-z0-9_:-]{1,100}$'
  ),
  provider_status integer check (provider_status is null or provider_status between 100 and 599),
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object'
    and (
      (
        kind = 'document_signed_url'
        and outcome = 'delivered'
        and evidence_code = 'document_ocr_completed'
        and jsonb_typeof(evidence -> 'extraction') = 'object'
        -- The canonical worker/Edge contract permits an extraction payload up to 25 MiB.
        and octet_length((evidence -> 'extraction')::text) <= 26214400
        -- One MiB is reserved only for the fixed, validated evidence envelope.
        and octet_length(evidence::text) <= 27262976
      )
      or (
        not (
          kind = 'document_signed_url'
          and outcome = 'delivered'
          and evidence_code = 'document_ocr_completed'
        )
        and octet_length(evidence::text) <= 2097152
      )
    )
  ),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default statement_timestamp(),
  unique (org_id, kind, correlation_id)
);

create function private.reject_organization_external_egress_evidence_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'organization_external_egress_evidence_immutable' using errcode = '55000';
end
$$;
create trigger organization_external_egress_evidence_immutable
before update or delete on private.organization_external_egress_evidence
for each row execute function private.reject_organization_external_egress_evidence_change();

revoke all on table private.organization_export_snapshot_rows,
  private.organization_export_snapshot_table_states,
  private.organization_export_snapshot_storage_states,
  private.organization_export_snapshot_objects,
  private.organization_export_parts,
  private.organization_export_manifest_states,
  private.organization_export_access_events,
  private.organization_external_egress_leases,
  private.organization_external_egress_evidence
  from public, anon, authenticated, service_role;
revoke all on function private.reject_organization_external_egress_evidence_change()
  from public, anon, authenticated, service_role;
revoke all on function private.reject_organization_export_access_event_change()
  from public, anon, authenticated, service_role;

-- Keep the tenant's original Unicode filename in the human-facing manifest while refusing every
-- path shape that could escape the logical original-files root. Storage object keys are evidence,
-- not trusted filesystem paths; this check is repeated when the manifest is claimed.
create function private.tenant_export_source_logical_name(
  p_bucket_id text,
  p_object_name text
) returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_segment text;
begin
  if p_bucket_id is null
     or p_bucket_id not in ('documents', 'price-submissions', 'organization-branding')
     or p_object_name is null or p_object_name = ''
     or p_object_name like '/%'
     or p_object_name ~ '[[:cntrl:]]'
     or position(chr(92) in p_object_name) > 0 then
    raise exception 'tenant_export_source_name_invalid' using errcode = '22023';
  end if;
  foreach v_segment in array string_to_array(p_object_name, '/') loop
    if v_segment in ('', '.', '..') then
      raise exception 'tenant_export_source_name_invalid' using errcode = '22023';
    end if;
  end loop;
  return 'original-files/' || p_bucket_id || '/' || p_object_name;
end
$$;
revoke all on function private.tenant_export_source_logical_name(text, text)
  from public, anon, authenticated, service_role;

create function private.tenant_export_part_logical_name(
  p_kind text,
  p_payload jsonb
) returns text
language plpgsql
stable
set search_path = public, private, pg_temp
as $$
begin
  return case p_kind
    when 'table_json' then format(
      'data/%s/json/part-%s.json', p_payload ->> 'table_name',
      ((p_payload ->> 'batch_index')::bigint) + 1
    )
    when 'table_csv' then format(
      'data/%s/csv/part-%s.csv', p_payload ->> 'table_name',
      ((p_payload ->> 'batch_index')::bigint) + 1
    )
    when 'auth_accounts' then format(
      'data/auth_accounts/part-%s.json',
      ((p_payload ->> 'batch_index')::bigint) + 1
    )
    when 'source_object' then private.tenant_export_source_logical_name(
      p_payload ->> 'bucket_id', p_payload ->> 'object_name'
    )
    when 'manifest_page' then format(
      'manifest-pages/page-%s.json', ((p_payload ->> 'page_index')::bigint) + 1
    )
    when 'manifest' then 'manifest.json'
    else null
  end;
end
$$;
revoke all on function private.tenant_export_part_logical_name(text, jsonb)
  from public, anon, authenticated, service_role;

alter function private.scope_enforcement_violations() rename to scope_enforcement_violations_pre_0097;
create function private.scope_enforcement_violations()
returns table (assertion text, detail text)
language sql
stable
set search_path = public, pg_temp
as $$
  select * from private.scope_enforcement_violations_pre_0097()
  union all
  select 'A6'::text, violation.detail
  from private.tenant_export_registry_violations() violation
$$;
revoke all on function private.scope_enforcement_violations()
  from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-exports', 'tenant-exports', false, null,
  array[
    'application/json', 'text/csv', 'application/octet-stream'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No browser storage policy is intentional. Only the service-role Edge Function may write the
-- artifact or mint a signed link after re-checking the caller against the request row.

create or replace function private.organization_access_mode(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when o.id is null or o.status = 'suspended' then 'suspended'
    when exists (
      select 1
      from public.organization_offboarding_requests request
      where request.org_id = o.id
        and request.status in (
          'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
        )
    ) then 'offboarding'
    when o.status = 'active' then 'active'
    when o.trial_ends_at is null then 'read_only'
    when statement_timestamp() <= o.trial_ends_at then 'trial'
    when statement_timestamp() <= o.trial_ends_at + interval '7 days' then 'grace'
    else 'read_only'
  end
  from (select p_org_id as requested_id) requested
  left join public.organizations o on o.id = requested.requested_id
$$;

revoke all on function private.organization_access_mode(uuid)
  from public, anon, authenticated;

-- Storage RLS evaluates this helper inside the object-write transaction. Taking KEY SHARE is
-- load-bearing: request_organization_offboarding takes FOR UPDATE on the same organization row,
-- so it drains uploads that already crossed the policy and every later upload observes the
-- offboarding read-only state. VOLATILE prevents the planner from treating the lock as a cached
-- statement-level predicate.
create function private.organization_write_allowed_fenced(p_org_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is null then return false; end if;
  perform 1 from public.organizations organization
  where organization.id = p_org_id
  for key share;
  if not found then return false; end if;
  return private.organization_access_mode(p_org_id) in ('active', 'trial', 'grace');
end
$$;
revoke all on function private.organization_write_allowed_fenced(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.organization_write_allowed()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return private.organization_write_allowed_fenced(public.auth_org());
end
$$;
revoke all on function public.organization_write_allowed() from public, anon;
grant execute on function public.organization_write_allowed() to authenticated;

-- Enqueues race with offboarding just like public-table and Storage writes. Fence the organization
-- before accepting a new private outbox row and park it immediately when an open request exists.
create function private.park_integration_outbox_during_offboarding()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_request_id uuid;
begin
  perform 1 from public.organizations organization
  where organization.id = new.org_id
  for key share;

  select request.id into v_request_id
  from public.organization_offboarding_requests request
  where request.org_id = new.org_id
    and request.status in ('requested', 'approved', 'export_building', 'export_ready', 'export_failed')
  order by request.requested_at desc, request.id desc
  limit 1;

  if v_request_id is not null and new.status = 'pending' then
    new.status := 'parked';
    new.offboarding_request_id := v_request_id;
    new.parked_at := statement_timestamp();
    new.next_attempt_at := 'infinity'::timestamptz;
    new.claimed_by := null;
    new.claimed_at := null;
  end if;
  return new;
end
$$;
revoke all on function private.park_integration_outbox_during_offboarding()
  from public, anon, authenticated, service_role;
create trigger integration_outbox_offboarding_park
  before insert on private.integration_outbox
  for each row execute function private.park_integration_outbox_during_offboarding();

-- Keep the signed adapter projection from 0066, but make the database claim boundary canonical.
-- The fenced predicate drains claim transactions before offboarding can commit and prevents every
-- later pending/expired-claim row from being handed to a worker while the tenant is read-only.
create or replace function public.claim_integration_outbox(
  p_worker_id text,
  p_limit integer default 10
)
returns setof jsonb
language plpgsql
security definer
set search_path = public, vault, extensions, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_ts text := floor(extract(epoch from now()))::bigint::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200 then
    raise exception 'worker_id_invalid' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select o.id
    from private.integration_outbox o
    join public.organizations org on org.id = o.org_id
    where private.organization_write_allowed_fenced(o.org_id)
      and (
        (o.status = 'pending' and o.next_attempt_at <= now())
        or (o.status = 'claimed' and o.claimed_at <= now() - interval '10 minutes')
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ),
  claimed as (
    update private.integration_outbox o
    set status = 'claimed', claimed_by = v_worker, claimed_at = now(),
        attempt_count = o.attempt_count + 1, updated_at = now()
    from candidate
    where o.id = candidate.id
    returning o.id, o.org_id, o.target, o.event_id, o.attempt_count
  ),
  keyed as (
    insert into private.idempotency_keys (target, event_id, idempotency_key)
    select c.target, c.event_id, 'sf:' || c.event_id::text || ':' || c.target
    from claimed c
    on conflict (target, event_id) do nothing
  )
  select jsonb_build_object(
    'outbox_id', c.id,
    'target', c.target,
    'attempt', c.attempt_count,
    'idempotency_key', 'sf:' || c.event_id::text || ':' || c.target,
    'url', sub.url,
    'body', env.body,
    'timestamp', case when sub.url is not null then v_ts end,
    'signature', case when sub.url is not null
                   then encode(extensions.hmac(env.body || '.' || v_ts, sub.secret,
                                               'sha256'), 'hex')
                 end,
    'event', env.envelope)
  from claimed c
  join public.domain_events e on e.id = c.event_id
  cross join lateral (
    select built.envelope, built.envelope::text as body
    from (
      select jsonb_build_object(
        'id', e.id, 'sequence', e.sequence, 'event_type', e.event_type,
        'schema_version', e.schema_version, 'org_id', e.org_id, 'unit_id', e.unit_id,
        'entity_type', e.entity_type, 'entity_id', e.entity_id, 'actor_id', e.actor_id,
        'correlation_id', e.correlation_id, 'causation_id', e.causation_id,
        'occurred_at', e.occurred_at, 'payload', e.payload, 'metadata', e.metadata
      ) as envelope
    ) built
  ) env
  left join lateral (
    select w.url, ds.decrypted_secret as secret
    from public.webhook_subscriptions w
    join vault.decrypted_secrets ds on ds.id = w.secret_id
    where w.target = c.target and w.org_id = c.org_id and w.active
      and nullif(ds.decrypted_secret, '') is not null
  ) sub on true;
end
$$;
revoke all on function public.claim_integration_outbox(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_integration_outbox(text, integer) to service_role;

-- A worker that claimed before offboarding but was denied an egress lease has made no network
-- request. Park that exact attempt at infinity and retain failed-attempt evidence. Only this safe
-- pre-egress state is restored by cancellation/reactivation.
create function public.service_park_claimed_integration_outbox(
  p_outbox_id uuid,
  p_worker_id text,
  p_reason_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_reason text := lower(nullif(trim(p_reason_code), ''));
  v_probe private.integration_outbox;
  v_row private.integration_outbox;
  v_request_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200
     or v_reason is null or v_reason !~ '^[a-z0-9_:-]{1,100}$' then
    raise exception 'integration_outbox_park_invalid' using errcode = '22023';
  end if;
  select * into v_probe from private.integration_outbox where id = p_outbox_id;
  if not found then raise exception 'outbox_row_unknown' using errcode = 'P0002'; end if;

  select request.id into v_request_id
  from public.organization_offboarding_requests request
  where request.org_id = v_probe.org_id
    and request.status in ('requested', 'approved', 'export_building', 'export_ready', 'export_failed')
  order by request.requested_at desc, request.id desc
  for update
  limit 1;
  if not found then
    raise exception 'integration_outbox_park_without_offboarding' using errcode = '55000';
  end if;

  select * into v_row from private.integration_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if v_row.status = 'parked' and v_row.offboarding_request_id = v_request_id then
    return jsonb_build_object(
      'outbox_id', v_row.id, 'status', 'parked', 'egress_started', false,
      'idempotent', true
    );
  end if;
  if v_row.status <> 'claimed' or v_row.claimed_by is distinct from v_worker then
    raise exception 'outbox_claim_lost' using errcode = '55000';
  end if;

  insert into private.integration_deliveries (
    outbox_id, attempt, status, error, correlation_id
  ) values (
    v_row.id, v_row.attempt_count, 'failed', 'pre_egress_denied:' || v_reason,
    v_row.correlation_id
  );
  update private.integration_outbox outbox
  set status = 'parked', next_attempt_at = 'infinity'::timestamptz,
      claimed_by = null, claimed_at = null,
      offboarding_request_id = v_request_id, parked_at = statement_timestamp(),
      last_error = 'pre_egress_denied:' || v_reason, updated_at = statement_timestamp()
  where outbox.id = v_row.id;
  return jsonb_build_object(
    'outbox_id', v_row.id, 'status', 'parked', 'egress_started', false,
    'idempotent', false
  );
end
$$;
revoke all on function public.service_park_claimed_integration_outbox(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_park_claimed_integration_outbox(uuid, text, text)
  to service_role;

-- Settle an attempt only after the HTTP client has returned. An ambiguous result is terminal.
-- A definite failure also becomes terminal if the tenant changed lifecycle while the provider
-- request was in flight; retrying later would cross the boundary a second time without authority.
create function public.service_settle_claimed_integration_outbox(
  p_outbox_id uuid,
  p_worker_id text,
  p_outcome text,
  p_response_code integer default null,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_outcome text := lower(nullif(trim(p_outcome), ''));
  v_error text := nullif(left(trim(coalesce(p_error, '')), 900), '');
  v_row private.integration_outbox;
  v_next timestamptz;
  v_terminal_error text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200
     or v_outcome not in ('delivered', 'failed', 'ambiguous')
     or p_response_code is not null and p_response_code not between 100 and 599
     or v_outcome <> 'delivered' and v_error is null then
    raise exception 'integration_outbox_settlement_invalid' using errcode = '22023';
  end if;

  select * into v_row from private.integration_outbox outbox
  where outbox.id = p_outbox_id
  for update;
  if not found then raise exception 'outbox_row_unknown' using errcode = 'P0002'; end if;
  if v_row.status <> 'claimed' then
    if exists (
      select 1 from private.integration_deliveries delivery
      where delivery.outbox_id = v_row.id and delivery.attempt = v_row.attempt_count
    ) then
      return jsonb_build_object(
        'outbox_id', v_row.id, 'status', v_row.status,
        'attempt', v_row.attempt_count, 'idempotent', true
      );
    end if;
    raise exception 'outbox_claim_lost' using errcode = '55000';
  end if;
  if v_row.claimed_by is distinct from v_worker then
    raise exception 'outbox_claim_lost' using errcode = '55000';
  end if;

  insert into private.integration_deliveries (
    outbox_id, attempt, status, response_code, error, correlation_id
  ) values (
    v_row.id, v_row.attempt_count,
    case when v_outcome = 'delivered' then 'delivered' else 'failed' end,
    p_response_code, v_error, v_row.correlation_id
  );

  if v_outcome = 'delivered' then
    update private.integration_outbox outbox
    set status = 'delivered', delivered_at = statement_timestamp(),
        claimed_by = null, claimed_at = null, last_error = null,
        updated_at = statement_timestamp()
    where outbox.id = v_row.id;
    return jsonb_build_object(
      'outbox_id', v_row.id, 'status', 'delivered',
      'attempt', v_row.attempt_count, 'idempotent', false
    );
  end if;

  if v_outcome = 'ambiguous'
     or private.organization_access_mode(v_row.org_id) not in ('active', 'trial', 'grace')
     or v_row.attempt_count >= 8 then
    v_terminal_error := case
      when v_outcome = 'ambiguous' then 'ambiguous_after_egress:' || v_error
      when private.organization_access_mode(v_row.org_id) not in ('active', 'trial', 'grace')
        then 'lifecycle_changed_after_egress:' || v_error
      else v_error
    end;
    update private.integration_outbox outbox
    set status = 'dead_letter', claimed_by = null, claimed_at = null,
        last_error = v_terminal_error, updated_at = statement_timestamp()
    where outbox.id = v_row.id;
    insert into private.dead_letter_records (
      outbox_id, event_id, target, failure_reason, attempts
    ) values (
      v_row.id, v_row.event_id, v_row.target, v_terminal_error, v_row.attempt_count
    );
    return jsonb_build_object(
      'outbox_id', v_row.id, 'status', 'dead_letter',
      'attempt', v_row.attempt_count, 'idempotent', false
    );
  end if;

  v_next := statement_timestamp() + make_interval(
    mins => least(360, (4 ^ (v_row.attempt_count - 1))::integer)
  );
  update private.integration_outbox outbox
  set status = 'pending', next_attempt_at = v_next,
      claimed_by = null, claimed_at = null, last_error = v_error,
      updated_at = statement_timestamp()
  where outbox.id = v_row.id;
  return jsonb_build_object(
    'outbox_id', v_row.id, 'status', 'pending', 'attempt', v_row.attempt_count,
    'next_attempt_at', v_next, 'idempotent', false
  );
end
$$;
revoke all on function public.service_settle_claimed_integration_outbox(
  uuid, text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.service_settle_claimed_integration_outbox(
  uuid, text, text, integer, text
) to service_role;

-- Preserve the established Edge contract while routing it through the lifecycle-aware settlement
-- primitive. New workers should use service_settle_claimed_integration_outbox directly so an
-- ambiguous transport outcome can be represented explicitly.
create or replace function public.complete_integration_outbox_delivery(
  p_outbox_id uuid,
  p_worker_id text,
  p_response_code integer default null
) returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.service_settle_claimed_integration_outbox(
    p_outbox_id, p_worker_id, 'delivered', p_response_code, null
  )
$$;
create or replace function public.fail_integration_outbox_delivery(
  p_outbox_id uuid,
  p_worker_id text,
  p_error text,
  p_response_code integer default null
) returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.service_settle_claimed_integration_outbox(
    p_outbox_id, p_worker_id, 'failed', p_response_code, p_error
  )
$$;
revoke all on function public.complete_integration_outbox_delivery(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.complete_integration_outbox_delivery(uuid, text, integer)
  to service_role;
revoke all on function public.fail_integration_outbox_delivery(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_integration_outbox_delivery(uuid, text, text, integer)
  to service_role;

create function public.service_organization_access_mode(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.organization_access_mode(p_org_id)
  where auth.role() = 'service_role'
$$;

revoke all on function public.service_organization_access_mode(uuid)
  from public, anon, authenticated;
grant execute on function public.service_organization_access_mode(uuid) to service_role;

-- Reserve the right to cross an external-provider boundary. The organization row lock uses the
-- same order as request_organization_offboarding, and the canonical access mode is checked only
-- after that lock is held. A repeated correlation never authorizes a second send after settlement.
create function public.service_reserve_organization_external_egress(
  p_org_id uuid,
  p_kind text,
  p_correlation_id uuid,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := lower(nullif(trim(p_kind), ''));
  v_lease private.organization_external_egress_leases;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or p_correlation_id is null
     or v_kind not in (
       'document_interpretation', 'invitation_email', 'push_notification',
       'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
       'organization_logo_storage'
     ) or p_ttl_seconds not between 5 and 120 then
    raise exception 'organization_external_egress_reservation_invalid' using errcode = '22023';
  end if;

  perform 1 from public.organizations organization
  where organization.id = p_org_id
  for key share;
  if not found then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.org_id = p_org_id and lease.kind = v_kind
    and lease.correlation_id = p_correlation_id
  for update;
  if found and v_lease.status = 'settled' then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', v_lease.outcome, 'idempotent', true
    );
  end if;
  if found and v_lease.expires_at < statement_timestamp() then
    update private.organization_external_egress_leases lease
    set status = 'settled', outcome = 'ambiguous',
        evidence_code = 'lease_expired_without_settlement', settled_at = statement_timestamp()
    where lease.lease_id = v_lease.lease_id
    returning * into v_lease;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', 'ambiguous', 'idempotent', true
    );
  end if;
  if private.organization_access_mode(p_org_id) not in ('active', 'trial', 'grace') then
    raise exception 'organization_external_egress_not_allowed' using errcode = '42501';
  end if;
  if found and v_lease.expires_at >= statement_timestamp() then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', true, 'settled_outcome', null, 'idempotent', true
    );
  end if;

  insert into private.organization_external_egress_leases (
    org_id, kind, correlation_id, expires_at
  ) values (
    p_org_id, v_kind, p_correlation_id,
    statement_timestamp() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_lease;

  return jsonb_build_object(
    'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
    'org_id', v_lease.org_id, 'kind', v_lease.kind,
    'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
    'egress_allowed', true, 'settled_outcome', null, 'idempotent', false
  );
end
$$;
revoke all on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) to service_role;

-- Internal exact-token settlement. It remains callable after lease expiry or a lifecycle flip:
-- those facts must stop new egress, never erase the evidence of an attempt already made.
create function private.settle_organization_external_egress(
  p_lease_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_evidence_code text default null,
  p_provider_status integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outcome text := lower(nullif(trim(p_outcome), ''));
  v_evidence text := lower(nullif(trim(p_evidence_code), ''));
  v_lease private.organization_external_egress_leases;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_outcome not in ('delivered', 'failed', 'denied', 'ambiguous')
     or v_evidence is not null and v_evidence !~ '^[a-z0-9_:-]{1,100}$'
     or p_provider_status is not null and p_provider_status not between 100 and 599 then
    raise exception 'organization_external_egress_settlement_invalid' using errcode = '22023';
  end if;
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_lease_id
  for update;
  if not found then
    raise exception 'organization_external_egress_lease_unknown' using errcode = 'P0002';
  end if;
  if v_lease.lease_token is distinct from p_lease_token then
    raise exception 'organization_external_egress_lease_lost' using errcode = '40001';
  end if;
  if v_lease.status = 'settled' then
    if v_lease.outcome = v_outcome
       and v_lease.evidence_code is not distinct from v_evidence
       and v_lease.provider_status is not distinct from p_provider_status then
      return jsonb_build_object(
        'lease_id', v_lease.lease_id, 'org_id', v_lease.org_id,
        'kind', v_lease.kind, 'correlation_id', v_lease.correlation_id,
        'outcome', v_lease.outcome, 'idempotent', true
      );
    end if;
    raise exception 'organization_external_egress_already_settled' using errcode = '55000';
  end if;
  update private.organization_external_egress_leases lease
  set status = 'settled', outcome = v_outcome, evidence_code = v_evidence,
      provider_status = p_provider_status, settled_at = statement_timestamp()
  where lease.lease_id = v_lease.lease_id;
  return jsonb_build_object(
    'lease_id', v_lease.lease_id, 'org_id', v_lease.org_id,
    'kind', v_lease.kind, 'correlation_id', v_lease.correlation_id,
    'outcome', v_outcome, 'idempotent', false
  );
end
$$;
revoke all on function private.settle_organization_external_egress(
  uuid, uuid, text, text, integer
) from public, anon, authenticated, service_role;

create function public.service_release_organization_external_egress(
  p_lease_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_evidence_code text default null,
  p_provider_status integer default null
) returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select private.settle_organization_external_egress(
    p_lease_id, p_lease_token, p_outcome, p_evidence_code, p_provider_status
  )
$$;
revoke all on function public.service_release_organization_external_egress(
  uuid, uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.service_release_organization_external_egress(
  uuid, uuid, text, text, integer
) to service_role;

-- Append full provider evidence and settle the exact lease in one transaction. This RPC stays
-- valid after lease expiry or lifecycle change because it cannot mutate any public business row.
create function public.service_settle_organization_external_egress_evidence(
  p_lease_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_evidence_code text default null,
  p_provider_status integer default null,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_outcome text := lower(nullif(trim(p_outcome), ''));
  v_evidence_code text := lower(nullif(trim(p_evidence_code), ''));
  v_payload jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_sha256 text;
  v_provider_result_sha256 text;
  v_lease private.organization_external_egress_leases;
  v_existing private.organization_external_egress_evidence;
  v_settlement jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_lease_id is null or p_lease_token is null
     or v_outcome not in ('delivered', 'failed', 'denied', 'ambiguous')
     or v_evidence_code is not null
        and v_evidence_code !~ '^[a-z0-9_:-]{1,100}$'
     or p_provider_status is not null and p_provider_status not between 100 and 599
     or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'organization_external_egress_evidence_invalid' using errcode = '22023';
  end if;
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_lease_id
  for update;
  if not found then
    raise exception 'organization_external_egress_lease_unknown' using errcode = 'P0002';
  end if;
  if v_lease.lease_token is distinct from p_lease_token then
    raise exception 'organization_external_egress_lease_lost' using errcode = '40001';
  end if;
  -- Successful OCR evidence must pass the attempt/job/input/contract binding performed by the
  -- narrow recorder below. Letting the generic lease-token RPC write that immutable tuple would
  -- allow an unbound payload to poison the attempt permanently.
  if v_lease.kind = 'document_signed_url'
     and v_outcome = 'delivered'
     and v_evidence_code = 'document_ocr_completed' then
    raise exception 'document_ocr_evidence_narrow_rpc_required' using errcode = '42501';
  end if;
  if octet_length(v_payload::text) > 2097152 then
    raise exception 'organization_external_egress_evidence_invalid' using errcode = '22023';
  end if;

  -- JSONB::text is PostgreSQL's canonical object-key representation. Interpretation callers may
  -- send a convenience hash, but the database overwrites it from the immutable nested provider
  -- result so JavaScript property order can never become part of the evidence contract.
  if v_lease.kind = 'document_interpretation'
     and jsonb_typeof(v_payload -> 'interpretation') = 'object' then
    v_provider_result_sha256 := encode(digest(
      convert_to((v_payload -> 'interpretation')::text, 'UTF8'), 'sha256'
    ), 'hex');
    v_payload := jsonb_set(
      v_payload, '{provider_result_sha256}', to_jsonb(v_provider_result_sha256), true
    );
  end if;
  v_sha256 := encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  select * into v_existing
  from private.organization_external_egress_evidence evidence
  where evidence.lease_id = v_lease.lease_id;
  if found then
    if v_existing.outcome is distinct from v_outcome
       or v_existing.evidence_code is distinct from v_evidence_code
       or v_existing.provider_status is distinct from p_provider_status
       or v_existing.evidence_sha256 is distinct from v_sha256 then
      raise exception 'organization_external_egress_evidence_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'org_id', v_lease.org_id,
      'kind', v_lease.kind, 'correlation_id', v_lease.correlation_id,
      'lease_outcome', v_lease.outcome, 'evidence_outcome', v_existing.outcome,
      'evidence_sha256', v_existing.evidence_sha256,
      'provider_result_sha256', v_existing.evidence ->> 'provider_result_sha256',
      'idempotent', true
    );
  end if;

  if v_lease.status = 'active' then
    v_settlement := private.settle_organization_external_egress(
      v_lease.lease_id, p_lease_token, v_outcome, v_evidence_code, p_provider_status
    );
    v_lease.outcome := v_outcome;
  elsif v_lease.outcome <> v_outcome
        and not (
          v_lease.outcome = 'ambiguous'
          and v_lease.evidence_code in (
            'lease_expired_without_settlement',
            'job_lease_expired_before_settlement'
          )
        ) then
    raise exception 'organization_external_egress_already_settled' using errcode = '55000';
  end if;

  insert into private.organization_external_egress_evidence (
    lease_id, org_id, kind, correlation_id, outcome, evidence_code,
    provider_status, evidence, evidence_sha256
  ) values (
    v_lease.lease_id, v_lease.org_id, v_lease.kind, v_lease.correlation_id,
    v_outcome, v_evidence_code, p_provider_status, v_payload, v_sha256
  );

  return jsonb_build_object(
    'lease_id', v_lease.lease_id, 'org_id', v_lease.org_id,
    'kind', v_lease.kind, 'correlation_id', v_lease.correlation_id,
    'lease_outcome', v_lease.outcome, 'evidence_outcome', v_outcome,
    'evidence_sha256', v_sha256,
    'provider_result_sha256', v_provider_result_sha256,
    'idempotent', false
  );
end
$$;
revoke all on function public.service_settle_organization_external_egress_evidence(
  uuid, uuid, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.service_settle_organization_external_egress_evidence(
  uuid, uuid, text, text, integer, jsonb
) to service_role;

create function public.service_get_organization_external_egress_evidence(
  p_org_id uuid,
  p_kind text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or nullif(trim(p_kind), '') is null or p_correlation_id is null then
    raise exception 'organization_external_egress_evidence_lookup_invalid' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'lease_id', evidence.lease_id, 'org_id', evidence.org_id,
    'kind', evidence.kind, 'correlation_id', evidence.correlation_id,
    'lease_outcome', lease.outcome, 'evidence_outcome', evidence.outcome,
    'evidence_code', evidence.evidence_code, 'provider_status', evidence.provider_status,
    'evidence', evidence.evidence, 'evidence_sha256', evidence.evidence_sha256,
    'recorded_at', evidence.recorded_at
  ) into v_result
  from private.organization_external_egress_evidence evidence
  join private.organization_external_egress_leases lease
    on lease.lease_id = evidence.lease_id
  where evidence.org_id = p_org_id
    and evidence.kind = lower(trim(p_kind))
    and evidence.correlation_id = p_correlation_id;
  return v_result;
end
$$;
revoke all on function public.service_get_organization_external_egress_evidence(
  uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.service_get_organization_external_egress_evidence(
  uuid, text, uuid
) to service_role;

create function public.record_notification_push_delivery_outcome(
  p_notification_id uuid,
  p_outcome text,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outcome text := lower(nullif(trim(p_outcome), ''));
  v_error text := left(coalesce(nullif(trim(p_error), ''), 'push_delivery_failed'), 500);
  v_notification public.notifications;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_notification_id is null
     or v_outcome not in ('delivered', 'partial', 'no_delivery', 'failed') then
    raise exception 'notification_push_outcome_invalid' using errcode = '22023';
  end if;

  select * into v_notification
  from public.notifications notification
  where notification.id = p_notification_id
  for update;
  if not found then
    raise exception 'notification_unknown' using errcode = 'P0002';
  end if;

  if v_notification.push_terminal_at is not null then
    if v_notification.push_terminal_reason = v_outcome then
      return jsonb_build_object(
        'notification_id', v_notification.id, 'outcome', v_outcome,
        'terminal', true, 'idempotent', true
      );
    end if;
    raise exception 'notification_push_outcome_already_terminal' using errcode = '55000';
  end if;

  update public.notifications notification
  set push_attempts = notification.push_attempts + 1,
      push_sent_at = case
        when v_outcome in ('delivered', 'partial')
          then coalesce(notification.push_sent_at, statement_timestamp())
        else notification.push_sent_at
      end,
      push_terminal_at = case
        when v_outcome in ('delivered', 'partial', 'no_delivery')
          then statement_timestamp()
        else null
      end,
      push_terminal_reason = case
        when v_outcome in ('delivered', 'partial', 'no_delivery') then v_outcome
        else null
      end,
      push_last_error = case
        when v_outcome = 'delivered' then null
        when v_outcome = 'no_delivery' and nullif(trim(p_error), '') is null
          then 'push_no_delivery'
        else v_error
      end
  where notification.id = v_notification.id
  returning * into v_notification;

  return jsonb_build_object(
    'notification_id', v_notification.id, 'outcome', v_outcome,
    'terminal', v_notification.push_terminal_at is not null, 'idempotent', false
  );
end
$$;
revoke all on function public.record_notification_push_delivery_outcome(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_notification_push_delivery_outcome(uuid, text, text)
  to service_role;

-- Preserve the established caller contract while routing it through the explicit outcome model.
create or replace function public.record_notification_push_result(
  p_notification_id uuid,
  p_delivered boolean,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_delivered is null then
    raise exception 'notification_push_result_invalid' using errcode = '22023';
  end if;
  perform public.record_notification_push_delivery_outcome(
    p_notification_id,
    case when p_delivered then 'delivered' else 'failed' end,
    p_error
  );
end
$$;
revoke all on function public.record_notification_push_result(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_notification_push_result(uuid, boolean, text)
  to service_role;

create or replace function public.enqueue_notification_delivery(
  p_org_id uuid,
  p_event_code text,
  p_entity_key text,
  p_severity text,
  p_title text,
  p_body text,
  p_target_url text,
  p_dedupe_key text
) returns table (
  notification_id uuid,
  user_id uuid,
  notification_dedupe_key text,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null
     or nullif(trim(p_event_code), '') is null
     or nullif(trim(p_entity_key), '') is null
     or p_severity not in ('warning', 'critical')
     or nullif(trim(p_title), '') is null
     or nullif(trim(p_body), '') is null
     or nullif(trim(p_target_url), '') is null
     or left(p_target_url, 1) <> '/'
     or left(p_target_url, 2) = '//'
     or nullif(trim(p_dedupe_key), '') is null then
    raise exception 'notification_delivery_invalid' using errcode = '22023';
  end if;
  if not coalesce(private.organization_write_allowed_fenced(p_org_id), false) then return; end if;

  with eligible as (
    select profile.id,
           coalesce(preference.push_enabled, true) as push_enabled
    from public.profiles profile
    left join public.notification_preferences preference
      on preference.org_id = profile.org_id
     and preference.user_id = profile.id
     and preference.event_code = trim(p_event_code)
    where profile.org_id = p_org_id
      and profile.active
      and profile.role in ('owner', 'office')
      and coalesce(preference.inapp_enabled, true)
  ), inserted as (
    insert into public.notifications (
      org_id, user_id, event_code, entity_key, severity,
      title, body, target_url, dedupe_key, push_sent_at
    )
    select
      p_org_id, eligible.id, trim(p_event_code), trim(p_entity_key), p_severity,
      trim(p_title), trim(p_body), trim(p_target_url), trim(p_dedupe_key),
      case when eligible.push_enabled then null else now() end
    from eligible
    where not exists (
      select 1
      from public.notifications existing
      where existing.user_id = eligible.id
        and existing.dedupe_key in (
          trim(p_dedupe_key),
          trim(p_dedupe_key) || ':' || eligible.id::text
        )
    )
    on conflict on constraint notifications_user_id_dedupe_key_key do nothing
    returning id
  )
  select coalesce(array_agg(inserted.id), '{}'::uuid[])
    into v_created_ids
  from inserted;

  return query
  select notification.id, notification.user_id, notification.dedupe_key,
         notification.id = any(v_created_ids)
  from public.notifications notification
  where notification.org_id = p_org_id
    and notification.event_code = trim(p_event_code)
    and notification.entity_key = trim(p_entity_key)
    and notification.dedupe_key in (
      trim(p_dedupe_key),
      trim(p_dedupe_key) || ':' || notification.user_id::text
    )
    and notification.push_sent_at is null
    and notification.push_terminal_at is null
  order by notification.user_id;
end
$$;
revoke all on function public.enqueue_notification_delivery(
  uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_notification_delivery(
  uuid, text, text, text, text, text, text, text
) to service_role;

-- Reminder discovery and queue claiming share one worker batch across organizations. Every
-- candidate must therefore pass the canonical fenced write predicate before any status/lease
-- mutation, so an offboarding tenant cannot poison work that remains eligible for another one.
create or replace function public.claim_whatsapp_confirmation_reminders(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired public.whatsapp_order_messages;
  v_message public.whatsapp_order_messages;
  v_results jsonb := '[]'::jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  -- Once a provider attempt has started, an expired lease is ambiguous and is
  -- frozen for manual review. Offboarding/read-only tenants remain untouched.
  for v_expired in
    update public.whatsapp_order_messages message
    set status = 'unknown', lease_expires_at = null,
        error_code = 'reminder_send_lease_expired',
        error_message = 'לא ידוע אם תזכורת WhatsApp נשלחה'
    where message.kind = 'reminder' and message.status = 'sending'
      and message.lease_expires_at <= now()
      and private.organization_write_allowed_fenced(message.org_id)
    returning message.*
  loop
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_expired.org_id, null, 'whatsapp_reminder_ambiguous',
      'whatsapp_order_messages', v_expired.id,
      jsonb_build_object('status', 'unknown', 'order_id', v_expired.order_id),
      'פג תוקף נעילת השליחה לאחר תחילת ניסיון מול Meta'
    );
  end loop;

  insert into public.whatsapp_order_messages (
    org_id, order_id, kind, status, recipient_number, confirm_token_hash,
    attempt_count, lease_expires_at, created_by
  )
  select candidate.org_id, candidate.order_id, 'reminder', 'queued',
         candidate.recipient_number, null, 0, null, candidate.created_by
  from (
    select original.org_id, original.order_id, original.created_by,
           original.recipient_number
    from public.whatsapp_order_messages original
    join public.purchase_orders po
      on po.org_id = original.org_id and po.id = original.order_id and po.status = 'sent'
    join public.suppliers supplier
      on supplier.org_id = po.org_id and supplier.id = po.supplier_id
     and supplier.deleted_at is null
    join public.whatsapp_connections connection
      on connection.org_id = original.org_id and connection.status = 'active'
    left join public.whatsapp_order_messages reminder
      on reminder.org_id = original.org_id
     and reminder.order_id = original.order_id and reminder.kind = 'reminder'
    where original.kind = 'order'
      and original.status in ('accepted', 'sent', 'delivered', 'read')
      and original.accepted_at <= now() - interval '24 hours'
      and original.recipient_number is not null
      and reminder.id is null
      and private.organization_write_allowed_fenced(original.org_id)
    order by original.accepted_at, original.order_id
    limit v_limit
    for update of original skip locked
  ) candidate
  on conflict (org_id, order_id, kind) do nothing;

  for v_message in
    select message.*
    from public.whatsapp_order_messages message
    join public.purchase_orders po
      on po.org_id = message.org_id and po.id = message.order_id and po.status = 'sent'
    join public.whatsapp_connections connection
      on connection.org_id = message.org_id and connection.status = 'active'
    where message.kind = 'reminder' and message.status = 'queued'
      and (message.lease_expires_at is null or message.lease_expires_at <= now())
      and private.organization_write_allowed_fenced(message.org_id)
    order by message.created_at, message.id
    limit v_limit
    for update of message skip locked
  loop
    update public.whatsapp_order_messages message
    set lease_expires_at = now() + interval '5 minutes'
    where message.id = v_message.id
    returning message.* into v_message;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'message_id', v_message.id,
      'delivery_status', v_message.status
    ));
  end loop;

  return v_results;
end
$$;
revoke all on function public.claim_whatsapp_confirmation_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_confirmation_reminders(integer) to service_role;

-- A reminder may cross the provider boundary only after it reserves an organization-scoped
-- external-egress lease. The returned lease evidence is part of the existing JSON result rather
-- than a signature change; the caller must settle it after the provider attempt.
create or replace function public.begin_whatsapp_reminder_send(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_message public.whatsapp_order_messages;
  v_order public.purchase_orders;
  v_supplier public.suppliers;
  v_connection public.whatsapp_connections;
  v_egress jsonb;
  v_raw_token text;
  v_items jsonb;
  v_total numeric(12,2);
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_message_id is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;
  select * into v_message from public.whatsapp_order_messages
  where id = p_message_id for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;
  if v_message.kind <> 'reminder' then
    raise exception 'whatsapp_reminder_invalid' using errcode = '22023';
  end if;

  if v_message.status = 'sending' and v_message.lease_expires_at <= now() then
    update public.whatsapp_order_messages
    set status = 'unknown', lease_expires_at = null,
        error_code = 'reminder_send_lease_expired',
        error_message = 'לא ידוע אם תזכורת WhatsApp נשלחה'
    where id = v_message.id
    returning * into v_message;
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_ambiguous',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object('status', 'unknown', 'order_id', v_message.order_id),
      'פג תוקף נעילת השליחה לאחר תחילת ניסיון מול Meta'
    );
  end if;
  if v_message.status <> 'queued' then
    return jsonb_build_object(
      'message_id', v_message.id,
      'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false,
      'idempotent', true
    );
  end if;
  if v_message.recipient_number is null then
    raise exception 'whatsapp_recipient_snapshot_missing' using errcode = 'P0001';
  end if;

  select * into v_order from public.purchase_orders
  where org_id = v_message.org_id and id = v_message.order_id for update;
  if not found then raise exception 'whatsapp_order_unknown' using errcode = 'P0002'; end if;
  if v_order.status <> 'sent' then
    update public.whatsapp_order_messages
    set status = 'failed', lease_expires_at = null,
        failed_at = coalesce(failed_at, now()),
        error_code = 'order_no_longer_pending',
        error_message = 'ההזמנה כבר אינה ממתינה לאישור ספק'
    where id = v_message.id
    returning * into v_message;
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_not_sent',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object(
        'status', 'failed', 'order_id', v_message.order_id,
        'error_code', 'order_no_longer_pending'
      ),
      'ההזמנה כבר אינה ממתינה לאישור ספק; התזכורת לא נשלחה'
    );
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', false,
      'reason', 'order_no_longer_pending'
    );
  end if;

  select * into v_supplier from public.suppliers
  where org_id = v_order.org_id and id = v_order.supplier_id and deleted_at is null;
  if not found then
    update public.whatsapp_order_messages
    set status = 'failed', lease_expires_at = null,
        failed_at = coalesce(failed_at, now()),
        error_code = 'supplier_unavailable',
        error_message = 'הספק אינו פעיל עוד; התזכורת לא נשלחה'
    where id = v_message.id
    returning * into v_message;
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_not_sent',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object(
        'status', 'failed', 'order_id', v_message.order_id,
        'error_code', 'supplier_unavailable'
      ),
      'הספק אינו פעיל עוד; התזכורת לא נשלחה'
    );
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', false,
      'reason', 'supplier_unavailable'
    );
  end if;
  select * into v_connection from public.whatsapp_connections
  where org_id = v_order.org_id and status = 'active';
  if not found then
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', true,
      'reason', 'connection_inactive'
    );
  end if;

  v_egress := public.service_reserve_organization_external_egress(
    v_message.org_id, 'whatsapp_reminder', v_message.id, 120
  );
  if not coalesce((v_egress ->> 'egress_allowed')::boolean, false) then
    raise exception 'whatsapp_reminder_egress_already_settled' using errcode = '55000';
  end if;

  v_raw_token := encode(gen_random_bytes(32), 'hex');
  update public.whatsapp_order_messages
  set status = 'sending',
      confirm_token_hash = encode(sha256(convert_to(v_raw_token, 'UTF8')), 'hex'),
      attempt_count = 1,
      last_attempt_at = now(),
      lease_expires_at = now() + interval '5 minutes',
      failed_at = null, error_code = null, error_message = null
  where id = v_message.id
  returning * into v_message;

  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', item.product_id,
      'product_name', product.name,
      'unit', product.unit,
      'qty', item.qty,
      'unit_price', item.unit_price,
      'line_total', round(item.qty * item.unit_price, 2)
    ) order by product.name, item.id), '[]'::jsonb),
    round(coalesce(sum(item.qty * item.unit_price), 0), 2)
  into v_items, v_total
  from public.purchase_order_items item
  join public.products product
    on product.org_id = item.org_id and product.id = item.product_id
  where item.org_id = v_order.org_id and item.order_id = v_order.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_message.org_id, null, 'whatsapp_reminder_send_started',
    'whatsapp_order_messages', v_message.id,
    jsonb_build_object(
      'status', 'sending', 'order_id', v_message.order_id,
      'egress_lease_id', v_egress ->> 'lease_id'
    ),
    'החל ניסיון שליחת תזכורת מול Meta'
  );

  return jsonb_build_object(
    'message_id', v_message.id,
    'delivery_status', v_message.status,
    'recipient_number', v_message.recipient_number,
    'confirmation_token', v_raw_token,
    'should_send', true,
    'idempotent', false,
    'egress_lease_id', v_egress ->> 'lease_id',
    'egress_lease_token', v_egress ->> 'lease_token',
    'egress_lease_expires_at', v_egress ->> 'expires_at',
    'order', jsonb_build_object(
      'id', v_order.id,
      'number', v_order.number,
      'expected_date', v_order.expected_date,
      'notes', v_order.notes,
      'total', v_total,
      'items', v_items
    ),
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', v_supplier.name,
      'whatsapp', v_message.recipient_number
    ),
    'connection', jsonb_build_object(
      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,
      'display_phone_number', v_connection.display_phone_number,
      'template_name', v_connection.reminder_template_name,
      'language_code', v_connection.language_code
    )
  );
end
$$;
revoke all on function public.begin_whatsapp_reminder_send(uuid)
  from public, anon, authenticated;
grant execute on function public.begin_whatsapp_reminder_send(uuid) to service_role;

-- The document cron must skip an offboarding tenant before it writes a dispatch lease. Relying
-- only on the table guard would abort the whole multi-tenant batch at the first read-only row.
create or replace function private.claim_document_interpretation_jobs(
  p_limit integer,
  p_max_starts_per_org_hour integer
) returns table (job_id uuid)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_candidate record;
begin
  if p_limit not between 1 and 100
     or p_max_starts_per_org_hour not between 1 and 100 then
    raise exception 'document_interpretation_dispatch_limit_invalid' using errcode = '22023';
  end if;

  for v_candidate in
    with eligible as (
      select j.id, j.org_id, j.created_at,
             row_number() over (
               partition by j.org_id order by j.created_at, j.id
             ) as tenant_position
      from public.document_processing_jobs j
      join public.documents d
        on d.org_id = j.org_id and d.id = j.document_id and d.deleted_at is null
      join public.document_extractions e
        on e.org_id = j.org_id and e.job_id = j.id and e.document_id = d.id
       and e.input_checksum = j.input_checksum and e.contract_version = j.contract_version
      join public.profiles p
        on p.org_id = j.org_id and p.id = d.uploaded_by and p.active
       and p.role in ('owner', 'office', 'kitchen', 'supplier')
      left join private.document_interpretation_dispatches sent on sent.job_id = j.id
      where private.organization_access_mode(j.org_id) in ('active', 'trial', 'grace')
        and j.status = 'extracted'
        and j.requested_by = d.uploaded_by
        and not exists (
          select 1 from public.document_interpretations i
          where i.org_id = j.org_id and i.job_id = j.id
        )
        and (
          sent.job_id is null
          or sent.last_dispatched_at <= clock_timestamp() - interval '5 minutes'
        )
        and (
          select count(*)
          from public.document_processing_jobs recent
          where recent.org_id = j.org_id
            and recent.interpretation_started_at
              >= clock_timestamp() - interval '1 hour'
        ) < p_max_starts_per_org_hour
    )
    select id, org_id
    from eligible
    where tenant_position = 1
    order by created_at, id
    limit p_limit
  loop
    if not coalesce(
      private.organization_write_allowed_fenced(v_candidate.org_id), false
    ) then
      continue;
    end if;
    perform 1
    from public.document_processing_jobs j
    where j.id = v_candidate.id and j.status = 'extracted'
    for update skip locked;
    if not found then continue; end if;

    insert into private.document_interpretation_dispatches (
      job_id, org_id, last_dispatched_at, attempt_count
    ) values (
      v_candidate.id, v_candidate.org_id, clock_timestamp(), 1
    )
    on conflict on constraint document_interpretation_dispatches_pkey do update
      set last_dispatched_at = excluded.last_dispatched_at,
          attempt_count = private.document_interpretation_dispatches.attempt_count + 1;

    job_id := v_candidate.id;
    return next;
  end loop;
end
$$;

revoke all on function private.claim_document_interpretation_jobs(integer, integer)
  from public, anon, authenticated, service_role;

-- 0108's table-wide latch also protects offboarding. Its exception is a transaction-local org
-- marker that only an owner command, a platform-admin command or a service-role export command
-- can make effective. Merely setting the GUC as an ordinary member does not bypass read-only.
create or replace function private.organization_row_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_org uuid;
  v_old_org uuid;
  v_actor uuid := auth.uid();
  v_lifecycle_write boolean := coalesce(
    v_actor is not null
    and public.is_platform_admin()
    and current_setting('app.organization_lifecycle_writer', true) = v_actor::text,
    false
  );
  v_offboarding_org uuid := nullif(
    current_setting('app.organization_offboarding_writer_org', true), ''
  )::uuid;
  v_offboarding_write boolean := coalesce(
    v_offboarding_org is not null
    and (
      auth.role() = 'service_role'
      or (v_actor is not null and (public.auth_role() = 'owner' or public.is_platform_admin()))
    )
    and tg_table_name in ('organization_offboarding_requests', 'audit_logs'),
    false
  );
  v_transient_expired_delete boolean := false;
begin
  if tg_op = 'DELETE' and tg_table_schema = 'public' then
    v_transient_expired_delete := case
      when tg_table_name = 'supplier_price_submission_intakes' then
        (to_jsonb(old) ->> 'expires_at')::timestamptz <= statement_timestamp()
      when tg_table_name = 'supplier_price_document_upload_reservations' then
        to_jsonb(old) ->> 'status' = 'reserved'
        and (to_jsonb(old) ->> 'expires_at')::timestamptz
          <= statement_timestamp() - interval '1 hour'
      else false
    end;
  end if;

  if tg_op <> 'INSERT' then
    v_old_org := nullif(to_jsonb(old) ->> 'org_id', '')::uuid;
    if v_old_org is null then
      raise exception 'organization_write_guard_missing_org: %', tg_table_name;
    end if;
    -- Every tenant write takes a key-share fence. request_organization_offboarding holds the
    -- organization FOR UPDATE, so it first drains writers that already crossed this point;
    -- every later writer waits for the request commit and then observes read-only.
    perform 1 from public.organizations where id = v_old_org for key share;
    if private.organization_access_mode(v_old_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write
       and not (v_offboarding_write and v_offboarding_org = v_old_org)
       and not v_transient_expired_delete then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;
  end if;

  if tg_op <> 'DELETE' then
    v_new_org := nullif(to_jsonb(new) ->> 'org_id', '')::uuid;
    if v_new_org is null then
      raise exception 'organization_write_guard_missing_org: %', tg_table_name;
    end if;
    if v_new_org is distinct from v_old_org then
      perform 1 from public.organizations where id = v_new_org for key share;
    end if;
    if private.organization_access_mode(v_new_org) not in ('active', 'trial', 'grace')
       and not v_lifecycle_write
       and not (v_offboarding_write and v_offboarding_org = v_new_org) then
      raise exception 'organization_read_only' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function private.organization_row_write_guard()
  from public, anon, authenticated;

create trigger zz_organization_write_guard
  before insert or update or delete on public.organization_offboarding_requests
  for each row execute function private.organization_row_write_guard();

create trigger organization_offboarding_touch
  before update on public.organization_offboarding_requests
  for each row execute function public.set_updated_at();

create function public.request_organization_offboarding(p_idempotency_key uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid := public.auth_org();
  v_actor uuid := auth.uid();
  v_org public.organizations;
  v_existing public.organization_offboarding_requests;
  v_request_id uuid;
  v_requested_at timestamptz := statement_timestamp();
begin
  if v_actor is null or v_org_id is null or public.auth_role() <> 'owner' then
    raise exception 'offboarding_owner_required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'offboarding_idempotency_required' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  -- Serialize same-key retries and new requests on the organization before inspecting the
  -- ledger. The table guards take KEY SHARE on this row, so this is also the write drain.
  select * into v_org
  from public.organizations organization
  where organization.id = v_org_id
  for update;
  if not found then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.organization_offboarding_requests request
  where request.org_id = v_org_id
    and request.request_idempotency_key = p_idempotency_key;
  if found then return v_existing.id; end if;

  -- A provider call that already crossed its final authorization check must settle first. The
  -- organization FOR UPDATE lock above serializes with reserve's KEY SHARE lock in both orders.
  if exists (
    select 1 from private.organization_external_egress_leases lease
    where lease.org_id = v_org_id and lease.status = 'active'
      and lease.expires_at >= statement_timestamp()
  ) then
    raise exception 'organization_external_activity_in_progress' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.organization_offboarding_requests request
    where request.org_id = v_org_id
      and request.status in (
        'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
      )
  ) then
    raise exception 'offboarding_already_requested' using errcode = '23505';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_org_id::text, true);
  insert into public.organization_offboarding_requests (
    org_id, request_idempotency_key, requested_by, requested_at,
    previous_org_status, previous_trial_ends_at, cancellation_deadline,
    operational_purge_eligible_at, platform_reactivation_deadline,
    security_logs_retain_until,
    financial_records_retain_until
  ) values (
    v_org_id, p_idempotency_key, v_actor, v_requested_at,
    v_org.status, v_org.trial_ends_at, v_requested_at + interval '30 days',
    v_requested_at + interval '30 days', v_requested_at + interval '120 days',
    v_requested_at + interval '24 months',
    date_trunc('year', v_requested_at) + interval '8 years'
  ) returning id into v_request_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values
  ) values (
    v_org_id, v_actor, 'organization_offboarding_requested',
    'organization_offboarding_requests', v_request_id,
    jsonb_build_object(
      'cancellation_deadline', v_requested_at + interval '30 days',
      'export_formats', jsonb_build_array('csv', 'json', 'original_documents'),
      'signed_link_days', 7,
      'retention_policy_version', 'israel-conservative-v1'
    )
  );
  perform private.record_security_event(
    v_org_id, v_actor, 'organization_offboarding_requested',
    jsonb_build_object('request_id', v_request_id)
  );
  update private.integration_outbox outbox
  set status = 'parked', offboarding_request_id = v_request_id,
      parked_at = v_requested_at, claimed_by = null, claimed_at = null,
      next_attempt_at = 'infinity'::timestamptz, updated_at = statement_timestamp()
  where outbox.org_id = v_org_id and outbox.status = 'pending';
  return v_request_id;
end
$$;

revoke all on function public.request_organization_offboarding(uuid) from public, anon;
grant execute on function public.request_organization_offboarding(uuid) to authenticated;

create function public.approve_organization_offboarding(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.organization_offboarding_requests;
begin
  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found then raise exception 'offboarding_request_unknown' using errcode = 'P0002'; end if;
  if v_request.status in ('approved', 'export_building', 'export_ready') then return; end if;
  if v_request.status <> 'requested' then
    raise exception 'offboarding_request_not_approvable' using errcode = '22023';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set status = 'approved', approved_by = v_actor, approved_at = statement_timestamp()
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values
  ) values (
    v_request.org_id, v_actor, 'organization_offboarding_approved',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('status', v_request.status), jsonb_build_object('status', 'approved')
  );
  perform private.record_security_event(
    v_request.org_id, v_actor, 'organization_offboarding_approved',
    jsonb_build_object('request_id', v_request.id)
  );
end
$$;

revoke all on function public.approve_organization_offboarding(uuid) from public, anon;
grant execute on function public.approve_organization_offboarding(uuid) to authenticated;

create function public.cancel_organization_offboarding(
  p_request_id uuid,
  p_idempotency_key uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org_id uuid := public.auth_org();
  v_request public.organization_offboarding_requests;
begin
  if v_actor is null or v_org_id is null or public.auth_role() <> 'owner' then
    raise exception 'offboarding_owner_required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'offboarding_idempotency_required' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id and request.org_id = v_org_id
  for update;
  if not found then raise exception 'offboarding_request_unknown' using errcode = 'P0002'; end if;
  if v_request.status = 'cancelled' and v_request.cancel_idempotency_key = p_idempotency_key then
    return;
  end if;
  if v_request.status not in (
    'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
  ) then
    raise exception 'offboarding_request_not_cancellable' using errcode = '22023';
  end if;
  if statement_timestamp() > v_request.cancellation_deadline then
    raise exception 'offboarding_cancellation_window_closed' using errcode = '42501';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set status = 'cancelled', cancel_idempotency_key = p_idempotency_key,
      cancelled_by = v_actor, cancelled_at = statement_timestamp(), export_lease_until = null,
      export_worker_token = null,
      download_token_hash = null, download_token_expires_at = null
  where id = v_request.id;
  update private.organization_export_parts part
  set status = 'cancelled', claim_token = null, lease_until = null,
      updated_at = statement_timestamp()
  where part.request_id = v_request.id
    and part.status in ('pending', 'claimed', 'failed');
  update private.integration_outbox outbox
  set status = 'pending', offboarding_request_id = null, parked_at = null,
      claimed_by = null, claimed_at = null, next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where outbox.offboarding_request_id = v_request.id and outbox.status = 'parked'
    and outbox.next_attempt_at = 'infinity'::timestamptz;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values
  ) values (
    v_request.org_id, v_actor, 'organization_offboarding_cancelled',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('status', v_request.status), jsonb_build_object('status', 'cancelled')
  );
  perform private.record_security_event(
    v_request.org_id, v_actor, 'organization_offboarding_cancelled',
    jsonb_build_object('request_id', v_request.id)
  );
end
$$;

revoke all on function public.cancel_organization_offboarding(uuid, uuid) from public, anon;
grant execute on function public.cancel_organization_offboarding(uuid, uuid) to authenticated;

create function public.reactivate_organization_from_offboarding(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.organization_offboarding_requests;
begin
  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found then raise exception 'offboarding_request_unknown' using errcode = 'P0002'; end if;
  if v_request.status = 'reactivated' then return; end if;
  if v_request.status in ('cancelled', 'completed') then
    raise exception 'offboarding_request_not_reactivatable' using errcode = '22023';
  end if;
  if v_request.purge_started_at is not null then
    raise exception 'offboarding_purge_already_started' using errcode = '42501';
  end if;
  if statement_timestamp() > v_request.platform_reactivation_deadline then
    raise exception 'offboarding_reactivation_window_closed' using errcode = '42501';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  perform set_config('app.organization_lifecycle_writer', v_actor::text, true);
  update public.organizations
  set status = 'active', trial_ends_at = null
  where id = v_request.org_id;
  update public.organization_offboarding_requests
  set status = 'reactivated', reactivated_by = v_actor,
      reactivated_at = statement_timestamp(), export_lease_until = null,
      export_worker_token = null,
      download_token_hash = null, download_token_expires_at = null
  where id = v_request.id;
  update private.organization_export_parts part
  set status = 'cancelled', claim_token = null, lease_until = null,
      updated_at = statement_timestamp()
  where part.request_id = v_request.id
    and part.status in ('pending', 'claimed', 'failed');
  update private.integration_outbox outbox
  set status = 'pending', offboarding_request_id = null, parked_at = null,
      claimed_by = null, claimed_at = null, next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where outbox.offboarding_request_id = v_request.id and outbox.status = 'parked'
    and outbox.next_attempt_at = 'infinity'::timestamptz;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values
  ) values (
    v_request.org_id, v_actor, 'organization_offboarding_reactivated',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'reactivated', 'organization_status', 'active')
  );
  perform private.record_security_event(
    v_request.org_id, v_actor, 'organization_offboarding_reactivated',
    jsonb_build_object('request_id', v_request.id)
  );
end
$$;

revoke all on function public.reactivate_organization_from_offboarding(uuid) from public, anon;
grant execute on function public.reactivate_organization_from_offboarding(uuid) to authenticated;

create function public.organization_offboarding_state()
returns table (
  id uuid,
  status text,
  requested_at timestamptz,
  approved_at timestamptz,
  cancellation_deadline timestamptz,
  platform_reactivation_deadline timestamptz,
  operational_purge_eligible_at timestamptz,
  security_logs_retain_until timestamptz,
  financial_records_retain_until timestamptz,
  export_completed_at timestamptz,
  export_size_bytes bigint,
  export_file_count integer,
  export_parts_total bigint,
  export_parts_completed bigint,
  last_export_error text,
  can_owner_cancel boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select request.id, request.status, request.requested_at, request.approved_at,
         request.cancellation_deadline, request.platform_reactivation_deadline,
         request.operational_purge_eligible_at,
         request.security_logs_retain_until, request.financial_records_retain_until,
         request.export_completed_at, request.export_size_bytes, request.export_file_count,
         coalesce(parts.total, 0), coalesce(parts.completed, 0),
         request.last_export_error,
         request.status in (
           'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
         ) and statement_timestamp() <= request.cancellation_deadline
  from public.organization_offboarding_requests request
  left join lateral (
    select count(*)::bigint as total,
           count(*) filter (where part.status = 'completed')::bigint as completed
    from private.organization_export_parts part
    where part.request_id = request.id
      and part.generation = request.export_generation
  ) parts on true
  where request.org_id = public.auth_org()
    and public.auth_role() = 'owner'
  order by request.requested_at desc
  limit 1
$$;

revoke all on function public.organization_offboarding_state() from public, anon;
grant execute on function public.organization_offboarding_state() to authenticated;

create function public.platform_offboarding_requests()
returns table (
  id uuid,
  org_id uuid,
  organization_name text,
  status text,
  requested_at timestamptz,
  cancellation_deadline timestamptz,
  export_completed_at timestamptz,
  export_attempts integer,
  export_parts_total bigint,
  export_parts_completed bigint,
  last_export_error text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select request.id, request.org_id, organization.name, request.status,
         request.requested_at, request.cancellation_deadline,
         request.export_completed_at, request.export_attempts,
         coalesce(parts.total, 0), coalesce(parts.completed, 0), request.last_export_error
  from public.organization_offboarding_requests request
  join public.organizations organization on organization.id = request.org_id
  left join lateral (
    select count(*)::bigint as total,
           count(*) filter (where part.status = 'completed')::bigint as completed
    from private.organization_export_parts part
    where part.request_id = request.id
      and part.generation = request.export_generation
  ) parts on true
  where public.is_platform_admin()
  order by request.requested_at desc
$$;

revoke all on function public.platform_offboarding_requests() from public, anon;
grant execute on function public.platform_offboarding_requests() to authenticated;

-- The Edge Function cannot call assert_recent_password_authentication() directly: that primitive
-- is intentionally private to trusted commands. This narrow browser RPC performs the fresh-auth
-- proof and the exact actor/request authorization without mutating the request. The subsequent
-- service command re-locks and revalidates status, closing the authorize/action race.
create function public.authorize_organization_export_action(
  p_request_id uuid,
  p_action text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text := lower(nullif(trim(p_action), ''));
  v_request public.organization_offboarding_requests;
begin
  if v_actor is null or v_action not in ('build', 'download') then
    raise exception 'offboarding_export_action_invalid' using errcode = '22023';
  end if;
  if v_action = 'build' and not public.is_platform_admin() then
    raise exception 'offboarding_export_build_not_authorized' using errcode = '42501';
  end if;
  if v_action = 'download'
     and (public.auth_org() is null or public.auth_role() <> 'owner') then
    raise exception 'offboarding_export_download_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
    and (v_action = 'build' or request.org_id = public.auth_org());
  if not found then
    raise exception 'offboarding_request_unknown' using errcode = 'P0002';
  end if;

  if v_action = 'build' then
    if v_request.status not in ('approved', 'export_building', 'export_failed') then
      raise exception 'offboarding_export_build_not_authorized' using errcode = '42501';
    end if;
  else
    if v_request.status <> 'export_ready'
       or not exists (
         select 1 from public.profiles profile
         where profile.id = v_actor and profile.org_id = v_request.org_id
           and profile.active and profile.role = 'owner'
       ) then
      raise exception 'offboarding_export_download_not_authorized' using errcode = '42501';
    end if;
  end if;
  return true;
end
$$;
revoke all on function public.authorize_organization_export_action(uuid, text)
  from public, anon;
grant execute on function public.authorize_organization_export_action(uuid, text)
  to authenticated;

-- Service-role-only claim. It returns the exact allow-listed schema and tenant-owned storage
-- objects that the Edge Function must export. No browser role can execute or inspect it.
create function public.service_claim_organization_export(
  p_request_id uuid,
  p_worker_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
  v_tables jsonb;
  v_generation uuid := gen_random_uuid();
  v_registry record;
  v_resume boolean := false;
  v_org_columns text[];
  v_org_schema_hash text;
  v_org_relfilenode oid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_worker_token is null then
    raise exception 'offboarding_export_worker_token_required' using errcode = '22023';
  end if;

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found then raise exception 'offboarding_request_unknown' using errcode = 'P0002'; end if;
  if v_request.status = 'export_ready' then
    return jsonb_build_object('build_required', false, 'request', to_jsonb(v_request));
  end if;
  if v_request.status = 'export_building'
     and v_request.export_lease_until > statement_timestamp() then
    return jsonb_build_object('build_required', false, 'request', to_jsonb(v_request));
  end if;
  if v_request.status not in ('approved', 'export_failed', 'export_building') then
    raise exception 'offboarding_export_not_approved' using errcode = '42501';
  end if;

  v_resume := v_request.status in ('export_failed', 'export_building')
    and v_request.export_generation is not null
    and exists (
      select 1 from private.organization_export_snapshot_table_states state
      where state.request_id = v_request.id
        and state.generation = v_request.export_generation
    );
  if v_resume then
    v_generation := v_request.export_generation;
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set status = 'export_building', export_attempts = export_attempts + 1,
      export_generation = v_generation, export_worker_token = p_worker_token,
      export_started_at = case when v_resume then export_started_at else statement_timestamp() end,
      export_lease_until = statement_timestamp() + interval '5 minutes',
      last_export_error = null
  where id = v_request.id;

  if not v_resume then
    delete from private.organization_export_snapshot_rows where request_id = v_request.id;
    delete from private.organization_export_snapshot_table_states where request_id = v_request.id;
    delete from private.organization_export_snapshot_storage_states where request_id = v_request.id;
    delete from private.organization_export_snapshot_objects where request_id = v_request.id;
    delete from private.organization_export_parts where request_id = v_request.id;

    select array_agg(column_info.column_name order by column_info.ordinal_position),
           md5(string_agg(
             column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
             '|' order by column_info.ordinal_position
           )),
           pg_relation_filenode('public.organizations'::regclass)::oid
      into v_org_columns, v_org_schema_hash, v_org_relfilenode
    from information_schema.columns column_info
    where column_info.table_schema = 'public' and column_info.table_name = 'organizations';
    if v_org_columns is null or v_org_schema_hash is null or v_org_relfilenode is null then
      raise exception 'offboarding_export_source_schema_invalid' using errcode = '55000';
    end if;

    insert into private.organization_export_snapshot_table_states (
      request_id, generation, org_id, table_name, exported_columns,
      schema_hash, source_relfilenode
    ) values (
      v_request.id, v_generation, v_request.org_id, 'organizations', v_org_columns,
      v_org_schema_hash, v_org_relfilenode
    );

    for v_registry in
      select registry.table_name, registry.exported_columns, registry.schema_hash,
             pg_relation_filenode(to_regclass(format('public.%I', registry.table_name)))::oid
               as source_relfilenode
      from private.tenant_export_registry registry
      where registry.disposition = 'include'
      order by registry.table_name
    loop
      if v_registry.exported_columns is null or v_registry.schema_hash is null
         or v_registry.source_relfilenode is null then
        raise exception 'offboarding_export_source_schema_invalid' using errcode = '55000';
      end if;
      insert into private.organization_export_snapshot_table_states (
        request_id, generation, org_id, table_name, exported_columns,
        schema_hash, source_relfilenode
      ) values (
        v_request.id, v_generation, v_request.org_id, v_registry.table_name,
        v_registry.exported_columns, v_registry.schema_hash, v_registry.source_relfilenode
      );
    end loop;
    insert into private.organization_export_snapshot_storage_states (
      request_id, generation, org_id
    ) values (v_request.id, v_generation, v_request.org_id);
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'name', table_info.table_name,
      'columns', to_jsonb(table_info.exported_columns),
      'schema_hash', table_info.schema_hash,
      'row_count', table_info.row_count
    ) order by table_info.table_name
  ), '[]'::jsonb)
  into v_tables
  from (
    select state.table_name, state.exported_columns, state.schema_hash,
           state.next_ordinal as row_count
    from private.organization_export_snapshot_table_states state
    where state.request_id = v_request.id and state.generation = v_generation
  ) table_info;

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id;

  return jsonb_build_object(
    'build_required', true,
    'request', to_jsonb(v_request),
    'tables', v_tables,
    'storage_snapshot_status', (
      select state.status from private.organization_export_snapshot_storage_states state
      where state.request_id = v_request.id and state.generation = v_generation
    ),
    'resumed', v_resume,
    'part_count', (
      select count(*) from private.organization_export_parts part
      where part.request_id = v_request.id and part.generation = v_generation
    )
  );
end
$$;

revoke all on function public.service_claim_organization_export(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_claim_organization_export(uuid, uuid) to service_role;

-- Copy at most 50 rows and roughly one MiB in one durable transaction. A single row may exceed the
-- ordinary byte budget (for example immutable OCR evidence), but can never exceed the canonical
-- 25 MiB document payload ceiling. Snapshot rows, their serialization parts and cursor advancement
-- commit together, so a worker crash can only replay a completed checkpoint or start the next one.
create function public.service_snapshot_organization_export_batch(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid,
  p_max_rows integer default 50,
  p_max_bytes integer default 1048576
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
  v_state private.organization_export_snapshot_table_states;
  v_storage_state private.organization_export_snapshot_storage_states;
  v_current_schema_hash text;
  v_current_relfilenode oid;
  v_batch_row_count integer := 0;
  v_batch_bytes bigint := 0;
  v_last_ctid tid;
  v_after_ordinal bigint;
  v_last_ordinal bigint;
  v_batch_index integer;
  v_has_more boolean := false;
  v_oversized boolean := false;
  v_completed boolean := false;
  v_all_completed boolean := false;
  v_json_part_id uuid;
  v_csv_part_id uuid;
  v_auth_part_id uuid;
  v_source_part_ids jsonb := '[]'::jsonb;
  v_batch_object_count integer := 0;
  v_last_bucket_id text;
  v_last_object_name text;
  v_payload jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_max_rows not between 1 and 50 or p_max_bytes not between 1 and 1048576 then
    raise exception 'offboarding_export_snapshot_budget_invalid' using errcode = '22023';
  end if;

  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
    and request.status = 'export_building'
    and request.export_generation = p_generation
    and request.export_worker_token = p_worker_token
    and request.export_lease_until >= statement_timestamp()
  for update;
  if not found then
    raise exception 'offboarding_export_lease_lost' using errcode = '40001';
  end if;

  select * into v_state
  from private.organization_export_snapshot_table_states state
  where state.request_id = p_request_id and state.generation = p_generation
    and state.status <> 'completed'
  order by case state.status when 'copying' then 0 else 1 end, state.table_name
  for update
  limit 1;

  if not found then
    if not exists (
      select 1 from private.organization_export_snapshot_table_states state
      where state.request_id = p_request_id and state.generation = p_generation
    ) then
      raise exception 'offboarding_export_snapshot_state_missing' using errcode = '55000';
    end if;
    select * into v_storage_state
    from private.organization_export_snapshot_storage_states state
    where state.request_id = p_request_id and state.generation = p_generation
      and state.status <> 'completed'
    for update;
    if not found then
      if not exists (
        select 1 from private.organization_export_snapshot_storage_states state
        where state.request_id = p_request_id and state.generation = p_generation
      ) then
        raise exception 'offboarding_export_storage_snapshot_state_missing' using errcode = '55000';
      end if;
      return jsonb_build_object(
        'state_kind', 'completed', 'table_name', null, 'status', 'completed',
        'batch_index', null, 'batch_row_count', 0, 'batch_object_count', 0,
        'batch_bytes', 0, 'after_ordinal', null, 'last_ordinal', null,
        'json_part_id', null, 'csv_part_id', null, 'auth_part_id', null,
        'source_part_ids', '[]'::jsonb, 'oversized_single_record', false,
        'all_snapshots_completed', true, 'idempotent', true
      );
    end if;

    v_after_ordinal := v_storage_state.next_ordinal;
    v_batch_index := v_storage_state.batch_count;
    with raw as (
      select object.bucket_id, object.name as object_name,
             coalesce((object.metadata ->> 'size')::bigint, 0) as size_bytes,
             object.metadata ->> 'mimetype' as mime_type, object.updated_at,
             jsonb_build_object(
               'bucket_id', object.bucket_id, 'object_name', object.name,
               'size_bytes', coalesce((object.metadata ->> 'size')::bigint, 0),
               'mime_type', object.metadata ->> 'mimetype', 'updated_at', object.updated_at
             ) as row_data
      from storage.objects object
      where object.bucket_id in ('documents', 'price-submissions', 'organization-branding')
        and object.name like v_request.org_id::text || '/%'
        and (
          v_storage_state.cursor_bucket_id is null
          or (object.bucket_id, object.name) >
             (v_storage_state.cursor_bucket_id, v_storage_state.cursor_object_name)
        )
      order by object.bucket_id, object.name
      limit p_max_rows
    ), measured as (
      select raw.*, octet_length(raw.row_data::text)::bigint as row_bytes,
             row_number() over (order by raw.bucket_id, raw.object_name) as batch_ordinal,
             sum(octet_length(raw.row_data::text)::bigint)
               over (order by raw.bucket_id, raw.object_name) as cumulative_bytes
      from raw
    ), chosen as (
      select * from measured where cumulative_bytes <= p_max_bytes or batch_ordinal = 1
    ), inserted_objects as (
      insert into private.organization_export_snapshot_objects (
        request_id, generation, org_id, bucket_id, object_name,
        size_bytes, mime_type, updated_at
      )
      select p_request_id, p_generation, v_request.org_id, chosen.bucket_id,
             chosen.object_name, chosen.size_bytes, chosen.mime_type, chosen.updated_at
      from chosen order by chosen.bucket_id, chosen.object_name
      returning bucket_id, object_name, size_bytes, mime_type, updated_at
    ), inserted_parts as (
      insert into private.organization_export_parts (
        request_id, generation, part_id, org_id, kind, payload, mime_type
      )
      select p_request_id, p_generation, gen_random_uuid(), v_request.org_id, 'source_object',
             jsonb_build_object(
               'bucket_id', object.bucket_id, 'object_name', object.object_name,
               'size_bytes', object.size_bytes, 'mime_type', object.mime_type,
               'updated_at', object.updated_at, 'batch_index', v_batch_index
             ), 'application/octet-stream'
      from inserted_objects object
      returning part_id
    )
    select (select count(*)::integer from chosen),
           (select coalesce(sum(chosen.row_bytes), 0)::bigint from chosen),
           (select chosen.bucket_id from chosen order by chosen.bucket_id desc,
             chosen.object_name desc limit 1),
           (select chosen.object_name from chosen order by chosen.bucket_id desc,
             chosen.object_name desc limit 1),
           (select coalesce(jsonb_agg(inserted_parts.part_id order by inserted_parts.part_id),
             '[]'::jsonb) from inserted_parts)
      into v_batch_object_count, v_batch_bytes, v_last_bucket_id,
           v_last_object_name, v_source_part_ids;

    if v_batch_object_count = 1 and v_batch_bytes > p_max_bytes then
      if v_batch_bytes > 27262976 then
        raise exception 'offboarding_export_row_too_large' using errcode = '54000';
      end if;
      v_oversized := true;
    end if;
    if v_batch_object_count > 0 then
      select exists (
        select 1 from storage.objects object
        where object.bucket_id in ('documents', 'price-submissions', 'organization-branding')
          and object.name like v_request.org_id::text || '/%'
          and (object.bucket_id, object.name) > (v_last_bucket_id, v_last_object_name)
      ) into v_has_more;
      v_last_ordinal := v_after_ordinal + v_batch_object_count;
    else
      v_has_more := false;
      v_last_ordinal := v_after_ordinal;
    end if;
    v_completed := not v_has_more;
    update private.organization_export_snapshot_storage_states state
    set cursor_bucket_id = coalesce(v_last_bucket_id, state.cursor_bucket_id),
        cursor_object_name = coalesce(v_last_object_name, state.cursor_object_name),
        next_ordinal = v_last_ordinal, batch_count = state.batch_count + 1,
        status = case when v_completed then 'completed' else 'copying' end,
        completed_at = case when v_completed then statement_timestamp() else null end,
        updated_at = statement_timestamp()
    where state.request_id = p_request_id and state.generation = p_generation;

    if v_completed and (
      exists (
        select 1 from public.documents document
        where document.org_id = v_request.org_id and document.storage_path is not null
          and not exists (
            select 1 from private.organization_export_snapshot_objects object
            where object.request_id = p_request_id and object.generation = p_generation
              and object.bucket_id = 'documents' and object.object_name = document.storage_path
          )
      ) or exists (
        select 1 from public.supplier_price_submissions submission
        where submission.org_id = v_request.org_id and submission.storage_path is not null
          and not exists (
            select 1 from private.organization_export_snapshot_objects object
            where object.request_id = p_request_id and object.generation = p_generation
              and object.bucket_id = 'price-submissions'
              and object.object_name = submission.storage_path
          )
      ) or exists (
        select 1 from public.organizations organization
        where organization.id = v_request.org_id and organization.logo_path is not null
          and not exists (
            select 1 from private.organization_export_snapshot_objects object
            where object.request_id = p_request_id and object.generation = p_generation
              and object.bucket_id = 'organization-branding'
              and object.object_name = organization.logo_path
          )
      )
    ) then
      raise exception 'offboarding_export_source_file_missing' using errcode = '55000';
    end if;

    return jsonb_build_object(
      'state_kind', 'storage', 'table_name', null,
      'status', case when v_completed then 'completed' else 'copying' end,
      'batch_index', v_batch_index, 'batch_row_count', 0,
      'batch_object_count', v_batch_object_count, 'batch_bytes', v_batch_bytes,
      'after_ordinal', v_after_ordinal, 'last_ordinal', v_last_ordinal,
      'json_part_id', null, 'csv_part_id', null, 'auth_part_id', null,
      'source_part_ids', v_source_part_ids, 'oversized_single_record', v_oversized,
      'all_snapshots_completed', v_completed, 'idempotent', false
    );
  end if;

  select md5(string_agg(
           column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
           '|' order by column_info.ordinal_position
         )),
         pg_relation_filenode(to_regclass(format('public.%I', v_state.table_name)))::oid
    into v_current_schema_hash, v_current_relfilenode
  from information_schema.columns column_info
  where column_info.table_schema = 'public' and column_info.table_name = v_state.table_name;
  if v_current_schema_hash is distinct from v_state.schema_hash
     or v_current_relfilenode is distinct from v_state.source_relfilenode then
    raise exception 'offboarding_export_source_changed' using errcode = '40001';
  end if;

  if v_state.table_name <> 'organizations' and not exists (
    select 1 from private.tenant_export_registry registry
    where registry.table_name = v_state.table_name and registry.disposition = 'include'
      and registry.schema_hash = v_state.schema_hash
      and registry.exported_columns = v_state.exported_columns
  ) then
    raise exception 'offboarding_export_source_schema_invalid' using errcode = '55000';
  end if;

  v_after_ordinal := v_state.next_ordinal;
  v_batch_index := v_state.batch_count;
  execute format($snapshot$
    with raw as (
      select source.ctid as source_ctid, projected.row_data,
             octet_length(projected.row_data::text)::bigint as row_bytes
      from public.%I source
      cross join lateral (
        select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb) as row_data
        from jsonb_each(to_jsonb(source)) entry
        where entry.key = any($4)
      ) projected
      where source.%I = $3 and ($5::tid is null or source.ctid > $5::tid)
        %s
      order by source.ctid
      limit $6
    ), measured as (
      select raw.*,
             row_number() over (order by raw.source_ctid) as batch_ordinal,
             sum(raw.row_bytes) over (order by raw.source_ctid) as cumulative_bytes
      from raw
    ), chosen as (
      select * from measured
      where cumulative_bytes <= $7 or batch_ordinal = 1
    ), inserted as (
      insert into private.organization_export_snapshot_rows (
        request_id, generation, org_id, table_name, row_ordinal, row_data
      )
      select $1, $2, $3, %L, $8 + chosen.batch_ordinal, chosen.row_data
      from chosen order by chosen.source_ctid
      returning row_ordinal
    )
    select (select count(*)::integer from chosen),
           (select coalesce(sum(chosen.row_bytes), 0)::bigint from chosen),
           (select (array_agg(chosen.source_ctid order by chosen.source_ctid desc))[1]
              from chosen),
           (select coalesce(max(inserted.row_ordinal), $8) from inserted)
  $snapshot$,
    v_state.table_name,
    case when v_state.table_name = 'organizations' then 'id' else 'org_id' end,
    case when v_state.table_name = 'organization_offboarding_requests' then
      'and not exists (select 1 from private.organization_export_snapshot_rows prior '
        || 'where prior.request_id = $1 and prior.generation = $2 '
        || 'and prior.table_name = ''organization_offboarding_requests'' '
        || 'and prior.row_data ->> ''id'' = source.id::text)'
    else '' end,
    v_state.table_name
  )
  using p_request_id, p_generation, v_request.org_id, v_state.exported_columns,
        v_state.cursor_ctid, p_max_rows, p_max_bytes, v_after_ordinal
  into v_batch_row_count, v_batch_bytes, v_last_ctid, v_last_ordinal;

  if v_batch_row_count = 1 and v_batch_bytes > p_max_bytes then
    if v_batch_bytes > 27262976 then
      raise exception 'offboarding_export_row_too_large' using errcode = '54000';
    end if;
    v_oversized := true;
  end if;

  if v_batch_row_count > 0 then
    execute format(
      'select exists (select 1 from public.%I source where source.%I = $1 '
        || 'and source.ctid > $2::tid %s)',
      v_state.table_name,
      case when v_state.table_name = 'organizations' then 'id' else 'org_id' end,
      case when v_state.table_name = 'organization_offboarding_requests' then
        'and not exists (select 1 from private.organization_export_snapshot_rows prior '
          || 'where prior.request_id = $3 and prior.generation = $4 '
          || 'and prior.table_name = ''organization_offboarding_requests'' '
          || 'and prior.row_data ->> ''id'' = source.id::text)'
      else '' end
    ) using v_request.org_id, v_last_ctid, p_request_id, p_generation into v_has_more;
  else
    v_last_ordinal := v_after_ordinal;
    v_has_more := false;
  end if;
  v_completed := not v_has_more;

  update private.organization_export_snapshot_table_states state
  set cursor_ctid = coalesce(v_last_ctid, state.cursor_ctid),
      next_ordinal = v_last_ordinal,
      batch_count = state.batch_count + 1,
      status = case when v_completed then 'completed' else 'copying' end,
      completed_at = case when v_completed then statement_timestamp() else null end,
      updated_at = statement_timestamp()
  where state.request_id = v_state.request_id and state.generation = v_state.generation
    and state.table_name = v_state.table_name;

  v_payload := jsonb_build_object(
    'table_name', v_state.table_name,
    'batch_index', v_batch_index,
    'after_ordinal', v_after_ordinal,
    'limit', v_batch_row_count,
    'first_ordinal', case when v_batch_row_count = 0 then null else v_after_ordinal + 1 end,
    'last_ordinal', v_last_ordinal,
    'row_count', v_last_ordinal,
    'batch_row_count', v_batch_row_count,
    'batch_bytes', v_batch_bytes,
    'columns', to_jsonb(v_state.exported_columns),
    'empty', v_batch_row_count = 0,
    'oversized_single_row', v_oversized
  );
  insert into private.organization_export_parts (
    request_id, generation, part_id, org_id, kind, payload, mime_type
  ) values (
    p_request_id, p_generation, gen_random_uuid(), v_request.org_id, 'table_json',
    v_payload || jsonb_build_object('format', 'json'), 'application/json'
  ) returning part_id into v_json_part_id;
  insert into private.organization_export_parts (
    request_id, generation, part_id, org_id, kind, payload, mime_type
  ) values (
    p_request_id, p_generation, gen_random_uuid(), v_request.org_id, 'table_csv',
    v_payload || jsonb_build_object('format', 'csv'), 'text/csv'
  ) returning part_id into v_csv_part_id;

  if v_state.table_name = 'profiles' and v_batch_row_count > 0 then
    insert into private.organization_export_parts (
      request_id, generation, part_id, org_id, kind, payload, mime_type
    )
    select p_request_id, p_generation, gen_random_uuid(), v_request.org_id, 'auth_accounts',
           jsonb_build_object(
             'batch_index', v_batch_index,
             'after_ordinal', v_after_ordinal,
             'limit', v_batch_row_count,
             'user_ids', coalesce(jsonb_agg(snapshot.row_data ->> 'id'
               order by snapshot.row_ordinal), '[]'::jsonb)
           ), 'application/json'
    from private.organization_export_snapshot_rows snapshot
    where snapshot.request_id = p_request_id and snapshot.generation = p_generation
      and snapshot.table_name = 'profiles'
      and snapshot.row_ordinal > v_after_ordinal
      and snapshot.row_ordinal <= v_last_ordinal
    returning part_id into v_auth_part_id;
  end if;

  select not exists (
    select 1 from private.organization_export_snapshot_table_states state
    where state.request_id = p_request_id and state.generation = p_generation
      and state.status <> 'completed'
  ) and exists (
    select 1 from private.organization_export_snapshot_storage_states state
    where state.request_id = p_request_id and state.generation = p_generation
      and state.status = 'completed'
  ) into v_all_completed;

  return jsonb_build_object(
    'state_kind', 'table', 'table_name', v_state.table_name,
    'status', case when v_completed then 'completed' else 'copying' end,
    'batch_index', v_batch_index,
    'batch_row_count', v_batch_row_count,
    'batch_object_count', 0,
    'batch_bytes', v_batch_bytes,
    'after_ordinal', v_after_ordinal,
    'last_ordinal', v_last_ordinal,
    'json_part_id', v_json_part_id,
    'csv_part_id', v_csv_part_id,
    'auth_part_id', v_auth_part_id,
    'source_part_ids', '[]'::jsonb,
    'oversized_single_record', v_oversized,
    'all_snapshots_completed', v_all_completed,
    'idempotent', false
  );
end
$$;
revoke all on function public.service_snapshot_organization_export_batch(
  uuid, uuid, uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.service_snapshot_organization_export_batch(
  uuid, uuid, uuid, integer, integer
) to service_role;

create function public.service_get_organization_export_snapshot_page(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid,
  p_table_name text,
  p_after_ordinal bigint default 0,
  p_limit integer default 50
) returns table (row_ordinal bigint, row_data jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_limit not between 0 and 50 then
    raise exception 'offboarding_export_page_limit_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_offboarding_requests request
    where request.id = p_request_id and request.status = 'export_building'
      and request.export_generation = p_generation
      and request.export_worker_token = p_worker_token
      and request.export_lease_until >= statement_timestamp()
  ) then
    raise exception 'offboarding_export_lease_lost' using errcode = '40001';
  end if;
  if not exists (
    select 1 from private.organization_export_parts part
    where part.request_id = p_request_id and part.generation = p_generation
      and part.kind in ('table_json', 'table_csv')
      and part.payload ->> 'table_name' = p_table_name
      and (part.payload ->> 'after_ordinal')::bigint = p_after_ordinal
      and (part.payload ->> 'limit')::integer = p_limit
  ) then
    raise exception 'offboarding_export_snapshot_page_unplanned' using errcode = '42501';
  end if;
  return query
  select snapshot.row_ordinal, snapshot.row_data
  from private.organization_export_snapshot_rows snapshot
  where snapshot.request_id = p_request_id and snapshot.generation = p_generation
    and snapshot.table_name = p_table_name and snapshot.row_ordinal > p_after_ordinal
  order by snapshot.row_ordinal
  limit p_limit;
end
$$;

revoke all on function public.service_get_organization_export_snapshot_page(
  uuid, uuid, uuid, text, bigint, integer
) from public, anon, authenticated;
grant execute on function public.service_get_organization_export_snapshot_page(
  uuid, uuid, uuid, text, bigint, integer
) to service_role;

create function public.service_claim_organization_export_part(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_part private.organization_export_parts;
  v_manifest_state private.organization_export_manifest_states;
  v_claim_token uuid := gen_random_uuid();
  v_page_artifacts jsonb;
  v_page_artifact_count integer;
  v_page_last_part_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_offboarding_requests request
    where request.id = p_request_id and request.status = 'export_building'
      and request.export_generation = p_generation
      and request.export_worker_token = p_worker_token
      and request.export_lease_until >= statement_timestamp()
  ) then
    raise exception 'offboarding_export_lease_lost' using errcode = '40001';
  end if;
  if exists (
    select 1 from private.organization_export_snapshot_table_states state
    where state.request_id = p_request_id and state.generation = p_generation
      and state.status <> 'completed'
  ) then
    return null;
  end if;
  if exists (
    select 1 from private.organization_export_snapshot_storage_states state
    where state.request_id = p_request_id and state.generation = p_generation
      and state.status <> 'completed'
  ) then
    return null;
  end if;

  select * into v_part
  from private.organization_export_parts part
  where part.request_id = p_request_id and part.generation = p_generation
    and (
      part.status in ('pending', 'failed')
      or (part.status = 'claimed' and part.lease_until < statement_timestamp())
    )
    and (
      part.kind <> 'manifest'
      or not exists (
        select 1 from private.organization_export_parts prerequisite
        where prerequisite.request_id = part.request_id
          and prerequisite.generation = part.generation
          and prerequisite.kind <> 'manifest'
          and prerequisite.status <> 'completed'
      )
    )
  order by case part.kind
             when 'table_json' then 1 when 'table_csv' then 2
             when 'auth_accounts' then 3 when 'source_object' then 4
             when 'manifest_page' then 5 else 6
           end,
           part.created_at, part.part_id
  for update skip locked
  limit 1;
  if not found then
    -- Active claims are allowed to finish; a parallel caller may not create manifest pages while
    -- any original data artifact remains incomplete.
    if exists (
      select 1 from private.organization_export_parts part
      where part.request_id = p_request_id and part.generation = p_generation
        and part.kind not in ('manifest_page', 'manifest') and part.status <> 'completed'
    ) then
      return null;
    end if;

    insert into private.organization_export_manifest_states (
      request_id, generation, org_id
    )
    select p_request_id, p_generation, request.org_id
    from public.organization_offboarding_requests request
    where request.id = p_request_id
    on conflict do nothing;
    select * into v_manifest_state
    from private.organization_export_manifest_states state
    where state.request_id = p_request_id and state.generation = p_generation
    for update;

    if v_manifest_state.status <> 'completed' then
      if exists (
        select 1 from private.organization_export_parts page
        where page.request_id = p_request_id and page.generation = p_generation
          and page.kind = 'manifest_page' and page.status <> 'completed'
      ) then
        return null;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object(
               'name', private.tenant_export_part_logical_name(source.kind, source.payload),
               'path', source.object_path, 'sha256', source.sha256,
               'size_bytes', source.size_bytes, 'mime_type', source.mime_type
             ) order by source.part_id), '[]'::jsonb),
             count(*)::integer,
             (array_agg(source.part_id order by source.part_id desc))[1]
        into v_page_artifacts, v_page_artifact_count, v_page_last_part_id
      from (
        select artifact.*
        from private.organization_export_parts artifact
        where artifact.request_id = p_request_id and artifact.generation = p_generation
          and artifact.kind not in ('manifest_page', 'manifest')
          and artifact.status = 'completed'
          and (v_manifest_state.cursor_part_id is null
            or artifact.part_id > v_manifest_state.cursor_part_id)
        order by artifact.part_id
        limit 100
      ) source;

      if v_page_artifact_count > 0 then
        if v_manifest_state.page_count >= 1000 then
          raise exception 'offboarding_export_manifest_capacity_exceeded' using errcode = '54000';
        end if;
        insert into private.organization_export_parts (
          request_id, generation, part_id, org_id, kind, payload, mime_type
        ) values (
          p_request_id, p_generation, gen_random_uuid(), v_manifest_state.org_id,
          'manifest_page', jsonb_build_object(
            'schema_version', 1, 'contract', 'artifact_index_page_v1',
            'page_index', v_manifest_state.page_count,
            'artifact_count', v_page_artifact_count,
            'artifacts', v_page_artifacts
          ), 'application/json'
        ) returning * into v_part;
        update private.organization_export_manifest_states state
        set cursor_part_id = v_page_last_part_id,
            page_count = state.page_count + 1,
            artifact_count = state.artifact_count + v_page_artifact_count,
            status = 'building', updated_at = statement_timestamp()
        where state.request_id = p_request_id and state.generation = p_generation;
      else
        update private.organization_export_manifest_states state
        set status = 'completed', completed_at = statement_timestamp(),
            updated_at = statement_timestamp()
        where state.request_id = p_request_id and state.generation = p_generation
        returning * into v_manifest_state;
      end if;
    end if;

    if v_part.part_id is null then
      insert into private.organization_export_parts (
        request_id, generation, part_id, org_id, kind, payload, mime_type
      )
      select p_request_id, p_generation, gen_random_uuid(), v_manifest_state.org_id, 'manifest',
             jsonb_build_object(
               'schema_version', 1, 'contract', 'paged_artifact_index_v1',
               'request_id', p_request_id, 'generation', p_generation,
               'created_at', statement_timestamp(),
               'artifact_count', v_manifest_state.artifact_count,
               'page_count', v_manifest_state.page_count,
               'indexed_file_count', (
                 select count(*)::bigint
                 from private.organization_export_parts indexed
                 where indexed.request_id = p_request_id
                   and indexed.generation = p_generation
                   and indexed.kind <> 'manifest' and indexed.status = 'completed'
               ),
               'indexed_size_bytes', (
                 select coalesce(sum(indexed.size_bytes), 0)::bigint
                 from private.organization_export_parts indexed
                 where indexed.request_id = p_request_id
                   and indexed.generation = p_generation
                   and indexed.kind <> 'manifest' and indexed.status = 'completed'
               ),
               'artifact_fields', jsonb_build_array(
                 'name', 'path', 'sha256', 'size_bytes', 'mime_type'
               ),
               'pages', coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'page_index', (page.payload ->> 'page_index')::integer,
                   'name', private.tenant_export_part_logical_name(page.kind, page.payload),
                   'path', page.object_path, 'sha256', page.sha256,
                   'size_bytes', page.size_bytes, 'mime_type', page.mime_type,
                   'artifact_count', (page.payload ->> 'artifact_count')::integer
                 ) order by (page.payload ->> 'page_index')::integer)
                 from private.organization_export_parts page
                 where page.request_id = p_request_id and page.generation = p_generation
                   and page.kind = 'manifest_page' and page.status = 'completed'
               ), '[]'::jsonb)
             ), 'application/json'
      on conflict do nothing
      returning * into v_part;
      if v_part.part_id is null then
        select * into v_part
        from private.organization_export_parts part
        where part.request_id = p_request_id and part.generation = p_generation
          and part.kind = 'manifest'
          and (
            part.status in ('pending', 'failed')
            or (part.status = 'claimed' and part.lease_until < statement_timestamp())
          )
        for update;
        if not found then return null; end if;
      end if;
    end if;
  end if;

  update private.organization_export_parts part
  set status = 'claimed', claim_token = v_claim_token,
      lease_until = statement_timestamp() + interval '5 minutes',
      attempts = part.attempts + 1, last_error_code = null,
      updated_at = statement_timestamp()
  where part.request_id = v_part.request_id and part.generation = v_part.generation
    and part.part_id = v_part.part_id
  returning * into v_part;
  return to_jsonb(v_part);
end
$$;
revoke all on function public.service_claim_organization_export_part(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_claim_organization_export_part(uuid, uuid, uuid)
  to service_role;

create function public.service_heartbeat_organization_export_part(
  p_request_id uuid,
  p_generation uuid,
  p_part_id uuid,
  p_claim_token uuid
) returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease_until timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update private.organization_export_parts part
  set lease_until = v_lease_until, updated_at = statement_timestamp()
  where part.request_id = p_request_id and part.generation = p_generation
    and part.part_id = p_part_id and part.status = 'claimed'
    and part.claim_token = p_claim_token
    and part.lease_until >= statement_timestamp();
  if not found then
    raise exception 'offboarding_export_part_lease_lost' using errcode = '40001';
  end if;
  return v_lease_until;
end
$$;
revoke all on function public.service_heartbeat_organization_export_part(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_heartbeat_organization_export_part(uuid, uuid, uuid, uuid)
  to service_role;

create function public.service_complete_organization_export_part(
  p_request_id uuid,
  p_generation uuid,
  p_part_id uuid,
  p_claim_token uuid,
  p_object_path text,
  p_sha256 text,
  p_size_bytes bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_part private.organization_export_parts;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_part
  from private.organization_export_parts part
  where part.request_id = p_request_id and part.generation = p_generation
    and part.part_id = p_part_id
  for update;
  if not found then
    raise exception 'offboarding_export_part_unknown' using errcode = 'P0002';
  end if;
  if v_part.status = 'completed'
     and v_part.object_path = p_object_path and v_part.sha256 = lower(p_sha256)
     and v_part.size_bytes = p_size_bytes then
    return;
  end if;
  if v_part.status <> 'claimed' or v_part.claim_token is distinct from p_claim_token
     or v_part.lease_until < statement_timestamp() then
    raise exception 'offboarding_export_part_lease_lost' using errcode = '40001';
  end if;
  if p_object_path <> (case when v_part.kind = 'manifest'
       then v_part.org_id::text || '/offboarding/' || v_part.request_id::text
         || '/' || v_part.generation::text || '/manifest.json'
       else v_part.org_id::text || '/offboarding/' || v_part.request_id::text
         || '/' || v_part.generation::text || '/parts/' || v_part.part_id::text || '.part'
     end)
     or lower(coalesce(p_sha256, '')) !~ '^[0-9a-f]{64}$'
     or p_size_bytes < 0 then
    raise exception 'offboarding_export_part_evidence_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'tenant-exports' and object.name = p_object_path
      and coalesce((object.metadata ->> 'size')::bigint, -1) = p_size_bytes
      and lower(coalesce(object.metadata ->> 'mimetype', '')) = v_part.mime_type
  ) then
    raise exception 'offboarding_export_part_object_unverified' using errcode = '55000';
  end if;

  update private.organization_export_parts part
  set status = 'completed', object_path = p_object_path, sha256 = lower(p_sha256),
      size_bytes = p_size_bytes, claim_token = null, lease_until = null,
      last_error_code = null, updated_at = statement_timestamp()
  where part.request_id = v_part.request_id and part.generation = v_part.generation
    and part.part_id = v_part.part_id;
end
$$;
revoke all on function public.service_complete_organization_export_part(
  uuid, uuid, uuid, uuid, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.service_complete_organization_export_part(
  uuid, uuid, uuid, uuid, text, text, bigint
) to service_role;

create function public.service_fail_organization_export_part(
  p_request_id uuid,
  p_generation uuid,
  p_part_id uuid,
  p_claim_token uuid,
  p_error_code text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_error text := lower(coalesce(nullif(trim(p_error_code), ''), 'unknown_part_error'));
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_error !~ '^[a-z0-9_:-]{1,100}$' then v_error := 'unknown_part_error'; end if;
  update private.organization_export_parts part
  set status = 'failed', claim_token = null, lease_until = null,
      last_error_code = v_error, updated_at = statement_timestamp()
  where part.request_id = p_request_id and part.generation = p_generation
    and part.part_id = p_part_id and part.status = 'claimed'
    and part.claim_token = p_claim_token;
end
$$;
revoke all on function public.service_fail_organization_export_part(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.service_fail_organization_export_part(
  uuid, uuid, uuid, uuid, text
) to service_role;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values
  (
    'public.service_claim_organization_export(uuid,uuid)'::regprocedure::text,
    'actor: service_role-only tenant-export worker; tenant: org_id is derived from the locked '
      || 'offboarding request and never accepted from the caller; scope: the export registry '
      || 'contains reviewed org-global projections and the worker has no user auth_scopes; '
      || 'tables: reads export registry and tenant Storage metadata, writes only the locked '
      || 'offboarding ledger; audit: completion/failure/link commands record immutable evidence; '
      || 'proof: browser roles have no EXECUTE and A6 pins every exported table schema.',
    'tenant offboarding export'
  ),
  (
    'public.service_snapshot_organization_export_batch(uuid,uuid,uuid,integer,integer)'
      ::regprocedure::text,
    'actor: service_role-only tenant-export worker; tenant: the locked request and generation '
      || 'derive the only org; scope: this worker has no user scopes and the A6-pinned registry '
      || 'provides the exact column projection; tables: reads one bounded tenant source page or '
      || 'Storage metadata page and writes private snapshot checkpoints plus part tasks; reason: '
      || 'the export must cross RLS without exposing private snapshots to browser roles; audit: '
      || 'final completion records manifest checksum, aggregate size and artifact count; proof: '
      || 'browser execute is revoked, worker fencing, schema/relfilenode checks, byte/row caps and '
      || 'durable cursors fail closed.',
    'tenant offboarding export'
  );

create function public.service_heartbeat_organization_export(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid
) returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_lease_until timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select request.org_id into v_org_id
  from public.organization_offboarding_requests request
  where request.id = p_request_id
    and request.status = 'export_building'
    and request.export_generation = p_generation
    and request.export_worker_token = p_worker_token
    and request.export_lease_until >= statement_timestamp()
  for update;
  if not found then
    raise exception 'offboarding_export_lease_lost' using errcode = '40001';
  end if;
  perform set_config('app.organization_offboarding_writer_org', v_org_id::text, true);
  update public.organization_offboarding_requests
  set export_lease_until = v_lease_until
  where id = p_request_id;
  return v_lease_until;
end
$$;

revoke all on function public.service_heartbeat_organization_export(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_heartbeat_organization_export(uuid, uuid, uuid)
  to service_role;

create function public.service_complete_organization_export(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid,
  p_object_path text,
  p_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
  v_manifest private.organization_export_parts;
  v_artifact_count integer;
  v_aggregate_size bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found then raise exception 'offboarding_request_unknown' using errcode = 'P0002'; end if;
  if v_request.status = 'export_ready'
     and v_request.export_generation = p_generation
     and v_request.export_object_path = p_object_path
     and v_request.export_sha256 = lower(p_sha256) then
    return jsonb_build_object(
      'request_id', v_request.id, 'generation', p_generation,
      'status', 'export_ready', 'artifact_count', v_request.export_file_count,
      'aggregate_size_bytes', v_request.export_size_bytes, 'idempotent', true
    );
  end if;
  if v_request.status <> 'export_building'
     or v_request.export_generation is distinct from p_generation
     or v_request.export_worker_token is distinct from p_worker_token
     or v_request.export_lease_until < statement_timestamp() then
    raise exception 'offboarding_export_not_building' using errcode = '22023';
  end if;
  if p_object_path <> v_request.org_id::text || '/offboarding/' || v_request.id::text
     || '/' || v_request.export_generation::text || '/manifest.json'
     or lower(coalesce(p_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'offboarding_export_evidence_invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.organization_export_snapshot_table_states state
    where state.request_id = v_request.id and state.generation = p_generation
      and state.status <> 'completed'
  ) or not exists (
    select 1 from private.organization_export_snapshot_storage_states state
    where state.request_id = v_request.id and state.generation = p_generation
      and state.status = 'completed'
  ) or not exists (
    select 1 from private.organization_export_manifest_states state
    where state.request_id = v_request.id and state.generation = p_generation
      and state.status = 'completed'
  ) then
    raise exception 'offboarding_export_snapshot_incomplete' using errcode = '55000';
  end if;
  if not exists (
    select 1 from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = p_generation
  ) or exists (
    select 1 from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = p_generation
      and part.status <> 'completed'
  ) then
    raise exception 'offboarding_export_parts_incomplete' using errcode = '55000';
  end if;
  select * into v_manifest
  from private.organization_export_parts part
  where part.request_id = v_request.id and part.generation = p_generation
    and part.kind = 'manifest' and part.status = 'completed';
  if not found or v_manifest.object_path is distinct from p_object_path
     or v_manifest.sha256 is distinct from lower(p_sha256) then
    raise exception 'offboarding_export_manifest_unverified' using errcode = '55000';
  end if;
  if exists (
    select 1
    from private.organization_export_parts part
    left join storage.objects object
      on object.bucket_id = 'tenant-exports' and object.name = part.object_path
    where part.request_id = v_request.id and part.generation = p_generation
      and part.status = 'completed'
      and (
        object.id is null
        or coalesce((object.metadata ->> 'size')::bigint, -1) <> part.size_bytes
        or lower(coalesce(object.metadata ->> 'mimetype', '')) <> part.mime_type
      )
  ) then
    raise exception 'offboarding_export_part_object_unverified' using errcode = '55000';
  end if;
  select count(*)::integer, coalesce(sum(part.size_bytes), 0)::bigint
    into v_artifact_count, v_aggregate_size
  from private.organization_export_parts part
  where part.request_id = v_request.id and part.generation = p_generation
    and part.status = 'completed';
  if exists (
    select 1
    from private.organization_export_snapshot_objects snapshot
    left join storage.objects live
      on live.bucket_id = snapshot.bucket_id and live.name = snapshot.object_name
    where snapshot.request_id = v_request.id and snapshot.generation = p_generation
      and (
        live.id is null
        or coalesce((live.metadata ->> 'size')::bigint, -1) <> snapshot.size_bytes
        or live.updated_at is distinct from snapshot.updated_at
      )
  ) or exists (
    select 1 from storage.objects live
    where live.bucket_id in ('documents', 'price-submissions', 'organization-branding')
      and live.name like v_request.org_id::text || '/%'
      and not exists (
        select 1 from private.organization_export_snapshot_objects snapshot
        where snapshot.request_id = v_request.id and snapshot.generation = p_generation
          and snapshot.bucket_id = live.bucket_id and snapshot.object_name = live.name
      )
  ) then
    raise exception 'offboarding_export_source_changed' using errcode = '40001';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set status = 'export_ready', export_completed_at = statement_timestamp(),
      export_object_path = p_object_path, export_sha256 = lower(p_sha256),
      export_size_bytes = v_aggregate_size, export_file_count = v_artifact_count,
      export_lease_until = null, last_export_error = null,
      export_worker_token = null,
      download_token_hash = null, download_token_expires_at = null
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, action, entity_type, entity_id, new_values
  ) values (
    v_request.org_id, 'organization_export_completed',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object(
      'manifest_sha256', lower(p_sha256), 'aggregate_size_bytes', v_aggregate_size,
      'artifact_count', v_artifact_count
    )
  );
  delete from private.organization_export_snapshot_rows
  where request_id = v_request.id and generation = p_generation;
  delete from private.organization_export_snapshot_table_states
  where request_id = v_request.id and generation = p_generation;
  delete from private.organization_export_snapshot_storage_states
  where request_id = v_request.id and generation = p_generation;
  delete from private.organization_export_snapshot_objects
  where request_id = v_request.id and generation = p_generation;
  delete from private.organization_export_manifest_states
  where request_id = v_request.id and generation = p_generation;
  return jsonb_build_object(
    'request_id', v_request.id, 'generation', p_generation,
    'status', 'export_ready', 'artifact_count', v_artifact_count,
    'aggregate_size_bytes', v_aggregate_size, 'idempotent', false
  );
end
$$;

revoke all on function public.service_complete_organization_export(
  uuid, uuid, uuid, text, text
)
  from public, anon, authenticated;
grant execute on function public.service_complete_organization_export(
  uuid, uuid, uuid, text, text
)
  to service_role;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.service_complete_organization_export(uuid,uuid,uuid,text,text)'
    ::regprocedure::text,
  'actor: service_role-only tenant-export finalizer, never a browser or user JWT; tenant: the '
    || 'organization is derived from the locked offboarding request and the supplied generation '
    || 'and worker token must match its live lease; scope: auth_scopes() is unavailable to this '
    || 'worker, while every business row was already materialized by the A6-pinned snapshot; '
    || 'tables: reads only tenant-exports Storage evidence and private snapshot/part checkpoints, '
    || 'then writes the single locked offboarding row plus its tenant audit record; reason: it '
    || 'cannot be invoker because browser roles intentionally have no table privileges on any of '
    || 'those ledgers; audit: completion records checksum, size and part count; proof: browser '
    || 'EXECUTE is revoked, worker fencing and all-parts-complete checks fail closed.',
  'tenant offboarding export'
);

create function public.service_fail_organization_export(
  p_request_id uuid,
  p_generation uuid,
  p_worker_token uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
  v_error text := lower(coalesce(nullif(trim(p_error_code), ''), 'unknown_export_error'));
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_error !~ '^[a-z0-9_:-]{1,100}$' then v_error := 'unknown_export_error'; end if;
  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found then return; end if;
  if v_request.status <> 'export_building'
     or v_request.export_generation is distinct from p_generation
     or v_request.export_worker_token is distinct from p_worker_token then return; end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set status = 'export_failed', export_lease_until = null,
      export_worker_token = null, last_export_error = v_error
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, action, entity_type, entity_id, new_values
  ) values (
    v_request.org_id, 'organization_export_failed',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('error', v_error)
  );
end
$$;

revoke all on function public.service_fail_organization_export(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_fail_organization_export(uuid, uuid, uuid, text)
  to service_role;

create function public.service_issue_organization_export_link(
  p_request_id uuid,
  p_actor_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_request
  from public.organization_offboarding_requests request
  where request.id = p_request_id
  for update;
  if not found or v_request.status <> 'export_ready' then
    raise exception 'offboarding_export_not_ready' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_actor_id and profile.org_id = v_request.org_id
      and profile.active and profile.role = 'owner'
  ) then
    raise exception 'offboarding_export_owner_required' using errcode = '42501';
  end if;
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'offboarding_export_token_invalid' using errcode = '22023';
  end if;
  if p_expires_at < statement_timestamp() + interval '6 days 23 hours'
     or p_expires_at > statement_timestamp() + interval '7 days 5 minutes' then
    raise exception 'offboarding_export_link_expiry_invalid' using errcode = '22023';
  end if;

  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  update public.organization_offboarding_requests
  set download_token_hash = lower(p_token_hash),
      download_token_issued_at = statement_timestamp(),
      download_token_expires_at = p_expires_at
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values
  ) values (
    v_request.org_id, p_actor_id, 'organization_export_link_issued',
    'organization_offboarding_requests', v_request.id,
    jsonb_build_object('expires_at', p_expires_at)
  );
end
$$;

revoke all on function public.service_issue_organization_export_link(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.service_issue_organization_export_link(uuid, uuid, text, timestamptz)
  to service_role;

create function public.service_resolve_organization_export_link(p_token_hash text)
returns table (
  request_id uuid,
  generation uuid,
  object_path text,
  object_sha256 text,
  object_size_bytes bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$' then return; end if;

  select * into v_request
  from public.organization_offboarding_requests request
  where request.download_token_hash = lower(p_token_hash)
    and request.download_token_expires_at >= statement_timestamp()
    and request.status = 'export_ready';
  if not found then return; end if;

  request_id := v_request.id;
  select part.generation, part.object_path, part.sha256, part.size_bytes
    into generation, object_path, object_sha256, object_size_bytes
  from private.organization_export_parts part
  where part.request_id = v_request.id and part.generation = v_request.export_generation
    and part.kind = 'manifest' and part.status = 'completed'
    and part.object_path = v_request.export_object_path
    and part.sha256 = v_request.export_sha256;
  if not found then return; end if;
  return next;
end
$$;

revoke all on function public.service_resolve_organization_export_link(text)
  from public, anon, authenticated;
grant execute on function public.service_resolve_organization_export_link(text) to service_role;

-- The broker calls this after Storage has minted a short-lived signed URL and immediately before
-- redirecting. FOR UPDATE serializes with owner cancellation/reactivation; unlike resolve(), this
-- recheck is deliberately side-effect free and does not inflate download_count on failed redirects.
create function public.service_revalidate_organization_export_link(
  p_token_hash text,
  p_object_path text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$'
     or nullif(trim(p_object_path), '') is null then
    return false;
  end if;

  perform 1
  from public.organization_offboarding_requests request
  where request.download_token_hash = lower(p_token_hash)
    and request.download_token_expires_at >= statement_timestamp()
    and request.status = 'export_ready'
    and request.export_object_path = p_object_path
  for update;
  return found;
end
$$;
revoke all on function public.service_revalidate_organization_export_link(text, text)
  from public, anon, authenticated;
grant execute on function public.service_revalidate_organization_export_link(text, text)
  to service_role;

create function public.service_resolve_organization_export_artifact(
  p_token_hash text,
  p_artifact_path text
) returns table (
  name text,
  path text,
  sha256 text,
  size_bytes bigint,
  mime_type text,
  artifact_kind text
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$'
     or nullif(trim(p_artifact_path), '') is null then
    return;
  end if;
  return query
  select private.tenant_export_part_logical_name(part.kind, part.payload),
         part.object_path, part.sha256, part.size_bytes, part.mime_type, part.kind
  from public.organization_offboarding_requests request
  join private.organization_export_parts part
    on part.request_id = request.id and part.generation = request.export_generation
  join storage.objects object
    on object.bucket_id = 'tenant-exports' and object.name = part.object_path
    and coalesce((object.metadata ->> 'size')::bigint, -1) = part.size_bytes
    and lower(coalesce(object.metadata ->> 'mimetype', '')) = part.mime_type
  where request.download_token_hash = lower(p_token_hash)
    and request.download_token_expires_at >= statement_timestamp()
    and request.status = 'export_ready'
    and part.kind <> 'manifest' and part.status = 'completed'
    and part.object_path = p_artifact_path;
end
$$;
revoke all on function public.service_resolve_organization_export_artifact(text, text)
  from public, anon, authenticated;
grant execute on function public.service_resolve_organization_export_artifact(text, text)
  to service_role;

create function public.service_record_organization_export_access(
  p_token_hash text,
  p_access_kind text,
  p_idempotency_key uuid,
  p_artifact_name text default null,
  p_artifact_path text default null,
  p_artifact_sha256 text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, private, storage, pg_temp
as $$
declare
  v_request public.organization_offboarding_requests;
  v_existing private.organization_export_access_events;
  v_part private.organization_export_parts;
  v_access_kind text := lower(nullif(trim(p_access_kind), ''));
  v_artifact_name text := nullif(trim(p_artifact_name), '');
  v_artifact_path text := nullif(trim(p_artifact_path), '');
  v_artifact_sha256 text := lower(nullif(trim(p_artifact_sha256), ''));
  v_download_count integer;
  v_portal_open_count integer;
  v_artifact_link_issued_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or v_access_kind not in (
       'portal_opened', 'manifest_downloaded',
       'manifest_page_downloaded', 'artifact_link_issued'
     )
     or lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'organization_export_access_invalid' using errcode = '22023';
  end if;
  select * into v_request
  from public.organization_offboarding_requests request
  where request.download_token_hash = lower(p_token_hash)
    and request.download_token_expires_at >= statement_timestamp()
    and request.status = 'export_ready'
  for update;
  if not found then
    raise exception 'organization_export_link_invalid' using errcode = 'P0002';
  end if;

  if v_access_kind = 'portal_opened' then
    if v_artifact_name is not null or v_artifact_path is not null
       or v_artifact_sha256 is not null then
      raise exception 'organization_export_access_invalid' using errcode = '22023';
    end if;
    select * into v_part
    from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = v_request.export_generation
      and part.kind = 'manifest' and part.status = 'completed';
  elsif v_access_kind = 'manifest_downloaded' then
    if v_artifact_name <> 'manifest.json'
       or v_artifact_path is distinct from v_request.export_object_path
       or v_artifact_sha256 is distinct from v_request.export_sha256 then
      raise exception 'organization_export_artifact_unverified' using errcode = '55000';
    end if;
    select * into v_part
    from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = v_request.export_generation
      and part.kind = 'manifest' and part.status = 'completed'
      and part.object_path = v_artifact_path and part.sha256 = v_artifact_sha256;
  elsif v_access_kind = 'manifest_page_downloaded' then
    if v_artifact_name is null or v_artifact_path is null
       or coalesce(v_artifact_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception 'organization_export_access_invalid' using errcode = '22023';
    end if;
    select * into v_part
    from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = v_request.export_generation
      and part.kind = 'manifest_page' and part.status = 'completed'
      and part.object_path = v_artifact_path and part.sha256 = v_artifact_sha256
      and private.tenant_export_part_logical_name(part.kind, part.payload) = v_artifact_name;
  else
    if v_artifact_name is null or v_artifact_path is null
       or coalesce(v_artifact_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception 'organization_export_access_invalid' using errcode = '22023';
    end if;
    select * into v_part
    from private.organization_export_parts part
    where part.request_id = v_request.id and part.generation = v_request.export_generation
      and part.kind <> 'manifest' and part.status = 'completed'
      and part.object_path = v_artifact_path and part.sha256 = v_artifact_sha256
      and private.tenant_export_part_logical_name(part.kind, part.payload) = v_artifact_name;
  end if;
  if not found or not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'tenant-exports' and object.name = v_part.object_path
      and coalesce((object.metadata ->> 'size')::bigint, -1) = v_part.size_bytes
      and lower(coalesce(object.metadata ->> 'mimetype', '')) = v_part.mime_type
  ) then
    raise exception 'organization_export_artifact_unverified' using errcode = '55000';
  end if;

  select * into v_existing
  from private.organization_export_access_events event
  where event.request_id = v_request.id
    and event.generation = v_request.export_generation
    and event.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.access_kind is distinct from v_access_kind
       or v_existing.artifact_name is distinct from v_artifact_name
       or v_existing.artifact_path is distinct from v_artifact_path
       or v_existing.artifact_sha256 is distinct from v_artifact_sha256 then
      raise exception 'organization_export_access_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'recorded', true, 'request_id', v_request.id,
      'generation', v_request.export_generation, 'access_kind', v_access_kind,
      'idempotency_key', p_idempotency_key, 'idempotent', true
    ) || case v_access_kind
      when 'portal_opened' then jsonb_build_object(
        'portal_open_count', v_request.portal_open_count)
      when 'manifest_downloaded' then jsonb_build_object(
        'download_count', v_request.download_count)
      when 'manifest_page_downloaded' then jsonb_build_object(
        'download_count', v_request.download_count)
      else jsonb_build_object(
        'artifact_link_issued_count', v_request.artifact_link_issued_count)
    end;
  end if;

  insert into private.organization_export_access_events (
    request_id, generation, org_id, idempotency_key, access_kind,
    artifact_name, artifact_path, artifact_sha256
  ) values (
    v_request.id, v_request.export_generation, v_request.org_id, p_idempotency_key,
    v_access_kind, v_artifact_name, v_artifact_path, v_artifact_sha256
  );
  perform set_config('app.organization_offboarding_writer_org', v_request.org_id::text, true);
  if v_access_kind in ('manifest_downloaded', 'manifest_page_downloaded') then
    update public.organization_offboarding_requests request
    set download_count = request.download_count + 1,
        last_downloaded_at = statement_timestamp()
    where request.id = v_request.id
    returning request.download_count into v_download_count;
  elsif v_access_kind = 'artifact_link_issued' then
    update public.organization_offboarding_requests request
    set artifact_link_issued_count = request.artifact_link_issued_count + 1,
        last_artifact_link_issued_at = statement_timestamp()
    where request.id = v_request.id
    returning request.artifact_link_issued_count into v_artifact_link_issued_count;
    v_download_count := v_request.download_count;
  else
    update public.organization_offboarding_requests request
    set portal_open_count = request.portal_open_count + 1
    where request.id = v_request.id
    returning request.portal_open_count into v_portal_open_count;
    v_download_count := v_request.download_count;
  end if;
  insert into public.audit_logs (
    org_id, action, entity_type, entity_id, new_values
  ) values (
    v_request.org_id,
    case v_access_kind
      when 'portal_opened' then 'organization_export_portal_opened'
      when 'manifest_downloaded' then 'organization_export_manifest_downloaded'
      when 'manifest_page_downloaded' then 'organization_export_manifest_page_downloaded'
      else 'organization_export_artifact_link_issued'
    end,
    'organization_offboarding_requests', v_request.id,
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', p_idempotency_key, 'artifact_name', v_artifact_name,
      'artifact_path', v_artifact_path, 'artifact_sha256', v_artifact_sha256
    ) || case v_access_kind
      when 'portal_opened' then jsonb_build_object(
        'portal_open_count', v_portal_open_count)
      when 'manifest_downloaded' then jsonb_build_object(
        'download_count', v_download_count)
      when 'manifest_page_downloaded' then jsonb_build_object(
        'download_count', v_download_count)
      else jsonb_build_object(
        'artifact_link_issued_count', v_artifact_link_issued_count)
    end)
  );
  return jsonb_build_object(
    'recorded', true, 'request_id', v_request.id,
    'generation', v_request.export_generation, 'access_kind', v_access_kind,
    'idempotency_key', p_idempotency_key, 'idempotent', false
  ) || case v_access_kind
    when 'portal_opened' then jsonb_build_object(
      'portal_open_count', v_portal_open_count)
    when 'manifest_downloaded' then jsonb_build_object(
      'download_count', v_download_count)
    when 'manifest_page_downloaded' then jsonb_build_object(
      'download_count', v_download_count)
    else jsonb_build_object(
      'artifact_link_issued_count', v_artifact_link_issued_count)
  end;
end
$$;
revoke all on function public.service_record_organization_export_access(
  text, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.service_record_organization_export_access(
  text, text, uuid, text, text, text
) to service_role;

comment on table public.organization_offboarding_requests is
  'Audited tenant offboarding contract: 30-day owner cancellation, full export evidence, seven-day signed delivery and separate retention boundaries.';
comment on function public.request_organization_offboarding(uuid) is
  'Owner-only, step-up and idempotent. No free-text reason is required by product decision.';
comment on function public.service_claim_organization_export(uuid, uuid) is
  'Service-role-only export lease and exact tenant dataset manifest for the tenant-export Edge Function.';

-- ===== OCR attempt-bound signed-download egress =====
-- 0045 intended a 25 MiB extraction ceiling, but pg_column_size(jsonb) includes binary JSONB
-- container overhead. The evidence boundary below hashes and limits canonical UTF-8 JSON, so an
-- exact 25 MiB canonical payload was rejected by the earlier shape validator before it reached
-- that boundary. Keep every structural rule and align only the byte unit with the evidence
-- contract. The ancestry pin makes this forward replacement fail closed if 0045 changes.
do $guard$
declare
  v_hash text;
begin
  select md5(procedure.prosrc)
  into v_hash
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.oid = 'public.smart_document_extraction_valid(jsonb,text)'::regprocedure;
  if v_hash is distinct from '77fc0b0db2550dc2bdf37e7d6b514448' then
    raise exception '0111 ancestry guard failed: smart_document_extraction_valid changed';
  end if;
end
$guard$;

create or replace function public.smart_document_extraction_valid(
  p_payload jsonb,
  p_contract_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_document jsonb;
  v_item jsonb;
  v_row jsonb;
  v_cell jsonb;
  v_total_rows integer := 0;
begin
  if p_payload is null
     or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ?& array['schema_version', 'document', 'blocks', 'tables', 'marks'])
     or p_contract_version is distinct from '1'
     or jsonb_typeof(p_payload -> 'schema_version') is distinct from 'string'
     or (p_payload ->> 'schema_version') is distinct from p_contract_version
     or jsonb_typeof(p_payload -> 'document') <> 'object'
     or jsonb_typeof(p_payload -> 'blocks') <> 'array'
     or jsonb_typeof(p_payload -> 'tables') <> 'array'
     or jsonb_typeof(p_payload -> 'marks') <> 'array'
     or octet_length(p_payload::text) > 26214400 then
    return false;
  end if;

  v_document := p_payload -> 'document';
  if not (v_document ?& array['page_count', 'detected_languages', 'plain_text', 'partial'])
     or jsonb_typeof(v_document -> 'page_count') <> 'number'
     or (v_document ->> 'page_count')::numeric < 1
     or (v_document ->> 'page_count')::numeric <> trunc((v_document ->> 'page_count')::numeric)
     or (v_document ->> 'page_count')::numeric > 100
     or jsonb_typeof(v_document -> 'detected_languages') <> 'array'
     or exists (
       select 1 from jsonb_array_elements(v_document -> 'detected_languages') language
       where jsonb_typeof(language) <> 'string'
     )
     or jsonb_typeof(v_document -> 'plain_text') <> 'string'
     or length(v_document ->> 'plain_text') > 2000000
     or jsonb_typeof(v_document -> 'partial') <> 'boolean' then
    return false;
  end if;

  for v_item in select value from jsonb_array_elements(p_payload -> 'blocks')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['id', 'page', 'type', 'bbox', 'text', 'confidence'])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or jsonb_typeof(v_item -> 'type') is distinct from 'string'
       or v_item ->> 'type' not in ('text', 'heading', 'table', 'image', 'handwriting')
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'text') <> 'string'
       or not public.smart_document_confidence_valid(v_item -> 'confidence') then
      return false;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'tables')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['id', 'page', 'bbox', 'rows'])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'rows') <> 'array'
       or jsonb_array_length(v_item -> 'rows') > 5000 then
      return false;
    end if;
    v_total_rows := v_total_rows + jsonb_array_length(v_item -> 'rows');
    if v_total_rows > 5000 then
      return false;
    end if;
    for v_row in select value from jsonb_array_elements(v_item -> 'rows')
    loop
      if jsonb_typeof(v_row) <> 'array' then
        return false;
      end if;
      for v_cell in select value from jsonb_array_elements(v_row)
      loop
        if jsonb_typeof(v_cell) <> 'object'
           or not (v_cell ?& array['text', 'bbox'])
           or jsonb_typeof(v_cell -> 'text') <> 'string'
           or not (
             jsonb_typeof(v_cell -> 'bbox') = 'null'
             or public.smart_document_bbox_valid(v_cell -> 'bbox')
           ) then
          return false;
        end if;
      end loop;
    end loop;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'marks')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'id', 'page', 'kind', 'bbox', 'nearby_block_ids', 'confidence', 'fingerprint'
       ])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or v_item ->> 'kind' not in ('circle', 'check', 'cross', 'underline', 'star', 'custom', 'unknown')
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'nearby_block_ids') <> 'array'
       or exists (
         select 1 from jsonb_array_elements(v_item -> 'nearby_block_ids') block_id
         where jsonb_typeof(block_id) <> 'string'
       )
       or not public.smart_document_confidence_valid(v_item -> 'confidence')
       or not (jsonb_typeof(v_item -> 'fingerprint') in ('string', 'null')) then
      return false;
    end if;
  end loop;

  return true;
exception when others then
  return false;
end
$$;
revoke all on function public.smart_document_extraction_valid(jsonb, text)
  from public, anon, authenticated, service_role;

-- A job may be claimed more than once. The egress correlation is therefore a fresh UUID per
-- claim, never the durable job id. This prevents a late worker from settling or completing a
-- newer attempt and lets an explicitly retryable failure close one lease before requeueing.
alter table public.document_processing_jobs
  add column processing_attempt_id uuid,
  add column processing_attempt_started_at timestamptz,
  add constraint document_processing_jobs_attempt_shape check (
    (processing_attempt_id is null and processing_attempt_started_at is null)
    or (processing_attempt_id is not null and processing_attempt_started_at is not null)
  );

-- Attempt identity is durable tenant audit evidence, unlike the transient worker name/expiry.
-- Refresh this one reviewed projection explicitly so A6 continues to detect every later drift.
update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    ),
    rationale = 'Job history with durable per-attempt identity, without transient worker leases.'
where registry.table_name = 'document_processing_jobs';

create or replace function public.guard_document_processing_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_processing_claim_job', true) = old.id::text, false
  );
  v_retry_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_processing_retry_job', true) = old.id::text, false
  );
  v_recovery_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_interpretation_recovery_job', true) = old.id::text, false
  );
  v_extraction_recovery_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_extraction_recovery_job', true) = old.id::text, false
  );
begin
  if new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.requested_by is distinct from old.requested_by
     or new.input_checksum is distinct from old.input_checksum
     or new.contract_version is distinct from old.contract_version
     or new.priority is distinct from old.priority
     or new.created_at is distinct from old.created_at
     or new.attempt_count < old.attempt_count then
    raise exception 'document_processing_job_identity_immutable' using errcode = '42501';
  end if;

  if new.processing_attempt_id is distinct from old.processing_attempt_id
     or new.processing_attempt_started_at is distinct from old.processing_attempt_started_at then
    if not v_claim_write
       or new.status <> 'leased'
       or new.processing_attempt_id is null
       or new.processing_attempt_started_at is null
       or new.attempt_count <> old.attempt_count + 1 then
      raise exception 'document_processing_attempt_immutable' using errcode = '42501';
    end if;
  end if;

  if new.interpretation_actor_id is distinct from old.interpretation_actor_id
     or new.interpretation_started_at is distinct from old.interpretation_started_at then
    if old.status = 'extracted'
       and new.status = 'interpreting'
       and old.interpretation_actor_id is null
       and old.interpretation_started_at is null
       and new.interpretation_actor_id is not null
       and new.interpretation_started_at is not null
       and current_setting('app.document_interpretation_writer', true)
            is not distinct from new.interpretation_actor_id::text then
      null;
    elsif old.status = 'interpreting'
       and new.status = 'interpreting'
       and old.interpretation_actor_id is not null
       and old.interpretation_started_at <= clock_timestamp() - interval '5 minutes'
       and new.interpretation_actor_id is not null
       and new.interpretation_started_at > old.interpretation_started_at
       and current_setting('app.document_interpretation_writer', true)
            is not distinct from new.interpretation_actor_id::text then
      null;
    else
      raise exception 'document_interpretation_actor_immutable' using errcode = '42501';
    end if;
  elsif old.status = 'extracted' and new.status = 'interpreting' then
    raise exception 'document_interpretation_rpc_required' using errcode = '42501';
  end if;

  if old.status = 'queued' and new.status not in ('queued', 'leased') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'leased'
        and new.status not in ('leased', 'extracted', 'failed')
        and not (new.status = 'queued' and v_retry_write) then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'extracted' and new.status not in ('extracted', 'interpreting', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'interpreting' and new.status not in ('interpreting', 'review', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'review' and new.status not in ('review', 'completed', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'completed' and new.status <> old.status then
    raise exception 'document_processing_terminal_state' using errcode = '23514';
  elsif old.status = 'failed'
        and new.status <> old.status
        and not (
          (new.status = 'interpreting' and v_recovery_write)
          or (new.status = 'extracted' and v_extraction_recovery_write)
        ) then
    raise exception 'document_processing_terminal_state' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end
$$;

drop function public.claim_document_processing_job(text, integer);
create function public.claim_document_processing_job(
  p_lease_owner text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_attempt_id uuid;
  v_recovery_lease_id uuid;
  v_recovery_evidence_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;

  loop
    select j.* into v_job
    from public.document_processing_jobs j
    where (
      j.status = 'queued'
      or (j.status = 'leased' and j.lease_until <= statement_timestamp())
    )
      and private.organization_write_allowed_fenced(j.org_id)
    order by j.priority desc, j.created_at, j.id
    for update skip locked
    limit 1;
    if not found then return null; end if;

    if v_job.status = 'leased' and v_job.processing_attempt_id is not null then
      -- A committed provider result always wins over starting a second billable OCR call.
      -- This is the crash-recovery path for a worker that recorded immutable evidence but
      -- disappeared before the separate business-apply RPC (or lost that RPC response).
      select evidence.lease_id, evidence.evidence_sha256
      into v_recovery_lease_id, v_recovery_evidence_sha256
      from private.organization_external_egress_evidence evidence
      join private.organization_external_egress_leases lease
        on lease.lease_id = evidence.lease_id
      where evidence.org_id = v_job.org_id
        and evidence.kind = 'document_signed_url'
        and evidence.correlation_id = v_job.processing_attempt_id
        and evidence.outcome = 'delivered'
        and lease.org_id = v_job.org_id
        and lease.kind = evidence.kind
        and lease.correlation_id = evidence.correlation_id;
      if found then
        perform public.service_recover_document_extraction_from_egress(
          v_job.id,
          v_job.processing_attempt_id,
          v_recovery_lease_id,
          v_recovery_evidence_sha256
        );
        continue;
      end if;

      update private.organization_external_egress_leases lease
      set status = 'settled', outcome = 'ambiguous',
          evidence_code = 'job_lease_expired_before_settlement',
          settled_at = statement_timestamp()
      where lease.org_id = v_job.org_id
        and lease.kind = 'document_signed_url'
        and lease.correlation_id = v_job.processing_attempt_id
        and lease.status = 'active';
    end if;

    v_attempt_id := gen_random_uuid();
    perform set_config('app.document_processing_claim_job', v_job.id::text, true);
    update public.document_processing_jobs j
    set status = 'leased', lease_owner = v_owner,
        lease_until = statement_timestamp() + make_interval(secs => v_seconds),
        attempt_count = j.attempt_count + 1,
        processing_attempt_id = v_attempt_id,
        processing_attempt_started_at = statement_timestamp(),
        last_error_code = null, last_error_message = null
    where j.id = v_job.id
    returning j.* into v_job;

    select * into v_document
    from public.documents
    where id = v_job.document_id and org_id = v_job.org_id;
    if not found or v_document.deleted_at is not null then
      update public.document_processing_jobs
      set status = 'failed', lease_owner = null, lease_until = null,
          last_error_code = 'document_deleted',
          last_error_message = 'Source document was deleted before processing'
      where id = v_job.id;
      insert into public.audit_logs (
        org_id, user_id, action, entity_type, entity_id, new_values, reason
      ) values (
        v_job.org_id, null, 'document_processing_failed', 'document_processing_jobs', v_job.id,
        jsonb_build_object('error_code', 'document_deleted', 'processing_attempt_id', v_attempt_id),
        'source document deleted before processing'
      );
      continue;
    end if;
    exit;
  end loop;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_claimed', 'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'lease_owner', v_owner, 'attempt_count', v_job.attempt_count,
      'processing_attempt_id', v_attempt_id
    ), 'private OCR worker lease'
  );
  return jsonb_build_object(
    'job_id', v_job.id, 'org_id', v_job.org_id, 'document_id', v_job.document_id,
    'processing_attempt_id', v_attempt_id,
    'processing_attempt_started_at', v_job.processing_attempt_started_at,
    'storage_path', v_document.storage_path, 'mime_type', v_document.mime_type,
    'file_name', v_document.file_name, 'input_checksum', v_job.input_checksum,
    'contract_version', v_job.contract_version, 'lease_until', v_job.lease_until,
    'attempt_count', v_job.attempt_count
  );
end
$$;
revoke all on function public.claim_document_processing_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_document_processing_job(text, integer) to service_role;

create function private.document_processing_egress_binding(
  p_job public.document_processing_jobs,
  p_lease_id uuid,
  p_lease_token uuid,
  p_require_ack boolean,
  p_require_active boolean
) returns private.organization_external_egress_leases
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lease private.organization_external_egress_leases;
begin
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_lease_id
  for update;
  if not found
     or p_job.processing_attempt_id is null
     or v_lease.lease_token is distinct from p_lease_token
     or v_lease.org_id is distinct from p_job.org_id
     or v_lease.kind <> 'document_signed_url'
     or v_lease.correlation_id is distinct from p_job.processing_attempt_id
     or (p_require_active and v_lease.status <> 'active')
     or (p_require_ack and (
       v_lease.acknowledged_at is null
       or v_lease.acknowledged_by is distinct from p_job.lease_owner
     )) then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  return v_lease;
end
$$;
revoke all on function private.document_processing_egress_binding(
  public.document_processing_jobs, uuid, uuid, boolean, boolean
) from public, anon, authenticated, service_role;

create function public.service_acknowledge_document_processing_download(
  p_job_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
  v_now timestamptz := statement_timestamp();
  v_ack timestamptz;
  v_until timestamptz;
  v_idempotent boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= v_now then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  v_lease := private.document_processing_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, false, true
  );
  if v_lease.expires_at <= v_now then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  v_idempotent := v_lease.acknowledged_at is not null;
  if v_idempotent and v_lease.acknowledged_by is distinct from v_owner then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  v_ack := coalesce(v_lease.acknowledged_at, v_now);
  v_until := least(v_ack + interval '3720 seconds', v_now + make_interval(secs => v_seconds));
  if v_until <= v_now then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  update private.organization_external_egress_leases
  set acknowledged_at = v_ack, acknowledged_by = v_owner,
      expires_at = greatest(expires_at, v_until)
  where lease_id = v_lease.lease_id
  returning expires_at into v_until;
  update public.document_processing_jobs set lease_until = v_until where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'org_id', v_job.org_id,
    'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'acknowledged_at', v_ack,
    'job_lease_until', v_until, 'egress_expires_at', v_until,
    'idempotent', v_idempotent
  );
end
$$;
revoke all on function public.service_acknowledge_document_processing_download(
  uuid, text, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.service_acknowledge_document_processing_download(
  uuid, text, uuid, uuid, integer
) to service_role;

create function public.heartbeat_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
  v_now timestamptz := statement_timestamp();
  v_until timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= v_now then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  v_lease := private.document_processing_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, true, true
  );
  if v_lease.expires_at <= v_now then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  v_until := least(
    v_lease.acknowledged_at + interval '3720 seconds',
    v_now + make_interval(secs => v_seconds)
  );
  if v_until <= v_now then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  update private.organization_external_egress_leases
  set expires_at = greatest(expires_at, v_until)
  where lease_id = v_lease.lease_id
  returning expires_at into v_until;
  update public.document_processing_jobs set lease_until = v_until where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'acknowledged_at', v_lease.acknowledged_at,
    'job_lease_until', v_until, 'egress_expires_at', v_until
  );
end
$$;
revoke all on function public.heartbeat_document_processing_job(uuid, text, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_document_processing_job(uuid, text, uuid, uuid, integer)
  to service_role;

create function private.document_ocr_evidence_binding(
  p_job public.document_processing_jobs,
  p_processing_attempt_id uuid,
  p_evidence_lease_id uuid,
  p_evidence_sha256 text
) returns private.organization_external_egress_evidence
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_lease private.organization_external_egress_leases;
  v_evidence private.organization_external_egress_evidence;
  v_payload_sha256 text;
begin
  if p_processing_attempt_id is null or p_evidence_lease_id is null
     or lower(coalesce(p_evidence_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'document_ocr_evidence_invalid' using errcode = '22023';
  end if;
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_evidence_lease_id;
  select * into v_evidence
  from private.organization_external_egress_evidence evidence
  where evidence.lease_id = p_evidence_lease_id;
  if v_lease.lease_id is null or v_evidence.lease_id is null
     or v_lease.org_id is distinct from p_job.org_id
     or v_lease.kind <> 'document_signed_url'
     or v_lease.correlation_id is distinct from p_processing_attempt_id
     or v_lease.status <> 'settled'
     or v_evidence.org_id is distinct from p_job.org_id
     or v_evidence.kind is distinct from v_lease.kind
     or v_evidence.correlation_id is distinct from p_processing_attempt_id
     or v_evidence.outcome <> 'delivered'
     or v_evidence.evidence_code <> 'document_ocr_completed'
     or v_evidence.evidence_sha256 is distinct from lower(p_evidence_sha256)
     or v_evidence.evidence ->> 'evidence_schema_version'
          is distinct from 'document_ocr_evidence_v1'
     or v_evidence.evidence ->> 'org_id' is distinct from p_job.org_id::text
     or v_evidence.evidence ->> 'job_id' is distinct from p_job.id::text
     or v_evidence.evidence ->> 'processing_attempt_id'
          is distinct from p_processing_attempt_id::text
     or v_evidence.evidence ->> 'document_id' is distinct from p_job.document_id::text
     or v_evidence.evidence ->> 'input_checksum' is distinct from p_job.input_checksum
     or v_evidence.evidence ->> 'contract_version' is distinct from p_job.contract_version
     or nullif(trim(v_evidence.evidence ->> 'engine'), '') is null
     or nullif(trim(v_evidence.evidence ->> 'model'), '') is null
     or nullif(trim(v_evidence.evidence ->> 'model_version'), '') is null
     or jsonb_typeof(v_evidence.evidence -> 'extraction') is distinct from 'object'
     or jsonb_typeof(v_evidence.evidence -> 'resource_metadata') is distinct from 'object'
     or not public.smart_document_extraction_valid(
       v_evidence.evidence -> 'extraction', p_job.contract_version
     ) then
    raise exception 'document_ocr_evidence_mismatch' using errcode = '42501';
  end if;
  v_payload_sha256 := encode(digest(
    convert_to((v_evidence.evidence -> 'extraction')::text, 'UTF8'), 'sha256'
  ), 'hex');
  if v_evidence.evidence ->> 'payload_sha256' is distinct from v_payload_sha256 then
    raise exception 'document_ocr_evidence_hash_mismatch' using errcode = '42501';
  end if;
  return v_evidence;
end
$$;
revoke all on function private.document_ocr_evidence_binding(
  public.document_processing_jobs, uuid, uuid, text
) from public, anon, authenticated, service_role;

-- Provider output is durably committed before any public extraction mutation. The caller must
-- await this RPC and only then invoke complete_document_processing_job in a second transaction.
-- A lost response is safe: exact canonical replay returns the original immutable evidence hash.
create function public.service_record_document_ocr_evidence(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_engine text,
  p_model text,
  p_model_version text,
  p_input_checksum text,
  p_contract_version text,
  p_payload jsonb,
  p_duration_ms integer default null,
  p_resource_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_payload_sha256 text;
  v_evidence jsonb;
  v_existing private.organization_external_egress_evidence;
  v_evidence_sha256 text;
  v_settlement jsonb;
  v_receipt jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_job_id is null or p_processing_attempt_id is null
     or p_egress_lease_id is null or p_egress_lease_token is null
     or v_owner is null or length(v_owner) > 200
     or nullif(trim(p_engine), '') is null or length(trim(p_engine)) > 100
     or nullif(trim(p_model), '') is null or length(trim(p_model)) > 200
     or nullif(trim(p_model_version), '') is null or length(trim(p_model_version)) > 200
     or p_duration_ms is not null and p_duration_ms < 0
     or p_resource_metadata is null or jsonb_typeof(p_resource_metadata) <> 'object'
     or p_payload is null or octet_length(p_payload::text) > 26214400
     or not public.smart_document_extraction_valid(p_payload, p_contract_version) then
    raise exception 'document_ocr_evidence_invalid' using errcode = '22023';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  if p_input_checksum is distinct from v_job.input_checksum
     or p_contract_version is distinct from v_job.contract_version then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_egress_lease_id
  for update;
  if not found
     or v_lease.lease_token is distinct from p_egress_lease_token
     or v_lease.org_id is distinct from v_job.org_id
     or v_lease.kind <> 'document_signed_url'
     or v_lease.correlation_id is distinct from p_processing_attempt_id
     or v_lease.acknowledged_at is null
     or v_lease.acknowledged_by is distinct from v_owner then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;

  v_payload_sha256 := encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  v_evidence := jsonb_build_object(
    'evidence_schema_version', 'document_ocr_evidence_v1',
    'org_id', v_job.org_id,
    'job_id', v_job.id,
    'processing_attempt_id', p_processing_attempt_id,
    'document_id', v_job.document_id,
    'engine', trim(p_engine),
    'model', trim(p_model),
    'model_version', trim(p_model_version),
    'input_checksum', p_input_checksum,
    'contract_version', p_contract_version,
    'duration_ms', p_duration_ms,
    'resource_metadata', p_resource_metadata,
    'payload_sha256', v_payload_sha256,
    'extraction', p_payload
  );
  v_evidence_sha256 := encode(
    digest(convert_to(v_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );
  select * into v_existing
  from private.organization_external_egress_evidence evidence
  where evidence.lease_id = v_lease.lease_id;
  if found then
    if v_existing.outcome <> 'delivered'
       or v_existing.evidence_code <> 'document_ocr_completed'
       or v_existing.provider_status is not null
       or v_existing.evidence_sha256 <> v_evidence_sha256 then
      raise exception 'organization_external_egress_evidence_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'job_id', v_job.id, 'org_id', v_job.org_id,
      'processing_attempt_id', p_processing_attempt_id,
      'egress_lease_id', v_lease.lease_id,
      'evidence_sha256', v_existing.evidence_sha256,
      'payload_sha256', v_payload_sha256,
      'lease_outcome', v_lease.outcome, 'idempotent', true
    );
  end if;
  if v_lease.status = 'active' then
    v_settlement := private.settle_organization_external_egress(
      v_lease.lease_id, p_egress_lease_token, 'delivered',
      'document_ocr_completed', null
    );
    v_lease.outcome := 'delivered';
  elsif v_lease.outcome <> 'delivered'
        and not (
          v_lease.outcome = 'ambiguous'
          and v_lease.evidence_code in (
            'lease_expired_without_settlement',
            'job_lease_expired_before_settlement'
          )
        ) then
    raise exception 'organization_external_egress_already_settled' using errcode = '55000';
  end if;
  insert into private.organization_external_egress_evidence (
    lease_id, org_id, kind, correlation_id, outcome, evidence_code,
    provider_status, evidence, evidence_sha256
  ) values (
    v_lease.lease_id, v_lease.org_id, v_lease.kind, v_lease.correlation_id,
    'delivered', 'document_ocr_completed', null, v_evidence, v_evidence_sha256
  );
  v_receipt := jsonb_build_object(
    'evidence_sha256', v_evidence_sha256,
    'lease_outcome', v_lease.outcome, 'idempotent', false
  );
  return jsonb_build_object(
    'job_id', v_job.id,
    'org_id', v_job.org_id,
    'processing_attempt_id', p_processing_attempt_id,
    'egress_lease_id', v_lease.lease_id,
    'evidence_sha256', v_receipt ->> 'evidence_sha256',
    'payload_sha256', v_payload_sha256,
    'lease_outcome', v_receipt ->> 'lease_outcome',
    'idempotent', (v_receipt ->> 'idempotent')::boolean
  );
end
$$;
revoke all on function public.service_record_document_ocr_evidence(
  uuid, uuid, text, uuid, uuid, text, text, text, text, text, jsonb, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.service_record_document_ocr_evidence(
  uuid, uuid, text, uuid, uuid, text, text, text, text, text, jsonb, integer, jsonb
) to service_role;

create function public.complete_document_processing_job(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_evidence_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_lease private.organization_external_egress_leases;
  v_evidence private.organization_external_egress_evidence;
  v_existing public.document_extractions;
  v_current_checksum text;
  v_extraction_id uuid;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_mode text;
  v_can_apply boolean := false;
  v_payload jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_processing_attempt_id is null or v_owner is null or length(v_owner) > 200
     or p_egress_lease_id is null or p_egress_lease_token is null
     or lower(coalesce(p_evidence_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'document_ocr_completion_invalid' using errcode = '22023';
  end if;

  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  v_evidence := private.document_ocr_evidence_binding(
    v_job, p_processing_attempt_id, p_egress_lease_id, p_evidence_sha256
  );
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_egress_lease_id;
  if v_lease.lease_token is distinct from p_egress_lease_token
     or v_lease.acknowledged_by is distinct from v_owner then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;
  v_payload := v_evidence.evidence;

  perform 1 from public.organizations organization
  where organization.id = v_job.org_id for key share;
  v_mode := private.organization_access_mode(v_job.org_id);
  v_can_apply := v_mode in ('active', 'trial', 'grace')
    and v_job.status = 'leased'
    and v_job.processing_attempt_id is not distinct from p_processing_attempt_id
    and v_job.lease_owner is not distinct from v_owner
    and v_job.lease_until > statement_timestamp()
    and v_lease.status = 'settled'
    and v_lease.outcome = 'delivered'
    and v_lease.expires_at > statement_timestamp();

  select * into v_existing
  from public.document_extractions extraction
  where extraction.org_id = v_job.org_id and extraction.job_id = v_job.id;
  if found and (
    v_existing.input_checksum is distinct from v_payload ->> 'input_checksum'
    or v_existing.contract_version is distinct from v_payload ->> 'contract_version'
    or v_existing.engine is distinct from trim(v_payload ->> 'engine')
    or v_existing.model is distinct from trim(v_payload ->> 'model')
    or v_existing.model_version is distinct from trim(v_payload ->> 'model_version')
    or v_existing.payload is distinct from v_payload -> 'extraction'
    or v_existing.duration_ms is distinct from (v_payload ->> 'duration_ms')::integer
    or v_existing.resource_metadata is distinct from v_payload -> 'resource_metadata'
  ) then
    raise exception 'document_extraction_conflict' using errcode = '23505';
  end if;

  if v_can_apply and v_existing.id is null then
    select * into v_document
    from public.documents
    where id = v_job.document_id and org_id = v_job.org_id and deleted_at is null;
    if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
    v_current_checksum := public.smart_document_source_checksum(
      v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
    );
    if v_current_checksum <> v_job.input_checksum then
      raise exception 'document_processing_source_changed' using errcode = '22023';
    end if;
  end if;

  if v_existing.id is not null then
    return jsonb_build_object(
      'job_id', v_job.id, 'processing_attempt_id', p_processing_attempt_id,
      'egress_lease_id', v_lease.lease_id, 'extraction_id', v_existing.id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'payload_sha256', v_payload ->> 'payload_sha256',
      'business_applied', true, 'access_mode', v_mode, 'idempotent', true
    );
  end if;
  if not v_can_apply then
    return jsonb_build_object(
      'job_id', v_job.id, 'processing_attempt_id', p_processing_attempt_id,
      'egress_lease_id', v_lease.lease_id, 'extraction_id', null,
      'evidence_sha256', v_evidence.evidence_sha256,
      'payload_sha256', v_payload ->> 'payload_sha256',
      'business_applied', false, 'access_mode', v_mode,
      'idempotent', false
    );
  end if;

  insert into public.document_extractions (
    org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload, duration_ms, resource_metadata
  ) values (
    v_job.org_id, v_job.id, v_job.document_id,
    trim(v_payload ->> 'engine'), trim(v_payload ->> 'model'),
    trim(v_payload ->> 'model_version'),
    v_payload ->> 'input_checksum', v_payload ->> 'contract_version',
    v_payload -> 'extraction', (v_payload ->> 'duration_ms')::integer,
    v_payload -> 'resource_metadata'
  ) returning id into v_extraction_id;
  update public.document_processing_jobs
  set status = 'extracted', lease_owner = null, lease_until = null,
      last_error_code = null, last_error_message = null
  where id = v_job.id;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_extracted', 'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'extraction_id', v_extraction_id, 'engine', trim(v_payload ->> 'engine'),
      'model', trim(v_payload ->> 'model'), 'processing_attempt_id', p_processing_attempt_id,
      'egress_lease_id', v_lease.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'payload_sha256', v_payload ->> 'payload_sha256'
    ), 'immutable OCR evidence applied after separate provider-result settlement'
  );
  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', p_processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'extraction_id', v_extraction_id,
    'evidence_sha256', v_evidence.evidence_sha256,
    'payload_sha256', v_payload ->> 'payload_sha256',
    'business_applied', true, 'access_mode', v_mode, 'idempotent', false
  );
end
$$;
revoke all on function public.complete_document_processing_job(
  uuid, uuid, text, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_document_processing_job(
  uuid, uuid, text, uuid, uuid, text
) to service_role;

create function public.fail_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_error_code text,
  p_error_message text default null,
  p_retryable boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_error_code text := lower(nullif(trim(p_error_code), ''));
  v_error_message text := nullif(left(trim(coalesce(p_error_message, '')), 1000), '');
  v_mode text;
  v_receipt jsonb;
  v_status text;
  v_business_applied boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200
     or v_error_code is null or v_error_code !~ '^[a-z0-9_:-]{1,100}$' then
    raise exception 'document_processing_failure_invalid' using errcode = '22023';
  end if;
  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  v_lease := private.document_processing_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, false, false
  );
  if v_lease.status = 'active' and (
    v_job.status <> 'leased' or v_job.lease_owner is distinct from v_owner
  ) then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  if v_lease.acknowledged_by is not null and v_lease.acknowledged_by is distinct from v_owner then
    raise exception 'document_processing_egress_lease_lost' using errcode = '40001';
  end if;

  perform 1 from public.organizations organization
  where organization.id = v_job.org_id for key share;
  v_mode := private.organization_access_mode(v_job.org_id);
  v_receipt := public.service_settle_organization_external_egress_evidence(
    v_lease.lease_id, p_egress_lease_token, 'failed', v_error_code, null,
    jsonb_build_object(
      'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
      'document_id', v_job.document_id, 'error_code', v_error_code,
      'error_message', v_error_message, 'retryable', coalesce(p_retryable, false)
    )
  );

  if v_mode in ('active', 'trial', 'grace') and v_job.status = 'leased'
     and v_job.lease_owner is not distinct from v_owner then
    if coalesce(p_retryable, false) then
      perform set_config('app.document_processing_retry_job', v_job.id::text, true);
      update public.document_processing_jobs
      set status = 'queued', lease_owner = null, lease_until = null,
          last_error_code = null, last_error_message = null
      where id = v_job.id;
      v_status := 'queued';
    else
      update public.document_processing_jobs
      set status = 'failed', lease_owner = null, lease_until = null,
          last_error_code = v_error_code, last_error_message = v_error_message
      where id = v_job.id;
      v_status := 'failed';
    end if;
    v_business_applied := true;
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_job.org_id, null,
      case when coalesce(p_retryable, false)
        then 'document_processing_retry_queued' else 'document_processing_failed' end,
      'document_processing_jobs', v_job.id,
      jsonb_build_object(
        'error_code', v_error_code, 'retryable', coalesce(p_retryable, false),
        'processing_attempt_id', v_job.processing_attempt_id,
        'egress_lease_id', v_lease.lease_id,
        'evidence_sha256', v_receipt ->> 'evidence_sha256'
      ), coalesce(v_error_message, v_error_code)
    );
  else
    v_status := v_job.status;
  end if;

  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'evidence_sha256', v_receipt ->> 'evidence_sha256',
    'job_status', v_status, 'retryable', coalesce(p_retryable, false),
    'business_applied', v_business_applied, 'access_mode', v_mode,
    'idempotent', (v_receipt ->> 'idempotent')::boolean
  );
end
$$;
revoke all on function public.fail_document_processing_job(
  uuid, text, uuid, uuid, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.fail_document_processing_job(
  uuid, text, uuid, uuid, text, text, boolean
) to service_role;

-- Expand/contract rollout bridge. The currently deployed worker used these three signatures
-- before attempt-bound egress was introduced. Keep them callable while DB-first -> Edge rollout
-- is in progress and for a worker that was already in flight when this migration committed.
-- They are deliberately refused as soon as the current attempt owns an egress lease, so a new
-- worker cannot downgrade an attempt from the evidence-first contract to the legacy contract.
create or replace function public.heartbeat_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_lease_seconds integer default 120
) returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  v_until timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= statement_timestamp() then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  if v_job.processing_attempt_id is not null and exists (
    select 1
    from private.organization_external_egress_leases lease
    where lease.org_id = v_job.org_id
      and lease.kind = 'document_signed_url'
      and lease.correlation_id = v_job.processing_attempt_id
  ) then
    raise exception 'document_processing_legacy_contract_forbidden' using errcode = '42501';
  end if;
  if not private.organization_write_allowed_fenced(v_job.org_id) then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  v_until := statement_timestamp() + make_interval(secs => v_seconds);
  update public.document_processing_jobs
  set lease_until = v_until
  where id = v_job.id;
  return v_until;
end
$$;
revoke all on function public.heartbeat_document_processing_job(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_document_processing_job(uuid, text, integer)
  to service_role;

create or replace function public.complete_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_engine text,
  p_model text,
  p_model_version text,
  p_input_checksum text,
  p_contract_version text,
  p_payload jsonb,
  p_duration_ms integer default null,
  p_resource_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_existing public.document_extractions;
  v_current_checksum text;
  v_extraction_id uuid;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_payload_sha256 text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200
     or nullif(trim(p_engine), '') is null or length(trim(p_engine)) > 100
     or nullif(trim(p_model), '') is null or length(trim(p_model)) > 200
     or nullif(trim(p_model_version), '') is null or length(trim(p_model_version)) > 200
     or p_duration_ms is not null and p_duration_ms < 0
     or p_resource_metadata is null or jsonb_typeof(p_resource_metadata) <> 'object'
     or p_payload is null or octet_length(p_payload::text) > 26214400
     or not public.smart_document_extraction_valid(p_payload, p_contract_version) then
    raise exception 'document_extraction_invalid' using errcode = '22023';
  end if;

  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.processing_attempt_id is not null and exists (
    select 1
    from private.organization_external_egress_leases lease
    where lease.org_id = v_job.org_id
      and lease.kind = 'document_signed_url'
      and lease.correlation_id = v_job.processing_attempt_id
  ) then
    raise exception 'document_processing_legacy_contract_forbidden' using errcode = '42501';
  end if;

  select * into v_existing
  from public.document_extractions extraction
  where extraction.org_id = v_job.org_id and extraction.job_id = v_job.id;
  if found then
    if v_existing.input_checksum is distinct from p_input_checksum
       or v_existing.contract_version is distinct from p_contract_version
       or v_existing.engine is distinct from trim(p_engine)
       or v_existing.model is distinct from trim(p_model)
       or v_existing.model_version is distinct from trim(p_model_version)
       or v_existing.payload is distinct from p_payload
       or v_existing.duration_ms is distinct from p_duration_ms
       or v_existing.resource_metadata is distinct from p_resource_metadata then
      raise exception 'document_extraction_conflict' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= statement_timestamp() then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  if not private.organization_write_allowed_fenced(v_job.org_id) then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  if p_input_checksum is distinct from v_job.input_checksum
     or p_contract_version is distinct from v_job.contract_version then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;
  select * into v_document
  from public.documents document
  where document.id = v_job.document_id
    and document.org_id = v_job.org_id
    and document.deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
  if v_current_checksum <> v_job.input_checksum then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;

  v_payload_sha256 := encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.document_extractions (
    org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload, duration_ms, resource_metadata
  ) values (
    v_job.org_id, v_job.id, v_job.document_id,
    trim(p_engine), trim(p_model), trim(p_model_version),
    p_input_checksum, p_contract_version, p_payload, p_duration_ms, p_resource_metadata
  ) returning id into v_extraction_id;
  update public.document_processing_jobs
  set status = 'extracted', lease_owner = null, lease_until = null,
      last_error_code = null, last_error_message = null
  where id = v_job.id;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_legacy_bridge_extracted',
    'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'extraction_id', v_extraction_id,
      'processing_attempt_id', v_job.processing_attempt_id,
      'payload_sha256', v_payload_sha256,
      'worker_contract', 'legacy_v1'
    ),
    'DB-first Edge rollout bridge completed a legacy OCR worker attempt'
  );
  return v_extraction_id;
end
$$;
revoke all on function public.complete_document_processing_job(
  uuid, text, text, text, text, text, text, jsonb, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_document_processing_job(
  uuid, text, text, text, text, text, text, jsonb, integer, jsonb
) to service_role;

create or replace function public.fail_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_error_code text,
  p_error_message text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_error_code text := lower(nullif(trim(p_error_code), ''));
  v_error_message text := nullif(left(trim(coalesce(p_error_message, '')), 1000), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200
     or v_error_code is null or v_error_code !~ '^[a-z0-9_:-]{1,100}$' then
    raise exception 'document_processing_failure_invalid' using errcode = '22023';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.processing_attempt_id is not null and exists (
    select 1
    from private.organization_external_egress_leases lease
    where lease.org_id = v_job.org_id
      and lease.kind = 'document_signed_url'
      and lease.correlation_id = v_job.processing_attempt_id
  ) then
    raise exception 'document_processing_legacy_contract_forbidden' using errcode = '42501';
  end if;
  if v_job.status = 'failed' and v_job.last_error_code = v_error_code then
    return v_job.id;
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= statement_timestamp() then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  update public.document_processing_jobs
  set status = 'failed', lease_owner = null, lease_until = null,
      last_error_code = v_error_code, last_error_message = v_error_message
  where id = v_job.id;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_legacy_bridge_failed',
    'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'error_code', v_error_code,
      'processing_attempt_id', v_job.processing_attempt_id,
      'worker_contract', 'legacy_v1'
    ), coalesce(v_error_message, v_error_code)
  );
  return v_job.id;
end
$$;
revoke all on function public.fail_document_processing_job(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_document_processing_job(uuid, text, text, text)
  to service_role;

comment on function public.heartbeat_document_processing_job(uuid, text, integer) is
  'Temporary expand-compatible legacy OCR worker bridge. Rejects attempts that entered attempt-bound egress.';
comment on function public.complete_document_processing_job(
  uuid, text, text, text, text, text, text, jsonb, integer, jsonb
) is
  'Temporary DB-first Edge rollout bridge. Service-only, audited and unavailable once the attempt has an egress lease.';
comment on function public.fail_document_processing_job(uuid, text, text, text) is
  'Temporary expand-compatible legacy OCR worker bridge. Service-only and unavailable once the attempt has an egress lease.';

-- Applies an already-committed OCR result without contacting the provider. Lease expiry is not a
-- reason to discard paid-for evidence, but the attempt must still be the job's current attempt and
-- the tenant must be writable. This is also the only guarded failed -> extracted transition.
create function public.service_recover_document_extraction_from_egress(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_evidence_lease_id uuid,
  p_evidence_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_evidence private.organization_external_egress_evidence;
  v_existing public.document_extractions;
  v_payload jsonb;
  v_current_checksum text;
  v_extraction_id uuid;
  v_mode text;
  v_recovered_from_failed boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_job_id is null or p_processing_attempt_id is null or p_evidence_lease_id is null
     or lower(coalesce(p_evidence_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'document_extraction_recovery_invalid' using errcode = '22023';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id
  for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  v_evidence := private.document_ocr_evidence_binding(
    v_job, p_processing_attempt_id, p_evidence_lease_id, p_evidence_sha256
  );
  v_payload := v_evidence.evidence;

  select * into v_existing
  from public.document_extractions extraction
  where extraction.org_id = v_job.org_id and extraction.job_id = v_job.id;
  if found then
    if v_existing.input_checksum is distinct from v_payload ->> 'input_checksum'
       or v_existing.contract_version is distinct from v_payload ->> 'contract_version'
       or v_existing.engine is distinct from trim(v_payload ->> 'engine')
       or v_existing.model is distinct from trim(v_payload ->> 'model')
       or v_existing.model_version is distinct from trim(v_payload ->> 'model_version')
       or v_existing.payload is distinct from v_payload -> 'extraction'
       or v_existing.duration_ms is distinct from (v_payload ->> 'duration_ms')::integer
       or v_existing.resource_metadata is distinct from v_payload -> 'resource_metadata' then
      raise exception 'document_extraction_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'job_id', v_job.id, 'processing_attempt_id', p_processing_attempt_id,
      'evidence_lease_id', v_evidence.lease_id, 'extraction_id', v_existing.id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'payload_sha256', v_payload ->> 'payload_sha256',
      'access_mode', private.organization_access_mode(v_job.org_id),
      'idempotent', true, 'recovered_from_failed', false
    );
  end if;

  perform 1 from public.organizations organization
  where organization.id = v_job.org_id for key share;
  v_mode := private.organization_access_mode(v_job.org_id);
  if v_mode not in ('active', 'trial', 'grace') then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  if v_job.processing_attempt_id is distinct from p_processing_attempt_id
     or v_job.status not in ('leased', 'failed') then
    raise exception 'document_extraction_recovery_attempt_invalid' using errcode = '55000';
  end if;

  select * into v_document
  from public.documents document
  where document.id = v_job.document_id
    and document.org_id = v_job.org_id
    and document.deleted_at is null;
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
  if v_current_checksum <> v_job.input_checksum then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;

  insert into public.document_extractions (
    org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload, duration_ms, resource_metadata
  ) values (
    v_job.org_id, v_job.id, v_job.document_id,
    trim(v_payload ->> 'engine'), trim(v_payload ->> 'model'),
    trim(v_payload ->> 'model_version'),
    v_payload ->> 'input_checksum', v_payload ->> 'contract_version',
    v_payload -> 'extraction', (v_payload ->> 'duration_ms')::integer,
    v_payload -> 'resource_metadata'
  ) returning id into v_extraction_id;

  v_recovered_from_failed := v_job.status = 'failed';
  if v_recovered_from_failed then
    perform set_config('app.document_extraction_recovery_job', v_job.id::text, true);
  end if;
  update public.document_processing_jobs
  set status = 'extracted', lease_owner = null, lease_until = null,
      last_error_code = null, last_error_message = null
  where id = v_job.id;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_extraction_recovered',
    'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'extraction_id', v_extraction_id,
      'processing_attempt_id', p_processing_attempt_id,
      'evidence_lease_id', v_evidence.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'payload_sha256', v_payload ->> 'payload_sha256',
      'recovered_from_failed', v_recovered_from_failed
    ), 'immutable OCR evidence recovered without a second provider request'
  );
  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', p_processing_attempt_id,
    'evidence_lease_id', v_evidence.lease_id, 'extraction_id', v_extraction_id,
    'evidence_sha256', v_evidence.evidence_sha256,
    'payload_sha256', v_payload ->> 'payload_sha256',
    'access_mode', v_mode, 'idempotent', false,
    'recovered_from_failed', v_recovered_from_failed
  );
end
$$;
revoke all on function public.service_recover_document_extraction_from_egress(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.service_recover_document_extraction_from_egress(
  uuid, uuid, uuid, text
) to service_role;

create function public.service_recover_document_interpretation_from_egress(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_evidence_lease_id uuid,
  p_evidence_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_extraction public.document_extractions;
  v_lease private.organization_external_egress_leases;
  v_evidence private.organization_external_egress_evidence;
  v_existing public.document_interpretations;
  v_role public.user_role;
  v_started_at timestamptz;
  v_duration_ms integer;
  v_provider_hash text;
  v_usage jsonb;
  v_interpretation_id uuid;
  v_recovered_from_failed boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_job_id is null or p_extraction_id is null or p_actor_id is null
     or p_evidence_lease_id is null
     or lower(coalesce(p_evidence_sha256, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'document_interpretation_recovery_invalid' using errcode = '22023';
  end if;

  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  select * into v_extraction
  from public.document_extractions extraction
  where extraction.org_id = v_job.org_id and extraction.id = p_extraction_id
    and extraction.job_id = v_job.id and extraction.document_id = v_job.document_id;
  if not found then raise exception 'document_extraction_unknown' using errcode = 'P0002'; end if;

  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_evidence_lease_id
  for update;
  select * into v_evidence
  from private.organization_external_egress_evidence evidence
  where evidence.lease_id = p_evidence_lease_id;
  if v_lease.lease_id is null or v_evidence.lease_id is null
     or v_lease.org_id is distinct from v_job.org_id
     or v_lease.kind <> 'document_interpretation'
     or v_lease.correlation_id is distinct from v_job.id
     or v_lease.status <> 'settled'
     or v_evidence.org_id is distinct from v_job.org_id
     or v_evidence.kind <> v_lease.kind
     or v_evidence.correlation_id is distinct from v_lease.correlation_id
     or v_evidence.outcome not in ('delivered', 'ambiguous')
     or v_evidence.evidence_sha256 is distinct from lower(p_evidence_sha256)
     or v_evidence.evidence ->> 'job_id' is distinct from v_job.id::text
     or v_evidence.evidence ->> 'extraction_id' is distinct from v_extraction.id::text
     or v_evidence.evidence ->> 'actor_id' is distinct from p_actor_id::text
     or nullif(trim(v_evidence.evidence ->> 'provider'), '') is null
     or nullif(trim(v_evidence.evidence ->> 'model'), '') is null
     or nullif(trim(v_evidence.evidence ->> 'prompt_version'), '') is null
     or v_evidence.evidence ->> 'schema_version' is distinct from '1'
     or jsonb_typeof(v_evidence.evidence -> 'usage') <> 'object'
     or jsonb_typeof(v_evidence.evidence -> 'interpretation') <> 'object'
     or coalesce(v_evidence.evidence ->> 'duration_ms', '') !~ '^[0-9]+$' then
    raise exception 'document_interpretation_recovery_evidence_mismatch' using errcode = '42501';
  end if;

  begin
    v_started_at := (v_evidence.evidence ->> 'interpretation_started_at')::timestamptz;
    v_duration_ms := (v_evidence.evidence ->> 'duration_ms')::integer;
  exception when others then
    raise exception 'document_interpretation_recovery_evidence_mismatch' using errcode = '42501';
  end;
  if v_job.interpretation_actor_id is distinct from p_actor_id
     or v_job.interpretation_started_at is distinct from v_started_at then
    raise exception 'document_interpretation_recovery_attempt_mismatch' using errcode = '55000';
  end if;
  v_provider_hash := encode(digest(
    convert_to((v_evidence.evidence -> 'interpretation')::text, 'UTF8'), 'sha256'
  ), 'hex');
  if v_evidence.evidence ->> 'provider_result_sha256' is distinct from v_provider_hash then
    raise exception 'document_interpretation_recovery_hash_mismatch' using errcode = '42501';
  end if;
  v_usage := (v_evidence.evidence -> 'usage') || jsonb_strip_nulls(jsonb_build_object(
    'provider_request_id', v_evidence.evidence -> 'provider_request_id',
    'provider_result_sha256', v_provider_hash,
    'input_truncation', v_evidence.evidence -> 'input_truncation'
  ));

  select * into v_existing
  from public.document_interpretations interpretation
  where interpretation.org_id = v_job.org_id and interpretation.job_id = v_job.id;
  if found then
    if v_existing.extraction_id is distinct from v_extraction.id
       or v_existing.interpreted_for_user_id is distinct from p_actor_id
       or v_existing.provider is distinct from trim(v_evidence.evidence ->> 'provider')
       or v_existing.model is distinct from trim(v_evidence.evidence ->> 'model')
       or v_existing.prompt_version is distinct from trim(v_evidence.evidence ->> 'prompt_version')
       or v_existing.schema_version is distinct from '1'
       or v_existing.payload is distinct from v_evidence.evidence -> 'interpretation'
       or v_existing.usage is distinct from v_usage
       or v_existing.duration_ms is distinct from v_duration_ms then
      raise exception 'document_interpretation_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'interpretation_id', v_existing.id, 'job_id', v_job.id,
      'evidence_lease_id', v_evidence.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'provider_result_sha256', v_provider_hash,
      'idempotent', true, 'recovered_from_failed', false
    );
  end if;

  perform 1 from public.organizations organization
  where organization.id = v_job.org_id for key share;
  if private.organization_access_mode(v_job.org_id) not in ('active', 'trial', 'grace') then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  if v_job.status = 'failed' then
    v_recovered_from_failed := true;
    perform set_config('app.document_interpretation_recovery_job', v_job.id::text, true);
    update public.document_processing_jobs
    set status = 'interpreting', last_error_code = null, last_error_message = null
    where id = v_job.id;
  elsif v_job.status <> 'interpreting' then
    raise exception 'document_interpretation_status_invalid' using errcode = '55000';
  end if;

  select profile.role into v_role
  from public.profiles profile
  where profile.org_id = v_job.org_id and profile.id = p_actor_id and profile.active;
  if v_role = 'supplier' then
    v_interpretation_id := public.save_supplier_price_interpretation(
      v_job.id, v_extraction.id, p_actor_id, v_started_at,
      trim(v_evidence.evidence ->> 'provider'), trim(v_evidence.evidence ->> 'model'),
      trim(v_evidence.evidence ->> 'prompt_version'), '1',
      v_evidence.evidence -> 'interpretation', v_usage, v_duration_ms
    );
  else
    v_interpretation_id := public.save_document_interpretation(
      v_job.id, v_extraction.id, p_actor_id, v_started_at,
      trim(v_evidence.evidence ->> 'provider'), trim(v_evidence.evidence ->> 'model'),
      trim(v_evidence.evidence ->> 'prompt_version'), '1',
      v_evidence.evidence -> 'interpretation', v_usage, v_duration_ms
    );
  end if;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_interpretation_recovered',
    'document_interpretations', v_interpretation_id,
    jsonb_build_object(
      'job_id', v_job.id, 'evidence_lease_id', v_evidence.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'provider_result_sha256', v_provider_hash,
      'recovered_from_failed', v_recovered_from_failed
    ), 'immutable provider evidence recovered without a second provider request'
  );
  return jsonb_build_object(
    'interpretation_id', v_interpretation_id, 'job_id', v_job.id,
    'evidence_lease_id', v_evidence.lease_id,
    'evidence_sha256', v_evidence.evidence_sha256,
    'provider_result_sha256', v_provider_hash,
    'idempotent', false, 'recovered_from_failed', v_recovered_from_failed
  );
end
$$;
revoke all on function public.service_recover_document_interpretation_from_egress(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.service_recover_document_interpretation_from_egress(
  uuid, uuid, uuid, uuid, text
) to service_role;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values
  (
    'public.service_record_document_ocr_evidence(uuid,uuid,text,uuid,uuid,text,text,text,text,text,jsonb,integer,jsonb)'::regprocedure::text,
    'actor: service_role OCR worker only; tenant: job, explicit attempt and exact acknowledged signed-url lease derive one org; scope: evidence-only command cannot mutate public business state; tables: private egress lease and immutable evidence; reason: provider output must commit independently before extraction apply so later rollback cannot erase recovery proof; audit: canonical evidence retains org, job, attempt, source, contract and payload hashes; proof: browser execute revoked, token, owner, lease correlation and source contract checks fail closed.',
    'OCR immutable evidence split'
  ),
  (
    'public.complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)'::regprocedure::text,
    'actor: service_role OCR worker only; tenant: job, current processing attempt and exact immutable signed-url evidence derive one org; scope: worker has no user unit scopes and cannot choose a tenant outside that locked chain; tables: documents, processing jobs and immutable extraction; reason: applies only a separately committed provider result at the server-authoritative extraction boundary; audit: extraction completion records attempt, lease, evidence and payload hashes; proof: browser execute revoked, exact token, correlation, owner, evidence hash, source and lifecycle fences fail closed.',
    'OCR attempt-bound egress'
  ),
  (
    'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)'::regprocedure::text,
    'actor: service_role recovery path only; tenant: immutable evidence, lease, job and attempt must share one org; scope: no user unit scope is accepted and no provider call occurs; tables: documents, processing jobs, immutable extraction and audit; reason: committed OCR evidence must survive apply crash, lifecycle flip, expired lease or failed job without a second billable OCR request; audit: recovery records attempt plus evidence and payload hashes; proof: browser execute revoked, current-attempt, canonical hash, source checksum and writable lifecycle checks fail closed.',
    'OCR extraction recovery'
  ),
  (
    'public.service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)'::regprocedure::text,
    'actor: service_role interpretation worker only; tenant: immutable evidence, lease, job, extraction and actor must share one org; scope: no caller-supplied unit scope can widen the exact document chain; tables: immutable egress evidence and document interpretation review records; reason: recovery must atomically consume canonical provider evidence without a second network call; audit: recovery records evidence and provider-result hashes; proof: browser execute revoked, exact evidence hash and relationship checks fail closed.',
    'document interpretation recovery'
  );

-- Cross-wave ACL reconciliation. 0025 deliberately moved supplier agents onto the narrow
-- supplier_portal_context() projection because public.suppliers also contains internal notes and
-- bank details. 0104 rebuilt this policy for the accountant projection and accidentally restored
-- the older direct supplier branch. Keep procurement staff and the existing payer obligation read,
-- while supplier agents continue through the explicit portal projection only.
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated using (
  org_id = public.auth_org() and (
    public.auth_role() in ('owner', 'office', 'kitchen')
    or (public.auth_role() = 'payer' and exists (
      select 1 from public.payment_requests request
      where request.org_id = suppliers.org_id
        and request.supplier_id = suppliers.id
        and request.status in ('approved', 'sent_for_execution', 'executed', 'matched')
    ))
  )
);

-- The three adapter tables were created by 0066 after 0039's one-time trusted-server grant.
-- Shape-2 tables retain zero browser table access, and all three retain the project's full
-- service-role CRUD contract for managed adapters. Browser access remains exactly as 0066 defined:
-- webhook/failure rows only through narrow definers, external references SELECT-only for owners.
revoke all on table public.webhook_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table
  public.webhook_subscriptions,
  public.external_references,
  public.integration_failures
to service_role;

do $$
declare
  v_supplier_policy text;
  v_violations text;
begin
  select pg_get_expr(policy.polqual, policy.polrelid)
  into v_supplier_policy
  from pg_catalog.pg_policy policy
  where policy.polrelid = 'public.suppliers'::regclass
    and policy.polname = 'suppliers_select';
  if v_supplier_policy is null
     or v_supplier_policy ~* 'auth_role\(\).*''supplier'''
     or position('auth_supplier()' in v_supplier_policy) > 0 then
    raise exception
      '0111 supplier raw-row assertion failed: supplier agents must use supplier_portal_context()';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0111 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
