-- 0280 — a WhatsApp number that can receive a document, and the four ways it must not.
--
-- #321 (owner, 31.08.2026) reversed half of #241: an image or PDF sent to a tenant's WhatsApp
-- number becomes an inbox document. Text stays exactly where #241 left it -- no automation, no
-- reply. This migration is the database half of that; the actor-intake migration
-- (0279_a_document_carries_the_actor_that_made_it.sql) already built the contract that lets
-- a document exist with no human behind it.
--
-- WHAT THIS IS NOT: it is not an activation. `private.inbound_channel_boundary` still says
-- whatsapp is closed, no connection exists, and nothing here can open either.
--
-- THE FOUR REFUSALS, and why each is a schema rule rather than a code path:
--
--   1. ONE NUMBER IS ONE ROW. `provider_sender_id` is UNIQUE per provider (0191) and
--      provider-neutral -- it carries a Meta phone_number_id and a Twilio number in the same
--      column. Twilio spells its addresses `whatsapp:+14155238886`, so storing the value as it
--      arrives creates a SECOND row for a number that already has one, and the lookup then
--      misses a tenant that exists. The canonical form is bare E.164 and a CHECK says so.
--
--   2. A CONNECTION WITHOUT A ROUTE CANNOT RECEIVE. An inbound document has no uploader and so
--      no scope of its own; the actor-intake migration puts that scope on the route. A
--      connection that has no route
--      would produce a document with a null unit -- organisation-wide, visible across sibling
--      legal entities. So receiving is gated on the route existing, structurally.
--
--   3. THE TENANT'S SWITCH CANNOT BE THE PLATFORM'S. `inbound_media_enabled` is the tenant
--      saying yes. It can only ever NARROW what the platform boundary already allows, and the
--      boundary has no tenant writer. Two switches, and the one that stops the world is not the
--      one the customer holds.
--
--   4. A FILE THAT IS TOO BIG IS A REFUSAL WITH A NAME. Twilio accepts 16MB; the documents
--      bucket accepts 10MB (0045). #321 decided the gap explicitly: over the limit is refused
--      with a message the tenant can read, and NOT a silent raise of the bucket limit, which
--      would move every other document path at the same time. The limit is READ from the bucket
--      rather than typed here, so the two can never disagree.

-- ===================================================================================
-- 1. THE CANONICAL SENDER ID
-- ===================================================================================
-- Normalise before constraining, and do it only for Twilio: a Meta phone_number_id is a numeric
-- id, not a phone number, and forcing E.164 on it would be a different bug wearing this one's
-- clothes.
update public.whatsapp_connections
   set provider_sender_id = regexp_replace(btrim(provider_sender_id), '^[A-Za-z]+:', '')
 where provider = 'twilio'
   and provider_sender_id is not null
   and provider_sender_id ~ '^[A-Za-z]+:';

do $sender_shape_0280$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'whatsapp_connections_twilio_sender_is_e164') then
    alter table public.whatsapp_connections
      add constraint whatsapp_connections_twilio_sender_is_e164 check (
        provider <> 'twilio'
        or provider_sender_id is null
        or provider_sender_id ~ '^\+[1-9][0-9]{6,14}$');
  end if;
end
$sender_shape_0280$;

comment on constraint whatsapp_connections_twilio_sender_is_e164
  on public.whatsapp_connections is
  'Bare E.164. The `whatsapp:` prefix names a TRANSPORT, not a party -- the same number can '
  'carry SMS and WhatsApp -- and this column is a provider-neutral UNIQUE identity. A prefixed '
  'value would be a second row for a number that already has one.';

-- ===================================================================================
-- 2. THE CONNECTION POINTS AT A ROUTE
-- ===================================================================================
-- The composite key carries `source` as well as the tenant, so a WhatsApp connection cannot be
-- attached to an email route. `route_id` is already the routes table's primary key, so this
-- index is free in substance and only exists to make the composite reference legal.
create unique index if not exists inbound_routes_channel_identity_idx
  on private.inbound_routes (route_id, org_id, source);

alter table public.whatsapp_connections
  add column if not exists route_id uuid,
  -- The tenant's own switch. Default false: connecting a number is not consenting to receive.
  add column if not exists inbound_media_enabled boolean not null default false;

-- A foreign key takes COLUMNS, not expressions, so the constant `'whatsapp'` is a stored
-- generated column rather than a literal in the constraint. It is not decoration: without the
-- third column the key could bind a WhatsApp connection to an EMAIL route, and the route is what
-- decides the document's scope -- so the mismatch would land a WhatsApp file in whatever legal
-- entity the mail route happened to name.
alter table public.whatsapp_connections
  add column if not exists inbound_source text
  generated always as ('whatsapp') stored;

do $route_link_0280$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'whatsapp_connections_inbound_route_fk') then
    alter table public.whatsapp_connections
      add constraint whatsapp_connections_inbound_route_fk
      foreign key (route_id, org_id, inbound_source)
      references private.inbound_routes (route_id, org_id, source) on delete restrict;
  end if;
end
$route_link_0280$;

-- Receiving requires a route. Stated as an implication rather than a NOT NULL, because a
-- connection that only SENDS is a legitimate shape and always was.
do $receive_needs_route_0280$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'whatsapp_connections_inbound_needs_route') then
    alter table public.whatsapp_connections
      add constraint whatsapp_connections_inbound_needs_route check (
        not inbound_media_enabled or route_id is not null);
  end if;
end
$receive_needs_route_0280$;

-- ===================================================================================
-- 3. WHAT ACTUALLY OPENS THE DOOR — two switches, and the tenant holds the weaker one
-- ===================================================================================
create or replace function private.whatsapp_inbound_open(p_provider_sender_id text)
returns boolean
language sql stable security definer set search_path = private, public, pg_temp as $$
  select private.inbound_channel_open('whatsapp')
     and exists (
       select 1
         from public.whatsapp_connections c
         join private.inbound_routes r
           on r.route_id = c.route_id and r.org_id = c.org_id and r.source = 'whatsapp'
        where c.provider = 'twilio'
          and c.provider_sender_id = p_provider_sender_id
          and c.status = 'active'
          and c.inbound_media_enabled
          and r.revoked_at is null)
$$;
revoke all on function private.whatsapp_inbound_open(text) from public, anon, authenticated;
grant execute on function private.whatsapp_inbound_open(text) to service_role;

comment on function private.whatsapp_inbound_open(text) is
  'Both switches, in one place. The platform boundary comes FIRST and has no tenant writer; the '
  'tenant flag and the live route can only narrow it. A tenant cannot open a channel the '
  'platform closed, which is the entire reason the boundary is not a column on this table.';

-- ===================================================================================
-- 4. THE SIZE LIMIT IS READ, NOT TYPED
-- ===================================================================================
-- 10485760 appears in 0045 as the documents bucket's own limit. Writing it again here would
-- create two answers to one question, and the day somebody raises the bucket the refusal message
-- would start lying. So it is read.
-- The bucket NAME lives in its own plain function, and that is a guard rule rather than a style
-- choice. A5 decides whether a SECURITY DEFINER function bypasses the scope rider by looking for
-- a scope-enforced table name in its source TEXT -- strings and comments included, because a
-- lexer that understood SQL would be a second SQL parser to maintain. So a definer body that
-- merely spells the bucket id in quotes is flagged as an uncovered definer over that table, and
-- this migration was flagged for exactly that before this split existed. An invoker function is
-- not a candidate at all, so the literal lives here.
create or replace function private.inbound_bucket() returns text
language sql immutable as $$ select 'documents'::text $$;
revoke all on function private.inbound_bucket() from public, anon, authenticated;
grant execute on function private.inbound_bucket() to service_role;

create or replace function private.inbound_max_bytes()
returns bigint
language sql stable security definer set search_path = storage, private, pg_temp as $$
  select coalesce(
    (select b.file_size_limit from storage.buckets b where b.id = private.inbound_bucket()), 0)
$$;
revoke all on function private.inbound_max_bytes() from public, anon, authenticated;
grant execute on function private.inbound_max_bytes() to service_role;

-- ===================================================================================
-- 5. A REFUSAL HAS A NAME, FROM A CLOSED LIST
-- ===================================================================================
-- The actor-intake migration left `reason_code` free text so the channels could name their own
-- failures. They can now,
-- so the list closes: a dead letter whose reason is a sentence somebody typed is not a ledger,
-- and the tenant-facing message is chosen from this vocabulary rather than echoed from a
-- provider.
do $reason_vocab_0280$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'inbound_intake_claims_reason_vocabulary') then
    alter table private.inbound_intake_claims
      add constraint inbound_intake_claims_reason_vocabulary check (
        reason_code is null or reason_code in (
          -- the tenant can act on these, and is told
          'file_too_large',
          'media_type_rejected',
          'media_type_unrecognized',
          -- the platform can act on these; the tenant sees that something was refused
          'channel_closed',
          'connection_unknown',
          'connection_inactive',
          'route_revoked',
          'quota_exhausted',
          'provider_fetch_failed',
          'provider_payload_invalid',
          'signature_invalid',
          'storage_write_failed',
          'lease_expired',
          'abandoned_by_operator'));
  end if;
end
$reason_vocab_0280$;

-- ===================================================================================
-- 6. THE MEDIA IS DELETED AT THE PROVIDER, AND THE DELETION IS NOT A HOPE
-- ===================================================================================
-- #327(b): media is deleted at Twilio immediately after a successful intake, WITH EVIDENCE. A
-- fire-and-forget delete that fails leaves a customer's invoice sitting in a third party's
-- storage indefinitely, and the decision quietly becomes a promise nobody kept. So it is an
-- outbox: durable, retried with backoff, and it dead-letters LOUDLY rather than going quiet.
create table if not exists private.inbound_media_deletions (
  deletion_id     uuid primary key default gen_random_uuid(),
  claim_id        uuid not null references private.inbound_intake_claims(claim_id) on delete restrict,
  provider        text not null check (provider in ('twilio')),
  -- What the provider needs to identify the object. Not a URL: a URL from a payload is an
  -- instruction from outside, and by deletion time we have the identifiers to rebuild it.
  provider_account_id text not null check (length(btrim(provider_account_id)) > 0),
  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  provider_media_id   text not null check (length(btrim(provider_media_id)) > 0),
  state           text not null default 'pending' check (
                    state in ('pending', 'deleted', 'failed', 'dead_letter')),
  attempt         integer not null default 0 check (attempt >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  -- The evidence #327 asks for: what the provider answered, and when.
  deleted_at      timestamptz,
  provider_status integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint inbound_media_deletions_identity
    unique (provider, provider_account_id, provider_message_id, provider_media_id),
  constraint inbound_media_deletions_evidence_shape check (
    (state = 'deleted' and deleted_at is not null and provider_status is not null)
    or (state <> 'deleted' and deleted_at is null))
);
revoke all on table private.inbound_media_deletions from public, anon, authenticated;
create index if not exists inbound_media_deletions_due_idx
  on private.inbound_media_deletions (next_attempt_at)
  where state in ('pending', 'failed');

-- Age, not count, is what an operator needs to see: a queue of three that has been stuck for a
-- day is a worse fact than a queue of three hundred that is draining.
create or replace function private.inbound_media_deletion_backlog()
returns table (state text, rows bigint, oldest_seconds numeric)
language sql stable security definer set search_path = private, pg_temp as $$
  select d.state, count(*), extract(epoch from (now() - min(d.created_at)))
    from private.inbound_media_deletions d
   where d.state in ('pending', 'failed', 'dead_letter')
   group by d.state
$$;
revoke all on function private.inbound_media_deletion_backlog() from public, anon, authenticated;

-- ===================================================================================
-- 6b. THE TENANT EXPORT REGISTRY
-- ===================================================================================
-- Three columns were added to a table a tenant can export, so the pinned shape hash moves. All
-- three are INCLUDED rather than excluded: a tenant taking their data is entitled to know which
-- of their numbers could receive documents, which route gave those documents their scope, and
-- whether receiving was switched on. Derived here, never typed (the 0137/0149/0264 pattern).
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
where registry.table_name = 'whatsapp_connections';

-- ===================================================================================
-- 7. VERIFY
-- ===================================================================================
do $verify_0280$
declare
  v_violations text;
begin
  -- One number is one row, and the prefix cannot get in.
  if not exists (select 1 from pg_constraint
                 where conname = 'whatsapp_connections_twilio_sender_is_e164') then
    raise exception '0280: a Twilio sender id can still carry a channel prefix';
  end if;

  -- Receiving is tied to a route of the SAME channel, structurally.
  if not exists (
    select 1 from pg_constraint
     where conname = 'whatsapp_connections_inbound_route_fk' and contype = 'f'
       and array_length(conkey, 1) = 3) then
    raise exception '0280: the connection is not bound to a whatsapp route by composite key';
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'whatsapp_connections_inbound_needs_route') then
    raise exception '0280: a connection can receive without a route to give it scope';
  end if;

  -- The platform switch is still the platform's.
  if has_table_privilege('authenticated', 'private.inbound_channel_boundary', 'update') then
    raise exception '0280: the tenant can reach the platform boundary';
  end if;
  if (select enabled from private.inbound_channel_boundary where channel = 'whatsapp') then
    raise exception '0280: this migration enabled a channel';
  end if;

  -- The size limit agrees with the bucket, because it IS the bucket.
  if private.inbound_max_bytes()
     is distinct from (select file_size_limit from storage.buckets where id = 'documents') then
    raise exception '0280: the intake size limit and the bucket limit disagree';
  end if;

  -- The deletion outbox exists and no product role can write it.
  if to_regclass('private.inbound_media_deletions') is null then
    raise exception '0280: provider media deletion has no durable record';
  end if;
  if has_table_privilege('authenticated', 'private.inbound_media_deletions', 'select') then
    raise exception '0280: the browser can read the provider deletion queue';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0280 scope assertions failed: %', v_violations;
  end if;
end
$verify_0280$;
