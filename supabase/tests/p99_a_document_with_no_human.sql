-- P99 — a document nobody uploaded, and every way it must not be allowed to become one.
--
-- Two inbound channels are about to put documents into this product with no person behind them.
-- The pipeline was built on the opposite assumption in four separate places, and relaxing those
-- places is the easy half. The hard half is that a relaxation big enough to let a machine in is
-- also big enough to let several other things in, and this suite is the list of those things.
--
-- WHAT IT PINS, and why each one is here rather than assumed:
--
--   1. THE ACTOR RULE IS BIDIRECTIONAL. A one-way rule ("a channel document may have no actor")
--      would also permit a BROWSER document with no actor -- an upload nobody made. Both
--      directions are asserted on all three tables, because a rule tested in one direction is a
--      rule half written.
--
--   2. A JOB CANNOT LIE ABOUT WHERE ITS DOCUMENT CAME FROM. Three tables each carry `source`,
--      which is three chances to disagree, and a job claiming 'email' over a browser document
--      would use that claim to shed the actor requirement. The tie is a composite foreign key,
--      so the mismatch is unstorable rather than merely unusual.
--
--   3. THE INGEST RPC DOES NOT BELIEVE ITS CALLER. It is called by `service_role`, which reads
--      every tenant. So the suite hands it another tenant's object, an object whose version
--      moved under it, a stale lease token and a replay -- the four ways a globally privileged
--      caller turns into a cross-tenant write -- and requires a named refusal for each.
--
--   4. A SIBLING LEGAL ENTITY CANNOT SEE THE OTHER'S POST. An inbound document has no uploader
--      and therefore no scope of its own; if `unit_id` were left null it would be organisation-
--      wide, which means visible across sibling entities. The route decides the unit, and the
--      tenant readers filter on it.
--
--   5. THE PLATFORM CAN STOP THIS AND THE TENANT CANNOT START IT. A tenant-owned flag is not a
--      kill switch. The boundary table is asserted unwritable by every product role INCLUDING
--      service_role, and ingest is asserted to refuse while a channel is closed.
--
-- Fixture shape: one organisation with TWO sibling legal entities under a root, plus a second
-- organisation that exists only to be stolen from.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p99_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P99 machine-actor assertion failed: %', p_message;
  end if;
end
$$;

-- Runs a statement and returns the SQLSTATE+message it refused with, or 'ACCEPTED' if it did
-- not refuse at all. A test that only asserts "it raised" passes when the wrong thing raises.
create function pg_temp.p99_refusal(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACCEPTED';
exception when others then
  return sqlstate || ':' || sqlerrm;
end
$$;

-- ---- fixture -----------------------------------------------------------------------------
insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0980000-0000-4000-8000-000000000001', 'P99 org',        'active', 18, 'ILS', 'IL'),
  ('a0980000-0000-4000-8000-000000000002', 'P99 other org',  'active', 18, 'ILS', 'IL');

-- Creating an organisation already creates its root unit, so the root is READ rather than
-- written -- inserting one raises org_units_one_root_per_org, which is the schema saying the
-- fixture was about to describe a shape the product cannot have.
create temporary table p99_roots as
  select org_id, id as root_id from public.org_units
   where unit_type = 'root'
     and org_id in ('a0980000-0000-4000-8000-000000000001',
                    'a0980000-0000-4000-8000-000000000002');

-- Two siblings under that root. Everything about cross-entity leakage is measured between them.
insert into public.org_units(id, org_id, parent_id, unit_type, name)
select 'e0980000-0000-4000-8000-000000000001'::uuid, org_id, root_id, 'legal_entity'::org_unit_type, 'P99 entity A'
  from p99_roots where org_id = 'a0980000-0000-4000-8000-000000000001'
union all
select 'e0980000-0000-4000-8000-000000000002'::uuid, org_id, root_id, 'legal_entity'::org_unit_type, 'P99 entity B'
  from p99_roots where org_id = 'a0980000-0000-4000-8000-000000000001'
union all
select 'e0980000-0000-4000-8000-000000000009'::uuid, org_id, root_id, 'legal_entity'::org_unit_type, 'P99 other entity'
  from p99_roots where org_id = 'a0980000-0000-4000-8000-000000000002';

insert into auth.users (id, email) values
  ('b0980000-0000-4000-8000-000000000001', 'p99-owner@example.test'),
  ('b0980000-0000-4000-8000-000000000002', 'p99-entity-b-only@example.test'),
  ('b0980000-0000-4000-8000-000000000009', 'p99-other-owner@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001', 'P99 owner', 'owner', true),
  ('b0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001', 'P99 entity B officer', 'office', true),
  ('b0980000-0000-4000-8000-000000000009', 'a0980000-0000-4000-8000-000000000002', 'P99 other owner', 'owner', true);

-- The officer is narrowed to ONE sibling. That narrowing is what makes assertion 4 meaningful:
-- without it the reader would see everything for a reason unrelated to scope.
--
-- Measured rather than assumed: creating a profile ALREADY grants it the organisation root, for
-- owner and office alike, and the closure expands that to every unit. So the fixture removes the
-- automatic grant before adding the narrow one. Inserting the root grant instead -- which is
-- what this suite first tried -- raises a duplicate key, which is the schema saying the premise
-- was wrong. The owner keeps the automatic root grant, which is exactly the contrast the
-- assertions below need.
delete from public.user_scope_grants
 where org_id = 'a0980000-0000-4000-8000-000000000001'
   and user_id = 'b0980000-0000-4000-8000-000000000002';
insert into public.user_scope_grants(org_id, user_id, unit_id) values
  ('a0980000-0000-4000-8000-000000000001', 'b0980000-0000-4000-8000-000000000002',
   'e0980000-0000-4000-8000-000000000002');

-- ---- 1. THE ACTOR RULE, IN BOTH DIRECTIONS, ON ALL THREE TABLES ------------------------------
-- A browser document with no uploader: the upload nobody made.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into public.documents(org_id, entity_type, entity_id, storage_path, file_name,
                                 mime_type, uploaded_by, source)
    values ('a0980000-0000-4000-8000-000000000001', 'inbox', null,
            'a0980000-0000-4000-8000-000000000001/nobody.pdf', 'nobody.pdf',
            'application/pdf', null, 'browser')
  $$) like '23514:%',
  'a browser document with no uploader was stored');

-- A channel document that names a person: either a mislabelled upload, or an attribution nobody
-- made. Both are refusals, and it matters that this direction is checked too -- it is the one a
-- "just make the actor optional" change would have left open.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into public.documents(org_id, entity_type, entity_id, storage_path, file_name,
                                 mime_type, uploaded_by, unit_id, source)
    values ('a0980000-0000-4000-8000-000000000001', 'inbox', null,
            'a0980000-0000-4000-8000-000000000001/claimed.pdf', 'claimed.pdf',
            'application/pdf', 'b0980000-0000-4000-8000-000000000001',
            'e0980000-0000-4000-8000-000000000001', 'email')
  $$) like '23514:%',
  'an email document was allowed to name a human uploader');

-- The legitimate machine document. Everything after this point depends on it being storable.
insert into public.documents(id, org_id, entity_type, entity_id, storage_path, file_name,
                             mime_type, uploaded_by, unit_id, source)
values ('d0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
        'inbox', null, 'a0980000-0000-4000-8000-000000000001/inbound-a.pdf', 'inbound-a.pdf',
        'application/pdf', null, 'e0980000-0000-4000-8000-000000000001', 'email');

-- source is immutable. A document cannot be relabelled later to acquire or shed an actor.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    update public.documents set source = 'browser'
     where id = 'd0980000-0000-4000-8000-000000000001'
  $$) like '42501:document_source_immutable%',
  'a document''s source could be rewritten after insert');

-- ---- 2. A JOB CANNOT DISAGREE WITH ITS DOCUMENT ABOUT WHERE IT CAME FROM ---------------------
-- The mismatch is refused by the composite foreign key, not by a trigger anyone can forget to
-- fire and not by a convention in a function.
-- Two layers, proved separately.
--
-- LAYER ONE, the derivation: a writer that states the wrong source does not get it. Six live
-- functions build a job out of a document and none of them says anything about source, so the
-- copy is filled from the parent rather than typed -- and a writer that DOES type it is
-- overruled rather than believed.
insert into public.document_processing_jobs
  (id, org_id, document_id, requested_by, status, input_checksum, contract_version,
   priority, attempt_count, created_at, updated_at, source)
values ('f0980000-0000-4000-8000-0000000000aa', 'a0980000-0000-4000-8000-000000000001',
        'd0980000-0000-4000-8000-000000000001', null, 'queued',
        'etag:0000000000000000000000000000000a', '1', 0, 0, now(), now(), 'whatsapp');
select pg_temp.p99_assert(
  (select source = 'email' from public.document_processing_jobs
    where id = 'f0980000-0000-4000-8000-0000000000aa'),
  'a job that claimed whatsapp over an email document kept the claim');
delete from public.document_processing_jobs where id = 'f0980000-0000-4000-8000-0000000000aa';

-- LAYER TWO, the key: with the derivation switched OFF, the mismatched row is still unstorable.
-- This is the mutation the plan asked for -- without it, layer one could be the only thing
-- standing between a job and a document it does not belong to, and a future writer that bypasses
-- the trigger would silently succeed.
alter table public.document_processing_jobs disable trigger document_processing_jobs_inherit_source;
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into public.document_processing_jobs
      (id, org_id, document_id, requested_by, status, input_checksum, contract_version,
       priority, attempt_count, created_at, updated_at, source)
    values (gen_random_uuid(), 'a0980000-0000-4000-8000-000000000001',
            'd0980000-0000-4000-8000-000000000001', null, 'queued',
            'etag:00000000000000000000000000000001', '1', 0, 0, now(), now(), 'whatsapp')
  $$) like '23503:%',
  'with the derivation disabled, a whatsapp job was stored against an email document');
alter table public.document_processing_jobs enable trigger document_processing_jobs_inherit_source;

-- And a job that agrees with its document needs no actor at all -- which is the entire point.
insert into public.document_processing_jobs
  (id, org_id, document_id, requested_by, status, input_checksum, contract_version,
   priority, attempt_count, created_at, updated_at, source)
values ('f0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
        'd0980000-0000-4000-8000-000000000001', null, 'queued',
        'etag:00000000000000000000000000000001', '1', 0, 0, now(), now(), 'email');

-- A machine job that names a person is refused on the same rule as the document.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into public.document_processing_jobs
      (id, org_id, document_id, requested_by, status, input_checksum, contract_version,
       priority, attempt_count, created_at, updated_at, source)
    values (gen_random_uuid(), 'a0980000-0000-4000-8000-000000000001',
            'd0980000-0000-4000-8000-000000000001', 'b0980000-0000-4000-8000-000000000001',
            'queued', 'etag:00000000000000000000000000000002', '1', 0, 0, now(), now(), 'email')
  $$) like '23514:%',
  'an email job was allowed to name a human requester');

-- An IMAGE must reach scanning. This is the row 0136:100 made impossible: `requested_by` was
-- `not null` in its own right, so a photographed invoice could not enter the scan queue at all
-- however many other locks were released.
insert into public.documents(id, org_id, entity_type, entity_id, storage_path, file_name,
                             mime_type, uploaded_by, unit_id, source)
values ('d0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001',
        'inbox', null, 'a0980000-0000-4000-8000-000000000001/inbound-photo.jpg',
        'inbound-photo.jpg', 'image/jpeg', null,
        'e0980000-0000-4000-8000-000000000001', 'whatsapp');
insert into public.document_processing_jobs
  (id, org_id, document_id, requested_by, status, input_checksum, contract_version,
   priority, attempt_count, created_at, updated_at, source)
values ('f0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001',
        'd0980000-0000-4000-8000-000000000002', null, 'awaiting_scan',
        'etag:00000000000000000000000000000003', '1', 0, 0, now(), now(), 'whatsapp');
insert into public.document_scan_jobs
  (id, org_id, document_id, processing_job_id, requested_by, status, input_checksum, source)
values ('f0980000-0000-4000-8000-000000000003', 'a0980000-0000-4000-8000-000000000001',
        'd0980000-0000-4000-8000-000000000002', 'f0980000-0000-4000-8000-000000000002',
        null, 'queued', 'etag:00000000000000000000000000000003', 'whatsapp');
select pg_temp.p99_assert(
  exists (select 1 from public.document_scan_jobs
           where id = 'f0980000-0000-4000-8000-000000000003'
             and requested_by is null and source = 'whatsapp'),
  'an image with no human could not enter the scan queue');

-- ---- 3. THE INGEST RPC DOES NOT BELIEVE ITS CALLER -------------------------------------------
insert into private.inbound_routes(route_id, org_id, intake_unit_id, source, created_by) values
  ('c0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
   'e0980000-0000-4000-8000-000000000001', 'email', 'b0980000-0000-4000-8000-000000000001'),
  ('c0980000-0000-4000-8000-000000000009', 'a0980000-0000-4000-8000-000000000002',
   'e0980000-0000-4000-8000-000000000009', 'email', 'b0980000-0000-4000-8000-000000000009');

-- A route cannot point at a unit of another organisation: composite FK, not a check anyone runs.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into private.inbound_routes(org_id, intake_unit_id, source)
    values ('a0980000-0000-4000-8000-000000000001',
            'e0980000-0000-4000-8000-000000000009', 'email')
  $$) like '23503:%',
  'a route was pointed at another organisation''s unit');

-- Two objects: one belonging to our tenant, one belonging to the OTHER tenant. The second exists
-- purely so the RPC can be asked to steal it.
insert into storage.objects(id, bucket_id, name, version, metadata) values
  ('40980000-0000-4000-8000-000000000001', 'documents',
   'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf', 'v1',
   '{"mimetype":"application/pdf","size":1024}'::jsonb),
  ('40980000-0000-4000-8000-000000000009', 'documents',
   'a0980000-0000-4000-8000-000000000002/inbound/theirs.pdf', 'v1',
   '{"mimetype":"application/pdf","size":1024}'::jsonb);

insert into private.inbound_intake_claims
  (claim_id, route_id, org_id, intake_unit_id, source, provider, provider_message_id,
   attachment_id, state, lease_until, storage_path, media_type, byte_size)
values
  ('50980000-0000-4000-8000-000000000001', 'c0980000-0000-4000-8000-000000000001',
   'a0980000-0000-4000-8000-000000000001', 'e0980000-0000-4000-8000-000000000001', 'email',
   'resend', 'msg-1', 'att-1', 'stored', now() + interval '5 minutes',
   'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf', 'application/pdf', 1024);

-- One message, one attachment, one claim. A provider that redelivers cannot open a second.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    insert into private.inbound_intake_claims
      (route_id, org_id, intake_unit_id, source, provider, provider_message_id, attachment_id,
       lease_until)
    values ('c0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
            'e0980000-0000-4000-8000-000000000001', 'email', 'resend', 'msg-1', 'att-1',
            now() + interval '5 minutes')
  $$) like '23505:%',
  'a redelivered message opened a second claim for the same attachment');

-- A claim cannot be re-pointed at another tenant after it exists.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    update private.inbound_intake_claims
       set org_id = 'a0980000-0000-4000-8000-000000000002'
     where claim_id = '50980000-0000-4000-8000-000000000001'
  $$) like '42501:inbound_claim_identity_immutable%',
  'a claim was moved to another tenant');

-- The lease token is carried into a session setting BEFORE the role changes. `service_role` has
-- no access to the `private` schema at all, so a subquery reading the claim row inside the test's
-- own argument list fails with "permission denied for schema private" -- and a refusal assertion
-- that only checks "it refused" then passes on the TEST's failure rather than the product's.
-- That is exactly what happened here before this line existed.
select set_config('app.p99_lease',
  (select lease_token::text from private.inbound_intake_claims
    where claim_id = '50980000-0000-4000-8000-000000000001'), true);

-- auth.role() reads the JWT CLAIM, not the Postgres session role: setting the role alone leaves
-- it NULL and every service-only gate refuses with service_role_only, which would make every
-- refusal below pass for the wrong reason. The claim is set alongside the role, as every other
-- suite in this repository does.
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

-- THE CHANNEL IS CLOSED. Everything below this line would otherwise succeed, and the platform
-- stop has to come first -- before the object checks, before the tenant checks.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    select public.service_ingest_inbound_document(
      '50980000-0000-4000-8000-000000000001',
      current_setting('app.p99_lease')::uuid,
      '40980000-0000-4000-8000-000000000001', 'v1')
  $$) like '42501:inbound_channel_closed%',
  'a document was ingested while the platform had the channel closed');

reset role;
select set_config('request.jwt.claim.role', '', true);
-- Opened only for this transaction, and rolled back with everything else. Nothing in the product
-- can do this: the table is revoked from every role including service_role, which is asserted
-- further down.
update private.inbound_channel_boundary
   set enabled = true, enabled_at = now(),
       enabled_by = 'b0980000-0000-4000-8000-000000000001',
       enable_reason = 'P99 fixture'
 where channel = 'email';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

-- THE STOLEN OBJECT. The caller is service_role and may read every tenant, so this is the shape
-- that matters most: a claim of tenant A completed with an object living under tenant B's prefix.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    select public.service_ingest_inbound_document(
      '50980000-0000-4000-8000-000000000001',
      current_setting('app.p99_lease')::uuid,
      '40980000-0000-4000-8000-000000000009', 'v1')
  $$) like '42501:inbound_object_outside_tenant_prefix%',
  'one tenant''s claim was completed with another tenant''s object');

-- THE STALE LEASE. A worker from an earlier attempt is still alive and still finishing. Its
-- token is not the current one, and `lease_until` alone could never have told us that.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    select public.service_ingest_inbound_document(
      '50980000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000ff',
      '40980000-0000-4000-8000-000000000001', 'v1')
  $$) like '40001:inbound_claim_lease_lost%',
  'a stale worker completed a claim that had been re-leased');

-- TOCTOU. The object was replaced between the download and this call, so the bytes we checked
-- are not the bytes now stored. Recording the row anyway is how one tenant's file ends up
-- described as another's.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    select public.service_ingest_inbound_document(
      '50980000-0000-4000-8000-000000000001',
      current_setting('app.p99_lease')::uuid,
      '40980000-0000-4000-8000-000000000001', 'v2')
  $$) like '40001:inbound_object_version_changed%',
  'an object that changed under us was ingested on the version we no longer had');

-- The happy path, and the only one in this suite.
select pg_temp.p99_assert(
  (select public.service_ingest_inbound_document(
     '50980000-0000-4000-8000-000000000001',
     current_setting('app.p99_lease')::uuid,
     '40980000-0000-4000-8000-000000000001', 'v1')) is not null,
  'a valid inbound claim did not produce a document');

-- The document it produced has NO uploader, carries its channel, and inherited the route's unit
-- rather than being organisation-wide.
select pg_temp.p99_assert(
  (select uploaded_by is null and source = 'email'
          and unit_id = 'e0980000-0000-4000-8000-000000000001'
          and entity_type = 'inbox'
     from public.documents
    where storage_path = 'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf'),
  'the ingested document did not come out with no actor, its channel and its route''s unit');

-- REPLAY. The provider redelivers, the worker runs again, and the answer is the SAME document --
-- not a second one, and not an error either.
select pg_temp.p99_assert(
  (select count(*) from public.documents
    where storage_path = 'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf') = 1
  and (select public.service_ingest_inbound_document(
         '50980000-0000-4000-8000-000000000001',
         current_setting('app.p99_lease')::uuid,
         '40980000-0000-4000-8000-000000000001', 'v1'))
      = (select id from public.documents
          where storage_path = 'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf')
  and (select count(*) from public.documents
        where storage_path = 'a0980000-0000-4000-8000-000000000001/inbound/mine.pdf') = 1,
  'a replayed claim produced a second document');

reset role;
select set_config('request.jwt.claim.role', '', true);

-- Who may reach it at all. Asserted from the privilege catalogue rather than by calling it as
-- the wrong role: "read as the wrong role and catch insufficient_privilege" is the pattern that
-- has taken this backend down, and it would also pass here for the wrong reason -- which is
-- exactly what happened before the grant below existed. Every refusal above was returning
-- "permission denied for function" and every assertion that only checked "it refused" was green.
select pg_temp.p99_assert(
  has_function_privilege('service_role',
    'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute'),
  'service_role cannot execute the command it is the only caller of');
select pg_temp.p99_assert(
  not has_function_privilege('authenticated',
    'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon',
    'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute'),
  'a browser role can execute the inbound ingest command');

-- ---- 4. A SIBLING LEGAL ENTITY CANNOT SEE THE OTHER'S POST -----------------------------------
-- The owner is granted the root and therefore both entities; the officer is granted entity B
-- only. The document that arrived belongs to entity A.
select pg_temp.p99_assert(
  (select array['e0980000-0000-4000-8000-000000000001'::uuid] <@
          private.scopes_for_user('b0980000-0000-4000-8000-000000000001',
                                  'a0980000-0000-4000-8000-000000000001')),
  'the owner is not scoped to entity A, so the sibling test would prove nothing');
select pg_temp.p99_assert(
  not (select array['e0980000-0000-4000-8000-000000000001'::uuid] <@
       private.scopes_for_user('b0980000-0000-4000-8000-000000000002',
                               'a0980000-0000-4000-8000-000000000001')),
  'the entity-B officer is scoped to entity A, so the sibling test would prove nothing');

-- The scope function takes its subject as an ARGUMENT. `auth_scopes()` could not be used here:
-- it reads auth.uid(), returns '{}' with no JWT, and `assert_unit_in_scope` then early-exits
-- treating the caller as trusted service work -- a check that passes without checking.
select pg_temp.p99_assert(
  private.scopes_for_user('b0980000-0000-4000-8000-000000000002',
                          'a0980000-0000-4000-8000-000000000001')
    is distinct from
  private.scopes_for_user('b0980000-0000-4000-8000-000000000001',
                          'a0980000-0000-4000-8000-000000000001'),
  'two differently-scoped people got the same scope out of the server-side function');

-- And the promise the scope function exists to keep, measured on the reader the product will
-- actually call. Asserting only that two people have different scopes proves the LOOKUP works;
-- it does not prove the door uses it. So the door is opened as each of them in turn.
--
-- The document that arrived belongs to entity A. The owner is scoped to the root and therefore
-- to A; the officer is scoped to B alone.
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000001', true);
select pg_temp.p99_assert(
  (select count(*) from public.inbound_provenance_for_org()) = 1,
  'the owner, scoped to the entity that received the document, cannot see that it arrived');

select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000002', true);
select pg_temp.p99_assert(
  (select count(*) from public.inbound_provenance_for_org()) = 0,
  'a reader scoped to the sibling legal entity can see the other one''s inbound document');

-- The other ORGANISATION is a different question from the sibling entity, and both have to hold:
-- one is the scope axis, the other is the tenant axis.
select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000009', true);
select pg_temp.p99_assert(
  (select count(*) from public.inbound_provenance_for_org()) = 0,
  'another tenant can see this organisation''s inbound document');
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

-- ---- 5. THE PLATFORM CAN STOP THIS AND THE TENANT CANNOT START IT ----------------------------
select pg_temp.p99_assert(
  not has_table_privilege('authenticated', 'private.inbound_channel_boundary', 'update')
  and not has_table_privilege('service_role', 'private.inbound_channel_boundary', 'update')
  and not has_table_privilege('anon', 'private.inbound_channel_boundary', 'select'),
  'a product role can write or read the platform intake boundary');
select pg_temp.p99_assert(
  not has_table_privilege('authenticated', 'private.inbound_intake_claims', 'select')
  and not has_table_privilege('authenticated', 'private.inbound_routes', 'select'),
  'the browser can read the private intake ledgers directly');

-- Enabling is not a boolean flip: it must carry who, when and why, or it is not storable.
select pg_temp.p99_assert(
  pg_temp.p99_refusal($$
    update private.inbound_channel_boundary
       set enabled = true, enabled_at = null, enabled_by = null, enable_reason = null
     where channel = 'whatsapp'
  $$) like '23514:%',
  'a channel was enabled without recording who did it and why');

-- ---- 6. THE CLAIMER STOPPED REQUIRING A HUMAN ------------------------------------------------
-- Read from the LIVE body rather than from the migration text, because the migration patched
-- what was running rather than redeclaring it from a file.
select pg_temp.p99_assert(
  position('left join public.profiles p' in
           replace(pg_get_functiondef(to_regprocedure(
             'private.claim_document_interpretation_jobs(integer,integer)')), e'\r', '')) > 0
  and position('d.source <> ''browser'' and j.requested_by is null' in
           replace(pg_get_functiondef(to_regprocedure(
             'private.claim_document_interpretation_jobs(integer,integer)')), e'\r', '')) > 0
  and position('and j.source = d.source' in
           replace(pg_get_functiondef(to_regprocedure(
             'private.claim_document_interpretation_jobs(integer,integer)')), e'\r', '')) > 0,
  'the interpretation claimer still drops a document that has no uploader');

-- And it did not lose the browser-side requirement while gaining the machine one. An inner join
-- turned into a left join with no compensating predicate would let a browser document whose
-- uploader is inactive, or the wrong role, through the door the join was closing.
select pg_temp.p99_assert(
  position('d.source = ''browser'' and j.requested_by = d.uploaded_by and p.id is not null' in
           replace(pg_get_functiondef(to_regprocedure(
             'private.claim_document_interpretation_jobs(integer,integer)')), e'\r', '')) > 0,
  'the browser branch lost its active owner/office requirement when the join was relaxed');

-- ---- 6b. A PACKET SPLIT HANDS ITS CHILDREN THE PARENT'S SOURCE -------------------------------
-- The one row the derivation trigger cannot reach: a child document has no link to its parent at
-- insert time. Without this, an emailed PDF holding three invoices splits into three children
-- that inherit a NULL uploader beside a defaulted 'browser' source and the split fails on the
-- CHECK -- a document arriving and then vanishing at the step whose job is to rescue it.
select pg_temp.p99_assert(
  position('v_parent.document_date,v_parent.unit_id,v_parent.source' in
           replace(pg_get_functiondef(to_regprocedure(
             'public.service_materialize_document_packet(uuid, text, uuid)')), e'\r', '')) > 0,
  'a packet split still gives its children the default source');

-- ---- 7. THE INGEST SIGNATURE CANNOT NAME A TENANT --------------------------------------------
-- The shape of the signature IS the security property: an org_id parameter would make this a
-- function that believes whichever tenant a globally privileged caller names.
select pg_temp.p99_assert(
  (select pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'service_ingest_inbound_document')
  = 'p_claim_id uuid, p_lease_token uuid, p_object_id uuid, p_object_version text',
  'the ingest command accepts something other than a claim, a lease token and an object');

rollback;

select 'P99_a_document_with_no_human_passed' as result;
