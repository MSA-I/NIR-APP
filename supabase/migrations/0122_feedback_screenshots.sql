-- 0122 -- The picture that comes with the sentence.
--
-- A design partner writes "זה לא עובד" and the vendor's first three questions are which screen, in
-- what state, and what did it look like. 0091 answered the first by storing the route. This answers
-- the rest, and the owner chose the mechanism on 11.08.2026 after being shown both:
--
--   * `html2canvas` renders the DOM the person is looking at. It can capture ONLY this page.
--   * `getDisplayMedia` captures whatever the operating system's picker is pointed at -- which is
--     how a person accidentally shares their bank tab with a vendor's Discord channel.
--
-- The chosen one cannot reach outside the page, and that is the whole reason it was chosen. This
-- migration is the storage half of that decision.
--
-- WHAT MAKES THIS SAFE, given that the image DOES leave the building. Four things, and none of them
-- is a promise in a comment:
--   1. The bucket is PRIVATE and its path must start with the tenant's own org id, which the policy
--      reads rather than trusts. A browser cannot write into another tenant's folder.
--   2. Only PNG, and only up to 4 MB. A viewport screenshot is a few hundred KB; the cap is what
--      stops the field from becoming a file-transfer channel.
--   3. Nobody reads the image through the browser. Not the author, not the owner, not a platform
--      admin -- there is no SELECT policy at all, so the only reader is `send-feedback`, which
--      holds the service role and posts it once. An image with no reader is an image that cannot
--      leak through a screen someone left open.
--   4. The row records what was sent -- size, checksum, mime -- so "what did we send them" has an
--      answer that does not require opening the file.
--
-- WHAT IS NOT CAPTURED, enforced on the client (src/lib/screenshot.ts) rather than here: the
-- feedback dialog itself, anything marked `data-no-capture`, and any element the browser is not
-- painting. The server cannot check the contents of a PNG, so this migration does not pretend to.
--
-- The columns are all NULLABLE and the note is inserted before the upload is attempted. A capture
-- that fails must never cost somebody the sentence they took the trouble to write -- the guarantee
-- 0091's header states and `submitFeedbackNote` is built around.

-- ===== 1. What travelled with the note =====
alter table public.feedback_notes
  add column if not exists screenshot_path text,
  add column if not exists screenshot_bytes integer,
  add column if not exists screenshot_checksum text,
  add column if not exists screenshot_mime text,
  -- The exact page title, which `pageTitleFor` already computes for the tab. "תיקיית המסמכים —
  -- עסק לדוגמה" identifies a screen in words the vendor and the customer both use; `/documents`
  -- identifies it in words only the vendor uses.
  add column if not exists page_title text,
  -- Query and hash, separately from `route`. 0091 capped `route` at 200 characters and a filtered
  -- list can carry more than that in its query string alone -- and the filters ARE the state the
  -- bug report is about.
  add column if not exists route_query text,
  add column if not exists route_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feedback_notes_screenshot_coherent') then
    alter table public.feedback_notes add constraint feedback_notes_screenshot_coherent check (
      -- All four together or none of them. A path with no checksum is a file nobody can vouch for,
      -- and a checksum with no path is a claim about nothing.
      (screenshot_path is null and screenshot_bytes is null
        and screenshot_checksum is null and screenshot_mime is null)
      or (screenshot_path is not null and screenshot_bytes is not null
        and screenshot_checksum is not null and screenshot_mime is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'feedback_notes_screenshot_shape') then
    alter table public.feedback_notes add constraint feedback_notes_screenshot_shape check (
      (screenshot_path is null or char_length(screenshot_path) between 1 and 400)
      and (screenshot_bytes is null or screenshot_bytes between 1 and 4194304)
      -- sha-256, lower hex. Pinned by shape so a client cannot store "ok" and call it a checksum.
      and (screenshot_checksum is null or screenshot_checksum ~ '^[0-9a-f]{64}$')
      and (screenshot_mime is null or screenshot_mime = 'image/png')
      and (page_title is null or char_length(page_title) between 1 and 300)
      and (route_query is null or char_length(route_query) between 1 and 2000)
      and (route_hash is null or char_length(route_hash) between 1 and 200)
    );
  end if;
end
$$;

comment on column public.feedback_notes.screenshot_path is
  'Path in the private `feedback` bucket, always {org_id}/…, or null when the capture failed or the '
  'author declined it (0122). A note without a picture is still a note.';
comment on column public.feedback_notes.page_title is
  'The tab title at the moment of the note (0122). Names the screen in the words the customer uses, '
  'which `route` cannot.';

-- ===== 2. The grants =====
-- Column-level, matching 0091's shape: the browser may write what it observed and still cannot
-- touch `sent_at` or `send_error`, so "נשלח" still cannot originate in a tab.
grant insert (org_id, user_id, note, route, role, viewport_width, app_release,
              page_title, route_query, route_hash)
  on table public.feedback_notes to authenticated;

-- The one UPDATE the browser gets, and only on its own row (policy below). The note is inserted
-- first so that it survives a failed capture; the path can therefore only be attached afterwards.
grant update (screenshot_path, screenshot_bytes, screenshot_checksum, screenshot_mime)
  on table public.feedback_notes to authenticated;

drop policy if exists feedback_notes_attach_screenshot on public.feedback_notes;
create policy feedback_notes_attach_screenshot on public.feedback_notes
  for update to authenticated
  using (org_id = auth_org() and user_id = auth.uid() and sent_at is null)
  with check (org_id = auth_org() and user_id = auth.uid());

comment on policy feedback_notes_attach_screenshot on public.feedback_notes is
  'The author attaches their own screenshot to their own unsent note (0122). `sent_at is null` is '
  'what stops a path being swapped under a note that was already delivered -- the row is the '
  'record of what was sent, so it stops being editable the moment it has been.';

-- ===== 2b. A6: the export knows the note grew =====
-- 0103 pins each table's exact shape, so adding a column is drift until somebody decides whether it
-- leaves with the tenant. These do. `page_title`, `route_query` and `route_hash` are the tenant's own
-- words about their own screens, and the three screenshot columns describe a file THEY produced --
-- an export that returned the notes without them would hand back a bug report stripped of what it
-- was about. `screenshot_path` goes too: the export names the object, and a tenant taking their data
-- elsewhere is entitled to know a picture existed even if the bucket is not part of the dump.
update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name)
where registry.table_name = 'feedback_notes';

-- ===== 3. The private bucket =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback', 'feedback', false, 4194304, array['image/png']::text[])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists feedback_storage_insert on storage.objects;
create policy feedback_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'feedback'
  -- {org_id}/{note_id}.png, and nothing deeper. The tenant prefix is READ from the path and
  -- compared, which is the rule every bucket in this system follows.
  and array_length(storage.foldername(name), 1) = 1
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and lower(coalesce(metadata ->> 'mimetype', '')) = 'image/png'
);

-- No select, update or delete policy exists on purpose. See point 3 of the header: the only reader
-- is `send-feedback` through the service role, and an image nobody can open through a browser
-- cannot be leaked by a browser somebody left open.

-- (No `comment on policy` here: storage.objects is owned by the storage role and a migration
-- running as the project owner cannot comment on it. The paragraph above is the comment.)

-- ===== 4. A1/A3/A5 re-assertion =====
-- No SECURITY DEFINER code is added, so no exemption row and the p9 pin does not move. A feedback
-- note carries no unit meaning -- 0091 recorded that -- and a screenshot of one carries no more.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0122 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 5. Anchors =====
do $$
declare
  v_grants text[];
begin
  -- (a) The bucket is private. This is the assertion the whole feature rests on: a public bucket
  -- would put every screenshot behind a guessable URL with no authentication at all.
  if (select public from storage.buckets where id = 'feedback') is distinct from false then
    raise exception '0122: THE FEEDBACK BUCKET IS PUBLIC. Every screenshot would be world-readable.';
  end if;
  if (select file_size_limit from storage.buckets where id = 'feedback') is distinct from 4194304 then
    raise exception '0122: the feedback bucket lost its size cap.';
  end if;
  if (select allowed_mime_types from storage.buckets where id = 'feedback')
     is distinct from array['image/png']::text[] then
    raise exception '0122: the feedback bucket accepts something other than png.';
  end if;

  -- (b) Nobody can read one through the browser. A SELECT policy added later would silently turn
  -- the archive of everything customers have photographed into a browsable gallery.
  if exists (
    select 1 from pg_policy p
    where p.polrelid = 'storage.objects'::regclass
      and p.polname like 'feedback%'
      and p.polcmd in ('r', '*')
  ) then
    raise exception
      '0122: a read policy appeared on the feedback bucket. Only send-feedback, on the service '
      'role, is meant to open a screenshot.';
  end if;

  -- (c) The browser still cannot claim delivery. 0091's guarantee, restated because this migration
  -- is the first to give `authenticated` any UPDATE on the table at all.
  select array_agg(privilege_type || ':' || column_name) into v_grants
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'feedback_notes'
    and grantee = 'authenticated' and privilege_type = 'UPDATE';
  if v_grants is null then
    raise exception '0122: the author cannot attach a screenshot to their own note.';
  end if;
  if 'UPDATE:sent_at' = any (v_grants) or 'UPDATE:send_error' = any (v_grants) then
    raise exception
      '0122: THE BROWSER CAN NOW WRITE sent_at. "נשלח" would be able to originate in a tab, which '
      'is exactly what 0091 was built to prevent.';
  end if;
  if 'UPDATE:note' = any (v_grants) then
    raise exception '0122: the browser can rewrite the note text after the fact.';
  end if;
end
$$;
