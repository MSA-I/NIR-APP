-- Wave 4 of Customer Operations (owner decision 19.08.2026) -- the first limit that actually
-- refuses something, and the counters it is measured against.
--
-- Shape: events and counters both live in `private`. Raw usage events are metering exhaust, not
-- tenant business data: nobody reads them from a browser, they carry no content, and putting them
-- in `public` would buy an export-registry row and a write-guard trigger for rows no tenant will
-- ever ask for. The tenant reads its own usage through organization_usage_snapshot(), and the
-- operator through platform_org_usage(); both are scoped functions, not table access.
--
-- IDEMPOTENCY IS IN THE PRIMARY KEY, not in application logic. (org_id, metric_key,
-- idempotency_key) is the key, the counter is incremented only when an event row was actually
-- inserted, and both happen in the caller's transaction. A retried enqueue, a replayed worker
-- completion, and a double-clicked upload therefore all count once -- which matters because the
-- number they move is the one that later refuses a customer's work.
--
-- THE BILLING PERIOD, and what happens when there is not one. A per-period counter needs a window
-- to reset against. It comes from organization_subscriptions.current_period_start/end when the
-- provider has given us one and now() falls inside it. Otherwise it is the calendar month in
-- Asia/Jerusalem, and the read models return `period_source` so a reader can see which definition
-- produced the number rather than assuming. Same discipline as `net_definition` in 0113.
--
-- WHAT IS ENFORCED, AND WHERE. One limit: `documents.monthly`, at
-- public.enqueue_document_processing (0136:462) -- the single door into the processing pipeline,
-- and already idempotent, so a counter bound to it cannot count one document twice. The check
-- happens only on the path that creates a NEW job, inside the same transaction, after locking the
-- counter row, so two concurrent uploads cannot both pass a limit that admits one.
--
-- An unstated limit REFUSES. `measured: false` from effective_entitlement() means nobody has said
-- what this customer may process, and treating that as infinite is the exact failure mode this
-- layer exists to prevent when the thing being counted costs money per page. Today every seeded
-- plan is `unlimited`, so nothing is refused; the refusal path is live, tested, and waiting for
-- the numbers (OPEN-DECISIONS #166).
--
-- WHAT IS COUNTED BUT NOT ENFORCED: `ocr_pages.monthly`. The page count is only known AFTER
-- extraction (0045:284 reads it out of the payload), so there is no honest way to refuse a job on
-- pages before running it. Pages are therefore recorded from an AFTER INSERT trigger on
-- document_extractions, keyed by job id, and reported to the operator. Enforcing them needs a
-- pre-flight page count, which is a separate piece of work and is registered as debt rather than
-- implied here.
--
-- What this deliberately does not cover: no limit on users, suppliers or storage -- their
-- entitlements exist and resolve, but nothing counts them yet, and the read models say `measured:
-- false` rather than reporting a zero. No downgrade behaviour (OPEN-DECISIONS #169). No blocking
-- of reads: a customer at their limit keeps every document, invoice and report they already have.

-- ===== 1. Events and counters =====
-- 0154 gave the definitions a `(entitlement_key, kind)` unique so plan rows could carry `kind`
-- under a composite foreign key. The events table needs the same trick on `measure`, so the
-- database -- not a comment -- refuses an event row against a running total.
alter table private.entitlement_definitions
  add constraint entitlement_definitions_key_measure_key unique (entitlement_key, measure);

create table private.usage_events (
  org_id          uuid not null references organizations(id) on delete restrict,
  metric_key      text not null,
  -- Carried so the composite foreign key can prove, in the database, that only a per-period
  -- entitlement is ever counted by events. A running total like `suppliers.max` is a query, not
  -- a stream, and an event row against it would be a category error.
  measure         text not null default 'per_period' check (measure = 'per_period'),
  quantity        numeric not null check (quantity > 0),
  occurred_at     timestamptz not null default now(),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  source          text not null check (length(btrim(source)) > 0),
  correlation_id  uuid,
  created_at      timestamptz not null default statement_timestamp(),
  primary key (org_id, metric_key, idempotency_key),
  constraint usage_events_metric_fk foreign key (metric_key, measure)
    references private.entitlement_definitions(entitlement_key, measure) on delete restrict
);
revoke all on table private.usage_events from public, anon, authenticated, service_role;
create index usage_events_org_metric_idx on private.usage_events (org_id, metric_key, occurred_at);

create table private.usage_counters (
  org_id       uuid not null references organizations(id) on delete restrict,
  metric_key   text not null,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  quantity     numeric not null default 0 check (quantity >= 0),
  updated_at   timestamptz not null default now(),
  primary key (org_id, metric_key, period_start),
  constraint usage_counters_period_order check (period_end > period_start)
);
revoke all on table private.usage_counters from public, anon, authenticated, service_role;

comment on table private.usage_events is
  'Metering exhaust (0155). The primary key IS the idempotency guarantee: a retry, a replay and a '
  'double-click all land on the same row and move the counter once.';

-- ===== 2. The billing period =====
create or replace function private.usage_period(p_org_id uuid)
returns table (period_start timestamptz, period_end timestamptz, period_source text)
language sql stable security definer set search_path = public as $$
  select coalesce(subscription.current_period_start, calendar.month_start),
         coalesce(subscription.current_period_end, calendar.month_end),
         case when subscription.current_period_start is not null
               and subscription.current_period_end is not null
               and now() >= subscription.current_period_start
               and now() < subscription.current_period_end
              then 'subscription' else 'calendar_month' end
  from (
    select date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem'
             as month_start,
           (date_trunc('month', now() at time zone 'Asia/Jerusalem') + interval '1 month')
             at time zone 'Asia/Jerusalem' as month_end
  ) calendar
  left join lateral (
    select current_period_start, current_period_end
    from organization_subscriptions
    where org_id = p_org_id
      and current_period_start is not null and current_period_end is not null
      and now() >= current_period_start and now() < current_period_end
  ) subscription on true
$$;
revoke all on function private.usage_period(uuid) from public, anon, authenticated;

-- Creates the current period's counter row if it does not exist and returns it LOCKED, so a limit
-- check and the increment that follows it are serialized against a concurrent caller. Without the
-- lock two uploads arriving together both read "one below the limit" and both proceed.
create or replace function private.usage_counter_locked(p_org_id uuid, p_metric_key text)
returns private.usage_counters
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_period record;
  v_counter private.usage_counters;
begin
  select * into v_period from private.usage_period(p_org_id);

  insert into private.usage_counters (org_id, metric_key, period_start, period_end)
  values (p_org_id, p_metric_key, v_period.period_start, v_period.period_end)
  on conflict (org_id, metric_key, period_start) do nothing;

  select * into v_counter from private.usage_counters
  where org_id = p_org_id and metric_key = p_metric_key
    and period_start = v_period.period_start
  for update;
  return v_counter;
end
$$;
revoke all on function private.usage_counter_locked(uuid, text) from public, anon, authenticated;

-- ===== 3. Recording =====
create or replace function private.record_usage_event(
  p_org_id          uuid,
  p_metric_key      text,
  p_quantity        numeric,
  p_idempotency_key text,
  p_source          text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_counter private.usage_counters;
  v_inserted integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'usage_quantity_invalid' using errcode = '22023';
  end if;

  -- Lock first, insert second: the counter row is the serialization point, and taking it before
  -- the event keeps this function's lock order identical to the enforcement path's.
  v_counter := private.usage_counter_locked(p_org_id, p_metric_key);

  insert into private.usage_events (
    org_id, metric_key, quantity, idempotency_key, source, correlation_id
  ) values (
    p_org_id, p_metric_key, p_quantity, p_idempotency_key, p_source,
    public.request_correlation_id()
  ) on conflict (org_id, metric_key, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Already counted. Saying so beats returning success indistinguishable from a first write.
    return jsonb_build_object('recorded', false, 'idempotent', true,
                              'quantity', v_counter.quantity);
  end if;

  update private.usage_counters
     set quantity = quantity + p_quantity, updated_at = now()
   where org_id = p_org_id and metric_key = p_metric_key
     and period_start = v_counter.period_start
  returning quantity into v_counter.quantity;

  return jsonb_build_object('recorded', true, 'idempotent', false,
                            'quantity', v_counter.quantity);
end
$$;
revoke all on function private.record_usage_event(uuid, text, numeric, text, text)
  from public, anon, authenticated;

-- ===== 4. The limit check =====
-- Returns nothing and raises on refusal, so a caller cannot accidentally ignore the answer by
-- forgetting to read a boolean.
create or replace function private.assert_usage_within_limit(
  p_org_id uuid, p_metric_key text, p_current numeric, p_increment numeric
) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_entitlement jsonb := public.effective_entitlement(p_org_id, p_metric_key);
begin
  if v_entitlement is null or not coalesce((v_entitlement ->> 'measured')::boolean, false) then
    -- Nobody has stated what this customer may use. Treating that as infinite is the failure this
    -- layer exists to prevent; the operator sets a limit, or sets unlimited, deliberately.
    raise exception 'plan_limit_unknown' using errcode = 'P0001';
  end if;
  if coalesce((v_entitlement ->> 'unlimited')::boolean, false) then
    return;
  end if;
  if coalesce(p_current, 0) + coalesce(p_increment, 0) > (v_entitlement ->> 'limit')::numeric then
    raise exception 'plan_limit_reached' using errcode = 'P0001';
  end if;
end
$$;
revoke all on function private.assert_usage_within_limit(uuid, text, numeric, numeric)
  from public, anon, authenticated;

-- ===== 5. OCR pages: counted, not enforced =====
-- A page count only exists after extraction, so there is no honest pre-flight refusal. The trigger
-- keys on job id, so a replayed completion moves the counter once.
create or replace function private.record_extraction_pages() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pages numeric := nullif(new.payload -> 'document' ->> 'page_count', '')::numeric;
begin
  if v_pages is not null and v_pages > 0 then
    perform private.record_usage_event(
      new.org_id, 'ocr_pages.monthly', v_pages, new.job_id::text, 'document_extraction');
  end if;
  return new;
end
$$;
revoke all on function private.record_extraction_pages() from public, anon, authenticated;

create trigger zzz_record_extraction_pages
  after insert on public.document_extractions
  for each row execute function private.record_extraction_pages();

-- ===== 6. Read models =====
-- Every entitlement appears, measured or not. A metric nothing counts reports `measured: false`
-- and a null usage, never a zero -- a zero would claim the customer has used none of it, which is
-- a statement about their behaviour rather than about our instrumentation.
create or replace function private.usage_rows(p_org_id uuid)
returns table (
  metric_key text, label text, unit text, measure text,
  used numeric, usage_limit numeric, unlimited boolean, measured boolean,
  remaining numeric, percent_used numeric,
  period_start timestamptz, period_end timestamptz, period_source text
)
language sql stable security definer set search_path = public as $$
  select definition.entitlement_key,
         definition.label,
         definition.unit,
         definition.measure,
         case when definition.measure = 'per_period' then coalesce(counter.quantity, 0) end,
         (entitlement ->> 'limit')::numeric,
         coalesce((entitlement ->> 'unlimited')::boolean, false),
         -- Two independent things must be true to call a row measured: we know the entitlement,
         -- and we actually count the usage. Reporting either half alone is how a dashboard ends
         -- up asserting "0 of 500" for something nobody meters.
         coalesce((entitlement ->> 'measured')::boolean, false)
           and definition.measure = 'per_period',
         case when coalesce((entitlement ->> 'unlimited')::boolean, false)
                or (entitlement ->> 'limit') is null or definition.measure <> 'per_period'
              then null
              else greatest((entitlement ->> 'limit')::numeric - coalesce(counter.quantity, 0), 0)
         end,
         case when coalesce((entitlement ->> 'unlimited')::boolean, false)
                or (entitlement ->> 'limit') is null or (entitlement ->> 'limit')::numeric = 0
                or definition.measure <> 'per_period'
              then null
              else round(coalesce(counter.quantity, 0) * 100 / (entitlement ->> 'limit')::numeric, 1)
         end,
         period.period_start, period.period_end, period.period_source
  from private.entitlement_definitions definition
  cross join lateral private.usage_period(p_org_id) period
  cross join lateral public.effective_entitlement(p_org_id, definition.entitlement_key) entitlement
  left join private.usage_counters counter
    on counter.org_id = p_org_id and counter.metric_key = definition.entitlement_key
   and counter.period_start = period.period_start
  where definition.kind = 'numeric'
  order by definition.measure desc, definition.entitlement_key
$$;
revoke all on function private.usage_rows(uuid) from public, anon, authenticated;

create or replace function public.organization_usage_snapshot()
returns table (
  metric_key text, label text, unit text, measure text,
  used numeric, usage_limit numeric, unlimited boolean, measured boolean,
  remaining numeric, percent_used numeric,
  period_start timestamptz, period_end timestamptz, period_source text
)
language sql stable security definer set search_path = public as $$
  select * from private.usage_rows(auth_org()) where auth_org() is not null
$$;
revoke all on function public.organization_usage_snapshot() from public, anon;
grant execute on function public.organization_usage_snapshot() to authenticated;

comment on function public.organization_usage_snapshot() is
  'The caller''s own usage against their own limits (0155). No organization argument: the tenant '
  'comes from auth_org(), so it cannot be aimed at another customer.';

create or replace function public.platform_org_usage(p_org_id uuid)
returns table (
  metric_key text, label text, unit text, measure text,
  used numeric, usage_limit numeric, unlimited boolean, measured boolean,
  remaining numeric, percent_used numeric,
  period_start timestamptz, period_end timestamptz, period_source text
)
language sql stable security definer set search_path = public as $$
  select * from private.usage_rows(p_org_id)
  where is_platform_admin() and public.platform_has_capability('usage.view')
$$;
revoke all on function public.platform_org_usage(uuid) from public, anon;
grant execute on function public.platform_org_usage(uuid) to authenticated;

-- ===== 7. Enforcement =====
-- Drift guard before replacing a pinned body: if the live source no longer matches its A5 pin,
-- somebody changed it out of band and this migration must not paper over that.
do $enqueue_drift$
begin
  if not exists (
    select 1 from private.scope_definer_enforcements pin
    join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(pin.function_signature)
    where pin.function_signature = 'enqueue_document_processing(uuid)'
      and pin.body_hash = md5(replace(proc.prosrc, e'\r', ''))
  ) then
    raise exception '0155: enqueue_document_processing drifted from its A5 pin; re-review before replacing';
  end if;
end
$enqueue_drift$;

-- 0136:462 verbatim, with the plan limit added and nothing else changed. The check sits after the
-- existing-job lookup and before the insert, so re-enqueuing a document that already has a job is
-- never refused -- it was already counted, and refusing it would block a retry rather than a new
-- unit of work.
create or replace function public.enqueue_document_processing(p_document_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_document public.documents;
  v_output public.document_scan_outputs;
  v_checksum text;
  v_job_id uuid;
  v_status text;
  v_requires_scan boolean;
  v_counter private.usage_counters;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_document
  from public.documents document
  where document.id = p_document_id and document.org_id = v_org
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  -- The trusted supplier price-list bridge owns a separate reservation and immutable intake
  -- contract. Keep that route unchanged even when its source happens to be an image.
  v_requires_scan := public.document_scan_image_mime(v_document.mime_type)
    and not (
      v_document.entity_type = 'supplier'
      and v_document.document_kind = 'price_list'
    );

  if v_requires_scan then
    select output.* into v_output
    from public.document_scan_outputs output
    join public.document_scan_decisions decision
      on decision.org_id = output.org_id and decision.scan_output_id = output.id
    where output.org_id = v_org and output.document_id = v_document.id
      and decision.decision = 'accepted'
    order by decision.created_at desc
    limit 1;
  end if;

  if v_output.id is not null then
    v_checksum := 'etag:' || v_output.sha256;
    v_status := 'queued';
  else
    v_checksum := public.smart_document_source_checksum(
      v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
    );
    v_status := case when v_requires_scan then 'awaiting_scan' else 'queued' end;
  end if;

  select job.id into v_job_id
  from public.document_processing_jobs job
  where job.org_id = v_org and job.document_id = v_document.id
    and job.input_checksum = v_checksum and job.contract_version = '1'
    and job.status <> 'failed'
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then return v_job_id; end if;

  -- Plan limit (0155). Only a NEW job reaches here. The counter row is locked first so two
  -- concurrent uploads cannot both pass a limit that admits one, and the refusal happens before
  -- any row is written, so a refused upload leaves nothing half-created.
  v_counter := private.usage_counter_locked(v_org, 'documents.monthly');
  perform private.assert_usage_within_limit(v_org, 'documents.monthly', v_counter.quantity, 1);

  begin
    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, status, input_checksum,
      contract_version, scan_output_id
    ) values (
      v_org, v_document.id, v_user, v_status, v_checksum,
      '1', v_output.id
    ) returning id into v_job_id;
  exception when unique_violation then
    select job.id into v_job_id
    from public.document_processing_jobs job
    where job.org_id = v_org and job.document_id = v_document.id
      and job.input_checksum = v_checksum and job.contract_version = '1'
      and job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
    order by job.created_at desc limit 1;
  end;
  if v_job_id is null then
    raise exception 'document_processing_enqueue_conflict' using errcode = '40001';
  end if;

  -- Keyed by job id: the unique_violation branch above returns an EXISTING job, whose id was
  -- already counted, so a racing retry moves the counter exactly once.
  perform private.record_usage_event(
    v_org, 'documents.monthly', 1, v_job_id::text, 'document_processing_enqueue');

  if v_status = 'awaiting_scan' then
    insert into public.document_scan_jobs (
      org_id, document_id, processing_job_id, requested_by, input_checksum
    ) values (
      v_org, v_document.id, v_job_id, v_user, v_checksum
    ) on conflict (org_id, processing_job_id) do nothing;
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user,
    case when v_status = 'awaiting_scan'
      then 'document_scan_enqueued' else 'document_processing_enqueued' end,
    'document_processing_jobs', v_job_id,
    jsonb_build_object(
      'document_id', v_document.id,
      'contract_version', '1',
      'scan_output_id', v_output.id
    ),
    case when v_status = 'awaiting_scan'
      then 'document image queued for scan preview'
      else 'document queued for extraction' end
  );
  return v_job_id;
end
$$;
revoke all on function public.enqueue_document_processing(uuid) from public, anon;
grant execute on function public.enqueue_document_processing(uuid) to authenticated;

-- Re-pin the replaced body. Computed, never literal (the CRLF trap): md5 over prosrc with
-- carriage returns stripped, exactly as private.scope_definer_marker_violations() recomputes it.
insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('enqueue_document_processing(uuid)', 'filtered_read',
    '0155 keeps 0136''s auth_scopes() filter on documents unchanged and adds a plan-limit check that reads only the caller''s own organization.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

update private.entitlement_definitions set enforced_since = '0155'
where entitlement_key = 'documents.monthly';

-- ===== 8. Structural re-assertion =====
do $assert_0155$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0155 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0155 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0155$;

-- ===== 9. Anchors =====
do $anchor_0155$
declare
  v_period record;
begin
  -- The pipeline door still exists and is still the only one that counts.
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.enqueue_document_processing(uuid)')
      and prosrc like '%assert_usage_within_limit%'
      and prosrc like '%record_usage_event%'
  ) then
    raise exception '0155: enqueue_document_processing does not check or record the document limit';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'document_extractions'
      and trg.tgname = 'zzz_record_extraction_pages' and not trg.tgisinternal
  ) then
    raise exception '0155: OCR pages would never be counted';
  end if;

  -- The period falls back to a calendar month rather than to nothing when no subscription window
  -- has been supplied, and it says which definition it used.
  select * into v_period from private.usage_period('00000000-0000-4000-8000-000000000000');
  if v_period.period_source <> 'calendar_month' or v_period.period_end <= v_period.period_start then
    raise exception '0155: the billing-period fallback is not a usable calendar month';
  end if;

  -- Browser roles reach neither the events nor the counters.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('usage_events', 'usage_counters')
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception '0155: a browser role holds a grant on the metering tables';
  end if;
end
$anchor_0155$;
