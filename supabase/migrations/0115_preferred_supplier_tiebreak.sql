-- 0115 -- A preferred supplier breaks a tie. It never wins one.
--
-- THE WHOLE RISK OF THIS FEATURE IS THAT IT QUIETLY BECOMES A PRICE OVERRIDE. "Preferred" is a
-- reasonable thing for an owner to want -- this supplier delivers on time, their driver knows the
-- back entrance, they answer the phone -- and it is one small step from there to a recommendation
-- engine that costs the business money on every order while looking helpful. So the rule is
-- narrow and it is enforced in the ordering itself:
--
--     order by sp.current_price, s.preferred desc, sp.supplier_id
--
-- Price first, ALWAYS. Preference only decides between offers that already cost the same, taking
-- the place of the arbitrary `supplier_id` tie-break that decided them before -- which is to say
-- it replaces a coin flip with a judgement, and nothing else. A more expensive preferred supplier
-- is never recommended; choosing one deliberately stays what it already is, an explicit pin
-- (`0043`'s pinning, unchanged).
--
-- HOW THE TWO CALL SITES ARE CHANGED, and why not by rewriting them. `public.build_order_draft`
-- (0018) and the split-step recommendation (0043) both carry the tie-break, and the live body of a
-- command in this schema is not necessarily the text of the migration that created it -- 0061
-- rewrites `execute_payment_request` in place to inject a password step-up, and a `create or
-- replace` copied from the original would silently delete it. So this migration does what 0104
-- did for `tax_receipt`: it reads the LIVE definition, replaces one exact string, and executes the
-- result. Anything else in those bodies -- including an injection nobody remembers -- survives
-- untouched, and if the anchor string is missing the migration fails loudly instead of quietly
-- writing an older version back.
--
-- THE COLUMN GRANT IS NOT OPTIONAL. 0112 replaced the table-level SELECT on `suppliers` with
-- per-column grants to hide `bank_details`, which means a column added afterwards is NOT readable
-- until it is granted explicitly. p32 re-derives that list at gate time, so forgetting this line
-- fails the gate rather than producing a screen that renders empty for no traceable reason.

alter table public.suppliers
  add column if not exists preferred boolean not null default false;

grant select (preferred) on public.suppliers to authenticated;

comment on column public.suppliers.preferred is
  'An owner''s standing preference between suppliers (0115). Used for display order and as a '
  'tie-break between offers AT THE SAME PRICE, where it replaces the arbitrary supplier_id '
  'ordering. It never makes a more expensive supplier the recommendation. Set through '
  'set_supplier_preferred, which requires a reason, rather than by direct UPDATE.';

-- A6 (0103): a tenant's offboarding export is pinned to each table's exact shape, so ADDING a
-- column is drift until someone decides whether it leaves with the tenant. This one does: a
-- standing preference between suppliers is the tenant's own commercial judgement, and an export
-- that silently dropped it would hand back a supplier list that had lost a decision.
update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name)
where registry.table_name = 'suppliers';

-- ===== 2. The two recommendation sites, changed by anchored replacement =====
do $$
declare
  v_name text;
  v_def text;
  v_old constant text := 'order by sp.current_price, sp.supplier_id';
  v_new constant text := 'order by sp.current_price, s.preferred desc, sp.supplier_id';
  v_changed integer;
begin
  for v_name in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%' || v_old || '%'
  loop
    select pg_get_functiondef(to_regprocedure(v_name)) into v_def;
    if position(v_old in v_def) = 0 then
      raise exception '0115: % no longer contains the tie-break anchor.', v_name;
    end if;
    execute replace(v_def, v_old, v_new);
  end loop;

  -- At least the two the campaign measured. Zero would mean the anchor drifted and this migration
  -- silently did nothing at all, which is the failure mode an anchored replacement exists to
  -- prevent.
  select count(*) into v_changed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc like '%' || v_new || '%';
  if v_changed < 2 then
    raise exception
      '0115: only % recommendation site(s) carry the preference tie-break; 0018 and 0043 both '
      'should. The anchor string drifted and the replacement did nothing.', v_changed;
  end if;
end
$$;

-- ===== 3. Setting it is a decision, so it takes a reason =====
create or replace function public.set_supplier_preferred(
  p_supplier_id uuid,
  p_preferred boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_before boolean;
  v_name text;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'set_supplier_preferred_not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 1000 or p_preferred is null then
    raise exception 'set_supplier_preferred_invalid' using errcode = '22023';
  end if;

  select s.preferred, s.name into v_before, v_name
  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  for update;
  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  if v_before = p_preferred then
    -- Idempotent and silent: re-affirming a preference is not an event, and writing an audit row
    -- for it would bury the ones that recorded an actual change.
    return jsonb_build_object('supplier_id', p_supplier_id, 'preferred', p_preferred,
                              'changed', false);
  end if;

  update public.suppliers set preferred = p_preferred
  where org_id = v_org and id = p_supplier_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'supplier_preference_changed', 'suppliers', p_supplier_id,
    jsonb_build_object('preferred', v_before),
    jsonb_build_object('preferred', p_preferred, 'supplier_name', v_name),
    v_reason);

  return jsonb_build_object('supplier_id', p_supplier_id, 'preferred', p_preferred,
                            'changed', true);
end
$$;

revoke all on function public.set_supplier_preferred(uuid, boolean, text) from public, anon;
grant execute on function public.set_supplier_preferred(uuid, boolean, text) to authenticated;

comment on function public.set_supplier_preferred(uuid, boolean, text) is
  'Marks a supplier preferred, or stops (0115). owner/office only, reason required, audited. '
  'Re-affirming an existing preference is idempotent and writes nothing, so the audit trail holds '
  'changes rather than repetitions. The preference orders equal-price offers and nothing else.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'set_supplier_preferred(uuid,boolean,text)',
  '0115 locks the supplier row by auth_org and id after an explicit role check; suppliers carry '
  'no unit column, so the org boundary is the whole boundary for this row.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 4. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0115 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 5. Anchors =====
do $$
declare
  v_src text;
begin
  -- (a) PRICE STILL COMES FIRST. This is the assertion the whole feature is on probation for.
  for v_src in
    select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%s.preferred desc%'
  loop
    if position('order by sp.current_price, s.preferred desc' in v_src) = 0 then
      raise exception
        '0115: a recommendation orders by preference before price. Preference breaks a tie; it '
        'never wins one, and a preferred supplier who costs more must never be recommended.';
    end if;
  end loop;

  -- (b) The column is readable. 0112 turned the table grant into per-column grants, so a new
  -- column is invisible until granted -- and an invisible column here is a "preferred" badge that
  -- never appears with no error to explain it.
  if not has_column_privilege('authenticated', 'public.suppliers', 'preferred', 'select') then
    raise exception '0115: the preferred column is not readable by the client.';
  end if;

  -- (c) It is set by the reasoned command, not by a direct write. A preference with no reason and
  -- no audit row is a decision nobody can trace when the order recommendations change.
  if has_column_privilege('authenticated', 'public.suppliers', 'preferred', 'update') then
    raise exception
      '0115: a client can UPDATE preferred directly, bypassing the required reason and the audit '
      'row.';
  end if;
  if to_regprocedure('public.set_supplier_preferred(uuid,boolean,text)') is null then
    raise exception '0115: the reasoned preference command is missing.';
  end if;
end
$$;
