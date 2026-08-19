-- Owner decision 19.08.2026 (DEBT §55) -- the OCR page quota is enforced at upload, not only
-- counted.
--
-- WHAT THE MEASUREMENT CHANGED ABOUT THE DESIGN. The decision was "count the pages up front and
-- refuse at upload". Production was then measured (19.08.2026) and the volume splits in two:
--
--     application/pdf   30 documents   242 pages   avg 8.1   max 27
--     image/jpeg        26 documents    22 pages   avg 1.0   max  2
--
-- Images are one page and the server knows it from the MIME type. PDFs are 92% of the page volume
-- and the server does NOT know their page count before OCR runs -- nothing downloads and parses
-- the file, and `document-preprocessing` only brokers signed URLs to the scanner. So a literal
-- "count up front" would have to take the number from the BROWSER for exactly the 92% that
-- carries the risk, and a limit whose input the limited party supplies is not a limit.
--
-- So the refusal happens at upload, as decided, but on a number the server already owns: the
-- pages this customer has ALREADY had read this period, recorded by the extraction trigger (0155)
-- from what the provider actually processed. A customer at or over their page quota is refused
-- their next document.
--
-- THE OVERSHOOT IS BOUNDED AND STATED. Because the new document's own page count is unknown until
-- it is read, a customer can cross the line by at most one document. That document cannot cost
-- more than `ExtractionLimits.max_ai_pages` (worker/ocr/src/limits.py:25), which is 20 -- the
-- provider is never asked for more, whatever the file contains. Worst case per period is
-- therefore quota + 20 pages, once. A browser-declared count could shave that 20 down, and would
-- buy it by trusting the party being limited; the trade is not worth it.
--
-- THIS IS INERT UNTIL SOMEBODY SETS A PAGE NUMBER. 0161 left `ocr_pages.monthly` unlimited on
-- every plan deliberately: the document limits were decided, page limits were not, and deriving
-- one from the other would be inventing a business answer. The check below therefore passes for
-- every customer today. That is the same shape waves 3 and 4 shipped in -- mechanism live and
-- tested, number an owner decision -- and turning it on is one UPDATE.

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
    raise exception '0162: enqueue_document_processing drifted from its A5 pin; re-review before replacing';
  end if;
end
$enqueue_drift$;

-- 0155's body, with the page check added beside the document check and nothing else changed.
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
  v_pages private.usage_counters;
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

  -- Plan limits (0155, 0162). Only a NEW job reaches here. Both counter rows are locked first so
  -- two concurrent uploads cannot both pass a limit that admits one, and both refusals happen
  -- before any row is written, so a refused upload leaves nothing half-created.
  v_counter := private.usage_counter_locked(v_org, 'documents.monthly');
  perform private.assert_usage_within_limit(v_org, 'documents.monthly', v_counter.quantity, 1);

  -- Pages are checked on what has ALREADY been read this period -- the only page number the
  -- server owns before OCR runs. The increment is zero because this document's own page count is
  -- unknown until the provider reads it; the extraction trigger records the truth afterwards.
  v_pages := private.usage_counter_locked(v_org, 'ocr_pages.monthly');
  perform private.assert_usage_within_limit(v_org, 'ocr_pages.monthly', v_pages.quantity, 0);

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

-- Re-pin the replaced body. Computed, never literal (the CRLF trap).
insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('enqueue_document_processing(uuid)', 'filtered_read',
    '0162 keeps 0136''s auth_scopes() filter on documents unchanged and adds a second plan-limit check that reads only the caller''s own organization.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

do $assert_0162$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0162 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0162$;

do $anchor_0162$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.enqueue_document_processing(uuid)')
      and prosrc like '%ocr_pages.monthly%'
  ) then
    raise exception '0162: the page quota is still not checked at upload';
  end if;

  -- Inert on arrival, and that is the point: page numbers are an owner decision that has not been
  -- made, and a limit invented here would be exactly the silent guess the constitution forbids.
  if exists (
    select 1 from plan_entitlements
    where entitlement_key = 'ocr_pages.monthly' and not unlimited
  ) then
    raise exception '0162: a page limit was set here -- that number is an owner decision, not a migration';
  end if;
end
$anchor_0162$;
