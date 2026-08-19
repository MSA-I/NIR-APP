-- InPlace Assistant, wave 1 (owner decision 19.08.2026) -- the persistence, privacy and metering
-- foundations of the evidence-first assistant. Everything here is a floor for the Edge boundary:
-- the model itself never touches the database, and the browser never writes a row.
--
-- Shape: eight public dialogue tables plus one policy table, all org_id + RLS + write guard, ALL
-- writes through SECURITY DEFINER commands (the 0059/0152 idiom: reads are policy-driven where a
-- policy exists, writes have one door each and the door checks who is knocking). The commands run
-- under the CALLER'S OWN JWT -- never service_role -- so auth_org()/auth.uid() remain the
-- boundary of record and a compromised Edge secret cannot write another tenant's dialogue. They
-- are definers because their tables deliberately hold no browser DML grants; none of them reads a
-- scope-enforced table, so none costs a scope_definer_exemptions row (DEBT-REGISTER §7 stays
-- untouched).
--
-- THE PRIVACY RULE (assistant spec §13). A conversation belongs to the person who had it, not to
-- their organization. Every read policy therefore pins BOTH org_id = auth_org() AND the owning
-- user_id = auth.uid() (child tables join through their parent). An organization owner gets no
-- automatic read of an employee's dialogue text -- what an owner legitimately needs is "is this
-- feature used, what does it cost, does it fail", and that is exposed as assistant_org_health(),
-- an owner-only aggregate over assistant_runs that returns counts, tokens and cost and can return
-- no text because no text column is in its select list. The distinction is structural, not
-- configurable: there is no switch that widens an owner's read into message bodies.
--
-- WHAT A RUN STORES, AND WHAT IT REFUSES TO. assistant_runs is metering exhaust: status, model,
-- token counts, cost, latency. assistant_tool_calls stores the SHAPE of what happened -- which
-- tool, which arguments, how many rows came back, whether coverage was complete -- and never the
-- data rows the tool returned. The rows a tool reads are tenant business data that RLS already
-- governs at its source; copying them into a dialogue table would create a second, stale,
-- privacy-scoped copy of financial data that outlives the permissions that allowed the read.
-- Facts and source references (the evidence a claim cites) are stored because the product promise
-- is that an answer can be audited later; they carry single computed values and labels, never row
-- payloads.
--
-- THE PROPOSAL STATE MACHINE IS ENFORCED HERE, not only in TypeScript. A proposal is a draft of a
-- command the product already has; the assistant composes it, a human confirms it, and the Edge
-- boundary executes the underlying product command with the human's own JWT. The confirm/reject
-- commands below move state and do nothing else -- a database trigger refuses any transition that
-- is not in the contracts.ts PROPOSAL_TRANSITIONS map, so a bug (or a bypass) in the server code
-- cannot resurrect a rejected proposal or execute one twice.
--
-- THREE FLAGS AND ONE POLICY, and the split is the law, not taste. assistant.ui, .history and
-- .drafts gate EXPOSURE -- a panel, stored transcripts, a composed draft a human still has to
-- confirm -- and are 0059 flags, born off. assistant.confirmed_actions is NOT a flag:
-- ENTERPRISE-SECURITY-MODEL §8 says a flag may only turn a capability off, never widen
-- permission, and p4_flags_identity.sql structurally bars resolve_feature_flags() from any
-- authorization path. A switch whose ON state opens a new road to a business write therefore
-- follows the autonomy-policy pattern (0076, OPEN-DECISIONS #109): a private baseline of OFF held
-- by a CHECK constraint, per-organization enablement only through a platform-admin command that
-- demands a reason and writes an audit row. None of the commands below reads a flag; the Edge
-- gates exposure, the database gates permission.
--
-- ONE ENTITLEMENT, NUMERIC, AND HONEST ABOUT BEING UNDECIDED. OPEN-DECISIONS #158 records that
-- plans in this product do not gate capabilities, only volume -- so there is deliberately no
-- boolean assistant entitlement (one that is true for every plan is a knob with no position, and
-- one that is false for some plan would reverse #158 through a side door). What exists is
-- assistant_runs.monthly, seeded for every plan in the explicit UNKNOWN state, which refuses:
-- measured:false is "nobody has said", never "infinite" (0155's discipline), on a feature whose
-- every run costs provider money. And because a per-period quota is a billing control, not an
-- abuse control, there is also a per-user rate limit counted IN THE DATABASE (SECURITY-MODEL §10;
-- the 0020 invitation limit and 0159 signup limit precedents): 30 runs per user per rolling hour,
-- the contracts.ts ASSISTANT_RUNS_PER_USER_HOUR constant.
--
-- What this deliberately does not cover: no Edge function and no tools (the server boundary owns
-- those); no numbers for any plan's run quota -- the unknown state refuses until the owner prices
-- the feature (the 0161 pattern: stating a number is one UPDATE reviewed as pricing); no refund
-- of failed runs (the 0160 question for assistant runs is an owner decision nobody has taken); no
-- owner-facing surface to read an employee's dialogue, deliberately and permanently, per the
-- privacy rule above.

-- ===== 1. Tables =====
create table assistant_conversations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text check (title is null or length(btrim(title)) between 1 and 120),
  started_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  -- `updated_at`, not `last_activity_at`: the house convention every set_updated_at() table
  -- uses, and the column the client already orders its conversation list by.
  updated_at timestamptz not null default now()
);
create index assistant_conversations_owner_idx
  on assistant_conversations (org_id, user_id, updated_at desc) where deleted_at is null;

create trigger assistant_conversations_touch before update on assistant_conversations
  for each row execute function set_updated_at();

create table assistant_runs (
  id              uuid primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references assistant_conversations(id) on delete set null,
  status          text not null check (status in ('succeeded', 'refused', 'failed')),
  error_code      text check (error_code is null or length(btrim(error_code)) between 1 and 80),
  model           text,
  prompt_version  text,
  tool_call_count integer not null default 0 check (tool_call_count >= 0),
  input_tokens    integer check (input_tokens is null or input_tokens >= 0),
  output_tokens   integer check (output_tokens is null or output_tokens >= 0),
  cost_micros     bigint check (cost_micros is null or cost_micros >= 0),
  latency_ms      integer check (latency_ms is null or latency_ms >= 0),
  complete        boolean not null,
  created_at      timestamptz not null default now(),
  -- A run that succeeded has no error to name; a run that did not must say why.
  constraint assistant_runs_error_shape check (
    (status = 'succeeded' and error_code is null)
    or (status <> 'succeeded' and error_code is not null))
);
create index assistant_runs_owner_idx on assistant_runs (org_id, user_id, created_at desc);
create index assistant_runs_org_period_idx on assistant_runs (org_id, created_at);

create table assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  run_id          uuid references assistant_runs(id) on delete set null,
  author          text not null check (author in ('user', 'assistant')),
  -- `question` holds the human's text; `blocks` holds the validated AssistantAnswer for assistant
  -- rows. Exactly one of them exists, and which one is decided by the author -- a row that could
  -- carry both would let display code guess which half is authoritative.
  question        text check (question is null or length(btrim(question)) between 1 and 600),
  blocks          jsonb check (blocks is null or jsonb_typeof(blocks) = 'object'),
  -- clock_timestamp(), not now(): a question and its answer are inserted by ONE transactional
  -- call and now() is frozen per transaction, so they would tie and order by random uuid --
  -- an answer could replay before its question. Context reconstruction needs the real sequence.
  created_at      timestamptz not null default clock_timestamp(),
  constraint assistant_messages_author_payload check (
    (author = 'user' and question is not null and blocks is null)
    or (author = 'assistant' and blocks is not null and question is null))
);
create index assistant_messages_conversation_idx
  on assistant_messages (conversation_id, created_at);
create index assistant_messages_org_created_idx on assistant_messages (org_id, created_at);

create table assistant_tool_calls (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  run_id       uuid not null references assistant_runs(id) on delete cascade,
  tool         text not null check (length(btrim(tool)) between 1 and 80),
  arguments    jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  result_count integer check (result_count is null or result_count >= 0),
  complete     boolean not null,
  failures     jsonb not null default '[]'::jsonb check (jsonb_typeof(failures) = 'array'),
  duration_ms  integer check (duration_ms is null or duration_ms >= 0),
  error_code   text,
  created_at   timestamptz not null default now()
);
create index assistant_tool_calls_run_idx on assistant_tool_calls (run_id);
create index assistant_tool_calls_org_idx on assistant_tool_calls (org_id, created_at);

comment on table assistant_tool_calls is
  'The SHAPE of what a tool did during a run (0164): which tool, which arguments, how many rows, '
  'complete or not. Never the data rows themselves -- those are tenant business data that RLS '
  'governs at the source, and a copy here would be a second, stale, differently-scoped copy of '
  'financial data that outlives the permissions that allowed the original read.';

create table assistant_facts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  run_id         uuid not null references assistant_runs(id) on delete cascade,
  -- Run-scoped reference ('f1', 'f2', ...) -- meaningless outside its run, which is exactly what
  -- makes "cite only what this run returned" checkable (contracts.ts §3).
  fact_ref       text not null check (length(btrim(fact_ref)) between 1 and 40),
  kind           text not null check (kind in (
    'metric.count', 'metric.money', 'metric.percent',
    'invoice.total', 'invoice.status', 'invoice.block_reason', 'invoice.balance',
    'order.total', 'order.status', 'order_invoice.delta',
    'supplier.balance', 'supplier.price_change',
    'payment_request.total', 'payment_request.status',
    'credit.open_amount', 'exception.status', 'document.status', 'alert.occurrence')),
  entity         text check (entity is null or entity in (
    'invoice', 'purchase_order', 'supplier', 'product', 'payment_request', 'payment',
    'credit_note', 'exception', 'document', 'bank_transaction', 'price_offer', 'organization')),
  entity_id      uuid,
  label          text not null check (length(btrim(label)) between 1 and 200),
  value_numeric  numeric,
  value_text     text,
  unit           text not null check (unit in ('ils', 'count', 'percent', 'date', 'text')),
  classification text not null check (classification in (
    'public_product_metadata', 'tenant_standard', 'financial_sensitive',
    'bank_restricted', 'personal_contact', 'document_raw', 'provider_forbidden')),
  as_of          timestamptz not null,
  created_at     timestamptz not null default now(),
  constraint assistant_facts_subject_shape check ((entity is null) = (entity_id is null)),
  -- Null in both is honest ("not measured", contracts.ts: never rendered as zero); both filled
  -- would leave the reader guessing which value the claim cited.
  constraint assistant_facts_value_shape check (
    value_numeric is null or value_text is null),
  constraint assistant_facts_ref_unique unique (run_id, fact_ref)
);
create index assistant_facts_org_idx on assistant_facts (org_id, created_at);

create table assistant_source_references (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  run_id         uuid not null references assistant_runs(id) on delete cascade,
  source_ref     text not null check (length(btrim(source_ref)) between 1 and 40),
  entity         text not null check (entity in (
    'invoice', 'purchase_order', 'supplier', 'product', 'payment_request', 'payment',
    'credit_note', 'exception', 'document', 'bank_transaction', 'price_offer', 'organization')),
  entity_id      uuid not null,
  label          text not null check (length(btrim(label)) between 1 and 200),
  route          text check (route is null or length(btrim(route)) between 1 and 200),
  classification text not null check (classification in (
    'public_product_metadata', 'tenant_standard', 'financial_sensitive',
    'bank_restricted', 'personal_contact', 'document_raw', 'provider_forbidden')),
  created_at     timestamptz not null default now(),
  constraint assistant_source_references_ref_unique unique (run_id, source_ref)
);
create index assistant_source_references_org_idx
  on assistant_source_references (org_id, created_at);

create table assistant_action_proposals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  run_id             uuid references assistant_runs(id) on delete set null,
  state              text not null check (state in (
    'draft', 'awaiting_confirmation', 'confirmed', 'executed', 'failed', 'rejected', 'expired')),
  command            text not null check (length(btrim(command)) between 1 and 120),
  summary            text not null check (length(btrim(summary)) between 1 and 300),
  payload            jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at         timestamptz not null,
  confirmed_at       timestamptz,
  confirmed_by       uuid references auth.users(id) on delete set null,
  executed_at        timestamptz,
  execution_audit_id uuid,
  decided_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index assistant_action_proposals_owner_idx
  on assistant_action_proposals (org_id, user_id, created_at desc);
create index assistant_action_proposals_open_idx
  on assistant_action_proposals (expires_at)
  where state in ('draft', 'awaiting_confirmation');

create trigger assistant_action_proposals_touch before update on assistant_action_proposals
  for each row execute function set_updated_at();

comment on table assistant_action_proposals is
  'A draft of a product command the assistant composed (0164). The assistant never executes one: '
  'a human confirms, the Edge boundary runs the underlying command with the human''s own JWT, and '
  'the outcome is recorded here. The transition trigger makes the contracts.ts state machine a '
  'database fact rather than a TypeScript promise.';

create table assistant_feedback (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  run_id     uuid not null references assistant_runs(id) on delete cascade,
  rating     text not null check (rating in ('helpful', 'not_helpful')),
  note       text check (note is null or length(btrim(note)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint assistant_feedback_once_per_run unique (run_id)
);
create index assistant_feedback_org_idx on assistant_feedback (org_id, created_at);

-- The write guard every org_id table carries (0092/0103): a tenant that is not writable takes no
-- assistant writes either. Kept on all eight -- coverage stays whole.
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_conversations
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_runs
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_messages
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_tool_calls
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_facts
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_source_references
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_action_proposals
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.assistant_feedback
  for each row execute function private.organization_row_write_guard();

-- ===== 2. The proposal state machine, enforced by the database =====
-- contracts.ts PROPOSAL_TRANSITIONS, verbatim: draft -> awaiting_confirmation | rejected |
-- expired; awaiting_confirmation -> confirmed | rejected | expired; confirmed -> executed |
-- failed; the other four states are terminal. INSERT may only land on the two composing states.
-- The identity of a proposal (what it would do, for whom, until when) is immutable after insert:
-- confirming a proposal whose payload could have changed underneath the human is not confirmation.
create or replace function private.assistant_proposal_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.state not in ('draft', 'awaiting_confirmation') then
      raise exception 'assistant_proposal_state' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.user_id is distinct from old.user_id
     or new.run_id is distinct from old.run_id
     or new.command is distinct from old.command
     or new.summary is distinct from old.summary
     or new.payload is distinct from old.payload
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'assistant_proposal_state' using errcode = 'P0001';
  end if;

  if new.state is distinct from old.state then
    v_allowed := case old.state
      when 'draft' then new.state in ('awaiting_confirmation', 'rejected', 'expired')
      when 'awaiting_confirmation' then new.state in ('confirmed', 'rejected', 'expired')
      when 'confirmed' then new.state in ('executed', 'failed')
      else false
    end;
    if not v_allowed then
      raise exception 'assistant_proposal_state' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.assistant_proposal_guard() from public, anon, authenticated;

create trigger zzz_assistant_proposal_guard
  before insert or update on assistant_action_proposals
  for each row execute function private.assistant_proposal_guard();

-- ===== 3. RLS: a conversation belongs to the person who had it =====
alter table assistant_conversations    enable row level security;
alter table assistant_runs             enable row level security;
alter table assistant_messages         enable row level security;
alter table assistant_tool_calls       enable row level security;
alter table assistant_facts            enable row level security;
alter table assistant_source_references enable row level security;
alter table assistant_action_proposals enable row level security;
alter table assistant_feedback         enable row level security;

revoke all on table assistant_conversations     from public, anon, authenticated;
revoke all on table assistant_runs              from public, anon, authenticated;
revoke all on table assistant_messages          from public, anon, authenticated;
revoke all on table assistant_tool_calls        from public, anon, authenticated;
revoke all on table assistant_facts             from public, anon, authenticated;
revoke all on table assistant_source_references from public, anon, authenticated;
revoke all on table assistant_action_proposals  from public, anon, authenticated;
revoke all on table assistant_feedback          from public, anon, authenticated;

grant select on table assistant_conversations     to authenticated;
grant select on table assistant_runs              to authenticated;
grant select on table assistant_messages          to authenticated;
grant select on table assistant_tool_calls        to authenticated;
grant select on table assistant_facts             to authenticated;
grant select on table assistant_source_references to authenticated;
grant select on table assistant_action_proposals  to authenticated;
grant select on table assistant_feedback          to authenticated;

-- Every policy pins BOTH the tenant and the owning user. An organization owner deliberately gets
-- no read of another employee's rows here -- not by a stricter role check inside the same policy,
-- but by there being no policy shape that could return them. The owner's legitimate question
-- ("is this used, what does it cost, does it fail") is answered by assistant_org_health() below,
-- which aggregates over assistant_runs and has no text column in its select list.
create policy assistant_conversations_select on assistant_conversations
  for select to authenticated
  using (org_id = auth_org() and user_id = auth.uid() and deleted_at is null);

create policy assistant_runs_select on assistant_runs
  for select to authenticated
  using (org_id = auth_org() and user_id = auth.uid());

create policy assistant_messages_select on assistant_messages
  for select to authenticated
  using (org_id = auth_org() and exists (
    select 1 from assistant_conversations conversation
    where conversation.id = assistant_messages.conversation_id
      and conversation.org_id = auth_org()
      and conversation.user_id = auth.uid()
      and conversation.deleted_at is null));

create policy assistant_tool_calls_select on assistant_tool_calls
  for select to authenticated
  using (org_id = auth_org() and exists (
    select 1 from assistant_runs run
    where run.id = assistant_tool_calls.run_id
      and run.org_id = auth_org() and run.user_id = auth.uid()));

create policy assistant_facts_select on assistant_facts
  for select to authenticated
  using (org_id = auth_org() and exists (
    select 1 from assistant_runs run
    where run.id = assistant_facts.run_id
      and run.org_id = auth_org() and run.user_id = auth.uid()));

create policy assistant_source_references_select on assistant_source_references
  for select to authenticated
  using (org_id = auth_org() and exists (
    select 1 from assistant_runs run
    where run.id = assistant_source_references.run_id
      and run.org_id = auth_org() and run.user_id = auth.uid()));

create policy assistant_action_proposals_select on assistant_action_proposals
  for select to authenticated
  using (org_id = auth_org() and user_id = auth.uid());

create policy assistant_feedback_select on assistant_feedback
  for select to authenticated
  using (org_id = auth_org() and user_id = auth.uid());

-- ===== 4. Commands =====
-- All SECURITY DEFINER, all callable by the caller's own JWT, none by anon. None of them reads a
-- feature flag: flags gate exposure at the Edge boundary and the p4 suite structurally forbids
-- resolve_feature_flags() from being referenced by any other routine. What the database checks is
-- identity (auth_org()/auth.uid()), entitlement, rate, and the state machine.

-- The abuse valve, separate from the billing quota: 30 runs per user per rolling hour
-- (contracts.ts ASSISTANT_RUNS_PER_USER_HOUR), counted from assistant_runs in Postgres --
-- SECURITY-MODEL §10's standing requirement, the 0020 invitation-limit and 0159 signup-limit
-- precedents -- because a counter living in one Edge instance's memory is not a limit. The rows
-- counted are the recorded runs themselves: deleting a conversation keeps its run rows, so the
-- window cannot be reset by a privacy delete.
create or replace function public.assistant_assert_run_rate_limit() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org    uuid := auth_org();
  v_user   uuid := auth.uid();
  v_recent integer;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  select count(*) into v_recent
  from assistant_runs run
  where run.org_id = v_org and run.user_id = v_user
    and run.created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'assistant_rate_limited' using errcode = 'P0001';
  end if;
end
$$;
revoke all on function public.assistant_assert_run_rate_limit() from public, anon;
grant execute on function public.assistant_assert_run_rate_limit() to authenticated;

-- The pre-spend door. Called by the Edge boundary BEFORE any provider spend: rate first (cheap,
-- absolute), then the plan quota. An unstated quota refuses -- measured:false means nobody has
-- said what this customer may use, and 0155's header explains why that is never treated as
-- infinite. This check is deliberately non-locking: its job is to save provider money on the
-- obvious refusals, cheaply and without holding a lock across a provider call. It is NOT the
-- enforcement of record -- that is assistant_record_run, which locks the counter and asserts the
-- limit in the same transaction as the increment, so concurrency cannot slip a run past the
-- quota. Two doors on purpose: a limit enforced in one place is one bug away from nothing.
create or replace function public.assistant_assert_run_allowed() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org    uuid := auth_org();
  v_quota  jsonb;
  v_period record;
  v_used   numeric;
begin
  if v_org is null or auth.uid() is null or auth_role() is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;

  perform public.assistant_assert_run_rate_limit();

  v_quota := public.effective_entitlement(v_org, 'assistant_runs.monthly');
  if v_quota is null or not coalesce((v_quota ->> 'measured')::boolean, false) then
    raise exception 'assistant_limit_unknown' using errcode = 'P0001';
  end if;
  if coalesce((v_quota ->> 'unlimited')::boolean, false) then
    return jsonb_build_object('allowed', true, 'unlimited', true);
  end if;

  select * into v_period from private.usage_period(v_org);
  select coalesce(counter.quantity, 0) into v_used
  from private.usage_counters counter
  where counter.org_id = v_org and counter.metric_key = 'assistant_runs.monthly'
    and counter.period_start = v_period.period_start;

  if coalesce(v_used, 0) + 1 > (v_quota ->> 'limit')::numeric then
    raise exception 'assistant_limit_reached' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'allowed', true, 'unlimited', false,
    'used', coalesce(v_used, 0), 'limit', (v_quota ->> 'limit')::numeric);
end
$$;
revoke all on function public.assistant_assert_run_allowed() from public, anon;
grant execute on function public.assistant_assert_run_allowed() to authenticated;

-- The single persistence door: one completed run -- its dialogue, its evidence, its tool shapes
-- and its optional proposal -- lands in ONE transactional call, or not at all. There is no
-- start_run half: a two-phase protocol would leave dangling half-runs whenever the Edge died
-- between calls, and a run that never completed is recorded by this same function with status
-- 'failed' instead. p_run_id comes from the caller so a retried Edge invocation is idempotent:
-- the second call finds the row and returns it without moving the usage counter.
create or replace function public.assistant_record_run(
  p_run_id          uuid,
  p_conversation_id uuid,
  p_store_history   boolean,
  p_question        text,
  p_answer          jsonb,
  p_status          text,
  p_error_code      text,
  p_model           text,
  p_prompt_version  text,
  p_input_tokens    integer,
  p_output_tokens   integer,
  p_cost_micros     bigint,
  p_latency_ms      integer,
  p_complete        boolean,
  p_tool_calls      jsonb default '[]'::jsonb,
  p_facts           jsonb default '[]'::jsonb,
  p_sources         jsonb default '[]'::jsonb,
  p_proposal        jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org             uuid := auth_org();
  v_user            uuid := auth.uid();
  v_conversation_id uuid;
  v_proposal_id     uuid;
  v_item            jsonb;
  v_tool_count      integer := 0;
  v_existing        assistant_runs;
  v_counter         private.usage_counters;
begin
  if v_org is null or v_user is null or auth_role() is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  if p_run_id is null or p_status is null or p_complete is null
     or nullif(btrim(coalesce(p_question, '')), '') is null then
    raise exception 'assistant_invalid_request' using errcode = '22023';
  end if;
  if length(btrim(p_question)) > 600 then
    raise exception 'assistant_question_too_long' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_tool_calls, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_facts, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_sources, '[]'::jsonb)) <> 'array' then
    raise exception 'assistant_invalid_request' using errcode = '22023';
  end if;
  if private.organization_access_mode(v_org) <> 'active' then
    raise exception 'assistant_read_only_organization' using errcode = '42501';
  end if;

  -- Idempotency: a retried Edge call finds the run it already wrote. Someone else's run id is
  -- indistinguishable from an unknown one on purpose -- no oracle.
  select * into v_existing from assistant_runs
  where id = p_run_id and org_id = v_org and user_id = v_user;
  if found then
    return jsonb_build_object(
      'run_id', v_existing.id, 'conversation_id', v_existing.conversation_id,
      'idempotent', true);
  end if;
  if exists (select 1 from assistant_runs where id = p_run_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Write-time enforcement, the 0155 call-site pattern: the counter row is LOCKED, the limit is
  -- asserted and the increment happens later in this same transaction, so N concurrent requests
  -- at limit-minus-one serialize here and exactly one crosses. The preflight door is advisory and
  -- pre-spend; this is the half that cannot be raced. A run refused here was produced and then
  -- not recorded -- the right direction, because the alternative is a run that escaped the quota
  -- it was measured against; the Edge surfaces that as a failed turn. A retried call for a run
  -- that WAS recorded never reaches this line -- it was answered idempotently above, so a retry
  -- is never refused. The hourly ceiling is re-asserted too, as the backstop for an Edge that
  -- skipped the pre-spend door.
  perform public.assistant_assert_run_rate_limit();
  v_counter := private.usage_counter_locked(v_org, 'assistant_runs.monthly');
  begin
    perform private.assert_usage_within_limit(
      v_org, 'assistant_runs.monthly', v_counter.quantity, 1);
  exception when raise_exception then
    if sqlerrm = 'plan_limit_unknown' then
      raise exception 'assistant_limit_unknown' using errcode = 'P0001';
    elsif sqlerrm = 'plan_limit_reached' then
      raise exception 'assistant_limit_reached' using errcode = 'P0001';
    else
      raise;
    end if;
  end;

  -- History is stored only when the Edge says the history capability is on for this tenant. When
  -- it is off, the run row alone is written: the metering (tokens, cost, status) must stay true
  -- even for a tenant that keeps no transcripts, or the health and billing reads start lying.
  if coalesce(p_store_history, false) then
    if p_conversation_id is null then
      insert into assistant_conversations (org_id, user_id, title)
      values (v_org, v_user, left(btrim(p_question), 120))
      returning id into v_conversation_id;
    else
      select id into v_conversation_id from assistant_conversations
      where id = p_conversation_id and org_id = v_org and user_id = v_user
        and deleted_at is null
      for update;
      if v_conversation_id is null then
        raise exception 'assistant_history_unavailable' using errcode = '42501';
      end if;
    end if;
  end if;

  insert into assistant_runs (
    id, org_id, user_id, conversation_id, status, error_code, model, prompt_version,
    input_tokens, output_tokens, cost_micros, latency_ms, complete
  ) values (
    p_run_id, v_org, v_user, v_conversation_id, p_status,
    nullif(btrim(coalesce(p_error_code, '')), ''), p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_micros, p_latency_ms, p_complete
  );

  if v_conversation_id is not null then
    insert into assistant_messages (org_id, conversation_id, run_id, author, question)
    values (v_org, v_conversation_id, p_run_id, 'user', btrim(p_question));
    if p_answer is not null then
      insert into assistant_messages (org_id, conversation_id, run_id, author, blocks)
      values (v_org, v_conversation_id, p_run_id, 'assistant', p_answer);
    end if;
    update assistant_conversations set updated_at = now()
    where id = v_conversation_id;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_tool_calls, '[]'::jsonb))
  loop
    insert into assistant_tool_calls (
      org_id, run_id, tool, arguments, result_count, complete, failures, duration_ms, error_code
    ) values (
      v_org, p_run_id,
      v_item ->> 'tool',
      coalesce(v_item -> 'arguments', '{}'::jsonb),
      (v_item ->> 'result_count')::integer,
      coalesce((v_item ->> 'complete')::boolean, false),
      coalesce(v_item -> 'failures', '[]'::jsonb),
      (v_item ->> 'duration_ms')::integer,
      nullif(btrim(coalesce(v_item ->> 'error_code', '')), '')
    );
    v_tool_count := v_tool_count + 1;
  end loop;
  update assistant_runs set tool_call_count = v_tool_count where id = p_run_id;

  -- Evidence is stored only alongside a stored transcript: a fact row whose claim text was never
  -- kept has nothing to prove, and keeping it would retain dialogue-derived values the tenant
  -- chose not to retain.
  if v_conversation_id is not null then
    for v_item in select value from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb))
    loop
      insert into assistant_facts (
        org_id, run_id, fact_ref, kind, entity, entity_id, label,
        value_numeric, value_text, unit, classification, as_of
      ) values (
        v_org, p_run_id,
        v_item ->> 'id',
        v_item ->> 'kind',
        v_item #>> '{subject,entity}',
        (v_item #>> '{subject,id}')::uuid,
        v_item ->> 'label',
        case when jsonb_typeof(v_item -> 'value') = 'number'
             then (v_item ->> 'value')::numeric end,
        case when jsonb_typeof(v_item -> 'value') = 'string'
             then v_item ->> 'value' end,
        v_item ->> 'unit',
        v_item ->> 'classification',
        (v_item ->> 'as_of')::timestamptz
      );
    end loop;

    for v_item in select value from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb))
    loop
      insert into assistant_source_references (
        org_id, run_id, source_ref, entity, entity_id, label, route, classification
      ) values (
        v_org, p_run_id,
        v_item ->> 'id',
        v_item ->> 'entity',
        (v_item ->> 'entity_id')::uuid,
        v_item ->> 'label',
        v_item ->> 'route',
        v_item ->> 'classification'
      );
    end loop;
  end if;

  if p_proposal is not null then
    if jsonb_typeof(p_proposal) <> 'object'
       or nullif(btrim(coalesce(p_proposal ->> 'command', '')), '') is null
       or nullif(btrim(coalesce(p_proposal ->> 'summary', '')), '') is null
       or jsonb_typeof(p_proposal -> 'payload') <> 'object'
       or (p_proposal ->> 'expires_at') is null then
      raise exception 'assistant_invalid_request' using errcode = '22023';
    end if;
    insert into assistant_action_proposals (
      org_id, user_id, run_id, state, command, summary, payload, expires_at
    ) values (
      v_org, v_user, p_run_id, 'awaiting_confirmation',
      p_proposal ->> 'command', p_proposal ->> 'summary',
      p_proposal -> 'payload', (p_proposal ->> 'expires_at')::timestamptz
    ) returning id into v_proposal_id;
  end if;

  -- The counter moves once per run, keyed by the run id, in this same transaction -- a retried
  -- Edge call was already answered above and never reaches this line.
  perform private.record_usage_event(
    v_org, 'assistant_runs.monthly', 1, p_run_id::text, 'assistant_run');

  -- Activity metadata only: which run, what status, what shape. Never the question text -- the
  -- audit ledger is org-readable and the dialogue itself is not.
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_user, 'assistant_run_recorded', 'assistant_runs', p_run_id,
    jsonb_build_object(
      'status', p_status, 'model', p_model, 'complete', p_complete,
      'tool_call_count', v_tool_count, 'stored_history', v_conversation_id is not null,
      'proposal_id', v_proposal_id),
    'assistant run recorded');

  return jsonb_build_object(
    'run_id', p_run_id, 'conversation_id', v_conversation_id,
    'proposal_id', v_proposal_id, 'idempotent', false);
end
$$;
-- Grants and revokes stay on ONE line each throughout this migration: the CI browser-job
-- classifier sniffs changed migrations line by line for grants to authenticated/anon, and a
-- statement split across lines would let a policy-bearing migration skip the browser gate.
revoke all on function public.assistant_record_run(uuid, uuid, boolean, text, jsonb, text, text, text, text, integer, integer, bigint, integer, boolean, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.assistant_record_run(uuid, uuid, boolean, text, jsonb, text, text, text, text, integer, integer, bigint, integer, boolean, jsonb, jsonb, jsonb, jsonb) to authenticated;

comment on function public.assistant_record_run(
  uuid, uuid, boolean, text, jsonb, text, text, text, text, integer, integer, bigint, integer,
  boolean, jsonb, jsonb, jsonb, jsonb) is
  'One completed assistant run lands in one transaction (0164): dialogue, evidence, tool shapes, '
  'optional proposal, usage event and audit row -- or nothing. Caller-supplied run id makes a '
  'retried Edge call idempotent. Callable only with the user''s own JWT; auth_org()/auth.uid() '
  'are the boundary of record.';

-- The privacy delete. The person who had the conversation removes its text NOW -- messages,
-- facts and source references are hard-deleted, tool-call rows go with them (their arguments
-- echo what was asked), and the conversation row itself is tombstoned so the client stops
-- listing it. The run rows stay: status, token and cost figures are billing truth, carry no
-- dialogue, and deleting them would let a tenant erase what their usage cost -- and would reset
-- the hourly rate window. No typed reason is demanded: OPEN-DECISIONS #156 reserves a
-- user-written reason for decisions someone may later have to defend (cancellations,
-- investigations, overrides); deleting your own conversation is a privacy right, so the audit
-- row carries a fixed systemic reason instead -- recorded, not interrogated.
create or replace function public.assistant_delete_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org    uuid := auth_org();
  v_user   uuid := auth.uid();
  v_conversation assistant_conversations;
  v_messages integer;
  v_facts integer;
  v_sources integer;
  v_tool_calls integer;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;

  select * into v_conversation from assistant_conversations
  where id = p_conversation_id and org_id = v_org and user_id = v_user
  for update;
  if not found then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;
  if v_conversation.deleted_at is not null then
    return jsonb_build_object('conversation_id', p_conversation_id, 'idempotent', true);
  end if;

  delete from assistant_facts fact
  where fact.org_id = v_org and exists (
    select 1 from assistant_runs run
    where run.id = fact.run_id and run.conversation_id = p_conversation_id);
  get diagnostics v_facts = row_count;

  delete from assistant_source_references source
  where source.org_id = v_org and exists (
    select 1 from assistant_runs run
    where run.id = source.run_id and run.conversation_id = p_conversation_id);
  get diagnostics v_sources = row_count;

  delete from assistant_tool_calls tool_call
  where tool_call.org_id = v_org and exists (
    select 1 from assistant_runs run
    where run.id = tool_call.run_id and run.conversation_id = p_conversation_id);
  get diagnostics v_tool_calls = row_count;

  delete from assistant_messages
  where org_id = v_org and conversation_id = p_conversation_id;
  get diagnostics v_messages = row_count;

  update assistant_conversations
     set deleted_at = now(), title = null
   where id = p_conversation_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_user, 'assistant_conversation_deleted', 'assistant_conversations',
    p_conversation_id,
    jsonb_build_object(
      'messages_deleted', v_messages, 'facts_deleted', v_facts,
      'sources_deleted', v_sources, 'tool_calls_deleted', v_tool_calls),
    'conversation deleted by its author');

  return jsonb_build_object(
    'conversation_id', p_conversation_id, 'idempotent', false,
    'messages_deleted', v_messages);
end
$$;
revoke all on function public.assistant_delete_conversation(uuid) from public, anon;
grant execute on function public.assistant_delete_conversation(uuid) to authenticated;

-- Confirm moves state and NOTHING else runs here: no business command, no side effect on any
-- product table. Execution belongs to the Edge boundary, which calls the underlying product
-- command with the human's own JWT so the command's own validation, permissions and audit row
-- apply unchanged. A confirm inside this function would attach financial writes to a dialogue
-- command, which is exactly the coupling the proposal model exists to prevent.
create or replace function public.assistant_confirm_proposal(p_proposal_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid := auth_org();
  v_user     uuid := auth.uid();
  v_proposal assistant_action_proposals;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;

  select * into v_proposal from assistant_action_proposals
  where id = p_proposal_id and org_id = v_org and user_id = v_user
  for update;
  if not found then
    raise exception 'assistant_proposal_unavailable' using errcode = '42501';
  end if;

  if v_proposal.state not in ('awaiting_confirmation') then
    raise exception 'assistant_proposal_state' using errcode = 'P0001';
  end if;
  -- Refusal only, no state flip: an exception rolls back everything this call wrote, so a flip
  -- here could never outlive the error that justified it. The daily retention sweep is what
  -- moves an overdue proposal to 'expired'; until then expires_at itself is the truth a reader
  -- checks, and this refusal is the door that matters.
  if v_proposal.expires_at <= now() then
    raise exception 'assistant_proposal_expired' using errcode = 'P0001';
  end if;
  if private.organization_access_mode(v_org) <> 'active' then
    raise exception 'assistant_read_only_organization' using errcode = '42501';
  end if;

  update assistant_action_proposals
     set state = 'confirmed', confirmed_at = now(), confirmed_by = v_user
   where id = p_proposal_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_user, 'assistant_proposal_confirmed', 'assistant_action_proposals', p_proposal_id,
    jsonb_build_object('command', v_proposal.command, 'summary', v_proposal.summary),
    'assistant proposal confirmed by its author');

  return jsonb_build_object('proposal_id', p_proposal_id, 'state', 'confirmed');
end
$$;
revoke all on function public.assistant_confirm_proposal(uuid) from public, anon;
grant execute on function public.assistant_confirm_proposal(uuid) to authenticated;

create or replace function public.assistant_reject_proposal(
  p_proposal_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid := auth_org();
  v_user     uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_proposal assistant_action_proposals;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from assistant_action_proposals
  where id = p_proposal_id and org_id = v_org and user_id = v_user
  for update;
  if not found then
    raise exception 'assistant_proposal_unavailable' using errcode = '42501';
  end if;
  if v_proposal.state not in ('draft', 'awaiting_confirmation') then
    raise exception 'assistant_proposal_state' using errcode = 'P0001';
  end if;

  update assistant_action_proposals
     set state = 'rejected', decided_reason = v_reason
   where id = p_proposal_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_user, 'assistant_proposal_rejected', 'assistant_action_proposals', p_proposal_id,
    jsonb_build_object('command', v_proposal.command), v_reason);

  return jsonb_build_object('proposal_id', p_proposal_id, 'state', 'rejected');
end
$$;
revoke all on function public.assistant_reject_proposal(uuid, text) from public, anon;
grant execute on function public.assistant_reject_proposal(uuid, text) to authenticated;

-- After the Edge boundary executed (or failed to execute) the confirmed product command with the
-- human's own JWT, it records the outcome here. execution_audit_id points at the audit row the
-- PRODUCT command wrote -- the proposal remembers which business write it became.
create or replace function public.assistant_record_proposal_outcome(
  p_proposal_id uuid, p_succeeded boolean, p_execution_audit_id uuid, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid := auth_org();
  v_user     uuid := auth.uid();
  v_proposal assistant_action_proposals;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  if p_succeeded is null or (p_succeeded and p_execution_audit_id is null)
     or (not p_succeeded and nullif(btrim(coalesce(p_error_code, '')), '') is null) then
    raise exception 'assistant_invalid_request' using errcode = '22023';
  end if;

  select * into v_proposal from assistant_action_proposals
  where id = p_proposal_id and org_id = v_org and user_id = v_user
  for update;
  if not found then
    raise exception 'assistant_proposal_unavailable' using errcode = '42501';
  end if;
  if v_proposal.state <> 'confirmed' then
    raise exception 'assistant_proposal_state' using errcode = 'P0001';
  end if;

  if p_succeeded then
    update assistant_action_proposals
       set state = 'executed', executed_at = now(), execution_audit_id = p_execution_audit_id
     where id = p_proposal_id;
  else
    update assistant_action_proposals
       set state = 'failed', decided_reason = btrim(p_error_code)
     where id = p_proposal_id;
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_user,
    case when p_succeeded then 'assistant_proposal_executed'
         else 'assistant_proposal_failed' end,
    'assistant_action_proposals', p_proposal_id,
    jsonb_build_object('command', v_proposal.command,
                       'execution_audit_id', p_execution_audit_id,
                       'error_code', p_error_code),
    case when p_succeeded then 'assistant proposal executed by its confirming user'
         else 'assistant proposal execution failed' end);

  return jsonb_build_object(
    'proposal_id', p_proposal_id,
    'state', case when p_succeeded then 'executed' else 'failed' end);
end
$$;
revoke all on function public.assistant_record_proposal_outcome(uuid, boolean, uuid, text) from public, anon;
grant execute on function public.assistant_record_proposal_outcome(uuid, boolean, uuid, text) to authenticated;

-- Feedback: one rating per run, by the person whose run it was, in the exact shape the client
-- already calls -- rpc('assistant_record_feedback', { p_run_id, p_helpful }). The rating may be
-- revised (a second thought is still their opinion); everything else about the run is not theirs
-- to edit.
create or replace function public.assistant_record_feedback(
  p_run_id uuid, p_helpful boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org  uuid := auth_org();
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  if p_helpful is null then
    raise exception 'assistant_invalid_request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from assistant_runs run
    where run.id = p_run_id and run.org_id = v_org and run.user_id = v_user
  ) then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;

  insert into assistant_feedback (org_id, user_id, run_id, rating, note)
  values (v_org, v_user, p_run_id,
          case when p_helpful then 'helpful' else 'not_helpful' end,
          nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (run_id) do update
    set rating = excluded.rating, note = excluded.note
  returning id into v_id;

  return jsonb_build_object('feedback_id', v_id);
end
$$;
revoke all on function public.assistant_record_feedback(uuid, boolean, text) from public, anon;
grant execute on function public.assistant_record_feedback(uuid, boolean, text) to authenticated;

-- The owner's honest window: usage, cost and failure shape for the current billing period, with
-- zero text columns in the select list. Aggregates only -- "how much, how often, how broken" --
-- because the owner's stake is the bill and the feature's health, not the employee's questions.
-- A non-owner gets zero rows rather than an error, the 0006 anti-oracle convention.
create or replace function public.assistant_org_health()
returns table (
  period_start timestamptz, period_end timestamptz, period_source text,
  run_count bigint, refused_count bigint, failed_count bigint, distinct_users bigint,
  proposal_count bigint, executed_proposal_count bigint,
  input_tokens bigint, output_tokens bigint, cost_micros bigint, avg_latency_ms numeric
)
language sql stable security definer set search_path = public as $$
  select period.period_start, period.period_end, period.period_source,
         count(run.id),
         count(*) filter (where run.status = 'refused'),
         count(*) filter (where run.status = 'failed'),
         count(distinct run.user_id),
         (select count(*) from assistant_action_proposals proposal
           where proposal.org_id = auth_org()
             and proposal.created_at >= period.period_start
             and proposal.created_at < period.period_end),
         (select count(*) from assistant_action_proposals proposal
           where proposal.org_id = auth_org() and proposal.state = 'executed'
             and proposal.created_at >= period.period_start
             and proposal.created_at < period.period_end),
         coalesce(sum(run.input_tokens), 0),
         coalesce(sum(run.output_tokens), 0),
         coalesce(sum(run.cost_micros), 0),
         round(avg(run.latency_ms), 0)
  from private.usage_period(auth_org()) period
  left join assistant_runs run
    on run.org_id = auth_org()
   and run.created_at >= period.period_start and run.created_at < period.period_end
  where auth_org() is not null and auth_role() = 'owner'
  group by period.period_start, period.period_end, period.period_source
$$;
revoke all on function public.assistant_org_health() from public, anon;
grant execute on function public.assistant_org_health() to authenticated;

comment on function public.assistant_org_health() is
  'Owner-only aggregate over assistant_runs (0164): counts, tokens, cost, failure shape for the '
  'current billing period. No text column exists in its select list -- the privacy rule that an '
  'owner never reads an employee''s dialogue is enforced by shape, not by trust.';

-- Bounded conversation context for the Edge boundary. The conversation id arrives from the
-- browser, so the definer body is the only thing standing between one employee and another's
-- dialogue: ownership is checked against auth_org()/auth.uid(), never against the argument, and
-- a foreign or unknown id RAISES rather than returning empty -- an empty result would let the
-- Edge silently build context on nothing while quietly confirming the id exists. Unknown and
-- foreign are the same error, so the raise is not an oracle either.
create or replace function public.assistant_conversation_context(
  p_conversation_id uuid, p_limit integer default 12
) returns table (author text, content text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org  uuid := auth_org();
  v_user uuid := auth.uid();
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from assistant_conversations conversation
    where conversation.id = p_conversation_id
      and conversation.org_id = v_org and conversation.user_id = v_user
      and conversation.deleted_at is null
  ) then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;
  -- The newest N messages, returned oldest-first: that is the shape a prompt context wants.
  return query
  select recent.message_author, recent.message_content
  from (
    select message.author as message_author,
           coalesce(message.question, message.blocks::text) as message_content,
           message.created_at as message_created_at,
           message.id as message_id
    from assistant_messages message
    where message.conversation_id = p_conversation_id and message.org_id = v_org
    order by message.created_at desc, message.id desc
    limit least(greatest(coalesce(p_limit, 12), 1), 50)
  ) recent
  order by recent.message_created_at asc, recent.message_id asc;
end
$$;
revoke all on function public.assistant_conversation_context(uuid, integer) from public, anon;
grant execute on function public.assistant_conversation_context(uuid, integer) to authenticated;

-- Run totals for the Edge's environment caps. The load-bearing part is what is NULL: user/org
-- day counts and the period count are measured by construction (every recorded run passes
-- through this migration's own doors, so the tables and counters ARE the measurement, and zero
-- is an honest zero) -- but org_month_cost is a sum over cost_micros, which no price source
-- fills yet, and a null there must stay null rather than becoming a zero that claims the month
-- cost nothing. A cap configured against an unmeasurable number must refuse, exactly as
-- measured:false does for entitlements. Exposes org-level COUNTS and cost total to any member:
-- this is an enforcement read consulted during any user's run, carries no per-user attribution
-- beyond the caller's own count, and no dialogue.
create or replace function public.assistant_run_totals() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org            uuid := auth_org();
  v_user           uuid := auth.uid();
  v_day_start      timestamptz;
  v_period         record;
  v_user_today     bigint;
  v_org_today      bigint;
  v_org_month      numeric;
  v_org_month_cost bigint;
begin
  if v_org is null or v_user is null then
    raise exception 'assistant_unauthenticated' using errcode = '42501';
  end if;
  -- The business day in the product's one timezone (contracts.ts ORG_TIME_ZONE, 0155's
  -- usage_period precedent), not the UTC day.
  v_day_start := date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';

  select count(*) filter (where run.user_id = v_user), count(*)
    into v_user_today, v_org_today
  from assistant_runs run
  where run.org_id = v_org and run.created_at >= v_day_start;

  select * into v_period from private.usage_period(v_org);
  select counter.quantity into v_org_month
  from private.usage_counters counter
  where counter.org_id = v_org and counter.metric_key = 'assistant_runs.monthly'
    and counter.period_start = v_period.period_start;

  select sum(run.cost_micros) into v_org_month_cost
  from assistant_runs run
  where run.org_id = v_org
    and run.created_at >= v_period.period_start and run.created_at < v_period.period_end;

  return jsonb_build_object(
    'user_today', v_user_today,
    'org_today', v_org_today,
    'org_month', coalesce(v_org_month, 0),
    'org_month_cost', v_org_month_cost);
end
$$;
revoke all on function public.assistant_run_totals() from public, anon;
grant execute on function public.assistant_run_totals() to authenticated;

-- ===== 5. Feature flags: three switches, all born off, exposure only =====
-- ui/history are low risk (a panel, and persistence of what the panel already showed its own
-- user). drafts is medium: the model composes a proposal a human still has to confirm, and the
-- confirm road itself stays closed until the §6 policy below opens it. There is deliberately no
-- fourth flag: the switch that opens the execution road is a permission and lives in §6, because
-- a flag may only ever turn a capability off (SECURITY-MODEL §8).
insert into private.flag_definitions (flag_key, description, risk_level, default_state, kill_switch) values
  ('assistant.ui',
   'InPlace assistant panel and its read-only tools (0164 consumer)',              'low',    false, false),
  ('assistant.history',
   'Persistence of assistant conversations for their own author (0164 consumer)', 'low',    false, false),
  ('assistant.drafts',
   'The assistant may compose action proposals; a human must still confirm, and execution '
   'additionally requires the assistant.confirmed_actions policy (0164 consumer)', 'medium', false, false);

-- ===== 6. The confirmed-actions policy: a permission, not a flag =====
-- The 0076 shape, minus the number it does not need: a private baseline of OFF that a CHECK
-- constraint makes structural rather than intended, an off-only kill switch, per-organization
-- enablement ONLY through a reasoned platform command, and one evaluator the Edge boundary reads.
-- 0076's header explains at length why this class of switch must not be a 0059 flag; that
-- argument is not repeated here, it is obeyed.
create table private.assistant_policy_definitions (
  policy_key       text primary key check (policy_key ~ '^[a-z0-9_.-]+$'),
  description      text not null,
  -- Off. Always off -- the CHECK is what makes that sentence true rather than merely intended
  -- (the 0076 lesson: without it, one UPDATE was a force-on switch for every unconfigured
  -- tenant, with no reason and no audit row).
  baseline_enabled boolean not null default false
    constraint assistant_policy_definitions_baseline_off check (baseline_enabled = false),
  -- Off-only, the 0059:29-32 semantics: raised, it forces the policy OFF everywhere regardless
  -- of configuration. The only direction a platform lever may move authority is down.
  kill_switch      boolean not null default false
);
revoke all on table private.assistant_policy_definitions from public, anon, authenticated;

insert into private.assistant_policy_definitions (policy_key, description) values
  ('assistant.confirmed_actions',
   'May a human-confirmed assistant proposal be executed by the Edge boundary, running the '
   'underlying product command with the confirming user''s own JWT. Baseline is the live rule: '
   'no -- the assistant composes and a human confirms, but nothing executes. Enabled per '
   'organization only by a reasoned platform command.');

create table org_assistant_policies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  policy_key text not null check (policy_key ~ '^[a-z0-9_.-]+$'),
  enabled    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per (organization, policy): a reader resolves one answer, not a stack.
  constraint org_assistant_policies_org_key unique (org_id, policy_key)
  -- No FK to private.assistant_policy_definitions ON PURPOSE, the 0059:66-68 / 0076:190-192
  -- reasoning: an orphaned configuration row must surface as an anomaly rather than as a broken
  -- cascade the day a definition retires.
);

create trigger org_assistant_policies_touch before update on org_assistant_policies
  for each row execute function set_updated_at();

-- Closed shape, tighter than 0076's browser-readable one: the tenant does not read this table --
-- the Edge resolves capabilities server-side and the evaluator below is the read path -- so no
-- policy and no authenticated grant exist at all. And the 0076 §2 argument applies verbatim to
-- service_role: the ONLY legitimate writer is the reasoned definer command below, which writes
-- as postgres regardless of grants, so the default service_role CRUD buys nothing and costs a
-- bypass of the mandatory reason. Revoked -- this table joins org_autonomy_policies in the named
-- exception list of p0_client_dml_acl.sql.
alter table org_assistant_policies enable row level security;
revoke all on table org_assistant_policies from public, anon, authenticated;
revoke insert, update, delete, truncate on table org_assistant_policies from service_role;

create trigger zz_organization_write_guard before insert or update or delete on public.org_assistant_policies
  for each row execute function private.organization_row_write_guard();
create trigger org_assistant_policies_audit
  after insert or update or delete on org_assistant_policies
  for each row execute function audit_row_change();

comment on table org_assistant_policies is
  'Per-organization assistant permission policy (0164, the 0076 shape). Baseline off by CHECK in '
  'private.assistant_policy_definitions; the only writer is platform_set_assistant_policy, which '
  'demands a platform admin, a reason and writes an audit row to the target organization.';

-- The one reasoned write command: platform admin + mandatory reason + audit to the TARGET
-- organization, in one transaction -- platform_set_org_flag (0059:232) and
-- platform_set_autonomy_policy (0076:252) to the letter. The operator, not the owner: the owner
-- of a business does not get to open the execution road from a settings screen; a future
-- owner-facing surface needs no schema change, only a new reasoned RPC that carries its own
-- argument for why an owner may do this.
create or replace function public.platform_set_assistant_policy(
  p_org_id     uuid,
  p_policy_key text,
  p_enabled    boolean,
  p_reason     text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key    text := nullif(btrim(coalesce(p_policy_key, '')), '');
  v_id     uuid;
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'assistant_policy_reason_required' using errcode = '22023';
  end if;
  if p_org_id is null or v_key is null or p_enabled is null then
    raise exception 'assistant_policy_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.assistant_policy_definitions d where d.policy_key = v_key
  ) then
    raise exception 'assistant_policy_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  insert into org_assistant_policies (org_id, policy_key, enabled)
  values (p_org_id, v_key, p_enabled)
  on conflict (org_id, policy_key) do update
    set enabled = excluded.enabled, updated_at = now()
  returning id into v_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    p_org_id, v_actor, 'assistant_policy_configured', 'org_assistant_policies', v_id,
    jsonb_build_object('policy_key', v_key, 'enabled', p_enabled),
    v_reason);
  return v_id;
end
$$;
revoke all on function public.platform_set_assistant_policy(uuid, text, boolean, text) from public, anon;
grant execute on function public.platform_set_assistant_policy(uuid, text, boolean, text) to authenticated;

-- The evaluator the Edge boundary reads for ActorContext.capabilities.confirmedActions.
-- Kill switch forces off > the organization's configured answer > the baseline, which the CHECK
-- above pins to off. No parameter: the organization comes from auth_org(), so it cannot be aimed
-- at another tenant's policy.
create or replace function public.assistant_confirmed_actions_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when definition.kill_switch then false
    else coalesce(configuration.enabled, definition.baseline_enabled)
  end
  from private.assistant_policy_definitions definition
  left join org_assistant_policies configuration
    on configuration.org_id = auth_org()
   and configuration.policy_key = definition.policy_key
  where definition.policy_key = 'assistant.confirmed_actions'
    and auth_org() is not null
$$;
revoke all on function public.assistant_confirmed_actions_enabled() from public, anon;
grant execute on function public.assistant_confirmed_actions_enabled() to authenticated;

-- ===== 7. Entitlements: volume only, honest about being undecided =====
insert into private.entitlement_definitions
  (entitlement_key, kind, measure, unit, label, description)
values
  ('assistant_runs.monthly', 'numeric', 'per_period', 'runs', 'שאלות עוזר בחודש',
   'How many assistant runs the organization may perform within one billing period.');

-- The explicit UNKNOWN state (unlimited false, numeric_limit null) for every plan, INCLUDING
-- business and legacy. Unknown refuses (0154/0155), and refusal is the safe direction for a
-- brand-new metric where every unit is provider money: no plan's intent is obvious for a feature
-- that did not exist when the plans were priced, and 0161's "business stops counting" was a
-- decision about a measured cost, not a blank cheque for future ones. Nobody is blocked by this
-- today -- the three flags above are off, so no tenant can reach the door that refuses. Stating
-- the numbers is one UPDATE per plan, reviewed as pricing (the 0161 pattern). There is
-- deliberately NO boolean assistant entitlement: OPEN-DECISIONS #158 says plans differ by volume
-- only, and a boolean that must be true for every plan is a knob with no position.
insert into plan_entitlements (plan_key, entitlement_key, kind, unlimited, numeric_limit)
select plan.plan_key, 'assistant_runs.monthly', 'numeric', false, null
from subscription_plans plan;

-- ===== 8. Retention =====
-- RETENTION MATRIX (assistant spec §15). Per record type: how long it lives, how it dies, who
-- deletes it, and the exceptions.
--
--   record type                   retention                delete shape                 purge path            exceptions and notes
--   assistant_conversations       90 days after last use   soft on user delete, hard    cron, daily 03:40     the tombstone leaves at purge once its
--                                                          at purge (no messages left)                        messages are gone
--   assistant_messages            90 days                  hard                         cron, daily           user delete removes them immediately
--   assistant_runs                90 days                  hard (children cascade)      cron, daily           usage_events and audit_logs keep the
--                                                                                                             billing/activity truth after the run row goes
--   assistant_tool_calls          90 days (with run)       hard (cascade + user delete) cron, daily           shape only; never stores tool result rows
--   assistant_facts / sources     90 days (with run)       hard (cascade + user delete) cron, daily           --
--   assistant_action_proposals    90 days unless executed  hard                         cron, daily           EXECUTED proposals are never purged: each one
--                                                                                                             explains a real business write and keeps its
--                                                                                                             execution_audit_id pointer
--   assistant_feedback            90 days (with run)       hard (cascade)               cron, daily           --
--   org_assistant_policies        indefinite               --                           --                    a permission grant, not dialogue; its history
--                                                                                                             is the audit ledger
--   audit_logs                    never touched here       --                           --                    the audit ledger and every financial record
--                                                                                                             outlive dialogue, by iron rule
--
-- Backups: platform backups may retain purged rows until backup rotation; the purge promise is
-- about the live database. The offboarding export never includes dialogue tables (A6, section 9).
-- Suspended and offboarding organizations are SKIPPED by the purge -- their write guard refuses
-- deletes, honestly -- and their history is purged on the first run after they return to active.
create or replace function private.purge_assistant_history(p_retention_days integer default 90)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cutoff timestamptz;
  v_expired integer;
  v_proposals integer;
  v_runs integer;
  v_messages integer;
  v_conversations integer;
begin
  if p_retention_days is null or p_retention_days < 1 then
    raise exception 'assistant_retention_window_invalid' using errcode = '22023';
  end if;
  v_cutoff := now() - make_interval(days => p_retention_days);

  -- Proposals that outlived their confirmation window flip to expired first, through the same
  -- transition the state machine allows, so the deletes below never remove a row that still
  -- claims to be waiting for a human.
  update assistant_action_proposals proposal
     set state = 'expired', decided_reason = coalesce(proposal.decided_reason, 'expired unconfirmed')
   where proposal.state in ('draft', 'awaiting_confirmation')
     and proposal.expires_at <= now()
     and private.organization_access_mode(proposal.org_id) = 'active';
  get diagnostics v_expired = row_count;

  delete from assistant_action_proposals proposal
  where proposal.state <> 'executed'
    and proposal.created_at < v_cutoff
    and private.organization_access_mode(proposal.org_id) = 'active';
  get diagnostics v_proposals = row_count;

  -- Old runs go with their children (tool shapes, facts, sources, feedback cascade). What stays
  -- behind is the durable record: usage_events for billing and audit_logs for activity.
  delete from assistant_runs run
  where run.created_at < v_cutoff
    and private.organization_access_mode(run.org_id) = 'active';
  get diagnostics v_runs = row_count;

  delete from assistant_messages message
  where message.created_at < v_cutoff
    and private.organization_access_mode(message.org_id) = 'active';
  get diagnostics v_messages = row_count;

  delete from assistant_conversations conversation
  where not exists (
      select 1 from assistant_messages message
      where message.conversation_id = conversation.id)
    and coalesce(conversation.deleted_at, conversation.updated_at) < v_cutoff
    and private.organization_access_mode(conversation.org_id) = 'active';
  get diagnostics v_conversations = row_count;

  return jsonb_build_object(
    'retention_days', p_retention_days,
    'proposals_expired', v_expired,
    'proposals_deleted', v_proposals,
    'runs_deleted', v_runs,
    'messages_deleted', v_messages,
    'conversations_deleted', v_conversations);
end
$$;
revoke all on function private.purge_assistant_history(integer) from public, anon, authenticated, service_role;

comment on function private.purge_assistant_history(integer) is
  'Assistant retention (0164, spec §15): dialogue older than the window is hard-deleted daily. '
  'Never touches audit_logs, never touches an executed proposal, never touches any financial '
  'record. Skips organizations that are not writable; catches up when they return.';

-- Idempotent scheduling, the 0142 pattern: safe to replay against a database that already
-- carries the job.
select cron.unschedule('supplyflow-assistant-retention')
where exists (select 1 from cron.job where jobname = 'supplyflow-assistant-retention');

select cron.schedule(
  'supplyflow-assistant-retention',
  '40 3 * * *',
  $job$select private.purge_assistant_history();$job$
);

-- ===== 9. Registry duties (A1 + A6) =====
-- org_global: tenant-owned rows with no unit scope column -- a conversation belongs to a person,
-- not to a warehouse -- and never scope-enforced. org_assistant_policies follows
-- org_autonomy_policies' own classification exactly.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('assistant_conversations',     'org_global', false),
  ('assistant_runs',              'org_global', false),
  ('assistant_messages',          'org_global', false),
  ('assistant_tool_calls',        'org_global', false),
  ('assistant_facts',             'org_global', false),
  ('assistant_source_references', 'org_global', false),
  ('assistant_action_proposals',  'org_global', false),
  ('assistant_feedback',          'org_global', false),
  ('org_assistant_policies',      'org_global', false);

-- A6. Dialogue does not travel: the tenant export is the organization's business records handed
-- back on the way out, and §13 bars even the organization's own owner from reading an employee's
-- dialogue -- an export delivered to that owner must not contain what the product refuses to show
-- them. Proposals DO travel: an action proposal is a business decision record (what was drafted,
-- who confirmed it, which audit row the execution wrote), the same category as audit_logs, which
-- exports. So does the policy row -- the rule that governed the tenant is their record, like
-- org_autonomy_policies. Runs, tool shapes and feedback are operational exhaust, the usage_events
-- precedent.
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('assistant_conversations', 'exclude', '{}',
   'Employee-private assistant dialogue; the §13 privacy rule bars even the account owner from it.'),
  ('assistant_messages', 'exclude', '{}',
   'Employee-private assistant dialogue text; never disclosed to the organization, so never exported.'),
  ('assistant_runs', 'exclude', '{}',
   'Per-employee assistant metering exhaust (tokens, cost, latency); operational, not tenant business records.'),
  ('assistant_tool_calls', 'exclude', '{}',
   'Tool-call shapes whose arguments echo employee questions; dialogue-derived, not tenant business records.'),
  ('assistant_facts', 'exclude', '{}',
   'Evidence values issued into employee-private dialogue; derived from data the export already includes at source.'),
  ('assistant_source_references', 'exclude', '{}',
   'Evidence pointers issued into employee-private dialogue; the referenced records export at source.'),
  ('assistant_action_proposals', 'include', '{}',
   'Assistant-composed action drafts with their confirmation and execution trail; business decision records.'),
  ('assistant_feedback', 'exclude', '{}',
   'Employee-private product feedback tied to their own dialogue; not organizational business data.'),
  ('org_assistant_policies', 'include', '{}',
   'The assistant permission policy that governed the tenant; their record, like org_autonomy_policies.')
on conflict (table_name) do update
set disposition = excluded.disposition,
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
where registry.table_name in (
  'assistant_conversations', 'assistant_runs', 'assistant_messages', 'assistant_tool_calls',
  'assistant_facts', 'assistant_source_references', 'assistant_action_proposals',
  'assistant_feedback', 'org_assistant_policies');

-- ===== 10. Structural re-assertion =====
do $assert_0164$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0164 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0164 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0164$;

-- ===== 11. Anchors =====
do $anchor_0164$
declare
  v_count integer;
  v_result jsonb;
begin
  -- RLS is on everywhere, and the browser holds SELECT on the dialogue tables and nothing else.
  select count(*) into v_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace space on space.oid = relation.relnamespace
  where space.nspname = 'public'
    and relation.relname in (
      'assistant_conversations', 'assistant_runs', 'assistant_messages', 'assistant_tool_calls',
      'assistant_facts', 'assistant_source_references', 'assistant_action_proposals',
      'assistant_feedback', 'org_assistant_policies')
    and not relation.relrowsecurity;
  if v_count > 0 then
    raise exception '0164: % assistant table(s) without RLS enabled', v_count;
  end if;

  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'assistant_conversations', 'assistant_runs', 'assistant_messages', 'assistant_tool_calls',
      'assistant_facts', 'assistant_source_references', 'assistant_action_proposals',
      'assistant_feedback', 'org_assistant_policies')
    and grantee in ('anon', 'authenticated')
    and privilege_type <> 'SELECT';
  if v_count > 0 then
    raise exception '0164: % browser DML grant(s) on an assistant table -- the commands are the only door', v_count;
  end if;

  -- The policy table is closed to the browser entirely, and service_role lost its default CRUD:
  -- the reasoned command is the only writer.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'org_assistant_policies'
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_count > 0 then
    raise exception '0164: % write grant(s) on org_assistant_policies bypass the reasoned command', v_count;
  end if;

  -- The write guard is on all nine; the state-machine trigger is on the proposals.
  select count(*) into v_count from pg_catalog.pg_trigger trg
  join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
  where relation.relname in (
      'assistant_conversations', 'assistant_runs', 'assistant_messages', 'assistant_tool_calls',
      'assistant_facts', 'assistant_source_references', 'assistant_action_proposals',
      'assistant_feedback', 'org_assistant_policies')
    and trg.tgname = 'zz_organization_write_guard' and not trg.tgisinternal;
  if v_count <> 9 then
    raise exception '0164: expected 9 organization write guards, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trg
    join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
    where relation.relname = 'assistant_action_proposals'
      and trg.tgname = 'zzz_assistant_proposal_guard' and not trg.tgisinternal
  ) then
    raise exception '0164: the proposal state machine is not enforced by the database';
  end if;

  -- Exactly three flags, all born off, none killed -- and NOT a fourth for confirmed actions.
  select count(*) into v_count from private.flag_definitions
  where flag_key like 'assistant.%';
  if v_count <> 3 then
    raise exception '0164: expected exactly 3 assistant flags, found %', v_count;
  end if;
  select count(*) into v_count from private.flag_definitions
  where flag_key like 'assistant.%' and (default_state or kill_switch);
  if v_count > 0 then
    raise exception '0164: an assistant flag shipped on or killed';
  end if;

  -- The permission baseline is off and the CHECK that keeps it off exists.
  if not exists (
    select 1 from private.assistant_policy_definitions
    where policy_key = 'assistant.confirmed_actions'
      and baseline_enabled = false and kill_switch = false
  ) then
    raise exception '0164: the confirmed-actions policy baseline is not the off it must be';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'assistant_policy_definitions_baseline_off'
  ) then
    raise exception '0164: the baseline-off CHECK is missing -- baseline_enabled became a force-on lever';
  end if;

  -- Every plan resolves the run quota in the explicit UNKNOWN state that refuses rather than
  -- allows -- and no boolean assistant entitlement exists to reverse OPEN-DECISIONS #158.
  select count(*) into v_count from subscription_plans plan
  where not exists (
    select 1 from plan_entitlements entitlement
    where entitlement.plan_key = plan.plan_key
      and entitlement.entitlement_key = 'assistant_runs.monthly'
      and entitlement.unlimited = false and entitlement.numeric_limit is null);
  if v_count > 0 then
    raise exception '0164: % plan(s) whose assistant run quota is not the unknown-that-refuses state', v_count;
  end if;
  if exists (
    select 1 from private.entitlement_definitions
    where entitlement_key like 'assistant%' and kind = 'boolean'
  ) then
    raise exception '0164: a boolean assistant entitlement exists -- plans gate volume only (#158)';
  end if;

  -- The recording door ENFORCES at write time -- locked counter, asserted limit, counted event,
  -- one transaction (the 0155 call-site shape) -- and the preflight door reads the entitlement
  -- AND the rate.
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure(
      'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb)')
      and prosrc like '%usage_counter_locked%'
      and prosrc like '%assert_usage_within_limit%'
      and prosrc like '%record_usage_event%'
      and prosrc like '%assistant_assert_run_rate_limit%'
  ) then
    raise exception '0164: assistant_record_run does not lock, assert and count the quota at write time';
  end if;

  -- The Edge's context and totals reads exist, and the context read is definer-guarded (the
  -- conversation id it receives comes from the browser).
  if pg_catalog.to_regprocedure('public.assistant_conversation_context(uuid,integer)') is null
     or pg_catalog.to_regprocedure('public.assistant_run_totals()') is null then
    raise exception '0164: the Edge context/totals reads are missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.assistant_assert_run_allowed()')
      and prosrc like '%effective_entitlement%'
      and prosrc like '%assistant_assert_run_rate_limit%'
  ) then
    raise exception '0164: the preflight door skips the entitlement or the rate limit';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.assistant_assert_run_rate_limit()')
      and prosrc like '%assistant_rate_limited%'
  ) then
    raise exception '0164: the rate limit does not refuse by its named error';
  end if;

  -- The retention job is scheduled and the purge is callable against an empty ledger.
  select count(*) into v_count from cron.job
  where jobname = 'supplyflow-assistant-retention' and active;
  if v_count <> 1 then
    raise exception '0164: the assistant retention job is not scheduled and active (found %)', v_count;
  end if;

  v_result := private.purge_assistant_history();
  if v_result is null or (v_result ->> 'retention_days')::integer <> 90 then
    raise exception '0164 self-check: the purge returned %', v_result;
  end if;
end
$anchor_0164$;
