-- 0125 -- The feedback screenshot upload was refused by its own policy, always. Three times over.
--
-- Measured, not guessed. The storage service log for the failing request:
--
--   "message": "new row violates row-level security policy", "code": "42501",
--   "operation": "storage.object.upload",
--   "/object/feedback/{org}/{note}.png"
--
-- 0122's INSERT policy ends with `lower(coalesce(metadata ->> 'mimetype', '')) = 'image/png'`, a
-- line copied from the price-submissions bucket where it works. It does not work here, and the
-- reason is the order of operations inside the storage service: for a direct upload the object ROW
-- is inserted first and its `metadata` is filled in afterwards, so at the moment the policy runs
-- `metadata` is null. `coalesce(null, '')` is `''`, `'' = 'image/png'` is false, and every upload
-- this feature has ever attempted was denied.
--
-- It failed silently by design, which is why it took the heavy gate to find it: `uploadScreenshot`
-- swallows storage errors on purpose so that a picture never costs somebody their note. The note
-- always arrived. It simply never had a screenshot, and nothing on screen said otherwise. The
-- browser scenario caught it as an unexpected console error -- an HTTP 400 nobody had asked about.
--
-- THE MIME CHECK IS NOT LOST, it moves to the layer that can actually make it. The bucket's own
-- `allowed_mime_types` is `{image/png}` and the storage service enforces it against the request's
-- Content-Type before it writes anything -- earlier than RLS, and against a value that exists at
-- the time it is read. 0122's anchor already asserts that bucket setting, so the guarantee has a
-- test either way.
--
-- THE OWNERSHIP CHECK GOES TOO, for the same reason and it was the same bug twice. Removing the
-- mimetype clause was not enough -- the upload was still denied, and simulating the insert directly
-- showed why:
--
--   insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
--   values ('feedback', '{org}/no-owner.png', null, null, null);
--   ERROR:  new row violates row-level security policy for table "objects"
--
-- `owner` and `owner_id` are written by the storage service after the row exists, exactly like
-- `metadata`, so `(owner = auth.uid() or owner_id = auth.uid()::text)` is `(null or null)` at the
-- moment it is evaluated. The clause is inherited from the other buckets in this system, where it
-- has plausibly never been exercised by a real browser upload -- the demo fixtures write objects as
-- service_role, which bypasses RLS entirely. Recorded in DEBT-REGISTER §38 rather than fixed here,
-- because changing the buckets this feature does not touch is a separate, testable change.
--
-- WHAT STILL GUARDS THIS BUCKET, and it is the part that matters: the path must begin with the
-- caller's own `auth_org()`, read out of the name rather than trusted, and it must be exactly one
-- segment deep. Object ownership was never the tenancy control here -- and the bucket has no read
-- policy at all, so there is nothing an object's owner could be given access to anyway.
--
-- AND THE THIRD, which is the one that actually mattered and which corrects a claim 0122 makes in
-- its own header. Neither of the two removals above was enough. The storage service's log gives the
-- statement verbatim:
--
--   insert into "objects" ("bucket_id","metadata","name","owner","owner_id","user_metadata",
--   "version") values (...) on conflict ("name","bucket_id") do update set ... RETURNING *
--
-- `returning *` needs a SELECT policy on the row it returns. 0122 gave this bucket NO read policy at
-- all -- deliberately, and the header argues at length that an image with exactly one reader cannot
-- leak through a screen somebody left open. It is a good argument and it describes a bucket into
-- which nothing can ever be written, because the only supported upload path ends in `returning *`.
--
-- So the bucket gets a read policy, scoped to the tenant, and 0122's claim is corrected here rather
-- than left standing: an authenticated member of an organisation can read a feedback screenshot
-- belonging to that same organisation. Not another tenant's -- the prefix is still read out of the
-- name and compared to `auth_org()`. The exposure this adds is one colleague seeing another
-- colleague's screenshot of a screen they both have access to anyway, and it is the price of the
-- feature existing at all.
--
-- The tenant prefix and the single path segment stay exactly as they were. Those read the `name`
-- column, which is populated when the policy runs.

drop policy if exists feedback_storage_insert on storage.objects;
create policy feedback_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'feedback'
  -- {org_id}/{note_id}.png, and nothing deeper. The tenant prefix is READ from the path and
  -- compared, which is the rule every bucket in this system follows.
  and array_length(storage.foldername(name), 1) = 1
  and (storage.foldername(name))[1] = auth_org()::text
);

drop policy if exists feedback_storage_select on storage.objects;
create policy feedback_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'feedback'
  and (storage.foldername(name))[1] = auth_org()::text
);

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0125 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_check text;
begin
  select pg_get_expr(polwithcheck, polrelid) into v_check
  from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'feedback_storage_insert';
  if v_check is null then
    raise exception '0125: the feedback upload policy is gone.';
  end if;

  -- (a) The thing this migration removed stays removed. A well-meaning re-add would silently
  -- disable the whole feature again, and silently is the operative word: the client swallows
  -- storage errors so that a picture never costs a note.
  if position('mimetype' in v_check) > 0 then
    raise exception
      '0125: the metadata mimetype check is back in the feedback upload policy. It is null at the '
      'moment the policy runs, so every upload is denied and nothing on screen says so.';
  end if;

  -- (b) What must NOT have been loosened along with it.
  if position('auth_org()' in v_check) = 0 then
    raise exception '0125: the feedback upload policy no longer pins the tenant prefix.';
  end if;
  -- (b2) And the OTHER column that is null at policy time. Re-adding it looks like tightening
  -- security and is in fact a total outage of the feature, silently.
  if position('owner' in v_check) > 0 then
    raise exception
      '0125: the ownership check is back in the feedback upload policy. owner and owner_id are '
      'written by the storage service AFTER the row exists, so the clause is (null or null) when '
      'it runs and every upload is denied.';
  end if;

  -- (c) The read policy exists AND is still tenant-scoped. Both halves: without it no upload can
  -- complete, and without the prefix comparison it would be every tenant's screenshots.
  select pg_get_expr(polqual, polrelid) into v_check
  from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'feedback_storage_select';
  if v_check is null then
    raise exception
      '0125: the feedback bucket has no read policy, so the storage API''s `insert ... returning *` '
      'cannot complete and every upload fails with HTTP 400.';
  end if;
  if position('auth_org()' in v_check) = 0 then
    raise exception '0125: the feedback read policy is not scoped to the tenant.';
  end if;

  -- (d) The mime guarantee, at the layer that can keep it.
  if (select allowed_mime_types from storage.buckets where id = 'feedback')
     is distinct from array['image/png']::text[] then
    raise exception
      '0125: the feedback bucket no longer restricts to png, and the policy no longer does either.';
  end if;
end
$$;
