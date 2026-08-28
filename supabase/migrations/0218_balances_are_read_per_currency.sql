-- 0218: the balance readers are replaced by name, so a caller that was not updated fails loudly.
--
-- 0217 gave every money row a currency. This file makes the readers say which currency they are
-- talking about, and it does that by DROPPING the old names rather than changing their bodies.
--
-- WHY DROP AND NOT `create or replace`. `src/lib/supabase.ts:44` builds the client with no schema
-- generic, and every row is read through a hand-written cast — `Suppliers.tsx:93` reads
-- `as { supplier_id: string; open_balance: number }[]`. A cast lies quietly. If
-- `p0_supplier_balance_rows()` kept its name and started returning one row per supplier PER
-- CURRENCY, all thirteen client call sites would still compile, the `Map` at `Suppliers.tsx:95`
-- would overwrite a supplier's shekel balance with their dollar balance, and the screen would show
-- one of two figures with nothing anywhere to say so. Renaming turns that into
-- `relation "supplier_balances" does not exist` — a loud failure at the first read, in every
-- caller at once. The noise is the point (plan §3.2).
--
--   p0_invoice_balance_rows()   ⇒ p0_invoice_balance_rows_by_currency()
--   p0_supplier_balance_rows()  ⇒ p0_supplier_balance_rows_by_currency()
--   invoice_balances            ⇒ invoice_balances_by_currency
--   supplier_balances           ⇒ supplier_balances_by_currency
--
-- THE FIELD NAMES MOVE TOO, and for the same reason: `balance` becomes `balance_in_currency` and
-- `open_balance` becomes `open_balance_in_currency`. A field that keeps its name and changes its
-- meaning is exactly what the cast hides. A reader that selects `balance` now gets a PostgREST
-- error naming the column instead of a number whose unit it has guessed.
--
-- WHAT A SUPPLIER WITH NO INVOICES RETURNS: nothing. The old function left-joined suppliers so
-- that every supplier produced a row, and a supplier with no invoices reported `0`. Grouping by
-- currency has no honest currency to put on that row, and inventing one — the organisation's base
-- currency, say — would state a balance in a currency the supplier has never traded in. No row is
-- the truthful answer, and the constitution already says what the screen must then draw: `—`,
-- never `0`.
--
-- WHAT THIS FILE DOES NOT DO: it does not touch the client (phase 3), it does not open `0108`
-- (phase 4), and it converts nothing.

-- ===== 1. The invoice ledger, per invoice, in the invoice's own currency =====
drop view if exists public.invoice_balances;
drop view if exists public.supplier_balances;
drop function if exists public.p0_supplier_balance_rows();
drop function if exists public.p0_invoice_balance_rows();

-- Body carried over from `p0_invoice_balance_rows` unchanged except for what the currency
-- requires: the currency is selected from the invoice, `balance` is renamed, and the casts follow
-- the columns to `numeric(14,3)`. The scope filter and the role arms are re-stated because what is
-- written here is what production gets — A5 covers this function through `auth_scopes()`, not
-- through an exemption, and a partial restatement is how that property gets dropped in silence.
--
-- The allocations need no grouping by currency of their own: 0217's composite foreign keys make an
-- allocation in a currency other than its invoice's unrepresentable, so every row summed here is
-- already in `i.currency`.
create function public.p0_invoice_balance_rows_by_currency()
returns table (
  invoice_id          uuid,
  currency            text,
  total_amount        numeric,
  paid_amount         numeric,
  credited_amount     numeric,
  balance_in_currency numeric
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with paid as (
    select pa.org_id, pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = auth_org() and pa.invoice_id is not null
    group by pa.org_id, pa.invoice_id
  ), credited as (
    select cr.org_id, cr.invoice_id, sum(pa.amount) as amount
    from public.credit_requests cr
    join public.payment_allocations pa
      on pa.org_id = cr.org_id and pa.credit_id = cr.id
    where cr.org_id = auth_org() and cr.invoice_id is not null
    group by cr.org_id, cr.invoice_id
  )
  select i.id,
         i.currency,
         i.total_amount,
         coalesce(p.amount, 0)::numeric(14,3),
         coalesce(c.amount, 0)::numeric(14,3),
         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(14,3)
  from public.invoices i
  left join paid p on p.org_id = i.org_id and p.invoice_id = i.id
  left join credited c on c.org_id = i.org_id and c.invoice_id = i.id
  where i.org_id = auth_org() and i.deleted_at is null
    and i.financial_role = 'payable'
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
    and (
      auth_role() = 'owner'
      or (auth_role() = 'accountant' and i.review_status = 'approved')
    )
$$;

comment on function public.p0_invoice_balance_rows_by_currency() is
  'What is still owed on each invoice, in the currency that invoice was printed in (0218, #277). '
  'Replaces p0_invoice_balance_rows(), which returned a bare `balance` with no unit. The '
  'allocations summed here cannot be in another currency — 0217''s composite keys make that '
  'unrepresentable — so the invoice''s own currency is the currency of the whole row.';

-- ===== 2. The supplier ledger, one row per supplier AND CURRENCY =====
-- This is the row that #277 is about: a supplier who trades in two currencies has two balances,
-- and nothing anywhere is allowed to add them.
create function public.p0_supplier_balance_rows_by_currency()
returns table (
  supplier_id              uuid,
  currency                 text,
  open_balance_in_currency numeric,
  open_invoices            bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with balances as (
    select * from public.p0_invoice_balance_rows_by_currency()
  )
  select s.id,
         i.currency,
         coalesce(sum(b.balance_in_currency), 0)::numeric(14,3),
         count(b.invoice_id) filter (where b.balance_in_currency > 0)
  from public.suppliers s
  join public.invoices i
    on i.org_id = s.org_id and i.supplier_id = s.id and i.deleted_at is null
   and i.financial_role = 'payable'
   and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  left join balances b on b.invoice_id = i.id
  where s.org_id = auth_org() and auth_role() in ('owner', 'accountant')
  group by s.id, i.currency
$$;

comment on function public.p0_supplier_balance_rows_by_currency() is
  'What each supplier is still owed, ONE ROW PER CURRENCY (0218, #277). A supplier with shekel and '
  'dollar invoices returns two rows and nothing may add them: a screen showing 15,500 for 12,400 ₪ '
  'plus 3,100 $ is a false number on a screen decisions are made from. A supplier with no invoices '
  'returns NO row rather than a zero in a currency they have never traded in — the screen draws '
  'an em dash, which is what the constitution requires of a metric with no data.';

create view public.invoice_balances_by_currency
with (security_invoker = on, security_barrier = on) as
  select * from public.p0_invoice_balance_rows_by_currency();

create view public.supplier_balances_by_currency
with (security_invoker = on, security_barrier = on) as
  select * from public.p0_supplier_balance_rows_by_currency();

-- The grants the dropped objects carried, restated. Read only for the browser: these are computed
-- ledgers and there has never been anything to write to them.
revoke all on function public.p0_invoice_balance_rows_by_currency() from public;
revoke all on function public.p0_supplier_balance_rows_by_currency() from public;
grant execute on function public.p0_invoice_balance_rows_by_currency() to authenticated, service_role;
grant execute on function public.p0_supplier_balance_rows_by_currency() to authenticated, service_role;

revoke all on table public.invoice_balances_by_currency from public, anon, authenticated;
revoke all on table public.supplier_balances_by_currency from public, anon, authenticated;
grant select on table public.invoice_balances_by_currency to authenticated, service_role;
grant select on table public.supplier_balances_by_currency to authenticated, service_role;

comment on view public.supplier_balances_by_currency is
  'The view the client reads (0218). Replaces supplier_balances, which is dropped rather than '
  'redefined so that a caller still asking for the old shape fails at the first read instead of '
  'quietly keeping one of a supplier''s two balances.';

-- A5 keeps a row per SECURITY DEFINER function that reads an enforced table, pinning the body it
-- was reviewed against. Renaming a function moves the row too: the old signatures are now stale
-- registrations and the new ones are uncovered definers, and A5 fails on both counts until this
-- runs. The hash is COMPUTED from `pg_proc` rather than written as a literal — a digest typed into
-- a migration is a value produced on a machine whose line endings may not match CI's (0141, and
-- the CRLF rollout that aborted at 0181).
delete from private.scope_definer_enforcements
where function_signature in ('p0_invoice_balance_rows()', 'p0_supplier_balance_rows()');

insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('p0_invoice_balance_rows_by_currency()', 'filtered_read',
    '0218 keeps 0137/0173''s filter unchanged -- payable invoices, auth_org, and the canonical '
    || 'null-or-auth_scopes legal-entity predicate -- and adds only the invoice''s own currency '
    || 'to the row and to the renamed balance column.'),
  ('p0_supplier_balance_rows_by_currency()', 'filtered_read',
    '0218 derives supplier balances only from payable invoices in null-or-auth_scopes scope, one '
    || 'row per supplier AND currency, and emits no row at all for a supplier with no invoices '
    || 'rather than a zero in a currency they have never traded in.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash, enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

-- ===== 3. Deleting a supplier asks the question per currency =====
--
-- The predicate was `sum(total - paid - credited) > 0` over ALL of a supplier's invoices. With one
-- currency that is a debt; with two it is an addition of unlike things, and it can go wrong in the
-- direction that matters: a credit balance in one currency can cancel a real debt in another and
-- let the supplier be deleted with money still owed. The question becomes "is there ANY currency
-- in which this supplier is still owed money", which is the question the guard was always asking.
--
-- Everything else in this function is 0036/0133's, restated in full rather than patched by anchor:
-- it is SECURITY DEFINER with a registered scope exemption, and a partial replacement is how a
-- security property gets dropped in silence. The exemption row keys on the signature, which does
-- not move.
create or replace function public.soft_delete_supplier(p_supplier_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_supplier public.suppliers;
  v_deleted_at timestamptz;
  v_owes_in_any_currency boolean := false;
  v_previous_writer text := coalesce(
    current_setting('app.p0_supplier_soft_delete_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office') then
    raise exception 'supplier_soft_delete_not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select s.* into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id and s.org_id = v_org
  for update;

  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;
  if v_supplier.deleted_at is not null then
    return jsonb_build_object(
      'supplier_id', v_supplier.id,
      'status', 'deleted',
      'idempotent', true
    );
  end if;

  -- Do not call the role-filtered balance helper here: office is intentionally excluded from
  -- that read surface. This SECURITY DEFINER command computes only the deletion predicate and
  -- returns no amount, preserving the office balance-oracle boundary.
  --
  -- financial_role = 'payable' mirrors the invoice balance reader so the guard and the supplier
  -- screen answer the same question. unit_id is deliberately NOT filtered -- see the header:
  -- deletion is organization-wide, so the debt it must not hide is organization-wide too.
  --
  -- 0218: grouped by currency, and the answer is EXISTS rather than a total. A single sum over two
  -- currencies can net a credit in one against a debt in the other and report zero, which would
  -- delete a supplier who is still owed money.
  with paid as (
    select pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = v_org and pa.invoice_id is not null
    group by pa.invoice_id
  ), credited as (
    select cr.invoice_id, sum(pa.amount) as amount
    from public.credit_requests cr
    join public.payment_allocations pa
      on pa.org_id = cr.org_id and pa.credit_id = cr.id
    where cr.org_id = v_org and cr.invoice_id is not null
    group by cr.invoice_id
  ), per_currency as (
    select i.currency,
           coalesce(sum(i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0)), 0) as open_balance
    from public.invoices i
    left join paid p on p.invoice_id = i.id
    left join credited c on c.invoice_id = i.id
    where i.org_id = v_org
      and i.supplier_id = v_supplier.id
      and i.deleted_at is null
      and i.financial_role = 'payable'
    group by i.currency
  )
  select exists (select 1 from per_currency where open_balance > 0)
  into v_owes_in_any_currency;

  if v_owes_in_any_currency then
    raise exception 'supplier_has_open_balance' using errcode = 'P0001';
  end if;

  -- 'draft' joins the terminal statuses (owner decision, 19.08.2026): an order that was never
  -- sent commits the business to nothing. src/pages/Suppliers.tsx mirrors this list.
  if exists (
    select 1
    from public.purchase_orders po
    where po.org_id = v_org
      and po.supplier_id = v_supplier.id
      and po.status not in ('draft', 'received', 'cancelled')
  ) then
    raise exception 'supplier_has_active_orders' using errcode = 'P0001';
  end if;

  perform set_config('app.p0_supplier_soft_delete_writer', v_user::text, true);
  begin
    update public.suppliers
    set deleted_at = clock_timestamp()
    where id = v_supplier.id and org_id = v_org
    returning deleted_at into v_deleted_at;
  exception when others then
    perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'supplier_deleted',
    'suppliers',
    v_supplier.id,
    jsonb_build_object('deleted_at', v_supplier.deleted_at),
    jsonb_build_object('deleted_at', v_deleted_at),
    v_reason
  );

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'status', 'deleted',
    'idempotent', false
  );
end
$$;


-- ===== 4. The dashboard stops returning a single number for money =====
--
-- Six money figures on this screen were scalars: the open balance, the two payment-request
-- windows, the open credits, the two order commitments, and the six biggest supplier balances.
-- Each becomes an ARRAY OF `{currency, amount}`, ordered with the organisation's own currency
-- first and the rest by ISO code — an order derived from the data, never from insertion order.
--
-- EVERY MONEY KEY IS RENAMED (`openBalance` ⇒ `openBalanceByCurrency`, and so on) for the same
-- reason the functions above were: a client reading the old key would otherwise receive an array
-- where it expected a number, and a formatter would render SOMETHING rather than fail. An absent
-- key reaches the null branch this screen already draws as `—`.
--
-- THE COUNTS DO NOT SPLIT. "How many invoices are waiting for approval" is a count of documents,
-- and a count means the same thing in every currency. Only money splits.
--
-- The `null`-means-unknown mechanism is unchanged and deliberately not re-invented: where the old
-- body returned `null` because coverage was partial, this one still does, and the client still
-- draws `—` with an explanation rather than a partial zero.
create or replace function public.management_dashboard_snapshot(p_today date)
returns jsonb
language sql
stable strict
set search_path to 'public', 'pg_temp'
as $$
  with actor as (
    select public.auth_org() as org_id
    where public.auth_role() in ('owner', 'office')
  ),
  -- The organisation's own currency decides only the ORDER of the rows. It is never a conversion
  -- target and never a fallback for a figure that is in some other currency.
  base as (
    select o.base_currency
    from public.organizations o
    join actor a on a.org_id = o.id
  ),
  invoice_balance_metrics as (
    select
      count(*)::int as source_count,
      count(*) filter (where ib.balance_in_currency > 0)::int as open_invoice_count
    from public.invoice_balances_by_currency ib, actor
  ),
  invoice_balance_money as (
    select ib.currency,
           coalesce(sum(greatest(ib.balance_in_currency, 0)), 0)::numeric as amount,
           count(*) filter (where ib.balance_in_currency > 0)::int as invoice_count
    from public.invoice_balances_by_currency ib, actor
    group by ib.currency
  ),
  payment_request_metrics as (
    select
      count(*) filter (where status = 'pending_approval')::int as pending_approval,
      count(*) filter (where status = 'draft')::int as drafts,
      count(*) filter (
        where due_date is not null and status not in ('draft', 'executed', 'matched', 'cancelled')
      )::int as active_due_dated,
      count(*) filter (
        where status not in ('executed', 'matched', 'cancelled')
      )::int as active_total,
      count(*) filter (
        where due_date < p_today and status not in ('draft', 'executed', 'matched', 'cancelled')
      )::int as overdue,
      count(*) filter (
        where due_date = p_today and status not in ('draft', 'executed', 'matched', 'cancelled')
      )::int as due_today,
      count(*) filter (
        where due_date between p_today and p_today + 6
          and status not in ('draft', 'executed', 'matched', 'cancelled')
      )::int as due_within_7
    from public.payment_requests p
    join actor a on a.org_id = p.org_id
    where p.unit_id is null or p.unit_id = any(public.auth_scopes())
  ),
  payment_request_money as (
    select p.currency,
      coalesce(sum(p.amount) filter (
        where p.due_date < p_today and p.status not in ('draft', 'executed', 'matched', 'cancelled')
      ), 0)::numeric as overdue_amount,
      coalesce(sum(p.amount) filter (
        where p.due_date between p_today and p_today + 6
          and p.status not in ('draft', 'executed', 'matched', 'cancelled')
      ), 0)::numeric as due_within_7_amount
    from public.payment_requests p
    join actor a on a.org_id = p.org_id
    where p.unit_id is null or p.unit_id = any(public.auth_scopes())
    group by p.currency
  ),
  credit_metrics as (
    select count(*)::int as open_count
    from public.credit_requests c
    join actor a on a.org_id = c.org_id
    where c.status in ('open', 'requested', 'received')
  ),
  credit_money as (
    select c.currency, coalesce(sum(c.amount), 0)::numeric as amount
    from public.credit_requests c
    join actor a on a.org_id = c.org_id
    where c.status in ('open', 'requested', 'received')
    group by c.currency
  ),
  bank_metrics as (
    select
      count(*) filter (where b.status = 'unmatched')::int as unmatched,
      count(*) filter (where b.status = 'suggested')::int as suggested
    from public.bank_transactions b
    join actor a on a.org_id = b.org_id
  ),
  invoice_metrics as (
    select
      count(*) filter (where i.review_status = 'pending_approval')::int as pending_approval,
      count(*) filter (where i.review_status in ('received', 'in_review'))::int as to_review,
      count(*) filter (
        where i.review_status = 'approved' and i.export_status = 'not_sent'
      )::int as not_sent
    from public.invoices i
    join actor a on a.org_id = i.org_id
    where i.deleted_at is null and i.financial_role = 'payable'
  ),
  -- An order's line prices are in the order's currency: 0217 gives the head the column and the
  -- lines inherit it, because a purchase order is not placed in two currencies.
  open_orders as (
    select
      po.id,
      po.currency,
      po.status,
      po.expected_date,
      coalesce(sum(poi.qty * poi.unit_price), 0)::numeric as committed,
      coalesce(sum(greatest(0, poi.qty - poi.received_qty) * poi.unit_price), 0)::numeric as remaining
    from public.purchase_orders po
    join actor a on a.org_id = po.org_id
    left join public.purchase_order_items poi on poi.order_id = po.id
    where po.status in ('sent', 'confirmed', 'partial')
    group by po.id, po.currency, po.status, po.expected_date
  ),
  open_order_metrics as (
    select
      count(*)::int as open_count,
      count(*) filter (where expected_date is null)::int as no_date,
      count(*) filter (where expected_date < p_today)::int as late,
      count(*) filter (where status = 'sent')::int as awaiting_confirmation
    from open_orders
  ),
  open_order_money as (
    select currency,
           coalesce(sum(committed), 0)::numeric as committed,
           coalesce(sum(remaining), 0)::numeric as remaining
    from open_orders
    group by currency
  ),
  supplier_balance_rows as (
    select sb.supplier_id, sb.currency, s.name, sb.open_balance_in_currency
    from public.supplier_balances_by_currency sb
    join public.suppliers s on s.id = sb.supplier_id
    join actor a on a.org_id = s.org_id
    where sb.open_balance_in_currency > 0
  ),
  -- A supplier owed money in two currencies is ONE supplier who needs attention, not two.
  supplier_balance_metrics as (
    select count(distinct supplier_id)::int as open_supplier_count from supplier_balance_rows
  ),
  -- Six per currency, because "the six biggest" across two currencies is a ranking of unlike
  -- numbers — the same false comparison as the sum, wearing an ordering instead of a total.
  ranked_supplier_balances as (
    select r.*,
           row_number() over (
             partition by r.currency
             order by r.open_balance_in_currency desc, r.supplier_id
           ) as rank_in_currency
    from supplier_balance_rows r
  ),
  top_balances as (
    select coalesce(jsonb_agg(
      jsonb_build_object('currency', grouped.currency, 'rows', grouped.rows)
      order by (grouped.currency = (select base_currency from base)) desc, grouped.currency
    ), '[]'::jsonb) as rows
    from (
      select rsb.currency,
             jsonb_agg(jsonb_build_object(
               'id', rsb.supplier_id,
               'name', rsb.name,
               'balance', rsb.open_balance_in_currency
             ) order by rsb.open_balance_in_currency desc, rsb.supplier_id) as rows
      from ranked_supplier_balances rsb
      where rsb.rank_in_currency <= 6
      group by rsb.currency
    ) grouped
  )
  select case when exists (select 1 from actor) then jsonb_build_object(
    'money', jsonb_build_object(
      'openBalanceByCurrency', case when ib.source_count > 0 then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'currency', m.currency, 'amount', m.amount, 'invoiceCount', m.invoice_count
        ) order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
        from invoice_balance_money m
      ) else null end,
      'openInvoiceCount', ib.open_invoice_count
    ),
    'paymentRequests', jsonb_build_object(
      'pendingApproval', pr.pending_approval,
      'drafts', pr.drafts,
      'dueDateCoverage', pr.active_due_dated,
      'activeCount', pr.active_total,
      -- Measure only explicitly dated active requests. Undated active rows do not suppress a
      -- valid measurement, while zero dated rows remains unknown (JSON null), never a fake zero.
      'overdue', case
        when pr.active_due_dated > 0 then pr.overdue
        else null
      end,
      'dueToday', case
        when pr.active_due_dated > 0 then pr.due_today
        else null
      end,
      -- 0148: the money, under the same evidence guard as the counts above. The per-currency rows
      -- turn "dated requests exist, none in this window" into a measured 0 for each currency that
      -- has any request at all; the guard keeps "no dated request at all" as null.
      'overdueAmountByCurrency', case
        when pr.active_due_dated > 0 then (
          select coalesce(jsonb_agg(jsonb_build_object('currency', m.currency, 'amount', m.overdue_amount)
            order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
          from payment_request_money m
        ) else null end,
      'dueWithin7AmountByCurrency', case
        when pr.active_due_dated > 0 then (
          select coalesce(jsonb_agg(jsonb_build_object('currency', m.currency, 'amount', m.due_within_7_amount)
            order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
          from payment_request_money m
        ) else null end,
      'dueWithin7Count', case
        when pr.active_due_dated > 0 then pr.due_within_7
        else null
      end
    ),
    'credits', jsonb_build_object(
      'count', cr.open_count,
      'sumByCurrency', case when cr.open_count > 0 then (
        select coalesce(jsonb_agg(jsonb_build_object('currency', m.currency, 'amount', m.amount)
          order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
        from credit_money m
      ) else null end
    ),
    'bank', jsonb_build_object('unmatched', bm.unmatched, 'suggested', bm.suggested),
    'invoices', jsonb_build_object(
      'pendingApproval', im.pending_approval,
      'toReview', im.to_review,
      'notSent', im.not_sent
    ),
    'openOrders', jsonb_build_object(
      'count', oom.open_count,
      'committedByCurrency', case when oom.open_count > 0 then (
        select coalesce(jsonb_agg(jsonb_build_object('currency', m.currency, 'amount', m.committed)
          order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
        from open_order_money m
      ) else null end,
      'remainingByCurrency', (
        select coalesce(jsonb_agg(jsonb_build_object('currency', m.currency, 'amount', m.remaining)
          order by (m.currency = (select base_currency from base)) desc, m.currency), '[]'::jsonb)
        from open_order_money m
      ),
      'noDate', oom.no_date,
      'late', oom.late,
      'awaitingConfirmation', oom.awaiting_confirmation
    ),
    'openSupplierCount', sbm.open_supplier_count,
    'topBalancesByCurrency', tb.rows
  ) else null end
  from invoice_balance_metrics ib
  cross join payment_request_metrics pr
  cross join credit_metrics cr
  cross join bank_metrics bm
  cross join invoice_metrics im
  cross join open_order_metrics oom
  cross join supplier_balance_metrics sbm
  cross join top_balances tb
$$;

comment on function public.management_dashboard_snapshot(date) is
  'The management dashboard read model (0100, per-currency since 0218). Every money figure is an '
  'array of {currency, amount} ordered with the organisation''s own currency first; counts stay '
  'scalar because a count means the same thing in every currency. Nothing here adds two '
  'currencies, and a metric that cannot be measured is still null rather than a partial zero.';

-- ===== 5. Proof =====
do $assert_0218$
declare
  v_violations text;
  v_count      integer;
begin
  -- The old names are gone, so an un-migrated caller fails at the first read.
  if to_regprocedure('public.p0_supplier_balance_rows()') is not null
     or to_regprocedure('public.p0_invoice_balance_rows()') is not null then
    raise exception '0218: an old balance reader is still callable';
  end if;
  if to_regclass('public.supplier_balances') is not null
     or to_regclass('public.invoice_balances') is not null then
    raise exception '0218: an old balance view still exists';
  end if;

  -- The new ones are, with the currency on the row and the renamed balance column.
  if to_regprocedure('public.p0_supplier_balance_rows_by_currency()') is null
     or to_regprocedure('public.p0_invoice_balance_rows_by_currency()') is null then
    raise exception '0218: a by-currency balance reader is missing';
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and (table_name, column_name) in (
      ('invoice_balances_by_currency', 'currency'),
      ('invoice_balances_by_currency', 'balance_in_currency'),
      ('supplier_balances_by_currency', 'currency'),
      ('supplier_balances_by_currency', 'open_balance_in_currency'));
  if v_count <> 4 then
    raise exception '0218: % of the 4 renamed balance columns exist', v_count;
  end if;

  -- The dashboard no longer offers a scalar under any of the money keys it used to.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'management_dashboard_snapshot'
    and (p.prosrc ~ '''openBalance''' or p.prosrc ~ '''overdueAmount'''
         or p.prosrc ~ '''dueWithin7Amount''' or p.prosrc ~ '''topBalances''');
  if v_count <> 0 then
    raise exception '0218: the dashboard still exposes a single-currency money key';
  end if;

  -- 0058:207-218: the standing contracts are re-asserted where they can still be fixed cheaply.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0218 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0218 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0218$;
