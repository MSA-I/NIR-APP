-- 0288 -- HTML is not a document type. It stops being one at the database, not only at the screen.
--
-- WHY. Finding 7 of `docs/SECURITY-SCAN-20260902.md`: an uploaded `.html` file was accepted by
-- every layer -- the file picker, `public.smart_document_mime_allowed`, and the `documents`
-- bucket's `allowed_mime_types` -- and then served inline from the Supabase storage origin. A page
-- is a program. When a colleague opens the source of a document a supplier sent, the script in it
-- runs on the storage origin, with that origin's session, and nothing in the product asked for
-- consent. The severity was rated low because the attacker has to be a tenant member who can
-- upload; the mechanism is not low at all -- it is arbitrary script execution on our own origin.
--
-- WHAT PULL REQUEST 223 DID, AND WHY IT IS NOT THIS. `src/lib/documentSource.ts` makes every link
-- signed for an active type ask for `download`, so storage answers `Content-Disposition:
-- attachment` and the browser saves instead of renders. That is the right mitigation for bytes
-- ALREADY in the bucket, and it stays. It is not a reason to keep accepting new ones: it defends
-- by remembering, at four call sites, to ask for a header. This migration removes the type
-- instead, so a fifth call site that forgets has nothing to render.
--
-- THE RULING. `OPEN-DECISIONS #346`, owner, 02.09.2026: HTML is not a document type. A supplier
-- whose price list comes out of a mail client as an HTML table converts it to PDF or XLSX. This
-- SUPERSEDES the HTML sentence of DEBT `§98`, which recorded the opposite decision on 02.09.2026
-- ("HTML remains a supported document type -- 0045 permits it, the OCR worker parses it, and
-- suppliers have HTML price lists"). The worker keeps its HTML parser; from here it is unreachable
-- from any upload, and `worker/ocr/src/parsers.py` says so in a comment.
--
-- WHAT ALREADY SITS IN THE BUCKET. Nothing here deletes or rewrites a stored object, and no
-- `documents` row is touched: a removal would be a hard delete of a financial-adjacent record, and
-- a rewritten `mime_type` would be a lie about what the bytes are. Objects already stored stay
-- readable, and -- once that pull request lands -- only as downloads. But the row constraint
-- `p0_documents_mime_check` calls this function and PostgreSQL re-evaluates a CHECK on every
-- UPDATE, so a surviving `text/html` row could no longer be updated at all, soft delete included.
-- That is a silent trap, so this migration refuses to apply while one exists and names the number.
-- Measured on this branch: the only `text/html` document rows anywhere in the repository are the
-- fixtures in `supabase/tests/smart_document_processing.sql`, which this change flips to assert
-- refusal; a fresh reset applies this migration against an empty `documents` table.
--
-- NOT AN ANCHORED REPLACEMENT. The function is small and is restated whole rather than patched, so
-- nothing here reads `pg_get_functiondef` and no CRLF/LF hazard applies, which is what
-- `check:anchored-replacements` polices. It is SECURITY INVOKER, gains no exemption, and no index
-- depends on it -- the readers are two CHECK constraints, four storage policies and the intake
-- RPCs, all of which see the new answer on their next call.
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

-- ===== 2. No stored row may be left un-updatable =====
do $html_rows_0288$
declare
  v_rows bigint;
begin
  select count(*) into v_rows
  from public.documents
  where lower(coalesce(mime_type, '')) = 'text/html';

  if v_rows > 0 then
    raise exception '0288: % document row(s) still declare text/html; p0_documents_mime_check re-evaluates on every UPDATE, so applying this would leave them impossible to soft-delete or file. Decide what happens to them first (OPEN-DECISIONS #346) -- this migration does not choose for you.', v_rows;
  end if;

  raise notice '0288: no document row declares text/html; the type is removed cleanly.';
end
$html_rows_0288$;

-- ===== 3. The bucket stops accepting the bytes at all =====
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

-- ===== 4. Assert the removal, in the same transaction that made it =====
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
