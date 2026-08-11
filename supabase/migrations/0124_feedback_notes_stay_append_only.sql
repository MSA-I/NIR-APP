-- 0124 -- Putting back the invariant 0122 traded away without noticing.
--
-- `p0_client_dml_acl.sql:175-188` asserts, by name, that the browser's access to `feedback_notes`
-- is APPEND-ONLY: insert the columns you observed, never update anything, never delete. 0122 needed
-- to attach a screenshot path to a note and reached for the obvious tool — a column-scoped UPDATE
-- grant plus a policy narrowed to the author's own unsent row. Careful, narrow, and still a hole in
-- a wall somebody built on purpose: the P0 suite is the only reason it was caught, and it caught it
-- in CI rather than in any local check.
--
-- The invariant is worth more than the convenience, because "the browser can update a row in this
-- table" is a sentence that gets extended by the next person who needs one more column, and the
-- table's whole design rests on the row being a record rather than a draft.
--
-- THE FIX IS AN ORDERING, NOT A PRIVILEGE. The note id is generated in the browser, the screenshot
-- is uploaded to `{org_id}/{note_id}.png` first, and THEN the row is inserted once, already
-- carrying its path. Nothing needs to be updated because nothing was written early.
--
-- The guarantee 0122 was protecting survives intact: a capture or an upload that fails simply means
-- the insert carries nulls, and the note is stored exactly as it always was. The only new cost is
-- an orphaned object if the insert itself fails after a successful upload — a PNG under 4 MB, in
-- the tenant's own folder, in a bucket with no read policy at all. That is a cheaper thing to own
-- than a standing UPDATE grant.

-- ===== 1. Take the grant back =====
revoke update (screenshot_path, screenshot_bytes, screenshot_checksum, screenshot_mime)
  on table public.feedback_notes from authenticated;

drop policy if exists feedback_notes_attach_screenshot on public.feedback_notes;

-- ===== 2. Let the insert carry it instead =====
-- `id` joins the list because the path must be known before the row exists, and a path is only
-- addressable if the id is. The columns the browser must never write -- sent_at, send_error,
-- created_at -- are absent here exactly as they were absent from 0091.
grant insert (id, org_id, user_id, note, route, role, viewport_width, app_release,
              page_title, route_query, route_hash,
              screenshot_path, screenshot_bytes, screenshot_checksum, screenshot_mime)
  on table public.feedback_notes to authenticated;

-- ===== 3. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0124 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 4. Anchors -- the same three the P0 suite makes, here, in milliseconds =====
-- P0 runs in the nineteenth minute of a twenty-minute gate. This migration is the one that broke
-- the assertion, so it is the one that should fail fast if it ever breaks it again.
do $$
begin
  if has_any_column_privilege('authenticated', 'public.feedback_notes', 'UPDATE') then
    raise exception
      '0124: THE BROWSER CAN UPDATE feedback_notes AGAIN. The table is append-only by design and '
      'p0_client_dml_acl.sql:188 asserts it by name.';
  end if;
  if has_table_privilege('authenticated', 'public.feedback_notes', 'DELETE') then
    raise exception '0124: the browser can delete a feedback note.';
  end if;
  if has_column_privilege('authenticated', 'public.feedback_notes', 'sent_at', 'INSERT')
     or has_column_privilege('authenticated', 'public.feedback_notes', 'send_error', 'INSERT') then
    raise exception
      '0124: "נשלח" can originate in a tab again, which is what 0091 was built to prevent.';
  end if;
  -- And the thing this migration exists to make possible.
  if not has_column_privilege('authenticated', 'public.feedback_notes', 'id', 'INSERT')
     or not has_column_privilege(
          'authenticated', 'public.feedback_notes', 'screenshot_path', 'INSERT') then
    raise exception
      '0124: the browser cannot insert a note with its own id and screenshot path, so there is no '
      'way to attach one without an UPDATE grant.';
  end if;
end
$$;
