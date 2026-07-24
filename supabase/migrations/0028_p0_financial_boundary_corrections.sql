-- P0 follow-up: close the financial boundary gaps found after the persona-contract cutover.
-- Forward-only after 0025. Migration numbers 0026/0027 are owned by the parallel P1 streams.

-- Fresh CLI installs can create application tables before Supabase's browser-role DDL grant
-- hook is present. Restore only the table ACL needed by an existing authenticated/PUBLIC read
-- policy. Views keep their explicit grants, and service-only or non-RLS tables stay inaccessible.
do $$
declare
  v_relation record;
begin
  for v_relation in
    select n.nspname as schema_name, c.relname as relation_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and exists (
        select 1
        from pg_catalog.pg_policy p
        where p.polrelid = c.oid
          and p.polcmd in ('r', '*')
          and (
            0::oid = any(p.polroles)
            or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(p.polroles)
          )
      )
  loop
    execute format(
      'grant select on table %I.%I to authenticated',
      v_relation.schema_name,
      v_relation.relation_name
    );
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and has_table_privilege('authenticated', c.oid, 'SELECT')
  ) then
    raise exception 'authenticated_select_on_non_rls_table' using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and exists (
        select 1
        from pg_catalog.pg_policy p
        where p.polrelid = c.oid
          and p.polcmd in ('r', '*')
          and (
            0::oid = any(p.polroles)
            or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(p.polroles)
          )
      )
      and not has_table_privilege('authenticated', c.oid, 'SELECT')
  ) then
    raise exception 'authenticated_select_missing_for_rls_table' using errcode = '42501';
  end if;
end
$$;

-- ===== Invoice soft delete is one atomic, reasoned command =====

create or replace function public.p0_invoice_soft_delete_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p0_invoice_soft_delete_writer', true)
                          is not distinct from auth.uid()::text;
begin
  if new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;

  -- Trusted migrations/seeds have no end-user subject. Every authenticated mutation must use
  -- soft_delete_invoice so the reference check, row update and reasoned audit stay atomic.
  if v_user is null or v_authorized then
    return new;
  end if;

  raise exception 'invoice_soft_delete_rpc_required' using errcode = '42501';
end
$$;

drop trigger if exists p0_invoice_soft_delete_guard on public.invoices;
create trigger p0_invoice_soft_delete_guard
  before update of deleted_at on public.invoices
  for each row execute function public.p0_invoice_soft_delete_guard();

create or replace function public.soft_delete_invoice(
  p_invoice_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_invoice public.invoices;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'invoice_soft_delete_not_authorized' using errcode = '42501';
  end if;
  if p_invoice_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id and i.org_id = v_org
  for update;

  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_invoice.deleted_at is not null then
    return jsonb_build_object(
      'invoice_id', v_invoice.id,
      'status', 'deleted',
      'idempotent', true
    );
  end if;

  -- A financial reference is historical evidence, even when its current workflow status is
  -- cancelled or closed. It must be corrected through its owning command, never hidden by
  -- soft-deleting the invoice. The invoice row lock serializes with those commands.
  if v_invoice.payment_status <> 'unpaid'
     or v_invoice.export_status <> 'not_sent'
     or exists (
       select 1 from public.payment_request_invoices pri
       where pri.org_id = v_org and pri.invoice_id = v_invoice.id
     )
     or exists (
       select 1 from public.payment_allocations pa
       where pa.org_id = v_org and pa.invoice_id = v_invoice.id
     )
     or exists (
       select 1 from public.bank_allocations ba
       where ba.org_id = v_org and ba.invoice_id = v_invoice.id
     )
     or exists (
       select 1 from public.credit_requests cr
       where cr.org_id = v_org and cr.invoice_id = v_invoice.id
     )
     or exists (
       select 1 from public.monthly_exports me
       where me.org_id = v_org and v_invoice.id = any(coalesce(me.invoice_ids, '{}'::uuid[]))
     ) then
    raise exception 'invoice_has_financial_references' using errcode = 'P0001';
  end if;

  perform set_config('app.p0_invoice_soft_delete_writer', v_user::text, true);
  begin
    update public.invoices
    set deleted_at = clock_timestamp()
    where id = v_invoice.id and org_id = v_org;
  exception when others then
    perform set_config('app.p0_invoice_soft_delete_writer', '', true);
    raise;
  end;
  perform set_config('app.p0_invoice_soft_delete_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'invoice_soft_deleted', 'invoices', v_invoice.id,
    jsonb_build_object('deleted_at', v_invoice.deleted_at),
    jsonb_build_object('deleted_at', (select i.deleted_at from public.invoices i where i.id = v_invoice.id)),
    v_reason
  );

  return jsonb_build_object(
    'invoice_id', v_invoice.id,
    'status', 'deleted',
    'idempotent', false
  );
end
$$;

revoke all on function public.soft_delete_invoice(uuid, text) from public;
grant execute on function public.soft_delete_invoice(uuid, text) to authenticated;

-- ===== Preflight signals never expand a role's financial visibility =====

create or replace function public.invoice_financial_check_signals(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_invoice public.invoices;
  v_bank_match boolean := false;
  v_already_paid boolean;
  v_balance numeric;
begin
  if v_org is null or auth.uid() is null
     or v_role not in ('owner', 'office', 'kitchen', 'accountant') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id and i.org_id = v_org and i.deleted_at is null;

  if not found or (v_role = 'accountant' and v_invoice.review_status <> 'approved') then
    raise exception 'invoice_unknown' using errcode = 'P0002';
  end if;

  if v_role in ('owner', 'accountant') then
    select exists (
      select 1
      from public.bank_allocations ba
      where ba.org_id = v_org and ba.invoice_id = v_invoice.id and ba.confirmed
    ) into v_bank_match;

    select v_invoice.total_amount
           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       where pa.org_id = v_org and pa.invoice_id = v_invoice.id), 0)
           - coalesce((select sum(cr.amount) from public.credit_requests cr
                       where cr.org_id = v_org and cr.invoice_id = v_invoice.id
                         and cr.status in ('offset', 'closed')), 0)
      into v_balance;
    v_already_paid := v_balance <= 0;
  else
    -- Procurement roles may already read the invoice's coarse payment status. They never get
    -- a bank fact or a balance-derived oracle from this SECURITY DEFINER function.
    v_bank_match := false;
    v_already_paid := v_invoice.payment_status = 'paid';
  end if;

  return jsonb_build_object(
    'bank_match_exists', v_bank_match,
    'already_paid', v_already_paid
  );
end
$$;

create or replace function public.payment_request_financial_check_signals(
  p_supplier_id uuid,
  p_amount numeric,
  p_invoice_ids uuid[],
  p_payment_request_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_requested_count int;
  v_visible_count int;
  v_paid_count int;
  v_unapproved_count int;
  v_open_balance numeric := 0;
  v_amount_matches boolean := true;
  v_similar_bank boolean := false;
begin
  if v_org is null or auth.uid() is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or p_amount is null or p_amount <= 0
     or p_invoice_ids is null or array_position(p_invoice_ids, null) is not null then
    raise exception 'payment_request_checks_invalid' using errcode = '22023';
  end if;

  -- When checks are attached to an existing request, bind every caller-controlled input to
  -- that request. Creation checks keep p_payment_request_id null.
  if p_payment_request_id is not null and not exists (
    select 1
    from public.payment_requests pr
    where pr.id = p_payment_request_id
      and pr.org_id = v_org
      and pr.supplier_id = p_supplier_id
      and round(pr.amount, 2) = round(p_amount, 2)
      and coalesce((
        select array_agg(pri.invoice_id order by pri.invoice_id)
        from public.payment_request_invoices pri
        where pri.org_id = v_org and pri.payment_request_id = pr.id
      ), '{}'::uuid[]) = coalesce((
        select array_agg(requested.id order by requested.id)
        from (select distinct unnest(p_invoice_ids) as id) requested
      ), '{}'::uuid[])
  ) then
    raise exception 'payment_request_checks_mismatch' using errcode = '22023';
  end if;

  select count(*) into v_requested_count
  from (select distinct unnest(p_invoice_ids) as id) requested;

  with requested as (
    select distinct unnest(p_invoice_ids) as id
  ), visible as (
    select i.id, i.review_status, i.payment_status
    from requested r
    join public.invoices i on i.id = r.id
    where i.org_id = v_org and i.supplier_id = p_supplier_id and i.deleted_at is null
  )
  select count(*),
         count(*) filter (where payment_status = 'paid'),
         count(*) filter (where review_status <> 'approved')
    into v_visible_count, v_paid_count, v_unapproved_count
  from visible;

  if v_role = 'owner' then
    with requested as (
      select distinct unnest(p_invoice_ids) as id
    ), balances as (
      select i.total_amount
             - coalesce((select sum(pa.amount) from public.payment_allocations pa
                         where pa.org_id = v_org and pa.invoice_id = i.id), 0)
             - coalesce((select sum(cr.amount) from public.credit_requests cr
                         where cr.org_id = v_org and cr.invoice_id = i.id
                           and cr.status in ('offset', 'closed')), 0) as balance
      from requested r
      join public.invoices i on i.id = r.id
      where i.org_id = v_org and i.supplier_id = p_supplier_id and i.deleted_at is null
    )
    select count(*) filter (where balance <= 0),
           coalesce(sum(greatest(balance, 0)), 0)
      into v_paid_count, v_open_balance
    from balances;

    v_amount_matches := abs(round(v_open_balance, 2) - round(p_amount, 2)) <= 1;

    select exists (
      select 1
      from public.bank_transactions bt
      where bt.org_id = v_org
        and bt.supplier_id = p_supplier_id
        and round(bt.amount, 2) = round(p_amount, 2)
        and bt.is_debit
        and bt.tx_date >= current_date - 45
    ) into v_similar_bank;
  else
    -- Office can approve against invoice status and the authoritative transition command, but
    -- cannot probe hidden balances or bank transfers by varying p_amount.
    v_amount_matches := true;
    v_similar_bank := false;
  end if;

  return jsonb_build_object(
    'requested_invoice_count', v_requested_count,
    'visible_invoice_count', v_visible_count,
    'paid_invoice_count', v_paid_count,
    'unapproved_invoice_count', v_unapproved_count,
    'amount_matches_open_balance', v_amount_matches,
    'similar_bank_transfer_exists', v_similar_bank
  );
end
$$;

revoke all on function public.invoice_financial_check_signals(uuid) from public;
revoke all on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid) from public;
grant execute on function public.invoice_financial_check_signals(uuid) to authenticated;
grant execute on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid) to authenticated;

-- ===== Accountant queue visibility follows current invoice readiness =====

create or replace function public.p0_accountant_payment_request_ready(
  p_org_id uuid,
  p_payment_request_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or auth_role() <> 'accountant'
     or p_org_id is null or p_org_id <> auth_org() or p_payment_request_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.payment_request_invoices pri
    where pri.org_id = p_org_id and pri.payment_request_id = p_payment_request_id
  ) and not exists (
    select 1
    from public.payment_request_invoices pri
    left join public.invoices i
      on i.org_id = pri.org_id and i.id = pri.invoice_id
    where pri.org_id = p_org_id
      and pri.payment_request_id = p_payment_request_id
      and (i.id is null or i.deleted_at is not null or i.review_status <> 'approved')
  );
end
$$;

revoke all on function public.p0_accountant_payment_request_ready(uuid, uuid) from public;
grant execute on function public.p0_accountant_payment_request_ready(uuid, uuid) to authenticated;

drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office')
    or (auth_role() = 'payer'
        and status in ('approved', 'sent_for_execution', 'executed', 'matched'))
    or (auth_role() = 'accountant'
        and status in ('approved', 'sent_for_execution', 'executed', 'matched')
        and public.p0_accountant_payment_request_ready(org_id, id))
  )
);

drop policy if exists pri2_select on public.payment_request_invoices;
create policy pri2_select on public.payment_request_invoices for select to authenticated using (
  org_id = auth_org() and exists (
    select 1
    from public.payment_requests pr
    where pr.org_id = payment_request_invoices.org_id
      and pr.id = payment_request_invoices.payment_request_id
      and (
        auth_role() in ('owner', 'office')
        or (auth_role() = 'payer'
            and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched'))
        or (auth_role() = 'accountant'
            and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched')
            and public.p0_accountant_payment_request_ready(pr.org_id, pr.id))
      )
  )
);

-- ===== Bank unmatch restores every linked payment request =====

create or replace function public.unmatch_bank_transaction(
  p_bank_transaction_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_tx public.bank_transactions;
  v_reason text := nullif(trim(p_reason), '');
  v_payment_ids uuid[] := '{}'::uuid[];
  v_payment_request_ids uuid[] := '{}'::uuid[];
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'accountant') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_bank_transaction_id is null or v_reason is null then
    raise exception 'bank_unmatch_invalid' using errcode = '22023';
  end if;

  select * into v_tx
  from public.bank_transactions
  where id = p_bank_transaction_id and org_id = v_org
  for update;

  if not found then
    raise exception 'bank_transaction_unknown' using errcode = 'P0002';
  end if;
  if v_tx.status <> 'matched' then
    if v_tx.status = 'unmatched' and exists (
      select 1
      from public.audit_logs a
      where a.org_id = v_org and a.entity_type = 'bank_transactions'
        and a.entity_id = v_tx.id and a.action = 'bank_match_removed'
    ) then
      return jsonb_build_object(
        'bank_transaction_id', v_tx.id,
        'status', 'unmatched',
        'idempotent', true
      );
    end if;
    raise exception 'bank_transaction_not_matched' using errcode = 'P0001';
  end if;

  perform 1
  from public.bank_allocations ba
  where ba.org_id = v_org and ba.bank_transaction_id = v_tx.id
  order by ba.id
  for update;

  if exists (
    select 1
    from public.bank_allocations ba
    where ba.org_id = v_org and ba.bank_transaction_id = v_tx.id
      and ba.invoice_id is not null
  ) then
    raise exception 'bank_direct_match_requires_financial_correction' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct ba.payment_id order by ba.payment_id), '{}'::uuid[])
    into v_payment_ids
  from public.bank_allocations ba
  where ba.org_id = v_org and ba.bank_transaction_id = v_tx.id
    and ba.payment_id is not null;

  if cardinality(v_payment_ids) = 0 then
    raise exception 'bank_match_allocation_missing' using errcode = 'P0001';
  end if;

  perform 1
  from public.payments p
  where p.org_id = v_org and p.id = any(v_payment_ids)
  order by p.id
  for update;

  select coalesce(array_agg(distinct p.payment_request_id order by p.payment_request_id), '{}'::uuid[])
    into v_payment_request_ids
  from public.payments p
  where p.org_id = v_org and p.id = any(v_payment_ids)
    and p.payment_request_id is not null;

  perform 1
  from public.payment_requests pr
  where pr.org_id = v_org and pr.id = any(v_payment_request_ids)
  order by pr.id
  for update;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  delete from public.bank_allocations
  where org_id = v_org and bank_transaction_id = v_tx.id;

  update public.bank_transactions
  set status = 'unmatched'
  where id = v_tx.id and org_id = v_org;

  update public.payment_requests
  set status = 'executed'
  where org_id = v_org and id = any(v_payment_request_ids) and status = 'matched';

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'bank_match_removed', 'bank_transactions', v_tx.id,
    jsonb_build_object(
      'status', 'matched',
      'payment_id', v_payment_ids[1],
      'payment_ids', to_jsonb(v_payment_ids),
      'payment_request_ids', to_jsonb(v_payment_request_ids)
    ),
    jsonb_build_object(
      'status', 'unmatched',
      'payment_id', v_payment_ids[1],
      'payment_ids', to_jsonb(v_payment_ids),
      'payment_request_ids', to_jsonb(v_payment_request_ids)
    ),
    v_reason
  );

  return jsonb_build_object(
    'bank_transaction_id', v_tx.id,
    'payment_id', v_payment_ids[1],
    'payment_ids', to_jsonb(v_payment_ids),
    'payment_request_ids', to_jsonb(v_payment_request_ids),
    'status', 'unmatched',
    'idempotent', false
  );
end
$$;

revoke all on function public.unmatch_bank_transaction(uuid, text) from public;
grant execute on function public.unmatch_bank_transaction(uuid, text) to authenticated;
