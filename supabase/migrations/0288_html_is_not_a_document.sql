-- 0288 -- HTML is not a document type. It stops being one at the database, not only at the screen.
--
-- WHY, STATED IN FULL HERE. An uploaded `.html` file was accepted by every layer: the file picker,
-- `public.smart_document_mime_allowed`, and the `documents` bucket's `allowed_mime_types`. Storage
-- then served it inline. A page is a program, so the script inside a file a supplier "sent as a
-- price list" ran on the storage origin, with that origin's session, the moment a colleague opened
-- the source. (This is finding 7 of the 02.09.2026 security scan; the report and the debt section
-- that records it are on other branches, so nothing here points at a path this tree does not have.)
--
-- WHY NOT THE DOWNLOAD-ONLY FIX. The parallel security branch (PR 223) makes every signed link for
-- an active type ask for `download`, so storage answers `Content-Disposition: attachment` and the
-- browser saves instead of renders. That is the right mitigation for bytes ALREADY stored and it
-- stays. It is not a reason to keep accepting new ones: it defends only as long as every caller
-- remembers to ask for the header, and the next call site that forgets restores the hole. Removing
-- the type leaves that call site nothing to render.
--
-- THE RULING. `OPEN-DECISIONS #346`, owner, 02.09.2026: HTML is not a document type. A supplier
-- whose price list comes out of a mail client as an HTML table converts it to PDF or XLSX. It
-- SUPERSEDES the HTML sentence of the debt section PR 223 adds, which recorded the opposite
-- decision on the same day. The OCR worker keeps its HTML parser; from here it is unreachable from
-- any upload, and `worker/ocr/src/parsers.py` says so in a comment.
--
-- WHO READS THE PREDICATE. Measured, because an earlier draft of this header got it wrong:
-- THREE check constraints call it -- `p0_documents_mime_check` (0045:39), and on two intake tables
-- `supplier_price_submission_intakes_mime_check` (0048:77-90, its source_document_id branch) and
-- `supplier_price_document_upload_reservations_mime_check` (0048:239-241). TWO storage policies
-- call it (0092:293 and 0092:333) and one table policy does (`documents_insert`, 0133:227), plus
-- the intake RPCs. No index depends on it, so replacing the body reaches all of them at once.
--
-- WHY SECTION 2 COUNTS `documents` ALONE. A CHECK is re-evaluated on UPDATE, so narrowing the
-- predicate can strand a stored row. That can only bite a table whose rows are UPDATEd. The two
-- intake tables are not: they carry a 15-minute expiry and are cleared by DELETE, which does not
-- evaluate a CHECK (0048:352, 0048:1255, 0065:216, 0078:61, 0078:137). Their one UPDATE path,
-- reserved -> registered, lives inside that same 15 minutes, and a row that misses it is swept
-- rather than written. `public.documents` is the only table that keeps its rows.
--
-- WHAT ALREADY SITS IN THE BUCKET. Nothing here deletes or rewrites a stored object. No `documents`
-- row is rewritten either: `documents_guard_columns` (0045:88-97, still live per 0090:860-866)
-- raises on any change to `mime_type`, and a rewritten type would be a lie about the bytes anyway.
-- Objects already stored stay readable, and -- once PR 223 lands -- only as downloads.
--
-- SO THE REFUSAL IS MADE SATISFIABLE, NOT JUST LOUD. Section 2 refuses to apply while a LIVE
-- `text/html` document row exists, and section 3 re-scopes `p0_documents_mime_check` so a RETIRED
-- one stays updatable. That combination leaves the operator a path that exists today:
-- `public.remove_document(id, reason)` (0119:90) soft-deletes the row -- it writes `deleted_at`,
-- which the guard trigger explicitly permits, and the re-scoped constraint then accepts the
-- retired row forever after. Without the re-scope there would be NO permitted route: a soft delete
-- would trip the constraint, a hard delete is barred for financial records, and the mime column
-- cannot be edited. The refusal names that path in its message.
--
-- A RETIRED ROW CANNOT SMUGGLE THE TYPE BACK IN. The escape is scoped to `deleted_at is not null`,
-- and every writer evaluates the predicate before the row is inserted -- `documents_insert`
-- (0133:227), `register_uploaded_document` (0131:104) and the machine intake path (0279:605) all
-- refuse `text/html` at insert time, when `deleted_at` is still null.
--
-- NOT AN ANCHORED REPLACEMENT. The function is small and is restated whole rather than patched, so
-- nothing here reads `pg_get_functiondef` and no CRLF/LF hazard applies, which is what
-- `check:anchored-replacements` polices. It is SECURITY INVOKER and gains no exemption.
--
-- NUMBERING. 0286 and 0287 are claimed by two branches open in parallel, so this file leaves a
-- gap and `check:migration-numbers` reports `0285 -> 0288` until both land. Measured: with those
-- two present the same guard passes (279 migrations, 0001-0288, no duplicate, no new gap).

-- ===== 1. The one predicate every intake path asks =====
-- Restated in full from 0045:7-25 with `text/html` removed and nothing else changed.
create or replace function public.smart_document_mime_allowed(p_mime text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(coalesce(p_mime, '')) in (
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf', 'text/rtf',
    'text/plain',
    'application/vnd.oasis.opendocument.text'
  )
$$;

-- `create or replace` keeps the existing privileges; these are restated so the grant surface is
-- readable in one place instead of only in 0045.
revoke all on function public.smart_document_mime_allowed(text) from public, anon;
grant execute on function public.smart_document_mime_allowed(text) to authenticated, service_role;

-- ===== 2. No LIVE row may be left un-updatable =====
-- Live only. A retired row is covered by the constraint scope in section 3 and needs no work; a
-- live one has to be retired FIRST, because after this migration the predicate that would let it
-- be retired is gone. `db-query.ps1` sends each migration as one implicit transaction and
-- `rollout-apply.ps1` stops on a failing step, so this halts the package instead of half-applying.
-- The same count is a read-only probe the rollout runs BEFORE the package, so this is the second
-- line of defence rather than the first time anyone finds out.
do $html_rows_0288$
declare
  v_rows bigint;
begin
  select count(*) into v_rows
  from public.documents
  where deleted_at is null
    and lower(coalesce(mime_type, '')) = 'text/html';

  if v_rows > 0 then
    raise exception '0288: % live document row(s) still declare text/html. Retire each one FIRST with public.remove_document(id, reason) -- that is the only permitted route, and this migration closes it. Then re-run. See OPEN-DECISIONS #346.', v_rows;
  end if;

  raise notice '0288: no live document row declares text/html; the type is removed cleanly.';
end
$html_rows_0288$;

-- ===== 3. The constraint keeps retired rows updatable =====
-- Without this, a `text/html` row retired in the past becomes frozen: every UPDATE re-evaluates
-- the CHECK, so it could never be re-filed, re-audited or touched by any later migration. The
-- escape is scoped to rows that are already gone from the product, and section 2 has just proved
-- no live row needs it. `not valid` then `validate` so the scan is its own named step.
alter table public.documents drop constraint p0_documents_mime_check;
alter table public.documents add constraint p0_documents_mime_check check (
  mime_type is null
  or deleted_at is not null
  or public.smart_document_mime_allowed(mime_type)
) not valid;
alter table public.documents validate constraint p0_documents_mime_check;

-- ===== 4. The bucket stops accepting the bytes at all =====
-- Last set at 0047:1117-1133 (which added `application/json` on top of 0045:171-184). Restated in
-- full with `text/html` removed; the storage service enforces this list against the upload's
-- declared type before any policy runs.
update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/json',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf', 'text/rtf',
      'text/plain',
      'application/vnd.oasis.opendocument.text'
    ]::text[]
where id = 'documents';

-- ===== 5. Assert the removal, in the same transaction that made it =====
do $verify_0288$
declare
  v_bucket text;
  v_violations text;
begin
  if public.smart_document_mime_allowed('text/html') then
    raise exception '0288: smart_document_mime_allowed still accepts text/html';
  end if;
  if public.smart_document_mime_allowed('TEXT/HTML') then
    raise exception '0288: smart_document_mime_allowed still accepts text/html case-insensitively';
  end if;
  if public.smart_document_mime_allowed('application/xhtml+xml') then
    raise exception '0288: smart_document_mime_allowed accepts application/xhtml+xml, which a browser renders the same way';
  end if;

  -- The removal must be exactly one type wide. A predicate that started refusing PDFs would also
  -- pass a "text/html is refused" assertion, and would take document intake down with it.
  if not public.smart_document_mime_allowed('application/pdf')
     or not public.smart_document_mime_allowed('image/jpeg')
     or not public.smart_document_mime_allowed('text/csv')
     or not public.smart_document_mime_allowed('text/plain')
     or not public.smart_document_mime_allowed('application/vnd.oasis.opendocument.text') then
    raise exception '0288: the predicate lost a type other than text/html';
  end if;

  -- The retired-row escape is what makes section 2 satisfiable. A later migration that restates
  -- this constraint without it re-freezes every retired HTML row, silently.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.documents'::regclass
      and conname = 'p0_documents_mime_check'
      and convalidated
      and pg_get_constraintdef(oid) like '%deleted_at IS NOT NULL%'
  ) then
    raise exception '0288: p0_documents_mime_check is missing, unvalidated, or lost the retired-row escape';
  end if;

  -- Every bucket, not only `documents`: `price-submissions` (0032:107-122) never carried the type
  -- and must not have gained it, and a future bucket seeded with the old list fails here.
  select string_agg(id, ', ' order by id) into v_bucket
  from storage.buckets
  where 'text/html' = any(allowed_mime_types);
  if v_bucket is not null then
    raise exception '0288: bucket(s) still permit text/html: %', v_bucket;
  end if;

  if not (array['application/pdf', 'text/csv', 'application/json']::text[]
          <@ (select allowed_mime_types from storage.buckets where id = 'documents')) then
    raise exception '0288: the documents bucket lost a type it must still accept';
  end if;

  raise notice '0288: text/html refused by the predicate and absent from every bucket allowlist.';

  -- The standing A1/A3/A5 re-assertion every migration after 0057 owes. Nothing here creates a
  -- table, a policy or a definer function, so it is expected to be silent -- which is the point:
  -- the one migration that skips it is the one that was sure it did not need it.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0288 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0288$;
