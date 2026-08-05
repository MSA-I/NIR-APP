-- 0062 -- Correlation ids on audit_logs (PLAN-4b).
--
-- One nullable uuid column, one invoker-rights helper, one partial index. No existing
-- function is edited: every audit write path already lists its columns explicitly, so a
-- column DEFAULT covers all of them at once (see the column comment below for the count).
--
-- The route is header/GUC, not an RPC argument (INTEGRATION-ARCHITECTURE.md §5): the
-- browser sends `x-correlation-id` per request, PostgREST exposes it through the
-- `request.headers` GUC, and server-originated work (cron, maintenance) may mint a root id
-- via `set_config('app.correlation_id', <uuid>, true)` -- which deliberately takes
-- precedence over the header so a trusted server context can group everything it does.

-- Two separate statements on purpose: ADD COLUMN with no default is a pure catalog change
-- on every PostgreSQL version, and the SET DEFAULT that follows applies to future inserts
-- only -- no table rewrite, no fast-default backfill question on the largest audit table.
alter table public.audit_logs add column correlation_id uuid;

-- STABLE + invoker rights: the function only reads two GUCs, touches no table, and must
-- not add SECURITY DEFINER surface (A5). It lives in public -- NOT private -- because the
-- DEFAULT expression is evaluated with the privileges of whoever performs the insert, and
-- service_role (the gate's direct audit insert path) has no USAGE on private.
create function public.request_correlation_id()
returns uuid
language plpgsql
stable
set search_path = public
as $$
begin
  -- Explicit GUC first (server-minted root id), header second (browser-request id).
  -- Any failure -- malformed headers JSON, a non-uuid value, anything else -- returns
  -- NULL: a bad correlation header must NEVER fail the audited write it rides on.
  return coalesce(
    nullif(current_setting('app.correlation_id', true), ''),
    nullif(current_setting('request.headers', true)::json ->> 'x-correlation-id', '')
  )::uuid;
exception when others then
  return null;
end
$$;

comment on function public.request_correlation_id() is
  'Correlation id of the current request: app.correlation_id GUC first (server-minted '
  'root), then the x-correlation-id request header PostgREST exposes via request.headers. '
  'Fails to NULL on any malformed input; never raises.';

-- The 0020:228 idiom: revoke the browser-facing roles but KEEP service_role's default
-- grant. service_role inserts audit rows directly (check-p0-security.ps1 fixtures), and
-- the column DEFAULT is evaluated with the inserter's privileges -- revoking service_role
-- (the 0028 private-helper idiom) would turn every such insert into permission denied.
revoke all on function public.request_correlation_id() from public, anon, authenticated;

alter table public.audit_logs
  alter column correlation_id set default public.request_correlation_id();

-- Lookups are always "give me everything for this id"; most historical rows are NULL and
-- must not pay for the index.
create index audit_logs_correlation_idx
  on public.audit_logs (correlation_id)
  where correlation_id is not null;

comment on column public.audit_logs.correlation_id is
  'Request correlation id, filled by the column DEFAULT (public.request_correlation_id). '
  'NULL means the write predates 0062, arrived without a header, or carried a malformed '
  'value -- the default fails to NULL rather than failing the write. The DEFAULT covers '
  'every write path without editing any function: all 77 direct audit_logs inserts across '
  'the 71 SECURITY DEFINER commands plus the audit_row_change trigger list their columns '
  'explicitly and none names correlation_id (PLAN-4b §1.1).';

-- audit_logs is already classified in private.scope_registry (0054: cross_scope, not
-- enforced) and A1 checks tables, not columns -- no new registry row. Re-run the 0057
-- assertions to prove A1/A3/A5 did not regress inside this migration (0058:207-218 idiom).
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0062 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
