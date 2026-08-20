-- Customer Operations post-merge hardening (20.08.2026; renumbered 21.08.2026).
--
-- WHY THIS IS A NEW MIGRATION. PR #85 committed 0154, 0159, 0162 and 0163 before the final
-- concurrency/security review completed. A committed migration is immutable: changing its text
-- would make a fresh reset differ from every database that already ran it. This forward-only file
-- changes the live objects instead.
--
-- THREE FAILURES, ONE COMPATIBLE PATCH:
--   1. `/pricing` is public, but 0154 granted its catalogue only to authenticated. Anonymous
--      visitors now receive SELECT on the two catalogue tables, with RLS restricted to active
--      plans and their entitlements. The inactive `legacy` holding plan stays hidden.
--   2. 0159 counted and inserted signup attempts without a serialization point. Parallel calls
--      could all observe a below-limit count. A short transaction advisory lock now covers only
--      the three counts and one insert; no network work occurs while it is held.
--   3. 0162 checked the page quota with increment zero and checked document quota before a retry
--      that had waited on the counter could re-observe the winning job. The server-known one-page
--      lower bound makes the exact boundary refuse correctly, and the post-lock job recheck keeps
--      a lost-response retry idempotent. With a 20-page worker ceiling, bounded page overshoot is
--      quota + 19 pages once (519 on Free, a 3.8% remainder), not quota + 20.
--
-- Compatibility: no table shape, function signature, response shape or existing row changes.
-- Existing authenticated readers keep the full plan catalogue. Rollback, if ever required, is a
-- new forward migration that revokes anon SELECT, drops the two anon policies, and restores the
-- prior function bodies; history is never rewritten.

-- ===== 1. Refuse to cover unreviewed drift =====
do $guard_0169$
begin
  if has_table_privilege('anon', 'public.subscription_plans', 'SELECT')
     or has_table_privilege('anon', 'public.plan_entitlements', 'SELECT')
     or exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public'
         and policyname in ('subscription_plans_public_select',
                            'plan_entitlements_public_select')
     ) then
    raise exception '0169: public catalogue access changed before the reviewed migration';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure(
      'public.service_check_signup_rate(text,text)')
      and prosrc not like '%pg_advisory_xact_lock%'
  ) then
    raise exception '0169: signup limiter body drifted before serialization review';
  end if;

  if not exists (
    select 1 from private.scope_definer_enforcements pin
    join pg_catalog.pg_proc proc
      on proc.oid = pg_catalog.to_regprocedure(pin.function_signature)
    where pin.function_signature = 'enqueue_document_processing(uuid)'
      and pin.body_hash = md5(replace(proc.prosrc, e'\r', ''))
      and proc.prosrc like '%v_pages.quantity, 0%'
  ) then
    raise exception '0169: enqueue_document_processing drifted from the reviewed 0162 body';
  end if;
end
$guard_0169$;

-- ===== 2. Public, read-only pricing catalogue =====
grant select on table public.subscription_plans to anon;
grant select on table public.plan_entitlements to anon;

create policy subscription_plans_public_select on public.subscription_plans
  for select to anon
  using (active);

create policy plan_entitlements_public_select on public.plan_entitlements
  for select to anon
  using (exists (
    select 1
    from public.subscription_plans plan
    where plan.plan_key = plan_entitlements.plan_key
      and plan.active
  ));

-- ===== 3. Serialize the anonymous signup decision =====
create or replace function public.service_check_signup_rate(
  p_ip_hash text, p_email_hash text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ip_count     integer;
  v_email_count  integer;
  v_global_count integer;
  v_reason       text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_hash_invalid' using errcode = '22023';
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'signup_hash_invalid' using errcode = '22023';
  end if;

  -- Persistence is not concurrency control. One lock protects the address, email and platform
  -- caps together. At a hard ceiling of 200 successful signups per day, this millisecond-scale
  -- critical section is safer than three bucket locks with a deadlock order to maintain.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('supplyflow:signup-rate-limit', 0));

  select count(*) into v_ip_count from private.signup_attempts
  where p_ip_hash is not null and ip_hash = p_ip_hash
    and attempted_at > now() - interval '1 hour';

  select count(*) into v_email_count from private.signup_attempts
  where email_hash = p_email_hash and attempted_at > now() - interval '1 hour';

  select count(*) into v_global_count from private.signup_attempts
  where outcome = 'accepted' and attempted_at > now() - interval '1 day';

  v_reason := case
    when v_ip_count >= 5 then 'address_hourly'
    when v_email_count >= 3 then 'email_hourly'
    when v_global_count >= 200 then 'platform_daily'
    else null end;

  -- Refused attempts count too. Otherwise repeated refusals could walk past a window that only
  -- remembered accepted calls.
  insert into private.signup_attempts (ip_hash, email_hash, outcome)
  values (p_ip_hash, p_email_hash,
          case when v_reason is null then 'accepted' else 'rate_limited' end);

  return jsonb_build_object('allowed', v_reason is null, 'reason', v_reason);
end
$$;
revoke all on function public.service_check_signup_rate(text, text)
  from public, anon, authenticated;
grant execute on function public.service_check_signup_rate(text, text) to service_role;

-- ===== 4. Exact page boundary and post-lock enqueue idempotency =====
create or replace function public.enqueue_document_processing(p_document_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_document public.documents;
  v_output public.document_scan_outputs;
  v_checksum text;
  v_job_id uuid;
  v_status text;
  v_requires_scan boolean;
  v_counter private.usage_counters;
  v_pages private.usage_counters;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_document
  from public.documents document
  where document.id = p_document_id and document.org_id = v_org
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  -- The trusted supplier price-list bridge owns a separate reservation and immutable intake
  -- contract. Keep that route unchanged even when its source happens to be an image.
  v_requires_scan := public.document_scan_image_mime(v_document.mime_type)
    and not (
      v_document.entity_type = 'supplier'
      and v_document.document_kind = 'price_list'
    );

  if v_requires_scan then
    select output.* into v_output
    from public.document_scan_outputs output
    join public.document_scan_decisions decision
      on decision.org_id = output.org_id and decision.scan_output_id = output.id
    where output.org_id = v_org and output.document_id = v_document.id
      and decision.decision = 'accepted'
    order by decision.created_at desc
    limit 1;
  end if;

  if v_output.id is not null then
    v_checksum := 'etag:' || v_output.sha256;
    v_status := 'queued';
  else
    v_checksum := public.smart_document_source_checksum(
      v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
    );
    v_status := case when v_requires_scan then 'awaiting_scan' else 'queued' end;
  end if;

  -- Fast idempotency path when an equivalent job committed before this call began.
  select job.id into v_job_id
  from public.document_processing_jobs job
  where job.org_id = v_org and job.document_id = v_document.id
    and job.input_checksum = v_checksum and job.contract_version = '1'
    and job.status <> 'failed'
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then return v_job_id; end if;

  -- The document counter is the serialization point for every enqueue in this organization.
  v_counter := private.usage_counter_locked(v_org, 'documents.monthly');

  -- A same-document retry can pass the optimistic lookup, then wait above while the first caller
  -- creates and meters the job. Recheck after the lock. Charging or refusing that retry would
  -- make a lost response consume quota twice, or report a false limit failure.
  select job.id into v_job_id
  from public.document_processing_jobs job
  where job.org_id = v_org and job.document_id = v_document.id
    and job.input_checksum = v_checksum and job.contract_version = '1'
    and job.status <> 'failed'
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then return v_job_id; end if;

  perform private.assert_usage_within_limit(
    v_org, 'documents.monthly', v_counter.quantity, 1);

  -- Exact pages remain unknown until extraction. One page is nevertheless a server-known lower
  -- bound for every processable document, so an account exactly at quota must be refused without
  -- trusting a browser-declared page count. The extraction trigger records the exact truth later.
  v_pages := private.usage_counter_locked(v_org, 'ocr_pages.monthly');
  perform private.assert_usage_within_limit(
    v_org, 'ocr_pages.monthly', v_pages.quantity, 1);

  begin
    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, status, input_checksum,
      contract_version, scan_output_id
    ) values (
      v_org, v_document.id, v_user, v_status, v_checksum,
      '1', v_output.id
    ) returning id into v_job_id;
  exception when unique_violation then
    select job.id into v_job_id
    from public.document_processing_jobs job
    where job.org_id = v_org and job.document_id = v_document.id
      and job.input_checksum = v_checksum and job.contract_version = '1'
      and job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
    order by job.created_at desc limit 1;
  end;
  if v_job_id is null then
    raise exception 'document_processing_enqueue_conflict' using errcode = '40001';
  end if;

  -- Keyed by job id: the unique_violation branch returns an existing job whose id was already
  -- counted, so a racing retry moves the counter exactly once.
  perform private.record_usage_event(
    v_org, 'documents.monthly', 1, v_job_id::text, 'document_processing_enqueue');

  if v_status = 'awaiting_scan' then
    insert into public.document_scan_jobs (
      org_id, document_id, processing_job_id, requested_by, input_checksum
    ) values (
      v_org, v_document.id, v_job_id, v_user, v_checksum
    ) on conflict (org_id, processing_job_id) do nothing;
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user,
    case when v_status = 'awaiting_scan'
      then 'document_scan_enqueued' else 'document_processing_enqueued' end,
    'document_processing_jobs', v_job_id,
    jsonb_build_object(
      'document_id', v_document.id,
      'contract_version', '1',
      'scan_output_id', v_output.id
    ),
    case when v_status = 'awaiting_scan'
      then 'document image queued for scan preview'
      else 'document queued for extraction' end
  );
  return v_job_id;
end
$$;
revoke all on function public.enqueue_document_processing(uuid) from public, anon;
grant execute on function public.enqueue_document_processing(uuid) to authenticated;

-- Re-pin the replaced definer body. The hash is computed from the body that Postgres stored;
-- never paste a literal hash that can drift on CRLF conversion.
insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('enqueue_document_processing(uuid)', 'filtered_read',
    '0169 preserves the auth_scopes() document filter, serializes on the caller organization counter, rechecks an equivalent job after that lock, and reads only that organization''s page counter.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

-- ===== 5. Global assertions and migration anchors =====
do $assert_0169$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0169 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0169 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0169$;

do $anchor_0169$
begin
  if not has_table_privilege('anon', 'public.subscription_plans', 'SELECT')
     or not has_table_privilege('anon', 'public.plan_entitlements', 'SELECT')
     or not exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public'
         and policyname = 'subscription_plans_public_select'
         and roles = array['anon']::name[]
     )
     or not exists (
       select 1 from pg_catalog.pg_policies
       where schemaname = 'public'
         and policyname = 'plan_entitlements_public_select'
         and roles = array['anon']::name[]
     ) then
    raise exception '0169: public pricing still lacks explicit grant and anon RLS';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure(
      'public.service_check_signup_rate(text,text)')
      and position('pg_advisory_xact_lock' in prosrc) > 0
      and position('pg_advisory_xact_lock' in prosrc)
          < position('select count(*) into v_ip_count' in prosrc)
  ) then
    raise exception '0169: signup limiter does not lock before its first count';
  end if;

  if not exists (
    select 1 from private.scope_definer_enforcements pin
    join pg_catalog.pg_proc proc
      on proc.oid = pg_catalog.to_regprocedure(pin.function_signature)
    where pin.function_signature = 'enqueue_document_processing(uuid)'
      and pin.body_hash = md5(replace(proc.prosrc, e'\r', ''))
      and proc.prosrc like '%v_pages.quantity, 1%'
      and proc.prosrc like '%A same-document retry can pass%'
  ) then
    raise exception '0169: enqueue page boundary or post-lock idempotency is not pinned';
  end if;
end
$anchor_0169$;
