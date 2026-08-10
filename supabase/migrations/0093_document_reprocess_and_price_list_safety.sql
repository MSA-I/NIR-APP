-- 0093 -- Preserve the document interpretation actor chain across manager-requested reprocessing,
-- make price-list reversal retries safe, and reject conflicting catalog identifiers.

-- requested_by is the document-processing/interpretation actor. The operator who asked for the
-- reprocess remains the audit actor, so an owner or office user cannot accidentally replace the
-- immutable uploader identity used by the worker and automatic financial decision chain.
create or replace function public.reprocess_document(p_document_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_document public.documents;
  v_checksum text;
  v_job_id uuid;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_document
  from public.documents
  where id = p_document_id and org_id = v_org and deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  v_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );

  if exists (
    select 1 from public.document_processing_jobs j
    where j.org_id = v_org
      and j.document_id = v_document.id
      and j.input_checksum = v_checksum
      and j.contract_version = '1'
      and j.status in ('queued', 'leased', 'extracted', 'interpreting')
  ) then
    raise exception 'document_processing_active' using errcode = '55000';
  end if;

  insert into public.document_processing_jobs (
    org_id, document_id, requested_by, input_checksum, contract_version
  ) values (
    v_org, v_document.id, v_document.uploaded_by, v_checksum, '1'
  ) returning id into v_job_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'document_processing_reprocessed', 'document_processing_jobs', v_job_id,
    jsonb_build_object(
      'document_id', v_document.id,
      'contract_version', '1',
      'processing_actor_id', v_document.uploaded_by
    ),
    v_reason
  );
  return v_job_id;
end
$$;

revoke all on function public.reprocess_document(uuid, text) from public, anon, service_role;
grant execute on function public.reprocess_document(uuid, text) to authenticated;

-- Resolve every supplied strong identifier before selecting a product. A supplier SKU and product
-- SKU are both SKU evidence; a barcode is independent evidence. Multiple candidates or two unique
-- identifiers that point at different products are ambiguous. Product names are not an input and
-- therefore can never authorize a match.
create or replace function private.match_price_list_line(
  p_org_id uuid,
  p_supplier_id uuid,
  p_sku text,
  p_barcode text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku text := nullif(lower(trim(p_sku)), '');
  v_barcode text := nullif(lower(trim(p_barcode)), '');
  v_supplier_sku_ids uuid[];
  v_product_sku_ids uuid[];
  v_barcode_ids uuid[];
  v_sku_product_id uuid;
  v_barcode_product_id uuid;
  v_sku_matched_by text;
begin
  if p_org_id is null or p_supplier_id is null then
    return jsonb_build_object('status', 'unmatched');
  end if;

  -- An identifier already owned by an inactive catalog row is not a new-product candidate.
  -- Reactivation is a human decision; automatic intake must route the line to review.
  if exists (
    select 1
    from public.products p
    where p.org_id = p_org_id
      and not p.active
      and (
        (v_sku is not null and lower(trim(p.sku)) = v_sku)
        or (v_barcode is not null and lower(trim(p.barcode)) = v_barcode)
        or (
          v_sku is not null
          and exists (
            select 1
            from public.supplier_products sp
            where sp.org_id = p.org_id
              and sp.product_id = p.id
              and sp.supplier_id = p_supplier_id
              and lower(trim(sp.supplier_sku)) = v_sku
          )
        )
      )
  ) then
    return jsonb_build_object('status', 'ambiguous', 'matched_by', 'inactive_product_identifier');
  end if;

  if v_sku is not null then
    select array_agg(distinct sp.product_id order by sp.product_id)
      into v_supplier_sku_ids
    from public.supplier_products sp
    join public.products p
      on p.org_id = sp.org_id and p.id = sp.product_id and p.active
    where sp.org_id = p_org_id
      and sp.supplier_id = p_supplier_id
      and lower(trim(sp.supplier_sku)) = v_sku;

    select array_agg(distinct p.id order by p.id)
      into v_product_sku_ids
    from public.products p
    where p.org_id = p_org_id and p.active and lower(trim(p.sku)) = v_sku;

    if coalesce(cardinality(v_supplier_sku_ids), 0) > 1
       or coalesce(cardinality(v_product_sku_ids), 0) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'sku');
    end if;

    if coalesce(cardinality(v_supplier_sku_ids), 0) = 1
       and coalesce(cardinality(v_product_sku_ids), 0) = 1
       and v_supplier_sku_ids[1] is distinct from v_product_sku_ids[1] then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'sku_conflict');
    end if;

    if coalesce(cardinality(v_supplier_sku_ids), 0) = 1 then
      v_sku_product_id := v_supplier_sku_ids[1];
      v_sku_matched_by := 'supplier_sku';
    elsif coalesce(cardinality(v_product_sku_ids), 0) = 1 then
      v_sku_product_id := v_product_sku_ids[1];
      v_sku_matched_by := 'sku';
    end if;
  end if;

  if v_barcode is not null then
    select array_agg(distinct p.id order by p.id)
      into v_barcode_ids
    from public.products p
    where p.org_id = p_org_id and p.active and lower(trim(p.barcode)) = v_barcode;

    if coalesce(cardinality(v_barcode_ids), 0) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'barcode');
    elsif coalesce(cardinality(v_barcode_ids), 0) = 1 then
      v_barcode_product_id := v_barcode_ids[1];
    end if;
  end if;

  if v_sku_product_id is not null
     and v_barcode_product_id is not null
     and v_sku_product_id is distinct from v_barcode_product_id then
    return jsonb_build_object('status', 'ambiguous', 'matched_by', 'identifier_conflict');
  end if;

  if v_sku_product_id is not null then
    return jsonb_build_object(
      'status', 'matched',
      'product_id', v_sku_product_id,
      'matched_by', v_sku_matched_by
    );
  elsif v_barcode_product_id is not null then
    return jsonb_build_object(
      'status', 'matched',
      'product_id', v_barcode_product_id,
      'matched_by', 'barcode'
    );
  end if;

  return jsonb_build_object('status', 'unmatched');
end
$$;

revoke all on function private.match_price_list_line(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- A lost response after a committed reversal is replayable only when the normalized reason is the
-- same. Replays return the original effect count before any writer GUC or audit mutation. A changed
-- reason represents a different command and fails closed.
create or replace function public.revert_price_list_auto_action(
  p_decision_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_decision public.price_list_interpretation_decisions;
  v_snap private.price_list_auto_action_snapshots;
  v_previous jsonb;
  v_applied jsonb;
  v_current public.supplier_products;
  v_reverted integer := 0;
  v_preserved_products integer := 0;
  v_effective_date date :=
    timezone('Asia/Jerusalem', clock_timestamp())::date;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_decision
  from public.price_list_interpretation_decisions d
  where d.id = p_decision_id and d.org_id = v_org
  for update;
  if not found then
    raise exception 'price_list_auto_action_unknown' using errcode = 'P0002';
  end if;
  if v_decision.submission_id is null then
    raise exception 'price_list_auto_action_not_applied' using errcode = '55000';
  end if;

  if v_decision.reverted_at is not null then
    if v_decision.reverted_reason is distinct from v_reason then
      raise exception 'price_list_auto_action_revert_reason_conflict' using errcode = '55000';
    end if;

    select * into v_snap
    from private.price_list_auto_action_snapshots s
    where s.org_id = v_org and s.decision_id = v_decision.id;
    if not found then
      raise exception 'price_list_auto_action_snapshot_missing' using errcode = 'P0002';
    end if;

    return jsonb_build_object(
      'decision_id', v_decision.id,
      'submission_id', v_decision.submission_id,
      'reverted_price_count', jsonb_array_length(v_snap.applied_prices),
      'preserved_created_product_count', (
        select count(*)
        from jsonb_array_elements(v_snap.previous_prices) previous
        where coalesce((previous ->> 'product_created')::boolean, false)
      ),
      'idempotent', true
    );
  end if;

  select * into v_snap
  from private.price_list_auto_action_snapshots s
  where s.org_id = v_org and s.decision_id = v_decision.id;
  if not found then
    raise exception 'price_list_auto_action_snapshot_missing' using errcode = 'P0002';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  perform set_config('app.price_list_auto_writer', 'revert', true);
  for v_applied in select value from jsonb_array_elements(v_snap.applied_prices)
  loop
    select * into v_current
    from public.supplier_products sp
    where sp.org_id = v_org
      and sp.id = (v_applied ->> 'supplier_product_id')::uuid
      and sp.supplier_id = v_decision.supplier_id
      and sp.product_id = (v_applied ->> 'product_id')::uuid
    for update;
    if not found
       or round(v_current.current_price, 2)
            <> round((v_applied ->> 'current_price')::numeric, 2)
       or v_current.price_effective_date
            <> (v_applied ->> 'price_effective_date')::date
       or v_current.available <> (v_applied ->> 'available')::boolean then
      raise exception 'price_list_auto_action_superseded' using errcode = '55000';
    end if;

    select value into v_previous
    from jsonb_array_elements(v_snap.previous_prices)
    where value ->> 'product_id' = v_applied ->> 'product_id';
    if v_previous is null then
      raise exception 'price_list_auto_action_snapshot_missing' using errcode = 'P0002';
    end if;

    if (v_previous ->> 'existed')::boolean then
      update public.supplier_products
      set current_price = (v_previous ->> 'current_price')::numeric,
          previous_price = v_current.current_price,
          price_effective_date = v_effective_date,
          available = (v_previous ->> 'available')::boolean
      where id = v_current.id;
      insert into public.price_history (
        org_id, supplier_product_id, price, effective_date, created_by
      ) values (
        v_org, v_current.id, (v_previous ->> 'current_price')::numeric,
        v_effective_date, v_user
      );
    else
      update public.supplier_products
      set available = false
      where id = v_current.id;
    end if;
    if coalesce((v_previous ->> 'product_created')::boolean, false) then
      -- The snapshot cannot prove the catalog row is still unused. Disable only the supplier
      -- link created by this batch and preserve the product for later commerce and history.
      v_preserved_products := v_preserved_products + 1;
    end if;
    v_reverted := v_reverted + 1;
  end loop;

  update public.price_list_interpretation_decisions
  set reverted_at = clock_timestamp(),
      reverted_by = v_user,
      reverted_reason = v_reason
  where id = v_decision.id and org_id = v_org;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'price_list_auto_action_reverted',
    'price_list_interpretation_decisions', v_decision.id,
    jsonb_build_object(
      'submission_id', v_decision.submission_id,
      'accepted_count', v_decision.accepted_count,
      'outcome', v_decision.outcome
    ),
    jsonb_build_object(
      'reverted_price_count', v_reverted,
      'preserved_created_product_count', v_preserved_products
    ),
    v_reason
  );

  return jsonb_build_object(
    'decision_id', v_decision.id,
    'submission_id', v_decision.submission_id,
    'reverted_price_count', v_reverted,
    'preserved_created_product_count', v_preserved_products,
    'idempotent', false
  );
end
$$;

revoke all on function public.revert_price_list_auto_action(uuid, text)
  from public, anon, service_role;
grant execute on function public.revert_price_list_auto_action(uuid, text)
  to authenticated;

do $$
declare
  v_violations text;
begin
  if has_function_privilege(
       'service_role',
       'private.match_price_list_line(uuid,uuid,text,text)',
       'EXECUTE'
     ) then
    raise exception '0093 refused: service role can call the private matcher directly';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0093 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
