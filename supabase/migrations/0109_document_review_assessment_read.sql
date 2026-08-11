-- 0109 -- The one read the review screen makes, and the only door the browser has to 0106/0107/0108.
--
-- Those three functions live in `private`, which carries no USAGE grant for `authenticated`. That
-- is deliberate: each of them takes `p_org_id` as an ARGUMENT rather than reading it from the
-- session, so a browser that could call them directly would be trusted with the tenant boundary
-- itself. This function is the door: it reads the tenant, the actor and the role from the session,
-- narrows to the units the actor may see, and only then calls them.
--
-- WHAT IT ANSWERS, in one round trip, because the screen needs all of it before it can render a
-- single row: who sent this document (0106), which order it is about (0107), and how its four
-- sources compare (0108) -- plus the two states the screen must never conflate.
--
-- THE TWO STATES. `file_stored` and `data_approved` are separate fields and separate sentences on
-- the screen. A person who photographs an invoice next to a delivery truck has, at that moment,
-- achieved exactly one thing: the file cannot be lost any more. Nothing about their business has
-- changed. Merging those two into one "saved" is how a reviewer walks away believing an invoice was
-- recorded when it is still sitting in a queue.
--
-- SCOPE, WHICH IS THIS FUNCTION'S JOB AND NOT THE HELPERS'. `documents`, `purchase_orders` and
-- `goods_receipts` are all scope-enforced in `private.scope_registry`, and inside a SECURITY
-- DEFINER body those policies do not apply. 0106 and 0107 deliberately do NOT re-implement the
-- narrowing -- they are invokers and say so -- which makes it this caller's responsibility, stated
-- here rather than assumed:
--   * the document itself must be in scope, or this function refuses outright;
--   * a resolved order outside the actor's scope is dropped BEFORE it reaches 0108, so the
--     assessment never compares against an order the actor may not see;
--   * the order's own items and receipts are read once the order is in scope. They are the order's
--     children, and this is the same reasoning 0090's resolver records for its exemption row.
--
-- IT IS A READ. STABLE, no writes, no queue side effects. Opening a document to look at it is not
-- a decision, and this function must never become one -- section 3 anchor (b) pins that.

create or replace function public.get_document_review_assessment(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_document public.documents;
  v_interpretation public.document_interpretations;
  v_payload jsonb;
  v_document_type text;
  v_supplier jsonb;
  v_supplier_id uuid;
  v_order jsonb;
  v_order_id uuid;
  v_order_in_scope boolean := false;
  v_document_date date;
  v_product_ids uuid[];
  v_assessment jsonb;
begin
  -- The same reader set as get_invoice_three_way_match (0099:1885). `supplier` is excluded on
  -- purpose: a supplier portal account must never see our order quantities, our contracted prices
  -- or what another document of ours said.
  if auth.uid() is null or v_org is null
     or v_role not in ('owner', 'office', 'kitchen', 'accountant') then
    raise exception 'document_review_read_not_authorized' using errcode = '42501';
  end if;

  select d.* into v_document
  from public.documents d
  where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
    and (d.unit_id is null or d.unit_id = any(public.auth_scopes()));
  if not found then
    -- Deleted, another tenant's, or outside this actor's units. One message for all three: which
    -- of them is true is itself information about a document they may not see.
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  select i.* into v_interpretation
  from public.document_interpretations i
  where i.org_id = v_org and i.document_id = p_document_id
  order by i.created_at desc, i.id desc
  limit 1;

  if not found then
    -- The file is stored and safe. Nothing has been read from it yet, and saying so is the honest
    -- answer -- not an empty assessment that looks like "we checked and found nothing".
    return jsonb_build_object(
      'document_id', v_document.id,
      'file_name', v_document.file_name,
      'document_kind', v_document.document_kind,
      'file_stored', true,
      'data_approved', false,
      'interpretation_id', null,
      'supplier_resolution', null,
      'order_resolution', null,
      'assessment', null,
      'state', 'awaiting_interpretation');
  end if;

  v_payload := v_interpretation.payload;
  v_document_type := coalesce(v_payload ->> 'document_type', v_document.document_kind);

  -- ---- Who sent it (0106). The document's own supplier_id is the ladder's second rung, so it is
  -- passed in rather than short-circuited here: one ladder, one answer, one explanation.
  v_supplier := private.resolve_document_supplier(v_org, v_document.id, v_payload);
  if (v_supplier ->> 'resolved')::boolean then
    v_supplier_id := (v_supplier ->> 'supplier_id')::uuid;
  end if;

  v_document_date := coalesce(v_document.document_date, private.interpretation_date(
    private.interpretation_field(v_payload, array[
      'invoice_date', 'document_date', 'date', 'תאריך חשבונית', 'תאריך המסמך', 'תאריך'])));

  -- ---- Which order (0107). The products the document names are the item tier's evidence, and
  -- they come from the same matcher the assessment uses, so the two cannot disagree about which
  -- product a printed code is.
  if v_supplier_id is not null then
    select array_agg(distinct (line ->> 'product_id')::uuid)
      into v_product_ids
    from jsonb_array_elements(
      private.document_assessment_lines(v_org, v_supplier_id, v_payload)) line
    where line ->> 'product_id' is not null;

    v_order := private.resolve_document_order(
      v_org, v_supplier_id, v_document_type, v_payload, v_document_date, v_product_ids);

    if (v_order ->> 'resolved')::boolean then
      v_order_id := (v_order ->> 'order_id')::uuid;
      -- The narrowing this function owns. An order the actor may not see is not silently used as
      -- the comparison basis; it is dropped, and the screen shows an unresolved order instead.
      select true into v_order_in_scope
      from public.purchase_orders po
      where po.org_id = v_org and po.id = v_order_id
        and (po.unit_id is null or po.unit_id = any(public.auth_scopes()));
      if not found then
        v_order_id := null;
        v_order := v_order || jsonb_build_object(
          'resolved', false, 'order_id', null, 'matched_by', null,
          'reason', 'order_out_of_scope');
      end if;
    end if;
  end if;

  v_assessment := private.document_reconciliation_assessment(
    v_org, v_document_type, v_supplier_id, v_order_id, v_payload, v_document_date);

  return jsonb_build_object(
    'document_id', v_document.id,
    'file_name', v_document.file_name,
    'mime_type', v_document.mime_type,
    'document_kind', v_document.document_kind,
    'document_type', v_document_type,
    'document_date', v_document_date,
    -- Two states, two words, never merged. The file being safe is not the data being approved.
    'file_stored', true,
    'data_approved', false,
    'interpretation_id', v_interpretation.id,
    'interpretation_created_at', v_interpretation.created_at,
    'supplier_resolution', v_supplier,
    'order_resolution', v_order,
    'assessment', v_assessment,
    'state', case
      when v_supplier_id is null then 'supplier_unresolved'
      when (v_assessment ->> 'approval_blocked')::boolean then 'blocked'
      else 'ready_for_approval' end);
end
$$;

revoke all on function public.get_document_review_assessment(uuid) from public, anon;
grant execute on function public.get_document_review_assessment(uuid) to authenticated;

comment on function public.get_document_review_assessment(uuid) is
  'Everything the document review screen needs in one read (0109): who sent the document (0106), '
  'which order it is about (0107), and how its four sources compare (0108). This is the only door '
  'the browser has to those three -- they take org_id as an argument and live in `private`, which '
  'has no USAGE grant, precisely so a browser cannot pass its own tenant id. Reports file_stored '
  'and data_approved as SEPARATE fields, because a photographed invoice that cannot be lost is not '
  'an invoice that has been recorded. Narrows to auth_scopes() itself, since the private helpers '
  'are invokers that deliberately leave that to their definer caller: a document out of scope is '
  'not found, and an order out of scope is dropped before it can become the comparison basis. '
  'Readers are owner/office/kitchen/accountant -- never a supplier portal account.';

-- ===== 2. The A5 ledger: this definer is ENFORCED, not exempt =====
--
-- 0095 gives a definer that touches a scope-enforced table exactly two honest options: an
-- exemption row, or a registered body whose hash matches the live source and whose source contains
-- an EXECUTABLE scope marker. This function takes the second, because it genuinely does the
-- narrowing -- and that means the exemption registry does not grow and the p9 pin does not move.
--
-- CR-STRIPPED, matching 0095's checker and 0099's precedent. A hash stored from a CRLF checkout
-- would never equal the one the checker recomputes, and A5 would fail closed on Windows only. The
-- hash is computed here from pg_proc at apply time rather than pasted as a literal, so it cannot
-- be copied stale into a later migration.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'get_document_review_assessment(uuid)',
  '0109 loads the document only through auth_org, role and the canonical null-or-auth_scopes unit '
  'predicate, and drops a resolved purchase order failing the same predicate before it can become '
  'the comparison basis for the assessment.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 3. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0109 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 4. Anchors =====
do $$
declare
  v_def text;
  v_volatile "char";
  v_secdef boolean;
begin
  select p.prosecdef, p.provolatile, pg_get_functiondef(p.oid)
    into v_secdef, v_volatile, v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_document_review_assessment';

  -- (a) It is a definer, because it must reach `private`. That is exactly why the scope narrowing
  -- below is not optional.
  if not v_secdef then
    raise exception '0109: the review read stopped being SECURITY DEFINER; it cannot reach private.';
  end if;

  -- (b) STABLE. Opening a document to look at it is not a decision, and a VOLATILE body could
  -- queue, write or approve as a side effect of rendering a screen.
  if v_volatile <> 's' then
    raise exception '0109: the review read is not STABLE -- looking at a document could now write.';
  end if;

  -- (c) The scope narrowing itself, asserted in the text rather than trusted to a comment. Inside
  -- a definer body the scope policies do not apply, so if this call disappears the function
  -- silently starts serving documents and orders from units the actor may not see.
  if position('auth_scopes()' in v_def) = 0 then
    raise exception
      '0109: the review read no longer narrows by auth_scopes(). Its three source tables are '
      'scope-enforced and RLS does not run inside a SECURITY DEFINER body.';
  end if;

  -- (d) A supplier portal account must not be a reader. It would see our order quantities, our
  -- contracted prices and what other documents of ours said.
  if position('''supplier''' in v_def) > 0 then
    raise exception '0109: the reader list now mentions supplier.';
  end if;
  if position('''accountant''' in v_def) = 0 or position('''kitchen''' in v_def) = 0 then
    raise exception '0109: a reader role was dropped from the review read.';
  end if;

  -- (e) The three resolvers it exists to front. Losing one would leave the screen quietly
  -- rendering a document with no supplier, no order or no comparison and no error to say why.
  if to_regprocedure('private.resolve_document_supplier(uuid,uuid,jsonb)') is null
     or to_regprocedure('private.resolve_document_order(uuid,uuid,text,jsonb,date,uuid[])') is null
     or to_regprocedure(
          'private.document_reconciliation_assessment(uuid,text,uuid,uuid,jsonb,date)') is null then
    raise exception '0109: one of the three resolvers this read fronts is missing.';
  end if;

  -- (f) The browser reaches this and nothing beneath it.
  if has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception '0109: authenticated gained USAGE on private; the door is no longer the only way in.';
  end if;
  if not has_function_privilege(
       'authenticated', 'public.get_document_review_assessment(uuid)', 'execute') then
    raise exception '0109: authenticated cannot execute the review read; the screen has no door.';
  end if;
  if has_function_privilege('anon', 'public.get_document_review_assessment(uuid)', 'execute') then
    raise exception '0109: anon can execute the review read.';
  end if;
end
$$;
