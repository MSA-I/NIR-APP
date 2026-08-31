-- 0276 — a document carries the actor that made it, and a machine is an actor.
--
-- WHY THIS IS NOT "RELEASING TWO LOCKS". The plan for inbound intake described the pipeline as
-- human-only in two places and proposed relaxing both. Measured against the tree, that is not
-- enough and would have shipped a channel that silently swallows documents:
--
--   * `document_scan_jobs.requested_by` is `not null` in its own right (0136:100, with an FK),
--     so an IMAGE arriving from a provider cannot enter scanning at all;
--   * `private.claim_document_interpretation_jobs` (last defined in 0246) blocks a machine
--     document TWICE -- `and j.requested_by = d.uploaded_by`, and an INNER JOIN to `profiles`
--     on `d.uploaded_by` requiring an ACTIVE owner/office profile. The second pin is not in the
--     plan; it was found by reading the live body. A document with no uploader is dropped by the
--     join before the predicate is ever evaluated.
--
-- So the shape here is a contract, not a relaxation: every document and every unit of work
-- declares WHERE IT CAME FROM, and the actor rule is derived from that rather than assumed.
--
-- THE INVARIANT, in one line: a browser document has a human; a channel document has none; and
-- neither can pretend to be the other, because the database refuses to store the combination.
--
-- WHAT THIS MIGRATION MUST NOT DO, and does not:
--   * it does not touch `documents_insert`, `register_uploaded_document` or any other step of
--     the browser path. `source` arrives with a DEFAULT precisely so the three live builders
--     that insert without the column (0131:139, 0140:495, 0169:234) keep working unchanged. A
--     `not null` with no default would have broken all three -- which is the iron rule, not a
--     style preference.
--   * it does not make a silent default dangerous. A machine row that quietly took 'browser'
--     is REFUSED, because the bidirectional CHECK then demands a human actor it does not have.
--     The default cannot disguise a source; it collides with the missing actor.
--   * it does not invent an actor. Nowhere is a document attributed to the organisation's owner
--     because a human was convenient to name. An actor who did not ask is a lie in the ledger.
--   * it does not take `org_id` from a caller. `service_role` is a globally privileged reader,
--     so a function that accepts `org_id`, a path and a MIME type does not VERIFY a tenant, it
--     TRUSTS one. Every field is derived from the routing row in this database.
--
-- The intake channels themselves are NOT enabled here. This is the contract they will need, the
-- claim ledger they will write to, and the refusals they will hit. Nothing polls, nothing
-- fetches, and `private.inbound_channel_boundary` starts disabled with no product door to
-- enable it.

-- ===================================================================================
-- 0. PREFLIGHT — the backfill is not safe by assumption, so it is not assumed
-- ===================================================================================
-- `documents.uploaded_by` has been NULLABLE since 0001:368 and never was anything else. So
-- production may hold historical documents with no uploader at all. Marking every existing row
-- 'browser' and then enforcing "browser implies an actor" would FAIL ON THOSE ROWS -- at apply
-- time, in production, half way through a migration.
--
-- This block is that measurement, run where it matters rather than remembered from a
-- development database. A non-zero count STOPS the migration and asks for an owner decision on
-- what those documents' origin actually is: a separate 'legacy' source, or an exclusion of
-- pre-migration rows from the CHECK. Both are decisions. Guessing one is not available, and
-- attributing an old document to a person who did not upload it is not available either.
do $preflight_0276$
declare
  v_orphans bigint;
begin
  select count(*) into v_orphans from public.documents where uploaded_by is null;
  if v_orphans > 0 then
    raise exception using
      errcode = '23514',
      message = format('0276 preflight: %s document(s) have no uploader', v_orphans),
      detail  = 'documents.uploaded_by has been nullable since 0001 and these rows predate any '
             || 'actor requirement. Backfilling them to source=browser would violate the '
             || 'browser-implies-actor CHECK this migration adds.',
      hint    = 'This needs an owner decision recorded in docs/OPEN-DECISIONS.md: either a '
             || 'distinct legacy source value, or an explicit exclusion of pre-migration rows '
             || 'from the CHECK. Do not attribute these documents to a person.';
  end if;
end
$preflight_0276$;

-- ===================================================================================
-- 1. SOURCE — three tables, one closed vocabulary, immutable after insert
-- ===================================================================================
-- Text plus CHECK rather than a real enum, deliberately. `user_role` is the cautionary tale in
-- this repository: a real enum embedded in 77 policies that nobody can now widen. A closed CHECK
-- gives the same refusal with an ALTER that a later migration can actually perform.

alter table public.documents
  add column if not exists source text not null default 'browser';
alter table public.document_processing_jobs
  add column if not exists source text not null default 'browser';
alter table public.document_scan_jobs
  add column if not exists source text not null default 'browser';

do $source_checks_0276$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_source_check') then
    alter table public.documents add constraint documents_source_check
      check (source in ('browser', 'email', 'whatsapp'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'document_processing_jobs_source_check') then
    alter table public.document_processing_jobs add constraint document_processing_jobs_source_check
      check (source in ('browser', 'email', 'whatsapp'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_scan_jobs_source_check') then
    alter table public.document_scan_jobs add constraint document_scan_jobs_source_check
      check (source in ('browser', 'email', 'whatsapp'));
  end if;
end
$source_checks_0276$;

-- Immutable after insert. A document that arrived by email cannot be re-labelled a browser
-- upload later to acquire an actor, and a browser upload cannot be relabelled to shed one.
create or replace function private.source_is_immutable() returns trigger
language plpgsql as $$
begin
  if new.source is distinct from old.source then
    raise exception 'document_source_immutable'
      using errcode = '42501',
            detail = format('%s.source may not change after insert (%s -> %s)',
                            tg_table_name, old.source, new.source);
  end if;
  return new;
end
$$;

drop trigger if exists documents_source_immutable on public.documents;
create trigger documents_source_immutable
  before update of source on public.documents
  for each row execute function private.source_is_immutable();

drop trigger if exists document_processing_jobs_source_immutable on public.document_processing_jobs;
create trigger document_processing_jobs_source_immutable
  before update of source on public.document_processing_jobs
  for each row execute function private.source_is_immutable();

drop trigger if exists document_scan_jobs_source_immutable on public.document_scan_jobs;
create trigger document_scan_jobs_source_immutable
  before update of source on public.document_scan_jobs
  for each row execute function private.source_is_immutable();

-- ===================================================================================
-- 2. THE JOB AND ITS DOCUMENT MUST AGREE ABOUT WHERE THEY CAME FROM
-- ===================================================================================
-- Three tables each carrying an independent `source` is three chances to disagree. Without a
-- structural tie, a job could claim source='email' over a browser document and use that claim to
-- shed the actor requirement -- the exact bypass this contract exists to prevent. So the tie is
-- a composite foreign key, not a convention: the existing (org_id, document_id) references are
-- WIDENED to carry source, which keeps every guarantee they already gave and adds this one.

do $source_fk_0276$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_org_id_source_key') then
    alter table public.documents
      add constraint documents_org_id_source_key unique (org_id, id, source);
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'document_processing_jobs_document_tenant_fk') then
    alter table public.document_processing_jobs
      drop constraint document_processing_jobs_document_tenant_fk;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'document_processing_jobs_document_source_fk') then
    alter table public.document_processing_jobs
      add constraint document_processing_jobs_document_source_fk
      foreign key (org_id, document_id, source)
      references public.documents (org_id, id, source) on delete restrict;
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'document_scan_jobs_document_tenant_fk') then
    alter table public.document_scan_jobs
      drop constraint document_scan_jobs_document_tenant_fk;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'document_scan_jobs_document_source_fk') then
    alter table public.document_scan_jobs
      add constraint document_scan_jobs_document_source_fk
      foreign key (org_id, document_id, source)
      references public.documents (org_id, id, source) on delete restrict;
  end if;
end
$source_fk_0276$;

-- ===================================================================================
-- 2b. A JOB'S SOURCE IS DERIVED, NEVER TYPED BY ITS WRITER
-- ===================================================================================
-- Measured, and it is the reason this section exists rather than six edits: EIGHT live functions
-- insert into `documents` or the two work tables, and six of them build a job out of a document
-- they just read --
--
--   enqueue_document_processing (0169), reprocess_document (0136), accept_document_scan (0136),
--   recover_document_scan (0136), service_recover_stuck_document_processing (0132) and
--   service_materialize_document_packet (0140).
--
-- Every one of them passes `v_document.uploaded_by` as the actor and says nothing about source.
-- For an inbound document that is a NULL actor next to a defaulted 'browser' source -- which the
-- CHECK above refuses. So without this section, the very first step of the machine path fails and
-- the contract is a contract for a pipeline nothing can enter.
--
-- Six anchored replacements would fix it and would also be six chances to get an anchor wrong,
-- plus a seventh chance for the next writer somebody adds. So the copy is DERIVED instead:
-- `source` on a work row is not independent information, it is a denormalised copy of the
-- document's, kept where the CHECK can see it. A BEFORE INSERT trigger fills it from the parent,
-- and the composite foreign key from section 2 stays exactly where it is -- the trigger keeps the
-- copy right, the key proves it stayed right, and a row that somehow disagrees is still
-- unstorable. P99 proves both layers separately, the second by disabling the first.
create or replace function private.work_row_inherits_document_source() returns trigger
language plpgsql as $$
declare
  v_source text;
begin
  select d.source into v_source
    from public.documents d
   where d.org_id = new.org_id and d.id = new.document_id;
  if v_source is null then
    -- No parent document. Left alone deliberately: the foreign key is the right thing to refuse
    -- this, with the right message, a moment later.
    return new;
  end if;
  new.source := v_source;
  return new;
end
$$;

drop trigger if exists document_processing_jobs_inherit_source on public.document_processing_jobs;
create trigger document_processing_jobs_inherit_source
  before insert on public.document_processing_jobs
  for each row execute function private.work_row_inherits_document_source();

drop trigger if exists document_scan_jobs_inherit_source on public.document_scan_jobs;
create trigger document_scan_jobs_inherit_source
  before insert on public.document_scan_jobs
  for each row execute function private.work_row_inherits_document_source();

-- The one row a trigger cannot derive: the CHILD DOCUMENT a packet split creates. It is a
-- document, not a work row, and at insert time nothing links it to its parent yet -- the segment
-- row that will link them is updated afterwards. So this one is an anchored replacement, and it
-- is one rather than six.
--
-- Without it, an emailed PDF that turns out to hold three invoices splits into three children
-- that inherit the parent's NULL uploader beside a defaulted 'browser' source, and the split
-- fails on the CHECK -- a document arriving and then disappearing at the one step whose whole
-- job is to rescue it.
do $packet_0276$
declare
  v_source text;
  v_patched text;
  v_hits integer;
begin
  select replace(pg_get_functiondef(p.oid), e'\r', '')
    into v_source
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'service_materialize_document_packet';
  if v_source is null then
    raise exception '0276: public.service_materialize_document_packet is not defined';
  end if;

  if position('v_parent.document_date,v_parent.unit_id,v_parent.source' in v_source) > 0 then
    return;  -- already patched; a replayed migration must not patch a patched body
  end if;

  select (length(v_source) - length(replace(v_source, 'document_kind,supplier_id,document_date,unit_id', '')))
         / length('document_kind,supplier_id,document_date,unit_id')
    into v_hits;
  if v_hits <> 1 then
    raise exception '0276: expected exactly one packet child-document column list, found %', v_hits;
  end if;

  v_patched := replace(v_source,
    'document_kind,supplier_id,document_date,unit_id',
    'document_kind,supplier_id,document_date,unit_id,source');
  v_patched := replace(v_patched,
    'v_parent.uploaded_by,v_kind,v_parent.supplier_id,v_parent.document_date,v_parent.unit_id',
    'v_parent.uploaded_by,v_kind,v_parent.supplier_id,v_parent.document_date,v_parent.unit_id,v_parent.source');
  if v_patched = v_source then
    raise exception '0276: the packet child-document patch produced no change';
  end if;
  execute v_patched;
end
$packet_0276$;

-- ===================================================================================
-- 3. THE ACTOR RULE — bidirectional, so neither direction can be forgotten
-- ===================================================================================
-- `requested_by` becomes nullable on both work tables, and the CHECK immediately takes back
-- everything that relaxation gave away in the browser case. Stated as two implications rather
-- than one, because a one-way rule ("a channel job may have no actor") would still permit a
-- browser job with no actor -- an upload nobody made -- which is the failure this replaces.

alter table public.document_processing_jobs alter column requested_by drop not null;
alter table public.document_scan_jobs       alter column requested_by drop not null;

do $actor_checks_0276$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'document_processing_jobs_actor_matches_source') then
    alter table public.document_processing_jobs
      add constraint document_processing_jobs_actor_matches_source check (
        (source = 'browser' and requested_by is not null)
        or (source <> 'browser' and requested_by is null));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'document_scan_jobs_actor_matches_source') then
    alter table public.document_scan_jobs
      add constraint document_scan_jobs_actor_matches_source check (
        (source = 'browser' and requested_by is not null)
        or (source <> 'browser' and requested_by is null));
  end if;
  -- The same rule on the document itself. `uploaded_by` stays nullable in the type system
  -- because it always was, but from here a browser document without an uploader is refused and
  -- a channel document WITH one is refused too -- an inbound file that names a person is either
  -- a mislabelled upload or an attribution nobody made.
  if not exists (select 1 from pg_constraint where conname = 'documents_actor_matches_source') then
    alter table public.documents
      add constraint documents_actor_matches_source check (
        (source = 'browser' and uploaded_by is not null)
        or (source <> 'browser' and uploaded_by is null));
  end if;
end
$actor_checks_0276$;

-- ===================================================================================
-- 4. THE PLATFORM BOUNDARY — what actually stops intake
-- ===================================================================================
-- A tenant-facing flag is not a kill switch. `revoked_at` on an address and an `inbound_enabled`
-- toggle are both things the TENANT controls, so neither can stop a channel the platform needs
-- stopped. This table is in `private`, is revoked from every role including `service_role`, and
-- has no product door: an operator changes it with a migration or with direct database access,
-- which is the point.
--
-- Same shape as private.billing_provider_boundary (0187): enabling is not a boolean flip, it
-- carries who, when and why, and points at the decision that authorised it.
create table if not exists private.inbound_channel_boundary (
  channel            text primary key check (channel in ('email', 'whatsapp')),
  enabled            boolean not null default false,
  decision_reference text not null check (decision_reference ~ '^#[0-9]+$'),
  readiness          text not null check (length(btrim(readiness)) > 0),
  enabled_at         timestamptz,
  enabled_by         uuid references auth.users(id) on delete restrict,
  enable_reason      text,
  updated_at         timestamptz not null default now(),
  constraint inbound_channel_boundary_enable_shape check (
    (enabled = false and enabled_at is null and enabled_by is null and enable_reason is null)
    or (enabled = true and enabled_at is not null and enabled_by is not null
        and length(btrim(enable_reason)) > 0))
);
revoke all on table private.inbound_channel_boundary
  from public, anon, authenticated, service_role;

insert into private.inbound_channel_boundary (channel, decision_reference, readiness) values
  ('whatsapp', '#311', 'NOT_ENABLED: media intake decided, no verified Twilio account proven'),
  ('email',    '#309', 'NOT_ENABLED: no MX on in.inplace.digital, received_for unverified')
on conflict (channel) do nothing;

create or replace function private.inbound_channel_open(p_channel text) returns boolean
language sql stable security definer set search_path = private, public, pg_temp as $$
  select coalesce((select enabled from private.inbound_channel_boundary where channel = p_channel), false)
$$;
revoke all on function private.inbound_channel_open(text) from public, anon, authenticated;

-- ===================================================================================
-- 5. THE ROUTE — one canonical parent, so association is structural
-- ===================================================================================
-- A claim has to be tied to the routing decision that produced it, and a foreign key cannot
-- point at "either an address row or a connection row". Freezing org_id/unit/source ALONGSIDE a
-- routing id does not help either: nothing then proves the frozen values match that route.
--
-- So the parent is one table. An email address row and a WhatsApp connection row will each
-- point at a route, and a claim carries a COMPOSITE key into all four columns at once -- which
-- makes agreement a property of the schema rather than a promise in a function.
--
-- Revoked routes are kept (`revoked_at`), never deleted: a claim written before a tenant turned
-- the channel off still has to resolve, and a dangling claim is a document nobody can explain.
create table if not exists private.inbound_routes (
  route_id       uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete restrict,
  -- NOT NULL on purpose. An inbound document has no uploader and therefore no scope of its own;
  -- a null unit would make it organisation-wide, which means visible across sibling legal
  -- entities. The scope has to be decided when the route is created, by a human, once.
  intake_unit_id uuid not null,
  source         text not null check (source in ('email', 'whatsapp')),
  created_at     timestamptz not null default now(),
  created_by     uuid,
  revoked_at     timestamptz,
  revoked_by     uuid,
  constraint inbound_routes_unit_fk
    foreign key (org_id, intake_unit_id) references public.org_units(org_id, id) on delete restrict,
  constraint inbound_routes_creator_fk
    foreign key (org_id, created_by) references public.profiles(org_id, id) on delete restrict,
  constraint inbound_routes_identity unique (route_id, org_id, intake_unit_id, source)
);
revoke all on table private.inbound_routes from public, anon, authenticated;
create index if not exists inbound_routes_org_live_idx
  on private.inbound_routes (org_id, source) where revoked_at is null;

-- ===================================================================================
-- 6. THE CLAIM — written before any network I/O, fenced by a token
-- ===================================================================================
-- Order matters more than content here. The claim is taken BEFORE the provider is contacted, so
-- two deliveries of the same message cannot both fetch, and a crash mid-fetch leaves a row that
-- says what was in flight instead of leaving nothing at all.
--
-- `lease_until` and `attempt` are not authority. A worker from attempt 1 whose lease expired can
-- still be alive and can still finish AFTER attempt 2 has taken the claim -- and it would finish
-- with attempt 2's row. `lease_token` is the fence: the RPC is handed the token and verifies it
-- under a row lock, so a stale worker's completion is refused rather than applied.
create table if not exists private.inbound_intake_claims (
  claim_id            uuid primary key default gen_random_uuid(),
  -- The four routing columns travel together into the composite FK below. They are frozen by a
  -- trigger after insert: a claim cannot be re-pointed at another tenant once it exists.
  route_id            uuid not null,
  org_id              uuid not null,
  intake_unit_id      uuid not null,
  source              text not null,
  provider            text not null check (provider in ('resend', 'twilio')),
  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  -- One row per ATTACHMENT, not per message: a mail carrying three invoices is three documents,
  -- and a retry of that mail must not produce six.
  attachment_id       text not null check (length(btrim(attachment_id)) > 0),
  state               text not null default 'claimed' check (
                        state in ('claimed', 'fetching', 'stored', 'ingested', 'failed', 'abandoned')),
  lease_token         uuid not null default gen_random_uuid(),
  lease_until         timestamptz not null,
  attempt             integer not null default 1 check (attempt > 0),
  document_id         uuid,
  storage_path        text,
  byte_size           bigint check (byte_size is null or byte_size >= 0),
  media_type          text,
  -- Why it ended, in a bounded vocabulary. A dead letter that says only "failed" is not a ledger.
  reason_code         text,
  -- Follows the claim from the webhook to the document, so an operator can join a tenant's
  -- report of a missing invoice to what actually happened.
  correlation_id      uuid not null default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint inbound_intake_claims_identity
    unique (provider, provider_message_id, attachment_id),
  constraint inbound_intake_claims_route_fk
    foreign key (route_id, org_id, intake_unit_id, source)
    references private.inbound_routes (route_id, org_id, intake_unit_id, source) on delete restrict,
  constraint inbound_intake_claims_document_fk
    foreign key (org_id, document_id, source)
    references public.documents (org_id, id, source) on delete restrict,
  -- A terminal state has to say why; a live one has nothing to say yet.
  constraint inbound_intake_claims_reason_shape check (
    (state in ('failed', 'abandoned') and reason_code is not null)
    or (state not in ('failed', 'abandoned') and reason_code is null)),
  -- Only an ingested claim owns a document, and an ingested claim must own one.
  constraint inbound_intake_claims_document_shape check (
    (state = 'ingested' and document_id is not null)
    or (state <> 'ingested' and document_id is null))
);
revoke all on table private.inbound_intake_claims from public, anon, authenticated;
create index if not exists inbound_intake_claims_live_idx
  on private.inbound_intake_claims (state, lease_until)
  where state in ('claimed', 'fetching', 'stored');
create index if not exists inbound_intake_claims_org_idx
  on private.inbound_intake_claims (org_id, created_at desc);

create or replace function private.inbound_claim_route_is_frozen() returns trigger
language plpgsql as $$
begin
  if new.route_id is distinct from old.route_id
     or new.org_id is distinct from old.org_id
     or new.intake_unit_id is distinct from old.intake_unit_id
     or new.source is distinct from old.source
     or new.provider is distinct from old.provider
     or new.provider_message_id is distinct from old.provider_message_id
     or new.attachment_id is distinct from old.attachment_id then
    raise exception 'inbound_claim_identity_immutable'
      using errcode = '42501',
            detail = 'A claim may change state; it may not change which tenant, unit, channel '
                  || 'or provider message it belongs to.';
  end if;
  return new;
end
$$;

drop trigger if exists inbound_intake_claims_identity_frozen on private.inbound_intake_claims;
create trigger inbound_intake_claims_identity_frozen
  before update on private.inbound_intake_claims
  for each row execute function private.inbound_claim_route_is_frozen();

-- ===================================================================================
-- 7. SCOPE FOR A SERVER JOB — the check that was passing without checking
-- ===================================================================================
-- `auth_scopes()` takes no arguments and reads `auth.uid()`/`auth_org()` (0054:321-328). A cron
-- or service_role worker has no JWT, so it returns '{}' -- and `assert_unit_in_scope` then EARLY
-- EXITS on a missing JWT subject, treating it as trusted service work (0054:334-336). A scope
-- check written with those two inside a server job does not merely fail to protect: it PASSES,
-- because it is a server job. That is worse than no check, because it reads like one.
--
-- This is the explicit-argument version, server-only, over the same closure table those
-- functions read. It never impersonates a JWT and it has no opinion about who is calling.
create or replace function private.scopes_for_user(p_profile_id uuid, p_org_id uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select c.unit_ids
       from public.user_scope_closure c
      where c.user_id = p_profile_id
        and c.org_id = p_org_id),
    '{}'::uuid[])
$$;
revoke all on function private.scopes_for_user(uuid, uuid) from public, anon, authenticated;

-- ===================================================================================
-- 8. THE INGEST RPC — four arguments, and org_id is not one of them
-- ===================================================================================
-- The signature is the security property. `service_role` is a globally privileged reader, so a
-- function that accepted (org_id, path, mime) would not be verifying a tenant -- it would be
-- believing whichever tenant the caller named. Everything that decides WHOSE document this is
-- comes out of the claim and its route, inside this transaction, under a row lock.
--
-- What is re-checked here, atomically, and why each one:
--   * the lease token, against the row -- a stale worker must not finish another's attempt;
--   * the claim state -- a replay must add zero documents, not a second one;
--   * the channel boundary -- the platform's stop, re-read at the last moment;
--   * the storage object still exists AND still has the version we downloaded -- between the
--     fetch and this call the object could have been replaced (TOCTOU), and storing the row for
--     bytes we never saw is how one tenant's file ends up described as another's;
--   * the bucket and the `{org_id}/` prefix, derived here rather than trusted;
--   * the MIME type against smart_document_mime_allowed, which the browser path also obeys.
create or replace function public.service_ingest_inbound_document(
  p_claim_id       uuid,
  p_lease_token    uuid,
  p_object_id      uuid,
  p_object_version text
) returns uuid
language plpgsql security definer set search_path = public, private, storage, pg_temp as $$
declare
  v_claim   private.inbound_intake_claims%rowtype;
  v_object  record;
  v_doc_id  uuid;
  v_prefix  text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode = '42501';
  end if;

  select * into v_claim
    from private.inbound_intake_claims
   where claim_id = p_claim_id
     for update;
  if not found then
    raise exception 'inbound_claim_unknown' using errcode = '23503';
  end if;

  -- The fence, before anything else is considered. An expired lease that a live worker still
  -- holds is exactly the case `lease_until` alone cannot answer.
  if v_claim.lease_token is distinct from p_lease_token then
    raise exception 'inbound_claim_lease_lost' using errcode = '40001',
      detail = 'This claim has been leased to a later attempt; the completion is refused.';
  end if;

  -- Replay: an already-ingested claim returns its document and adds nothing. Not an error, and
  -- not a second document.
  if v_claim.state = 'ingested' then
    return v_claim.document_id;
  end if;
  if v_claim.state <> 'stored' then
    raise exception 'inbound_claim_not_stored' using errcode = '55000',
      detail = format('A claim is ingested from state stored; this one is %s.', v_claim.state);
  end if;

  if not private.inbound_channel_open(v_claim.source) then
    raise exception 'inbound_channel_closed' using errcode = '42501',
      detail = format('The %s intake channel is not enabled on this platform.', v_claim.source);
  end if;

  -- The route must still resolve. It may be revoked -- a claim taken before a tenant turned the
  -- channel off still finishes, because the alternative is a downloaded file with no home.
  if not exists (select 1 from private.inbound_routes r
                  where r.route_id = v_claim.route_id
                    and r.org_id = v_claim.org_id
                    and r.intake_unit_id = v_claim.intake_unit_id
                    and r.source = v_claim.source) then
    raise exception 'inbound_route_unknown' using errcode = '23503';
  end if;

  select o.id, o.name, o.bucket_id, o.version, o.metadata
    into v_object
    from storage.objects o
   where o.id = p_object_id;
  if not found then
    raise exception 'inbound_object_missing' using errcode = '23503',
      detail = 'The stored object does not exist at ingest time.';
  end if;
  if v_object.bucket_id is distinct from 'documents' then
    raise exception 'inbound_object_wrong_bucket' using errcode = '42501';
  end if;
  -- TOCTOU. The object we are about to describe must be the same VERSION we downloaded and
  -- checked; a replacement between fetch and ingest would have us record one tenant's bytes
  -- under another tenant's document.
  if v_object.version is distinct from p_object_version then
    raise exception 'inbound_object_version_changed' using errcode = '40001',
      detail = 'The stored object changed between the fetch and this call.';
  end if;

  v_prefix := v_claim.org_id::text || '/';
  if v_object.name is null or left(v_object.name, length(v_prefix)) <> v_prefix then
    raise exception 'inbound_object_outside_tenant_prefix' using errcode = '42501',
      detail = 'Every stored path begins with the owning organisation id.';
  end if;
  if v_claim.storage_path is distinct from v_object.name then
    raise exception 'inbound_object_path_mismatch' using errcode = '42501',
      detail = 'The claim named a different path than the object it is being completed with.';
  end if;

  if v_claim.media_type is null or not public.smart_document_mime_allowed(v_claim.media_type) then
    raise exception 'inbound_media_type_rejected' using errcode = '42501',
      detail = format('%s is not a stored document type.', coalesce(v_claim.media_type, 'unknown'));
  end if;

  -- `uploaded_by` is left null on purpose and `source` is stated explicitly rather than left to
  -- the default: the inbound path never relies on a default to describe itself.
  insert into public.documents (
    org_id, entity_type, entity_id, storage_path, file_name, mime_type,
    uploaded_by, document_kind, unit_id, source
  ) values (
    v_claim.org_id, 'inbox', null, v_object.name,
    coalesce(nullif(regexp_replace(v_object.name, '^.*/', ''), ''), 'inbound'),
    v_claim.media_type, null, 'other', v_claim.intake_unit_id, v_claim.source
  ) returning id into v_doc_id;

  update private.inbound_intake_claims
     set state = 'ingested',
         document_id = v_doc_id,
         updated_at = now()
   where claim_id = p_claim_id;

  return v_doc_id;
end
$$;
revoke all on function public.service_ingest_inbound_document(uuid, uuid, uuid, text)
  from public, anon, authenticated;
-- And then hand it back to the one caller that needs it. `revoke ... from public` removes the
-- default EXECUTE that every role inherits, service_role included -- so without this line the
-- Edge worker would meet "permission denied for function" and the whole channel would be shut by
-- an omission rather than by a decision. Found by the suite, not by reasoning: every refusal
-- assertion in P99 passed for the wrong reason until this grant existed.
grant execute on function public.service_ingest_inbound_document(uuid, uuid, uuid, text)
  to service_role;

-- ===================================================================================
-- 9. QUOTA — reserved before the fetch, settled after the count, released on every failure
-- ===================================================================================
-- Two rules the plan measured and this implements.
--
-- FIRST: the reservation happens BEFORE the provider is contacted, against the counters the
-- product already enforces (`documents.monthly`, `ocr_pages.monthly`), not a new counter beside
-- them. A limiter that runs after the download has already spent the bandwidth, and a new
-- counter beside the old ones is a second answer to "how much has this tenant used".
--
-- SECOND, and this is the subtle one: reserving ONE page and reconciling after extraction would
-- let a large PDF consume OCR that was never available to it. By the time the page count is
-- known the work is done and paid for. So the balance is reserved after the download and BEFORE
-- the OCR, and insufficient capacity refuses or defers at that point rather than afterwards.
--
-- Every reservation is idempotency-keyed on the claim, so a retry does not double-charge and a
-- release cannot refund something a different claim spent.
-- The tenant is read ONCE, from the claim, and the reservation key is built from the claim id.
-- Not a tidiness point: three separate lookups of the same organisation are three chances for a
-- reservation, its limit check and its record to disagree about whose quota was just spent.
create or replace function private.inbound_quota_key(p_claim_id uuid, p_metric text)
returns text
language sql immutable as $$ select 'inbound:' || p_claim_id::text || ':' || p_metric $$;

create or replace function private.inbound_reserve_quota(
  p_claim_id uuid, p_metric text, p_quantity numeric
) returns void
language plpgsql security definer set search_path = private, public, pg_temp as $$
declare
  v_org     uuid;
  v_counter private.usage_counters%rowtype;
begin
  if p_quantity <= 0 then
    raise exception 'inbound_quota_quantity_invalid' using errcode = '22023';
  end if;
  select c.org_id into v_org
    from private.inbound_intake_claims c where c.claim_id = p_claim_id;
  if v_org is null then
    raise exception 'inbound_claim_unknown' using errcode = '23503';
  end if;
  -- Locked read, then the limit, then the record -- in that order, so two concurrent claims for
  -- the same tenant serialise on the counter instead of both passing a stale limit check.
  v_counter := private.usage_counter_locked(v_org, p_metric);
  perform private.assert_usage_within_limit(v_org, p_metric, v_counter.quantity, p_quantity);
  perform private.record_usage_event(v_org, p_metric, p_quantity,
    private.inbound_quota_key(p_claim_id, p_metric), 'inbound_intake');
end
$$;

create or replace function private.inbound_release_quota(p_claim_id uuid, p_metric text)
returns boolean
language plpgsql security definer set search_path = private, public, pg_temp as $$
declare
  v_org uuid;
begin
  select c.org_id into v_org
    from private.inbound_intake_claims c where c.claim_id = p_claim_id;
  if v_org is null then
    return false;
  end if;
  return private.refund_usage_event(v_org, p_metric,
    private.inbound_quota_key(p_claim_id, p_metric));
end
$$;

revoke all on function private.inbound_quota_key(uuid, text) from public, anon, authenticated;
revoke all on function private.inbound_reserve_quota(uuid, text, numeric)
  from public, anon, authenticated;
revoke all on function private.inbound_release_quota(uuid, text) from public, anon, authenticated;
-- Handed to the one caller, for the same reason the ingest command is: `revoke ... from public`
-- takes the default EXECUTE away from service_role too, and a reservation the worker cannot make
-- is an intake channel closed by an omission.
grant execute on function private.inbound_reserve_quota(uuid, text, numeric) to service_role;
grant execute on function private.inbound_release_quota(uuid, text) to service_role;

-- ===================================================================================
-- 10. THE CLAIMER STOPS REQUIRING A HUMAN — by anchored replacement, not redeclaration
-- ===================================================================================
-- `private.claim_document_interpretation_jobs` is last defined in 0246, but redeclaring it from
-- that file's text is how a security property gets silently reverted: production's body is the
-- authority on what is running there, and it is not necessarily 0246's. So the live body is read
-- and the two actor pins are replaced by anchor.
--
-- The `e'\r'` strip is not decoration. A function body is stored as the bytes it was created
-- from, so a migration applied from Windows leaves CRLF in `prosrc` while CI leaves LF; an
-- anchor built with a newline then matches in one and fails in the other. That is exactly how
-- the 0171-0205 rollout aborted at 0181, and check:anchored-replacements exists to refuse a
-- migration that would depend on it.
--
-- Both pins go, and both are replaced by the source-aware rule rather than deleted:
--   * the INNER JOIN to profiles becomes a LEFT JOIN whose requirement now applies only to
--     browser documents. A channel document has no profile to join to, and dropping the join
--     entirely would have removed the active-owner/office requirement from browser uploads too.
--   * `j.requested_by = d.uploaded_by` becomes an equality that only browser rows must satisfy,
--     with channel rows required to carry no actor on either side.
do $claimer_0276$
declare
  v_source text;
  v_patched text;
  v_hits integer;
begin
  select replace(pg_get_functiondef(p.oid), e'\r', '')
    into v_source
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'claim_document_interpretation_jobs';
  if v_source is null then
    raise exception '0276: private.claim_document_interpretation_jobs is not defined';
  end if;

  -- Already patched? A replayed migration -- `supabase db reset` replays every one of them --
  -- must not patch a patched body. Without this, the second run turns `left join` into
  -- `left left join`, because 'join public.profiles p' is still a substring of the patched text
  -- and every uniqueness guard below still reads exactly one hit. Measured, not imagined: that
  -- is what the first replay of this file produced.
  if position('d.source <> ''browser'' and j.requested_by is null' in v_source) > 0 then
    return;
  end if;

  -- `replace` rewrites EVERY occurrence, so each anchor is required to be unique before it is
  -- used. An anchor that matched twice would quietly rewrite a second join this migration never
  -- read.
  select (length(v_source) - length(replace(v_source, 'join public.profiles p', ''))) / length('join public.profiles p')
    into v_hits;
  if v_hits <> 1 then
    raise exception '0276: expected exactly one profiles join in the live claimer, found %', v_hits;
  end if;
  if position('left join public.profiles p' in v_source) > 0 then
    raise exception '0276: the live claimer already left-joins profiles; the anchor is not what this migration read';
  end if;
  select (length(v_source) - length(replace(v_source, 'j.requested_by = d.uploaded_by', ''))) / length('j.requested_by = d.uploaded_by')
    into v_hits;
  if v_hits <> 1 then
    raise exception '0276: expected exactly one requested_by pin in the live claimer, found %', v_hits;
  end if;

  v_patched := replace(v_source,
    'join public.profiles p',
    'left join public.profiles p');
  v_patched := replace(v_patched,
    'and j.requested_by = d.uploaded_by',
    'and ((d.source = ''browser'' and j.requested_by = d.uploaded_by and p.id is not null)'
    || ' or (d.source <> ''browser'' and j.requested_by is null and d.uploaded_by is null))'
    || ' and j.source = d.source');

  if v_patched = v_source then
    raise exception '0276: the claimer patch produced no change';
  end if;
  execute v_patched;
end
$claimer_0276$;

-- ===================================================================================
-- 11. WHAT THE TENANT SEES — a projection, because private is not readable from a browser
-- ===================================================================================
-- `private.inbound_intake_claims` cannot feed DocumentsInbox.tsx: the browser cannot read the
-- private schema at all, so "this arrived by email from ..." is unimplementable without a
-- projection in `public` that carries org_id and an RLS policy over it.
--
-- What crosses: the channel, the provider, a correlation id and a timestamp. What does not
-- cross: any raw provider payload, the inbound address itself (it is a secret -- see #309), and
-- `ProfileName`, which is a person's name and is never stored in the first place.
--
-- These are FUNCTIONS rather than views on purpose. A security_invoker view over a private table
-- runs with the reader's own privileges, and `authenticated` is revoked from that table -- so the
-- view would return an empty set to everyone and look like "no inbound documents" rather than
-- like a missing grant. A definer reader that filters on auth_org() itself is the honest door.
--
-- Both also filter on auth_scopes(). An inbound document's scope is its route's intake unit, and
-- a reader granted only to a sibling legal entity must not learn that the other one received a
-- file -- which is the whole reason intake_unit_id is NOT NULL.
create or replace function public.inbound_provenance_for_org()
returns table (document_id uuid, channel text, provider text, correlation_id uuid,
               received_at timestamptz)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select c.document_id, c.source, c.provider, c.correlation_id, c.created_at
    from private.inbound_intake_claims c
   where c.org_id = public.auth_org()
     and c.state = 'ingested'
     and c.intake_unit_id = any (auth_scopes())
$$;
revoke all on function public.inbound_provenance_for_org() from public, anon;
grant execute on function public.inbound_provenance_for_org() to authenticated;

-- A rejection has NO document, so a projection keyed on documents cannot show it -- and the
-- promise that "the customer gets a readable message" would break in silence for exactly the
-- cases that need it: a file over the size limit, or a type we do not store. This one is keyed
-- on the claim.
create or replace function public.inbound_rejections_for_org()
returns table (claim_id uuid, channel text, provider text, reason_code text,
               byte_size bigint, media_type text, received_at timestamptz,
               rejected_at timestamptz)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select c.claim_id, c.source, c.provider, c.reason_code, c.byte_size, c.media_type,
         c.created_at, c.updated_at
    from private.inbound_intake_claims c
   where c.org_id = public.auth_org()
     and c.state in ('failed', 'abandoned')
     and c.intake_unit_id = any (auth_scopes())
$$;
revoke all on function public.inbound_rejections_for_org() from public, anon;
grant execute on function public.inbound_rejections_for_org() to authenticated;

-- ===================================================================================
-- 12. THE DEFINER LEDGER — one exemption, argued, and two readers that need none
-- ===================================================================================
-- A5 flags a SECURITY DEFINER function whose source names an ENFORCED table, because such a
-- function bypasses the restrictive scope rider by design. Exactly one function here does that:
-- `service_ingest_inbound_document` inserts into `documents`.
--
-- It cannot carry the usual scope marker, and the reason is the thing worth writing down rather
-- than working around: it runs as `service_role` with NO JWT, so `auth_scopes()` would return
-- '{}' and `assert_unit_in_scope` would EARLY-EXIT treating it as trusted service work. A scope
-- check written with either one inside this function would pass without checking anything --
-- which is worse than no check, because it reads like one. The scope is instead derived
-- STRUCTURALLY: `unit_id` comes from the claim's route, the route's identity is a composite
-- foreign key, and the four routing columns are frozen by trigger after insert. That is a
-- stronger guarantee than a predicate the caller could influence, and it is why this row exists
-- rather than a marker.
--
-- The two tenant readers above need no row here: they filter on auth_scopes() and their bodies
-- name no enforced table.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave) values
  ('service_ingest_inbound_document(uuid,uuid,uuid,text)',
   'Runs as service_role with no JWT, so auth_scopes() is empty and assert_unit_in_scope '
   || 'early-exits as trusted service work -- a scope predicate here would pass without '
   || 'checking. Scope is derived structurally instead: unit_id comes from the claim route, '
   || 'whose identity is a composite FK and whose routing columns are frozen after insert.',
   'inbound intake machine actor')
on conflict (function_signature) do nothing;

-- ===================================================================================
-- 12b. THE TENANT EXPORT REGISTRY — three shapes changed, so three hashes are recomputed
-- ===================================================================================
-- A6 pins each exported table's shape as a hash so a new column cannot quietly escape a tenant
-- export. Three shapes moved here: `source` on all three tables, and `requested_by` becoming
-- nullable on the two work tables -- the hash covers nullability too, which is how the guard
-- noticed the second change and not just the first.
--
-- `source` is INCLUDED in the export rather than excluded, and that is a decision rather than a
-- default. A tenant taking their data is entitled to know which of their documents a person
-- uploaded and which arrived from a channel; withholding it would hand them a file they cannot
-- account for.
--
-- The hash is DERIVED here, never typed (the 0137/0149/0264 pattern). A hand-written hash is a
-- hash that drifts the moment anyone adds a column.
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name in ('documents', 'document_processing_jobs', 'document_scan_jobs');

-- ===================================================================================
-- 13. VERIFY — the assertions this migration is willing to be judged on
-- ===================================================================================
do $verify_0276$
declare
  v_violations text;
  v_bad bigint;
begin
  -- The contract exists on all three tables.
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and column_name = 'source'
         and table_name in ('documents', 'document_processing_jobs', 'document_scan_jobs')) <> 3 then
    raise exception '0276: source is missing from one of the three tables';
  end if;

  -- The actor rule is bidirectional on all three.
  if (select count(*) from pg_constraint
       where conname in ('documents_actor_matches_source',
                         'document_processing_jobs_actor_matches_source',
                         'document_scan_jobs_actor_matches_source')) <> 3 then
    raise exception '0276: an actor/source CHECK is missing';
  end if;

  -- The job cannot disagree with its document about where it came from.
  if (select count(*) from pg_constraint
       where conname in ('document_processing_jobs_document_source_fk',
                         'document_scan_jobs_document_source_fk')) <> 2 then
    raise exception '0276: a job/document source FK is missing';
  end if;

  -- Neither work table still demands a human.
  select count(*) into v_bad from information_schema.columns
   where table_schema = 'public' and column_name = 'requested_by' and is_nullable = 'NO'
     and table_name in ('document_processing_jobs', 'document_scan_jobs');
  if v_bad > 0 then
    raise exception '0276: requested_by is still NOT NULL on % work table(s)', v_bad;
  end if;

  -- A work row cannot be created with a source its document does not have.
  if (select count(*) from pg_catalog.pg_trigger
       where tgname in ('document_processing_jobs_inherit_source',
                        'document_scan_jobs_inherit_source')
         and not tgisinternal) <> 2 then
    raise exception '0276: a work row can be written with a source of its writer''s choosing';
  end if;
  -- And the packet split hands its children the parent's source rather than the default.
  if position('v_parent.document_date,v_parent.unit_id,v_parent.source' in
              replace(pg_get_functiondef(to_regprocedure(
                'public.service_materialize_document_packet(uuid, text, uuid)')), e'\r', '')) = 0 then
    raise exception '0276: a packet split still gives its children the default source';
  end if;

  -- The quota pair is reachable by the worker that has to call it, and by nobody else.
  if not has_function_privilege('service_role',
        'private.inbound_reserve_quota(uuid,text,numeric)', 'execute')
     or not has_function_privilege('service_role',
        'private.inbound_release_quota(uuid,text)', 'execute') then
    raise exception '0276: the intake worker cannot reserve or release quota';
  end if;
  if has_function_privilege('authenticated',
        'private.inbound_reserve_quota(uuid,text,numeric)', 'execute') then
    raise exception '0276: a browser role can reserve intake quota';
  end if;

  -- The claimer no longer drops a document that has no uploader.
  if (select position('d.source <> ''browser'' and j.requested_by is null' in
                      replace(pg_get_functiondef(to_regprocedure(
                        'private.claim_document_interpretation_jobs(integer, integer)')), e'\r', ''))) = 0 then
    raise exception '0276: the interpretation claimer still requires a human actor';
  end if;

  -- Both channels start closed, and no role can open them from the product.
  if (select count(*) from private.inbound_channel_boundary where enabled) > 0 then
    raise exception '0276: an intake channel is enabled at migration time';
  end if;
  if has_table_privilege('service_role', 'private.inbound_channel_boundary', 'UPDATE')
     or has_table_privilege('authenticated', 'private.inbound_channel_boundary', 'UPDATE') then
    raise exception '0276: a product role can write the platform intake boundary';
  end if;

  -- The one caller can reach it and the browser cannot. Asserted with has_function_privilege
  -- rather than by attempting the call: reading as the wrong role and catching
  -- insufficient_privilege is the pattern that has crashed this backend before.
  if not has_function_privilege('service_role',
        'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute') then
    raise exception '0276: service_role cannot execute the ingest command it is the only caller of';
  end if;
  if has_function_privilege('authenticated',
        'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute')
     or has_function_privilege('anon',
        'public.service_ingest_inbound_document(uuid,uuid,uuid,text)', 'execute') then
    raise exception '0276: a browser role can execute the ingest command';
  end if;

  -- The RPC does not accept a tenant from its caller.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'service_ingest_inbound_document'
         and pg_get_function_identity_arguments(p.oid) = 'p_claim_id uuid, p_lease_token uuid, p_object_id uuid, p_object_version text') <> 1 then
    raise exception '0276: the ingest RPC does not have the four-argument signature';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0276 scope assertions failed: %', v_violations;
  end if;
end
$verify_0276$;
