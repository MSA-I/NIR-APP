-- P38 -- the accountant's own workbook becomes the export, and the four steps that get it there.
--
-- The whole of package K is one sentence a person acts out: propose a template for a report, attach
-- the workbook they sent us, approve it, and from then on the export renders into their layout. Each
-- of those four is a place the feature can go quietly wrong, and each wrong version looks configured
-- from the outside:
--
--   * a report contract forced through a validator written for documents,
--   * a DOCUMENT contract broken by the widening that let the report one through,
--   * an approved template with no file, which renders nothing while looking live,
--   * a file swapped underneath a version somebody already approved, which makes every export
--     already produced from it unexplainable,
--   * and a template from another tenant.
--
-- The assertions below are those five, plus the ordinary happy path they are the edges of.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p38_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P38 export template assertion failed: %', p_message;
  end if;
end
$$;

-- A checksum-shaped value. The command refuses anything that is not 64 lower hex, so the suite
-- cannot use 'abc' and pretend.
create function pg_temp.p38_sum(p_seed text)
returns text language sql immutable as $$
  select md5(p_seed) || md5(p_seed || 'x');
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('1a380000-0000-4000-8000-000000000001', 'P38 mine', 'active', 18),
  ('1a380000-0000-4000-8000-000000000002', 'P38 other tenant', 'active', 18);

insert into auth.users (id, email) values
  ('2a380000-0000-4000-8000-000000000001', 'owner-p38@example.test'),
  ('2a380000-0000-4000-8000-000000000002', 'office-p38@example.test'),
  ('2a380000-0000-4000-8000-000000000003', 'accountant-p38@example.test'),
  ('2a380000-0000-4000-8000-000000000004', 'owner-other-p38@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('2a380000-0000-4000-8000-000000000001', '1a380000-0000-4000-8000-000000000001',
   'P38 owner', 'owner'),
  ('2a380000-0000-4000-8000-000000000002', '1a380000-0000-4000-8000-000000000001',
   'P38 office', 'office'),
  ('2a380000-0000-4000-8000-000000000003', '1a380000-0000-4000-8000-000000000001',
   'P38 accountant', 'accountant'),
  ('2a380000-0000-4000-8000-000000000004', '1a380000-0000-4000-8000-000000000002',
   'P38 other owner', 'owner');

-- ===== 1. The widening did not touch the document path =====
--
-- 0126 puts one branch in front of a 140-line validator that a CHECK constraint depends on. The
-- cheapest way for that to be wrong is invisibly: document templates keep being proposed and start
-- being refused, or worse, stop being validated.

select pg_temp.p38_assert(
  public.document_export_template_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'P38 מסמך', 'format', 'csv',
    'scope', jsonb_build_object('document_type', 'invoice', 'supplier_id', null, 'user_id', null),
    'columns', jsonb_build_array(jsonb_build_object(
      'key', 'total', 'label', 'סה"כ', 'source_path', 'fields.total',
      'type', 'number', 'required', true)))),
  'a document contract that was valid before 0126 is rejected after it');

select pg_temp.p38_assert(
  not public.document_export_template_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'P38 מסמך', 'format', 'csv',
    'scope', jsonb_build_object('document_type', 'invoice', 'supplier_id', null, 'user_id', null),
    'columns', jsonb_build_array(jsonb_build_object(
      -- `payments.total` is not in document_export_source_path_allowed, and never was.
      'key', 'total', 'label', 'סה"כ', 'source_path', 'payments.total',
      'type', 'number', 'required', true)))),
  'the document validator stopped refusing a source path outside the allowed list. The widening was '
  'supposed to add a branch, not loosen the branch that was already there');

-- ===== 2. The report contract, and the shapes it refuses =====

select pg_temp.p38_assert(
  public.document_export_template_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'תבנית הרו״ח', 'format', 'xlsx',
    'scope', jsonb_build_object('export_key', 'accountant_monthly_report'))),
  'a report contract is rejected by the validator 0126 taught to accept it');

select pg_temp.p38_assert(
  not public.export_report_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'תבנית', 'format', 'csv',
    'scope', jsonb_build_object('export_key', 'accountant_monthly_report'))),
  'a report template may be a csv. The entire reason this feature exists is the formatting, and a '
  'csv has none');

select pg_temp.p38_assert(
  not public.export_report_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'תבנית', 'format', 'xlsx',
    'scope', jsonb_build_object('export_key', 'whatever_i_typed'))),
  'an export key nobody defined was accepted. The key is named by the code so an export can still '
  'find its template three releases later');

select pg_temp.p38_assert(
  not public.export_report_contract_valid(jsonb_build_object(
    'schema_version', '1', 'name', 'תבנית', 'format', 'xlsx',
    'scope', jsonb_build_object('export_key', 'accountant_monthly_report'),
    'columns', '[]'::jsonb)),
  'a report contract carrying columns was accepted. A report''s columns belong to the report, and a '
  'second copy here would drift from it');

-- ===== 3. Proposing, as the two roles that may and one that may not =====

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '2a380000-0000-4000-8000-000000000003', true);

do $$
begin
  perform public.propose_export_report_template(
    'accountant_monthly_report', 'P38 רואה חשבון מנסה', 'P38');
  raise exception 'P38 export template assertion failed: an accountant proposed an export '
    'template. The file it produces is sent to an accountant under this system''s name';
exception when sqlstate '42501' then
  if sqlerrm <> 'export_template_not_authorized' then raise; end if;
end
$$;

select set_config('request.jwt.claim.sub', '2a380000-0000-4000-8000-000000000001', true);

do $$
begin
  perform public.propose_export_report_template('not_a_report', 'P38', 'P38');
  raise exception 'P38 export template assertion failed: a template was proposed for an export key '
    'that does not exist';
exception when sqlstate '22023' then
  if sqlerrm <> 'export_template_key_unknown' then raise; end if;
end
$$;

do $$
begin
  perform public.propose_export_report_template('accountant_monthly_report', '   ', 'P38');
  raise exception 'P38 export template assertion failed: a template was proposed with no name. The '
    'name is what a person recognises it by a year later';
exception when sqlstate '22023' then
  if sqlerrm <> 'export_template_name_required' then raise; end if;
end
$$;

create temporary table p38_first as
select public.propose_export_report_template(
  'accountant_monthly_report', 'תבנית הרו״ח — מרץ', 'P38 הצעה ראשונה') as r;

select pg_temp.p38_assert(
  (select (r ->> 'version')::integer = 1 and (r ->> 'version_id') is not null from p38_first),
  'the first proposal is not version 1');

-- The template is created once and reused. A second proposal is a second VERSION of the same
-- template, not a second active template for the same report.
create temporary table p38_second as
select public.propose_export_report_template(
  'accountant_monthly_report', 'תבנית הרו״ח — אפריל', 'P38 הצעה שנייה') as r;

select pg_temp.p38_assert(
  (select (b.r ->> 'template_id') = (a.r ->> 'template_id')
          and (b.r ->> 'version')::integer = 2
   from p38_first a, p38_second b),
  'a second proposal created a second template instead of a second version. Two active templates '
  'for one report is what the unique index exists to prevent, and the resolver would pick between '
  'them by accident');

select pg_temp.p38_assert(
  (select count(*) = 1 from public.document_export_templates
   where org_id = '1a380000-0000-4000-8000-000000000001'
     and export_key = 'accountant_monthly_report' and active),
  'more than one active template exists for one export key');

-- ===== 4. Approval refuses a version with no workbook =====

do $$
declare
  v_version uuid;
begin
  select (r ->> 'version_id')::uuid into v_version from p38_first;
  perform public.approve_document_export_template_version(v_version, 'P38 מאשר בלי קובץ');
  raise exception 'P38 export template assertion failed: A REPORT TEMPLATE WAS APPROVED WITH NO '
    'WORKBOOK. It becomes active_version_id and the export renders nothing while looking configured';
exception when sqlstate '55000' then
  if sqlerrm <> 'export_template_workbook_required' then raise; end if;
end
$$;

-- ===== 5. Attaching the workbook =====

do $$
declare
  v_version uuid;
begin
  select (r ->> 'version_id')::uuid into v_version from p38_first;

  -- A path outside the caller's own tenant folder.
  begin
    perform public.attach_export_template_workbook(
      v_version, '1a380000-0000-4000-8000-000000000002/stolen.xlsx', 'stolen.xlsx',
      1024, pg_temp.p38_sum('a'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '[]'::jsonb, '[]'::jsonb, 'P38');
    raise exception 'P38 export template assertion failed: a workbook path in ANOTHER TENANT''S '
      'folder was accepted. The prefix is meant to be read and compared, never trusted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'export_template_path_invalid' then raise; end if;
  end;

  -- A macro-enabled workbook, refused in the database and not only in the upload form.
  begin
    perform public.attach_export_template_workbook(
      v_version, '1a380000-0000-4000-8000-000000000001/macro.xlsm', 'macro.xlsm',
      1024, pg_temp.p38_sum('b'), 'application/vnd.ms-excel.sheet.macroEnabled.12',
      '[]'::jsonb, '[]'::jsonb, 'P38');
    raise exception 'P38 export template assertion failed: A MACRO-ENABLED WORKBOOK WAS ACCEPTED. '
      'This file is handed to an accountant every month under this system''s name';
  exception when sqlstate '22023' then
    if sqlerrm <> 'export_template_format_refused' then raise; end if;
  end;

  -- A checksum that is not one.
  begin
    perform public.attach_export_template_workbook(
      v_version, '1a380000-0000-4000-8000-000000000001/ok.xlsx', 'ok.xlsx',
      1024, 'not-a-checksum',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '[]'::jsonb, '[]'::jsonb, 'P38');
    raise exception 'P38 export template assertion failed: a workbook was recorded with a checksum '
      'nobody could verify';
  exception when sqlstate '22023' then
    if sqlerrm <> 'export_template_checksum_invalid' then raise; end if;
  end;

  perform public.attach_export_template_workbook(
    v_version, '1a380000-0000-4000-8000-000000000001/march.xlsx', 'מרץ.xlsx',
    204800, pg_temp.p38_sum('march'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jsonb_build_array(jsonb_build_object('name', 'דוח', 'headers', jsonb_build_array('ספק', 'סכום'),
                                         'rows', 20, 'columns', 4)),
    jsonb_build_array(jsonb_build_object('key', 'net_total', 'sheet', 'דוח', 'cell', 'B2',
                                         'source', 'net_total')),
    'P38 החוברת של הרו״ח');
end
$$;

select pg_temp.p38_assert(
  (select v.workbook_name = 'מרץ.xlsx'
          and jsonb_array_length(v.workbook_placeholders) = 1
          and v.workbook_placeholders -> 0 ->> 'source' = 'net_total'
   from public.document_export_template_versions v, p38_first f
   where v.id = (f.r ->> 'version_id')::uuid),
  'the workbook and the mapping a person approved were not recorded');

-- ===== 6. Approval, and the immutability it buys =====

do $$
declare
  v_version uuid;
begin
  select (r ->> 'version_id')::uuid into v_version from p38_first;
  perform public.approve_document_export_template_version(v_version, 'P38 מאשר');

  -- The file may not be swapped underneath an approved version.
  begin
    perform public.attach_export_template_workbook(
      v_version, '1a380000-0000-4000-8000-000000000001/april.xlsx', 'אפריל.xlsx',
      204800, pg_temp.p38_sum('april'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '[]'::jsonb, '[]'::jsonb, 'P38');
    raise exception 'P38 export template assertion failed: THE WORKBOOK OF AN APPROVED VERSION WAS '
      'REPLACED. Every export already produced from it becomes unexplainable';
  exception when sqlstate '55000' then
    if sqlerrm <> 'export_template_version_already_approved' then raise; end if;
  end;
end
$$;

-- ===== 7. Resolving the live one =====

select pg_temp.p38_assert(
  (select (r ->> 'found')::boolean
          and r ->> 'workbook_name' = 'מרץ.xlsx'
          and r ->> 'name' = 'תבנית הרו״ח — מרץ'
          and jsonb_array_length(r -> 'placeholders') = 1
   from public.resolve_export_report_template('accountant_monthly_report') r),
  'the approved template is not what the export resolves to');

-- A report with no template is not an error. It is the standard export, which stays the fallback.
select pg_temp.p38_assert(
  (select (r ->> 'found')::boolean = false
   from public.resolve_export_report_template('owner_expense_summary') r),
  'a report with no template raised instead of answering found=false. No template means the '
  'standard export, and an error there would break an export that works');

-- The unapproved second version is invisible to the resolver: approving is what makes a template
-- live, and a proposal sitting beside it must not change what the export renders.
select pg_temp.p38_assert(
  (select (r ->> 'version')::integer = 1
   from public.resolve_export_report_template('accountant_monthly_report') r),
  'an unapproved version is being resolved as the live template');

-- ===== 8. Another tenant sees none of it =====

select set_config('request.jwt.claim.sub', '2a380000-0000-4000-8000-000000000004', true);
select pg_temp.p38_assert(
  (select (r ->> 'found')::boolean = false
   from public.resolve_export_report_template('accountant_monthly_report') r),
  'ANOTHER TENANT RESOLVED THIS ORGANISATION''S TEMPLATE');

-- The accountant may read the template their own report is rendered with; they may not propose one.
select set_config('request.jwt.claim.sub', '2a380000-0000-4000-8000-000000000003', true);
select pg_temp.p38_assert(
  (select (r ->> 'found')::boolean
   from public.resolve_export_report_template('accountant_monthly_report') r),
  'the accountant cannot see the template their own monthly report is rendered with, which is the '
  'layout they would need to query when the file looks wrong');

do $$
begin
  perform public.propose_export_report_template('accountant_monthly_report', 'P38 רו״ח', 'P38');
  raise exception 'P38 export template assertion failed: the accountant proposed a template';
exception when sqlstate '42501' then
  if sqlerrm <> 'export_template_not_authorized' then raise; end if;
end
$$;

reset role;
rollback;
