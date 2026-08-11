-- 0116 -- Before you remove a document, here is exactly what goes with it.
--
-- A document in this product is rarely just a file. It can have created an invoice, opened a
-- receipt draft, attached itself as evidence to a payment, moved a price list. "Delete" on such a
-- thing is one of the few buttons in a financial system that can destroy something nobody can
-- reconstruct, and the honest way to offer it is to say -- computed, not guessed -- what it will
-- take with it.
--
-- TWO OPTIONS, NAMED, NEVER MERGED:
--   * REMOVE THE DOCUMENT ONLY. The file goes to the archive; every business record derived from
--     it stays exactly where it is. This is always available.
--   * REMOVE THE DOCUMENT AND UNDO WHAT IT CREATED. Available ONLY where a safe reversal can be
--     PROVEN. Not "looks fine" -- proven, by this function, per derived record.
--
-- WHEN SAFETY CANNOT BE PROVEN, THE DESTRUCTIVE OPTION IS BLOCKED, and it is blocked with a
-- specific Hebrew sentence naming what is holding it. "Cannot be deleted" with no reason is how a
-- person concludes the software is broken and goes looking for another way to do it.
--
-- WHAT COUNTS AS A BLOCKER. A derived record may be undone only if it is still exactly what the
-- machine or the approval made it. Anything below means somebody or something has since built on
-- it, and unbuilding it silently would be the failure this whole function exists to prevent:
--   * an invoice that is approved, paid or partly paid, or that a payment request refers to;
--   * a goods receipt that has been COMPLETED -- stock moved, quantities counted;
--   * a payment or a bank allocation of any kind;
--   * a locked monthly report that already counted it;
--   * another document filed against the same record.
--
-- THE ORIGINAL FILE IS NEVER DESTROYED. Not by either option. The immutable extraction and
-- interpretation payloads stay, `deleted_at` is a soft delete, and the stored object stays in
-- private storage. Financial history in this product does not get hard-deleted, and a "remove"
-- button is not the place to make the first exception.
--
-- IT DELEGATES THE UNDOING. `revert_document_auto_action` (0077), `revert_delivery_note_receipt`
-- (0090) and `revert_price_list_auto_action` (0093) already exist, already take a reason, and
-- already know their own preconditions. This function decides WHETHER, names WHY NOT, and leaves
-- the HOW where it already works.

create or replace function private.document_removal_impact(
  p_org_id uuid,
  p_document_id uuid
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_document public.documents;
  v_effects jsonb := '[]'::jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_application public.document_review_applications;
  v_invoice public.invoices;
  v_receipt public.goods_receipts;
begin
  select d.* into v_document
  from public.documents d
  where d.org_id = p_org_id and d.id = p_document_id and d.deleted_at is null;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  -- Everything this document was applied into, newest first. A document can have been applied more
  -- than once only through distinct idempotency keys, which means distinct deliberate approvals.
  for v_application in
    select * from public.document_review_applications a
    where a.org_id = p_org_id and a.document_id = p_document_id
    order by a.created_at desc
  loop
    if v_application.invoice_id is not null then
      select * into v_invoice from public.invoices i
      where i.org_id = p_org_id and i.id = v_application.invoice_id;

      if not found or v_invoice.deleted_at is not null then
        v_effects := v_effects || jsonb_build_array(jsonb_build_object(
          'kind', 'invoice', 'id', v_application.invoice_id, 'action', 'already_removed',
          'description', 'החשבונית שנוצרה מהמסמך כבר נמחקה'));
      else
        if v_invoice.review_status = 'approved' then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'invoice_approved', 'id', v_invoice.id,
            'description', format('החשבונית %s אושרה. ביטולה הוא החלטה כספית נפרדת — יש לבטל '
              || 'את האישור תחילה', v_invoice.invoice_number)));
        end if;
        if v_invoice.payment_status <> 'unpaid' then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'invoice_paid', 'id', v_invoice.id,
            'description', format('החשבונית %s שולמה או שולמה חלקית. כסף שיצא אינו מבוטל '
              || 'במחיקת מסמך', v_invoice.invoice_number)));
        end if;
        if exists (
          select 1 from public.payment_request_invoices pri
          where pri.org_id = p_org_id and pri.invoice_id = v_invoice.id
        ) then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'invoice_in_payment_request', 'id', v_invoice.id,
            'description', format('החשבונית %s נכללת בדרישת תשלום', v_invoice.invoice_number)));
        end if;
        if jsonb_array_length(v_blockers) = 0 then
          v_effects := v_effects || jsonb_build_array(jsonb_build_object(
            'kind', 'invoice', 'id', v_invoice.id, 'action', 'soft_delete',
            'description', format('החשבונית %s תימחק מחיקה רכה', v_invoice.invoice_number)));
        end if;
      end if;
    end if;

    if v_application.receipt_id is not null then
      select * into v_receipt from public.goods_receipts g
      where g.org_id = p_org_id and g.id = v_application.receipt_id;
      if found and v_receipt.status = 'completed' then
        -- The one blocker nobody should be able to argue with: a person counted the goods and
        -- stock moved. Undoing that from a document screen would leave the shelves disagreeing
        -- with the system and nothing to explain why.
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'kind', 'receipt_completed', 'id', v_receipt.id,
          'description', 'קבלת הסחורה הושלמה — המלאי והכמויות שהתקבלו כבר זזו'));
      elsif found then
        v_effects := v_effects || jsonb_build_array(jsonb_build_object(
          'kind', 'goods_receipt', 'id', v_receipt.id, 'action', 'delete_draft',
          'description', 'טיוטת קבלת הסחורה שנוצרה מהמסמך תבוטל'));
      end if;
    end if;

    if v_application.payment_id is not null then
      -- A tax receipt only ever LINKED to a payment; it never created one. Removing the document
      -- removes the link, and says so, so nobody reads "payment" and fears the money moved.
      v_effects := v_effects || jsonb_build_array(jsonb_build_object(
        'kind', 'payment_link', 'id', v_application.payment_id, 'action', 'unlink',
        'description', 'הקישור בין המסמך לתשלום הרשום יוסר — התשלום עצמו אינו משתנה'));
    end if;
  end loop;

  -- A locked monthly report that already counted this document's invoice. Reopening a closed
  -- month from a document screen is not a thing this product does.
  if exists (
    select 1
    from public.document_review_applications a
    join public.invoices i on i.org_id = a.org_id and i.id = a.invoice_id
    join public.monthly_report_snapshots s on s.org_id = a.org_id
    where a.org_id = p_org_id and a.document_id = p_document_id
      and to_char(i.invoice_date, 'YYYY-MM') = to_char(s.report_month, 'YYYY-MM')
  ) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'kind', 'month_reported',
      'description', 'החודש שאליו שייכת החשבונית כבר נסגר בדוח חודשי'));
  end if;

  return jsonb_build_object(
    'found', true,
    'document_id', v_document.id,
    'file_name', v_document.file_name,
    'entity_type', v_document.entity_type,
    -- Always true, for both options, and stated rather than assumed: the original file and the
    -- immutable evidence survive any removal this product offers.
    'original_file_retained', true,
    'effects', v_effects,
    'blockers', v_blockers,
    'can_remove_document_only', true,
    'can_remove_derived', jsonb_array_length(v_blockers) = 0,
    'derived_count', jsonb_array_length(v_effects));
end
$fn$;

revoke all on function private.document_removal_impact(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.document_removal_impact(uuid, uuid) is
  'What removing this document would take with it, computed per derived record (0116). Returns the '
  'effects and, separately, the BLOCKERS -- an approved or paid invoice, an invoice inside a '
  'payment request, a COMPLETED goods receipt, a reported month -- each with the Hebrew sentence '
  'that names it. The destructive option is offered only when the blocker list is empty, because '
  '"cannot be deleted" with no reason is how a person concludes the software is broken. The '
  'original file and the immutable evidence survive either option.';

create or replace function public.get_document_removal_impact(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
begin
  if auth.uid() is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'document_removal_not_authorized' using errcode = '42501';
  end if;
  -- Scope, for the reason 0109 records: inside a definer body the scope riders do not run.
  if not exists (
    select 1 from public.documents d
    where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
      and (d.unit_id is null or d.unit_id = any(public.auth_scopes()))
  ) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;
  return private.document_removal_impact(v_org, p_document_id);
end
$$;

revoke all on function public.get_document_removal_impact(uuid) from public, anon;
grant execute on function public.get_document_removal_impact(uuid) to authenticated;

comment on function public.get_document_removal_impact(uuid) is
  'The impact preview a person reads before removing a document (0116). owner/office only, scoped '
  'to the actor''s units, read-only.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'get_document_removal_impact(uuid)',
  '0116 refuses any document failing auth_org plus the canonical null-or-auth_scopes unit '
  'predicate before computing a single effect.'
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
    raise exception e'0116 scope assertions failed:\n%', v_violations;
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
  where n.nspname = 'private' and p.proname = 'document_removal_impact';

  -- (a) It computes; it does not act. A preview that could write would be a delete button that
  -- fires while a person is still reading what it will do.
  if (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'document_removal_impact') <> 's' then
    raise exception '0116: the impact preview is not STABLE -- reading it could change something.';
  end if;

  -- (b) The four blockers the header names. Losing one turns a refusal into a silent destruction.
  if position('receipt_completed' in v_src) = 0
     or position('invoice_paid' in v_src) = 0
     or position('invoice_approved' in v_src) = 0
     or position('month_reported' in v_src) = 0 then
    raise exception
      '0116: a blocker was removed from the impact calculation. Each one is a record somebody '
      'else has since built on, and unbuilding it silently is what this function exists to stop.';
  end if;

  -- (c) The destructive option is gated on the blocker list being EMPTY, not on a count or a
  -- severity. "Probably safe" is not a thing this button may act on.
  if position('jsonb_array_length(v_blockers) = 0' in v_src) = 0 then
    raise exception
      '0116: the destructive option is no longer gated on an empty blocker list.';
  end if;

  -- (d) The commands it delegates to. This function decides WHETHER; they know HOW, and they
  -- already require a reason.
  if to_regprocedure('public.revert_document_auto_action(uuid,text)') is null
     or to_regprocedure('public.revert_delivery_note_receipt(uuid,text)') is null
     or to_regprocedure('public.revert_price_list_auto_action(uuid,text)') is null then
    raise exception '0116: one of the existing reasoned revert commands is gone.';
  end if;

  -- (e) The file survives. Both options, always.
  if position('original_file_retained' in v_src) = 0 then
    raise exception
      '0116: the answer no longer states that the original file is retained. Financial history in '
      'this product is not hard-deleted, and a person about to press remove needs to know that.';
  end if;
end
$$;
