-- Remove the retired kitchen, payer and supplier login surfaces without rewriting history.
--
-- The enum values, inactive profiles, supplier_id references, business rows and audit evidence
-- remain valid historical vocabulary. Browser identity is deliberately narrower: only owner,
-- office and accountant may resolve a tenant. This migration also rewrites every live RLS policy
-- so a retired enum literal cannot survive as a dormant authenticated branch.

-- ===== One active-persona boundary for every tenant surface =====

create or replace function public.auth_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select profile.role
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active
    and profile.role in ('owner', 'office', 'accountant')
$$;

create or replace function public.auth_org() returns uuid
language sql stable security definer set search_path = public as $$
  select profile.org_id
  from public.profiles profile
  join public.organizations organization on organization.id = profile.org_id
  where profile.id = auth.uid()
    and profile.active
    and profile.role in ('owner', 'office', 'accountant')
    and organization.status <> 'suspended'
$$;

revoke all on function public.auth_role() from public, anon;
revoke all on function public.auth_org() from public, anon;
grant execute on function public.auth_role() to authenticated, service_role;
grant execute on function public.auth_org() to authenticated, service_role;

comment on function public.auth_role() is
  'Active browser role. Historical kitchen, payer and supplier profiles deliberately resolve NULL.';
comment on function public.auth_org() is
  'Tenant boundary for active owner, office and accountant profiles in a non-suspended organization.';

-- ===== Invitation and profile commands reject retired roles before any write =====

do $patch_active_roles$
declare
  v_signature regprocedure;
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  v_signature := 'public.create_invitation(text,public.user_role,uuid)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := replace($anchor$  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then$anchor$, e'\r', '');
  v_replacement := replace($replacement$  if p_role not in ('owner', 'office', 'accountant')
     or p_supplier_id is not null then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then$replacement$, e'\r', '');
  if position(v_anchor in v_definition) = 0 then
    raise exception '0133: create_invitation authorization anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);

  v_signature := 'public.manage_profile_access(uuid,public.user_role,boolean,uuid,text)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := replace($anchor$  if p_profile_id = v_actor then$anchor$, e'\r', '');
  v_replacement := replace($replacement$  if p_active and (
    p_role not in ('owner', 'office', 'accountant') or p_supplier_id is not null
  ) then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;
  if p_profile_id = v_actor then$replacement$, e'\r', '');
  if position(v_anchor in v_definition) = 0 then
    raise exception '0133: manage_profile_access authorization anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);

  -- The four-argument terms wrapper delegates to this internal three-argument command.
  v_signature := 'public.accept_invitation(text,text,text)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := replace($anchor$  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;$anchor$, e'\r', '');
  v_replacement := replace($replacement$  if inv.role not in ('owner', 'office', 'accountant') or inv.supplier_id is not null then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;
  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;$replacement$, e'\r', '');
  if position(v_anchor in v_definition) = 0 then
    raise exception '0133: accept_invitation authorization anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_active_roles$;

-- ===== Retired supplier login surface =====

delete from private.scope_definer_enforcements
where function_signature in (
  'supplier_portal_context()',
  'supplier_price_document_owned(uuid,uuid,uuid)'
);
delete from private.scope_definer_exemptions
where function_signature in (
  'supplier_portal_context()',
  'public.supplier_portal_context()'
);
drop function if exists public.supplier_portal_context();

drop policy if exists supplier_price_documents_select on public.documents;
drop policy if exists supplier_price_document_jobs_select on public.document_processing_jobs;
drop policy if exists supplier_price_document_extractions_select on public.document_extractions;
drop policy if exists supplier_price_document_interpretations_select on public.document_interpretations;
drop policy if exists supplier_price_document_annotations_select on public.document_annotations;
drop policy if exists supplier_price_document_review_corrections_select
  on public.document_review_corrections;
drop policy if exists supplier_price_document_type_review_decisions_select
  on public.document_type_review_decisions;
drop policy if exists supplier_price_documents_storage_insert on storage.objects;
drop policy if exists supplier_price_documents_storage_select on storage.objects;
drop policy if exists supplier_price_documents_storage_delete on storage.objects;

-- ===== Explicit active product policies =====

drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select to authenticated
using (id = public.auth_org());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
using (org_id = public.auth_org());

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'office')
);

drop policy if exists supplier_products_select on public.supplier_products;
create policy supplier_products_select on public.supplier_products for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'office')
);

drop policy if exists price_history_select on public.price_history;
create policy price_history_select on public.price_history for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'office')
);

drop policy if exists supplier_price_submissions_select on public.supplier_price_submissions;
create policy supplier_price_submissions_select
on public.supplier_price_submissions for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'office')
);

drop policy if exists price_list_interpretation_decisions_select
  on public.price_list_interpretation_decisions;
create policy price_list_interpretation_decisions_select
on public.price_list_interpretation_decisions for select to authenticated using (
  org_id = public.auth_org()
  and actor_id = auth.uid()
  and exists (
    select 1 from public.profiles profile
    where profile.org_id = price_list_interpretation_decisions.org_id
      and profile.id = auth.uid()
      and profile.active
      and profile.role in ('owner', 'office')
  )
);

drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'office')
);

drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests for select to authenticated using (
  org_id = public.auth_org()
  and (
    public.auth_role() in ('owner', 'office')
    or (
      public.auth_role() = 'accountant'
      and status in ('approved', 'sent_for_execution', 'executed', 'matched')
      and public.p0_accountant_payment_request_ready(org_id, id)
    )
  )
);

drop policy if exists pri2_select on public.payment_request_invoices;
create policy pri2_select on public.payment_request_invoices for select to authenticated using (
  org_id = public.auth_org()
  and exists (
    select 1 from public.payment_requests request
    where request.org_id = payment_request_invoices.org_id
      and request.id = payment_request_invoices.payment_request_id
      and (
        public.auth_role() in ('owner', 'office')
        or (
          public.auth_role() = 'accountant'
          and request.status in ('approved', 'sent_for_execution', 'executed', 'matched')
          and public.p0_accountant_payment_request_ready(request.org_id, request.id)
        )
      )
  )
);

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated using (
  org_id = public.auth_org()
  and public.auth_role() in ('owner', 'accountant')
);

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (
  org_id = public.auth_org()
  and (
    public.auth_role() in ('owner', 'office')
    or (public.auth_role() = 'accountant' and review_status = 'approved')
  )
);

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  org_id = public.auth_org()
  and uploaded_by = auth.uid()
  and storage_path like public.auth_org()::text || '/%'
  and entity_type in ('inbox', 'invoice', 'goods_receipt', 'payment', 'supplier')
  and mime_type is not null
  and public.smart_document_mime_allowed(mime_type)
  and public.p0_document_object_owned(storage_path, mime_type)
  and (
    public.auth_role() in ('owner', 'office')
    or (
      public.auth_role() = 'accountant'
      and entity_type = 'payment'
      and exists (
        select 1 from public.payments payment
        where payment.org_id = documents.org_id
          and payment.id = documents.entity_id
          and payment.executed_by = auth.uid()
      )
    )
  )
);

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated using (
  org_id = public.auth_org() and (
    public.auth_role() in ('owner', 'office')
    or (public.auth_role() = 'accountant' and (
      (entity_type = 'invoice' and exists (
        select 1 from public.invoices invoice
        where invoice.org_id = documents.org_id and invoice.id = documents.entity_id
          and invoice.review_status = 'approved'
      ))
      or (entity_type = 'goods_receipt' and exists (
        select 1
        from public.invoice_receipt_links receipt_link
        join public.invoices invoice
          on invoice.org_id = receipt_link.org_id and invoice.id = receipt_link.invoice_id
        where receipt_link.org_id = documents.org_id
          and receipt_link.receipt_id = documents.entity_id
          and invoice.review_status = 'approved'
      ))
      or (entity_type = 'payment' and exists (
        select 1 from public.payments payment
        where payment.org_id = documents.org_id and payment.id = documents.entity_id
      ))
    ))
  )
);

drop policy if exists docs_storage_read on storage.objects;
create policy docs_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'documents'
  and (
    exists (
      select 1 from public.documents document
      where document.storage_path = storage.objects.name
        and document.org_id = public.auth_org()
        and (
          public.auth_role() in ('owner', 'office')
          or (public.auth_role() = 'accountant' and (
            (document.entity_type = 'invoice' and exists (
              select 1 from public.invoices invoice
              where invoice.org_id = document.org_id and invoice.id = document.entity_id
                and invoice.review_status = 'approved'
            ))
            or (document.entity_type = 'goods_receipt' and exists (
              select 1
              from public.invoice_receipt_links receipt_link
              join public.invoices invoice
                on invoice.org_id = receipt_link.org_id and invoice.id = receipt_link.invoice_id
              where receipt_link.org_id = document.org_id
                and receipt_link.receipt_id = document.entity_id
                and invoice.review_status = 'approved'
            ))
            or (document.entity_type = 'payment' and exists (
              select 1 from public.payments payment
              where payment.org_id = document.org_id and payment.id = document.entity_id
            ))
          ))
        )
    )
    or exists (
      select 1 from public.document_exports export
      where export.storage_path = storage.objects.name
        and export.org_id = public.auth_org()
        and public.auth_role() in ('owner', 'office')
        and exists (
          select 1 from public.document_export_templates template
          where template.org_id = export.org_id and template.id = export.template_id
            and (template.owner_user_id is null or template.owner_user_id = auth.uid())
        )
    )
  )
);

drop policy if exists price_submissions_storage_insert on storage.objects;
create policy price_submissions_storage_insert
on storage.objects for insert to authenticated with check (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = public.auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (storage.foldername(name))[4]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.auth_role() in ('owner', 'office')
  and exists (
    select 1 from public.suppliers supplier
    where supplier.org_id = public.auth_org()
      and supplier.id::text = (storage.foldername(storage.objects.name))[3]
      and supplier.deleted_at is null
  )
);

drop policy if exists price_submissions_storage_delete on storage.objects;
create policy price_submissions_storage_delete
on storage.objects for delete to authenticated using (
  public.organization_write_allowed()
  and bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = public.auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and public.auth_role() in ('owner', 'office')
  and exists (
    select 1 from public.suppliers supplier
    where supplier.org_id = public.auth_org()
      and supplier.id::text = (storage.foldername(storage.objects.name))[3]
      and supplier.deleted_at is null
  )
  and not public.p1b_price_intake_is_active(name)
  and not exists (
    select 1 from public.supplier_price_submissions submission
    where submission.org_id = public.auth_org()
      and submission.storage_path = storage.objects.name
  )
);

-- The complex equality branches were replaced explicitly above. What remains is the repeated
-- kitchen member inside active-role IN lists. pg_get_expr renders those lists as typed arrays;
-- remove the member itself so the live policy contains no dormant NULL or retired branch.
do $narrow_policies$
declare
  policy_row record;
  v_using text;
  v_check text;
  v_sql text;
begin
  for policy_row in
    select namespace.nspname as schema_name, relation.relname as table_name,
           policy.polname as policy_name,
           pg_get_expr(policy.polqual, policy.polrelid) as using_expression,
           pg_get_expr(policy.polwithcheck, policy.polrelid) as check_expression
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'storage')
  loop
    v_using := policy_row.using_expression;
    v_check := policy_row.check_expression;
    foreach v_sql in array array['kitchen', 'payer', 'supplier'] loop
      v_using := regexp_replace(
        v_using,
        ',[[:space:]]*''' || v_sql || '''::(public\.)?user_role',
        '', 'gi'
      );
      v_using := regexp_replace(
        v_using,
        '''' || v_sql || '''::(public\.)?user_role[[:space:]]*,[[:space:]]*',
        '', 'gi'
      );
      v_check := regexp_replace(
        v_check,
        ',[[:space:]]*''' || v_sql || '''::(public\.)?user_role',
        '', 'gi'
      );
      v_check := regexp_replace(
        v_check,
        '''' || v_sql || '''::(public\.)?user_role[[:space:]]*,[[:space:]]*',
        '', 'gi'
      );
    end loop;
    if v_using is distinct from policy_row.using_expression
       or v_check is distinct from policy_row.check_expression then
      v_sql := format(
        'alter policy %I on %I.%I',
        policy_row.policy_name, policy_row.schema_name, policy_row.table_name
      );
      if v_using is not null then
        v_sql := v_sql || format(' using (%s)', v_using);
      end if;
      if v_check is not null then
        v_sql := v_sql || format(' with check (%s)', v_check);
      end if;
      execute v_sql;
    end if;
  end loop;
end
$narrow_policies$;

-- Remove the supplier-persona branches themselves before dropping the helpers they called.
-- Each edit is anchored against the live catalog definition and therefore fails the migration
-- if a later migration moved the authorization boundary.
do $remove_retired_function_branches$
declare
  patch_row record;
  v_definition text;
begin
  for patch_row in
    select * from (values
      (
        'public.create_invitation(text,public.user_role,uuid)'::regprocedure,
        $anchor$  if (p_role = 'supplier') is distinct from (p_supplier_id is not null) then
    raise exception 'supplier_invitation_requires_supplier' using errcode = '22023';
  end if;
$anchor$,
        ''
      ),
      (
        'public.create_invitation(text,public.user_role)'::regprocedure,
        $anchor$  if p_role = 'supplier' then
    raise exception 'supplier_invitation_requires_supplier' using errcode = '22023';
  end if;
$anchor$,
        ''
      ),
      (
        'public.manage_profile_access(uuid,public.user_role,boolean,uuid,text)'::regprocedure,
        $anchor$  if (p_role = 'supplier') is distinct from (p_supplier_id is not null) then
    raise exception 'supplier_profile_requires_supplier' using errcode = '22023';
  end if;
$anchor$,
        ''
      ),
      (
        'public.global_search(text,integer)'::regprocedure,
        $anchor$    when 'kitchen'    then array['product', 'invoice', 'order', 'credit']
$anchor$,
        ''
      ),
      (
        'public.reserve_supplier_price_document_upload(uuid,text,text)'::regprocedure,
        $anchor$  v_profile_supplier uuid;
$anchor$,
        ''
      ),
      (
        'public.reserve_supplier_price_document_upload(uuid,text,text)'::regprocedure,
        '  select p.role, p.supplier_id into v_role, v_profile_supplier',
        '  select p.role into v_role'
      ),
      (
        'public.reserve_supplier_price_document_upload(uuid,text,text)'::regprocedure,
        $anchor$     or (v_role = 'supplier' and v_profile_supplier is distinct from p_supplier_id)$anchor$,
        ''
      ),
      (
        'public.renew_supplier_price_document_upload(uuid)'::regprocedure,
        $anchor$  v_profile_supplier uuid;
$anchor$,
        ''
      ),
      (
        'public.renew_supplier_price_document_upload(uuid)'::regprocedure,
        '  select p.role, p.supplier_id into v_role, v_profile_supplier',
        '  select p.role into v_role'
      ),
      (
        'public.renew_supplier_price_document_upload(uuid)'::regprocedure,
        $anchor$  if v_role = 'supplier'
     and v_profile_supplier is distinct from v_reservation.supplier_id then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.register_supplier_price_document(uuid)'::regprocedure,
        $anchor$  v_profile_supplier uuid;
$anchor$,
        ''
      ),
      (
        'public.register_supplier_price_document(uuid)'::regprocedure,
        '  select p.role, p.supplier_id into v_role, v_profile_supplier',
        '  select p.role into v_role'
      ),
      (
        'public.register_supplier_price_document(uuid)'::regprocedure,
        $anchor$  if v_role = 'supplier'
     and v_profile_supplier is distinct from v_reservation.supplier_id then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.enqueue_document_processing(uuid)'::regprocedure,
        $anchor$  if v_role = 'supplier'
     and not public.supplier_price_document_owned(v_org, v_document.id, v_user) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.add_document_annotation(uuid,text,text,text,text,text,text,text)'::regprocedure,
        $anchor$    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
$anchor$,
        ''
      ),
      (
        'public.add_document_review_correction(uuid,text,text,integer,integer,text,text,text,text,text,integer)'::regprocedure,
        $anchor$    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
$anchor$,
        ''
      ),
      (
        'public.claim_supplier_price_intake(uuid,uuid,uuid,uuid,date,text,text,text)'::regprocedure,
        $anchor$  v_profile_supplier uuid;
$anchor$,
        ''
      ),
      (
        'public.claim_supplier_price_intake(uuid,uuid,uuid,uuid,date,text,text,text)'::regprocedure,
        $anchor$  select profile.org_id, profile.role, profile.supplier_id
    into v_org, v_role, v_profile_supplier
$anchor$,
        $replacement$  select profile.org_id, profile.role
    into v_org, v_role
$replacement$
      ),
      (
        'public.claim_supplier_price_intake(uuid,uuid,uuid,uuid,date,text,text,text)'::regprocedure,
        $anchor$     or (v_role = 'supplier' and v_profile_supplier is distinct from p_supplier_id)$anchor$,
        ''
      ),
      (
        'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure,
        $anchor$  v_supplier uuid := auth_supplier();
$anchor$,
        ''
      ),
      (
        'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure,
        $anchor$       or (v_role = 'supplier' and (v_supplier is null or row.supplier_id <> v_supplier))
$anchor$,
        ''
      ),
      (
        'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure,
        $anchor$  v_profile_supplier uuid;
$anchor$,
        ''
      ),
      (
        'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure,
        $anchor$  select p.org_id, p.role, p.supplier_id
    into v_org, v_role, v_profile_supplier
$anchor$,
        $replacement$  select p.org_id, p.role
    into v_org, v_role
$replacement$
      ),
      (
        'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure,
        $anchor$  if v_role = 'supplier'
     and v_profile_supplier is distinct from v_document.supplier_id then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure,
        $anchor$  v_auth_supplier uuid := auth_supplier();
$anchor$,
        ''
      ),
      (
        'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure,
        $anchor$  if v_role = 'supplier' and (v_auth_supplier is null or v_auth_supplier <> p_supplier_id) then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.submit_supplier_price_list(uuid)'::regprocedure,
        $anchor$  if v_role = 'supplier' and auth_supplier() is distinct from v_intake.supplier_id then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
$anchor$,
        ''
      ),
      (
        'public.transition_purchase_order_status(uuid,text,text,text,date)'::regprocedure,
        $anchor$  v_supplier uuid := public.auth_supplier();
$anchor$,
        ''
      ),
      (
        'public.transition_purchase_order_status(uuid,text,text,text,date)'::regprocedure,
        $anchor$  if v_role = 'supplier' and p_target_status <> 'confirmed' then
    raise exception 'purchase_order_status_not_authorized' using errcode = '42501';
  end if;
  -- A supplier may acknowledge the issued order, but may not silently negotiate a new
  -- delivery date through the generic staff confirmation parameter.
  if v_role = 'supplier' and p_expected_date is not null then
    raise exception 'purchase_order_confirmation_fields_invalid' using errcode = '22023';
  end if;
$anchor$,
        ''
      ),
      (
        'public.transition_purchase_order_status(uuid,text,text,text,date)'::regprocedure,
        $anchor$    and (v_role <> 'supplier' or po.supplier_id = v_supplier)
    and (v_role <> 'supplier' or po.unit_id is null or po.unit_id = any(public.auth_scopes()))
$anchor$,
        ''
      ),
      (
        'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure,
        $anchor$  v_emergency boolean := coalesce(
    auth_role() = 'owner'
    and current_setting('app.p0_owner_emergency_payment', true) = auth.uid()::text,
    false
  );
$anchor$,
        $replacement$  -- Kept only as a response/audit compatibility field; no bypass reads it.
  v_emergency boolean := false;
$replacement$
      ),
      (
        'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure,
        $anchor$  if v_org is null or v_user is null
     or (v_role not in ('payer', 'accountant') and not v_emergency) then
$anchor$,
        $replacement$  if v_org is null or v_user is null or v_role <> 'accountant' then
$replacement$
      )
    ) as patches(function_signature, anchor_text, replacement_text)
  loop
    v_definition := replace(pg_get_functiondef(patch_row.function_signature), e'\r', '');
    if position(patch_row.anchor_text in v_definition) = 0 then
      raise exception '0133: retired branch anchor moved for %', patch_row.function_signature;
    end if;
    execute replace(v_definition, patch_row.anchor_text, patch_row.replacement_text);
  end loop;
end
$remove_retired_function_branches$;

drop function public.supplier_price_upload_authorized(uuid, uuid, uuid);
drop function public.supplier_price_upload_reservation_active(text, text, uuid);
drop function public.supplier_price_document_owned(uuid, uuid, uuid);
drop function public.auth_supplier();

-- The three supplier-named interpretation wrappers remain only because 0132 must be able to
-- settle immutable provider evidence whose original actor was a now-retired supplier account.
-- Remove their ordinary active-profile branch so they cannot start new supplier-persona work.
do $historical_supplier_interpretation_only$
declare
  v_signature regprocedure :=
    'public.assert_supplier_price_interpretation_context(uuid,uuid,uuid)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text :=
    '    and (p.active or v_historical_recovery) and p.role = ''supplier''';
  v_replacement text :=
    '    and v_historical_recovery and p.role = ''supplier''';
begin
  if position(v_anchor in v_definition) = 0 then
    raise exception '0133: 0132 supplier evidence recovery anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$historical_supplier_interpretation_only$;

comment on function public.transition_purchase_order_status(uuid, text, text, text, date) is
  'Reasoned purchase-order transitions for active owner and office procurement staff.';

-- ===== Active RPC authorization gates =====

-- Patch only role vocabulary in browser-executable commands. Entity keys named "supplier" and
-- historical evidence branches remain business vocabulary; their caller role is resolved by the
-- active auth helpers above. Every exact replacement is asserted so migration drift fails closed.
do $narrow_functions$
declare
  function_row record;
  v_definition text;
  v_rewritten text;
begin
  for function_row in
    select procedure.oid
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  loop
    v_definition := replace(pg_get_functiondef(function_row.oid), e'\r', '');
    v_rewritten := v_definition;
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''kitchen'', ''accountant'')',
      '(''owner'', ''office'', ''accountant'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'',''office'',''kitchen'',''accountant'')',
      '(''owner'',''office'',''accountant'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''kitchen'', ''supplier'')',
      '(''owner'', ''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'',''office'',''kitchen'',''supplier'')',
      '(''owner'',''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''kitchen'')', '(''owner'', ''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'',''office'',''kitchen'')', '(''owner'',''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''supplier'')', '(''owner'', ''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'',''office'',''supplier'')', '(''owner'',''office'')');
    v_rewritten := replace(v_rewritten,
      '(''payer'', ''accountant'')', '(''accountant'')');
    v_rewritten := replace(v_rewritten,
      '(''payer'',''accountant'')', '(''accountant'')');
    if v_rewritten is distinct from v_definition then
      execute v_rewritten;
    end if;
  end loop;
end
$narrow_functions$;

-- Service-side document actor checks are not browser RPCs, but active processing must also start
-- only for owner/office actors. The 0132 recovery fences remain intact solely to replay already-
-- paid historical evidence, including evidence whose immutable actor was kitchen or supplier.
do $narrow_interpretation_actor$
declare
  v_signature regprocedure :=
    'public.assert_document_interpretation_actor(uuid,uuid)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_active_anchor text := replace($anchor$      and p.active
      and p.role in ('owner', 'office', 'kitchen')$anchor$, e'\r', '');
  v_active_replacement text := replace($replacement$      and p.active
      and p.role in ('owner', 'office')$replacement$, e'\r', '');
  v_recovery_anchor text := replace($anchor$         and p.role in ('owner', 'office', 'kitchen')$anchor$, e'\r', '');
begin
  if position(v_active_anchor in v_definition) = 0 then
    raise exception '0133: active interpretation actor anchor moved';
  end if;
  v_definition := replace(v_definition, v_active_anchor, v_active_replacement);
  if position(v_recovery_anchor in v_definition) = 0 then
    raise exception '0133: 0132 historical interpretation actor recovery fence moved';
  end if;
  execute v_definition;
end
$narrow_interpretation_actor$;

do $narrow_service_document_actors$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
begin
  foreach v_signature in array array[
    'private.claim_document_interpretation_jobs(integer,integer)'::regprocedure,
    'public.apply_delivery_note_interpretation(uuid,uuid,uuid)'::regprocedure,
    'public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure,
    'public.run_price_list_shadow(uuid,uuid,uuid)'::regprocedure,
    'public.claim_supplier_price_intake(uuid,uuid,uuid,uuid,date,text,text,text)'::regprocedure,
    'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure,
    'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure,
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure,
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text,uuid)'::regprocedure
  ] loop
    v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
    v_rewritten := v_definition;
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''kitchen'', ''supplier'')', '(''owner'', ''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''kitchen'')', '(''owner'', ''office'')');
    v_rewritten := replace(v_rewritten,
      '(''owner'', ''office'', ''supplier'')', '(''owner'', ''office'')');
    if v_rewritten is not distinct from v_definition then
      if v_definition ~* 'role[^;]+(''kitchen''|''supplier'')' then
        raise exception '0133: active document actor role anchor moved for %', v_signature;
      end if;
    else
      execute v_rewritten;
    end if;
  end loop;
end
$narrow_service_document_actors$;

-- Explicitly retire the payer branch in the payment executor. The owner emergency capability was
-- revoked by 0111 and its dormant internal bypass was removed above; accountant is the sole actor.
do $narrow_payment_executor$
declare
  v_signature regprocedure :=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_rewritten text;
begin
  v_rewritten := replace(
    replace(v_definition,
      '(''payer'', ''accountant'')', '(''accountant'')'),
      '(''payer'',''accountant'')', '(''accountant'')'
  );
  if v_rewritten is not distinct from v_definition then
    if position('''payer''' in v_definition) > 0 then
      raise exception '0133: execute_payment_request payer authorization anchor moved';
    end if;
  else
    execute v_rewritten;
  end if;
end
$narrow_payment_executor$;

-- Purchase-order transitions are now procurement staff only. Supplier confirmation was a login
-- persona surface; historical supplier business rows remain untouched.
do $narrow_purchase_order_transition$
declare
  v_signature regprocedure :=
    'public.transition_purchase_order_status(uuid,text,text,text,date)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_rewritten text;
begin
  v_rewritten := replace(
    replace(v_definition,
      '(''owner'', ''office'', ''kitchen'', ''supplier'')', '(''owner'', ''office'')'),
      '(''owner'',''office'',''kitchen'',''supplier'')', '(''owner'',''office'')'
  );
  if v_rewritten is not distinct from v_definition then
    if v_definition ~* 'v_role not in[^;]+(''kitchen''|''supplier'')' then
      raise exception '0133: transition_purchase_order_status role anchor moved';
    end if;
  else
    execute v_rewritten;
  end if;
end
$narrow_purchase_order_transition$;

-- Financial balance functions carried the last payer branch outside policies.
create or replace function public.p0_invoice_balance_rows()
returns table (
  invoice_id uuid, total_amount numeric(12,2), paid_amount numeric(12,2),
  credited_amount numeric(12,2), balance numeric(12,2)
)
language sql stable security definer set search_path = public as $$
  with paid as (
    select allocation.org_id, allocation.invoice_id, sum(allocation.amount) as amount
    from public.payment_allocations allocation
    where allocation.org_id = public.auth_org() and allocation.invoice_id is not null
    group by allocation.org_id, allocation.invoice_id
  ), credited as (
    select credit.org_id, credit.invoice_id, sum(credit.amount) as amount
    from public.credit_requests credit
    where credit.org_id = public.auth_org() and credit.invoice_id is not null
      and credit.status in ('offset', 'closed')
    group by credit.org_id, credit.invoice_id
  )
  select invoice.id, invoice.total_amount,
         coalesce(paid.amount, 0)::numeric(12,2),
         coalesce(credited.amount, 0)::numeric(12,2),
         (invoice.total_amount - coalesce(paid.amount, 0) - coalesce(credited.amount, 0))::numeric(12,2)
  from public.invoices invoice
  left join paid on paid.org_id = invoice.org_id and paid.invoice_id = invoice.id
  left join credited on credited.org_id = invoice.org_id and credited.invoice_id = invoice.id
  where invoice.org_id = public.auth_org() and invoice.deleted_at is null
    and (invoice.unit_id is null or invoice.unit_id = any(public.auth_scopes()))
    and (
      public.auth_role() = 'owner'
      or (public.auth_role() = 'accountant' and invoice.review_status = 'approved')
    )
$$;

create or replace function public.p0_supplier_balance_rows()
returns table (supplier_id uuid, open_balance numeric(12,2), open_invoices bigint)
language sql stable security definer set search_path = public as $$
  with balances as (select * from public.p0_invoice_balance_rows())
  select supplier.id,
         coalesce(sum(balance.balance), 0)::numeric(12,2),
         count(balance.invoice_id) filter (where balance.balance > 0)
  from public.suppliers supplier
  left join public.invoices invoice
    on invoice.org_id = supplier.org_id and invoice.supplier_id = supplier.id
   and invoice.deleted_at is null
   and (invoice.unit_id is null or invoice.unit_id = any(public.auth_scopes()))
  left join balances balance on balance.invoice_id = invoice.id
  where supplier.org_id = public.auth_org()
    and public.auth_role() in ('owner', 'accountant')
  group by supplier.id
$$;

-- Accountant/office/owner may read the narrow financial identity directory. Raw bank details stay
-- column-revoked as established by 0112.
create or replace view public.financial_supplier_directory
with (security_barrier = true)
as
select supplier.id, supplier.name, supplier.tax_id, supplier.payment_terms,
       supplier.status, supplier.bank_details
from public.suppliers supplier
where supplier.org_id = public.auth_org()
  and auth.uid() is not null
  and public.auth_role() in ('owner', 'office', 'accountant');

revoke all on public.financial_supplier_directory from public, anon, authenticated;
grant select on public.financial_supplier_directory to authenticated;

comment on view public.financial_supplier_directory is
  'Tenant-scoped financial supplier identity for owner, office and accountant only.';

-- Refresh the body pins of reviewed SECURITY DEFINER functions changed intentionally above.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(procedure.prosrc, e'\r', ''))
from pg_catalog.pg_proc procedure
where procedure.oid = to_regprocedure(enforcement.function_signature);

-- ===== Migration self-check =====

do $self_check$
declare
  v_violations text;
begin
  if to_regprocedure('public.supplier_portal_context()') is not null then
    raise exception '0133: supplier portal RPC remains';
  end if;
  if to_regprocedure('public.auth_supplier()') is not null then
    raise exception '0133: retired supplier identity helper remains';
  end if;
  if to_regprocedure('public.supplier_price_upload_authorized(uuid,uuid,uuid)') is not null
     or to_regprocedure('public.supplier_price_upload_reservation_active(text,text,uuid)') is not null
     or to_regprocedure('public.supplier_price_document_owned(uuid,uuid,uuid)') is not null then
    raise exception '0133: retired supplier-login helper remains';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc procedure
    where procedure.prosrc like '%auth_supplier(%'
       or procedure.prosrc like '%supplier_price_upload_authorized(%'
       or procedure.prosrc like '%supplier_price_upload_reservation_active(%'
       or procedure.prosrc like '%supplier_price_document_owned(%'
  ) then
    raise exception '0133: function body still depends on a retired supplier-login helper';
  end if;
  if exists (
    select 1 from private.scope_definer_enforcements
    where function_signature in (
      'supplier_portal_context()',
      'supplier_price_document_owned(uuid,uuid,uuid)'
    )
  ) then
    raise exception '0133: retired supplier-login scope registration remains';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'storage')
      and (
        policy.polroles = array[0::oid]
        or 'authenticated'::regrole::oid = any(policy.polroles)
      )
      and (
        coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')
        || ' ' || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
      ) ~* '''(kitchen|payer|supplier)''::(public\.)?user_role'
  ) then
    raise exception '0133: authenticated RLS still contains a retired persona role';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'storage')
      and relation.relkind = 'v'
      and has_table_privilege('authenticated', relation.oid, 'SELECT')
      and (
        pg_get_viewdef(relation.oid) ~*
          '(auth_role\(\)|[.]role)[^;]{0,120}''(kitchen|payer|supplier)'''
        or pg_get_viewdef(relation.oid) ~*
          '''(kitchen|payer|supplier)''[^;]{0,120}(auth_role\(\)|[.]role)'
      )
  ) then
    raise exception '0133: authenticated view still contains a retired persona role';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname in ('public', 'storage')
      and policyname in (
        'supplier_price_documents_select',
        'supplier_price_document_jobs_select',
        'supplier_price_document_extractions_select',
        'supplier_price_document_interpretations_select',
        'supplier_price_document_annotations_select',
        'supplier_price_document_review_corrections_select',
        'supplier_price_document_type_review_decisions_select',
        'supplier_price_documents_storage_insert',
        'supplier_price_documents_storage_select',
        'supplier_price_documents_storage_delete'
      )
  ) then
    raise exception '0133: retired supplier persona policy remains';
  end if;
  if position('''payer''' in pg_get_functiondef(
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure
     )) > 0
     or position('p0_owner_emergency_payment' in pg_get_functiondef(
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure
     )) > 0 then
    raise exception '0133: payment executor still contains a retired execution branch';
  end if;
  if pg_get_functiondef(
       'public.transition_purchase_order_status(uuid,text,text,text,date)'::regprocedure
     ) ~* 'v_role not in[^;]+(kitchen|supplier)' then
    raise exception '0133: purchase-order transition still authorizes a retired persona';
  end if;
  if not (
    pg_get_functiondef('public.auth_role()'::regprocedure)
      ~* 'role in \(''owner'', ''office'', ''accountant''\)'
    and pg_get_functiondef('public.auth_org()'::regprocedure)
      ~* 'role in \(''owner'', ''office'', ''accountant''\)'
  ) then
    raise exception '0133: active auth helper contract is not pinned to three roles';
  end if;
  if position(
       replace($pin$      and p.active
      and p.role in ('owner', 'office')$pin$, e'\r', ''),
       replace(pg_get_functiondef(
         'public.assert_document_interpretation_actor(uuid,uuid)'::regprocedure
       ), e'\r', '')
     ) = 0
     or position(
       replace($pin$         and p.role in ('owner', 'office', 'kitchen')$pin$, e'\r', ''),
       replace(pg_get_functiondef(
         'public.assert_document_interpretation_actor(uuid,uuid)'::regprocedure
       ), e'\r', '')
     ) = 0 then
    raise exception '0133: active interpretation roles or the 0132 kitchen recovery fence drifted';
  end if;
  if position(
       'and v_historical_recovery and p.role = ''supplier''',
       pg_get_functiondef(
         'public.assert_supplier_price_interpretation_context(uuid,uuid,uuid)'::regprocedure
       )
     ) = 0 then
    raise exception '0133: supplier interpretation is not restricted to 0132 evidence recovery';
  end if;

  select string_agg(procedure.oid::regprocedure::text, ', ' order by procedure.oid::regprocedure::text)
    into v_violations
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and has_schema_privilege('authenticated', namespace.oid, 'USAGE')
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
    and procedure.prorettype <> 'pg_catalog.trigger'::regtype
    and procedure.oid::regprocedure::text not in (
      'guard_retired_product_invitation()',
      'guard_retired_product_profile()',
      'assert_supplier_price_interpretation_context(uuid,uuid,uuid)',
      'service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)'
    )
    and (
      procedure.prosrc ~* '(auth_role\(\)|v_role|profile\.role|p\.role|inv\.role|new\.role|old\.role)[^;]{0,220}''(kitchen|payer|supplier)'''
      or procedure.prosrc ~* '''(kitchen|payer|supplier)''[^;]{0,220}(auth_role\(\)|v_role|profile\.role|p\.role|inv\.role|new\.role|old\.role)'
    );
  if v_violations is not null then
    raise exception '0133: live function authorization still contains a retired persona: %',
      v_violations;
  end if;

  if has_function_privilege(
       'authenticated',
       'public.assert_supplier_price_interpretation_context(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)',
       'EXECUTE'
     ) then
    raise exception '0133: historical supplier-evidence recovery is browser executable';
  end if;
  if has_function_privilege(
       'authenticated',
       'public.begin_supplier_price_interpretation(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.save_supplier_price_interpretation(uuid,uuid,uuid,timestamptz,text,text,text,text,jsonb,jsonb,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.fail_supplier_price_interpretation(uuid,uuid,uuid,timestamptz,text,text)',
       'EXECUTE'
     ) then
    raise exception '0133: historical supplier-evidence wrapper is browser executable';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0133 scope assertions failed:\n%', v_violations;
  end if;
end
$self_check$;
