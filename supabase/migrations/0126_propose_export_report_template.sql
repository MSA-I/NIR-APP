-- 0126 -- The command that creates a report template, without bending the one that creates a
-- document template.
--
-- `DEBT §36` recorded why 0123 stopped short. `document_export_template_contract_valid` (0047:38) is
-- written for a DOCUMENT: its `scope` must be exactly `{document_type, supplier_id, user_id}`, its
-- column keys must match `^[A-Za-z_][A-Za-z0-9_]{0,99}$` -- so a Hebrew placeholder cannot pass it --
-- and every `source_path` must come from `document_export_source_path_allowed`, which is a fixed
-- list of interpretation paths: `fields.*`, `line_items.values.*` and seven named keys. A monthly
-- report has none of those, and it never will.
--
-- There is a `CHECK (document_export_template_contract_valid(contract))` on the versions table, so
-- "just insert a different shape" is not available either. The two ways through were to invent a
-- fake column so a validator written for something else would accept it, or to widen that validator.
--
-- THIS WIDENS IT, ADDITIVELY, and the addition is a branch taken before the existing body runs:
-- a contract whose `scope` carries `export_key` is a report contract and goes to a separate
-- validator; everything else reaches the 0047 body byte for byte. A document contract that was
-- valid yesterday is valid today, and section 5 asserts that rather than asking to be believed.
--
-- WHAT A REPORT CONTRACT CONTAINS, which is almost nothing, and that is the point. `{schema_version,
-- name, format, scope:{export_key}}`. No columns. A report's columns are defined by the report --
-- by `monthlyReport.ts` and by `get_product_purchase_summary` -- not by the template. What the
-- template contributes is the WORKBOOK and the mapping from its `{{placeholders}}` to those fields,
-- and both of those live in `workbook_placeholders` (0123), attached after the propose and frozen
-- by the approve. A contract that also carried the mapping would be a second copy of it.
--
-- AND `attach_export_template_workbook` HAS NEVER WORKED. 0123 shipped it untested end to end, and
-- the suite this migration comes with found it on the first run:
--
--   ERROR:  document_export_template_version_immutable
--
-- `guard_document_export_template_version` (0047:474) permits exactly ONE update to a version row --
-- setting `approved_by` and `approved_at` together, with every other column identical -- and raises
-- on everything else. Attaching a workbook is every other column. So section 4 below widens that
-- guard by one branch, in the direction the guard already means: a version is immutable once
-- APPROVED, and before approval it is a draft being assembled. The workbook is the assembly.
--
-- BOTH ANCHORED REPLACEMENTS READ THE BODY'S LINE ENDING instead of assuming one. Measured: in
-- this database `document_export_template_contract_valid` carries LF and
-- `guard_document_export_template_version` carries CRLF, because they were created from files saved
-- differently on a Windows machine. An anchor with bare newlines matches on a Linux runner and
-- misses here -- the same trap the `md5(prosrc)` pins hit, wearing a different hat.
--
-- AN APPROVED REPORT TEMPLATE MUST HAVE A WORKBOOK. Nothing in 0047 requires one, because a
-- document template's contract IS its content. For a report the contract is a shell, so approving a
-- version with no file would make it `active_version_id` and hand the export a template with
-- nothing in it. Enforced by a trigger rather than by editing `approve_document_export_template_
-- version`, so the rule holds wherever an approval comes from and the live command keeps the text
-- its own suites pin.

-- ===== 1. The report contract's own validator =====
create or replace function public.export_report_contract_valid(p_contract jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_contract is not null
    and jsonb_typeof(p_contract) = 'object'
    and (p_contract ?& array['schema_version', 'name', 'format', 'scope'])
    and (p_contract - array['schema_version', 'name', 'format', 'scope']) = '{}'::jsonb
    and p_contract ->> 'schema_version' = '1'
    and jsonb_typeof(p_contract -> 'name') = 'string'
    and length(btrim(p_contract ->> 'name')) between 1 and 120
    -- xlsx alone: the whole point of a report template is the accountant's formatting, and there is
    -- no formatting in a csv.
    and p_contract ->> 'format' = 'xlsx'
    and jsonb_typeof(p_contract -> 'scope') = 'object'
    and (p_contract -> 'scope') ?& array['export_key']
    and ((p_contract -> 'scope') - array['export_key']) = '{}'::jsonb
    -- The same three the 0123 CHECK admits. Named by the code, never typed by a person.
    and p_contract #>> '{scope,export_key}' in (
      'accountant_monthly_report', 'owner_expense_summary', 'product_purchase_summary')
$$;

revoke all on function public.export_report_contract_valid(jsonb) from public, anon;
grant execute on function public.export_report_contract_valid(jsonb) to authenticated, service_role;

comment on function public.export_report_contract_valid(jsonb) is
  'The contract shape of a REPORT export template (0126): schema_version, name, format=xlsx and a '
  'scope carrying nothing but export_key. Deliberately has no columns -- a report''s columns belong '
  'to the report, and the template''s content is its workbook and the placeholder mapping stored '
  'beside it in workbook_placeholders.';

-- ===== 2. One branch in front of the document validator =====
-- Anchored replacement of the FIRST statement of the body, so the rest of 0047's function is
-- carried across unread and unedited. A `create or replace` retyping the whole 140-line validator
-- would put a second copy of it in the repository, and the next person to change one would not find
-- the other.
do $$
declare
  v_def text;
  v_nl text;
  v_old text := E'begin\n  if p_contract is null\n';
  v_new text :=
    E'begin\n'
    '  -- 0126: a contract whose scope carries export_key is a REPORT contract, and its shape is\n'
    '  -- validated somewhere else. Everything below this branch is 0047, unchanged.\n'
    '  if p_contract is not null and jsonb_typeof(p_contract -> ''scope'') = ''object''\n'
    '     and (p_contract -> ''scope'') ? ''export_key'' then\n'
    '    return public.export_report_contract_valid(p_contract);\n'
    '  end if;\n'
    '  if p_contract is null\n';
begin
  select pg_get_functiondef(to_regprocedure('public.document_export_template_contract_valid(jsonb)'))
    into v_def;
  if v_def is null then
    raise exception '0126: the document export contract validator is gone.';
  end if;
  -- Idempotent, for the reason 0117 learned: a migration that mutates and then fails later leaves
  -- the mutation applied, and re-running must not double-apply.
  if position('export_report_contract_valid' in v_def) > 0 then
    return;
  end if;
  -- A function body created from a CRLF file keeps its CRs in prosrc, and this repository is
  -- edited on Windows. An anchor written with bare newlines matches on a Linux runner and misses on
  -- the maintainer's own machine -- which is the same trap the md5(prosrc) pins hit, wearing a
  -- different hat. Match the body's own line ending rather than assuming one.
  v_nl := case when position(chr(13) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
  v_old := replace(v_old, chr(10), v_nl);
  v_new := replace(v_new, chr(10), v_nl);

  if position(v_old in v_def) = 0 then
    raise exception
      '0126: the validator does not open with the text 0047 wrote. Refusing to guess at an insert '
      'point inside a function a CHECK constraint depends on.';
  end if;
  execute replace(v_def, v_old, v_new);
end
$$;

-- ===== 3. Proposing one =====
create or replace function public.propose_export_report_template(
  p_export_key text,
  p_name text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(btrim(p_reason), '');
  v_name text := nullif(btrim(p_name), '');
  v_template public.document_export_templates;
  v_version integer;
  v_version_id uuid;
  v_contract jsonb;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'export_template_not_authorized' using errcode = '42501';
  end if;
  if p_export_key is null or p_export_key not in (
       'accountant_monthly_report', 'owner_expense_summary', 'product_purchase_summary') then
    raise exception 'export_template_key_unknown' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'export_template_name_required' using errcode = '22023';
  end if;

  -- The same advisory lock shape 0047 uses, on the same scope tuple plus the new dimension: two
  -- people proposing a template for one report at the same moment must not both get "version 1".
  perform pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array(v_org, null, null, null, p_export_key)::text, 0));

  select * into v_template
  from public.document_export_templates t
  where t.org_id = v_org and t.export_key = p_export_key and t.active
  for update;

  if not found then
    insert into public.document_export_templates (org_id, export_key, created_by)
    values (v_org, p_export_key, v_actor)
    returning * into v_template;
  end if;

  -- The next version of THIS template, not of the tenant. Versions are per template, as 0047 has
  -- them, so a report template's history reads 1, 2, 3 regardless of what other templates exist.
  select coalesce(max(v.version), 0) + 1 into v_version
  from public.document_export_template_versions v
  where v.org_id = v_org and v.template_id = v_template.id;

  v_contract := jsonb_build_object(
    'schema_version', '1',
    'name', v_name,
    'format', 'xlsx',
    'scope', jsonb_build_object('export_key', p_export_key));

  insert into public.document_export_template_versions (
    org_id, template_id, version, schema_version, format, contract, created_by
  ) values (
    v_org, v_template.id, v_version, '1', 'xlsx', v_contract, v_actor
  ) returning id into v_version_id;

  insert into public.audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_actor, 'export_report_template_proposed',
    'document_export_template_versions', v_version_id,
    jsonb_build_object('export_key', p_export_key, 'template_id', v_template.id,
                       'version', v_version, 'name', v_name),
    coalesce(v_reason, 'הצעת תבנית ייצוא לדוח — ללא הערה מהמשתמש')
  );

  return jsonb_build_object(
    'template_id', v_template.id, 'version_id', v_version_id, 'version', v_version);
end
$$;

revoke all on function public.propose_export_report_template(text, text, text) from public, anon;
grant execute on function public.propose_export_report_template(text, text, text) to authenticated;

comment on function public.propose_export_report_template(text, text, text) is
  'Creates the next unapproved version of the report template for this export key, creating the '
  'template on first use (0126). owner/office only. The contract it writes is a shell -- a report''s '
  'columns belong to the report -- and the content arrives next through '
  'attach_export_template_workbook.';

-- ===== 4. The draft may still be assembled =====
-- Anchored replacement, one branch inserted before the guard's final raise. The permitted update is
-- narrow in both directions: only the workbook columns may differ, and only while the version is
-- unapproved. Everything the guard refused yesterday it refuses today.
do $$
declare
  v_def text;
  v_nl text;
  v_old text :=
    E'  raise exception ''document_export_template_version_immutable'' using errcode = ''42501'';\nend';
  v_new text :=
    E'  -- 0126: before approval a version is a draft being assembled, and attaching the\n'
    '  -- accountant''''s workbook is the assembly. Only the workbook columns, and only while\n'
    '  -- nobody has approved it -- after that the row is the record of what was agreed.\n'
    '  if old.approved_at is null and new.approved_at is null\n'
    '     and old.approved_by is null and new.approved_by is null\n'
    '     and (to_jsonb(new) - array[''workbook_path'', ''workbook_name'', ''workbook_bytes'',\n'
    '                               ''workbook_checksum'', ''workbook_mime'', ''workbook_sheets'',\n'
    '                               ''workbook_placeholders''])\n'
    '          is not distinct from\n'
    '         (to_jsonb(old) - array[''workbook_path'', ''workbook_name'', ''workbook_bytes'',\n'
    '                               ''workbook_checksum'', ''workbook_mime'', ''workbook_sheets'',\n'
    '                               ''workbook_placeholders'']) then\n'
    '    return new;\n'
    '  end if;\n'
    '  raise exception ''document_export_template_version_immutable'' using errcode = ''42501'';\nend';
begin
  select pg_get_functiondef(
    to_regprocedure('public.guard_document_export_template_version()')) into v_def;
  if v_def is null then
    raise exception '0126: the version immutability guard is gone.';
  end if;
  if position('workbook_placeholders' in v_def) > 0 then
    return;
  end if;
  -- Measured on this machine: THIS function's prosrc carries CRLF while the validator above
  -- carries LF, in the same database, because they were created from files saved differently. So
  -- the line ending is read from the body rather than assumed, in both places.
  v_nl := case when position(chr(13) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
  v_old := replace(v_old, chr(10), v_nl);
  v_new := replace(v_new, chr(10), v_nl);

  if position(v_old in v_def) = 0 then
    raise exception
      '0126: the immutability guard does not end with the text 0047 wrote. Refusing to guess at an '
      'insert point inside the trigger that protects an approved template.';
  end if;
  execute replace(v_def, v_old, v_new);
end
$$;

-- ===== 4b. An approved report template has a file =====
create or replace function private.guard_report_template_approval()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_export_key text;
begin
  -- Only the moment of approval, and only for report templates. A document template's contract is
  -- its content, so it has nothing to attach and nothing to be missing.
  if new.approved_at is null or old.approved_at is not null then
    return new;
  end if;
  select t.export_key into v_export_key
  from public.document_export_templates t
  where t.org_id = new.org_id and t.id = new.template_id;
  if v_export_key is not null and new.workbook_path is null then
    raise exception 'export_template_workbook_required' using errcode = '55000';
  end if;
  return new;
end
$$;

drop trigger if exists guard_report_template_approval
  on public.document_export_template_versions;
create trigger guard_report_template_approval
  before update on public.document_export_template_versions
  for each row execute function private.guard_report_template_approval();

comment on function private.guard_report_template_approval() is
  'Refuses to approve a REPORT template version with no workbook (0126). A report contract is a '
  'shell, so an approved version with no file would become active_version_id and hand the export a '
  'template containing nothing. A trigger rather than an edit to '
  'approve_document_export_template_version, so the rule holds wherever an approval comes from.';

-- ===== 5. Reading the live one =====
create or replace function public.resolve_export_report_template(p_export_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_row record;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'export_template_not_authorized' using errcode = '42501';
  end if;
  -- Everyone who can produce one of these reports may read the template it will be rendered with.
  -- The accountant is the person the monthly report is FOR, and a template they cannot see is a
  -- layout they cannot query when the file looks wrong.
  if v_role not in ('owner', 'office', 'accountant') then
    raise exception 'export_template_not_authorized' using errcode = '42501';
  end if;

  select v.id, v.version, v.contract, v.workbook_path, v.workbook_name, v.workbook_bytes,
         v.workbook_checksum, v.workbook_sheets, v.workbook_placeholders, v.approved_at,
         t.id as template_id
    into v_row
  from public.document_export_templates t
  join public.document_export_template_versions v
    on v.org_id = t.org_id and v.id = t.active_version_id
  where t.org_id = v_org and t.export_key = p_export_key and t.active
    and v.approved_at is not null;

  if not found then
    -- Not an error. No template means the standard export, which is the fallback the plan keeps.
    return jsonb_build_object('found', false, 'export_key', p_export_key);
  end if;

  return jsonb_build_object(
    'found', true,
    'export_key', p_export_key,
    'template_id', v_row.template_id,
    'version_id', v_row.id,
    'version', v_row.version,
    'name', v_row.contract ->> 'name',
    'workbook_path', v_row.workbook_path,
    'workbook_name', v_row.workbook_name,
    'workbook_bytes', v_row.workbook_bytes,
    'workbook_checksum', v_row.workbook_checksum,
    'sheets', coalesce(v_row.workbook_sheets, '[]'::jsonb),
    'placeholders', coalesce(v_row.workbook_placeholders, '[]'::jsonb));
end
$$;

revoke all on function public.resolve_export_report_template(text) from public, anon;
grant execute on function public.resolve_export_report_template(text) to authenticated;

comment on function public.resolve_export_report_template(text) is
  'The live, approved report template for this export key, or found=false (0126). found=false is '
  'not an error: no template means the standard export, which stays the fallback.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values
  ('propose_export_report_template(text,text,text)',
   '0126 refuses any actor failing auth_org and the owner/office role gate, and every read, insert '
   'and lock is keyed on that same org_id. Export templates carry no unit meaning, so A5 has no '
   'unit predicate to want.'),
  ('resolve_export_report_template(text)',
   '0126 refuses any actor failing auth_org and the owner/office/accountant role gate, and joins '
   'both tables on that org_id. Read-only.')
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 6. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0126 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 7. Anchors =====
do $$
declare
  v_document_contract constant jsonb := jsonb_build_object(
    'schema_version', '1', 'name', 'anchor', 'format', 'csv',
    'scope', jsonb_build_object('document_type', 'invoice', 'supplier_id', null, 'user_id', null),
    'columns', jsonb_build_array(jsonb_build_object(
      'key', 'total', 'label', 'סה"כ', 'source_path', 'fields.total',
      'type', 'number', 'required', true)));
  v_report_contract constant jsonb := jsonb_build_object(
    'schema_version', '1', 'name', 'תבנית הרו״ח', 'format', 'xlsx',
    'scope', jsonb_build_object('export_key', 'accountant_monthly_report'));
begin
  -- (a) THE DOCUMENT PATH IS UNTOUCHED. This is the assertion the whole design of section 2 exists
  -- to earn: a contract that was valid before this migration is valid after it.
  if not public.document_export_template_contract_valid(v_document_contract) then
    raise exception
      '0126: A DOCUMENT CONTRACT THAT WAS VALID IS NOW REJECTED. The branch was meant to be taken '
      'only by report contracts.';
  end if;
  -- And still refuses what it always refused.
  if public.document_export_template_contract_valid(
       v_document_contract || jsonb_build_object('format', 'pdf')) then
    raise exception '0126: the document validator stopped refusing an unknown format.';
  end if;

  -- (b) The report path works, and refuses the shapes that would make a template meaningless.
  if not public.document_export_template_contract_valid(v_report_contract) then
    raise exception '0126: a report contract is rejected by the validator that must now accept it.';
  end if;
  if public.document_export_template_contract_valid(
       v_report_contract || jsonb_build_object('format', 'csv')) then
    raise exception '0126: a report template may be a csv, which has no formatting to preserve.';
  end if;
  if public.document_export_template_contract_valid(jsonb_set(
       v_report_contract, '{scope,export_key}', '"whatever_i_typed"'::jsonb)) then
    raise exception '0126: an export key nobody defined was accepted.';
  end if;
  if public.document_export_template_contract_valid(
       v_report_contract || jsonb_build_object('columns', '[]'::jsonb)) then
    raise exception
      '0126: a report contract carrying columns was accepted. A report''s columns belong to the '
      'report, and a second copy of them here would drift from it.';
  end if;

  -- (b2) The immutability guard learned the draft branch and kept the rest. Both halves matter:
  -- without the branch the attach command cannot run at all, and without the approval condition an
  -- approved template's file could be swapped by a plain UPDATE that never goes near the command.
  if position('workbook_placeholders' in pg_get_functiondef(
       to_regprocedure('public.guard_document_export_template_version()'))) = 0 then
    raise exception
      '0126: the immutability guard still refuses the workbook attachment, so '
      'attach_export_template_workbook cannot run.';
  end if;
  if position('old.approved_at is null and new.approved_at is null' in pg_get_functiondef(
       to_regprocedure('public.guard_document_export_template_version()'))) = 0 then
    raise exception
      '0126: THE WORKBOOK OF AN APPROVED VERSION CAN BE CHANGED BY A PLAIN UPDATE. The command '
      'refuses it, and the trigger is what makes that refusal mean something.';
  end if;

  -- (c) The workbook guard is attached, by name. Without it an approved report template can be a
  -- shell with no file, and the export would render nothing while looking configured.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.document_export_template_versions'::regclass
      and tgname = 'guard_report_template_approval'
      and not tgisinternal
  ) then
    raise exception '0126: a report template version can be approved with no workbook attached.';
  end if;

  -- (d) The tenant guard 0092 sweeps onto org-owned tables. The two tables here predate it and
  -- already carry it; this asserts the trigger above did not replace one of them.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.document_export_template_versions'::regclass
      and tgname = 'zz_organization_write_guard'
  ) then
    raise exception
      '0126: document_export_template_versions lost its organization write guard, so an expired '
      'tenant can still write template versions.';
  end if;
end
$$;
