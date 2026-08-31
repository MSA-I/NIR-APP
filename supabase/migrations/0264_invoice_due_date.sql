-- 0264 — an invoice can carry the date it is due, and nothing guesses one for it.
--
-- WHY IT DID NOT EXIST. Payment requests have carried `due_date` since `0001:253`; invoices never
-- have. So "how much leaves the business in the next thirty days" could only ever be answered from
-- the requests somebody had already scheduled, which is a fraction of what is actually owed. The
-- owner's ruling of 31.08.2026 adds the column.
--
-- IN TWO STEPS, AND THEY MUST NOT BE MERGED. This migration adds the column and the review screen
-- gains an OPTIONAL date field. It touches `worker/ocr` not at all. Reading "payable by…" off the
-- document is a separate change that carries a gateway contract version on BOTH sides and a VPS
-- redeployment in the same rollout — the rule `CLAUDE.md` states because raising it on one side
-- only stopped document processing in production for five days without a single error surfacing
-- to a user (`a3603c0`). Splitting the work is what keeps this migration free of that risk.
--
-- AND A DATE NOBODY SUPPLIED IS UNKNOWN. Never derived from `suppliers.payment_terms`: that column
-- is free text nobody parses, `alerts.ts:145-148` already tells the user so, and parsing it here
-- would invent a debt with a date attached. `null` means "not known", which is the honest input to
-- a card that reports its own coverage.
--
-- NULLABLE ON PURPOSE, AND THEREFORE SAFE. Every existing row keeps a null, no default fabricates
-- a date, and no read model changes behaviour today. The column is inert until somebody types
-- into it.

alter table public.invoices
  add column if not exists due_date date;

comment on column public.invoices.due_date is
  'When this invoice is due, as stated on the document or entered by a person. NULL means nobody '
  'knows — never a value derived from payment terms, which are free text nobody parses (0264, '
  'owner ruling 31.08.2026). Filled by hand from the review screen; OCR extraction is a later '
  'change that carries a gateway contract bump and a VPS redeployment.';

-- A date this far from its invoice is a typing accident, not a business fact. Wide enough to hold
-- any real term (a five-year retention deal is inside it) and narrow enough that a mis-keyed year
-- is refused at the boundary rather than becoming a card figure.
alter table public.invoices
  drop constraint if exists invoices_due_date_plausible;
alter table public.invoices
  add constraint invoices_due_date_plausible check (
    due_date is null
    or (due_date >= invoice_date - interval '1 year'
        and due_date <= invoice_date + interval '5 years')
  );

-- The export registry stores a hash of each table's shape, DERIVED rather than typed (the 0149 and
-- 0137 pattern — a hand-written hash is a hash that drifts). Adding a column changes the shape, so
-- the row is recomputed here instead of going stale.
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name = 'invoices';

do $assert_0264$
declare
  v_violations text;
  v_registry_columns text[];
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices' and column_name = 'due_date'
      and data_type = 'date' and is_nullable = 'YES') then
    raise exception '0264: invoices.due_date is absent or not a nullable date';
  end if;

  -- NOTHING WAS GIVEN A DATE. The column is inert until a person types into it, and a default or a
  -- backfill would be exactly the invented debt this migration refuses to create.
  if exists (select 1 from public.invoices where due_date is not null) then
    raise exception '0264: an existing invoice was given a due date';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices' and column_name = 'due_date'
      and column_default is not null) then
    raise exception '0264: due_date carries a default, which would fabricate a date';
  end if;

  -- The plausibility bound exists and actually refuses. Proved by trying it, not by reading it.
  begin
    insert into public.invoices
      (org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount,
       total_amount, currency, due_date)
    select organization.id, supplier.id, '0264-probe', date '2026-01-01', 1, 0, 1,
           organization.base_currency, date '2036-01-01'
    from public.organizations organization
    join public.suppliers supplier on supplier.org_id = organization.id
    limit 1;
    -- No tenant to probe with is not a failure; the constraint is asserted below either way.
    if found then
      raise exception '0264: a due date ten years past its invoice was accepted';
    end if;
  exception
    when check_violation then null;
  end;
  if not exists (
    select 1 from pg_constraint
    where conname = 'invoices_due_date_plausible' and conrelid = 'public.invoices'::regclass) then
    raise exception '0264: the plausibility constraint is absent';
  end if;

  -- The export registry knows the new shape rather than carrying yesterday's hash.
  select exported_columns into v_registry_columns
  from private.tenant_export_registry where table_name = 'invoices';
  if v_registry_columns is not null and not ('due_date' = any(v_registry_columns))
     and (select disposition from private.tenant_export_registry
          where table_name = 'invoices') <> 'exclude' then
    raise exception '0264: the export registry did not learn the new column';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0264 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0264$;

-- ===== The command that fills it =====
--
-- The column cannot be written from the client directly: `p1_financial_command_guard` (0023)
-- refuses every invoice UPDATE that does not come through an RPC holding the writer token. That
-- boundary is the reason this migration ships a command rather than a permission.
--
-- A REASON IS RECORDED, AND IT IS NOT DEMANDED. The constitution requires an audited reason on a
-- sensitive action, and this is an audited action: the row carries the old date, the new one, and
-- who changed it. But making a person justify typing a date in prose would suppress the very
-- coverage the card is built to grow, so the caller MAY supply a reason and a stated default is
-- recorded when they do not. The audit row is never reasonless.
create or replace function public.set_invoice_due_date(
  p_invoice_id uuid,
  p_due_date date,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_invoice public.invoices;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The scope predicate is the enforcement, not a formality: `0099`'s idiom, locking the exact
  -- tenant invoice and refusing one that belongs to a unit this actor cannot see. A definer
  -- function that reads an enforced table without it is what A5 exists to catch.
  select * into v_invoice from public.invoices i
  where i.org_id = v_org and i.id = p_invoice_id and i.deleted_at is null
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: setting the date it already has changes nothing and writes no audit row, so a
  -- double submit does not fill the log with events that did not happen.
  if v_invoice.due_date is not distinct from p_due_date then
    return jsonb_build_object('invoice_id', p_invoice_id, 'due_date', p_due_date,
                              'changed', false);
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  update public.invoices
     set due_date = p_due_date, updated_at = now()
   where org_id = v_org and id = p_invoice_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id,
                          old_values, new_values, reason)
  values (v_org, v_user, 'invoice_due_date_set', 'invoices', p_invoice_id,
          jsonb_build_object('due_date', v_invoice.due_date),
          jsonb_build_object('due_date', p_due_date),
          coalesce(nullif(trim(p_reason), ''),
                   'due date entered by hand on the invoice review screen'));

  return jsonb_build_object('invoice_id', p_invoice_id, 'due_date', p_due_date, 'changed', true);
end
$$;

comment on function public.set_invoice_due_date(uuid, date, text) is
  'Sets or clears the date an invoice is due, for owner and office only. Audited with the old and '
  'new value and a reason — supplied or a stated default, never absent. Idempotent: re-sending '
  'the date the invoice already has writes nothing. Passing NULL clears the date back to '
  '"not known", which is a real answer and not a deletion (0264).';

revoke all on function public.set_invoice_due_date(uuid, date, text) from public;
revoke all on function public.set_invoice_due_date(uuid, date, text) from anon;
grant execute on function public.set_invoice_due_date(uuid, date, text) to authenticated;

-- The body is pinned to a ledger a reviewer reads, so a later edit either updates it or fails A5
-- closed. The hash is DERIVED from the live body with carriage returns stripped — a typed hash is
-- a hash that drifts between Windows and CI.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'set_invoice_due_date(uuid,date,text)',
       md5(replace(p.prosrc, chr(13), '')), 'filtered_read',
       '0264 locks the exact tenant invoice through the org filter and a null-or-auth_scopes unit '
       'predicate before it writes, so an actor cannot date an invoice outside their scope.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_invoice_due_date'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

do $assert_0264_command$
declare
  v_violations text;
begin
  if not has_function_privilege('authenticated', 'public.set_invoice_due_date(uuid, date, text)', 'execute') then
    raise exception '0264: the command is not executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.set_invoice_due_date(uuid, date, text)', 'execute') then
    raise exception '0264: the command is executable by anon';
  end if;
  -- The audit row can never be reasonless, which is the rule the constitution states in words.
  -- Read with carriage returns stripped. A body applied from Windows stores CRLF and one applied
  -- on CI stores LF, and a check that only ever runs on CI would not notice until production did.
  if position('coalesce(nullif(trim(p_reason)' in replace(pg_get_functiondef(
      'public.set_invoice_due_date(uuid, date, text)'::regprocedure), e'', '')) = 0 then
    raise exception '0264: the command can write an audit row without a reason';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0264 command scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0264_command$;
