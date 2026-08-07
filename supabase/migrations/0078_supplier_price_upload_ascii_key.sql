-- A Hebrew file name cannot reach the supplier price-list path, and the fix is the storage KEY,
-- not the name the person sees.
--
-- WHAT WAS OBSERVED, in production, before anything here was written:
--   * `reserve_supplier_price_document_upload` succeeded -- the reservation row exists
--     (document_id 527f7e3c…, created 2026-08-07 11:43:48Z, status 'reserved').
--   * No storage object was ever created for it: object_id null, registered_at null.
--   * The reserved key was `{org}/supplier/{supplier}/{document}/אחים כהן מחירון.pdf`.
--   * Every object that HAS landed in the bucket carries an ASCII-only key. The one supplier-path
--     upload that succeeded was `IMG_4078.jpeg`.
--   * The inbox flow has never hit this, because FileUpload.tsx:220 already sanitizes:
--     `file.name.replace(/[^\w.\-]+/g, '_')`. In JavaScript `\w` is ASCII-only, so Hebrew becomes
--     `_` there and the stored path is `{ts}_ADTV_Ltd_receipt_7352_he_original_.pdf`. The price
--     path is built HERE, in SQL, from the raw name -- 0048:370-372 -- and never sanitized.
--
-- WHAT WAS NOT ESTABLISHED, and is stated rather than glossed: the exact rejection was not
-- recovered from the logs (the gateway log showed no request at all for the upload endpoint in
-- that window). Several mechanisms are consistent with the evidence -- Supabase Storage's own key
-- validation, the tus Upload-Metadata round-trip, or `supplier_price_upload_reservation_active`
-- failing to match because the stored object name is not byte-identical to the reserved path.
-- They differ in where the refusal happens and agree on the cause and on the remedy: the key must
-- be ASCII. This migration therefore fixes the key and does NOT claim which layer refused it.
--
-- WHAT DOES NOT CHANGE: `file_name` still holds the original, in Hebrew, and that is the string
-- every screen shows. Only the storage key -- an internal address the user never reads -- is
-- transliterated. document_id already makes the key unique, so two files that sanitize to the
-- same segment cannot collide.

-- ===== 1. The sanitizer =====
-- ASCII CLASS SPELLED OUT, NOT `\w`. This is the one place where copying the JavaScript regex
-- verbatim would silently do nothing: PostgreSQL's `\w` is `[[:alnum:]_]` under a UTF-8 collation
-- and MATCHES Hebrew, so `regexp_replace(name, '[^\w.\-]+', '_', 'g')` would return the Hebrew
-- unchanged and this migration would be a no-op that looks correct. Measured on this database
-- before the class was written out: `select 'א' ~ '\w'` returns true.
create or replace function private.storage_key_segment(p_file_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select left(
    coalesce(
      nullif(regexp_replace(btrim(coalesce(p_file_name, '')), '[^a-zA-Z0-9._-]+', '_', 'g'), ''),
      '_'
    ),
    255
  );
$$;

comment on function private.storage_key_segment(text) is
  'The ASCII storage-key form of a display file name. Runs of anything outside [A-Za-z0-9._-] '
  'collapse to a single underscore, so a Hebrew name keeps its extension and loses nothing that '
  'a key needs. The display name is stored separately and is never rewritten. Mirrors '
  'FileUpload.tsx:220 in intent; the class is spelled out because Postgres''s \w is unicode-aware '
  'and would match Hebrew.';

-- ===== 2. Retire the reservations that the old path shape produced =====
-- `reserved` rows are disposable by the flow's own rule (0048:351-353 sweeps expired ones on every
-- call: "Registered rows are the durable retry receipt. Only unused, expired claims are
-- disposable."). A `registered` row is never touched here -- it is a real document.
delete from public.supplier_price_document_upload_reservations
where status = 'reserved'
  and storage_path <> concat_ws('/', org_id::text, 'supplier', supplier_id::text,
                                document_id::text, private.storage_key_segment(file_name));

-- ===== 3. The path constraint now compares against the sanitized segment =====
alter table public.supplier_price_document_upload_reservations
  drop constraint if exists supplier_price_document_upload_reservations_path_check;

alter table public.supplier_price_document_upload_reservations
  add constraint supplier_price_document_upload_reservations_path_check check (
    array_length(string_to_array(storage_path, '/'), 1) = 5
    and split_part(storage_path, '/', 1) = org_id::text
    and split_part(storage_path, '/', 2) = 'supplier'
    and split_part(storage_path, '/', 3) = supplier_id::text
    and split_part(storage_path, '/', 4) = document_id::text
    -- The only line that moved. It used to read `= file_name`, which made an ASCII key
    -- UNREPRESENTABLE: the schema itself required the raw name in the key.
    and split_part(storage_path, '/', 5) = private.storage_key_segment(file_name)
    and split_part(storage_path, '/', 6) = ''
  );

-- ===== 4. The reserve command mints the sanitized key =====
-- THE BASE IS 0065, NOT 0048 -- and the first draft of this migration got that wrong.
--
-- The draft re-declared 0048's body and justified it with a pg_proc check whose predicate was
-- `prosrc like '%concat_ws(%' and prosrc like '%v_profile_supplier%'`. Both are true of 0065's
-- rewrite as well, so the check passed while the claim above it ("0048's body is the ONLY
-- definition") was false. That is the exact defect this repository has now recorded three times:
-- a predicate narrower than the sentence it is asked to support. It would have silently reverted
-- 0065's sweep grace -- physical deletion moving back from `now() - interval '1 hour'` to `now()`,
-- reopening the race a renewal in flight can lose.
--
-- `supabase/tests/p6b_upload_reservations.sql` caught it locally, by name: "reserve must sweep
-- only claims a full hour past expiry". That is why the suite ran before production did.
--
-- The body below is 0065:177-251 -- the live definition -- with ONE line changed, marked inline.
create or replace function public.reserve_supplier_price_document_upload(
  p_supplier_id uuid,
  p_file_name text,
  p_mime_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role;
  v_profile_supplier uuid;
  v_document_id uuid := gen_random_uuid();
  v_file_name text := nullif(btrim(p_file_name), '');
  v_mime_type text := lower(split_part(trim(coalesce(p_mime_type, '')), ';', 1));
  v_storage_path text;
  v_expires_at timestamptz;
begin
  if v_org is null or v_actor is null or p_supplier_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.role, p.supplier_id into v_role, v_profile_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = v_actor and p.org_id = v_org and p.active
    and o.status in ('trial', 'active');
  if v_role is null or v_role not in ('owner', 'office', 'supplier')
     or (v_role = 'supplier' and v_profile_supplier is distinct from p_supplier_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Registered rows are the durable retry receipt. Only unused claims a full grace hour
  -- past expiry are disposable: expiry alone already closed the storage and register
  -- gates, and the grace keeps a just-expired claim renewable so an in-flight renewal
  -- cannot lose the race to another tenant's sweep (0065).
  delete from public.supplier_price_document_upload_reservations
  where status = 'reserved' and expires_at <= now() - interval '1 hour';

  perform 1
  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  -- UNCHANGED, and deliberately so: these rules police the NAME, which is still stored raw and
  -- still shown to the person. A name may be Hebrew; it may not be a path traversal.
  if v_file_name is null or length(v_file_name) > 255
     or v_file_name in ('.', '..')
     or v_file_name ~ '[\\/]'
     or v_file_name ~ '[[:cntrl:]]'
     or not public.smart_document_mime_allowed(v_mime_type) then
    raise exception 'document_upload_invalid' using errcode = '22023';
  end if;

  -- CHANGED: the key segment is the sanitized form, not the raw name.
  v_storage_path := concat_ws(
    '/', v_org::text, 'supplier', p_supplier_id::text, v_document_id::text,
    private.storage_key_segment(v_file_name)
  );
  insert into public.supplier_price_document_upload_reservations (
    document_id, org_id, actor_id, supplier_id,
    file_name, mime_type, storage_path
  ) values (
    v_document_id, v_org, v_actor, p_supplier_id,
    v_file_name, v_mime_type, v_storage_path
  ) returning expires_at into v_expires_at;

  return jsonb_build_object(
    'document_id', v_document_id,
    'storage_path', v_storage_path,
    'expires_at', v_expires_at
  );
end
$$;

revoke all on function public.reserve_supplier_price_document_upload(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.reserve_supplier_price_document_upload(uuid, text, text)
  to authenticated;

-- ===== 5. Proof, in the migration, that the class is the ASCII one =====
do $$
begin
  -- The trap this migration exists to avoid, asserted rather than described.
  if not ('א' ~ '\w') then
    raise exception '0078: assumption wrong -- Postgres \w no longer matches Hebrew; revisit the note above';
  end if;
  if private.storage_key_segment('אחים כהן מחירון.pdf') !~ '^[a-zA-Z0-9._-]+$' then
    raise exception '0078: sanitizer let a non-ASCII character through';
  end if;
  if private.storage_key_segment('אחים כהן מחירון.pdf') not like '%.pdf' then
    raise exception '0078: sanitizer dropped the extension';
  end if;
  if private.storage_key_segment('IMG_4078.jpeg') <> 'IMG_4078.jpeg' then
    raise exception '0078: sanitizer rewrote a name that was already a valid key';
  end if;
  if private.storage_key_segment('') <> '_' or private.storage_key_segment(null) <> '_' then
    raise exception '0078: sanitizer produced an empty key segment';
  end if;
end
$$;

-- ===== 6. Re-assert (the 0058:207-218 idiom, literal 0078) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0078 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
