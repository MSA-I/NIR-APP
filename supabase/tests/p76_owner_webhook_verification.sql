-- P76 owner-webhook verification harness for 0198. Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves, mapped to the identity threat model §4:
--   (a) structure: the two verification columns, the named activation CHECK, the named trigger,
--       the private attempt ledger's ACL, and the grant matrix of the five new commands, all by
--       NAME -- never by counting objects, because this database also carries another
--       program's uncommitted work and 21 extension-provided functions;
--   D1  the attack corpus: one row per hostile URL encoding through private.webhook_url_rejection;
--   D4  scheme, credentials and port, in the same corpus;
--   D5  activation is unreachable without a completed handshake -- proven twice: as a CHECK
--       violation on a direct UPDATE (a row property, not command ordering) and as the named
--       command error;
--   D6  registration, verification request and activation each require owner + step-up + a
--       reason and leave an audit row and a security_events row;
--   D7  the owner reader never returns secret_id or any vault reference;
--   D8  the owner reader carries no raw error text -- last success, counts, nothing else;
--   D9  the delivery contract is preserved: the #97 known-answer vector still holds, a verified
--       ACTIVE subscription still enqueues on a domain event, and the claim still returns a
--       url/body/timestamp/signature that verifies against the subscription's Vault secret;
--   FENCE  the 0103 offboarding egress fence still holds for a NAMED fixture subscription: an
--       organization with an open offboarding request yields no claimable row, and
--       claim_integration_outbox still calls organization_write_allowed_fenced;
--   D10 the mutation proof: private.webhook_url_rejection is replaced by a permissive stub
--       inside a savepoint and the corpus assertion is observed to turn red, then rolled back.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p76_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P76 owner webhook assertion failed: %', p_message;
  end if;
end
$$;

-- The p7/p4 JWT-claims idiom: NULL offset = no amr at all (no step-up proof);
-- interval '0' = a password proof taken this instant.
create function pg_temp.p76_claims(p_sub uuid, p_offset interval default null)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claim.role', '', true);
  if p_offset is null then
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub::text)::text, true);
  else
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_sub::text,
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from clock_timestamp() + p_offset)::bigint))
    )::text, true);
  end if;
end
$$;

create function pg_temp.p76_clear_claims()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ===== (a) structural proofs -- named objects only, never a census =====

select pg_temp.p76_assert(
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'webhook_subscriptions'
     and column_name in ('verified_at', 'verified_url')) = 2,
  'webhook_subscriptions must carry verified_at and verified_url');

select pg_temp.p76_assert(
  exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.webhook_subscriptions'::regclass
      and c.conname = 'webhook_subscriptions_active_requires_verification'
      and c.contype = 'c'),
  'the named activation CHECK must exist on webhook_subscriptions');

select pg_temp.p76_assert(
  exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.webhook_subscriptions'::regclass
      and tg.tgname = 'webhook_subscriptions_clear_verification'
      and not tg.tgisinternal),
  'the url-change verification reset trigger must exist');

-- The attempt ledger holds the challenge digest: no browser role may reach it, ever.
select pg_temp.p76_assert(
  not has_table_privilege('anon', 'private.webhook_verification_attempts', 'SELECT')
    and not has_table_privilege('authenticated', 'private.webhook_verification_attempts', 'SELECT')
    and not has_table_privilege('authenticated', 'private.webhook_verification_attempts', 'INSERT'),
  'private.webhook_verification_attempts must be unreachable from browser roles');

select pg_temp.p76_assert(
  has_function_privilege('authenticated',
    'public.register_webhook_subscription(text,text[],text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.register_webhook_subscription(text,text[],text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.request_webhook_verification(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.request_webhook_verification(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.service_begin_webhook_verification(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.service_begin_webhook_verification(uuid)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.service_complete_webhook_verification(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.service_complete_webhook_verification(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'private.webhook_url_rejection(text)', 'EXECUTE'),
  'the 0198 grant matrix must hold for each named command');

-- ===== CONTRACT EXISTENCE -- the client boundary, enumerated by name =====
-- One row per RPC the browser or the webhook-verify Edge helper actually calls, resolved by
-- exact signature. A component spec can only prove that the UI renders and refuses correctly
-- against a SHAPE; it cannot prove the function exists, is named that, or takes those types.
-- Every name below is copied verbatim from a call site in src/lib/webhooks.ts or
-- supabase/functions/webhook-verify/index.ts, so a rename on either side fails HERE.
create table pg_temp.p76_client_contract (signature text primary key, caller text not null);
insert into pg_temp.p76_client_contract (signature, caller) values
  ('public.register_webhook_subscription(text,text[],text,text,text)', 'browser: register endpoint'),
  ('public.request_webhook_verification(uuid,text)',                   'browser: start handshake'),
  ('public.set_webhook_subscription_active(uuid,boolean,text)',        'browser: activate AND revoke'),
  ('public.read_webhook_subscriptions()',                              'browser: health + masked metadata'),
  ('public.service_begin_webhook_verification(uuid)',                  'webhook-verify: signed envelope'),
  ('public.service_complete_webhook_verification(uuid,text,text)',     'webhook-verify: settle');

select pg_temp.p76_assert(
  not exists (
    select 1 from pg_temp.p76_client_contract c
    where to_regprocedure(c.signature) is null),
  'a client call site names a function that does not exist: '
  || coalesce((select string_agg(c.signature || ' (' || c.caller || ')', ', ')
               from pg_temp.p76_client_contract c
               where to_regprocedure(c.signature) is null), ''));

-- ===== The event taxonomy the browser offers must be one the outbox actually emits =====
-- `private.domain_event_map` (0063) is the source of truth and the browser cannot read it, so
-- `WEBHOOK_EVENT_CHOICES` in src/lib/webhooks.ts is a copy. A copy is only acceptable with a
-- gate: an owner who picks a renamed or misspelled event type gets a subscription that matches
-- nothing and fails silently forever, which is the worst possible outcome for this feature.
-- Named values only — this asserts each one exists, never how many the map holds.
create table pg_temp.p76_client_event_choices (event_type text primary key);
insert into pg_temp.p76_client_event_choices (event_type) values
  ('supplier.created'), ('supplier.updated'), ('supplier.bank_details_changed'),
  ('product.created'), ('supplier_price.updated'), ('supplier_price_list.submitted'),
  ('purchase_order.created'), ('purchase_order.approved'), ('purchase_order.sent'),
  ('goods_receipt.completed'),
  ('invoice.created'), ('invoice.approved'), ('invoice.review_required'),
  ('credit.created'),
  ('payment_request.created'), ('payment_request.approved'), ('payment.executed'),
  ('bank_transaction.imported'), ('reconciliation.completed'),
  ('document.uploaded'), ('document.processing_completed'), ('document.processing_failed'),
  ('month_export.sent'), ('user.access_changed');

select pg_temp.p76_assert(
  not exists (
    select 1 from pg_temp.p76_client_event_choices c
    where not exists (
      select 1 from private.domain_event_map m where m.event_type = c.event_type)),
  'src/lib/webhooks.ts offers an event type the outbox does not emit: '
  || coalesce((select string_agg(c.event_type, ', ')
               from pg_temp.p76_client_event_choices c
               where not exists (
                 select 1 from private.domain_event_map m where m.event_type = c.event_type)), ''));

-- Step-up is not optional on either new owner path (SECURITY-MODEL §6, #85).
select pg_temp.p76_assert(
  (select p.prosrc ~ 'assert_recent_password_authentication'
   from pg_catalog.pg_proc p
   where p.oid = 'public.register_webhook_subscription(text,text[],text,text,text)'::regprocedure)
  and (select p.prosrc ~ 'assert_recent_password_authentication'
       from pg_catalog.pg_proc p
       where p.oid = 'public.request_webhook_verification(uuid,text)'::regprocedure)
  and (select p.prosrc ~ 'assert_recent_password_authentication'
       from pg_catalog.pg_proc p
       where p.oid = 'public.set_webhook_subscription_active(uuid,boolean,text)'::regprocedure),
  'each named step-up path must still call assert_recent_password_authentication');

-- The anchored patch landed on the LIVE body rather than replacing it wholesale: the 0066
-- audit/security-event arms are still there next to the new refusal.
select pg_temp.p76_assert(
  (select p.prosrc ~ 'webhook_verification_required'
          and p.prosrc ~ 'webhook_subscription_toggled'
          and p.prosrc ~ 'record_security_event'
   from pg_catalog.pg_proc p
   where p.oid = 'public.set_webhook_subscription_active(uuid,boolean,text)'::regprocedure),
  'the activation patch must add the verification refusal WITHOUT dropping the 0066 arms');

-- ===== (D1 + D4) the attack corpus =====
-- One row per hostile encoding. A hand-written chain of three ifs is not a corpus; this table
-- is the assertion, and pg_temp.p76_corpus_leaks() is reused by the D10 mutation proof below.
create table pg_temp.p76_url_corpus (url text primary key, code text not null, why text not null);
insert into pg_temp.p76_url_corpus (url, code, why) values
  ('https://127.0.0.1/hook',                 'webhook_url_ip_literal_rejected',  'dotted-quad loopback'),
  ('https://localhost/hook',                 'webhook_url_local_name_rejected',  'the name every string check remembers'),
  ('https://[::1]/hook',                     'webhook_url_ip_literal_rejected',  'bracketed IPv6 loopback'),
  ('https://0.0.0.0/hook',                   'webhook_url_ip_literal_rejected',  'unspecified address'),
  ('https://0x7f.1/hook',                    'webhook_url_ip_literal_rejected',  'hex+decimal inet_aton form of 127.0.0.1'),
  ('https://2130706433/hook',                'webhook_url_ip_literal_rejected',  'single 32-bit decimal form of 127.0.0.1'),
  ('https://0177.0.0.1/hook',                'webhook_url_ip_literal_rejected',  'octal first octet'),
  ('https://0x7f000001/hook',                'webhook_url_ip_literal_rejected',  'single hex form'),
  ('https://169.254.169.254/latest/meta-data/', 'webhook_url_ip_literal_rejected', 'cloud instance metadata'),
  ('https://10.0.0.1/hook',                  'webhook_url_ip_literal_rejected',  'RFC1918 10/8'),
  ('https://172.16.0.1/hook',                'webhook_url_ip_literal_rejected',  'RFC1918 172.16/12'),
  ('https://192.168.1.1/hook',               'webhook_url_ip_literal_rejected',  'RFC1918 192.168/16'),
  ('https://100.64.0.1/hook',                'webhook_url_ip_literal_rejected',  'CGNAT 100.64/10'),
  ('https://224.0.0.1/hook',                 'webhook_url_ip_literal_rejected',  'IPv4 multicast'),
  ('https://[::ffff:127.0.0.1]/hook',        'webhook_url_ip_literal_rejected',  'IPv4-mapped IPv6 loopback'),
  ('https://[fc00::1]/hook',                 'webhook_url_ip_literal_rejected',  'IPv6 unique-local'),
  ('https://[fe80::1]/hook',                 'webhook_url_ip_literal_rejected',  'IPv6 link-local'),
  ('https://api.internal.local/hook',        'webhook_url_local_name_rejected',  'mDNS .local'),
  ('https://svc.localhost/hook',             'webhook_url_local_name_rejected',  '.localhost is loopback by RFC 6761'),
  ('https://erp.internal/hook',              'webhook_url_local_name_rejected',  'conventional private zone'),
  ('https://1.0.0.127.in-addr.arpa/hook',    'webhook_url_local_name_rejected',  'reverse-DNS zone'),
  ('http://hooks.example.com/hook',          'webhook_url_scheme_rejected',      'plaintext http (#253)'),
  ('file:///etc/passwd',                     'webhook_url_scheme_rejected',      'file:'),
  ('gopher://hooks.example.com/_x',          'webhook_url_scheme_rejected',      'gopher:'),
  ('ftp://hooks.example.com/x',              'webhook_url_scheme_rejected',      'ftp:'),
  ('data:text/plain,hello',                  'webhook_url_scheme_rejected',      'data:'),
  ('https://user:pass@hooks.example.com/h',  'webhook_url_credentials_rejected', 'credentials in the authority'),
  ('https://user@hooks.example.com/h',       'webhook_url_credentials_rejected', 'userinfo without a password'),
  ('https://hooks.example.com:8443/hook',    'webhook_url_port_rejected',        'non-443 port is a port-scan primitive'),
  ('https://hooks.example.com:22/hook',      'webhook_url_port_rejected',        'ssh'),
  ('not a url',                              'webhook_url_scheme_rejected',      'unparseable, refused before anything else'),
  ('',                                       'webhook_url_invalid',              'empty');

-- Every row that the validator FAILS to reject with its named code. Empty = the corpus holds.
create function pg_temp.p76_corpus_leaks()
returns table (url text, expected text, actual text)
language sql
as $$
  select c.url, c.code, coalesce(private.webhook_url_rejection(c.url), '<accepted>')
  from pg_temp.p76_url_corpus c
  where private.webhook_url_rejection(c.url) is distinct from c.code
$$;

select pg_temp.p76_assert(
  (select count(*) from pg_temp.p76_url_corpus) = 32,
  'the corpus size is pinned so a silent deletion fails here');

select pg_temp.p76_assert(
  not exists (select 1 from pg_temp.p76_corpus_leaks()),
  'every hostile URL encoding must be rejected with its named code: '
  || coalesce((select string_agg(url || ' -> ' || actual, ', ')
               from pg_temp.p76_corpus_leaks()), ''));

-- The honest half: a hostname that RESOLVES privately passes the string layer by construction.
-- This is recorded, not hidden -- the connect-time guard in the webhook-verify Edge helper is
-- what closes it, and this assertion exists so nobody later claims the SQL layer did.
select pg_temp.p76_assert(
  private.webhook_url_rejection('https://127.0.0.1.nip.io/hook') is null,
  'a DNS-rebinding host passes the SQL string layer -- it is closed at connect time, not here');

select pg_temp.p76_assert(
  private.webhook_url_rejection('https://hooks.p76.example.com/inplace') is null
    and private.webhook_url_rejection('https://hooks.p76.example.com:443/inplace') is null,
  'a legitimate public HTTPS endpoint must be accepted');

-- ===== (D9) the #97 known-answer vector, unchanged =====
-- The same fixed secret/body/timestamp pinned in p7_integration_adapters.sql and in
-- outbox-worker/core.test.ts. If 0198 had disturbed the signed-string format, this fails here
-- before any behavioural test gets the chance to pass for the wrong reason.
select pg_temp.p76_assert(
  encode(extensions.hmac('{"p7":"known-answer"}.1754400000',
                         'p7-known-answer-secret', 'sha256'), 'hex')
    = '4e3f7e7c2061cba6aa5de9f70b941753e26dc9f33cabd8830a9244608aa94f75',
  'the HMAC-SHA256 signed-string format must be exactly the one #97 pinned');

-- ===== Trusted fixtures =====

insert into organizations (id, name, status) values
  ('18000000-0000-0000-0000-000000000001', 'P76 tenant', 'active'),
  ('18000000-0000-0000-0000-000000000002', 'P76 offboarding tenant', 'active');

insert into auth.users (id, email) values
  ('28000000-0000-0000-0000-000000000001', 'p76-owner@example.test'),
  ('28000000-0000-0000-0000-000000000002', 'p76-office@example.test'),
  ('28000000-0000-0000-0000-000000000003', 'p76-owner2@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('28000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001',
   'P76 Owner', 'owner'),
  ('28000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000001',
   'P76 Office', 'office'),
  ('28000000-0000-0000-0000-000000000003', '18000000-0000-0000-0000-000000000002',
   'P76 Owner Two', 'owner');

\set p76_secret 'p76-signing-secret-0123456789abcdef'
\set p76_url 'https://hooks.p76.example.com/inplace'

-- ===== (D6) registration authorization =====

-- office, with a fresh password proof, is refused on the role before anything else matters.
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000002', interval '0');
set local role authenticated;
do $$
begin
  begin
    perform register_webhook_subscription(
      'https://hooks.p76.example.com/inplace', '{}'::text[],
      'p76-signing-secret-0123456789abcdef', null, 'P76 office attempt');
    raise exception 'P76 owner webhook assertion failed: office registration must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%webhook_not_authorized%' then raise; end if;
  end;
end
$$;
reset role;

-- owner WITHOUT a fresh password proof: the step-up assertion refuses (#85, fail closed).
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
begin
  begin
    perform register_webhook_subscription(
      'https://hooks.p76.example.com/inplace', '{}'::text[],
      'p76-signing-secret-0123456789abcdef', null, 'P76 no amr');
    raise exception 'P76 owner webhook assertion failed: registration without amr must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
  end;
end
$$;
reset role;

-- owner + fresh proof, but a blank reason, a hostile URL and a weak secret each refuse.
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
do $$
begin
  begin
    perform register_webhook_subscription(
      'https://hooks.p76.example.com/inplace', '{}'::text[],
      'p76-signing-secret-0123456789abcdef', null, '   ');
    raise exception 'P76 owner webhook assertion failed: blank reason must be refused';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_subscription_invalid%' then raise; end if;
  end;

  begin
    perform register_webhook_subscription(
      'https://169.254.169.254/latest/meta-data/', '{}'::text[],
      'p76-signing-secret-0123456789abcdef', null, 'P76 metadata attempt');
    raise exception 'P76 owner webhook assertion failed: metadata address must be refused';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_url_ip_literal_rejected%' then raise; end if;
  end;

  begin
    perform register_webhook_subscription(
      'https://hooks.p76.example.com/inplace', '{}'::text[], 'short', null, 'P76 weak secret');
    raise exception 'P76 owner webhook assertion failed: a weak signing secret must be refused';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_secret_invalid%' then raise; end if;
  end;
end
$$;

-- The real registration. Returns the row identity and nothing secret.
select register_webhook_subscription(
  'https://hooks.p76.example.com/inplace',
  array['invoice.approved'],
  'p76-signing-secret-0123456789abcdef',
  'P76 endpoint',
  'P76 registration proof') as registered \gset
reset role;

select (:'registered'::jsonb ->> 'id') as sub_id \gset

-- psql does not interpolate variables inside dollar-quoted bodies, and `authenticated` holds
-- ZERO privileges on the Shape-2 registry, so a DO block running as the browser role cannot
-- look the id up either. A transaction-local GUC carries it across both boundaries.
select set_config('p76.sub_id', :'sub_id', true);

select pg_temp.p76_assert(
  :'registered'::jsonb ->> 'active' = 'false'
    and not (:'registered'::jsonb ? 'secret')
    and not (:'registered'::jsonb ? 'secret_id'),
  'registration must return an INACTIVE subscription and no secret material');

select pg_temp.p76_assert(
  (select active is false and verified_at is null and verified_url is null
   from webhook_subscriptions where id = :'sub_id'::uuid),
  'a freshly registered subscription is inactive and unverified');

-- The Vault secret exists and holds the plaintext the owner supplied -- proving the secret went
-- INTO Vault rather than into the row, the audit log or the return value.
select pg_temp.p76_assert(
  (select ds.decrypted_secret = 'p76-signing-secret-0123456789abcdef'
   from webhook_subscriptions w
   join vault.decrypted_secrets ds on ds.id = w.secret_id
   where w.id = :'sub_id'::uuid),
  'the signing secret must be stored in Vault, resolvable by the row''s secret_id');

-- The reasoned audit row carries the decision, and the SECRET ITSELF appears in NO audit row --
-- asserted on the literal plaintext, not on a column name, so a future column that happens to
-- carry it fails here too.
--
-- Deliberately NOT asserted: that no audit row mentions secret_id. The generic 0066
-- audit_row_change trigger captures the whole row, vault reference included, and 0066:63-65
-- states that choice in its own words ("secret_id is a Vault reference, not a secret"). This
-- suite records the boundary rather than moving it: the browser cannot dereference a vault id,
-- and changing that trigger is a separate decision, not a side effect of this migration.
select pg_temp.p76_assert(
  (select count(*) from audit_logs
   where action = 'webhook_subscription_registered'
     and entity_id = :'sub_id'::uuid
     and reason = 'P76 registration proof') = 1
  and (select not (coalesce(new_values, '{}'::jsonb) ? 'secret_id')
       from audit_logs
       where action = 'webhook_subscription_registered' and entity_id = :'sub_id'::uuid)
  and not exists (
    select 1 from audit_logs
    where coalesce(new_values::text, '') || coalesce(old_values::text, '')
          like '%p76-signing-secret%'),
  'registration must leave a reasoned audit row, and no audit row may carry the secret itself');

select pg_temp.p76_assert(
  (select count(*) from security_events
   where event_type = 'webhook_subscription_registered'
     and org_id = '18000000-0000-0000-0000-000000000001') = 1,
  'registration must record a security event');

-- ===== (D5) activation is unreachable without a handshake =====

-- (1) The ROW property. A direct UPDATE by a trusted writer -- no command, no UI, no ordering --
-- is refused by the named CHECK. This is the assertion that makes D5 structural.
do $$
begin
  begin
    update webhook_subscriptions set active = true
    where id = (select id from webhook_subscriptions
                where org_id = '18000000-0000-0000-0000-000000000001');
    raise exception 'P76 owner webhook assertion failed: direct activation must violate the CHECK';
  exception when check_violation then
    if sqlerrm not like '%webhook_subscriptions_active_requires_verification%' then raise; end if;
  end;
end
$$;

-- (2) The command's named refusal, with everything else satisfied: owner, fresh proof, reason.
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
do $$
declare
  v_id uuid;
begin
  v_id := current_setting('p76.sub_id')::uuid;
  begin
    perform set_webhook_subscription_active(v_id, true, 'P76 premature activation');
    raise exception 'P76 owner webhook assertion failed: unverified activation must be refused';
  exception when sqlstate '42501' then
    if sqlerrm not like '%webhook_verification_required%' then raise; end if;
  end;
end
$$;
reset role;

-- ===== the handshake =====

-- request: owner + step-up + reason, and nothing but an opaque id comes back.
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000002', interval '0');
set local role authenticated;
do $$
declare
  v_id uuid;
begin
  v_id := current_setting('p76.sub_id')::uuid;
  begin
    perform request_webhook_verification(v_id, 'P76 office request');
    raise exception 'P76 owner webhook assertion failed: office may not request verification';
  exception when sqlstate '42501' then
    if sqlerrm not like '%webhook_not_authorized%' then raise; end if;
  end;
end
$$;
reset role;

select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
declare
  v_id uuid;
begin
  v_id := current_setting('p76.sub_id')::uuid;
  begin
    perform request_webhook_verification(v_id, 'P76 stale session');
    raise exception 'P76 owner webhook assertion failed: request without amr must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
  end;
end
$$;
reset role;

select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
select request_webhook_verification(:'sub_id'::uuid, 'P76 verification request') as requested \gset
reset role;

select (:'requested'::jsonb ->> 'verification_id') as verification_id \gset

select pg_temp.p76_assert(
  not (:'requested'::jsonb ? 'challenge') and not (:'requested'::jsonb ? 'signature'),
  'the owner-facing request must return an opaque id, never the challenge or a signature');

select pg_temp.p76_assert(
  (select outcome = 'pending' and challenge_hash is null and dispatched_at is null
     and expires_at > now()
   from private.webhook_verification_attempts where id = :'verification_id'::uuid),
  'the attempt is pending, undispatched, and carries no challenge until the worker asks');

select pg_temp.p76_assert(
  (select count(*) from audit_logs
   where action = 'webhook_verification_requested' and entity_id = :'sub_id'::uuid) = 1
  and (select count(*) from security_events
       where event_type = 'webhook_verification_requested'
         and org_id = '18000000-0000-0000-0000-000000000001') = 1,
  'the verification request must leave a reasoned audit row and a security event');

-- begin/complete are the trusted-worker half: no browser role may reach them at all.
--
-- Proven from the catalogue rather than by calling them, deliberately. On this shared local
-- stack ANY call from role `authenticated` to a COMMITTED public-schema function it lacks
-- EXECUTE on terminates the postmaster with SIGSEGV. Reproduced on
-- public.service_check_signup_rate(text,text) and public.claim_integration_outbox(text,integer)
-- -- neither of which this plan touches -- and NOT reproducible on a function created inside
-- the same transaction, so it is a property of the environment, not of these commands. A suite
-- that crashes a database shared with two other programs is not a suite.
select pg_temp.p76_assert(
  not has_function_privilege('authenticated',
    'public.service_begin_webhook_verification(uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.service_begin_webhook_verification(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.service_complete_webhook_verification(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.service_complete_webhook_verification(uuid,text,text)', 'EXECUTE'),
  'no browser role may reach the trusted-worker half of the handshake');

select pg_temp.p76_clear_claims();
select set_config('request.jwt.claim.role', 'service_role', true);
select service_begin_webhook_verification(:'verification_id'::uuid) as dispatch \gset

-- The envelope is signed in the EXACT #97 format with the subscription's Vault secret, and the
-- secret itself is nowhere in the return value.
select pg_temp.p76_assert(
  (:'dispatch'::jsonb ->> 'url') = 'https://hooks.p76.example.com/inplace'
  and (:'dispatch'::jsonb ->> 'signature') = encode(extensions.hmac(
        (:'dispatch'::jsonb ->> 'body') || '.' || (:'dispatch'::jsonb ->> 'timestamp'),
        'p76-signing-secret-0123456789abcdef', 'sha256'), 'hex')
  and (:'dispatch'::jsonb ->> 'timestamp') ~ '^[0-9]+$'
  and (:'dispatch'::jsonb ->> 'body') not like '%p76-signing-secret%',
  'the dispatch envelope must be HMAC-signed in the #97 format and carry no secret');

select pg_temp.p76_assert(
  (select challenge_hash is not null and dispatched_at is not null
   from private.webhook_verification_attempts where id = :'verification_id'::uuid)
  and (select challenge_hash = encode(extensions.digest(
         ((:'dispatch'::jsonb ->> 'body')::jsonb ->> 'challenge'), 'sha256'), 'hex')
       from private.webhook_verification_attempts where id = :'verification_id'::uuid),
  'the ledger must store the DIGEST of the issued challenge, never the challenge');

-- A second begin on the same attempt is refused: one dispatch per authorization.
do $$
begin
  begin
    perform service_begin_webhook_verification(
      (select id from private.webhook_verification_attempts where outcome = 'pending'));
    raise exception 'P76 owner webhook assertion failed: a second dispatch must be refused';
  exception when sqlstate '55000' then
    if sqlerrm not like '%already_dispatched%' then raise; end if;
  end;
end
$$;

-- A wrong echo fails the handshake, records a NAMED code, and leaves the row unverified.
savepoint p76_wrong_echo;
select service_complete_webhook_verification(
  :'verification_id'::uuid, 'not-the-challenge', null) as wrong_echo \gset

select pg_temp.p76_assert(
  (:'wrong_echo'::jsonb ->> 'verified') = 'false'
  and (:'wrong_echo'::jsonb ->> 'code') = 'webhook_verification_challenge_mismatch'
  and (select verified_at is null from webhook_subscriptions where id = :'sub_id'::uuid)
  and (select count(*) from integration_failures
       where subscription_id = :'sub_id'::uuid
         and error_code = 'webhook_verification_challenge_mismatch'
         and raw_error is null) = 1,
  'a wrong echo must fail with a named code and never verify the row');

-- Settling twice is idempotent rather than a second decision.
select pg_temp.p76_assert(
  (service_complete_webhook_verification(:'verification_id'::uuid, 'anything', null)
     ->> 'idempotent') = 'true',
  'a settled attempt must answer idempotently');
rollback to savepoint p76_wrong_echo;

-- The correct echo verifies the row.
select service_complete_webhook_verification(
  :'verification_id'::uuid,
  ((:'dispatch'::jsonb ->> 'body')::jsonb ->> 'challenge'),
  null) as settled \gset

select pg_temp.p76_assert(
  (:'settled'::jsonb ->> 'verified') = 'true',
  'the correct echo must verify the endpoint');

select pg_temp.p76_assert(
  (select verified_at is not null
     and verified_url = 'https://hooks.p76.example.com/inplace'
   from webhook_subscriptions where id = :'sub_id'::uuid)
  and (select challenge_hash is null and outcome = 'verified'
       from private.webhook_verification_attempts where id = :'verification_id'::uuid),
  'verification stamps the row and clears the challenge digest');

select pg_temp.p76_assert(
  (select count(*) from audit_logs
   where action = 'webhook_verification_succeeded' and entity_id = :'sub_id'::uuid) = 1
  and (select count(*) from security_events
       where event_type = 'webhook_verification_succeeded'
         and org_id = '18000000-0000-0000-0000-000000000001') = 1,
  'a successful handshake must leave an audit row and a security event');

-- ===== activation, now reachable, still step-up-gated =====

select pg_temp.p76_clear_claims();
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
begin
  begin
    perform set_webhook_subscription_active(
      current_setting('p76.sub_id')::uuid, true, 'P76 stale activation');
    raise exception 'P76 owner webhook assertion failed: activation without amr must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
  end;
end
$$;
reset role;

select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
select set_webhook_subscription_active(:'sub_id'::uuid, true, 'P76 activation proof');
reset role;

select pg_temp.p76_assert(
  (select active from webhook_subscriptions where id = :'sub_id'::uuid)
  and (select count(*) from audit_logs
       where action = 'webhook_subscription_toggled' and entity_id = :'sub_id'::uuid) = 1,
  'a verified subscription activates and keeps the 0066 reasoned audit row');

-- ===== changing the endpoint revokes the proof, in the same statement =====

savepoint p76_endpoint_change;
do $$
begin
  begin
    update webhook_subscriptions set url = 'https://elsewhere.p76.example.com/inplace'
    where id = (select id from webhook_subscriptions
                where org_id = '18000000-0000-0000-0000-000000000001');
    raise exception 'P76 owner webhook assertion failed: re-pointing an ACTIVE row must fail';
  exception when check_violation then
    if sqlerrm not like '%webhook_subscriptions_active_requires_verification%' then raise; end if;
  end;
end
$$;

-- Deactivate first, then re-point: the verification is cleared by the trigger, so the row
-- cannot simply be switched back on.
update webhook_subscriptions set active = false where id = :'sub_id'::uuid;
update webhook_subscriptions set url = 'https://elsewhere.p76.example.com/inplace'
where id = :'sub_id'::uuid;

select pg_temp.p76_assert(
  (select verified_at is null and verified_url is null
   from webhook_subscriptions where id = :'sub_id'::uuid),
  'a url change must clear the verification stamp');
rollback to savepoint p76_endpoint_change;

-- ===== (D7 + D8) the owner reader =====

select pg_temp.p76_claims('28000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
select pg_temp.p76_assert(
  (select count(*) from read_webhook_subscriptions()) = 1
  and not exists (
    select 1 from read_webhook_subscriptions() r
    where to_jsonb(r) ? 'secret_id' or to_jsonb(r) ? 'secret'
       or to_jsonb(r) ? 'verified_url'),
  'the owner reader must list the tenant row and expose no secret or vault reference');

select pg_temp.p76_assert(
  not exists (
    select 1 from read_webhook_subscriptions() r
    where to_jsonb(r) ? 'last_error' or to_jsonb(r) ? 'error'
       or to_jsonb(r) ? 'raw_error' or to_jsonb(r) ? 'failure_code'),
  'the owner reader must carry counts and timestamps, never raw error text (#98)');

select pg_temp.p76_assert(
  (select verification_state = 'verified' and active
     and pending_count = 0 and failed_attempt_count = 0 and dead_letter_count = 0
     and last_success_at is null
   from read_webhook_subscriptions()),
  'a verified, active, never-delivered subscription reads as verified with zero counts');
reset role;

-- A foreign tenant's owner sees nothing at all -- zero rows, never an error.
select pg_temp.p76_claims('28000000-0000-0000-0000-000000000003', interval '0');
set local role authenticated;
select pg_temp.p76_assert(
  (select count(*) from read_webhook_subscriptions()) = 0,
  'another tenant''s owner must read zero rows');
reset role;

-- ===== (D9) the delivery contract still holds end to end =====

select pg_temp.p76_clear_claims();
insert into domain_events (event_type, org_id, entity_type, entity_id, payload)
values ('invoice.approved', '18000000-0000-0000-0000-000000000001', 'p76_entity',
        '48000000-0000-0000-0000-000000000001', '{"p76":true}'::jsonb)
returning id as event_id \gset

select pg_temp.p76_assert(
  (select count(*) from private.integration_outbox o
   where o.event_id = :'event_id'::uuid
     and o.target = (select target from webhook_subscriptions where id = :'sub_id'::uuid)
     and o.status = 'pending') = 1,
  'a matching ACTIVE verified subscription must still enqueue exactly one outbox row');

select set_config('request.jwt.claim.role', 'service_role', true);
create table pg_temp.p76_claimed (j jsonb);
insert into pg_temp.p76_claimed select * from claim_integration_outbox('p76-worker', 10);

select pg_temp.p76_assert(
  (select count(*) from pg_temp.p76_claimed c
   where (c.j ->> 'target') = (select target from webhook_subscriptions where id = :'sub_id'::uuid)
     and (c.j ->> 'url') = 'https://hooks.p76.example.com/inplace'
     and (c.j ->> 'idempotency_key') = 'sf:' || :'event_id' || ':' ||
         (select target from webhook_subscriptions where id = :'sub_id'::uuid)
     and (c.j ->> 'signature') = encode(extensions.hmac(
           (c.j ->> 'body') || '.' || (c.j ->> 'timestamp'),
           'p76-signing-secret-0123456789abcdef', 'sha256'), 'hex')) = 1,
  'the claim must still resolve url, the (target,event) idempotency key and a #97 signature');

-- ===== FENCE: the 0103 offboarding egress fence, for a NAMED fixture subscription =====
-- Named function, named predicate, named fixture row. No census, no "how many rows are
-- claimable across the catalogue".
select pg_temp.p76_assert(
  (select p.prosrc ~ 'organization_write_allowed_fenced'
   from pg_catalog.pg_proc p
   where p.oid = 'public.claim_integration_outbox(text,integer)'::regprocedure),
  'claim_integration_outbox must still call organization_write_allowed_fenced (0103)');

select pg_temp.p76_assert(
  exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'private.integration_outbox'::regclass
      and tg.tgname = 'integration_outbox_offboarding_park'
      and not tg.tgisinternal),
  'the 0103 offboarding park trigger must still sit on the outbox');

-- The behavioural half, and the ordering it needs. A verified ACTIVE subscription in a tenant
-- with an OPEN offboarding request must produce no claimable row. Two independent mechanisms
-- have to be seen doing it, so the fixture is built in a specific order:
--   * one outbox row is enqueued BEFORE the request exists, so it is an ordinary 'pending' row
--     and the only thing that can stop it is the fenced predicate inside the claim;
--   * a second is enqueued AFTER, so the BEFORE INSERT park trigger is the thing that stops it.
-- Both events are emitted before the request, because 0103's organization row-write guard
-- refuses a domain event for a read-only tenant outright -- itself a third layer, and the
-- reason the naive version of this fixture cannot be written.
select pg_temp.p76_clear_claims();
select vault.create_secret('p76-offboarding-secret-0123456789abcdef',
                           'p76-offboarding-secret') as off_secret \gset

insert into domain_events (event_type, org_id, entity_type, entity_id, payload)
values ('invoice.approved', '18000000-0000-0000-0000-000000000002', 'p76_entity',
        '48000000-0000-0000-0000-000000000002', '{"p76":"before"}'::jsonb)
returning id as off_event_before \gset

insert into domain_events (event_type, org_id, entity_type, entity_id, payload)
values ('invoice.approved', '18000000-0000-0000-0000-000000000002', 'p76_entity',
        '48000000-0000-0000-0000-000000000003', '{"p76":"after"}'::jsonb)
returning id as off_event_after \gset

insert into webhook_subscriptions (id, org_id, url, event_types, secret_id, active,
                                   verified_at, verified_url, description)
values ('a8000000-0000-4000-8000-000000000002',
        '18000000-0000-0000-0000-000000000002',
        'https://hooks.p76off.example.com/inplace', '{}'::text[], :'off_secret', true,
        now(), 'https://hooks.p76off.example.com/inplace', 'P76 offboarding tenant endpoint');

select private.enqueue_integration_outbox(
  :'off_event_before'::uuid, 'webhook:a8000000-0000-4000-8000-000000000002');

select pg_temp.p76_assert(
  (select status = 'pending' from private.integration_outbox
   where event_id = :'off_event_before'::uuid
     and target = 'webhook:a8000000-0000-4000-8000-000000000002'),
  'the pre-offboarding enqueue must be an ordinary pending row');

-- requested_at is stated rather than defaulted so the 0103 deadline equalities
-- (cancellation = requested_at + 30d = operational purge; reactivation = requested_at + 120d)
-- hold exactly: now() is fixed for the transaction, statement_timestamp() is not.
insert into organization_offboarding_requests (
  org_id, status, request_idempotency_key, requested_by, previous_org_status, requested_at,
  cancellation_deadline, operational_purge_eligible_at, platform_reactivation_deadline,
  security_logs_retain_until, financial_records_retain_until
) values (
  '18000000-0000-0000-0000-000000000002', 'requested', gen_random_uuid(),
  '28000000-0000-0000-0000-000000000003', 'active', now(),
  now() + interval '30 days', now() + interval '30 days', now() + interval '120 days',
  now() + interval '2 years', now() + interval '7 years');

select private.enqueue_integration_outbox(
  :'off_event_after'::uuid, 'webhook:a8000000-0000-4000-8000-000000000002');

select pg_temp.p76_assert(
  (select status = 'parked' from private.integration_outbox
   where event_id = :'off_event_after'::uuid
     and target = 'webhook:a8000000-0000-4000-8000-000000000002'),
  'the 0103 park trigger must park a row enqueued while an offboarding request is open');

select set_config('request.jwt.claim.role', 'service_role', true);
create table pg_temp.p76_offboarding_claim (j jsonb);
insert into pg_temp.p76_offboarding_claim
select * from claim_integration_outbox('p76-offboarding-worker', 10);

select pg_temp.p76_assert(
  (select count(*) from pg_temp.p76_offboarding_claim c
   where (c.j ->> 'target') = 'webhook:a8000000-0000-4000-8000-000000000002') = 0,
  'an organization with an open offboarding request must yield no claimable webhook row');

-- And the fence is the reason, not luck: the pre-offboarding row is still 'pending' and still
-- due, so only private.organization_write_allowed_fenced kept it out of that claim.
select pg_temp.p76_assert(
  (select status = 'pending' and next_attempt_at <= now() and claimed_by is null
   from private.integration_outbox
   where event_id = :'off_event_before'::uuid
     and target = 'webhook:a8000000-0000-4000-8000-000000000002'),
  'the unparked row stayed due and unclaimed -- the fenced predicate is what excluded it');
select pg_temp.p76_clear_claims();

-- ===== (D10) the mutation proof =====
-- Replace the validator with a permissive stub inside a savepoint and observe the corpus
-- assertion turn red. Without this the corpus proves only that the corpus ran.
savepoint p76_validator_mutation;

create or replace function private.webhook_url_rejection(p_url text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  -- The exact mistake this suite exists to catch: the two spellings everyone remembers.
  if p_url like '%localhost%' or p_url like '%127.0.0.1%' then
    return 'webhook_url_local_name_rejected';
  end if;
  return null;
end
$$;

select pg_temp.p76_assert(
  exists (select 1 from pg_temp.p76_corpus_leaks()),
  'a weakened validator MUST leak the corpus -- otherwise the corpus assertion proves nothing');

select pg_temp.p76_assert(
  (select count(*) from pg_temp.p76_corpus_leaks()) >= 20,
  'the weakened validator must leak most of the corpus, not one edge case');

rollback to savepoint p76_validator_mutation;

-- Restored: the corpus holds again, in the same run, so the two halves cannot drift.
select pg_temp.p76_assert(
  not exists (select 1 from pg_temp.p76_corpus_leaks()),
  'the restored validator must reject the whole corpus again');

rollback;

\echo 'p76_owner_webhook_verification_passed'
