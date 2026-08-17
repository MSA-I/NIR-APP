-- 0142 — Someone is told when document processing stops.
--
-- Closing DEBT-REGISTER §43. Until now nothing announced a dead OCR pool: `restart unless-stopped`
-- and `systemctl enable docker` both repair silently and report nothing, and the only user-visible
-- signal was documents sitting in "ממתין בתור" until 0130's classifier reached
-- `active_over_two_hours`. Two hours of a screen that looks fine while nothing moves.
--
-- WHAT IS MEASURED, AND WHY IT IS THE OUTCOME AND NOT THE PROCESS
--
-- This watches jobs, not workers. A health check on the worker would need an agent on the host and
-- would still miss an expired worker token, an exhausted OpenAI spend cap, or a network path that
-- fails only outbound. One query over the queue catches all of those, because they all end the same
-- way: work stops being picked up.
--
-- THE TWO SIGNALS
--
-- 1. `queued` and never claimed. Nobody is polling.
--    Threshold 20 minutes. Measured, not chosen: over 24 hours across 14 jobs the worst LEGITIMATE
--    wait between `created_at` and `processing_attempt_started_at` was 745 seconds -- 12.4 minutes,
--    on a single-worker pool. 20 minutes clears that by 61% and still fires six times sooner than
--    the two-hour classifier.
--
-- 2. `leased` with an expired lease. A worker took the job and stopped heartbeating.
--    Threshold 5 minutes past `lease_until`, which is 0132's existing recovery grace rather than a
--    new number. A healthy worker renews every 30 seconds, so an expired lease means the process is
--    gone -- it does NOT mean the job is slow. A legitimate 900-second extraction keeps its lease
--    fresh the whole way and never trips this.
--
-- Deliberately NOT alerted on: `extracted` (waiting for a human or the client to request
-- interpretation -- not a worker fault) and `interpreting` (an Edge function fenced at 120 seconds
-- by its egress lease, a different failure with a different owner).
--
-- ONE ALERT PER ORGANISATION PER HOUR
--
-- A dead pool queues every document behind it. Alerting per job would turn one incident into a
-- stream of identical notifications and train the reader to ignore the bell. The dedupe key carries
-- the hour, so a continuing outage re-announces itself once an hour and a fixed one goes quiet by
-- itself, with no state to reset.

insert into private.notification_event_definitions (event_code, description) values (
  'document_processing_stalled',
  'Documents are queued but nothing is picking them up, or a worker abandoned a job mid-flight (0142).'
) on conflict (event_code) do update set description = excluded.description;

-- SECURITY INVOKER on purpose, unlike the older dispatchers beside it.
--
-- The only caller is pg_cron, which runs the job as the role that scheduled it -- postgres -- and
-- that role bypasses RLS on its own. Definer rights would buy nothing here and would cost
-- something: A5 treats every SECURITY DEFINER function that names a scope-enforced table as a
-- candidate needing either an executable `auth_scopes()` marker or an argued exemption. This
-- function has no auth context to scope by (cron has no session user), so it could only ever take
-- the exemption route -- growing the pinned exemption registry to buy a privilege it does not use.
--
-- Worth knowing if this is ever revisited: the A5 candidate scan matches table names in the raw
-- prosrc WITHOUT stripping strings, so the literal '/documents' in target_url below is enough to
-- flag it. Invoker rights make that moot rather than papering over it.
create or replace function private.dispatch_stuck_document_processing_alerts()
returns integer
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_created integer := 0;
  -- The hour is the dedupe window. `statement_timestamp()` and not `now()`: this runs from cron,
  -- and a long transaction must not pin the window to when it started.
  v_window text := to_char(date_trunc('hour', statement_timestamp()), 'YYYYMMDDHH24');
begin
  with stalled as (
    select
      j.org_id,
      count(*) filter (where j.status = 'queued')  as never_claimed,
      count(*) filter (where j.status = 'leased')  as abandoned,
      max(extract(epoch from (statement_timestamp() - j.created_at))::integer) as oldest_seconds
    from public.document_processing_jobs j
    where (
        (j.status = 'queued'
          and j.created_at < statement_timestamp() - interval '20 minutes')
        or (j.status = 'leased'
          and j.lease_until is not null
          and j.lease_until < statement_timestamp() - interval '5 minutes')
      )
    group by j.org_id
  )
  insert into public.notifications (
    org_id, user_id, event_code, entity_key, severity, title, body, target_url, dedupe_key
  )
  select
    s.org_id,
    p.id,
    'document_processing_stalled',
    s.org_id::text,
    'critical',
    'עיבוד המסמכים אינו מתקדם',
    -- Says what is stuck, for how long, and what it means -- not "an error occurred". The reader
    -- is an owner, not an operator, so the body names the consequence and the next step.
    format(
      '%s ממתינים בתור ו־%s ננטשו באמצע. הוותיק ביותר כבר %s דקות. '
      || 'המסמכים עצמם נשמרו ולא אבדו, אבל הם לא ייקראו עד שהשירות יחזור. '
      || 'אם זה נמשך — יש לבדוק ששרת העיבוד פועל.',
      s.never_claimed, s.abandoned, greatest(1, s.oldest_seconds / 60)
    ),
    '/documents',
    'document_processing_stalled:' || v_window
  from stalled s
  join public.profiles p
    on p.org_id = s.org_id
   and p.role = 'owner'
   and p.active
  on conflict (user_id, dedupe_key) do nothing;

  get diagnostics v_created = row_count;
  return v_created;
end;
$$;

revoke all on function private.dispatch_stuck_document_processing_alerts()
  from public, anon, authenticated, service_role;

comment on function private.dispatch_stuck_document_processing_alerts() is
  'Alerts owners when documents stop being processed (0142, closes DEBT-REGISTER §43). Watches the '
  'queue rather than the worker, so one check covers a dead host, an expired worker token and an '
  'exhausted provider budget alike. Thresholds: 20 minutes unclaimed (the worst legitimate wait '
  'measured was 745s) and 5 minutes past an expired lease (0132''s recovery grace). One alert per '
  'organisation per hour, because a stopped pool queues every document behind it.';

-- Idempotent scheduling: the migration must be safe to replay against a database that already
-- carries the job.
select cron.unschedule('supplyflow-stuck-document-alert')
where exists (select 1 from cron.job where jobname = 'supplyflow-stuck-document-alert');

select cron.schedule(
  'supplyflow-stuck-document-alert',
  '*/5 * * * *',
  $job$select private.dispatch_stuck_document_processing_alerts();$job$
);

-- Self-check. The function writes notifications to real people, so the two things worth proving
-- here are that it is callable and that it does NOT fire against a healthy queue. A false alarm
-- every five minutes would be worse than the silence it replaces.
do $$
declare
  v_created integer;
  v_scheduled integer;
begin
  select count(*) into v_scheduled from cron.job
   where jobname = 'supplyflow-stuck-document-alert' and active;
  if v_scheduled <> 1 then
    raise exception '0142 self-check: the cron job is not scheduled and active (found %)', v_scheduled;
  end if;

  v_created := private.dispatch_stuck_document_processing_alerts();
  if v_created is null or v_created < 0 then
    raise exception '0142 self-check: the dispatcher returned %', v_created;
  end if;
  raise notice '0142 self-check: dispatcher ran, % alert(s) created', v_created;
end
$$;

do $$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0142 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0142 export assertions failed:\n%',v_violations; end if;
end
$$;
