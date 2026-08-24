-- 0174 -- One-time release of an approval snapshot's cumulative-consumption effect.

alter table public.invoice_three_way_approval_snapshots
  add column reversed_at timestamptz,
  add column reversed_by uuid,
  add column reversal_reason text,
  add constraint invoice_three_way_approval_snapshots_reversal_shape check (
    num_nonnulls(reversed_at, reversed_by, reversal_reason) in (0, 3)
    and (reversal_reason is null or (
      nullif(btrim(reversal_reason), '') is not null and length(reversal_reason) <= 1000
    ))
  ),
  add constraint invoice_three_way_approval_snapshots_reversed_actor_fk
    foreign key (org_id, reversed_by) references public.profiles(org_id, id) on delete restrict;

create index invoice_three_way_approval_snapshots_active_idx
  on public.invoice_three_way_approval_snapshots(org_id, invoice_id, revision desc)
  where reversed_at is null;

create or replace function public.invoice_three_way_immutable_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_expected text := case
    when tg_table_name in ('invoice_line_evidence_batches', 'invoice_lines') then 'evidence'
    when tg_table_name in ('invoice_line_match_sets', 'invoice_line_matches') then 'match'
    when tg_table_name = 'invoice_three_way_overrides' then 'override'
    when tg_table_name = 'invoice_three_way_approval_snapshots' then 'approval_snapshot'
  end;
begin
  if tg_table_name = 'invoice_three_way_approval_snapshots'
     and tg_op = 'UPDATE'
     and current_setting('app.invoice_three_way_writer', true) = 'approval_snapshot_reversal'
     and to_jsonb(old) -> 'reversed_at' = 'null'::jsonb
     and to_jsonb(new) -> 'reversed_at' <> 'null'::jsonb
     and to_jsonb(new) -> 'reversed_by' <> 'null'::jsonb
     and nullif(btrim(to_jsonb(new) ->> 'reversal_reason'), '') is not null
     and (to_jsonb(new) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
       is not distinct from
       (to_jsonb(old) - 'reversed_at' - 'reversed_by' - 'reversal_reason') then
    return new;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'invoice_three_way_evidence_immutable' using errcode = '42501';
  end if;
  if current_setting('app.invoice_three_way_writer', true) is distinct from v_expected then
    raise exception 'invoice_three_way_writer_required' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function public.invoice_three_way_immutable_guard()
  from public, anon, authenticated, service_role;

-- Pin the exact consumption anchors rather than copying the ~1,000-line assessment function.
--
-- TWO live functions read prior-approval consumption, not one. `private.invoice_line_candidates`
-- (0099:474) subtracts capacity a prior approval already claimed while SELECTING candidates;
-- `private.invoice_three_way_raw` (0099:1187) recomputes the same figure per order item while
-- ASSESSING them. Each carries exactly ONE `snapshot.invoice_id, snapshot.assessment` projection
-- and ONE consumption filter, in its own shape -- `is not null` in the candidate selector,
-- `= item.id::text` in the raw assessment. Reading a single body and expecting the projection twice
-- is what the counts below used to assert; that count is only reachable across the two bodies, and
-- `pg_get_functiondef` returns one. Patching only the raw reader would also leave a reversed
-- approval still consuming capacity during candidate selection: the reversal would change what an
-- invoice REPORTS while the next invoice stayed barred from claiming the released quantity.
-- So both bodies move, each asserted against its own live definition.
do $patch_consumption$
declare
  v_definition text;
  v_old text;
  v_new text;
  v_projection_old constant text := 'snapshot.invoice_id, snapshot.assessment';
  v_projection_new constant text :=
    'snapshot.invoice_id, snapshot.assessment, snapshot.reversed_at';
begin
  -- --- private.invoice_line_candidates -- capacity a prior approval already claimed ---
  select replace(
      pg_get_functiondef('private.invoice_line_candidates(uuid,uuid)'::regprocedure), e'\r', '')
    into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_projection_old, '')))
       / length(v_projection_old) <> 1 then
    raise exception '0174: candidate approval projection anchor moved';
  end if;
  v_definition := replace(v_definition, v_projection_old, v_projection_new);

  v_old := 'where approved_item ->> ''purchase_order_item_id'' is not null';
  v_new := 'where approval.reversed_at is null' || e'\n'
    || '      and approved_item ->> ''purchase_order_item_id'' is not null';
  if position(v_old in v_definition) = 0 then
    raise exception '0174: candidate consumption anchor moved';
  end if;
  execute replace(v_definition, v_old, v_new);

  -- --- private.invoice_three_way_raw -- the per-order-item assessment ---
  select replace(
      pg_get_functiondef('private.invoice_three_way_raw(uuid,uuid)'::regprocedure), e'\r', '')
    into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_projection_old, '')))
       / length(v_projection_old) <> 1 then
    raise exception '0174: latest approval projection anchor moved';
  end if;
  v_definition := replace(v_definition, v_projection_old, v_projection_new);

  v_old := 'where approved_item ->> ''purchase_order_item_id'' = item.id::text';
  v_new := 'where approval.reversed_at is null' || e'\n'
    || '          and approved_item ->> ''purchase_order_item_id'' = item.id::text';
  if position(v_old in v_definition) = 0 then
    raise exception '0174: prior approval consumption anchor moved';
  end if;
  execute replace(v_definition, v_old, v_new);

  -- Both bodies now gate on the reversal column; neither may be left behind.
  if position('approval.reversed_at is null' in
       replace(pg_get_functiondef(
         'private.invoice_line_candidates(uuid,uuid)'::regprocedure), e'\r', '')) = 0
     or position('approval.reversed_at is null' in
       replace(pg_get_functiondef(
         'private.invoice_three_way_raw(uuid,uuid)'::regprocedure), e'\r', '')) = 0 then
    raise exception '0174: a prior-consumption reader still ignores reversal';
  end if;
end
$patch_consumption$;

create function public.reverse_invoice_three_way_approval_consumption(
  p_snapshot_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(p_reason), '');
  v_probe record;
  v_invoice public.invoices;
  v_snapshot public.invoice_three_way_approval_snapshots;
begin
  if v_org is null or v_actor is null or public.auth_role() <> 'owner' then
    raise exception 'invoice_approval_reversal_not_authorized' using errcode = '42501';
  end if;
  if p_snapshot_id is null or v_reason is null then
    raise exception 'invoice_approval_reversal_reason_required' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  select snapshot.invoice_id, invoice.supplier_id
    into v_probe
  from public.invoice_three_way_approval_snapshots snapshot
  join public.invoices invoice on invoice.org_id = snapshot.org_id and invoice.id = snapshot.invoice_id
  where snapshot.org_id = v_org and snapshot.id = p_snapshot_id;
  if not found then
    raise exception 'invoice_approval_snapshot_unknown' using errcode = 'P0002';
  end if;

  -- Same supplier serialization key as approval. After it: invoice, then snapshot, always.
  perform pg_advisory_xact_lock(hashtextextended(
    'invoice-three-way-approval:' || v_org::text || ':' || v_probe.supplier_id::text, 0));

  select * into v_invoice from public.invoices invoice
  where invoice.org_id = v_org and invoice.id = v_probe.invoice_id
  for update;
  select * into v_snapshot from public.invoice_three_way_approval_snapshots snapshot
  where snapshot.org_id = v_org and snapshot.id = p_snapshot_id
  for update;

  if auth.uid() is distinct from v_actor or public.auth_org() is distinct from v_org
     or public.auth_role() <> 'owner' then
    raise exception 'invoice_approval_reversal_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  perform public.assert_unit_in_scope(v_invoice.unit_id);

  if v_snapshot.reversed_at is not null then
    if v_snapshot.reversed_by = v_actor and v_snapshot.reversal_reason = v_reason then
      return jsonb_build_object('snapshot_id', v_snapshot.id, 'invoice_id', v_invoice.id,
        'reversed_at', v_snapshot.reversed_at, 'idempotent', true);
    end if;
    raise exception 'invoice_approval_reversal_conflict' using errcode = '55000';
  end if;
  if v_invoice.review_status <> 'investigation' then
    raise exception 'invoice_approval_reversal_requires_investigation' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.invoice_three_way_approval_snapshots newer
    where newer.org_id = v_org and newer.invoice_id = v_invoice.id
      and newer.revision > v_snapshot.revision
  ) then
    raise exception 'invoice_approval_reversal_not_latest' using errcode = '55000';
  end if;
  if v_invoice.payment_status <> 'unpaid'
     or v_invoice.export_status <> 'not_sent'
     or exists (select 1 from public.payment_request_invoices relation
                where relation.org_id = v_org and relation.invoice_id = v_invoice.id)
     or exists (select 1 from public.payment_allocations relation
                where relation.org_id = v_org and relation.invoice_id = v_invoice.id)
     or exists (select 1 from public.bank_allocations relation
                where relation.org_id = v_org and relation.invoice_id = v_invoice.id)
     or exists (select 1 from public.credit_requests relation
                where relation.org_id = v_org and relation.invoice_id = v_invoice.id)
     or exists (select 1 from public.monthly_exports relation
                where relation.org_id = v_org
                  and v_invoice.id = any(coalesce(relation.invoice_ids, '{}'::uuid[]))) then
    raise exception 'invoice_approval_reversal_financial_links' using errcode = '55000';
  end if;

  perform set_config('app.invoice_three_way_writer', 'approval_snapshot_reversal', true);
  update public.invoice_three_way_approval_snapshots
  set reversed_at = clock_timestamp(), reversed_by = v_actor, reversal_reason = v_reason
  where org_id = v_org and id = v_snapshot.id;
  perform set_config('app.invoice_three_way_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'invoice_approval_consumption_reversed',
    'invoice_three_way_approval_snapshots', v_snapshot.id,
    jsonb_build_object('invoice_id', v_invoice.id, 'revision', v_snapshot.revision,
      'assessment_hash', v_snapshot.assessment_hash, 'reversed', false),
    jsonb_build_object('invoice_id', v_invoice.id, 'revision', v_snapshot.revision,
      'assessment_hash', v_snapshot.assessment_hash, 'reversed', true), v_reason
  );
  perform private.record_security_event(v_org, v_actor,
    'invoice_approval_consumption_reversed',
    jsonb_build_object('invoice_id', v_invoice.id, 'snapshot_id', v_snapshot.id,
      'revision', v_snapshot.revision, 'assessment_hash', v_snapshot.assessment_hash));

  return jsonb_build_object('snapshot_id', v_snapshot.id, 'invoice_id', v_invoice.id,
    'reversed_at', (select reversed_at from public.invoice_three_way_approval_snapshots
                    where id = v_snapshot.id), 'idempotent', false);
end
$$;
revoke all on function public.reverse_invoice_three_way_approval_consumption(uuid,text)
  from public, anon;
grant execute on function public.reverse_invoice_three_way_approval_consumption(uuid,text)
  to authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'reverse_invoice_three_way_approval_consumption(uuid,text)',
       md5(replace(proc.prosrc, e'\r', '')), 'assert_unit',
       '0174 locks the tenant invoice and latest immutable snapshot, then calls assert_unit_in_scope before reversal.'
from pg_proc proc
where proc.oid = 'public.reverse_invoice_three_way_approval_consumption(uuid,text)'::regprocedure;

update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ),
    schema_hash = (
      select md5(string_agg(column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name = 'invoice_three_way_approval_snapshots';

do $$
declare v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0174 scope assertions failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0174 export assertions failed:\n%', v_violations; end if;
end
$$;
