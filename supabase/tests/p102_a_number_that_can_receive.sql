-- P102 — a WhatsApp number that can receive a document, and the four ways it must not.
--
-- #321 opened media intake on WhatsApp. The number that receives it is the same row that already
-- SENDS orders, so every rule here is about a door being opened on a table that already had a
-- job, without widening anything else it does.
--
-- WHAT THIS PINS:
--
--   1. ONE NUMBER IS ONE ROW. `provider_sender_id` is provider-neutral and UNIQUE. Twilio spells
--      its addresses `whatsapp:+1...`, so a stored prefix would be a SECOND row for a number
--      that already has one -- and the lookup would then miss a tenant that exists rather than
--      fail loudly. A CHECK refuses the prefixed form, and this suite proves the two spellings
--      cannot both be stored.
--
--   2. RECEIVING WITHOUT A ROUTE IS REFUSED. An inbound document has no uploader and therefore
--      no scope of its own; the route carries it. A connection that could receive without one
--      would produce organisation-wide documents -- visible across sibling legal entities.
--
--   3. THE TENANT'S SWITCH CANNOT BE THE PLATFORM'S. Two switches, and the customer holds only
--      the one that can narrow. Proven by turning the tenant's on while the platform's is off
--      and requiring the door to stay shut.
--
--   4. A CHANNEL CANNOT BORROW ANOTHER CHANNEL'S ROUTE. The composite key carries the source, so
--      a WhatsApp connection cannot point at an email route and inherit whatever legal entity
--      that route names.
--
-- Plus: the size limit is the bucket's own, not a copy of it; and the provider-side deletion
-- #327(b) promises is a durable row rather than a hope.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p102_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P102 whatsapp intake assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p102_refusal(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACCEPTED';
exception when others then
  return sqlstate || ':' || sqlerrm;
end
$$;

-- ---- fixture -----------------------------------------------------------------------------
-- TWO organisations, because `whatsapp_connections` is keyed on org_id: one connection per
-- tenant. The duplicate-number assertion therefore needs a second tenant to try it from --
-- inserting a second row into the SAME org fails on the primary key first and would prove
-- nothing about the shape rule under test.
insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a1020000-0000-4000-8000-000000000001', 'P102 org', 'active', 18, 'ILS', 'IL'),
  ('a1020000-0000-4000-8000-000000000002', 'P102 second org', 'active', 18, 'ILS', 'IL');

-- The auth token lives in the vault, and the column is NOT NULL with a foreign key into it, so
-- the fixture creates real secrets rather than pretending the reference is optional.
create temporary table p102_secrets as
select vault.create_secret('p102-twilio-auth-token-0123456789abcdef', 'p102-a', 'P102') as a,
       vault.create_secret('p102-twilio-auth-token-fedcba9876543210', 'p102-b', 'P102') as b,
       vault.create_secret('p102-meta-token-0123456789abcdef0123', 'p102-c', 'P102') as c;

create temporary table p102_root as
  select org_id, id as root_id from public.org_units
   where unit_type = 'root' and org_id = 'a1020000-0000-4000-8000-000000000001';

insert into public.org_units(id, org_id, parent_id, unit_type, name)
select 'e1020000-0000-4000-8000-000000000001'::uuid, org_id, root_id,
       'legal_entity'::org_unit_type, 'P102 entity A' from p102_root
union all
select 'e1020000-0000-4000-8000-000000000002'::uuid, org_id, root_id,
       'legal_entity'::org_unit_type, 'P102 entity B' from p102_root;

insert into auth.users (id, email) values
  ('b1020000-0000-4000-8000-000000000001', 'p102-owner@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b1020000-0000-4000-8000-000000000001', 'a1020000-0000-4000-8000-000000000001',
   'P102 owner', 'owner', true);

-- One route per channel, both for the same tenant. The email route exists only so assertion 4
-- has something wrong to try to borrow.
insert into private.inbound_routes(route_id, org_id, intake_unit_id, source, created_by) values
  ('c1020000-0000-4000-8000-000000000001', 'a1020000-0000-4000-8000-000000000001',
   'e1020000-0000-4000-8000-000000000001', 'whatsapp', 'b1020000-0000-4000-8000-000000000001'),
  ('c1020000-0000-4000-8000-000000000002', 'a1020000-0000-4000-8000-000000000001',
   'e1020000-0000-4000-8000-000000000002', 'email', 'b1020000-0000-4000-8000-000000000001');

-- ---- 1. ONE NUMBER IS ONE ROW ----------------------------------------------------------------
insert into public.whatsapp_connections
  (org_id, provider, provider_account_id, provider_sender_id, display_phone_number,
   token_secret_id, order_template_name, reminder_template_name, status)
select 'a1020000-0000-4000-8000-000000000001', 'twilio',
       'AC00000000000000000000000000000001', '+14155238886', '+1 415 523 8886',
       a, 'p102_order', 'p102_reminder', 'active' from p102_secrets;

-- The prefixed spelling of the SAME number is refused by shape, before it can become a second
-- row. Without the CHECK this insert succeeds -- the unique index sees two different strings --
-- and every later lookup by the canonical form silently misses this tenant.
select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    insert into public.whatsapp_connections
      (org_id, provider, provider_account_id, provider_sender_id, display_phone_number,
       token_secret_id, order_template_name, reminder_template_name, status)
    select 'a1020000-0000-4000-8000-000000000002', 'twilio',
           'AC00000000000000000000000000000001', 'whatsapp:+14155238886', '+1 415 523 8886',
           b, 'p102_order', 'p102_reminder', 'active' from p102_secrets
  $$) like '23514:%',
  'the prefixed spelling of a number that already exists was stored as a second row');

-- And the same refusal for a number that is not a number at all.
select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    insert into public.whatsapp_connections
      (org_id, provider, provider_account_id, provider_sender_id, display_phone_number,
       token_secret_id, order_template_name, reminder_template_name, status)
    select 'a1020000-0000-4000-8000-000000000002', 'twilio',
           'AC00000000000000000000000000000001', '4155238886', '+1 415 523 8886',
           b, 'p102_order', 'p102_reminder', 'active' from p102_secrets
  $$) like '23514:%',
  'a sender id with no country code was accepted');

-- A Meta connection is NOT held to E.164: its sender id is a numeric phone_number_id, and
-- forcing a phone-number shape on it would be a different bug wearing this one's clothes.
select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    insert into public.whatsapp_connections
      (org_id, provider, provider_account_id, provider_sender_id, phone_number_id, waba_id,
       display_phone_number, token_secret_id, order_template_name, reminder_template_name, status)
    select 'a1020000-0000-4000-8000-000000000002', 'meta_cloud',
           '109876543210', '109876543210', '109876543210', '109876543210',
           '+1 555 000 0000', c, 'p102_order', 'p102_reminder', 'active' from p102_secrets
  $$) = 'ACCEPTED',
  'the Twilio shape rule was applied to a meta_cloud connection, which uses an id not a number');
delete from public.whatsapp_connections where org_id = 'a1020000-0000-4000-8000-000000000002';

-- ---- 2. RECEIVING WITHOUT A ROUTE IS REFUSED -------------------------------------------------
select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    update public.whatsapp_connections set inbound_media_enabled = true
     where provider = 'twilio' and provider_sender_id = '+14155238886'
  $$) like '23514:%',
  'a connection with no route was allowed to receive, which would make its documents org-wide');

-- ---- 4. A CHANNEL CANNOT BORROW ANOTHER CHANNEL'S ROUTE --------------------------------------
-- Asserted BEFORE the happy path, so the happy path cannot be what made it pass.
select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    update public.whatsapp_connections
       set route_id = 'c1020000-0000-4000-8000-000000000002'
     where provider = 'twilio' and provider_sender_id = '+14155238886'
  $$) like '23503:%',
  'a whatsapp connection was pointed at an email route and would inherit its legal entity');

-- The correct route, and only now can receiving be switched on.
update public.whatsapp_connections
   set route_id = 'c1020000-0000-4000-8000-000000000001', inbound_media_enabled = true
 where provider = 'twilio' and provider_sender_id = '+14155238886';
select pg_temp.p102_assert(
  (select inbound_media_enabled and route_id = 'c1020000-0000-4000-8000-000000000001'
     from public.whatsapp_connections
    where provider = 'twilio' and provider_sender_id = '+14155238886'),
  'a connection with a matching route could not be switched on');

-- ---- 3. THE TENANT'S SWITCH CANNOT BE THE PLATFORM'S -----------------------------------------
-- Everything the tenant controls now says yes: active connection, live route, flag on. The
-- platform boundary says no, and it is the one that decides.
select pg_temp.p102_assert(
  not private.whatsapp_inbound_open('+14155238886'),
  'the tenant opened a channel the platform had closed');

update private.inbound_channel_boundary
   set enabled = true, enabled_at = now(),
       enabled_by = 'b1020000-0000-4000-8000-000000000001', enable_reason = 'P102 fixture'
 where channel = 'whatsapp';
select pg_temp.p102_assert(
  private.whatsapp_inbound_open('+14155238886'),
  'with both switches on, the door is still shut');

-- Each tenant-side condition on its own is enough to close it again. Asserted one at a time,
-- because a door that only closes when everything is wrong is a door that closes by accident.
update public.whatsapp_connections set status = 'disabled'
 where provider = 'twilio' and provider_sender_id = '+14155238886';
select pg_temp.p102_assert(
  not private.whatsapp_inbound_open('+14155238886'),
  'a disabled connection still received');
update public.whatsapp_connections set status = 'active'
 where provider = 'twilio' and provider_sender_id = '+14155238886';

update private.inbound_routes set revoked_at = now()
 where route_id = 'c1020000-0000-4000-8000-000000000001';
select pg_temp.p102_assert(
  not private.whatsapp_inbound_open('+14155238886'),
  'a revoked route still received');
update private.inbound_routes set revoked_at = null
 where route_id = 'c1020000-0000-4000-8000-000000000001';

update public.whatsapp_connections set inbound_media_enabled = false
 where provider = 'twilio' and provider_sender_id = '+14155238886';
select pg_temp.p102_assert(
  not private.whatsapp_inbound_open('+14155238886'),
  'a connection with receiving switched off still received');
update public.whatsapp_connections set inbound_media_enabled = true
 where provider = 'twilio' and provider_sender_id = '+14155238886';

-- An unknown number is not an error and not an opening -- it is simply closed.
select pg_temp.p102_assert(
  not private.whatsapp_inbound_open('+972500000099'),
  'a number nobody registered was treated as open');

-- ---- 5. THE SIZE LIMIT IS THE BUCKET'S OWN ---------------------------------------------------
-- #321 refused the silent alternative: raising the bucket to Twilio's 16MB would move every
-- other document path at the same time. So the intake limit is READ from the bucket, and a copy
-- of the number cannot drift from it.
select pg_temp.p102_assert(
  private.inbound_max_bytes()
    = (select file_size_limit from storage.buckets where id = 'documents'),
  'the intake size limit is a copy of the bucket limit rather than the bucket limit');
select pg_temp.p102_assert(
  private.inbound_max_bytes() > 0,
  'the intake size limit reads as zero, which would refuse every file');

-- ---- 6. A REFUSAL HAS A NAME FROM A CLOSED LIST ----------------------------------------------
insert into private.inbound_intake_claims
  (claim_id, route_id, org_id, intake_unit_id, source, provider, provider_message_id,
   attachment_id, state, lease_until, reason_code)
values ('51020000-0000-4000-8000-000000000001', 'c1020000-0000-4000-8000-000000000001',
        'a1020000-0000-4000-8000-000000000001', 'e1020000-0000-4000-8000-000000000001',
        'whatsapp', 'twilio', 'SM102', 'ME102', 'failed', now(), 'file_too_large');

select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    update private.inbound_intake_claims
       set reason_code = 'the file the customer sent was a bit large'
     where claim_id = '51020000-0000-4000-8000-000000000001'
  $$) like '23514:%',
  'a dead letter could carry a sentence somebody typed instead of a reason from the list');

-- ---- 7. THE PROVIDER-SIDE DELETION IS A ROW, NOT A HOPE --------------------------------------
-- #327(b) says the media is deleted at Twilio with evidence. A delete that is fired and
-- forgotten leaves a customer's invoice in a third party's storage indefinitely and nobody
-- learns of it, so it is queued, retried, and cannot claim success without proof.
insert into private.inbound_media_deletions
  (claim_id, provider, provider_account_id, provider_message_id, provider_media_id)
values ('51020000-0000-4000-8000-000000000001', 'twilio',
        'AC00000000000000000000000000000001', 'SM102', 'ME102');

select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    insert into private.inbound_media_deletions
      (claim_id, provider, provider_account_id, provider_message_id, provider_media_id)
    values ('51020000-0000-4000-8000-000000000001', 'twilio',
            'AC00000000000000000000000000000001', 'SM102', 'ME102')
  $$) like '23505:%',
  'the same media could be queued for deletion twice');

select pg_temp.p102_assert(
  pg_temp.p102_refusal($$
    update private.inbound_media_deletions
       set state = 'deleted', deleted_at = null, provider_status = null
     where provider_media_id = 'ME102'
  $$) like '23514:%',
  'a deletion could be marked done without the evidence #327 asks for');

update private.inbound_media_deletions
   set state = 'deleted', deleted_at = now(), provider_status = 204
 where provider_media_id = 'ME102';
select pg_temp.p102_assert(
  (select state = 'deleted' and deleted_at is not null and provider_status = 204
     from private.inbound_media_deletions where provider_media_id = 'ME102'),
  'a deletion with evidence could not be recorded');

-- The operator surface reports AGE, not just depth: a queue of three stuck for a day is a worse
-- fact than a queue of three hundred that is draining, and a count alone cannot say which.
insert into private.inbound_media_deletions
  (claim_id, provider, provider_account_id, provider_message_id, provider_media_id, created_at)
values ('51020000-0000-4000-8000-000000000001', 'twilio',
        'AC00000000000000000000000000000001', 'SM102', 'ME103', now() - interval '2 days');
select pg_temp.p102_assert(
  (select oldest_seconds > 86400 from private.inbound_media_deletion_backlog()
    where state = 'pending'),
  'the deletion backlog does not report how long the oldest item has been waiting');

-- ---- 8. NONE OF THIS IS REACHABLE FROM A BROWSER ---------------------------------------------
select pg_temp.p102_assert(
  not has_table_privilege('authenticated', 'private.inbound_media_deletions', 'select')
  and not has_function_privilege('authenticated', 'private.whatsapp_inbound_open(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.inbound_max_bytes()', 'execute'),
  'a browser role can read the deletion queue or ask whether a channel is open');
select pg_temp.p102_assert(
  has_function_privilege('service_role', 'private.whatsapp_inbound_open(text)', 'execute')
  and has_function_privilege('service_role', 'private.inbound_max_bytes()', 'execute'),
  'the intake worker cannot ask the two questions it must ask before fetching anything');

rollback;

select 'P102_a_number_that_can_receive_passed' as result;
