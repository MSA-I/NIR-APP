-- 0084 -- The interpreted document type is the filing type; no manual approval is required.
-- A human review remains available only as an append-only correction through review_document_type.

create or replace function public.sync_document_kind_from_interpretation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_previous text;
begin
  v_kind := case new.payload ->> 'document_type'
    when 'credit_note' then 'credit'
    else new.payload ->> 'document_type'
  end;

  if v_kind not in (
    'invoice', 'delivery_note', 'credit', 'quote', 'price_list',
    'payment_confirmation', 'other'
  ) then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  select document_kind into v_previous
  from public.documents
  where id = new.document_id and org_id = new.org_id
  for update;

  -- A registered price-list reservation is trusted server context: the user selected the
  -- supplier and the dedicated intake before upload. A quote-like heading must not undo it.
  if v_previous = 'price_list' and v_kind <> 'price_list' and exists (
    select 1
    from public.supplier_price_document_upload_reservations r
    where r.document_id = new.document_id
      and r.org_id = new.org_id
      and r.actor_id = new.interpreted_for_user_id
      and r.status = 'registered'
  ) then
    return new;
  end if;

  if not found or v_previous = v_kind then
    return new;
  end if;

  update public.documents
  set document_kind = v_kind
  where id = new.document_id and org_id = new.org_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    new.org_id, new.interpreted_for_user_id, 'document_kind_classified_automatically',
    'documents', new.document_id,
    jsonb_build_object('document_kind', v_previous),
    jsonb_build_object(
      'document_kind', v_kind,
      'document_type', new.payload ->> 'document_type',
      'document_type_confidence', new.payload -> 'document_type_confidence',
      'interpretation_id', new.id
    ),
    'Automatic document classification from the stored interpretation'
  );

  return new;
end;
$$;

revoke all on function public.sync_document_kind_from_interpretation()
  from public, anon, authenticated;

drop trigger if exists document_interpretation_syncs_kind
  on public.document_interpretations;
create trigger document_interpretation_syncs_kind
  after insert on public.document_interpretations
  for each row execute function public.sync_document_kind_from_interpretation();

-- The price writer predates trusted intake context and required the model to call the same
-- price sheet a price_list. Patch the live body at one exact anchor instead of copying its
-- financial transaction forward: a registered dedicated upload supplies the type decision,
-- while supplier confidence, keyed matching and every per-line safety gate remain unchanged.
do $$
declare
  v_def text;
  v_next text;
  v_from constant text := $anchor$
  elsif v_doc.document_kind <> 'price_list'
     or v_i.payload ->> 'document_type' <> 'price_list' then
    v_reason_code := 'not_a_price_list';
  elsif v_i.payload -> 'document_type_confidence' = 'null'::jsonb
     or v_i.payload -> 'supplier' -> 'confidence' = 'null'::jsonb then
    v_reason_code := 'confidence_unknown';
  else
    v_decision_confidence := least(
      (v_i.payload ->> 'document_type_confidence')::numeric,
      (v_i.payload -> 'supplier' ->> 'confidence')::numeric
    );
$anchor$;
  v_to constant text := $anchor$
  elsif v_doc.document_kind <> 'price_list'
     or (
       v_i.payload ->> 'document_type' <> 'price_list'
       and not exists (
         select 1
         from public.supplier_price_document_upload_reservations r
         where r.document_id = v_doc.id
           and r.org_id = v_doc.org_id
           and r.actor_id = v_actor
           and r.supplier_id = v_doc.supplier_id
           and r.status = 'registered'
       )
     ) then
    v_reason_code := 'not_a_price_list';
  elsif v_i.payload -> 'supplier' -> 'confidence' = 'null'::jsonb
     or (
       v_i.payload ->> 'document_type' = 'price_list'
       and v_i.payload -> 'document_type_confidence' = 'null'::jsonb
     ) then
    v_reason_code := 'confidence_unknown';
  else
    v_decision_confidence := case
      when v_i.payload ->> 'document_type' <> 'price_list'
        then (v_i.payload -> 'supplier' ->> 'confidence')::numeric
      else least(
        (v_i.payload ->> 'document_type_confidence')::numeric,
        (v_i.payload -> 'supplier' ->> 'confidence')::numeric
      )
    end;
$anchor$;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'apply_price_list_interpretation'
    and pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_interpretation_id uuid, p_actor_id uuid';

  if v_def is null then
    raise exception '0084: apply_price_list_interpretation is not installed';
  end if;
  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '0084: price-list type gate changed; re-derive the trusted-intake anchor';
  end if;

  v_next := replace(v_def, v_from, v_to);
  execute v_next;
end
$$;

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'apply_price_list_interpretation'
    and pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_interpretation_id uuid, p_actor_id uuid';

  if v_src not like '%supplier_price_document_upload_reservations%'
     or v_src not like '%v_i.payload ->> ''document_type'' <> ''price_list''%'
     or v_src not like '%v_i.payload -> ''supplier'' ->> ''confidence''%' then
    raise exception '0084: trusted intake patch or its remaining confidence gate is missing';
  end if;
end
$$;

-- The same legacy type assertion exists at preparation and final file-fence validation. Patch
-- both exact predicates so the trusted reservation survives all the way to the sole price writer.
do $$
declare
  v_prepare text;
  v_writer text;
  v_prepare_from constant text :=
    '    and i.payload ->> ''document_type'' = ''price_list''';
  v_prepare_to constant text := $anchor$    and (
      i.payload ->> 'document_type' = 'price_list'
      or exists (
        select 1
        from public.supplier_price_document_upload_reservations r
        where r.document_id = v_document.id
          and r.org_id = v_org
          and r.actor_id = p_actor_id
          and r.supplier_id = v_document.supplier_id
          and r.status = 'registered'
      )
    )$anchor$;
  v_writer_from constant text :=
    '      and i.payload ->> ''document_type'' = ''price_list''';
  v_writer_to constant text := $anchor$      and (
        i.payload ->> 'document_type' = 'price_list'
        or exists (
          select 1
          from public.supplier_price_document_upload_reservations r
          where r.document_id = d.id
            and r.org_id = d.org_id
            and r.actor_id = v_user
            and r.supplier_id = p_supplier_id
            and r.status = 'registered'
        )
      )$anchor$;
begin
  select pg_get_functiondef(
    'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure
  ) into v_prepare;
  select pg_get_functiondef(
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure
  ) into v_writer;

  if (length(v_prepare) - length(replace(v_prepare, v_prepare_from, '')))
       / length(v_prepare_from) <> 1 then
    raise exception '0084: OCR intake type gate changed; re-derive its trusted-intake anchor';
  end if;
  if (length(v_writer) - length(replace(v_writer, v_writer_from, '')))
       / length(v_writer_from) <> 1 then
    raise exception '0084: final price-writer type gate changed; re-derive its trusted-intake anchor';
  end if;

  execute replace(v_prepare, v_prepare_from, v_prepare_to);
  execute replace(v_writer, v_writer_from, v_writer_to);
end
$$;

do $$
declare
  v_prepare text;
  v_writer text;
begin
  select p.prosrc into v_prepare
  from pg_proc p
  where p.oid =
    'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure;
  select p.prosrc into v_writer
  from pg_proc p
  where p.oid =
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure;

  if v_prepare not like '%supplier_price_document_upload_reservations%'
     or v_writer not like '%supplier_price_document_upload_reservations%' then
    raise exception '0084: trusted intake did not reach both price submission fences';
  end if;
end
$$;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.sync_document_kind_from_interpretation()'::regprocedure::text,
  'trigger-new-old-rows -- the interpretation FK pins document and org; the trigger updates only that firing row document.',
  'automatic document classification'
);

comment on function public.sync_document_kind_from_interpretation() is
  'Files a document under its interpreted type immediately; later human decisions are corrections, not approvals.';
