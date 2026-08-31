-- 0272 — a document that did not arrive becomes a finding, which requires saying what was expected.
--
-- THERE IS NO MODEL FOR THIS TODAY. Zero occurrences of `recurring`, `cadence` or
-- `expected_document` across every migration and all of `src/`. An electricity invoice that never
-- came is exactly "what needs attention", and an expense that was never recorded is a month closed
-- wrongly — but nothing in this database can hold the sentence "one of these is due each month".
--
-- STATED, NEVER INFERRED — in this wave. A person declares the expectation; the card shows beside
-- it what the system actually SAW ("6 occurrences in 6 months, usually between the 3rd and the
-- 7th") as evidence supporting the declaration, not as a suggestion the product initiated.
-- Learning a cadence is a separate item behind an open question, and `state` carries `proposed`
-- so a row that nobody approved is neither scanned nor able to open an exception.
--
-- TWO TABLES, AND TWO STATE FIELDS ON THE SECOND. `missed → received` on one field DESTROYS the
-- fact that the document was late, and leaving it at `missed` cannot express that the exception
-- was closed. `due_status` says what happened in the world; `resolution` says what we did about
-- it. The measure of this whole item — missing documents actually caught — is computed on exactly
-- that intersection, and without `missed_at`/`received_at` it cannot be computed after the fact.
--
-- ⚠ AND THIS FILE MUST ADD A KEY THAT DOES NOT EXIST. The composite foreign key
-- `(org_id, exception_id)` CANNOT be created today: `exceptions` has only `id` as its primary key
-- (`0001:339-352`) and was never given `unique (org_id, id)` by `0021:176-193`. Without adding it
-- first the migration fails — and the lazy way out, a simple foreign key, is precisely the hole
-- the composite key exists to close: a simple one lets a row in tenant A point at an exception in
-- tenant B, and RLS does not catch it.

-- ===== 0. The key the composite foreign key needs =====
alter table public.exceptions
  add constraint p0_exceptions_org_id_id_key unique (org_id, id);

-- ===== 1. The declaration =====
create table public.supplier_document_expectations (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id),
  supplier_id              uuid not null,
  document_type            text not null,
  -- Prepared, and deliberately unused in v1: see the matching contract below.
  series_key               text,
  cadence                  text not null check (cadence in ('monthly', 'weekly', 'quarterly')),
  expected_day_from        int check (expected_day_from between 1 and 31),
  expected_day_to          int check (expected_day_to between 1 and 31),
  expected_weekday         int check (expected_weekday between 0 and 6),
  expected_month_of_quarter int check (expected_month_of_quarter between 1 and 3),
  grace_days               int not null default 0 check (grace_days between 0 and 60),
  timezone                 text not null default 'Asia/Jerusalem',
  -- `learned` is reserved for the item that does not exist yet. Every row this wave writes is
  -- `stated`, and the column is here so that a later learned row is distinguishable rather than
  -- retrofitted.
  source                   text not null default 'stated' check (source in ('stated', 'learned')),
  learned_from_count       int,
  -- AN EXPLICIT STATE, not an `active` flag beside a `paused_until`. That pair cannot express a
  -- proposal nobody approved, and a proposal that scans is a product inventing work.
  state                    text not null default 'proposed'
                             check (state in ('proposed', 'active', 'paused', 'cancelled')),
  unit_id                  uuid,
  created_by               uuid not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- The cadence decides which columns must be filled. A monthly expectation with no day range is
  -- not a weaker expectation, it is an unanswerable one.
  constraint supplier_expectations_cadence_shape check (
    case cadence
      when 'monthly' then expected_day_from is not null and expected_day_to is not null
                          and expected_day_to >= expected_day_from
      when 'weekly' then expected_weekday is not null
      when 'quarterly' then expected_month_of_quarter is not null
                            and expected_day_from is not null and expected_day_to is not null
                            and expected_day_to >= expected_day_from
    end),
  constraint supplier_expectations_supplier_fkey
    foreign key (org_id, supplier_id) references public.suppliers (org_id, id),
  constraint supplier_expectations_unit_fkey
    foreign key (org_id, unit_id) references public.org_units (org_id, id),
  constraint supplier_expectations_org_id_key unique (org_id, id)
);

-- ONE ACTIVE SERIES PER SUPPLIER AND TYPE, ENFORCED BY TWO PARTIAL INDEXES RATHER THAN ONE
-- CONSTRAINT. `unit_id` is nullable, and in an ordinary UNIQUE every NULL differs from every other
-- NULL — so "only one active" would not have been enforced in the COMMON case, an organisation-wide
-- expectation. Two partial indexes say the intent outright and depend on no server version.
create unique index supplier_expectations_active_scoped
  on public.supplier_document_expectations (org_id, supplier_id, document_type, unit_id)
  where state = 'active' and unit_id is not null;
create unique index supplier_expectations_active_org_wide
  on public.supplier_document_expectations (org_id, supplier_id, document_type)
  where state = 'active' and unit_id is null;
create index supplier_expectations_org_idx
  on public.supplier_document_expectations (org_id, supplier_id, state);

comment on table public.supplier_document_expectations is
  'What a person declared should arrive from a supplier, and how often (0272). Stated, never '
  'inferred: `source` is always `stated` in this wave and `state` starts at `proposed`, so a row '
  'nobody approved is neither scanned nor able to open an exception. `series_key` is prepared and '
  'unused — see the matching contract on the occurrences table.';

-- ===== 2. The occurrence =====
create table public.expectation_occurrences (
  -- `org_id` is EXPLICIT and not derived through the foreign key: tenant RLS cannot filter on a
  -- column the table does not have.
  org_id          uuid not null references public.organizations(id),
  id              uuid primary key default gen_random_uuid(),
  expectation_id  uuid not null,
  period_start    date not null,
  period_end      date not null,
  -- What happened in the world.
  due_status      text not null default 'awaiting'
                    check (due_status in ('awaiting', 'received', 'not_due', 'missed')),
  -- And what we did about it. Two fields, because one cannot hold both.
  resolution      text not null default 'open'
                    check (resolution in ('open', 'resolved_by_document', 'resolved_manually',
                                          'cancelled')),
  document_id     uuid,
  exception_id    uuid,
  missed_at       timestamptz,
  received_at     timestamptz,
  -- Derivable in principle, stored because the measure of this item is computed on it later and a
  -- derivation needs both timestamps to have survived.
  received_late   boolean,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint expectation_occurrences_period check (period_end >= period_start),
  unique (expectation_id, period_start),
  -- COMPOSITE, ALL THREE. A simple foreign key lets a row in one tenant point at a document or an
  -- exception in another, and RLS does not catch it.
  constraint expectation_occurrences_expectation_fkey
    foreign key (org_id, expectation_id)
    references public.supplier_document_expectations (org_id, id) on delete cascade,
  constraint expectation_occurrences_document_fkey
    foreign key (org_id, document_id) references public.documents (org_id, id),
  constraint expectation_occurrences_exception_fkey
    foreign key (org_id, exception_id) references public.exceptions (org_id, id)
);
create index expectation_occurrences_due_idx
  on public.expectation_occurrences (org_id, due_status, period_end);
create index expectation_occurrences_expectation_idx
  on public.expectation_occurrences (org_id, expectation_id, period_start desc);

comment on table public.expectation_occurrences is
  'One period of one expectation, and what became of it (0272). TWO state fields on purpose: '
  '`missed → received` on a single field destroys the fact that the document was late, and '
  'leaving it at `missed` cannot say the exception was closed. `due_status` is the world, '
  '`resolution` is us. Without this table there is no idempotency and no "not expected this '
  'period" — a skipped period is a fact about a period, and a pause on the definition cannot '
  'carry it without erasing history.';

-- ===== 3. Tenancy =====
alter table public.supplier_document_expectations enable row level security;
alter table public.expectation_occurrences enable row level security;

create policy supplier_expectations_read on public.supplier_document_expectations
  for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner', 'office')
         and (unit_id is null or unit_id = any(public.auth_scopes())));
create policy expectation_occurrences_read on public.expectation_occurrences
  for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner', 'office'));

revoke all on table public.supplier_document_expectations from public, anon, authenticated;
revoke all on table public.expectation_occurrences from public, anon, authenticated;
grant select on table public.supplier_document_expectations to authenticated;
grant select on table public.expectation_occurrences to authenticated;

create trigger zz_organization_write_guard
  before insert or update or delete on public.supplier_document_expectations
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard
  before insert or update or delete on public.expectation_occurrences
  for each row execute function private.organization_row_write_guard();

insert into private.scope_registry (table_name, scope_class, enforced) values
  ('supplier_document_expectations', 'branch', false),
  ('expectation_occurrences', 'derived', false)
on conflict (table_name) do update
  set scope_class = excluded.scope_class, enforced = excluded.enforced;

-- Evidence a person acted: an expectation exists because somebody declared it. An occurrence is
-- machinery, and its presence proves only that a scanner ran.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale) values
  ('supplier_document_expectations', 'evidence',
   'A row exists only because a person declared what should arrive; direct evidence of use.'),
  ('expectation_occurrences', 'not_evidence',
   'Opened by the scanner for every period of an active expectation; its presence proves a job '
   'ran, not that anybody used the product.')
on conflict (table_name) do update
  set disposition = excluded.disposition, rationale = excluded.rationale;

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('supplier_document_expectations', 'include', '{}',
   'The tenant''s own statement of what it expects from each supplier.'),
  ('expectation_occurrences', 'include', '{}',
   'Each period of each expectation and what became of it, including whether a document arrived '
   'late.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

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
where registry.table_name in ('supplier_document_expectations', 'expectation_occurrences');

-- ===== 4. The only way a row gets in =====
--
-- A model with no writer is a model nobody can use, and "stated manually" needs something for a
-- person to state THROUGH. This is that, and it is deliberately narrow: it creates a proposal.
-- Approving one is a separate act, because the whole point of `proposed` is that creating an
-- expectation and letting it open exceptions are two different decisions.
create or replace function public.declare_document_expectation(
  p_supplier_id uuid,
  p_document_type text,
  p_cadence text,
  p_expected_day_from int default null,
  p_expected_day_to int default null,
  p_expected_weekday int default null,
  p_expected_month_of_quarter int default null,
  p_grace_days int default 0,
  p_unit_id uuid default null
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
  v_id uuid;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The unit must be one this actor can see. `ADR-0004` requires the assertion in the command
  -- rather than only in a policy, because a definer function bypasses the policy.
  if p_unit_id is not null then
    perform public.assert_unit_in_scope(p_unit_id);
  end if;

  -- The supplier must be this tenant's. A composite foreign key would catch it a moment later,
  -- but a named refusal is a better answer than a constraint violation.
  if not exists (select 1 from public.suppliers
                 where org_id = v_org and id = p_supplier_id and deleted_at is null) then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  insert into public.supplier_document_expectations (
    org_id, supplier_id, document_type, cadence,
    expected_day_from, expected_day_to, expected_weekday, expected_month_of_quarter,
    grace_days, unit_id, created_by, state, source)
  values (
    v_org, p_supplier_id, p_document_type, p_cadence,
    p_expected_day_from, p_expected_day_to, p_expected_weekday, p_expected_month_of_quarter,
    coalesce(p_grace_days, 0), p_unit_id, v_user,
    -- BORN PROPOSED, ALWAYS. The caller cannot ask for `active`: an expectation that scans is a
    -- thing that opens exceptions, and that is an approval, not a creation.
    'proposed',
    -- And born STATED. `learned` belongs to an item that does not exist, and a command that let a
    -- caller claim otherwise would put unearned confidence in the evidence line on the card.
    'stated')
  returning id into v_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, v_user, 'document_expectation_declared', 'supplier_document_expectations', v_id,
          jsonb_build_object('supplier_id', p_supplier_id, 'document_type', p_document_type,
                             'cadence', p_cadence, 'grace_days', coalesce(p_grace_days, 0)),
          'a person declared that this document should arrive on this cadence');

  return jsonb_build_object('expectation_id', v_id, 'state', 'proposed');
end
$$;

comment on function public.declare_document_expectation(uuid, text, text, int, int, int, int, int, uuid) is
  'Declares that a document should arrive from a supplier on a cadence (0272). Owner and office. '
  'The row is always born `proposed` and `stated`: the caller cannot ask for `active`, because an '
  'expectation that scans is one that opens exceptions and that is an approval rather than a '
  'creation; and it cannot claim to have been `learned`, because nothing learns yet.';

revoke all on function public.declare_document_expectation(uuid, text, text, int, int, int, int, int, uuid) from public;
revoke all on function public.declare_document_expectation(uuid, text, text, int, int, int, int, int, uuid) from anon;
grant execute on function public.declare_document_expectation(uuid, text, text, int, int, int, int, int, uuid) to authenticated;

insert into private.audit_scope_taxonomy (entity_type, scope_domain, resolver, rationale)
values ('supplier_document_expectations', 'organization_identity_platform', 'cross_scope',
        'An expectation is a standing statement about a supplier relationship. The taxonomy has '
        'no resolver that reads a unit off this table, and most rows carry none at all, so it is '
        'classified the way organisation-wide configuration is rather than given a resolver that '
        'would answer null for the common case.')
on conflict (entity_type) do update
  set scope_domain = excluded.scope_domain,
      resolver = excluded.resolver,
      rationale = excluded.rationale;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'declare_document_expectation(uuid,text,text,integer,integer,integer,integer,integer,uuid)',
       md5(replace(p.prosrc, chr(13), '')), 'assert_unit',
       '0272 asserts the named unit is in scope before writing and derives the organisation from '
       'auth_org(), so a caller cannot declare an expectation outside what it can see.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'declare_document_expectation'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== Proof =====
do $verify_0272$
declare
  v_violations text;
begin
  -- The key this file had to add before its own foreign key could exist.
  if not exists (
    select 1 from pg_constraint
    where conname = 'p0_exceptions_org_id_id_key' and conrelid = 'public.exceptions'::regclass) then
    raise exception '0272: exceptions did not get the composite key the foreign key needs';
  end if;

  -- EVERY cross-table reference is composite. A simple one is the hole this closes.
  if exists (
    select 1 from pg_constraint
    where conrelid in ('public.expectation_occurrences'::regclass,
                       'public.supplier_document_expectations'::regclass)
      and contype = 'f' and array_length(conkey, 1) < 2
      and confrelid <> 'public.organizations'::regclass) then
    raise exception '0272: a cross-table reference is not scoped by organisation';
  end if;

  -- "One active series" is enforced in the COMMON case too — the organisation-wide one, where an
  -- ordinary UNIQUE would have let every NULL differ from every other NULL.
  if not exists (select 1 from pg_indexes where indexname = 'supplier_expectations_active_org_wide')
     or not exists (select 1 from pg_indexes where indexname = 'supplier_expectations_active_scoped') then
    raise exception '0272: one active series per supplier and type is not enforced';
  end if;

  -- Both state fields survive, because the item is measured on their intersection.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'expectation_occurrences'
      and column_name in ('due_status', 'resolution', 'missed_at', 'received_at')
    having count(*) = 4) then
    raise exception '0272: the occurrence cannot say both what happened and what was done';
  end if;

  -- A proposal nobody approved is the default, so nothing scans a row on the strength of its
  -- having been created.
  if (select column_default from information_schema.columns
      where table_name = 'supplier_document_expectations' and column_name = 'state')
       not like '%proposed%' then
    raise exception '0272: an expectation is born active';
  end if;

  if has_table_privilege('authenticated', 'public.supplier_document_expectations', 'insert')
     or has_table_privilege('authenticated', 'public.expectation_occurrences', 'update')
     or has_table_privilege('anon', 'public.supplier_document_expectations', 'select') then
    raise exception '0272: a client role can write the expectations, or anon can read them';
  end if;
  if not (select relrowsecurity from pg_class
          where oid = 'public.supplier_document_expectations'::regclass)
     or not (select relrowsecurity from pg_class
             where oid = 'public.expectation_occurrences'::regclass) then
    raise exception '0272: row level security is not enabled on both tables';
  end if;

  -- Both tables classified everywhere a public table carrying org_id must be.
  if (select count(*) from private.tenant_export_registry
      where table_name in ('supplier_document_expectations', 'expectation_occurrences')) <> 2
     or (select count(*) from private.org_activity_evidence_registry
         where table_name in ('supplier_document_expectations', 'expectation_occurrences')) <> 2
     or (select count(*) from private.scope_registry
         where table_name in ('supplier_document_expectations', 'expectation_occurrences')) <> 2 then
    raise exception '0272: a new table is missing from a registry that blocks tenant deletion';
  end if;
  if exists (select 1 from private.org_activity_registry_violations()) then
    raise exception '0272: a public org table is unclassified for activity evidence';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0272 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0272$;
