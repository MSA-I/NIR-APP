-- 0175 -- Hybrid audit scope: deterministic financial legal entity or explicit cross-scope.

create table private.audit_scope_taxonomy (
  entity_type text primary key,
  scope_domain text not null check (scope_domain in ('financial_accounting','organization_identity_platform')),
  resolver text not null check (resolver in (
    'direct_invoice','direct_payment_request','direct_payment','direct_monthly_snapshot',
    'invoice_snapshot','invoice_override','snapshot_delivery','credit_invoice',
    'payment_allocation','ambiguous','cross_scope'
  )),
  rationale text not null check (nullif(btrim(rationale), '') is not null)
);
revoke all on private.audit_scope_taxonomy from public, anon, authenticated, service_role;

insert into private.audit_scope_taxonomy(entity_type, scope_domain, resolver, rationale) values
  ('invoices','financial_accounting','direct_invoice','Invoice legal entity is stored on the row.'),
  ('payment_requests','financial_accounting','direct_payment_request','Payment request legal entity is stored on the row.'),
  ('payments','financial_accounting','direct_payment','Payment legal entity is stored on the row.'),
  ('monthly_report_snapshots','financial_accounting','direct_monthly_snapshot','Snapshot legal entity is stored on the row.'),
  ('monthly_report_snapshot_deliveries','financial_accounting','snapshot_delivery','Delivery inherits its immutable snapshot.'),
  ('invoice_three_way_approval_snapshots','financial_accounting','invoice_snapshot','Approval snapshot inherits its invoice.'),
  ('invoice_three_way_overrides','financial_accounting','invoice_override','Override inherits its invoice.'),
  ('credit_requests','financial_accounting','credit_invoice','Only invoice-backed credits are deterministic.'),
  ('payment_allocations','financial_accounting','payment_allocation','Allocation inherits invoice, or payment when uniquely legal.'),
  ('bank_imports','financial_accounting','ambiguous','Bank imports do not yet carry legal entity.'),
  ('bank_transactions','financial_accounting','ambiguous','Bank transactions inherit an unscoped import today.'),
  ('bank_allocations','financial_accounting','ambiguous','Historical bank allocations may bridge targets.'),
  ('monthly_exports','financial_accounting','ambiguous','Legacy exports predate legal-entity ownership.'),
  ('organizations','organization_identity_platform','cross_scope','Organization lifecycle is organization-wide.'),
  ('profiles','organization_identity_platform','cross_scope','Identity and access are organization-wide.'),
  ('invitations','organization_identity_platform','cross_scope','Identity invitation is organization-wide.'),
  ('org_units','organization_identity_platform','cross_scope','Scope vocabulary is organization-wide.'),
  ('user_scope_grants','organization_identity_platform','cross_scope','Scope grant changes are organization-wide security events.'),
  ('identity_provider_settings','organization_identity_platform','cross_scope','Identity provider configuration is organization-wide.'),
  ('org_flag_configurations','organization_identity_platform','cross_scope','Feature rollout is organization-wide.'),
  ('suppliers','organization_identity_platform','cross_scope','Supplier catalogue identity is organization-global.'),
  ('supplier_products','organization_identity_platform','cross_scope','Supplier catalogue pricing is organization-global.'),
  ('products','organization_identity_platform','cross_scope','Product catalogue is organization-global.'),
  ('purchase_orders','organization_identity_platform','cross_scope','Procurement is branch-scoped, not legal-accounting scope.');

alter table public.audit_logs
  add column scope_domain text not null default 'financial_accounting',
  add column scope_class text not null default 'cross_scope',
  add column legal_entity_id uuid;

create function private.resolve_audit_legal_entity(
  p_org_id uuid, p_entity_type text, p_entity_id uuid, p_resolver text
) returns uuid
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
declare v_unit uuid;
begin
  if p_org_id is null or p_entity_id is null then return null; end if;
  case p_resolver
    when 'direct_invoice' then
      select unit_id into v_unit from public.invoices where org_id=p_org_id and id=p_entity_id;
    when 'direct_payment_request' then
      select unit_id into v_unit from public.payment_requests where org_id=p_org_id and id=p_entity_id;
    when 'direct_payment' then
      select unit_id into v_unit from public.payments where org_id=p_org_id and id=p_entity_id;
    when 'direct_monthly_snapshot' then
      select unit_id into v_unit from public.monthly_report_snapshots where org_id=p_org_id and id=p_entity_id;
    when 'snapshot_delivery' then
      select snapshot.unit_id into v_unit
      from public.monthly_report_snapshot_deliveries delivery
      join public.monthly_report_snapshots snapshot
        on snapshot.org_id=delivery.org_id and snapshot.id=delivery.snapshot_id
      where delivery.org_id=p_org_id and delivery.id=p_entity_id;
    when 'invoice_snapshot' then
      select invoice.unit_id into v_unit
      from public.invoice_three_way_approval_snapshots snapshot
      join public.invoices invoice on invoice.org_id=snapshot.org_id and invoice.id=snapshot.invoice_id
      where snapshot.org_id=p_org_id and snapshot.id=p_entity_id;
    when 'invoice_override' then
      select invoice.unit_id into v_unit
      from public.invoice_three_way_overrides override_row
      join public.invoices invoice on invoice.org_id=override_row.org_id and invoice.id=override_row.invoice_id
      where override_row.org_id=p_org_id and override_row.id=p_entity_id;
    when 'credit_invoice' then
      select invoice.unit_id into v_unit
      from public.credit_requests credit
      join public.invoices invoice on invoice.org_id=credit.org_id and invoice.id=credit.invoice_id
      where credit.org_id=p_org_id and credit.id=p_entity_id;
    when 'payment_allocation' then
      select coalesce(invoice.unit_id, payment.unit_id) into v_unit
      from public.payment_allocations allocation
      left join public.invoices invoice on invoice.org_id=allocation.org_id and invoice.id=allocation.invoice_id
      left join public.payments payment on payment.org_id=allocation.org_id and payment.id=allocation.payment_id
      where allocation.org_id=p_org_id and allocation.id=p_entity_id
        and (invoice.unit_id is null or payment.unit_id is null or invoice.unit_id=payment.unit_id);
    else return null;
  end case;
  if not exists (select 1 from public.org_units unit
    where unit.org_id=p_org_id and unit.id=v_unit and unit.unit_type='legal_entity') then
    return null;
  end if;
  return v_unit;
end
$$;
revoke all on function private.resolve_audit_legal_entity(uuid,text,uuid,text)
  from public, anon, authenticated, service_role;

-- OPEN-DECISIONS #255 admits two outcomes for an event that cannot be attributed
-- deterministically: fail closed, or stay cross_scope BECAUSE the taxonomy says the entity is
-- organizational. A default applied to an entity nobody classified is neither. Calling every
-- unclassified entity 'financial_accounting' would both mislabel it and silently narrow who may
-- read it -- until now every owner and accountant could read those rows, and the new policy would
-- hand them to holders of the root scope only. So the migration refuses to apply while any audited
-- entity is unclassified, and names the values that must be ruled on.
do $assert_taxonomy_complete$
declare
  v_missing text;
begin
  select string_agg(distinct audit.entity_type, ', ' order by audit.entity_type)
    into v_missing
  from public.audit_logs audit
  where not exists (
    select 1 from private.audit_scope_taxonomy taxonomy
    where taxonomy.entity_type = audit.entity_type
  );
  if v_missing is not null then
    raise exception 'audit_scope_taxonomy_incomplete: classify in private.audit_scope_taxonomy before 0175 can apply: %', v_missing
      using errcode = '22023';
  end if;
end
$assert_taxonomy_complete$;

update public.audit_logs audit
set scope_domain = taxonomy.scope_domain,
    legal_entity_id = private.resolve_audit_legal_entity(
      audit.org_id, audit.entity_type, audit.entity_id, taxonomy.resolver)
from private.audit_scope_taxonomy taxonomy
where taxonomy.entity_type = audit.entity_type;
update public.audit_logs
set scope_class = case when legal_entity_id is null then 'cross_scope' else 'legal_entity' end;

-- The column defaults exist only so the two NOT NULL columns could be added to a populated table.
-- Leaving them in place would re-create the silent classification this migration just removed, one
-- INSERT at a time, for anyone who bypassed the trigger. Without them a bypass is a NOT NULL
-- violation, which is the fail-closed outcome #255 asks for.
alter table public.audit_logs
  alter column scope_domain drop default,
  alter column scope_class drop default;

alter table public.audit_logs
  add constraint audit_logs_scope_domain_check
    check (scope_domain in ('financial_accounting','organization_identity_platform')),
  add constraint audit_logs_scope_class_check
    check (scope_class in ('legal_entity','cross_scope')),
  add constraint audit_logs_scope_shape check (
    (scope_class='legal_entity' and scope_domain='financial_accounting' and legal_entity_id is not null)
    or (scope_class='cross_scope' and legal_entity_id is null)
  ),
  add constraint audit_logs_legal_entity_fk foreign key (org_id, legal_entity_id)
    references public.org_units(org_id,id) on delete restrict;

create index audit_logs_legal_entity_idx
  on public.audit_logs(org_id, legal_entity_id, created_at desc) where legal_entity_id is not null;
create index audit_logs_cross_scope_idx
  on public.audit_logs(org_id, scope_domain, created_at desc) where scope_class='cross_scope';

create function private.assign_audit_scope()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_taxonomy private.audit_scope_taxonomy;
begin
  select * into v_taxonomy from private.audit_scope_taxonomy where entity_type=new.entity_type;
  if not found then
    -- Same rule at run time as at migration time: a newly audited entity nobody classified is
    -- refused, rather than silently labelled financial and silently narrowed to the root scope.
    raise exception
      'audit_scope_taxonomy_incomplete: %', new.entity_type using errcode = '22023';
  end if;
  new.scope_domain := v_taxonomy.scope_domain;
  new.legal_entity_id := private.resolve_audit_legal_entity(
    new.org_id, new.entity_type, new.entity_id, v_taxonomy.resolver);
  new.scope_class := case when new.legal_entity_id is null then 'cross_scope' else 'legal_entity' end;
  return new;
end
$$;
revoke all on function private.assign_audit_scope() from public, anon, authenticated, service_role;
create trigger aa_assign_audit_scope before insert on public.audit_logs
for each row execute function private.assign_audit_scope();

-- Raw audit history is immutable: UPDATE is refused unconditionally, for superuser too. DELETE is
-- refused the same way UNLESS the caller declared an authorized purge first, in exactly the shape
-- 0174 uses for app.invoice_three_way_writer: a transaction-local GUC the caller sets around its
-- own statement, never a role test. Two callers need it and no browser role can reach it -- 0020
-- revoked INSERT/UPDATE/DELETE/TRUNCATE on audit_logs from public, anon and authenticated, so the
-- GUC is a second fence behind a closed door, not the only one:
--   * tenant teardown -- supabase/demo/demo_reset.sql, and offboarding, which must be able to
--     remove an organization completely rather than leave its ledger behind;
--   * gate fixtures that clear the audit footprint they created themselves
--     (supabase/tests/p49_platform_capabilities.sql).
create function private.audit_log_immutable_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
  raise exception 'audit_log_immutable' using errcode='42501';
end
$$;
revoke all on function private.audit_log_immutable_guard() from public, anon, authenticated, service_role;
create trigger audit_log_immutable before update or delete on public.audit_logs
for each row execute function private.audit_log_immutable_guard();

drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated using (
  org_id=public.auth_org() and public.auth_role() in ('owner','accountant') and (
    (scope_class='legal_entity' and legal_entity_id=any(public.auth_scopes()))
    or (scope_class='cross_scope' and scope_domain='organization_identity_platform')
    or (scope_class='cross_scope' and scope_domain='financial_accounting' and exists (
      select 1 from public.org_units root
      where root.org_id=audit_logs.org_id and root.unit_type='root'
        and root.id=any(public.auth_scopes())
    ))
  )
);

create view public.audit_log_read_model
with (security_invoker=on, security_barrier=on) as
select id, org_id, user_id, action, entity_type, entity_id, old_values, new_values,
       reason, created_at, correlation_id, causation_id,
       scope_domain, scope_class, legal_entity_id
from public.audit_logs;
revoke all on public.audit_log_read_model from public, anon, authenticated;
grant select on public.audit_log_read_model to authenticated;

update private.tenant_export_registry registry
set exported_columns=(select array_agg(c.column_name order by c.ordinal_position)
  from information_schema.columns c where c.table_schema='public' and c.table_name=registry.table_name
    and not (c.column_name=any(registry.excluded_columns))),
    schema_hash=(select md5(string_agg(c.column_name||':'||c.data_type||':'||c.is_nullable,
      '|' order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema='public' and c.table_name=registry.table_name)
where registry.table_name='audit_logs';

do $$
declare v_violations text;
begin
  if exists (select 1 from public.audit_logs where scope_class='legal_entity' and legal_entity_id is null) then
    raise exception '0175: legal audit row lacks legal entity';
  end if;
  if exists (
    select 1 from public.audit_logs audit
    where not exists (select 1 from private.audit_scope_taxonomy taxonomy
                      where taxonomy.entity_type = audit.entity_type)
  ) then
    raise exception '0175: an audited entity_type survived the backfill unclassified';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='audit_logs'
      and column_name in ('scope_domain','scope_class') and column_default is not null
  ) then
    raise exception '0175: audit scope columns kept a silent default';
  end if;
  if position('app.audit_purge' in pg_get_functiondef(
       'private.audit_log_immutable_guard()'::regprocedure)) = 0 then
    raise exception '0175: the audit immutability guard has no authorized purge path';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail) into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0175 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0175 export assertions failed:\n%',v_violations; end if;
end
$$;
