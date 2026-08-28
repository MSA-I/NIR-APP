-- p11 — filing a document to the archive, and rescuing it back out with a reason.
--
-- Run against a freshly reset disposable local database after migration 0075.
-- Everything is rolled back; the suite never leaves business data behind.
--
-- What this suite defends, one area per paragraph:
--
--   (a) The archive is a REAL target of file_document -- 'archive' with a null entity -- and
--       the THREE gates that used to refuse it all agree now: the check constraint
--       documents_inbox_entity, the column-guard trigger documents_guard_columns, and
--       file_document's own target validation. A2's review found the first; the other two
--       were found by reading the LIVE catalogue, because the migration text is stale for
--       both (documents_guard_columns was last written by 0045, not 0019).
--
--   (b) The hole is exactly the size of the new case. Relaxing documents_inbox_entity must
--       not let entity_type='invoice' carry a null entity -- that is the invariant 0014:15-16
--       exists to hold, and dropping the constraint outright would have lost it silently.
--
--   (c) Rescue is its own command with its own reason. A human may pull a document back out
--       of the archive and must say why; a human may delete from the archive without a
--       reason, and that path already exists (soft delete, 0010, decision #28) and is not
--       re-invented here. The reason requirement is STRUCTURAL: it is a different function,
--       not a parameter of the filing commands, so "was a reason required?" cannot come to
--       depend on a prop.
--
--   (d) The archive is not a black hole. docs_storage_read DOES gate on entity_type -- but
--       only inside its accountant arm. owner/office, the STAFF roles that can reach
--       /documents/archive (App.tsx:102,248), match an arm that never looks at entity_type,
--       so an archived document's bytes stay downloadable and צפייה במקור keeps working.
--       Asserted rather than reasoned about, because it is the failure nobody would notice
--       until a person clicked the only action the archive screen has.
--
--   (e) Two mutation proofs: drop the partial unique index and an assertion fails; strip the
--       reason guard out of the live rescue definition and an assertion fails. Both restore
--       by savepoint rollback -- the p5_domain_events.sql idiom.
--
-- Anti-silent-revert anchors ride along: file_document must still be SECURITY DEFINER after
-- 0075 (0022:388 made it so while 0019's text still says invoker, so re-declaring from that
-- text would quietly revert it), and documents_insert must still NOT admit 'archive' -- it is
-- an INSERT policy, file_document performs an UPDATE, so it is not on this write path, and
-- opening it would create the browser route into the archive that DocumentsInbox.tsx:492-495
-- says must not exist.
\set ON_ERROR_STOP on

begin;

-- Legacy invoice fixtures in this transaction predate multi-currency and are explicitly ILS.
alter table public.invoices alter column currency set default 'ILS';

create function pg_temp.p11_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P11 document filing assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p4b_correlation.sql:34 / p5_domain_events.sql idiom. Role is switched
-- with set_config rather than SET LOCAL ROLE so the same helper works inside PL/pgSQL, where
-- an aborted subtransaction also rolls the GUC back for us.
create function pg_temp.p11_become(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub::text)::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function pg_temp.p11_unbecome()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
end
$$;

-- Runs a statement as one actor and returns the message it raised, or null on success. Keeps
-- every negative assertion NAMING the error it expects rather than merely observing failure.
create function pg_temp.p11_error(p_sub uuid, p_sql text)
returns text
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    perform pg_temp.p11_become(p_sub);
    execute p_sql;
    perform pg_temp.p11_unbecome();
    return null;
  exception when others then
    v_message := sqlerrm;
    perform pg_temp.p11_unbecome();
    return v_message;
  end;
end
$$;

-- Counts what ONE actor can actually see, under RLS. Invoker security, so the select runs as
-- whatever role p11_become installed.
create function pg_temp.p11_visible_filings(p_sub uuid)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  perform pg_temp.p11_become(p_sub);
  select count(*) into v_count from public.document_filings;
  perform pg_temp.p11_unbecome();
  return v_count;
end
$$;

create function pg_temp.p11_visible_objects(p_sub uuid, p_name text)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  perform pg_temp.p11_become(p_sub);
  select count(*) into v_count from storage.objects where name = p_name;
  perform pg_temp.p11_unbecome();
  return v_count;
end
$$;

create function pg_temp.p11_visible_documents(p_sub uuid, p_id uuid)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  perform pg_temp.p11_become(p_sub);
  select count(*) into v_count from public.documents where id = p_id;
  perform pg_temp.p11_unbecome();
  return v_count;
end
$$;

-- ===== 0. Structural proofs, before a single row exists =====

select pg_temp.p11_assert(
  to_regclass('public.document_filings') is not null,
  'document_filings must exist');

-- Derived tables inherit tenant and scope through their parent and must never carry a scope
-- column of their own (ADR-0004 section 4). All twelve sibling document_* tables are
-- classified exactly this way; a thirteenth that disagreed would be the anomaly.
select pg_temp.p11_assert(
  (select scope_class = 'derived' and not enforced
   from private.scope_registry where table_name = 'document_filings'),
  'document_filings must be registered derived/unenforced, like every document_* sibling');

select pg_temp.p11_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'document_filings'
      and column_name = 'unit_id'),
  'a derived table must not receive its own scope column');

select pg_temp.p11_assert(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.document_filings'::regclass),
  'document_filings must have RLS enabled AND forced');

select pg_temp.p11_assert(
  exists (
    select 1 from pg_policy
    where polrelid = 'public.document_filings'::regclass
      and pg_get_expr(polqual, polrelid) like '%auth_org()%'),
  'document_filings RLS must filter on auth_org()');

-- Cross-tenant pointers are impossible STRUCTURALLY, not by policy: the tenant travels inside
-- every key that points at a tenant-scoped parent -- the convention document_extractions and
-- document_processing_jobs already follow. The FK to organizations is the tenant itself and is
-- correctly single-column, so it is the one exception and is named as such.
select pg_temp.p11_assert(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_filings'::regclass and contype = 'f'
      and confrelid <> 'public.organizations'::regclass
      and pg_get_constraintdef(oid) not like 'FOREIGN KEY (org_id,%'),
  'every filing FK to a tenant-scoped parent must lead with org_id');

select pg_temp.p11_assert(
  (select count(*) = 3 from pg_constraint
   where conrelid = 'public.document_filings'::regclass and contype = 'f'
     and confrelid <> 'public.organizations'::regclass),
  'the filing row must be tenant-bound to its document, supplier and interpretation');

-- ON DELETE RESTRICT on all four. Decision 4 of this task: a filing survives its document's
-- soft delete, and a CASCADE here would quietly erase the decision along with a hard delete.
select pg_temp.p11_assert(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_filings'::regclass and contype = 'f'
      and confdeltype <> 'r'),
  'every filing foreign key must be ON DELETE RESTRICT -- a filing decision is never cascaded away');

-- The browser reads filings and never writes them. This is the whole reason the rescue RPC is
-- SECURITY DEFINER: were it invoker, authenticated would need UPDATE here, and a plain
-- PostgREST PATCH could then set reverted_at with no reason -- defeating (c) above.
-- service_role's full CRUD is the project ACL contract, not a statement about this table:
-- p0_client_dml_acl.sql:36-40 fails if any public server table is missing DELETE for it. So the
-- grant is asserted here for what it is, and the table's real integrity contract is asserted
-- separately below, where a trigger enforces it regardless of the grant.
select pg_temp.p11_assert(
  has_table_privilege('authenticated', 'public.document_filings', 'SELECT')
    and not has_table_privilege('authenticated', 'public.document_filings', 'INSERT')
    and not has_table_privilege('authenticated', 'public.document_filings', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.document_filings', 'DELETE')
    and has_table_privilege('service_role', 'public.document_filings', 'SELECT')
    and has_table_privilege('service_role', 'public.document_filings', 'INSERT')
    and has_table_privilege('service_role', 'public.document_filings', 'UPDATE')
    and has_table_privilege('service_role', 'public.document_filings', 'DELETE'),
  'document_filings must be browser-read-only, with the full service_role CRUD the P0 ACL demands');

select pg_temp.p11_assert(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.document_filings'::regclass
      and tgname = 'document_filings_guard_columns_trg' and not tgisinternal),
  'the filing ledger must carry its column guard -- the grant above cannot be the integrity story');

select pg_temp.p11_assert(
  has_function_privilege(
    'authenticated', 'public.rescue_document_from_archive(uuid,text)', 'EXECUTE')
    and not has_function_privilege(
      'anon', 'public.rescue_document_from_archive(uuid,text)', 'EXECUTE')
    and not exists (
      select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = 'public.rescue_document_from_archive(uuid,text)'::regprocedure
        and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'rescue must be granted to authenticated and to nobody else by default');

-- A5 of 0057: a SECURITY DEFINER function touching an enforced table (documents) must be
-- scope-aware or hold an exemption row. Rescue holds one, exactly as file_document does.
select pg_temp.p11_assert(
  (select prosecdef from pg_proc
   where oid = 'public.rescue_document_from_archive(uuid,text)'::regprocedure)
    and exists (
      select 1 from private.scope_definer_exemptions
      where function_signature = 'rescue_document_from_archive(uuid,text)'),
  'rescue must be SECURITY DEFINER and carry its A5 exemption row');

-- ANCESTRY ANCHOR. 0022:388 altered file_document to SECURITY DEFINER while 0019's text still
-- reads `security invoker`. A migration that re-declared it from 0019 would silently restore
-- invoker; this assertion is what makes that loud instead of quiet.
select pg_temp.p11_assert(
  (select prosecdef from pg_proc
   where oid = 'public.file_document(uuid,text,uuid,text)'::regprocedure),
  'file_document must remain SECURITY DEFINER (0022:388) -- 0019 text would revert it');

-- The sibling anchor. documents_guard_columns is also a definer and also holds an A5 exemption
-- row, so a downgrade there is the same class of silent change -- and 0075 patches its body by
-- the same replay. Asserting one and not the other left a real gap: `alter function
-- documents_guard_columns() security invoker` used to leave this suite exiting 0.
select pg_temp.p11_assert(
  (select prosecdef from pg_proc
   where oid = 'public.documents_guard_columns()'::regprocedure),
  'documents_guard_columns must remain SECURITY DEFINER');

-- The trigger 0075 deliberately does NOT recreate must still be wired to it. `create or replace
-- function` preserves the OID, which is why recreating it was unnecessary -- but "unnecessary"
-- is only safe if something checks, so this is that check.
select pg_temp.p11_assert(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.documents'::regclass
      and tgname = 'documents_guard_columns_trg' and not tgisinternal
      and tgfoid = 'public.documents_guard_columns()'::regprocedure),
  'documents_guard_columns_trg must still fire the patched guard');

-- The decision NOT to widen the INSERT policy, pinned. file_document performs an UPDATE, so
-- 'archive' is not needed here; adding it would open a browser upload straight into the
-- archive, contradicting the screen shipped one commit earlier.
select pg_temp.p11_assert(
  pg_get_expr(polwithcheck, polrelid) not like '%''archive''%',
  'documents_insert must NOT admit archive -- there is no human upload path into the archive')
from pg_policy
where polrelid = 'public.documents'::regclass and polname = 'documents_insert';

-- (b): the constraint was narrowed, not dropped.
select pg_temp.p11_assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'documents_inbox_entity'),
  'documents_inbox_entity must still exist -- the hole is narrowed, not dropped');

-- THE FENCE THAT ACTUALLY HOLDS, pinned for the first time in this repo.
--
-- 0075 makes a row state legal that was impossible before, so what stops a browser writing it
-- directly matters more than usual. It is a COLUMN GRANT and nothing else: `authenticated` holds
-- UPDATE on deleted_at/deleted_by only, and no table-level UPDATE at all. Not the GUC fence in
-- documents_guard_columns -- that is gated on `auth.uid() is not null` and service_role, the only
-- grantee of UPDATE on entity_type, has a null auth.uid(), so it never evaluates for the one role
-- that could perform the write. It is a tripwire for a future grant widening, not today's fence.
--
-- p0_client_dml_acl.sql:156 pins documents.storage_path this way and stops there. These two
-- columns are the ones 0075 puts in play, and nothing asserted them.
select pg_temp.p11_assert(
  not has_column_privilege('authenticated', 'public.documents', 'entity_type', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.documents', 'entity_id', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.documents', 'UPDATE'),
  'authenticated must hold no UPDATE on entity_type/entity_id and none on the table');

-- ...and the same fence observed rather than described, in both directions. These run before the
-- fixture exists, so they probe the grant itself: privilege is checked ahead of row visibility,
-- which is exactly why a non-existent row still returns permission denied.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$update public.documents set entity_type = 'archive', entity_id = null
      where id = '00000000-0000-4000-8000-000000000000'$$
  ) like '%permission denied for table documents%',
  'a direct PATCH into the archive must be refused at the column grant, by name');

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$update public.documents set entity_type = 'inbox', entity_id = null
      where id = '00000000-0000-4000-8000-000000000000'$$
  ) like '%permission denied for table documents%',
  'a direct PATCH back out of the archive must be refused the same way');

-- The soft-delete columns stay writable: that is decision #28's reason-free removal path, which
-- the archive screen now exposes, and it must NOT be collateral damage of the assertions above.
select pg_temp.p11_assert(
  has_column_privilege('authenticated', 'public.documents', 'deleted_at', 'UPDATE')
    and has_column_privilege('authenticated', 'public.documents', 'deleted_by', 'UPDATE'),
  'the soft-delete columns must stay writable -- removal from the archive depends on them');

-- ===== Fixture: two tenants, four actors, documents about to be archived =====

insert into public.organizations (id, name, status) values
  ('d1f00000-0000-4000-8000-000000000001', 'P11 tenant A', 'active'),
  ('d1f00000-0000-4000-8000-000000000002', 'P11 tenant B', 'active');

insert into auth.users (id, email) values
  ('d1f00000-0000-4000-8000-00000000000a', 'p11-owner-a@example.test'),
  ('d1f00000-0000-4000-8000-00000000000b', 'p11-office-a@example.test'),
  ('d1f00000-0000-4000-8000-00000000000c', 'p11-accountant-a@example.test'),
  ('d1f00000-0000-4000-8000-00000000000d', 'p11-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('d1f00000-0000-4000-8000-00000000000a', 'd1f00000-0000-4000-8000-000000000001', 'P11 owner A', 'owner'),
  ('d1f00000-0000-4000-8000-00000000000b', 'd1f00000-0000-4000-8000-000000000001', 'P11 office A', 'office'),
  ('d1f00000-0000-4000-8000-00000000000c', 'd1f00000-0000-4000-8000-000000000001', 'P11 accountant A', 'accountant'),
  ('d1f00000-0000-4000-8000-00000000000d', 'd1f00000-0000-4000-8000-000000000002', 'P11 owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('d1f00000-0000-4000-8000-0000000000a1', 'd1f00000-0000-4000-8000-000000000001', 'ספק P11 א'),
  ('d1f00000-0000-4000-8000-0000000000a2', 'd1f00000-0000-4000-8000-000000000002', 'ספק P11 ב');

-- Exists only to be an ILLEGAL archive target: the archive carries no entity, and this is a
-- real, in-tenant, otherwise-fileable id, so the rejection cannot be blamed on a bad uuid.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, received_by
) values (
  'd1f00000-0000-4000-8000-0000000000b1', 'd1f00000-0000-4000-8000-000000000001',
  'd1f00000-0000-4000-8000-0000000000a1', 'P11-1001', current_date,
  100, 18, 118, 'd1f00000-0000-4000-8000-00000000000a'
);

-- Three inbox documents in tenant A: one to archive, one as the untouched control, one spare.
-- Plus one in tenant B for the isolation assertions.
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
)
select
  ('d1f00000-0000-4000-8000-0000000000c' || n)::uuid,
  'd1f00000-0000-4000-8000-000000000001',
  'inbox', null,
  'd1f00000-0000-4000-8000-000000000001/p11/' || n || '.pdf',
  'p11-' || n || '.pdf', 'application/pdf', 'other',
  'd1f00000-0000-4000-8000-00000000000a'
from generate_series(1, 3) n;

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values (
  'd1f00000-0000-4000-8000-0000000000d1', 'd1f00000-0000-4000-8000-000000000002',
  'inbox', null,
  'd1f00000-0000-4000-8000-000000000002/p11/b1.pdf',
  'p11-b1.pdf', 'application/pdf', 'other',
  'd1f00000-0000-4000-8000-00000000000d'
);

insert into storage.objects (bucket_id, name, owner, metadata)
select
  'documents',
  'd1f00000-0000-4000-8000-000000000001/p11/' || n || '.pdf',
  'd1f00000-0000-4000-8000-00000000000a'::uuid,
  jsonb_build_object('mimetype', 'application/pdf', 'size', 1024, 'eTag', repeat(n::text, 32))
from generate_series(1, 3) n;

-- ===== 1. file_document accepts the archive, with a null entity and a reason =====

select pg_temp.p11_become('d1f00000-0000-4000-8000-00000000000a');
select public.file_document(
  'd1f00000-0000-4000-8000-0000000000c1', 'archive', null,
  'המערכת לא הצליחה לשייך את המסמך לאף קטגוריה');
select pg_temp.p11_unbecome();

select pg_temp.p11_assert(
  (select entity_type = 'archive' and entity_id is null
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'file_document must move the document to the archive with a null entity');

-- The reason is not decoration: it is what the audit row is for.
select pg_temp.p11_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = 'd1f00000-0000-4000-8000-000000000001'
      and entity_type = 'documents'
      and entity_id = 'd1f00000-0000-4000-8000-0000000000c1'
      and action = 'document_refiled'
      and reason = 'המערכת לא הצליחה לשייך את המסמך לאף קטגוריה'
      and new_values ->> 'entity_type' = 'archive'),
  'archiving must write an audit row carrying the caller''s reason verbatim');

-- Archiving does not forget what was already known about the document. The uploader's
-- supplier and date survive: "no business record fits this" is not "nothing is known".
select pg_temp.p11_assert(
  (select new_values ->> 'entity_id' is null
   from public.audit_logs
   where entity_id = 'd1f00000-0000-4000-8000-0000000000c1' and action = 'document_refiled'),
  'the archive audit row must record a null entity, not a fabricated one');

-- ===== 2. The archive carries no entity: a target id is refused BY NAME =====

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.file_document(
        'd1f00000-0000-4000-8000-0000000000c2', 'archive',
        'd1f00000-0000-4000-8000-0000000000b1', 'ניסיון לשייך ארכיון לישות')$$
  ) like '%document_target_invalid%',
  'file_document must refuse an archive target that carries an entity id, by name');

-- ...and the symmetric half: a business target still REQUIRES its entity.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.file_document(
        'd1f00000-0000-4000-8000-0000000000c2', 'invoice', null, 'חשבונית בלי ישות')$$
  ) like '%document_target_invalid%',
  'a business target must still require an entity id');

-- The control document was not touched by either rejected call.
select pg_temp.p11_assert(
  (select entity_type = 'inbox' and entity_id is null
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c2'),
  'a rejected filing must leave the document exactly where it was');

-- ===== 2b. The paths 0075 did NOT come to change must still work =====
--
-- 0075 rewrites file_document's target-derivation block to give the archive a branch. That edit
-- is the one thing in this migration that could break filing to a real business record, and the
-- rest of this suite is entirely about the archive -- so it would not notice. These assert the
-- pre-existing contract: an invoice target still files, still derives supplier and date from
-- the invoice, and an unknown target is still refused by its own name.

select pg_temp.p11_become('d1f00000-0000-4000-8000-00000000000a');
select public.file_document(
  'd1f00000-0000-4000-8000-0000000000c3', 'invoice',
  'd1f00000-0000-4000-8000-0000000000b1', 'שיוך מסמך לחשבונית');
select pg_temp.p11_unbecome();

select pg_temp.p11_assert(
  (select entity_type = 'invoice'
      and entity_id = 'd1f00000-0000-4000-8000-0000000000b1'
      and supplier_id = 'd1f00000-0000-4000-8000-0000000000a1'
      and document_date = current_date
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c3'),
  'filing to an invoice must still derive supplier and date from the target (0019 contract)');

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.file_document(
        'd1f00000-0000-4000-8000-0000000000c2', 'invoice',
        'd1f00000-0000-4000-8000-0000000000bf', 'חשבונית שאינה קיימת')$$
  ) like '%document_target_unknown%',
  'an unknown invoice target must still be refused by name');

-- A document already filed to a business record cannot be archived behind the app's back: the
-- guard takes only a row still in the inbox, and 0075 did not widen that.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.file_document(
        'd1f00000-0000-4000-8000-0000000000c3', 'archive', null, 'ארכוב מסמך משויך')$$
  ) like '%document_already_filed%',
  'a document already filed to a business record must not be archivable');

-- ===== 3. (b) the relaxed constraint is exactly one case wider =====

select pg_temp.p11_assert(
  (select count(*) = 1 from public.documents
   where id = 'd1f00000-0000-4000-8000-0000000000c1'
     and entity_type = 'archive' and entity_id is null),
  'an archive row with a null entity must satisfy documents_inbox_entity');

-- ...and 'invoice' with a null entity is still refused at the CONSTRAINT level, independent of
-- any RPC. This is the invariant 0014:15-16 exists to hold, and the reason the constraint was
-- replaced rather than dropped.
savepoint p11_constraint_probe;
do $$
declare
  v_state text;
begin
  begin
    insert into public.documents (
      id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
      document_kind, uploaded_by
    ) values (
      'd1f00000-0000-4000-8000-0000000000ee', 'd1f00000-0000-4000-8000-000000000001',
      'invoice', null, 'd1f00000-0000-4000-8000-000000000001/p11/bad.pdf',
      'bad.pdf', 'application/pdf', 'other', 'd1f00000-0000-4000-8000-00000000000a');
    raise exception 'P11 document filing assertion failed: entity_type=invoice with a null entity must still violate documents_inbox_entity';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      if v_state <> '23514' then raise; end if;
  end;
end
$$;
rollback to savepoint p11_constraint_probe;

-- ===== 4. The filing ledger: trusted-server write, tenant-isolated read =====

-- C2 will be the real writer. Here the trusted path is exercised directly, which is also the
-- proof that the service_role grant works and the browser grant does not.
set local role service_role;
insert into public.document_filings (
  org_id, document_id, category, supplier_id, confidence, decided_by
) values (
  'd1f00000-0000-4000-8000-000000000001', 'd1f00000-0000-4000-8000-0000000000c1',
  'other', 'd1f00000-0000-4000-8000-0000000000a1', 0.42, 'system'
);
reset role;

select pg_temp.p11_assert(
  pg_temp.p11_visible_filings('d1f00000-0000-4000-8000-00000000000a') = 1,
  'tenant A must see its own filing row');

select pg_temp.p11_assert(
  pg_temp.p11_visible_filings('d1f00000-0000-4000-8000-00000000000d') = 0,
  'tenant B must not see tenant A''s filing row');

-- Two separate mechanisms, asserted separately, each naming its own refusal. Combining them
-- (a cross-tenant org_id AND no grant) would let either one carry the assertion and prove
-- neither.
--
-- (i) The browser holds no INSERT grant, so a wholly in-tenant, otherwise-valid row is still
--     refused -- and refused at the privilege layer, by name.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$insert into public.document_filings (org_id, document_id, category, decided_by)
      values ('d1f00000-0000-4000-8000-000000000001',
              'd1f00000-0000-4000-8000-0000000000c2', 'other', 'system')$$
  ) like '%permission denied%',
  'the browser must hold no INSERT grant on document_filings, refused by name');

select pg_temp.p11_assert(
  not has_table_privilege('authenticated', 'public.document_filings', 'INSERT'),
  'the INSERT refusal above must be the missing grant, stated directly');

-- (ii) And independently of any grant, the composite key makes a cross-tenant filing
--      unrepresentable. Run as the superuser so the grant cannot be what refuses it.
create function pg_temp.p11_cross_tenant_filing_rejected()
returns text
language plpgsql
as $$
begin
  begin
    insert into public.document_filings (org_id, document_id, category, decided_by)
    values ('d1f00000-0000-4000-8000-000000000002',
            'd1f00000-0000-4000-8000-0000000000c2', 'other', 'system');
    return '(accepted)';
  exception when foreign_key_violation then
    return sqlerrm;
  end;
end
$$;

savepoint p11_cross_tenant_filing;
select pg_temp.p11_assert(
  pg_temp.p11_cross_tenant_filing_rejected() like '%document_filings_document_tenant_fk%',
  'tenant B''s org_id with tenant A''s document must fail on the composite key, named');
rollback to savepoint p11_cross_tenant_filing;

-- ===== 5. Confidence is nullable, and null means unknown -- never a fabricated zero =====

select pg_temp.p11_assert(
  (select is_nullable = 'YES' from information_schema.columns
   where table_schema = 'public' and table_name = 'document_filings'
     and column_name = 'confidence'),
  'confidence must be nullable: no datum is null, never 0');

select pg_temp.p11_assert(
  (select confidence = 0.42 from public.document_filings
   where document_id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'a supplied confidence must be stored as given');

-- Confidence is a probability or it is nothing. Matches smart_document_confidence_valid
-- (0046) exactly: null passes, anything outside 0..1 does not.
create function pg_temp.p11_bad_confidence_rejected(p_value numeric)
returns boolean
language plpgsql
as $$
begin
  begin
    insert into public.document_filings (org_id, document_id, category, decided_by, confidence)
    values ('d1f00000-0000-4000-8000-000000000001',
            'd1f00000-0000-4000-8000-0000000000c2', 'other', 'system', p_value);
    return false;
  exception when check_violation then
    return true;
  end;
end
$$;

savepoint p11_confidence_range;
select pg_temp.p11_assert(
  pg_temp.p11_bad_confidence_rejected(1.5) and pg_temp.p11_bad_confidence_rejected(-0.1),
  'a confidence outside 0..1 must be refused -- it is a probability or it is nothing');
rollback to savepoint p11_confidence_range;

-- category carries the interpretation contract's vocabulary, spelled out at the table. C2's
-- whole autonomy decision turns on this value, and a free-text column would accept
-- 'delivery-note' for 'delivery_note' with nobody the wiser until a filing went wrong.
savepoint p11_category_vocabulary;
do $$
begin
  begin
    insert into public.document_filings (org_id, document_id, category, decided_by)
    values ('d1f00000-0000-4000-8000-000000000001',
            'd1f00000-0000-4000-8000-0000000000c2', 'delivery-note', 'system');
    raise exception 'P11 document filing assertion failed: category outside the interpretation contract vocabulary must be refused';
  exception when check_violation then null;
  end;
end
$$;
rollback to savepoint p11_category_vocabulary;

-- ...and every value the contract DOES define is accepted, so the copy cannot silently
-- narrow the vocabulary it claims to mirror (0046:45-47).
savepoint p11_category_accepts_contract;
insert into public.document_filings (org_id, document_id, category, decided_by)
select 'd1f00000-0000-4000-8000-000000000001',
       'd1f00000-0000-4000-8000-0000000000c2', v, 'system'
from unnest(array['invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
                  'payment_confirmation', 'other']) v
limit 1;
select pg_temp.p11_assert(
  not exists (
    select 1
    from unnest(array['invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
                      'payment_confirmation', 'other']) v
    where not exists (
      select 1 from pg_constraint
      where conrelid = 'public.document_filings'::regclass
        and conname = 'document_filings_category_check'
        and pg_get_constraintdef(oid) like '%''' || v || '''%')),
  'the category vocabulary must contain every document_type the interpretation contract defines');
rollback to savepoint p11_category_accepts_contract;

-- A reversal is a time AND a reason, or neither -- enforced at the table, not only in the
-- command. This is the fence that survives even a trusted-server writer with a bug: a
-- reverted_at with no reason beside it is the silent write the constitution forbids, and it
-- cannot be represented at all. Section 12's mutation proof leans on this being true.
create function pg_temp.p11_reasonless_reversal_rejected()
returns boolean
language plpgsql
as $$
begin
  begin
    update public.document_filings
    set reverted_at = now()
    where document_id = 'd1f00000-0000-4000-8000-0000000000c1';
    return false;
  exception when check_violation then
    return true;
  end;
end
$$;

savepoint p11_reasonless_reversal;
select pg_temp.p11_assert(
  pg_temp.p11_reasonless_reversal_rejected(),
  'setting reverted_at without a reason must be refused by the table itself');
rollback to savepoint p11_reasonless_reversal;

-- A filing decision is evidence, so it is neither deletable nor rewritable -- by ANY role,
-- including the trusted server that holds the CRUD grant. These run as the suite's superuser
-- precisely so no grant can be mistaken for the mechanism: only the trigger can refuse them.
create function pg_temp.p11_ledger_mutation(p_sql text)
returns text
language plpgsql
as $$
begin
  begin
    execute p_sql;
    return '(accepted)';
  exception when others then
    return sqlerrm;
  end;
end
$$;

savepoint p11_ledger_immutability;
select pg_temp.p11_assert(
  pg_temp.p11_ledger_mutation(
    $$delete from public.document_filings
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1'$$
  ) like '%document_filing_immutable%',
  'a filing row must never be deletable, by name');

select pg_temp.p11_assert(
  pg_temp.p11_ledger_mutation(
    $$update public.document_filings set category = 'invoice'
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1'$$
  ) like '%document_filing_immutable%',
  'a decided category must never be rewritten, by name');

select pg_temp.p11_assert(
  pg_temp.p11_ledger_mutation(
    $$update public.document_filings set confidence = 0.99
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1'$$
  ) like '%document_filing_immutable%',
  'a recorded confidence must never be rewritten, by name');

-- Reversal is a one-way door: neither un-revertible nor re-revertible under a new reason.
update public.document_filings
set reverted_at = now(), reverted_reason = 'ביטול ראשון'
where document_id = 'd1f00000-0000-4000-8000-0000000000c1';

select pg_temp.p11_assert(
  pg_temp.p11_ledger_mutation(
    $$update public.document_filings set reverted_at = null, reverted_reason = null
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1'$$
  ) like '%document_filing_immutable%',
  'a reverted filing must not be un-reverted');

select pg_temp.p11_assert(
  pg_temp.p11_ledger_mutation(
    $$update public.document_filings set reverted_reason = 'סיבה אחרת'
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1'$$
  ) like '%document_filing_immutable%',
  'a reversal reason must not be rewritten after the fact');
rollback to savepoint p11_ledger_immutability;

-- ===== 6. One ACTIVE filing per document -- the partial unique index =====

select pg_temp.p11_assert(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'document_filings_active_one'
      and indexdef like '%reverted_at IS NULL%'),
  'the active-filing index must be partial on reverted_at is null');

-- Runs as the suite's superuser on purpose: it is the INDEX under test, not the grants, and a
-- role switch here would test the wrong thing.
create function pg_temp.p11_second_active_filing_rejected()
returns boolean
language plpgsql
as $$
begin
  begin
    insert into public.document_filings (org_id, document_id, category, decided_by)
    values ('d1f00000-0000-4000-8000-000000000001',
            'd1f00000-0000-4000-8000-0000000000c1', 'invoice', 'user');
    return false;
  exception when unique_violation then
    return true;
  end;
end
$$;

savepoint p11_second_filing;
select pg_temp.p11_assert(
  pg_temp.p11_second_active_filing_rejected(),
  'a second ACTIVE filing for the same document must be rejected');
rollback to savepoint p11_second_filing;

-- ===== 7. Mutation proof: the partial unique index is load-bearing =====
--
-- Deliberately sited HERE, while the section-4 filing is still active. After the rescue in
-- section 9 that filing is reverted, and an insert would then be legitimate -- so a proof
-- placed later would pass for the wrong reason and prove nothing.

savepoint p11_index_mutation;
drop index public.document_filings_active_one;

select pg_temp.p11_assert(
  not pg_temp.p11_second_active_filing_rejected(),
  'P11 mutation proof: with the index dropped, a second active filing must be ACCEPTED -- one document carrying two live decisions');
rollback to savepoint p11_index_mutation;

savepoint p11_index_restored;
select pg_temp.p11_assert(
  pg_temp.p11_second_active_filing_rejected(),
  'P11 mutation proof: with the index restored, a second active filing must be rejected again');
rollback to savepoint p11_index_restored;

-- ===== 8. Rescue requires a reason, by name =====

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', '')$$
  ) like '%reason_required%',
  'rescue must refuse an empty reason, by name');

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', '   ')$$
  ) like '%reason_required%',
  'rescue must refuse a whitespace-only reason, by name');

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', null)$$
  ) like '%reason_required%',
  'rescue must refuse a null reason, by name');

-- Still in the archive after all three refusals, and the filing still active.
select pg_temp.p11_assert(
  (select entity_type = 'archive'
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1')
    and (select reverted_at is null from public.document_filings
         where document_id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'a refused rescue must move nothing and revert nothing');

-- ===== 9. Rescue is owner/office only, tenant-bound, and archive-only =====

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000c',
    $$select public.rescue_document_from_archive(
        'd1f00000-0000-4000-8000-0000000000c1', 'חשבונאי מנסה לחלץ')$$
  ) like '%not_authorized%',
  'accountant must not rescue: filing remains an owner/office clerical responsibility');

-- An in-tenant sibling id and a cross-tenant id must be indistinguishable to the caller.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000d',
    $$select public.rescue_document_from_archive(
        'd1f00000-0000-4000-8000-0000000000c1', 'דייר אחר מנסה לחלץ')$$
  ) like '%document_unknown%',
  'tenant B must not rescue tenant A''s document, and must not learn that it exists');

select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive(
        'd1f00000-0000-4000-8000-0000000000c2', 'מסמך שאינו בארכיון')$$
  ) like '%document_not_in_archive%',
  'rescuing a document that is not in the archive must be refused by name');

-- ===== 10. Rescue moves the document out, reverts the filing, and audits the reason =====

select pg_temp.p11_become('d1f00000-0000-4000-8000-00000000000b');
select public.rescue_document_from_archive(
  'd1f00000-0000-4000-8000-0000000000c1', 'זוהה כחשבונית של ספק א, מוחזר לטיפול');
select pg_temp.p11_unbecome();

-- Back to the inbox: the only coherent destination, because the two existing שיוך actions work
-- from there and isUnfiled() is then telling the truth about the row.
select pg_temp.p11_assert(
  (select entity_type = 'inbox' and entity_id is null
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'rescue must return the document to the inbox');

select pg_temp.p11_assert(
  (select reverted_at is not null
      and reverted_reason = 'זוהה כחשבונית של ספק א, מוחזר לטיפול'
   from public.document_filings
   where document_id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'rescue must revert the active filing and store the reason on it');

-- Reverted, not deleted: the decision that put the document in the archive is history now, and
-- history is not rewritten.
select pg_temp.p11_assert(
  (select count(*) = 1 from public.document_filings
   where document_id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'rescue must revert the filing row, never delete it');

select pg_temp.p11_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = 'd1f00000-0000-4000-8000-000000000001'
      and entity_type = 'documents'
      and entity_id = 'd1f00000-0000-4000-8000-0000000000c1'
      and action = 'document_rescued_from_archive'
      and user_id = 'd1f00000-0000-4000-8000-00000000000b'
      and reason = 'זוהה כחשבונית של ספק א, מוחזר לטיפול'
      and old_values ->> 'entity_type' = 'archive'
      and new_values ->> 'entity_type' = 'inbox'),
  'rescue must write an audit row naming the actor and carrying the reason');

-- The archiving audit row survives the rescue: two facts, both kept.
select pg_temp.p11_assert(
  (select count(*) = 2 from public.audit_logs
   where entity_id = 'd1f00000-0000-4000-8000-0000000000c1'
     and action in ('document_refiled', 'document_rescued_from_archive')),
  'archiving and rescuing are two audit facts and both must remain');

-- Once reverted, the document can be archived again. The partial index guards ONE ACTIVE
-- filing; a rescued document that turns out to be unplaceable after all is a real sequence.
select pg_temp.p11_become('d1f00000-0000-4000-8000-00000000000a');
select public.file_document(
  'd1f00000-0000-4000-8000-0000000000c1', 'archive', null, 'נבדק ידנית, אכן ללא קטגוריה');
select pg_temp.p11_unbecome();

select pg_temp.p11_assert(
  (select entity_type = 'archive'
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'a rescued document must be archivable again');

-- ===== 11. The archive is not a black hole: the file is still readable =====
--
-- docs_storage_read gates on entity_type ONLY inside its accountant arm. owner/office
-- -- the STAFF roles guarding /documents/archive (App.tsx:102,248) -- match an arm that never
-- looks at entity_type. If a future edit folds entity_type into that arm, the archive screen's
-- one remaining action (צפייה במקור) breaks silently. This is that tripwire.

select pg_temp.p11_assert(
  pg_temp.p11_visible_objects(
    'd1f00000-0000-4000-8000-00000000000a',
    'd1f00000-0000-4000-8000-000000000001/p11/1.pdf') = 1
  and pg_temp.p11_visible_objects(
    'd1f00000-0000-4000-8000-00000000000b',
    'd1f00000-0000-4000-8000-000000000001/p11/1.pdf') = 1
  and pg_temp.p11_visible_objects(
    'd1f00000-0000-4000-8000-00000000000c',
    'd1f00000-0000-4000-8000-000000000001/p11/1.pdf') = 0,
  'an archived document''s file must stay readable by owner/office and hidden from accountant');

-- ...and the archived row follows the same active route boundary as the file.
select pg_temp.p11_assert(
  pg_temp.p11_visible_documents(
    'd1f00000-0000-4000-8000-00000000000c', 'd1f00000-0000-4000-8000-0000000000c1') = 0,
  'an accountant must not gain the owner/office archive route through row visibility');

-- The other tenant gets neither.
select pg_temp.p11_assert(
  pg_temp.p11_visible_objects(
    'd1f00000-0000-4000-8000-00000000000d',
    'd1f00000-0000-4000-8000-000000000001/p11/1.pdf') = 0
  and pg_temp.p11_visible_documents(
    'd1f00000-0000-4000-8000-00000000000d', 'd1f00000-0000-4000-8000-0000000000c1') = 0,
  'archiving must not widen cross-tenant visibility of the row or the file');

-- ===== 12. Mutation proof: the reason guard on rescue is load-bearing =====
--
-- Strip ONLY the reason guard out of the LIVE definition and reinstall. Everything else about
-- the function -- security, volatility, grants, the rest of the body -- stays whatever 0075
-- actually shipped, so this proves that guard specifically and not a hand-written stand-in.

savepoint p11_reason_mutation;
do $$
declare
  v_def text := replace(
    pg_get_functiondef('public.rescue_document_from_archive(uuid,text)'::regprocedure),
    e'\r', '');
  v_guard text := replace($guard$  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;$guard$, e'\r', '');
begin
  if position(v_guard in v_def) = 0 then
    raise exception 'P11 mutation proof cannot run: the reason guard is not where it was expected in rescue_document_from_archive';
  end if;
  execute replace(v_def, v_guard, '');
end
$$;

-- A fresh ACTIVE filing, so the mutated call has something to revert. Without this the proof
-- would pass vacuously: section 10 already reverted the only other filing row.
set local role service_role;
insert into public.document_filings (org_id, document_id, category, decided_by)
values ('d1f00000-0000-4000-8000-000000000001',
        'd1f00000-0000-4000-8000-0000000000c1', 'other', 'system');
reset role;

select pg_temp.p11_assert(
  (select entity_type = 'archive'
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1'),
  'P11 mutation proof precondition: the document is in the archive');

-- The regression the guard prevents: section 8's assertion -- "rescue must refuse an empty
-- reason, BY NAME" -- no longer holds. reason_required is gone from the caller's world.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', '   ')$$
  ) not like '%reason_required%',
  'P11 mutation proof: with the guard removed, section 8''s named refusal must STOP holding');

-- And what stops the write instead is worth naming, because it is the honest finding here: the
-- reason requirement is fenced TWICE, in the command and in the schema. Removing the command
-- guard alone cannot produce a reasonless reversal -- document_filings_reversal_shape refuses
-- it at the table. The guard is still load-bearing: without it the caller gets a raw constraint
-- violation instead of a named, translatable error, and the command's contract is the thing
-- the UI and every other caller actually read.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', '   ')$$
  ) like '%document_filings_reversal_shape%',
  'P11 mutation proof: the schema fence must be what refuses once the command guard is gone');

-- Nothing half-done: the aborted call left the document in the archive and the filing active.
select pg_temp.p11_assert(
  (select entity_type = 'archive'
   from public.documents where id = 'd1f00000-0000-4000-8000-0000000000c1')
    and exists (
      select 1 from public.document_filings
      where document_id = 'd1f00000-0000-4000-8000-0000000000c1' and reverted_at is null),
  'P11 mutation proof: a refused rescue must not leave the document or its filing half-moved');

rollback to savepoint p11_reason_mutation;

-- Restored: the same call is refused by name again.
select pg_temp.p11_assert(
  pg_temp.p11_error(
    'd1f00000-0000-4000-8000-00000000000a',
    $$select public.rescue_document_from_archive('d1f00000-0000-4000-8000-0000000000c1', '   ')$$
  ) like '%reason_required%',
  'P11 mutation proof: with the guard restored, a whitespace reason is refused again');

rollback;
