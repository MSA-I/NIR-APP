-- 0144 — The automatic packet-split page ceiling moves from 20 to 40, and nothing else moves.
--
-- 0140 wrote three independent conditions into `service_record_document_packet`: the org has
-- switched packet splitting on, every segment clears the confidence floor, the extraction is not
-- partial, and the document is at most 20 pages. The owner asked for 40. This migration changes
-- that one number and copies the rest of the body through unaltered, so the diff against 0140 is
-- a single token.
--
-- WHAT THIS DOES NOT DO, stated here because the two numbers are easy to confuse:
--
--   The OCR worker's paid-transcription cap, `ExtractionLimits.max_ai_pages`
--   (`worker/ocr/src/limits.py`), STAYS AT 20. It is a per-document provider bill, not a review
--   policy, and doubling it is a cost decision for the owner rather than a side effect of
--   widening a ceiling somewhere else. `parsers._parse_pdf` sends `missing[: max_ai_pages]` to
--   the provider and nothing beyond it.
--
--   So a SCANNED packet of 21-40 pages still has pages that were never rendered and never read.
--   As of the same change that ships this migration, the worker derives `document.partial` from
--   exactly that fact instead of hardcoding it, so such a document reports `partial = true`, the
--   `not partial` arm below refuses it, and a human still approves the split. That is the correct
--   outcome and it is not a gap this migration leaves open.
--
--   What the new ceiling actually unlocks is the case where every page WAS read: a 21-40 page PDF
--   carrying its own text layer. Those never enter the OCR branch at all, come out complete, and
--   were previously refused for their length alone.
--
-- The `page_count between 2 and 100` constraint on `public.document_packets` (0140:97) already
-- admits 40 and is deliberately left alone; the self-check below verifies that numerically rather
-- than assuming it. The 0.900 confidence floor, the autonomy policy tables, the RLS policies and
-- every other arm of the predicate are untouched.
--
-- `public.service_record_document_packet(uuid,uuid,uuid)` is registered in
-- `private.scope_definer_exemptions` (0140:598-600) as a service-role-trusted path. That registry
-- records a signature and a reason, not a body hash, and the signature is unchanged here — so
-- replacing the body neither adds nor drains an exemption and the pinned row count in
-- `p9_five_domains.sql` stays where it is.

create or replace function public.service_record_document_packet(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_interpretation public.document_interpretations;
  v_extraction public.document_extractions;
  v_manifest jsonb;
  v_hash text;
  v_policy record;
  v_threshold numeric;
  v_automatic boolean;
  v_packet public.document_packets;
  v_segment jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into v_job from public.document_processing_jobs where id=p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode='P0002'; end if;
  select * into v_document from public.documents
    where org_id=v_job.org_id and id=v_job.document_id and deleted_at is null;
  select * into v_interpretation from public.document_interpretations
    where org_id=v_job.org_id and id=p_interpretation_id and job_id=v_job.id;
  select * into v_extraction from public.document_extractions
    where org_id=v_job.org_id and id=v_interpretation.extraction_id and job_id=v_job.id;
  if v_document.id is null or v_interpretation.id is null or v_extraction.id is null
     or v_document.mime_type <> 'application/pdf'
     or v_interpretation.interpreted_for_user_id is distinct from p_actor_id then
    raise exception 'document_packet_context_invalid' using errcode='23514';
  end if;
  v_manifest := v_interpretation.payload -> 'packet_segments';
  if jsonb_typeof(v_manifest) is distinct from 'array'
     or jsonb_array_length(v_manifest) < 2
     or not private.document_packet_manifest_valid(
       v_manifest,(v_extraction.payload #>> '{document,page_count}')::integer
     ) then
    raise exception 'document_packet_manifest_invalid' using errcode='22023';
  end if;
  v_hash := private.document_packet_manifest_hash(v_manifest);

  select * into v_packet from public.document_packets
    where org_id=v_job.org_id and source_interpretation_id=v_interpretation.id;
  if found then
    if v_packet.manifest_hash is distinct from v_hash then
      raise exception 'document_packet_manifest_conflict' using errcode='23505';
    end if;
    return jsonb_build_object(
      'packet_id',v_packet.id,'status',v_packet.status,'manifest_hash',v_packet.manifest_hash,
      'automatic_eligible',v_packet.automatic_eligible,'idempotent',true
    );
  end if;

  select * into v_policy from private.autonomy_policy_for_org(v_job.org_id,'document.packet_split');
  if not found then raise exception 'autonomy_policy_unresolved' using errcode='P0002'; end if;
  select baseline_min_confidence into v_threshold
    from private.autonomy_policy_definitions where policy_key='document.packet_split';
  v_threshold := coalesce(v_policy.min_confidence,v_threshold);
  -- The `not partial` arm below is the one that keeps a long SCAN human: the worker cannot read
  -- past its own paid-OCR cap of 20 pages and now says so, so 21-40 pages of scan lands here as
  -- partial and is refused. The 40 is therefore a ceiling on documents that were read in full.
  v_automatic := coalesce(v_policy.autonomy_enabled,false)
    and not (v_extraction.payload #>> '{document,partial}')::boolean
    and (v_extraction.payload #>> '{document,page_count}')::integer <= 40
    and not exists (
      select 1 from jsonb_array_elements(v_manifest) item
      where jsonb_typeof(item -> 'confidence') <> 'number'
         or (item ->> 'confidence')::numeric < v_threshold
    );

  insert into public.document_packets(
    org_id,unit_id,parent_document_id,source_job_id,source_interpretation_id,page_count,
    source_partial,confidence_threshold,automatic_eligible,status,manifest_hash,
    created_by,approved_by,approved_at,approval_reason
  ) values (
    v_job.org_id,v_document.unit_id,v_document.id,v_job.id,v_interpretation.id,
    (v_extraction.payload #>> '{document,page_count}')::integer,
    (v_extraction.payload #>> '{document,partial}')::boolean,v_threshold,v_automatic,
    case when v_automatic then 'approved' else 'needs_review' end,v_hash,p_actor_id,
    case when v_automatic then p_actor_id end,
    case when v_automatic then statement_timestamp() end,
    case when v_automatic then 'פיצול אוטומטי לפי מדיניות הארגון' end
  ) returning * into v_packet;

  set constraints document_packet_segments_manifest_guard deferred;
  for v_segment in select value from jsonb_array_elements(v_manifest)
  loop
    insert into public.document_packet_segments(
      org_id,unit_id,packet_id,ordinal,start_page,end_page,document_type,confidence
    ) values (
      v_packet.org_id,v_packet.unit_id,v_packet.id,
      (v_segment ->> 'ordinal')::integer,(v_segment ->> 'start_page')::integer,
      (v_segment ->> 'end_page')::integer,v_segment ->> 'document_type',
      (v_segment ->> 'confidence')::numeric
    );
  end loop;
  set constraints document_packet_segments_manifest_guard immediate;
  set constraints document_packet_segments_manifest_guard deferred;

  return jsonb_build_object(
    'packet_id',v_packet.id,'status',v_packet.status,'manifest_hash',v_packet.manifest_hash,
    'automatic_eligible',v_packet.automatic_eligible,'idempotent',false
  );
end
$$;

comment on function public.service_record_document_packet(uuid,uuid,uuid) is
  'Records a mixed-PDF packet from a reviewed manifest. Automatic split requires an enabled policy, a complete extraction, at most 40 pages and every segment at or above the confidence floor.';

-- The change has to be visible where it is decided, or this migration is a no-op that reported
-- success. Asserted against the installed function body rather than against this file.
do $$
declare v_source text;
begin
  select prosrc into v_source from pg_catalog.pg_proc
  where oid = pg_catalog.to_regprocedure('public.service_record_document_packet(uuid,uuid,uuid)');
  if v_source is null then
    raise exception '0144 self-check: the packet recorder is missing';
  end if;
  if position('page_count}'')::integer <= 40' in v_source) = 0 then
    raise exception '0144 self-check: the packet page ceiling is not 40';
  end if;
  if position('page_count}'')::integer <= 20' in v_source) > 0 then
    raise exception '0144 self-check: the old 20-page ceiling is still in the body';
  end if;
  -- The other three arms of the same predicate. A ceiling raised by quietly deleting a
  -- neighbouring condition would be a far worse change than the one this migration claims to
  -- make. The partial arm is matched on the whole negated expression, because '{document,partial}'
  -- alone also appears in the INSERT that records `source_partial` and would still be found if
  -- the eligibility test had been dropped.
  if position('not (v_extraction.payload #>> ''{document,partial}'')::boolean' in v_source) = 0
     or position('autonomy_enabled' in v_source) = 0
     or position('< v_threshold' in v_source) = 0 then
    raise exception '0144 self-check: an arm of the automatic-eligibility predicate was lost';
  end if;
end
$$;

-- The stored ceiling has to admit what the predicate now admits. Read numerically rather than by
-- string match, because `pg_get_constraintdef` may deparse `between` either way.
do $$
declare
  v_definition text;
  v_upper integer;
begin
  select pg_get_constraintdef(constraint_row.oid) into v_definition
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.document_packets'::regclass
    and constraint_row.contype = 'c'
    and pg_get_constraintdef(constraint_row.oid) like '%page_count%'
  order by constraint_row.conname
  limit 1;
  if v_definition is null then
    raise exception '0144 self-check: the packet page_count constraint is missing';
  end if;
  v_upper := coalesce(
    (regexp_match(v_definition, 'page_count <= ([0-9]+)'))[1],
    (regexp_match(v_definition, 'page_count BETWEEN [0-9]+ AND ([0-9]+)'))[1]
  )::integer;
  if v_upper is null or v_upper < 40 then
    raise exception '0144 self-check: document_packets accepts at most % pages: %',
      coalesce(v_upper::text, 'an unreadable number'), v_definition;
  end if;
end
$$;

-- The grants of 0140 are not re-issued, so prove they survived `create or replace`.
do $$
declare v_signature text := 'public.service_record_document_packet(uuid,uuid,uuid)';
begin
  if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception '0144 self-check: service_role cannot execute the packet recorder';
  end if;
  if has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE') then
    raise exception '0144 self-check: a tenant API role can execute the packet recorder';
  end if;
  -- Matched on the resolved oid, not on the stored text: `regprocedure::text` drops the schema
  -- when the function is in the session's search_path, so a text comparison would depend on how
  -- the migration happens to be invoked.
  if not exists (
    select 1 from private.scope_definer_exemptions
    where to_regprocedure(function_signature) = to_regprocedure(v_signature)
  ) then
    raise exception '0144 self-check: the packet recorder lost its definer exemption registration';
  end if;
end
$$;

do $$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0144 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0144 export assertions failed:\n%',v_violations; end if;
end
$$;
