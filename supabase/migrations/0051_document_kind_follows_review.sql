-- The document type the reviewer approves now reaches the document itself.
--
-- Until now `review_document_type` recorded the decision in its append-only ledger and in
-- audit_logs, and stopped there. `documents.document_kind` kept whatever was picked from a
-- dropdown at upload time and was never touched again, so the gallery filtered on a guess while
-- the confirmed classification sat in a table nobody filters by. Recognising the document was the
-- point of running OCR over it.
--
-- This does not weaken "extraction output is a suggestion" (ARCHITECTURE.md:165). Nothing here
-- fires on the model's suggestion: it fires only once a person has approved it, carries the same
-- reason and revision that approval already recorded, and a rejection changes nothing. It is a
-- filing label, not a financial record -- no invoice, price or balance is written.

create or replace function public.sync_document_kind_from_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_previous text;
begin
  if new.decision is distinct from 'approved' or new.approved_document_type is null then
    return new;
  end if;

  -- The two vocabularies agree on every value except this one: InterpretationContract says
  -- 'credit_note', documents_kind_check says 'credit'. An unmapped value would fail the check
  -- constraint and take the whole approval down with it.
  v_kind := case new.approved_document_type
    when 'credit_note' then 'credit'
    else new.approved_document_type
  end;

  select document_kind into v_previous
  from public.documents
  where id = new.document_id and org_id = new.org_id
  for update;

  if v_previous is null or v_previous = v_kind then
    return new;
  end if;

  update public.documents
  set document_kind = v_kind
  where id = new.document_id and org_id = new.org_id;

  -- Reclassifying changes how a document is found later, so it is audited on its own rather than
  -- being left implicit inside the review decision.
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    new.org_id, new.actor_id, 'document_kind_synced_from_review',
    'documents', new.document_id,
    jsonb_build_object('document_kind', v_previous),
    jsonb_build_object(
      'document_kind', v_kind,
      'approved_document_type', new.approved_document_type,
      'decision_id', new.id,
      'revision', new.revision
    ),
    new.reason
  );

  return new;
end;
$$;

revoke all on function public.sync_document_kind_from_review() from public, anon, authenticated;

drop trigger if exists document_type_review_syncs_kind on public.document_type_review_decisions;
create trigger document_type_review_syncs_kind
  after insert on public.document_type_review_decisions
  for each row execute function public.sync_document_kind_from_review();
