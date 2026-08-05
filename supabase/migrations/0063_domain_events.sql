-- 0063 -- Domain events: envelope, causation, and the audit fan-out (PLAN-05, ADR-0009).
--
-- Emission architecture (ADR-0009): existing commands are NOT edited. Eight live command
-- bodies exist only in pg_proc (the 0031 dynamic persona rewrites + the 0061 dynamic
-- step-up injections, one overlap) -- injecting an event write into each is nine
-- silent-revert mines. The audit row already IS the intent (action + reason + old/new +
-- actor + correlation), so a fan-out trigger on audit_logs turns it into a domain event
-- through an allowlist map. The forward rule of ADR-0005 stands: a NEW command emits its
-- event inline; the fan-out is the retrofit mechanism.
--
-- audit_logs is classified cross_scope / enforced=false (0054), so a trigger on it does
-- not enter A5's trigger arm. The fan-out function body is deliberately word-clean of all
-- six enforced table names (A5 matches prosrc by word boundary, comments included): the
-- entity-name knowledge lives in private.domain_event_map DATA, never in the function.

-- ===== 1. Causation: the second lineage arm (the 0062 DEFAULT mechanism) =====
-- A trusted context that acts BECAUSE of an earlier event stamps
-- set_config('app.causation_id', <uuid>, true); a root has no cause and records NULL.
-- Same shape as public.request_correlation_id(): STABLE, invoker rights, fail-to-NULL.
create function public.request_causation_id()
returns uuid
language plpgsql
stable
set search_path = public
as $$
begin
  return nullif(current_setting('app.causation_id', true), '')::uuid;
exception when others then
  return null;
end
$$;

comment on function public.request_causation_id() is
  'Causation id of the current unit of work: the app.causation_id GUC, minted by a trusted '
  'server context that acts because of an earlier event. Fails to NULL on any malformed '
  'value; never raises. A root action has no cause.';

-- The 0020:228 idiom, exactly as 0062: revoke the browser-facing roles but KEEP
-- service_role's default grant -- the gate inserts audit rows directly as service_role
-- and a column DEFAULT is evaluated with the inserter's privileges.
revoke all on function public.request_causation_id() from public, anon, authenticated;

-- Two separate statements, the 0062 pattern: pure catalog change, then a DEFAULT that
-- applies to future inserts only -- no rewrite of the largest audit table.
alter table public.audit_logs add column causation_id uuid;
alter table public.audit_logs
  alter column causation_id set default public.request_causation_id();

create index audit_logs_causation_idx
  on public.audit_logs (causation_id)
  where causation_id is not null;

comment on column public.audit_logs.causation_id is
  'Id of the event/action this write happened BECAUSE of, filled by the column DEFAULT '
  '(public.request_causation_id from the app.causation_id GUC). NULL means a root action '
  'or a write that predates 0063. No writer names this column, so the DEFAULT covers '
  'every path without editing any function (the 0062 mechanism).';

-- ===== 2. The envelope =====
create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  -- Insertion order for consumers. Writers never name it; identity keeps it dense enough
  -- and the unique constraint makes the ordering claim structural.
  sequence bigint generated always as identity,
  event_type text not null check (btrim(event_type) <> ''),
  -- Integer schema version PER event type (OPEN-DECISIONS #92): bump when the payload
  -- contract for that type changes.
  schema_version integer not null default 1 check (schema_version >= 1),
  org_id uuid not null references organizations(id),
  -- Scope reference, nullable (OPEN-DECISIONS #84: NULL = org-visible). The composite FK
  -- makes a cross-tenant unit pointer structurally impossible.
  unit_id uuid,
  entity_type text not null,
  entity_id uuid,
  -- Forensic, no FK: an event survives profile deletion (the security_events precedent).
  actor_id uuid,
  -- NOT NULL is sound ONLY because no writer names the column: the DEFAULT either
  -- inherits the request id (GUC wins over header, the 0062 order) or mints a fresh root.
  -- correlation_source keeps the two honest -- without it NOT NULL would launder
  -- "unknown origin" into "known origin".
  correlation_id uuid not null
    default coalesce(public.request_correlation_id(), gen_random_uuid()),
  correlation_source text not null
    default (case when public.request_correlation_id() is not null
             then 'inherited' else 'minted' end)
    check (correlation_source in ('inherited', 'minted')),
  causation_id uuid default public.request_causation_id(),
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, unit_id) references org_units (org_id, id),
  unique (sequence)
);

create index domain_events_org_sequence_idx on public.domain_events (org_id, sequence);
create index domain_events_type_idx on public.domain_events (event_type);
create index domain_events_correlation_idx on public.domain_events (correlation_id);
create index domain_events_entity_idx on public.domain_events (entity_type, entity_id)
  where entity_id is not null;

comment on table public.domain_events is
  'Versioned business events (INTEGRATION-ARCHITECTURE.md SS2). Born either inline in a '
  'new command (ADR-0005 forward rule) or through the audit fan-out map (ADR-0009 '
  'retrofit). Payload carries only the keys the map row projects; the full change stays '
  'in audit_logs.';

-- Reads: owner-in-tenant only, for the future integrations screen. Writes are
-- server-only: the fan-out definer trigger (function owner) and service_role bypass RLS;
-- no INSERT/UPDATE/DELETE policy exists for browser roles and the table ACL drops their
-- write bits entirely.
alter table public.domain_events enable row level security;

create policy domain_events_owner_read on public.domain_events
  for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');

revoke all on table public.domain_events from anon, authenticated;
grant select on table public.domain_events to authenticated;

-- ===== 3. The event map -- the allowlist contract, in data =====
-- Dual necessity (PLAN-05 SS1.2): the payload contract lives in ONE reviewable place, and
-- the fan-out function stays word-clean of enforced table names because the names are
-- rows here, not tokens in a function body. An (action, entity_type) pair with no row
-- emits NOTHING -- which also contains generic service_role audit writes.
create table private.domain_event_map (
  action text not null,
  entity_type text not null,
  event_type text not null,
  schema_version integer not null default 1 check (schema_version >= 1),
  -- Optional transition discriminator: jsonb containment against the audit row's
  -- new_values (e.g. {"status":"sent"}). NULL = the action alone decides.
  match_new jsonb,
  -- The ONLY new_values keys copied into the event payload. An allowlist, never the full
  -- row: trigger-authored audit rows carry entire row images and must not leak (e.g.
  -- supplier bank details stay in the audit trail).
  payload_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (action, entity_type, event_type)
);

revoke all on table private.domain_event_map from public, anon, authenticated;

comment on table private.domain_event_map is
  'Audit action -> domain event allowlist (ADR-0009). Derivation: the 22 event names of '
  'INTEGRATION-ARCHITECTURE.md SS2 + month_export.sent + supplier.bank_details_changed, '
  'mapped onto the live audit action literals. Naming choices with no exact live '
  'counterpart are OPEN-DECISIONS #94. Changing a payload contract = edit the row AND '
  'bump schema_version.';

insert into private.domain_event_map
  (action, entity_type, event_type, schema_version, match_new, payload_keys)
values
  -- Catalog (audit_row_change trigger rows carry full row images; project narrowly).
  ('insert', 'suppliers', 'supplier.created', 1, null,
   array['name', 'status']),
  ('update', 'suppliers', 'supplier.updated', 1, null,
   array['name', 'status', 'deleted_at']),
  -- Signal-only on purpose: bank details never leave the audit trail (0061 command).
  ('supplier_bank_details_changed', 'suppliers', 'supplier.bank_details_changed', 1, null,
   array[]::text[]),
  ('insert', 'products', 'product.created', 1, null,
   array['name', 'unit', 'category_id', 'active']),
  -- Prices.
  ('supplier_product_price_set', 'supplier_products', 'supplier_price.updated', 1, null,
   array['price', 'effective_date', 'available', 'price_changed']),
  ('supplier_price_submission_processed', 'supplier_price_submissions',
   'supplier_price_list.submitted', 1, null,
   array['supplier_id', 'target_month', 'revision', 'status',
         'accepted_count', 'rejected_count', 'unchanged_count']),
  -- Procurement. Live po_status has no 'approved': 'ready' IS the approval step
  -- (draft -> ready gate, 0053) -- documented in OPEN-DECISIONS #94.
  ('insert', 'purchase_orders', 'purchase_order.created', 1, null,
   array['number', 'supplier_id', 'status', 'expected_date']),
  ('purchase_order_status_changed', 'purchase_orders', 'purchase_order.approved', 1,
   '{"status": "ready"}'::jsonb, array['status', 'expected_date']),
  ('purchase_order_status_changed', 'purchase_orders', 'purchase_order.sent', 1,
   '{"status": "sent"}'::jsonb, array['status', 'sent_at']),
  ('goods_receipt_completed', 'goods_receipts', 'goods_receipt.completed', 1, null,
   array['status', 'order_status', 'credit_count', 'open_credits']),
  -- Invoices. Both creation arms of create_invoice map to invoice.created; the live
  -- "requires review" state is 'investigation' (create_invoice flags suspected
  -- duplicates into it) -- OPEN-DECISIONS #94.
  ('invoice_created', 'invoices', 'invoice.created', 1, null,
   array['supplier_id', 'invoice_number', 'total_amount', 'review_status',
         'duplicate_detected']),
  ('invoice_duplicate_overridden', 'invoices', 'invoice.created', 1, null,
   array['supplier_id', 'invoice_number', 'total_amount', 'review_status',
         'duplicate_detected', 'override_reason']),
  ('invoice_review_status_changed', 'invoices', 'invoice.review_required', 1,
   '{"review_status": "investigation"}'::jsonb, array['review_status']),
  ('invoice_review_status_changed', 'invoices', 'invoice.approved', 1,
   '{"review_status": "approved"}'::jsonb, array['review_status']),
  ('invoice_credit_requested', 'credit_requests', 'credit.created', 1, null,
   array['invoice_id', 'supplier_id', 'credit_reason', 'amount', 'status']),
  -- Payment lifecycle. Both execution literals of the live execute_payment_request body
  -- (regular + emergency, a 0031-rewritten catalog-only body) map to payment.executed.
  ('payment_request_created', 'payment_requests', 'payment_request.created', 1, null,
   array['status', 'amount', 'invoice_count']),
  ('payment_request_transitioned', 'payment_requests', 'payment_request.approved', 1,
   '{"status": "approved"}'::jsonb, array['status']),
  ('payment_request_executed', 'payment_requests', 'payment.executed', 1, null,
   array['status', 'payment_id', 'amount', 'reference', 'emergency']),
  ('payment_request_emergency_executed', 'payment_requests', 'payment.executed', 1, null,
   array['status', 'payment_id', 'amount', 'reference', 'emergency']),
  -- Bank.
  ('bank_import_created', 'bank_imports', 'bank_transaction.imported', 1, null,
   array['file_hash', 'row_count']),
  ('bank_match_confirmed', 'bank_transactions', 'reconciliation.completed', 1, null,
   array['status', 'supplier_id', 'payment_id', 'confidence']),
  -- Documents.
  ('insert', 'documents', 'document.uploaded', 1, null,
   array['entity_type', 'entity_id', 'file_name', 'mime_type', 'kind',
         'supplier_id', 'document_date']),
  ('document_processing_extracted', 'document_processing_jobs',
   'document.processing_completed', 1, null,
   array['extraction_id', 'engine', 'model']),
  ('document_processing_failed', 'document_processing_jobs',
   'document.processing_failed', 1, null,
   array['error_code']),
  -- Identity & export.
  ('profile_access_changed', 'profiles', 'user.access_changed', 1, null,
   array['role', 'active', 'supplier_id']),
  ('month_export_sent', 'monthly_exports', 'month_export.sent', 1, null,
   array['status', 'month', 'invoice_count']);

-- ===== 4. The fan-out =====
-- SECURITY DEFINER: the trigger fires under whichever role authored the audit row
-- (definer commands, the generic audit trigger, or service_role directly) and must
-- always be able to write the event row. The body is word-clean by construction: it
-- speaks only of audit columns and the map -- every entity name is data.
create function private.emit_domain_events_from_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Rows without a tenant (platform bookkeeping probes) can never carry a tenant event.
  if new.org_id is null then
    return null;
  end if;

  insert into public.domain_events (
    event_type, schema_version, org_id, unit_id, entity_type, entity_id,
    actor_id, occurred_at, payload, metadata
  )
  select
    m.event_type,
    m.schema_version,
    new.org_id,
    -- Trigger-authored audit rows carry the full row image, so a scope reference is
    -- available when the source table has one; curated command rows simply lack the key.
    -- Fail-to-NULL on any non-uuid shape -- a malformed value must never abort the
    -- audited business write this trigger rides on.
    case
      when (coalesce(new.new_values, '{}'::jsonb) ->> 'unit_id')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (new.new_values ->> 'unit_id')::uuid
    end,
    new.entity_type,
    new.entity_id,
    new.user_id,
    new.created_at,
    coalesce(
      (select jsonb_object_agg(k.key, coalesce(new.new_values, '{}'::jsonb) -> k.key)
       from unnest(m.payload_keys) as k(key)
       where coalesce(new.new_values, '{}'::jsonb) ? k.key),
      '{}'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'audit_log_id', new.id,
      'audit_action', new.action,
      'reason', new.reason))
  from private.domain_event_map m
  where m.action = new.action
    and m.entity_type = new.entity_type
    and (m.match_new is null
         or coalesce(new.new_values, '{}'::jsonb) @> m.match_new);

  return null;
end
$$;

revoke all on function private.emit_domain_events_from_audit()
  from public, anon, authenticated;

create trigger audit_logs_domain_event_fanout
  after insert on public.audit_logs
  for each row execute function private.emit_domain_events_from_audit();

-- ===== 5. Audit completion: the three uncovered paths =====
-- products and categories carried no audit trigger at all (measured in the campaign
-- audit); they take the standard generic trigger. The LATEST audit_row_change
-- declaration is 0059:101 (the is_platform_admin escape) -- attached alongside here,
-- never redeclared.
create trigger products_audit
  after insert or update or delete on public.products
  for each row execute function audit_row_change();

create trigger categories_audit
  after insert or update or delete on public.categories
  for each row execute function audit_row_change();

-- organizations cannot take audit_row_change: it has no org_id column and the generic
-- trigger asserts one (0009:184 pins that failure). A bespoke trigger supplies
-- org_id := the organization's own id -- closing the OPEN-DECISIONS #86 hole
-- (organizations.settings was rejected as a flag store precisely because organizations
-- writes were unaudited). Record, not reject: authorization for organizations writes is
-- already enforced upstream (RLS strips platform-controlled fields, lifecycle goes
-- through its reasoned command), and signup inserts happen before the author has a
-- profile, so an org-mismatch rejection here would break provisioning.
create function private.audit_organizations_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id,
                          old_values, new_values)
  values (
    v_org,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_org,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function private.audit_organizations_change()
  from public, anon, authenticated;

create trigger organizations_audit
  after insert or update or delete on public.organizations
  for each row execute function private.audit_organizations_change();

-- ===== 6. Registry (A1) + re-assert =====
-- cross_scope: unit_id is a filter reference, never ownership; the owner-read policy
-- already pins tenancy, and enforcement (a rider) is for business rows, not event copies.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('domain_events', 'cross_scope', false);

-- Re-run the 0057 assertions (the 0058:207-218 idiom): proves the registry row is
-- present, the fan-out function tripped neither A5 arm, and no rider/registry/definer
-- contract regressed inside this migration.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0063 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
