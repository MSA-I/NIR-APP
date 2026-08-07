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

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.sync_document_kind_from_interpretation()'::regprocedure::text,
  'trigger-new-old-rows -- the interpretation FK pins document and org; the trigger updates only that firing row document.',
  'automatic document classification'
);

comment on function public.sync_document_kind_from_interpretation() is
  'Files a document under its interpreted type immediately; later human decisions are corrections, not approvals.';
