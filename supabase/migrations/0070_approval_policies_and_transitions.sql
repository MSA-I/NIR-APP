-- 0070 -- Approval policies (schema + evaluator, ZERO consumers) and the transition reader
-- (wave 9, PLAN-10 §2; OPEN-DECISIONS #104, #105).
--
-- ==========================================================================================
-- NOTHING IN THIS DATABASE CALLS evaluate_approval_policy(). THAT IS THE POINT, NOT AN
-- OVERSIGHT.
--
-- Wiring an approval policy into transition_payment_request or set_invoice_review_status would
-- silently re-decide OPEN-DECISIONS #2 -- who may approve money -- which is an open business
-- question. A wave that answers it in code, quietly, is exactly the failure this campaign
-- keeps catching. So this migration ships the vocabulary, the per-organization configuration,
-- the tighten-only law and a pure reader, and stops there. The precedent is wave 7: interfaces
-- and mocks with zero importers, declared in the file header (OPEN-DECISIONS #98).
--
-- The evaluator is also FORBIDDEN from appearing in any RLS USING / WITH CHECK expression and
-- in any role check inside an RPC (ENTERPRISE-SECURITY-MODEL.md:246-251, the same law that
-- keeps the feature-flag evaluator out of policies). supabase/tests/p9_five_domains.sql
-- asserts both structurally: if a later wave wires it, that assertion fails first and loudly.
--
-- THE TIGHTEN-ONLY LAW (OPEN-DECISIONS #104): a per-organization configuration may only make
-- a decision STRICTER than the global baseline -- more approvals, or a step-up where the
-- baseline had none. It may never reduce either. A configuration that could loosen a
-- requirement would be a permission grant wearing a configuration costume; this is the same
-- reasoning that gives a feature-flag kill switch "off only" semantics and no "force on"
-- counterpart (0059:29-32).
-- ==========================================================================================

-- ===== 1. Global vocabulary + baselines =====
-- Schema `private`, the flag_definitions shape (0059:24): platform vocabulary, owned by no
-- tenant, no org_id -- and therefore no scope_registry row, because A1 scans public base
-- tables only (the 0059:21-23 note).
--
-- The baselines are TODAY'S BEHAVIOUR, deliberately: one approver, no step-up. So even a
-- future consumer that honours a policy finds, for an organization with no configuration row,
-- exactly the rule the live commands already implement. The schema cannot change behaviour by
-- existing.
create table private.approval_policy_definitions (
  policy_key                  text primary key check (btrim(policy_key) <> ''),
  description                 text not null,
  baseline_required_approvals integer not null default 1
    check (baseline_required_approvals >= 1),
  baseline_step_up_required   boolean not null default false
);
revoke all on table private.approval_policy_definitions from public, anon, authenticated;

-- The two decision points a future consumer would plausibly govern. Naming a decision point
-- is not deciding it: neither row says WHO may approve, and #2 stays open.
insert into private.approval_policy_definitions
  (policy_key, description, baseline_required_approvals, baseline_step_up_required)
values
  ('payment_request.approval',
   'The decision that lets a payment request move on toward execution (0031:834). Baseline is '
   'the live rule: one approver holding a finance role, no separate re-authentication.',
   1, false),
  ('invoice_review.approval',
   'The decision that marks a supplier charge approved for payment (0023:1885). Baseline is '
   'the live rule: one approver holding a finance role.',
   1, false);

-- ===== 2. Per-organization configuration =====
-- Shape-1 (browser-readable), the org_flag_configurations reasoning (0059:41-44): tenant
-- members may SEE the configuration that governs them, the table holds no secret, and writes
-- are RPC-only.
create table approval_policy_configurations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  policy_key         text not null check (policy_key ~ '^[a-z0-9_.-]+$'),
  -- NULL = the requirement applies at every amount. A threshold can only ADD a requirement
  -- above itself; it never removes one below itself.
  threshold_amount   numeric(12,2) check (threshold_amount is null or threshold_amount >= 0),
  required_approvals integer not null default 1 check (required_approvals >= 1),
  step_up_required   boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One row per (organization, policy). A future consumer resolves one answer, not a stack.
  constraint approval_policy_configurations_org_key unique (org_id, policy_key)
  -- No FK to private.approval_policy_definitions ON PURPOSE, the 0059:66-68 reasoning: an
  -- orphaned configuration row must surface as a preflight anomaly
  -- (approval_policy_config_without_definition) rather than as a broken cascade the day a
  -- definition retires.
);

create trigger approval_policy_configurations_touch
  before update on approval_policy_configurations
  for each row execute function set_updated_at();

alter table approval_policy_configurations enable row level security;
create policy approval_policy_configurations_select on approval_policy_configurations
  for select to authenticated using (org_id = auth_org());
revoke all on table approval_policy_configurations from public, anon, authenticated;
grant select on table approval_policy_configurations to authenticated;

create trigger approval_policy_configurations_audit
  after insert or update or delete on approval_policy_configurations
  for each row execute function audit_row_change();

-- ===== 3. The one reasoned write command =====
-- Platform operator + mandatory reason + audit to the TARGET organization, in one transaction
-- -- platform_set_org_flag exactly (0059:232), and the same #86 answer to "who writes this":
-- the operator, not the owner, in this wave. A future owner-facing surface needs no schema
-- change, only a new reasoned RPC.
--
-- There is deliberately no "deactivate" parameter: with zero consumers, a switch nobody can
-- observe would be a dead column. Retiring a policy is a future reasoned command, like the
-- future owner surface.
--
-- The body names no enforced table, so A5 needs no exemption row -- the registry stays at 59.
create or replace function platform_set_approval_policy(
  p_org_id             uuid,
  p_policy_key         text,
  p_threshold_amount   numeric,
  p_required_approvals integer,
  p_step_up_required   boolean,
  p_reason             text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_policy_key, '')), '');
  v_definition private.approval_policy_definitions;
  v_id uuid;
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'approval_policy_reason_required' using errcode = '22023';
  end if;
  if p_org_id is null or v_key is null
     or p_required_approvals is null or p_step_up_required is null
     or p_required_approvals < 1
     or (p_threshold_amount is not null and p_threshold_amount < 0) then
    raise exception 'approval_policy_invalid' using errcode = '22023';
  end if;

  select * into v_definition
  from private.approval_policy_definitions d
  where d.policy_key = v_key;
  if not found then
    raise exception 'approval_policy_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  -- The tighten-only law (#104), enforced where the value enters the system. A configuration
  -- that asked for fewer approvals than the baseline, or that withdrew a baseline step-up,
  -- would be granting permission -- and configuration never grants.
  if p_required_approvals < v_definition.baseline_required_approvals
     or (v_definition.baseline_step_up_required and not p_step_up_required) then
    raise exception 'approval_policy_not_tightening' using errcode = '22023';
  end if;

  insert into approval_policy_configurations (
    org_id, policy_key, threshold_amount, required_approvals, step_up_required
  ) values (
    p_org_id, v_key, p_threshold_amount, p_required_approvals, p_step_up_required
  )
  on conflict (org_id, policy_key) do update
    set threshold_amount = excluded.threshold_amount,
        required_approvals = excluded.required_approvals,
        step_up_required = excluded.step_up_required,
        updated_at = now()
  returning id into v_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    p_org_id, v_actor, 'approval_policy_configured', 'approval_policy_configurations', v_id,
    jsonb_build_object(
      'policy_key', v_key,
      'threshold_amount', p_threshold_amount,
      'required_approvals', p_required_approvals,
      'step_up_required', p_step_up_required),
    v_reason
  );
  return v_id;
end
$$;

revoke all on function platform_set_approval_policy(uuid, text, numeric, integer, boolean, text)
  from public, anon;
grant execute on function platform_set_approval_policy(uuid, text, numeric, integer, boolean, text)
  to authenticated;

-- ===== 4. The evaluator -- pure, stable, INVOKER, and unwired =====
-- SECURITY INVOKER, and it stays that way: it reads exactly one public table under the
-- caller's own RLS, which is why it needs no definer rights, sits outside A5 entirely, and
-- cannot see another tenant's configuration even by accident. The private baselines are
-- deliberately NOT read here -- the baseline's only job is to bound a WRITE (§3), and reading
-- it would have forced this function to become a definer for no gain.
--
-- It returns a REQUIREMENT, never a verdict. There is no `allowed` column and there will not
-- be one: "may this person approve this" is #2, and #2 is open. With no configuration row the
-- numeric columns come back NULL -- a mark, not a zero (the campaign rule: an absent measure
-- shows a dash, because zero is also a claim). A caller would fall back to the command's own
-- rule, which is where the rule actually lives today.
--
-- ONE MORE TIME, because a reader three waves from now will be tempted: DO NOT CALL THIS FROM
-- A COMMAND, A POLICY, OR A ROLE CHECK.
create or replace function evaluate_approval_policy(
  p_policy_key text,
  p_amount     numeric
) returns table (
  policy_key         text,
  configured         boolean,
  applies            boolean,
  threshold_amount   numeric,
  required_approvals integer,
  step_up_required   boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_key text := nullif(btrim(coalesce(p_policy_key, '')), '');
begin
  if v_key is null then
    raise exception 'approval_policy_key_invalid' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'approval_policy_amount_invalid' using errcode = '22023';
  end if;

  return query
  select v_key,
         c.id is not null,
         c.id is not null
           and (c.threshold_amount is null or p_amount >= c.threshold_amount),
         c.threshold_amount,
         c.required_approvals,
         c.step_up_required
  from (select 1) probe
  left join approval_policy_configurations c
    on c.org_id = auth_org() and c.policy_key = v_key;
end
$$;

revoke all on function evaluate_approval_policy(text, numeric) from public, anon;
grant execute on function evaluate_approval_policy(text, numeric) to authenticated;

comment on function evaluate_approval_policy(text, numeric) is
  'Reads the caller organization''s approval-policy requirement for one policy key and one '
  'amount. SECURITY INVOKER, stable, side-effect free. NOTHING CALLS IT: wiring it into a '
  'financial command would re-decide OPEN-DECISIONS #2 (who may approve money). It must never '
  'appear in an RLS USING/WITH CHECK expression or a role check '
  '(ENTERPRISE-SECURITY-MODEL.md:246-251); p9_five_domains.sql asserts that structurally.';

-- ===== 5. read_allowed_transitions -- one source of truth for a status graph =====
-- THE DEFECT it closes (OPEN-DECISIONS #105): the invoice status graph is duplicated in the
-- browser (src/pages/InvoiceDetail.tsx:142-147) and the copy has drifted from the server. Two
-- matrices means one of them is wrong, and the wrong one is always the one further from the
-- data.
--
-- This function returns the graph as DATA. It is SECURITY INVOKER and it answers a question
-- about the MACHINE, not about the caller: "which next statuses would the command accept from
-- here". It deliberately does NOT say whether this caller may perform them -- role
-- authorization stays inside the commands, where it already is and where it is audited. A
-- reader that also answered "may I" would be a second permission surface.
--
-- Every row below mirrors a live command, cited. p9_five_domains.sql proves the mirror by
-- probing the real command for every ordered pair and comparing, so a future edit to a matrix
-- that forgets this table fails the gate instead of drifting:
--   invoice_review  -- set_invoice_review_status          (0023:1926-1931)
--   payment_request -- transition_payment_request         (0031:877-883)
--   credit_request  -- transition_credit_request          (0024:327-331)
--   purchase_order  -- transition_purchase_order_status   (0041:75-81)
--
-- Two honesty notes that travel with the contract:
--   * payment_request -> approved passes the graph and can still fail on the approval
--     preconditions inside the command. The graph allows it; the command decides it.
--   * cancelling an order is NOT in this graph: that is its own command,
--     cancel_purchase_order(). This reader describes the transition command's graph only.
-- A self-transition is never returned: every command treats "already there" as an idempotent
-- success, which is not a transition.
create or replace function read_allowed_transitions(
  p_entity_type    text,
  p_current_status text
) returns table (next_status text)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_entity text := nullif(btrim(coalesce(p_entity_type, '')), '');
  v_status text := nullif(btrim(coalesce(p_current_status, '')), '');
begin
  if v_entity is null or v_entity not in (
    'invoice_review', 'payment_request', 'credit_request', 'purchase_order'
  ) then
    raise exception 'allowed_transitions_entity_unknown' using errcode = 'P0002';
  end if;
  -- A blank, unrecognised or terminal status has no successor. Zero rows is the answer, not
  -- an error: a screen showing a finished record asks this question legitimately.
  if v_status is null then return; end if;

  return query
  select graph.to_status
  from (values
    -- invoice_review: the wildcard arm of 0023:1931 is why every status other than
    -- investigation may move INTO investigation -- including approved, which the browser
    -- copy hid (#105).
    ('invoice_review'::text,  'received'::text,            'in_review'::text),
    ('invoice_review',        'received',                   'investigation'),
    ('invoice_review',        'in_review',                  'pending_approval'),
    ('invoice_review',        'in_review',                  'approved'),
    ('invoice_review',        'in_review',                  'investigation'),
    ('invoice_review',        'pending_approval',           'approved'),
    ('invoice_review',        'pending_approval',           'investigation'),
    ('invoice_review',        'approved',                   'investigation'),
    ('invoice_review',        'investigation',              'pending_approval'),
    -- payment_request
    ('payment_request',       'draft',                      'pending_approval'),
    ('payment_request',       'draft',                      'investigation'),
    ('payment_request',       'draft',                      'cancelled'),
    ('payment_request',       'pending_approval',           'approved'),
    ('payment_request',       'pending_approval',           'investigation'),
    ('payment_request',       'pending_approval',           'cancelled'),
    ('payment_request',       'suspected_duplicate',        'approved'),
    ('payment_request',       'suspected_duplicate',        'investigation'),
    ('payment_request',       'suspected_duplicate',        'cancelled'),
    ('payment_request',       'investigation',              'approved'),
    ('payment_request',       'investigation',              'cancelled'),
    ('payment_request',       'approved',                   'sent_for_execution'),
    ('payment_request',       'approved',                   'cancelled'),
    ('payment_request',       'sent_for_execution',         'cancelled'),
    -- credit_request: a received credit is evidence from the supplier, not yet a financial
    -- offset, and cannot skip offset (0024:264-266).
    ('credit_request',        'open',                       'requested'),
    ('credit_request',        'open',                       'received'),
    ('credit_request',        'requested',                  'received'),
    ('credit_request',        'received',                   'offset'),
    ('credit_request',        'offset',                     'closed'),
    -- purchase_order: ready is the approval gate of 0053 (OPEN-DECISIONS #94).
    ('purchase_order',        'draft',                      'ready'),
    ('purchase_order',        'draft',                      'sent'),
    ('purchase_order',        'ready',                      'sent'),
    ('purchase_order',        'sent',                       'confirmed')
  ) as graph(entity_type, from_status, to_status)
  where graph.entity_type = v_entity
    and graph.from_status = v_status;
end
$$;

revoke all on function read_allowed_transitions(text, text) from public, anon;
grant execute on function read_allowed_transitions(text, text) to authenticated;

comment on function read_allowed_transitions(text, text) is
  'The status graph of the four reasoned transition commands, as data. SECURITY INVOKER; '
  'answers "which next statuses would the command accept from here", never "may I". The set '
  'is unordered by contract -- order it with the client vocabularies in src/lib/status.ts. '
  'p9_five_domains.sql probes the live commands for every ordered pair to prove the mirror.';

-- ===== 6. Registry (A1) + re-assert (the 0058:207-218 idiom, literal 0070) =====
-- org_global: an approval requirement is a rule of the organization, not of a branch or a
-- warehouse. A per-unit policy would be a real product decision, and it is not this one.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('approval_policy_configurations', 'org_global', false);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0070 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
