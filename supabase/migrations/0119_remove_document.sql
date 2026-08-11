-- 0119 -- The button `0116` computed the consequences of.
--
-- `0116` answers "what would this take with it" and refuses to offer the destructive option unless
-- a safe reversal can be proven. This is the command that acts on that answer, and its whole job is
-- to be a command rather than a set of UPDATEs a screen issues: the preview and the action must
-- read the SAME blocker list, in the SAME transaction, or a person can be shown "safe to remove",
-- have an invoice approved underneath them, and press the button anyway.
--
-- SO IT RECOMPUTES. The preview the person read is a courtesy; the blocker list this command
-- recomputes at the moment of the write is the gate. Nothing the client sends about safety is
-- read — the same rule `apply_reviewed_document` follows, for the same reason.
--
-- TWO MODES, AND THE NAMES ARE THE PROMISE:
--   `document_only`          The document is soft-deleted. Every derived record stays. Always
--                            available -- filing something away is not destruction, and a person
--                            must always be able to say "this does not belong here".
--   `document_and_derived`   Additionally undoes what the document created, and ONLY where 0116
--                            proves it safe. Refuses with the blocker list otherwise.
--
-- WHAT "UNDO" MEANS HERE, precisely, because the word is doing a lot of work:
--   * an invoice → SOFT delete. `deleted_at`, never a row that disappears. Its number, its
--     supplier and its audit trail stay readable forever.
--   * a DRAFT goods receipt → deleted with its lines. A draft asserted nothing; it moved no stock
--     and no received quantity, which is the whole reason 0116 lets it through.
--   * a payment link → the document's filing is cleared. THE PAYMENT ITSELF IS NOT TOUCHED. A
--     receipt only ever pointed at money that had already moved.
--
-- THE FILE IS NEVER DESTROYED, in either mode. The stored object stays in private storage, the
-- extraction and interpretation payloads stay immutable, and `deleted_at` is a soft delete. This
-- product does not hard-delete financial history and a remove button is not where that starts.

-- ===== 0. The ledger stops blocking the reversal it recorded =====
--
-- 0110 gave document_review_applications `on delete restrict` on its invoice, receipt and
-- payment pointers, which is the instinct you want on a ledger — and it is wrong here, as the
-- suite caught immediately: it makes the ledger refuse the very reversal 0116 spent its whole
-- body proving safe.
--
-- The correction separates two things that were conflated. The ledger's CLAIMS -- what was
-- approved, by whom, with what assessment and for what reason -- stay immutable and are what the
-- row exists for. Its POINTERS are a convenience for finding the record it created, and a
-- pointer to something legitimately reversed should become null rather than freeze the record in
-- place forever. So the FKs become `on delete set null`, and the immutability trigger learns to
-- allow exactly that one update and nothing else.
alter table public.document_review_applications
  drop constraint if exists document_review_applications_receipt_id_fkey,
  drop constraint if exists document_review_applications_invoice_id_fkey,
  drop constraint if exists document_review_applications_payment_id_fkey;
alter table public.document_review_applications
  add constraint document_review_applications_receipt_id_fkey
    foreign key (receipt_id) references public.goods_receipts(id) on delete set null,
  add constraint document_review_applications_invoice_id_fkey
    foreign key (invoice_id) references public.invoices(id) on delete set null,
  add constraint document_review_applications_payment_id_fkey
    foreign key (payment_id) references public.payments(id) on delete set null;

create or replace function public.reject_document_review_application_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_review_application_immutable' using errcode = '42501';
  end if;
  -- The ONE permitted update: a foreign key going null because the record it named was
  -- legitimately removed. Everything the row asserts must be identical, so a caller cannot smuggle
  -- a rewrite of the reason, the assessment or the actor through this door.
  if new.org_id is not distinct from old.org_id
     and new.document_id is not distinct from old.document_id
     and new.interpretation_id is not distinct from old.interpretation_id
     and new.idempotency_key is not distinct from old.idempotency_key
     and new.actor_id is not distinct from old.actor_id
     and new.document_type is not distinct from old.document_type
     and new.supplier_id is not distinct from old.supplier_id
     and new.order_id is not distinct from old.order_id
     and new.outcome is not distinct from old.outcome
     and new.reviewed is not distinct from old.reviewed
     and new.assessment is not distinct from old.assessment
     and new.reason is not distinct from old.reason
     and new.created_at is not distinct from old.created_at
     and (new.invoice_id is null or new.invoice_id is not distinct from old.invoice_id)
     and (new.receipt_id is null or new.receipt_id is not distinct from old.receipt_id)
     and (new.payment_id is null or new.payment_id is not distinct from old.payment_id) then
    return new;
  end if;
  raise exception 'document_review_application_immutable' using errcode = '42501';
end
$$;

create or replace function public.remove_document(
  p_document_id uuid,
  p_mode text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_mode text := lower(btrim(coalesce(p_mode, '')));
  v_document public.documents;
  v_impact jsonb;
  v_blockers text;
  v_effect jsonb;
  v_undone integer := 0;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'document_removal_not_authorized' using errcode = '42501';
  end if;
  if v_mode not in ('document_only', 'document_and_derived') then
    raise exception 'document_removal_mode_invalid' using errcode = '22023';
  end if;
  -- A reason for BOTH modes. Removing a document from where someone filed it is a decision even
  -- when nothing derived is touched, and "why is this not in the gallery any more" needs an answer.
  if v_reason is null or length(v_reason) > 1000 then
    raise exception 'document_removal_reason_required' using errcode = '22023';
  end if;

  select d.* into v_document
  from public.documents d
  where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
    and (d.unit_id is null or d.unit_id = any(public.auth_scopes()))
  for update;
  if not found then
    -- Already removed, another tenant's, or outside this actor's units. Idempotent for the first
    -- case: a second press of a button on a stale screen should not be an error a person has to
    -- interpret.
    if exists (
      select 1 from public.documents d
      where d.org_id = v_org and d.id = p_document_id and d.deleted_at is not null
    ) then
      return jsonb_build_object('removed', false, 'already_removed', true, 'undone_count', 0);
    end if;
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  -- THE GATE. Recomputed here, inside the lock, against the state that exists at the moment of the
  -- write -- not the state the screen was showing when a person started reading.
  v_impact := private.document_removal_impact(v_org, p_document_id);

  if v_mode = 'document_and_derived' then
    if not (v_impact ->> 'can_remove_derived')::boolean then
      select string_agg(b ->> 'description', ' · ')
        into v_blockers
      from jsonb_array_elements(v_impact -> 'blockers') b;
      -- The blockers travel in the error. "Cannot be deleted" with no reason is how a person
      -- concludes the software is broken and goes looking for another way to do it.
      raise exception 'document_removal_blocked: %', coalesce(v_blockers, 'לא ניתן לבטל בבטחה')
        using errcode = '55000';
    end if;

    perform set_config('app.p1_financial_writer', v_actor::text, true);

    for v_effect in select e from jsonb_array_elements(v_impact -> 'effects') e
    loop
      if v_effect ->> 'action' = 'soft_delete' and v_effect ->> 'kind' = 'invoice' then
        update public.invoices
        set deleted_at = now()
        where org_id = v_org and id = (v_effect ->> 'id')::uuid and deleted_at is null;
        v_undone := v_undone + 1;
      elsif v_effect ->> 'action' = 'delete_draft' and v_effect ->> 'kind' = 'goods_receipt' then
        -- A draft only. 0116 refuses to reach here for a completed one, and the status is
        -- re-checked rather than trusted from the preview.
        delete from public.goods_receipt_items
        where org_id = v_org and receipt_id = (v_effect ->> 'id')::uuid
          and exists (
            select 1 from public.goods_receipts g
            where g.org_id = v_org and g.id = (v_effect ->> 'id')::uuid and g.status = 'draft');
        delete from public.goods_receipts
        where org_id = v_org and id = (v_effect ->> 'id')::uuid and status = 'draft';
        v_undone := v_undone + 1;
      end if;
      -- 'unlink' and 'already_removed' need no work: the filing is cleared below for every mode,
      -- and a record that is already gone stays gone.
    end loop;
  end if;

  perform set_config('app.document_filing_writer', v_actor::text, true);
  update public.documents
  set deleted_at = now(),
      deleted_by = v_actor,
      entity_type = case when v_mode = 'document_and_derived' then 'inbox' else entity_type end,
      entity_id = case when v_mode = 'document_and_derived' then null else entity_id end
  where org_id = v_org and id = p_document_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_removed', 'documents', p_document_id,
    jsonb_build_object('entity_type', v_document.entity_type, 'entity_id', v_document.entity_id,
                       'file_name', v_document.file_name),
    jsonb_build_object('mode', v_mode, 'undone_count', v_undone,
                       'effects', v_impact -> 'effects'),
    v_reason);

  return jsonb_build_object(
    'removed', true,
    'already_removed', false,
    'mode', v_mode,
    'undone_count', v_undone,
    -- Stated in the answer, not just in a comment, so a screen can say it without knowing why.
    'original_file_retained', true);
end
$$;

revoke all on function public.remove_document(uuid, text, text) from public, anon;
grant execute on function public.remove_document(uuid, text, text) to authenticated;

comment on function public.remove_document(uuid, text, text) is
  'Removes a document, and optionally undoes what it created (0119). RECOMPUTES 0116''s blocker '
  'list inside the row lock rather than trusting the preview a person read: an invoice can be '
  'approved between reading and pressing. `document_only` is always available and touches nothing '
  'derived; `document_and_derived` refuses with the blockers named in the error. An invoice is '
  'SOFT deleted, a DRAFT receipt is deleted with its lines, a payment link is cleared and the '
  'payment itself is never touched. The stored file and the immutable evidence survive both modes.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'remove_document(uuid,text,text)',
  '0119 locks the document by auth_org, role and the canonical null-or-auth_scopes unit predicate '
  'before computing a single effect, and every derived write is filtered on the same org.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0119 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'remove_document';

  -- (a) THE GATE IS RECOMPUTED. If this command ever starts trusting what the screen showed, a
  -- person can be told "safe" and press the button after it stopped being true.
  if position('document_removal_impact' in v_src) = 0
     or position('can_remove_derived' in v_src) = 0 then
    raise exception
      '0119: the removal command no longer recomputes the impact, or no longer reads '
      'can_remove_derived. The preview is a courtesy; this is the gate.';
  end if;

  -- (b) NO HARD DELETE OF AN INVOICE. Ever. Its number, supplier and audit trail stay readable.
  if v_src ~* 'delete\s+from\s+public\.invoices' then
    raise exception
      '0119: the removal command hard-deletes invoices. Financial history in this product is soft '
      'deleted, and a remove button is not where the first exception starts.';
  end if;

  -- (c) A COMPLETED receipt is never deleted. Both the 0116 gate and the status filter here have
  -- to hold; this asserts the second one, because the first could be edited by someone who
  -- believed the second was there.
  if position('status = ''draft''' in v_src) = 0 then
    raise exception
      '0119: the receipt deletion is not filtered to drafts. A completed receipt means somebody '
      'counted the goods and the stock moved.';
  end if;

  -- (d) The payment is never touched.
  if v_src ~* 'delete\s+from\s+public\.payments' or v_src ~* 'update\s+public\.payments' then
    raise exception
      '0119: the removal command touches payments. A tax receipt only ever pointed at money that '
      'had already moved.';
  end if;

  -- (e) A reason, in both modes.
  if position('document_removal_reason_required' in v_src) = 0 then
    raise exception '0119: a document can be removed without a reason.';
  end if;

  -- (f) Scope, which RLS cannot do inside a definer body.
  if position('auth_scopes()' in v_src) = 0 then
    raise exception '0119: the removal command no longer narrows by auth_scopes().';
  end if;
end
$$;
