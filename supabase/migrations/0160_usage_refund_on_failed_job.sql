-- Owner decision 19.08.2026 -- a document that failed to process does not consume the customer's
-- monthly quota.
--
-- WHY THIS EXISTS AT ALL. 0155 counts `documents.monthly` at enqueue, which is the only place a
-- limit can refuse before work is done. The consequence was invisible until production was
-- measured on 19.08.2026: of 67 jobs in the design partner's first sixteen days, 15 failed --
-- 22%. Counting at enqueue therefore means roughly one in five of a customer's quota is spent on
-- our own unreliability, and they would have had no way to know that was what happened.
--
-- Shape: keep counting at enqueue -- the refusal must still happen before the pipeline runs --
-- and give the counter back once, when a job reaches `failed`. The event row is not deleted: it
-- is stamped `refunded_at`, so the ledger still records that the work was attempted and the
-- refund cannot be applied twice by a retried transition.
--
-- OCR PAGES ARE NOT REFUNDED, and that is not an oversight. `ocr_pages.monthly` is recorded from
-- an actual `document_extractions` row (0155), which only exists when pages were really read and
-- really billed by the provider. A page we paid for is a page the customer used, whatever the
-- interpretation step did afterwards.
--
-- What this deliberately does not cover: no refund for a job that succeeded and produced a
-- useless answer. "Failed" here is the pipeline's own status, not a judgement about quality, and
-- a quality-based refund would need a human decision and an operator command rather than a
-- trigger.

-- ===== 1. The event remembers its period and its refund =====
-- Matching an event to a counter by "which window contains occurred_at" would drift the moment a
-- subscription's billing window moves. The period the event was actually counted into is a fact
-- worth storing rather than re-deriving.
alter table private.usage_events
  add column if not exists period_start timestamptz,
  add column if not exists refunded_at  timestamptz;

-- Existing rows predate the column. They are matched to the counter window that contains them,
-- which is exactly the derivation this column exists to stop repeating.
update private.usage_events event
set period_start = counter.period_start
from private.usage_counters counter
where event.period_start is null
  and counter.org_id = event.org_id
  and counter.metric_key = event.metric_key
  and event.occurred_at >= counter.period_start
  and event.occurred_at < counter.period_end;

comment on column private.usage_events.refunded_at is
  'Stamped when a failed job gave the quota back (0160). The row is never deleted: the attempt '
  'happened, and the stamp is what stops a retried transition refunding twice.';

-- ===== 2. Recording, now stamping the period =====
-- 0158's recorder, with the period written onto the event and nothing else changed.
create or replace function private.record_usage_event(
  p_org_id          uuid,
  p_metric_key      text,
  p_quantity        numeric,
  p_idempotency_key text,
  p_source          text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_counter private.usage_counters;
  v_inserted integer;
  v_entitlement jsonb;
  v_before numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'usage_quantity_invalid' using errcode = '22023';
  end if;

  -- Lock first, insert second: the counter row is the serialization point, and taking it before
  -- the event keeps this function's lock order identical to the enforcement path's.
  v_counter := private.usage_counter_locked(p_org_id, p_metric_key);
  v_before := v_counter.quantity;

  insert into private.usage_events (
    org_id, metric_key, quantity, idempotency_key, source, correlation_id, period_start
  ) values (
    p_org_id, p_metric_key, p_quantity, p_idempotency_key, p_source,
    public.request_correlation_id(), v_counter.period_start
  ) on conflict (org_id, metric_key, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return jsonb_build_object('recorded', false, 'idempotent', true,
                              'quantity', v_counter.quantity);
  end if;

  update private.usage_counters
     set quantity = quantity + p_quantity, updated_at = now()
   where org_id = p_org_id and metric_key = p_metric_key
     and period_start = v_counter.period_start
  returning quantity into v_counter.quantity;

  -- The crossing, once per quota per period: idempotency keyed on the period start, so the
  -- hundredth document of a full month does not emit a hundredth event.
  v_entitlement := public.effective_entitlement(p_org_id, p_metric_key);
  if coalesce((v_entitlement ->> 'measured')::boolean, false)
     and not coalesce((v_entitlement ->> 'unlimited')::boolean, false)
     and (v_entitlement ->> 'limit') is not null
     and v_before < (v_entitlement ->> 'limit')::numeric
     and v_counter.quantity >= (v_entitlement ->> 'limit')::numeric then
    perform private.record_product_event(
      p_org_id, auth.uid(), 'usage.limit_reached',
      jsonb_build_object('metric_key', p_metric_key,
                         'limit', (v_entitlement ->> 'limit')::numeric,
                         'plan_key', v_entitlement ->> 'plan_key'),
      p_metric_key || '@' || v_counter.period_start::text);
  end if;

  return jsonb_build_object('recorded', true, 'idempotent', false,
                            'quantity', v_counter.quantity);
end
$$;
revoke all on function private.record_usage_event(uuid, text, numeric, text, text)
  from public, anon, authenticated;

-- ===== 3. The refund =====
create or replace function private.refund_usage_event(
  p_org_id uuid, p_metric_key text, p_idempotency_key text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event private.usage_events;
begin
  -- `for update` and the `refunded_at is null` filter together are the once-only guarantee: two
  -- concurrent transitions serialize here and the second sees the stamp.
  select * into v_event from private.usage_events
  where org_id = p_org_id and metric_key = p_metric_key
    and idempotency_key = p_idempotency_key and refunded_at is null
  for update;
  if not found then return false; end if;

  update private.usage_events set refunded_at = now()
  where org_id = v_event.org_id and metric_key = v_event.metric_key
    and idempotency_key = v_event.idempotency_key;

  -- greatest(..., 0) is a floor, not a fix: a counter cannot go negative even if a period row was
  -- rebuilt underneath an event. If that ever happens the refund is silently smaller, which is the
  -- safe direction -- it never invents quota the customer did not have.
  update private.usage_counters
     set quantity = greatest(quantity - v_event.quantity, 0), updated_at = now()
   where org_id = v_event.org_id and metric_key = v_event.metric_key
     and period_start = v_event.period_start;

  return true;
end
$$;
revoke all on function private.refund_usage_event(uuid, text, text)
  from public, anon, authenticated;

-- The metric key arrives as a TRIGGER ARGUMENT rather than a literal in the body, and that is not
-- style. A5 (0057:327) matches enforced table names textually over prosrc, and `documents` is an
-- enforced table -- so the string 'documents.monthly' inside this function would make a refund
-- that touches only private metering tables look like a cross-tenant read of `documents` and
-- demand an exemption for it. Every other function in this layer already takes the metric as a
-- parameter for the same reason; a trigger takes it through tg_argv.
create or replace function private.refund_failed_document_job() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.refund_usage_event(new.org_id, tg_argv[0], new.id::text);
  return new;
end
$$;
revoke all on function private.refund_failed_document_job()
  from public, anon, authenticated;

-- Fires only on the transition INTO failed, so a job that is updated again while already failed
-- does not reach the refund at all -- belt to the `refunded_at` braces.
create trigger zzz_refund_failed_document_job
  after update of status on public.document_processing_jobs
  for each row
  when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function private.refund_failed_document_job('documents.monthly');

-- ===== 4. Structural re-assertion =====
do $assert_0160$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0160 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0160 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0160$;

-- ===== 5. Anchors =====
do $anchor_0160$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'document_processing_jobs'
      and trg.tgname = 'zzz_refund_failed_document_job' and not trg.tgisinternal
  ) then
    raise exception '0160: a failed job would still consume the customer''s quota';
  end if;

  -- Every event carried into this migration must know its period, or its refund would silently
  -- find no counter to give back to.
  if exists (
    select 1 from private.usage_events where period_start is null
  ) then
    raise exception '0160: a usage event has no period and could never be refunded';
  end if;

  -- Pages stay counted. They were really read and really billed, so exactly one metric is
  -- refundable and the trigger argument is where that is now stated.
  if exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'document_processing_jobs'
      and trg.tgname = 'zzz_refund_failed_document_job'
      and encode(trg.tgargs, 'escape') like '%ocr_pages%'
  ) then
    raise exception '0160: OCR pages were made refundable -- a page we paid for was still used';
  end if;
end
$anchor_0160$;
