-- Open-credit approval policy regression harness.
-- Run against the isolated local database after migration 0053.
\set ON_ERROR_STOP on

begin;

create function pg_temp.credit_override_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'payment credit override assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('90000000-0000-4000-8000-000000000001', 'Credit tenant A', 'active'),
  ('90000000-0000-4000-8000-000000000002', 'Credit tenant B', 'active');

insert into auth.users (id, email) values
  ('91000000-0000-4000-8000-000000000001', 'credit-owner-a@example.test'),
  ('91000000-0000-4000-8000-000000000002', 'credit-office-a@example.test'),
  ('91000000-0000-4000-8000-000000000003', 'credit-payer-a@example.test'),
  ('91000000-0000-4000-8000-000000000004', 'credit-accountant-a@example.test'),
  ('91000000-0000-4000-8000-000000000005', 'credit-kitchen-a@example.test'),
  ('91000000-0000-4000-8000-000000000006', 'credit-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Credit owner A', 'owner'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', 'Credit office A', 'office'),
  ('91000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', 'Credit payer A', 'payer'),
  ('91000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000001', 'Credit accountant A', 'accountant'),
  ('91000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000001', 'Credit kitchen A', 'kitchen'),
  ('91000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000002', 'Credit owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('92000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Supplier with credits'),
  ('92000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', 'Supplier without credits'),
  ('92000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000002', 'Other tenant supplier');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('93000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'CREDIT-1', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'CREDIT-2', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'CREDIT-3', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'CREDIT-4', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'CREDIT-5', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000002', 'NO-CREDIT', '2026-08-01', 100, 0, 100, 'approved'),
  ('93000000-0000-4000-8000-000000000020', '90000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000003', 'TENANT-B', '2026-08-01', 100, 0, 100, 'approved');

insert into public.payment_requests (
  id, org_id, supplier_id, amount, status, created_by
) values
  ('95000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 100, 'pending_approval', '91000000-0000-4000-8000-000000000001'),
  ('95000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 100, 'pending_approval', '91000000-0000-4000-8000-000000000002'),
  ('95000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 100, 'pending_approval', '91000000-0000-4000-8000-000000000001'),
  ('95000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 100, 'pending_approval', '91000000-0000-4000-8000-000000000001'),
  ('95000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 100, 'draft', '91000000-0000-4000-8000-000000000001'),
  ('95000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000002', 100, 'pending_approval', '91000000-0000-4000-8000-000000000001'),
  ('95000000-0000-4000-8000-000000000020', '90000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000003', 100, 'pending_approval', '91000000-0000-4000-8000-000000000006');

insert into public.payment_request_invoices (
  org_id, payment_request_id, invoice_id, amount_allocated
) values
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 100),
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000002', 100),
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', '93000000-0000-4000-8000-000000000003', 100),
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000004', '93000000-0000-4000-8000-000000000004', 100),
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000005', '93000000-0000-4000-8000-000000000005', 100),
  ('90000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000010', '93000000-0000-4000-8000-000000000010', 100),
  ('90000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000020', '93000000-0000-4000-8000-000000000020', 100);

insert into public.credit_requests (
  id, org_id, supplier_id, reason, amount, status, created_by
) values
  ('94000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'other', 30, 'open', '91000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'other', 20, 'requested', '91000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'other', 10, 'received', '91000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'other', 40, 'offset', '91000000-0000-4000-8000-000000000001');

create temp table credit_state_before as
select id, status, amount, resolved_at
from public.credit_requests
where supplier_id = '92000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
set local role authenticated;

-- No open credits: the existing ordinary approval command still works.
select pg_temp.credit_override_assert(
  (public.transition_payment_request(
    '95000000-0000-4000-8000-000000000010', 'approved', 'ordinary approval'
  )->>'idempotent')::boolean = false,
  'ordinary approval without open credits failed'
);
select pg_temp.credit_override_assert(
  (select status = 'approved'
          and open_credit_override_total is null
          and amount = 100
   from public.payment_requests where id = '95000000-0000-4000-8000-000000000010'),
  'ordinary approval changed amount or wrote override context'
);

-- Open credits: the ordinary server command rejects approval.
do $$
begin
  perform public.transition_payment_request(
    '95000000-0000-4000-8000-000000000001', 'approved', 'must be blocked'
  );
  raise exception 'expected payment_request_credit_override_required';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%payment_request_credit_override_required%' then raise; end if;
end
$$;

-- Missing reason is rejected before any mutation.
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001', 60, '   '
  );
  raise exception 'expected payment_request_credit_override_invalid';
exception when sqlstate '22023' then
  if sqlerrm not like '%payment_request_credit_override_invalid%' then raise; end if;
end
$$;

-- The explicit owner override succeeds and records the approval-time values.
select pg_temp.credit_override_assert(
  (public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001', 60,
    'Reviewed the unallocated supplier credits'
  )->>'open_credit_override')::boolean,
  'valid explicit override did not succeed'
);
select pg_temp.credit_override_assert(
  (select status = 'approved'
          and approved_by = '91000000-0000-4000-8000-000000000001'
          and amount = 100
          and open_credit_override_total = 60
          and open_credit_override_reason = 'Reviewed the unallocated supplier credits'
          and open_credit_override_at is not null
   from public.payment_requests where id = '95000000-0000-4000-8000-000000000001'),
  'override columns do not preserve the decision context'
);
select pg_temp.credit_override_assert(
  exists (
    select 1 from public.audit_logs a
    where a.org_id = '90000000-0000-4000-8000-000000000001'
      and a.user_id = '91000000-0000-4000-8000-000000000001'
      and a.action = 'payment_request_transitioned'
      and a.entity_type = 'payment_requests'
      and a.entity_id = '95000000-0000-4000-8000-000000000001'
      and a.reason = 'Reviewed the unallocated supplier credits'
      and a.new_values ->> 'approving_user_id' = '91000000-0000-4000-8000-000000000001'
      and a.new_values ->> 'organization_id' = '90000000-0000-4000-8000-000000000001'
      and a.new_values ->> 'supplier_id' = '92000000-0000-4000-8000-000000000001'
      and a.new_values ->> 'payment_request_id' = '95000000-0000-4000-8000-000000000001'
      and (a.new_values ->> 'open_credit_override')::boolean
      and (a.new_values ->> 'open_credit_total')::numeric = 60
      and (a.new_values ->> 'payment_request_amount')::numeric = 100
      and a.new_values ->> 'override_reason' = 'Reviewed the unallocated supplier credits'
      and nullif(a.new_values ->> 'approved_at', '') is not null
      and a.created_at is not null
  ),
  'override audit is missing an approval-time value'
);
select pg_temp.credit_override_assert(
  (select count(*) = 1
   from public.audit_logs a
   where a.action = 'payment_request_transitioned'
     and a.entity_id = '95000000-0000-4000-8000-000000000001'),
  'override did not preserve exactly one reasoned transition audit event'
);

-- A second identical call is idempotent and creates no new update/audit rows.
create temp table credit_override_audit_count as
select count(*)::bigint as value
from public.audit_logs
where entity_type = 'payment_requests'
  and entity_id = '95000000-0000-4000-8000-000000000001';
select pg_temp.credit_override_assert(
  (public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001', 60,
    'Reviewed the unallocated supplier credits'
  )->>'idempotent')::boolean,
  'exact override replay was not idempotent'
);
select pg_temp.credit_override_assert(
  (select count(*) = (select value from credit_override_audit_count)
   from public.audit_logs
   where entity_type = 'payment_requests'
     and entity_id = '95000000-0000-4000-8000-000000000001'),
  'override replay duplicated an audit event'
);

-- The existing credits and request amount are untouched.
select pg_temp.credit_override_assert(
  (select count(*) = 4
          and sum(amount) filter (where status in ('open', 'requested', 'received')) = 60
          and count(*) filter (where status = 'offset' and amount = 40) = 1
   from public.credit_requests
   where supplier_id = '92000000-0000-4000-8000-000000000001'),
  'approval modified, closed or allocated an existing credit'
);
select pg_temp.credit_override_assert(
  not exists (
    select id, status, amount, resolved_at from credit_state_before
    except
    select id, status, amount, resolved_at from public.credit_requests
    where supplier_id = '92000000-0000-4000-8000-000000000001'
  ) and not exists (
    select id, status, amount, resolved_at from public.credit_requests
    where supplier_id = '92000000-0000-4000-8000-000000000001'
    except
    select id, status, amount, resolved_at from credit_state_before
  ),
  'approval changed an open-credit row'
);
select pg_temp.credit_override_assert(
  not exists (
    select 1 from public.payment_allocations
    where credit_id in (
      '94000000-0000-4000-8000-000000000001',
      '94000000-0000-4000-8000-000000000002',
      '94000000-0000-4000-8000-000000000003'
    )
  ),
  'approval created an automatic credit allocation'
);

-- Stale supplier/credit context and an invalid request state are rejected.
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000004',
    '92000000-0000-4000-8000-000000000002', 60, 'wrong supplier'
  );
  raise exception 'expected payment_request_credit_supplier_mismatch';
exception when sqlstate '22023' then
  if sqlerrm not like '%payment_request_credit_supplier_mismatch%' then raise; end if;
end
$$;
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000004',
    '92000000-0000-4000-8000-000000000001', 59, 'stale total'
  );
  raise exception 'expected payment_request_credit_total_changed';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%payment_request_credit_total_changed%' then raise; end if;
end
$$;
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000005',
    '92000000-0000-4000-8000-000000000001', 60, 'draft is invalid'
  );
  raise exception 'expected payment_request_transition_invalid';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%payment_request_transition_invalid%' then raise; end if;
end
$$;

-- Existing office approvers may use the override too.
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select pg_temp.credit_override_assert(
  (public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001', 60,
    'Office reviewed the open credits'
  )->>'idempotent')::boolean = false,
  'existing office approver could not use the override'
);

-- Payer is denied the command, but may read the immutable decision on an approved request.
reset role;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
set local role authenticated;
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000001', 60, 'payer must fail'
  );
  raise exception 'expected unauthorized role rejection';
exception when sqlstate '42501' then
  null;
end
$$;
select pg_temp.credit_override_assert(
  (select open_credit_override_total = 60
          and open_credit_override_reason = 'Reviewed the unallocated supplier credits'
   from public.payment_requests where id = '95000000-0000-4000-8000-000000000001'),
  'payer cannot read the approved override decision'
);
do $$
begin
  update public.payment_requests
  set open_credit_override_reason = 'payer edit'
  where id = '95000000-0000-4000-8000-000000000001';
  raise exception 'expected payer update rejection';
exception when sqlstate '42501' then
  null;
end
$$;

-- Owner A cannot discover or approve tenant B's request through the command.
reset role;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
begin
  perform public.approve_payment_request_with_credit_override(
    '95000000-0000-4000-8000-000000000020',
    '92000000-0000-4000-8000-000000000003', 1, 'cross tenant'
  );
  raise exception 'expected cross-tenant rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%payment_request_unknown%' then raise; end if;
end
$$;

rollback;
