-- 0167 -- Token-based supplier order portal: links, structured proposals, and order revisions.
--
-- ==========================================================================================
-- WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
--
-- A supplier receives a link to ONE purchase order, reviews it on a phone, and either approves
-- it or proposes structured line-level changes (quantity, unit price, availability, replacement
-- text, delivery date, a note). The business then accepts or rejects each row, with a reason,
-- and may create a NEW order revision from the accepted changes. Nothing the supplier sends
-- ever mutates the original order -- the original order, the proposal and the decision are
-- three separate immutable facts.
--
-- This is NOT a revival of the supplier persona. 0127 retired it, 0133 removed every surface
-- and self-checks that none returns; PRODUCT.md names owner/office/accountant as the only
-- personas. The portal therefore authenticates with a high-entropy bearer token whose HASH is
-- the only thing stored -- the 0103 tenant-export shape, the third such door after invitations
-- (0007) and the dormant WhatsApp confirm token (0028). auth_role()/user_role are not touched.
--
-- Token discipline (0103:4057-4190 is the model):
--   * raw = encode(gen_random_bytes(32), 'hex'); stored = encode(sha256(raw), 'hex').
--   * The raw token is returned ONCE from issue_supplier_order_link to the issuing owner/office
--     user, who is about to hand it to the supplier anyway (WhatsApp text, email). It is never
--     stored, never logged, never in audit rows.
--   * Redemption is service_role-only (`service_*` functions below); the Edge Function
--     `supplier-portal` (verify_jwt=false) hashes the presented token and asks the DB. Failures
--     return empty, never raise -- an invalid token is indistinguishable from a revoked one.
--   * Expiry and revocation live in the WHERE clause of every read, never in app code.
--
-- Enumeration and brute force: 32 random bytes make guessing infeasible; that entropy is the
-- primary defense (0103 records the same reasoning). On top of it, every failed lookup is
-- ledgered in private.supplier_portal_lookup_failures for observability, and a link that
-- accumulates failed SUBMIT attempts locks itself (failed_attempts >= 20 -> locked for 1 hour).
-- Per-IP limiting is an Edge/CDN concern and is recorded as a documented gap
-- (ENTERPRISE-SECURITY-MODEL.md:271-274 already names public supplier submissions there).
--
-- Snapshot rule: the portal renders order_snapshot, captured at issue time -- the supplier
-- sees what was sent, even if the order is later cancelled or revised. The snapshot carries the
-- RAW product wording (products.name), per the supplier-naming rule of 0149:77-84: the
-- canonical display name never reaches a supplier, who recognises their own wording.
--
-- A5 / EXEMPTION PIN: three functions here touch purchase_orders (scope class branch,
-- ENFORCED): issue_supplier_order_link, decide_supplier_order_proposal and
-- create_purchase_order_revision_from_proposal. All three are authenticated commands with a
-- real JWT, so they self-enforce with assert_unit_in_scope on the order's unit and register in
-- private.scope_definer_enforcements (the 0137:2536 idiom, hash computed from the live
-- catalog). The service_* functions read only the new derived tables and the snapshot -- their
-- bodies never name the enforced table. The exemption registry does NOT move: the pin in
-- p9_five_domains.sql stays at 89 and check:exemptions agrees by arithmetic.
-- ==========================================================================================

-- ===== 1. Order revisions are new orders, chained =====
-- A revision is a NEW purchase_orders row pointing back at the order it replaces. The original
-- keeps its rows, its audit and its evidence; nothing is edited in place. purchase_order_items
-- stays append-only exactly as finalize left it.
alter table purchase_orders
  add column revision_number integer not null default 1 check (revision_number >= 1),
  add column revised_from_order_id uuid references purchase_orders(id);

comment on column purchase_orders.revision_number is
  '1 for an order created directly; n+1 for a revision created from a supplier proposal. '
  'The chain is revised_from_order_id; history is never edited in place.';

create index purchase_orders_revised_from_idx
  on purchase_orders (revised_from_order_id) where revised_from_order_id is not null;

-- ===== 2. The link =====
create table supplier_order_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  purchase_order_id uuid not null references purchase_orders(id),
  supplier_id uuid not null,
  -- sha256 hex of the raw token; the raw value exists only in the issuing response and in the
  -- supplier's hands. Shape-checked so a raw token can never be stored by mistake -- the same
  -- check cannot tell hash from raw (both are 64 hex), the discipline is in the functions.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  -- What the supplier sees. Captured at issue time; immutable (guard trigger below).
  order_snapshot jsonb not null,
  expires_at timestamptz not null,
  issued_by uuid not null,
  opened_at timestamptz,
  open_count integer not null default 0,
  submitted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, supplier_id) references suppliers (org_id, id)
);

create unique index supplier_order_links_token_hash_idx on supplier_order_links (token_hash);
-- One live link per order: issuing again first revokes the previous link (regeneration).
create unique index supplier_order_links_live_order_idx
  on supplier_order_links (purchase_order_id) where revoked_at is null;
create index supplier_order_links_org_order_idx on supplier_order_links (org_id, purchase_order_id);

create trigger supplier_order_links_touch
before update on supplier_order_links
for each row execute function public.set_updated_at();

-- ===== 3. The proposal: structured immutable evidence =====
create table supplier_order_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  -- One proposal per link. A new proposal round requires a new link (regeneration or revision),
  -- which is the "submit only once per proposal version" rule, enforced structurally.
  link_id uuid not null unique references supplier_order_links(id),
  purchase_order_id uuid not null references purchase_orders(id),
  supplier_id uuid not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'accepted', 'partially_accepted', 'rejected')),
  proposed_delivery_date date,
  supplier_note text check (char_length(supplier_note) <= 2000),
  -- Deduplicates provider/network retries of the same submission; a different payload for the
  -- same link is a conflict, not a second version.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  total_delta numeric(14,2) not null,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  decision_reason text,
  -- NULL until the internal reviewer decides on the proposed delivery date; meaningful only
  -- when proposed_delivery_date is not null.
  delivery_date_accepted boolean,
  revision_order_id uuid references purchase_orders(id),
  created_at timestamptz not null default now(),
  foreign key (org_id, supplier_id) references suppliers (org_id, id)
);

create index supplier_order_proposals_org_status_idx on supplier_order_proposals (org_id, status);
create index supplier_order_proposals_order_idx on supplier_order_proposals (purchase_order_id);

create table supplier_order_proposal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  proposal_id uuid not null references supplier_order_proposals(id),
  order_item_id uuid not null,
  position integer not null,
  -- Raw supplier-facing wording, snapshotted -- the 0149 rule: display_name never travels here.
  product_name text not null,
  unit text,
  original_qty numeric(12,2) not null,
  proposed_qty numeric(12,2) check (proposed_qty is null or (proposed_qty >= 0 and proposed_qty <= 1000000)),
  original_unit_price numeric(12,2) not null,
  proposed_unit_price numeric(12,2) check (proposed_unit_price is null or (proposed_unit_price >= 0 and proposed_unit_price <= 1000000)),
  availability text not null default 'available' check (availability in ('available', 'unavailable')),
  replacement_note text check (char_length(replacement_note) <= 500),
  -- Monetary delta of this row as proposed, server-computed: an unavailable row is minus its
  -- original total; otherwise proposed(qty x price) minus original(qty x price), coalescing a
  -- field the supplier left untouched to its original value. round(...,2) per the money rule.
  line_delta numeric(14,2) not null,
  decision text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  unique (proposal_id, order_item_id)
);

create index supplier_order_proposal_lines_proposal_idx on supplier_order_proposal_lines (proposal_id);

-- ===== 4. Immutability guards =====
-- Proposals are evidence. After INSERT, only the decision fields may ever change, and only the
-- reasoned commands below change them (no browser DML is granted at all; the trigger is
-- defense-in-depth against a future grant mistake, the documents_guard_columns idiom).
create function private.supplier_order_proposal_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier_order_proposal_immutable' using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'status' - 'decided_at' - 'decided_by' - 'decision_reason'
        - 'delivery_date_accepted' - 'revision_order_id')
     is distinct from
     (to_jsonb(old) - 'status' - 'decided_at' - 'decided_by' - 'decision_reason'
        - 'delivery_date_accepted' - 'revision_order_id') then
    raise exception 'supplier_order_proposal_immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function private.supplier_order_proposal_guard() from public, anon, authenticated;

create function private.supplier_order_proposal_line_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier_order_proposal_line_immutable' using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'decision') is distinct from (to_jsonb(old) - 'decision') then
    raise exception 'supplier_order_proposal_line_immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function private.supplier_order_proposal_line_guard() from public, anon, authenticated;

create trigger supplier_order_proposals_guard
before update or delete on supplier_order_proposals
for each row execute function private.supplier_order_proposal_guard();

create trigger supplier_order_proposal_lines_guard
before update or delete on supplier_order_proposal_lines
for each row execute function private.supplier_order_proposal_line_guard();

-- The snapshot and identity of a link are immutable; only lifecycle fields move.
create function private.supplier_order_link_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier_order_link_immutable' using errcode = '55000';
  end if;
  if (to_jsonb(new) - 'opened_at' - 'open_count' - 'submitted_at' - 'revoked_at' - 'revoked_by'
        - 'revoked_reason' - 'failed_attempts' - 'locked_until' - 'updated_at')
     is distinct from
     (to_jsonb(old) - 'opened_at' - 'open_count' - 'submitted_at' - 'revoked_at' - 'revoked_by'
        - 'revoked_reason' - 'failed_attempts' - 'locked_until' - 'updated_at') then
    raise exception 'supplier_order_link_immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function private.supplier_order_link_guard() from public, anon, authenticated;

create trigger supplier_order_links_guard
before update or delete on supplier_order_links
for each row execute function private.supplier_order_link_guard();

-- ===== 5. Failed-lookup ledger (observability; private, no browser surface) =====
create table private.supplier_portal_lookup_failures (
  id uuid primary key default gen_random_uuid(),
  seen_at timestamptz not null default now(),
  token_prefix text not null check (char_length(token_prefix) <= 8),
  source text
);
revoke all on table private.supplier_portal_lookup_failures from public, anon, authenticated;

-- ===== 6. RLS and grants =====
alter table supplier_order_links enable row level security;
alter table supplier_order_proposals enable row level security;
alter table supplier_order_proposal_lines enable row level security;

create policy supplier_order_links_select on supplier_order_links
  for select to authenticated using (org_id = auth_org());
create policy supplier_order_proposals_select on supplier_order_proposals
  for select to authenticated using (org_id = auth_org());
create policy supplier_order_proposal_lines_select on supplier_order_proposal_lines
  for select to authenticated using (org_id = auth_org());

-- Supabase default privileges grant ALL to anon/authenticated by name (0053:99-104); revoke,
-- then grant back reads only. token_hash is withheld from the browser entirely -- the 0112
-- column-privilege idiom: an internal user manages links, they never need the credential.
revoke all on table supplier_order_links from public, anon, authenticated;
grant select (id, org_id, purchase_order_id, supplier_id, order_snapshot, expires_at, issued_by,
              opened_at, open_count, submitted_at, revoked_at, revoked_by, revoked_reason,
              failed_attempts, locked_until, created_at, updated_at)
  on supplier_order_links to authenticated;

revoke all on table supplier_order_proposals from public, anon, authenticated;
grant select on supplier_order_proposals to authenticated;

revoke all on table supplier_order_proposal_lines from public, anon, authenticated;
grant select on supplier_order_proposal_lines to authenticated;

-- ===== 7. Issue / revoke (authenticated commands) =====

-- The portal-link expiry window. A documented guardrail, not a business rule
-- (OPEN-DECISIONS #184): default 14 days, clamped 1..60, per-org override in settings.
create function private.supplier_link_expiry_days(p_org uuid)
returns integer
language sql stable
set search_path = public
as $$
  select least(60, greatest(1, coalesce(
    (o.settings ->> 'supplier_link_expiry_days')::integer, 14)))
  from organizations o where o.id = p_org
$$;
revoke all on function private.supplier_link_expiry_days(uuid) from public, anon, authenticated;

create function issue_supplier_order_link(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_order purchase_orders;
  v_supplier_name text;
  v_raw text;
  v_expires timestamptz;
  v_link_id uuid;
  v_previous supplier_order_links;
  v_snapshot jsonb;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_order from purchase_orders o
  where o.id = p_order_id and o.org_id = v_org
  for update;
  if not found then
    raise exception 'order_unknown' using errcode = 'P0002';
  end if;
  perform assert_unit_in_scope(v_order.unit_id);
  if v_order.status not in ('ready', 'sent') then
    raise exception 'order_not_linkable' using errcode = '55000';
  end if;

  -- A submitted proposal that nobody decided on yet blocks a new round: deciding first keeps
  -- one open negotiation per order, so evidence and decisions stay pairable.
  if exists (
    select 1 from supplier_order_proposals pr
    where pr.purchase_order_id = v_order.id and pr.org_id = v_org and pr.status = 'submitted'
  ) then
    raise exception 'proposal_pending_decision' using errcode = '55000';
  end if;

  -- Regeneration: the previous live link dies the moment a new one is born.
  select * into v_previous from supplier_order_links l
  where l.purchase_order_id = v_order.id and l.revoked_at is null
  for update;
  if found then
    update supplier_order_links
    set revoked_at = statement_timestamp(), revoked_by = auth.uid(),
        revoked_reason = 'regenerated'
    where id = v_previous.id;
  end if;

  select s.name into v_supplier_name from suppliers s
  where s.id = v_order.supplier_id and s.org_id = v_org;

  -- The snapshot is everything the portal shows: raw wording (0149 supplier rule), quantities,
  -- snapshot unit prices, requested delivery date. Scoped to this one order -- no balances, no
  -- other suppliers, no tenant data beyond the org's display identity.
  select jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.number,
    'revision_number', v_order.revision_number,
    'expected_date', v_order.expected_date,
    'notes', v_order.notes,
    'supplier_name', v_supplier_name,
    'org_name', (select o.name from organizations o where o.id = v_org),
    'issued_at', statement_timestamp(),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'order_item_id', item.id,
      'position', item.position,
      'product_name', item.product_name,
      'unit', item.unit,
      'qty', item.qty,
      'unit_price', item.unit_price
    ) order by item.position), '[]'::jsonb))
  into v_snapshot
  from (
    select poi.id, poi.qty, poi.unit_price,
           p.name as product_name,
           coalesce(poi.unit_snapshot, p.unit) as unit,
           row_number() over (order by p.name, poi.id) as position
    from purchase_order_items poi
    join products p on p.id = poi.product_id
    where poi.order_id = v_order.id
  ) item;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := statement_timestamp()
    + make_interval(days => private.supplier_link_expiry_days(v_org));

  insert into supplier_order_links (
    org_id, purchase_order_id, supplier_id, token_hash, order_snapshot, expires_at, issued_by
  ) values (
    v_org, v_order.id, v_order.supplier_id,
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
    v_snapshot, v_expires, auth.uid()
  ) returning id into v_link_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, auth.uid(), 'supplier_order_link_issued', 'supplier_order_links', v_link_id,
    case when v_previous.id is null then null
         else jsonb_build_object('revoked_link_id', v_previous.id) end,
    jsonb_build_object('purchase_order_id', v_order.id, 'expires_at', v_expires),
    p_reason
  );

  return jsonb_build_object(
    'link_id', v_link_id, 'token', v_raw, 'expires_at', v_expires,
    'order_number', v_order.number);
end
$$;
revoke all on function issue_supplier_order_link(uuid, text) from public, anon;
grant execute on function issue_supplier_order_link(uuid, text) to authenticated;

comment on function issue_supplier_order_link(uuid, text) is
  'Mints the one live supplier-portal link for a purchase order (owner/office, reasoned). '
  'Returns the raw token exactly once; only its sha256 is stored. Re-issuing revokes the '
  'previous link. Refused while a submitted proposal awaits decision.';

create function revoke_supplier_order_link(p_link_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_link supplier_order_links;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select * into v_link from supplier_order_links l
  where l.id = p_link_id and l.org_id = v_org
  for update;
  if not found then
    raise exception 'link_unknown' using errcode = 'P0002';
  end if;
  if v_link.revoked_at is not null then
    raise exception 'link_already_revoked' using errcode = '55000';
  end if;

  update supplier_order_links
  set revoked_at = statement_timestamp(), revoked_by = auth.uid(), revoked_reason = p_reason
  where id = v_link.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'supplier_order_link_revoked', 'supplier_order_links', v_link.id,
          jsonb_build_object('purchase_order_id', v_link.purchase_order_id), p_reason);
end
$$;
revoke all on function revoke_supplier_order_link(uuid, text) from public, anon;
grant execute on function revoke_supplier_order_link(uuid, text) to authenticated;

-- ===== 8. Redemption (service_role, called only by the supplier-portal Edge Function) =====

create function service_resolve_supplier_order_link(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link supplier_order_links;
  v_proposal supplier_order_proposals;
  v_proposal_json jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select * into v_link from supplier_order_links l
  where l.token_hash = lower(p_token_hash)
    and l.revoked_at is null
    and l.expires_at >= statement_timestamp()
  for update;
  if not found then
    -- Ledgered for observability; pruned in-band so the ledger cannot grow without bound.
    delete from private.supplier_portal_lookup_failures
    where seen_at < statement_timestamp() - interval '30 days';
    insert into private.supplier_portal_lookup_failures (token_prefix, source)
    values (left(lower(coalesce(p_token_hash, '')), 8), 'resolve');
    return null;
  end if;
  if v_link.locked_until is not null and v_link.locked_until > statement_timestamp() then
    return jsonb_build_object('state', 'locked');
  end if;

  update supplier_order_links
  set opened_at = coalesce(opened_at, statement_timestamp()), open_count = open_count + 1
  where id = v_link.id;

  select * into v_proposal from supplier_order_proposals pr where pr.link_id = v_link.id;
  if found then
    v_proposal_json := jsonb_build_object(
      'status', v_proposal.status,
      'submitted_at', v_proposal.submitted_at,
      'proposed_delivery_date', v_proposal.proposed_delivery_date,
      'total_delta', v_proposal.total_delta);
  end if;

  return jsonb_build_object(
    'state', case when v_link.submitted_at is not null then 'submitted' else 'open' end,
    'snapshot', v_link.order_snapshot,
    'expires_at', v_link.expires_at,
    'proposal', v_proposal_json);
end
$$;
revoke all on function service_resolve_supplier_order_link(text) from public, anon, authenticated;
grant execute on function service_resolve_supplier_order_link(text) to service_role;

create function service_submit_supplier_order_proposal(p_token_hash text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_link supplier_order_links;
  v_existing supplier_order_proposals;
  v_payload_hash text;
  v_proposal_id uuid;
  v_delivery date;
  v_note text;
  v_line jsonb;
  v_item jsonb;
  v_seen uuid[] := '{}';
  v_item_id uuid;
  v_orig_qty numeric(12,2);
  v_orig_price numeric(12,2);
  v_proposed_qty numeric(12,2);
  v_proposed_price numeric(12,2);
  v_availability text;
  v_replacement text;
  v_delta numeric(14,2);
  v_total numeric(14,2) := 0;
  v_position integer;
  v_count integer := 0;
  v_parsed jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  -- Failures are ANSWERED, not raised (except the caller guard above): a raised exception rolls
  -- back this statement's own bookkeeping -- the failed-lookup ledger row, the failed-attempt
  -- counter, the lock -- which is exactly the evidence a failure must leave behind. The Edge
  -- Function translates the error code to the HTTP status; SQL keeps the side effects.
  if lower(coalesce(p_token_hash, '')) !~ '^[0-9a-f]{64}$' or p_payload is null then
    return jsonb_build_object('error', 'link_invalid');
  end if;

  select * into v_link from supplier_order_links l
  where l.token_hash = lower(p_token_hash)
    and l.revoked_at is null
    and l.expires_at >= statement_timestamp()
  for update;
  if not found then
    delete from private.supplier_portal_lookup_failures
    where seen_at < statement_timestamp() - interval '30 days';
    insert into private.supplier_portal_lookup_failures (token_prefix, source)
    values (left(lower(coalesce(p_token_hash, '')), 8), 'submit');
    return jsonb_build_object('error', 'link_invalid');
  end if;
  if v_link.locked_until is not null and v_link.locked_until > statement_timestamp() then
    return jsonb_build_object('error', 'link_locked');
  end if;

  v_payload_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  if v_link.submitted_at is not null then
    select * into v_existing from supplier_order_proposals pr where pr.link_id = v_link.id;
    -- A provider or network retry of the SAME submission is answered idempotently; a different
    -- payload on a spent link is a real conflict -- one proposal per link, by construction.
    if found and v_existing.payload_hash = v_payload_hash then
      return jsonb_build_object('proposal_id', v_existing.id, 'status', v_existing.status,
                                'replayed', true);
    end if;
    return jsonb_build_object('error', 'proposal_already_submitted');
  end if;

  -- Validate the payload against the snapshot: only items the supplier was shown, each at most
  -- once. Anything else fails the whole submission -- fail closed, count the attempt. The rows
  -- are parsed and totalled BEFORE anything is inserted, because the proposal row is immutable
  -- from the moment it exists (the guard above allows only decision fields to change), so
  -- total_delta must be final at insert time.
  begin
    v_delivery := nullif(p_payload ->> 'proposed_delivery_date', '')::date;
    v_note := nullif(trim(coalesce(p_payload ->> 'supplier_note', '')), '');
    if v_note is not null and char_length(v_note) > 2000 then
      raise exception 'note_too_long';
    end if;
    if jsonb_typeof(p_payload -> 'lines') <> 'array'
       or jsonb_array_length(p_payload -> 'lines') = 0 then
      raise exception 'lines_required';
    end if;

    for v_line in select * from jsonb_array_elements(p_payload -> 'lines') loop
      v_item_id := (v_line ->> 'order_item_id')::uuid;
      if v_item_id = any (v_seen) then
        raise exception 'line_duplicated';
      end if;
      v_seen := v_seen || v_item_id;

      select item into v_item
      from jsonb_array_elements(v_link.order_snapshot -> 'items') item
      where (item ->> 'order_item_id')::uuid = v_item_id;
      if v_item is null then
        raise exception 'line_not_in_order';
      end if;

      v_orig_qty := (v_item ->> 'qty')::numeric(12,2);
      v_orig_price := (v_item ->> 'unit_price')::numeric(12,2);
      v_position := (v_item ->> 'position')::integer;
      v_proposed_qty := nullif(v_line ->> 'proposed_qty', '')::numeric(12,2);
      v_proposed_price := nullif(v_line ->> 'proposed_unit_price', '')::numeric(12,2);
      v_availability := coalesce(nullif(v_line ->> 'availability', ''), 'available');
      v_replacement := nullif(trim(coalesce(v_line ->> 'replacement_note', '')), '');
      if v_availability not in ('available', 'unavailable') then
        raise exception 'availability_invalid';
      end if;

      if v_availability = 'unavailable' then
        v_delta := round(-(v_orig_qty * v_orig_price), 2);
      else
        v_delta := round(
          coalesce(v_proposed_qty, v_orig_qty) * coalesce(v_proposed_price, v_orig_price)
          - v_orig_qty * v_orig_price, 2);
      end if;
      v_total := v_total + v_delta;
      v_count := v_count + 1;

      v_parsed := v_parsed || jsonb_build_object(
        'order_item_id', v_item_id, 'position', v_position,
        'product_name', v_item ->> 'product_name', 'unit', v_item ->> 'unit',
        'original_qty', v_orig_qty, 'proposed_qty', v_proposed_qty,
        'original_unit_price', v_orig_price, 'proposed_unit_price', v_proposed_price,
        'availability', v_availability, 'replacement_note', v_replacement,
        'line_delta', v_delta);
    end loop;

    insert into supplier_order_proposals (
      org_id, link_id, purchase_order_id, supplier_id, proposed_delivery_date,
      supplier_note, payload_hash, total_delta
    ) values (
      v_link.org_id, v_link.id, v_link.purchase_order_id, v_link.supplier_id,
      v_delivery, v_note, v_payload_hash, round(v_total, 2)
    ) returning id into v_proposal_id;

    insert into supplier_order_proposal_lines (
      org_id, proposal_id, order_item_id, position, product_name, unit,
      original_qty, proposed_qty, original_unit_price, proposed_unit_price,
      availability, replacement_note, line_delta
    )
    select v_link.org_id, v_proposal_id,
           (parsed ->> 'order_item_id')::uuid, (parsed ->> 'position')::integer,
           parsed ->> 'product_name', parsed ->> 'unit',
           (parsed ->> 'original_qty')::numeric(12,2),
           nullif(parsed ->> 'proposed_qty', '')::numeric(12,2),
           (parsed ->> 'original_unit_price')::numeric(12,2),
           nullif(parsed ->> 'proposed_unit_price', '')::numeric(12,2),
           parsed ->> 'availability', nullif(parsed ->> 'replacement_note', ''),
           (parsed ->> 'line_delta')::numeric(14,2)
    from jsonb_array_elements(v_parsed) parsed;
  exception when others then
    -- The inner block's inserts are rolled back; the counter below is this statement's surviving
    -- record of the attempt. One counter for every malformed submission; 20 lock the link for an
    -- hour. Answered, not raised, so the bookkeeping commits.
    update supplier_order_links
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 20
                            then statement_timestamp() + interval '1 hour' end
    where id = v_link.id;
    return jsonb_build_object('error', 'proposal_invalid');
  end;

  update supplier_order_links set submitted_at = statement_timestamp() where id = v_link.id;

  -- A machine actor: user_id stays NULL, the 0077 convention for non-human writers.
  insert into audit_logs (org_id, action, entity_type, entity_id, new_values)
  values (
    v_link.org_id, 'supplier_order_proposal_submitted', 'supplier_order_proposals', v_proposal_id,
    jsonb_build_object('link_id', v_link.id, 'line_count', v_count,
                       'total_delta', round(v_total, 2),
                       'proposed_delivery_date', v_delivery));

  return jsonb_build_object('proposal_id', v_proposal_id, 'status', 'submitted');
end
$$;
revoke all on function service_submit_supplier_order_proposal(text, jsonb)
  from public, anon, authenticated;
grant execute on function service_submit_supplier_order_proposal(text, jsonb) to service_role;

-- ===== 9. The internal decision =====

create function decide_supplier_order_proposal(
  p_proposal_id uuid,
  p_line_decisions jsonb,
  p_accept_delivery_date boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_proposal supplier_order_proposals;
  v_order purchase_orders;
  v_decision jsonb;
  v_line_id uuid;
  v_verdict text;
  v_total integer;
  v_decided integer := 0;
  v_accepted integer := 0;
  v_rejected integer := 0;
  v_before jsonb;
  v_status text;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_proposal from supplier_order_proposals pr
  where pr.id = p_proposal_id and pr.org_id = v_org
  for update;
  if not found then
    raise exception 'proposal_unknown' using errcode = 'P0002';
  end if;
  if v_proposal.status <> 'submitted' then
    raise exception 'proposal_already_decided' using errcode = '55000';
  end if;

  select * into v_order from purchase_orders o
  where o.id = v_proposal.purchase_order_id and o.org_id = v_org;
  if not found then
    raise exception 'order_unknown' using errcode = 'P0002';
  end if;
  perform assert_unit_in_scope(v_order.unit_id);

  select count(*) into v_total from supplier_order_proposal_lines l
  where l.proposal_id = v_proposal.id;

  if p_line_decisions is null or jsonb_typeof(p_line_decisions) <> 'array' then
    raise exception 'decisions_invalid' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object('line_id', l.id, 'decision', l.decision) order by l.position)
    into v_before
  from supplier_order_proposal_lines l where l.proposal_id = v_proposal.id;

  for v_decision in select * from jsonb_array_elements(p_line_decisions) loop
    v_line_id := (v_decision ->> 'line_id')::uuid;
    v_verdict := v_decision ->> 'decision';
    if v_verdict not in ('accepted', 'rejected') then
      raise exception 'decisions_invalid' using errcode = '22023';
    end if;
    update supplier_order_proposal_lines
    set decision = v_verdict
    where id = v_line_id and proposal_id = v_proposal.id and decision = 'pending';
    if not found then
      raise exception 'decisions_invalid' using errcode = '22023';
    end if;
    v_decided := v_decided + 1;
    if v_verdict = 'accepted' then v_accepted := v_accepted + 1;
    else v_rejected := v_rejected + 1; end if;
  end loop;

  -- Every row gets an explicit verdict: a partially-decided proposal is not a state.
  if v_decided <> v_total then
    raise exception 'decisions_incomplete' using errcode = '22023';
  end if;

  -- A rejection -- of any row, or of a proposed delivery date -- must carry a reason.
  if (v_rejected > 0
      or (v_proposal.proposed_delivery_date is not null and not p_accept_delivery_date))
     and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'decision_reason_required' using errcode = '22023';
  end if;

  v_status := case
    when v_rejected = 0 then 'accepted'
    when v_accepted = 0 then 'rejected'
    else 'partially_accepted' end;

  update supplier_order_proposals
  set status = v_status,
      decided_at = statement_timestamp(),
      decided_by = auth.uid(),
      decision_reason = nullif(trim(coalesce(p_reason, '')), ''),
      delivery_date_accepted = case when v_proposal.proposed_delivery_date is null then null
                                    else p_accept_delivery_date end
  where id = v_proposal.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, auth.uid(), 'supplier_order_proposal_decided', 'supplier_order_proposals', v_proposal.id,
    jsonb_build_object('status', 'submitted', 'lines', v_before),
    jsonb_build_object('status', v_status, 'accepted', v_accepted, 'rejected', v_rejected,
                       'delivery_date_accepted', p_accept_delivery_date, 'lines', p_line_decisions),
    p_reason);

  return jsonb_build_object('status', v_status, 'accepted', v_accepted, 'rejected', v_rejected);
end
$$;
revoke all on function decide_supplier_order_proposal(uuid, jsonb, boolean, text) from public, anon;
grant execute on function decide_supplier_order_proposal(uuid, jsonb, boolean, text) to authenticated;

-- ===== 10. The revision =====

create function create_purchase_order_revision_from_proposal(p_proposal_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_proposal supplier_order_proposals;
  v_order purchase_orders;
  v_new_id uuid;
  v_line supplier_order_proposal_lines;
  v_qty numeric(12,2);
  v_price numeric(12,2);
  v_inserted integer := 0;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_proposal from supplier_order_proposals pr
  where pr.id = p_proposal_id and pr.org_id = v_org
  for update;
  if not found then
    raise exception 'proposal_unknown' using errcode = 'P0002';
  end if;
  if v_proposal.status not in ('accepted', 'partially_accepted') then
    raise exception 'proposal_not_accepted' using errcode = '55000';
  end if;
  if v_proposal.revision_order_id is not null then
    raise exception 'revision_already_created' using errcode = '55000';
  end if;

  select * into v_order from purchase_orders o
  where o.id = v_proposal.purchase_order_id and o.org_id = v_org
  for update;
  if not found then
    raise exception 'order_unknown' using errcode = 'P0002';
  end if;
  perform assert_unit_in_scope(v_order.unit_id);
  if v_order.status in ('partial', 'received', 'cancelled') then
    raise exception 'order_not_revisable' using errcode = '55000';
  end if;

  perform set_config('app.p1_financial_writer', auth.uid()::text, true);

  insert into purchase_orders (
    org_id, supplier_id, request_id, status, expected_date, notes, created_by, unit_id,
    revision_number, revised_from_order_id
  ) values (
    v_org, v_order.supplier_id, v_order.request_id, 'ready',
    case when v_proposal.proposed_delivery_date is not null
              and coalesce(v_proposal.delivery_date_accepted, false)
         then v_proposal.proposed_delivery_date
         else v_order.expected_date end,
    v_order.notes, auth.uid(), v_order.unit_id,
    v_order.revision_number + 1, v_order.id
  ) returning id into v_new_id;

  -- Accepted change -> the supplier's numbers; rejected change -> the original numbers; an
  -- ACCEPTED unavailability removes the row. A replacement suggestion is text on the proposal
  -- and never creates a catalog product (the 0093 rule: names alone are not identity).
  for v_line in
    select * from supplier_order_proposal_lines l
    where l.proposal_id = v_proposal.id
    order by l.position
  loop
    if v_line.decision = 'accepted' and v_line.availability = 'unavailable' then
      continue;
    end if;
    if v_line.decision = 'accepted' then
      v_qty := coalesce(v_line.proposed_qty, v_line.original_qty);
      v_price := coalesce(v_line.proposed_unit_price, v_line.original_unit_price);
    else
      v_qty := v_line.original_qty;
      v_price := v_line.original_unit_price;
    end if;
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    insert into purchase_order_items (org_id, order_id, product_id, qty, unit_price)
    select v_org, v_new_id, poi.product_id, v_qty, v_price
    from purchase_order_items poi
    where poi.id = v_line.order_item_id and poi.order_id = v_order.id;
    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  if v_inserted = 0 then
    raise exception 'revision_empty' using errcode = '55000';
  end if;

  update supplier_order_proposals set revision_order_id = v_new_id where id = v_proposal.id;

  -- The original is superseded, not edited: cancelled with the same reasoned command every
  -- other cancellation uses, so its audit trail is the standard one (OPEN-DECISIONS #185).
  perform cancel_purchase_order(v_order.id, p_reason || ' (הוחלפה ברוויזיה חדשה)');

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, auth.uid(), 'purchase_order_revision_created', 'purchase_orders', v_new_id,
    jsonb_build_object('revised_from_order_id', v_order.id, 'revision_number', v_order.revision_number),
    jsonb_build_object('revision_number', v_order.revision_number + 1,
                       'proposal_id', v_proposal.id, 'line_count', v_inserted),
    p_reason);

  return v_new_id;
end
$$;
revoke all on function create_purchase_order_revision_from_proposal(uuid, text) from public, anon;
grant execute on function create_purchase_order_revision_from_proposal(uuid, text) to authenticated;

-- ===== 11. Scope registries and A5 self-enforcement pins =====

insert into private.scope_registry (table_name, scope_class, enforced) values
  ('supplier_order_links', 'derived', false),
  ('supplier_order_proposals', 'derived', false),
  ('supplier_order_proposal_lines', 'derived', false);

-- The three commands above touch the ENFORCED purchase_orders table with a real caller JWT, so
-- they self-enforce (assert_unit_in_scope on the order's unit) and pin their bodies here --
-- the 0137:2536 idiom, hash computed from the live catalog. The exemption registry stays at 89.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('issue_supplier_order_link(uuid,text)', 'assert_unit',
    '0167 locks the tenant order and asserts its branch unit before snapshotting it into a link.'),
  ('decide_supplier_order_proposal(uuid,jsonb,boolean,text)', 'assert_unit',
    '0167 resolves the tenant order behind the proposal and asserts its unit before deciding.'),
  ('create_purchase_order_revision_from_proposal(uuid,text)', 'assert_unit',
    '0167 locks the original tenant order and asserts its unit before writing the revision.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict (function_signature) do update
set body_hash = excluded.body_hash, enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

-- ===== 12. Tenant export review (A6) =====
-- Every public table is a reviewed export decision (0103:193). The three new tables are tenant
-- business evidence and export INCLUDED — except token_hash, which is the fingerprint of a live
-- credential: an offboarding export must carry the link's lifecycle, never a value that helps
-- reconstruct or verify the secret. purchase_orders grew two columns, so its pinned schema hash
-- is refreshed by the same review.
insert into private.tenant_export_registry (
  table_name, disposition, excluded_columns, rationale
) values
  ('supplier_order_links', 'include', '{token_hash}',
   'Tenant supplier-portal link lifecycle evidence; the credential fingerprint itself is withheld.'),
  ('supplier_order_proposals', 'include', '{}',
   'Tenant supplier proposal evidence and the reasoned decisions on it.'),
  ('supplier_order_proposal_lines', 'include', '{}',
   'Tenant per-line supplier proposal evidence with computed monetary deltas.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    )
where registry.table_name in (
  'purchase_orders', 'supplier_order_links',
  'supplier_order_proposals', 'supplier_order_proposal_lines'
);

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0167 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
