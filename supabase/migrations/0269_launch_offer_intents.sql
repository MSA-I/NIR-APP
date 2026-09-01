-- 0269 — "I want to keep this", recorded once per window, and the strip that then stops asking.
--
-- WHY A TABLE AND NOT AN AUDIT ROW. `audit_logs` cannot carry this: it holds no unique business
-- key at all (`0001:383-394`), so two devices would write two "intents" and the strip could never
-- know it should stop showing. The UNIQUE constraint IS the hiding.
--
-- AND THE LEDGER IS WRITTEN ONLY WHEN THE INSERT WON. `insert … on conflict do nothing returning
-- id`: if no row came back, the command reports "already recorded" and writes NOTHING. Otherwise
-- the constraint would correctly prevent a second table row while leaving two entries in the log,
-- which is exactly the duplicate it exists to prevent.
--
-- IT MOVES NO MONEY AND CHANGES NO PLAN. It opens no billing period, touches no counter, and does
-- not alter the subscription — that stays `platform_set_org_subscription`, with step-up and a
-- reason. Which is also why there is NO step-up here: recording an intention shifts nothing, and
-- demanding a password for a harmless act is a tax on it, against the test `0061` sets.
--
-- ⚠ AND `my_benefit_window()` GAINS AN OWNER GATE HERE, which is a correction rather than an
-- addition. `0262` left it open to any `authenticated` caller on the reasoning that
-- `my_plan_grant()` already exposes the same facts. That reasoning was wrong: this function also
-- returns `free_intro` and, from now, `intent_recorded` — two facts the older door does not open.
-- It is not a parallel door, it is a wider one, so a role other than owner gets a REFUSAL and
-- never an empty object. An empty object would read as "you have no benefit".

-- ===== 1. The intent =====
create table public.launch_offer_intents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id),
  window_kind     text not null check (window_kind in ('prelaunch_grant', 'free_intro')),
  window_ends_at  timestamptz not null,
  created_by      uuid not null,
  reason          text not null check (length(btrim(reason)) > 0),
  created_at      timestamptz not null default now(),
  -- One intent per organisation per window. Two devices pressing at once produce one row; a
  -- window that later moves is a different window and may be answered again.
  unique (org_id, window_kind, window_ends_at),
  -- Composite, so the person recorded is a member of the organisation recorded — not merely some
  -- profile that exists.
  constraint launch_offer_intents_actor_fkey
    foreign key (org_id, created_by) references public.profiles (org_id, id)
);
create index launch_offer_intents_org_idx on public.launch_offer_intents (org_id, created_at desc);

comment on table public.launch_offer_intents is
  'One row per organisation per benefit window: somebody said they want to talk about continuing '
  '(0269). The UNIQUE is what lets the strip stop asking, and it is why this is a table rather '
  'than an audit row — audit_logs carries no unique business key. Records an intention only: no '
  'plan changes, no billing period opens, nothing is charged.';

alter table public.launch_offer_intents enable row level security;
create policy launch_offer_intents_read on public.launch_offer_intents
  for select to authenticated using (org_id = auth_org() and auth_role() = 'owner');

-- The command is the only writer. No client role may insert, update or delete.
revoke all on table public.launch_offer_intents from public, anon, authenticated;
grant select on table public.launch_offer_intents to authenticated;

create trigger zz_organization_write_guard
  before insert or update or delete on public.launch_offer_intents
  for each row execute function private.organization_row_write_guard();

insert into private.scope_registry (table_name, scope_class, enforced)
values ('launch_offer_intents', 'derived', false)
on conflict (table_name) do update
  set scope_class = excluded.scope_class, enforced = excluded.enforced;

-- Evidence that a PERSON acted, unlike the cron-written snapshot tables: a row exists here only
-- because somebody pressed a button in the product.
insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
values ('launch_offer_intents', 'evidence',
        'A row exists only because an owner pressed the button in the product; it is direct '
        'evidence that the tenant was used.')
on conflict (table_name) do update
  set disposition = excluded.disposition, rationale = excluded.rationale;

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values ('launch_offer_intents', 'include', '{}',
        'The tenant''s own record of saying it wants to discuss continuing, with the window it '
        'was said about.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

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
where registry.table_name = 'launch_offer_intents';

-- The audit trigger refuses to file a row whose entity type it cannot place, which is how this
-- was found: the command wrote its first ledger entry and `aa_assign_audit_scope` rejected it
-- with `audit_scope_taxonomy_incomplete`. An intent belongs to the whole tenant — it is about the
-- subscription of an organisation, not about a warehouse or a legal entity — so it is classified
-- exactly as `organization_subscriptions` and `org_flag_configurations` already are.
insert into private.audit_scope_taxonomy (entity_type, scope_domain, resolver, rationale)
values ('launch_offer_intents', 'organization_identity_platform', 'cross_scope',
        'An intention about the whole tenant''s plan; entity_id is the intent and the row belongs '
        'to no unit within the organisation.')
on conflict (entity_type) do update
  set scope_domain = excluded.scope_domain,
      resolver = excluded.resolver,
      rationale = excluded.rationale;

-- ===== 2. The command =====
--
-- EVERY FACT ABOUT THE WINDOW IS DERIVED ON THE SERVER. The caller supplies a reason and nothing
-- else: a client that named its own `window_kind` or `window_ends_at` would be choosing the key
-- of its own uniqueness constraint, which is not a limit on the client — it is a client picking
-- a different lock.
create or replace function public.record_launch_offer_intent(p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_grant jsonb;
  v_kind text;
  v_ends timestamptz;
  v_reason text;
  v_id uuid;
begin
  if v_org is null or v_user is null or v_role <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Somebody who has paid is not being offered anything, so there is nothing to intend.
  v_grant := public.my_plan_grant();
  if coalesce((v_grant ->> 'has_paid')::boolean, false) then
    raise exception 'already_paying' using errcode = '22023';
  end if;

  -- The same precedence `my_benefit_window()` runs, for the same reason: the boundary that
  -- matters is the one after which the entitlement actually differs.
  if coalesce((v_grant ->> 'granted')::boolean, false) then
    v_kind := 'prelaunch_grant';
    v_ends := (v_grant ->> 'ends_at')::timestamptz;
  else
    select 'free_intro', intro_window.ends_at into v_kind, v_ends
    from private.free_intro_window(v_org) intro_window;
  end if;
  if v_kind is null or v_ends is null then
    raise exception 'no_eligible_window' using errcode = '22023';
  end if;

  v_reason := coalesce(nullif(trim(p_reason), ''),
                       'the owner asked to talk about continuing the plan');

  -- THE WHOLE IDEMPOTENCY, IN ONE STATEMENT. Two devices pressing at once: one INSERT wins and
  -- returns an id, the other conflicts and returns nothing.
  insert into public.launch_offer_intents (org_id, window_kind, window_ends_at, created_by, reason)
  values (v_org, v_kind, v_ends, v_user, v_reason)
  on conflict (org_id, window_kind, window_ends_at) do nothing
  returning id into v_id;

  -- AND THE LEDGER ONLY WHEN IT WON. A second call writes no audit row and no lifecycle event,
  -- because the row it would describe did not happen.
  if v_id is null then
    return jsonb_build_object('recorded', false, 'already_recorded', true,
                              'window_kind', v_kind, 'window_ends_at', v_ends);
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, v_user, 'launch_offer_intent_recorded', 'launch_offer_intents', v_id,
          jsonb_build_object('window_kind', v_kind, 'window_ends_at', v_ends),
          v_reason);

  -- The same pair `0212:163-174` writes, so the intention reaches the operator console rather
  -- than living only inside the tenant's own log.
  perform private.record_platform_lifecycle_event(
    v_org, v_user, 'launch_offer_intent_recorded', 'launch_offer_intents', v_id,
    null,
    jsonb_build_object('window_kind', v_kind, 'window_ends_at', v_ends),
    v_reason);

  return jsonb_build_object('recorded', true, 'already_recorded', false,
                            'window_kind', v_kind, 'window_ends_at', v_ends);
end
$$;

comment on function public.record_launch_offer_intent(text) is
  'Records that an owner wants to talk about continuing, once per organisation per window (0269). '
  'Derives the window on the server, refuses a caller who is not the owner, an organisation that '
  'has paid, and an absent window. Idempotent: a second call writes nothing at all, not even a '
  'log row. Changes no plan, opens no billing period and charges nothing, which is also why it '
  'requires no step-up.';

revoke all on function public.record_launch_offer_intent(text) from public;
revoke all on function public.record_launch_offer_intent(text) from anon;
grant execute on function public.record_launch_offer_intent(text) to authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'record_launch_offer_intent(text)',
       md5(replace(p.prosrc, chr(13), '')), 'filtered_read',
       '0269 derives every value from auth_org() and auth.uid(), writes only rows carrying that '
       'org id, and refuses any caller who is not the owner of it before reading anything.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'record_launch_offer_intent'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 3. The window says whether it has already been answered =====
--
-- Without this key the rule "after the intent the strip disappears" cannot be implemented in the
-- client at all. And the owner gate arrives with it: see the header.
create or replace function public.my_benefit_window()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  with actor as (
    -- 0269: OWNER ONLY, and a refusal rather than an empty object. This function returns
    -- `free_intro` and `intent_recorded`, neither of which `my_plan_grant()` exposes, so it is a
    -- wider door than the one 0262 reasoned from. An empty object would read as "you have no
    -- benefit", which is a different sentence from "this is not yours to see".
    select auth_org() as org_id
    where auth_role() = 'owner'
  ),
  grant_row as (
    select public.my_plan_grant() as grant_json
  ),
  subscription as (
    select * from public.organization_subscriptions
    where org_id = (select org_id from actor)
  ),
  intro as (
    select * from private.free_intro_window((select org_id from actor))
  ),
  chosen as (
    select case
      when (select (grant_json ->> 'granted')::boolean from grant_row) then jsonb_build_object(
        'kind', 'prelaunch_grant',
        'starts_at', null,
        'ends_at', (select grant_json ->> 'ends_at' from grant_row),
        'plan_key', (select plan_key from subscription),
        'reverts_to_plan_key', (select grant_json ->> 'reverts_to_plan_key' from grant_row))
      when exists (select 1 from intro) then jsonb_build_object(
        'kind', 'free_intro',
        'starts_at', (select started_at from intro),
        'ends_at', (select ends_at from intro),
        'plan_key', 'basic',
        'reverts_to_plan_key', (select plan_key from subscription))
      end as window_json
  ),
  -- Already answered, for THIS window. A window that later moves is a different window and is
  -- offered again, which is why the key is the boundary and not the organisation.
  intent as (
    select exists (
      select 1 from public.launch_offer_intents intent_row
      where intent_row.org_id = (select org_id from actor)
        and intent_row.window_kind = (select window_json ->> 'kind' from chosen)
        and intent_row.window_ends_at
              = (select (window_json ->> 'ends_at')::timestamptz from chosen)) as recorded
  )
  select case when exists (select 1 from actor) then jsonb_build_object(
    'server_now', now(),
    'has_paid', coalesce((select (grant_json ->> 'has_paid')::boolean from grant_row), false),
    'intent_recorded', (select recorded from intent),
    'eligible', (select window_json from chosen) is not null
      and not coalesce((select (grant_json ->> 'has_paid')::boolean from grant_row), false)
      and not (select recorded from intent),
    'window', (select window_json from chosen)
  ) else jsonb_build_object('status', 'not_permitted', 'reason', 'role_out_of_scope') end
$$;

comment on function public.my_benefit_window() is
  'The launch benefit as one object: the server''s own clock, whether anyone has ever paid, '
  'whether this window was already answered, and the window that ends next. Owner only from 0269 '
  '— a role outside that gets not_permitted, never an empty object, because this returns '
  'free_intro and intent_recorded and is therefore a wider door than my_plan_grant(). Carries '
  'plan KEYS and never a label: the client translates.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'my_benefit_window()',
       md5(replace(p.prosrc, chr(13), '')), 'filtered_read',
       '0269 reads only rows whose org id equals auth_org(), and refuses every role except owner '
       'before any read, returning not_permitted rather than an empty object.'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'my_benefit_window'
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== Proof =====
do $verify_0269$
declare
  v_body text;
  v_violations text;
begin
  -- The uniqueness that makes the strip able to stop asking.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.launch_offer_intents'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) like '%org_id, window_kind, window_ends_at%') then
    raise exception '0269: the one-intent-per-window constraint is absent';
  end if;

  -- No client role writes it; the command does.
  if has_table_privilege('authenticated', 'public.launch_offer_intents', 'insert')
     or has_table_privilege('authenticated', 'public.launch_offer_intents', 'update')
     or has_table_privilege('authenticated', 'public.launch_offer_intents', 'delete')
     or has_table_privilege('anon', 'public.launch_offer_intents', 'select') then
    raise exception '0269: a client role can write the intents, or anon can read them';
  end if;
  if not (select relrowsecurity from pg_class
          where oid = 'public.launch_offer_intents'::regclass) then
    raise exception '0269: row level security is not enabled on the intents';
  end if;

  -- THE LEDGER ONLY WHEN THE INSERT WON. Re-found in the body rather than trusted.
  v_body := replace(pg_get_functiondef(
    'public.record_launch_offer_intent(text)'::regprocedure), chr(13), '');
  if position('on conflict (org_id, window_kind, window_ends_at) do nothing' in v_body) = 0
     or position('if v_id is null then' in v_body) = 0 then
    raise exception '0269: the command can write a second log row for the same window';
  end if;
  -- It moves no money, so it demands no step-up and opens no billing period.
  if position('assert_recent_password_authentication' in v_body) > 0
     or position('organization_billing_periods' in v_body) > 0
     or position('platform_set_org_subscription' in v_body) > 0 then
    raise exception '0269: the command taxes or changes something it has no business touching';
  end if;

  -- The owner gate on the wider door, and the key that makes the strip able to disappear.
  v_body := replace(pg_get_functiondef('public.my_benefit_window()'::regprocedure), chr(13), '');
  if position('where auth_role() = ''owner''' in v_body) = 0
     or position('''status'', ''not_permitted''' in v_body) = 0 then
    raise exception '0269: my_benefit_window does not refuse a non-owner in words';
  end if;
  if position('''intent_recorded''' in v_body) = 0 then
    raise exception '0269: my_benefit_window does not report whether the window was answered';
  end if;
  -- And it still does not define either window a second time.
  if position('public.my_plan_grant()' in v_body) = 0
     or position('private.free_intro_window' in v_body) = 0
     or position('granted_until' in regexp_replace(v_body, '--[^' || chr(10) || ']*', '', 'g')) > 0 then
    raise exception '0269: my_benefit_window stopped reading the one definition of a window';
  end if;

  if not has_function_privilege('authenticated', 'public.record_launch_offer_intent(text)', 'execute')
     or has_function_privilege('anon', 'public.record_launch_offer_intent(text)', 'execute') then
    raise exception '0269: the command is not exactly authenticated-only';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0269 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_0269$;
