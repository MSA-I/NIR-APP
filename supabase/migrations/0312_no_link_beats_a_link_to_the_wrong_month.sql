-- 0312 — three corrections from the final review round: a citation with no window loses its link
-- rather than pointing at the wrong month, the counter reconstruction stops racing the hook, and
-- the rollback door can no longer be called without naming the attempt.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 3 (MEDIUM) — "weaker but honest" was neither.
--
-- `0309` stripped the query string from a shaped citation that had no stored declaration, and I
-- called the result "weaker, honest, and the run survives". Only the last third was true. A
-- January citation becomes `/expenses`, and `/expenses` opens on the CURRENT month — so a claim
-- about January now links to September. `routeAccess.ts`'s own header calls that class
-- CONTRADICTING rather than weak: a source that shows a different population than the claim is
-- worse than a source that shows nothing, because the reader checks it and is misled.
--
-- So the link goes. `route = null` is a citation that names its evidence and offers no journey to
-- it — which the answer view already renders, because three of the sixty-one claim cards have
-- always had no source. The run survives, which was the point, and nothing points anywhere wrong.
--
-- This also repairs the rows `0309` already stripped, so the same statement fixes the past and
-- the future.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 2 (HIGH) — the reconstruction raced the very hook it was repairing.
--
-- `0311` rebuilt `failed_at` from `failed_count` with a plain UPDATE. The hook serialises on an
-- advisory lock per account; a migration that does not take that lock is not serialised with it.
-- A failed attempt arriving during the backfill reads the empty array, computes one, and either
-- overwrites the reconstruction or is skipped by it — either way the run is back to one, which is
-- exactly the reset the backfill existed to prevent. The window is small and it is the window an
-- attacker cannot predict and cannot be relied upon to miss.
--
-- `access exclusive` on the counter table for the length of the reconstruction is the honest
-- answer: it is a table whose entire population is accounts currently failing to sign in, the
-- statement is one UPDATE, and holding every sign-in for its duration is a better outcome than a
-- lockout that quietly lifts.
--
-- ---------------------------------------------------------------------------------------------
-- FINDING 1 (HIGH), THE HALF THAT IS SETTLED — the one-argument door.
--
-- `0311` gave `p_attempt_profile_id` a `default null`, so the function was still callable with one
-- argument and its own assertion only proved the OLD overload was gone. The default is removed;
-- every caller in this repository already passes the argument explicitly.
--
-- THE OTHER HALF IS NOT SETTLED AND IS NOT PRETENDED TO BE. The reviewer has said since round 1
-- that a caller-supplied profile id is an ASSERTION and not proof: a `service_role` holder can
-- name a legitimate young tenant's only owner, and the fence steps aside. That is true. The
-- answer is a per-attempt nonce created with the organization and consumed atomically, and it is
-- not written here because it needs a digest column on `organizations`, a registry schema-hash
-- move, and a change to the one code path in this product that has never been exercised end to
-- end — work that should be measured before it is merged, not appended to a review round. It is
-- recorded as the open disagreement of this review rather than closed by a weaker fence with a
-- confident comment.

-- ---------------------------------------------------------------------------------------------
-- 1. A citation with no window offers no journey.
-- ---------------------------------------------------------------------------------------------
update public.assistant_source_references
set route = null
where route_params is null
  and route is not null
  and (route = '/expenses' or route like '/expenses?%');

-- ---------------------------------------------------------------------------------------------
-- 2. The reconstruction takes the table, so nothing can interleave with it.
-- ---------------------------------------------------------------------------------------------
begin;
lock table private.password_attempt_counters in access exclusive mode;
update private.password_attempt_counters
set failed_at = array_fill(last_failed_at, array[least(failed_count, 10)])
where cardinality(failed_at) = 0
  and failed_count > 0
  and last_failed_at is not null
  and last_failed_at > now() - interval '15 minutes';
commit;

-- ---------------------------------------------------------------------------------------------
-- 3. The rollback cannot be called without naming the attempt.
-- ---------------------------------------------------------------------------------------------
-- Postgres has no "alter argument ... drop default", and `create or replace` refuses it too:
-- "cannot remove parameter defaults from existing function". The default is part of the
-- signature, so the function has to be dropped and recreated — which is safe here precisely
-- because it is service-role only with one caller and nothing depends on it structurally.
--
-- The body is taken from the LIVE definition and only its header is edited, so nothing can drift
-- between the version that was reviewed and the version that lands. The grant is reapplied
-- afterwards, because a drop takes it with the function.
do $drop_default_0312$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor constant text := 'p_attempt_profile_id uuid DEFAULT NULL::uuid';
  v_count integer;
begin
  if position(v_anchor in v_definition) = 0 then
    return; -- already required; this migration is being re-applied
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0312: default anchor count %', v_count; end if;
  drop function public.service_rollback_provisioned_tenant(uuid, uuid);
  execute replace(v_definition, v_anchor, 'p_attempt_profile_id uuid');
end
$drop_default_0312$;

revoke all on function public.service_rollback_provisioned_tenant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_rollback_provisioned_tenant(uuid, uuid) to service_role;

do $assert_0312$
declare
  v_violations text;
  v_contradicting integer;
begin
  select count(*) into v_contradicting
  from public.assistant_source_references
  where route_params is null and route is not null and route like '/expenses%';
  if v_contradicting <> 0 then
    raise exception '0312: % citation(s) still link to a window they did not measure',
      v_contradicting;
  end if;

  if exists (
    select 1 from private.password_attempt_counters
    where cardinality(failed_at) = 0 and failed_count > 0
      and last_failed_at > now() - interval '15 minutes'
  ) then
    raise exception '0312: a live failure run was left with no timestamps';
  end if;

  -- One argument must no longer resolve. `to_regprocedure` on the one-argument signature answers
  -- for a DEFAULTED second parameter too, which is why 0311's version of this assertion passed
  -- while the door was still open.
  if (select pronargdefaults from pg_proc
      where oid = 'public.service_rollback_provisioned_tenant(uuid,uuid)'::regprocedure) <> 0 then
    raise exception '0312: the rollback can still be called without naming the attempt';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0312 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0312$;
