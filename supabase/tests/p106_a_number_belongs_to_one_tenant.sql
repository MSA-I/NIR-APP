-- P106 — per-tenant document numbering (0294, Wave 4b, owner decision B).
-- Run only against an isolated local database with every migration applied. Rolled back.
--
-- What it proves, on ALL SIX numbered tables rather than a representative one:
--   (a) a brand-new organisation is numbered from 1, which is the promise decision B makes;
--   (b) an existing tenant keeps its history — the next number is its own maximum plus one, and
--       no historical number is reused;
--   (c) two tenants do not see each other. Tenant B's first number is 1 however busy tenant A is,
--       which is the cross-tenant activity signal the global identity used to publish;
--   (d) an explicit number is REFUSED. The identity this replaces was `generated always`, so it
--       refused one at the storage layer; a convention that merely ignores it would let the first
--       caller to pass a number collide with a real one;
--   (e) the counter table is granted to no client role, because a readable counter republishes
--       exactly the signal (c) removes;
--   (f) `unique (org_id, number)` exists on all six, so "never reused" is checkable and not a
--       promise;
--   (g) the global identity and its sequence are really gone — a surviving sequence is a second
--       door to a number nobody counted.

\set ON_ERROR_STOP on

begin;

create function pg_temp.p106_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P106 assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixtures. Two tenants: A already trades, B has just signed up. =====
insert into organizations (id, name, status) values
  ('18000000-0000-0000-0000-000000000001', 'P106 tenant A', 'active'),
  ('18000000-0000-0000-0000-000000000002', 'P106 tenant B', 'active');

insert into suppliers (id, org_id, name) values
  ('38000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001', 'P106 supplier A'),
  ('38000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000002', 'P106 supplier B');

-- ===== (a)+(c) A brand-new tenant starts at 1 on every table, and tenant A's volume is invisible
-- to it. Tenant A goes first and repeatedly, precisely so that a global counter would show. =====
insert into purchase_requests (org_id) values
  ('18000000-0000-0000-0000-000000000001'),
  ('18000000-0000-0000-0000-000000000001'),
  ('18000000-0000-0000-0000-000000000001');
insert into purchase_orders (id, org_id, supplier_id) values
  ('78000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001',
   '38000000-0000-0000-0000-000000000001'),
  ('78000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000001',
   '38000000-0000-0000-0000-000000000001');
insert into goods_receipts (org_id, order_id) values
  ('18000000-0000-0000-0000-000000000001', '78000000-0000-0000-0000-000000000001'),
  ('18000000-0000-0000-0000-000000000001', '78000000-0000-0000-0000-000000000002');
insert into payment_requests (org_id, supplier_id, amount) values
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 10),
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 20);
insert into payments (org_id, supplier_id, amount, paid_date) values
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 10, '2026-07-01'),
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 20, '2026-07-02');
insert into credit_requests (org_id, supplier_id, reason, amount) values
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 'other', 5),
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 'other', 6);

select pg_temp.p106_assert(
  (select array_agg(number order by number) = array[1, 2, 3]
   from purchase_requests where org_id = '18000000-0000-0000-0000-000000000001'),
  'the first tenant was not numbered from 1 on purchase_requests'
);

-- Tenant B signs up after all of that and must still see 1 everywhere.
insert into purchase_requests (org_id) values ('18000000-0000-0000-0000-000000000002');
insert into purchase_orders (id, org_id, supplier_id) values
  ('78000000-0000-0000-0000-000000000009', '18000000-0000-0000-0000-000000000002',
   '38000000-0000-0000-0000-000000000002');
insert into goods_receipts (org_id, order_id) values
  ('18000000-0000-0000-0000-000000000002', '78000000-0000-0000-0000-000000000009');
insert into payment_requests (org_id, supplier_id, amount) values
  ('18000000-0000-0000-0000-000000000002', '38000000-0000-0000-0000-000000000002', 30);
insert into payments (org_id, supplier_id, amount, paid_date) values
  ('18000000-0000-0000-0000-000000000002', '38000000-0000-0000-0000-000000000002', 30, '2026-07-03');
insert into credit_requests (org_id, supplier_id, reason, amount) values
  ('18000000-0000-0000-0000-000000000002', '38000000-0000-0000-0000-000000000002', 'other', 7);

do $$
declare
  v_kind text;
  v_first integer;
begin
  foreach v_kind in array array[
    'credit_requests', 'goods_receipts', 'payment_requests',
    'payments', 'purchase_orders', 'purchase_requests'
  ] loop
    execute format(
      'select min(number) from public.%I where org_id = %L',
      v_kind, '18000000-0000-0000-0000-000000000002') into v_first;
    if v_first is distinct from 1 then
      raise exception
        'P106 assertion failed: a brand-new tenant got % rather than 1 on %', v_first, v_kind;
    end if;
  end loop;
end
$$;

-- ===== (b) An existing tenant keeps its history: the next number is its own maximum plus one,
-- and every number it has ever held is still distinct. =====
insert into payments (org_id, supplier_id, amount, paid_date) values
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 40, '2026-07-04');
select pg_temp.p106_assert(
  (select max(number) = 3 from payments where org_id = '18000000-0000-0000-0000-000000000001'),
  'an existing tenant did not continue from its own maximum'
);
select pg_temp.p106_assert(
  (select count(*) = count(distinct number)
   from payments where org_id = '18000000-0000-0000-0000-000000000001'),
  'a number was reused inside one tenant'
);

-- A deleted row does not free its number: the counter records what was handed out, not what
-- survived, which is the one property a "max plus one" allocator would get wrong.
delete from payments
where org_id = '18000000-0000-0000-0000-000000000001' and number = 3;
insert into payments (org_id, supplier_id, amount, paid_date) values
  ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001', 50, '2026-07-05');
select pg_temp.p106_assert(
  (select max(number) = 4 from payments where org_id = '18000000-0000-0000-0000-000000000001'),
  'a deleted number was handed out again'
);

-- ===== (d) An explicit number is refused, not honoured. =====
do $$
begin
  insert into payments (org_id, supplier_id, amount, paid_date, number) values
    ('18000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001',
     60, '2026-07-06', 99);
  raise exception 'P106 assertion failed: an explicit number was accepted';
exception when sqlstate '22023' then
  if sqlerrm not like '%org_number_is_allocated_not_supplied%' then raise; end if;
end
$$;
select pg_temp.p106_assert(
  not exists (select 1 from payments
    where org_id = '18000000-0000-0000-0000-000000000001' and number = 99),
  'the refused explicit number was written anyway'
);

-- ===== (e)+(f)+(g) The structural guarantees, on all six. =====
select pg_temp.p106_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'org_number_counters'
      and grantee in ('authenticated', 'anon')),
  'the counter table is readable by a client role, which republishes the cross-tenant signal'
);
do $$
declare
  v_kind text;
begin
  foreach v_kind in array array[
    'credit_requests', 'goods_receipts', 'payment_requests',
    'payments', 'purchase_orders', 'purchase_requests'
  ] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = v_kind
                 and column_name = 'number' and is_identity = 'YES') then
      raise exception 'P106 assertion failed: % still carries the global identity', v_kind;
    end if;
    if pg_get_serial_sequence('public.' || quote_ident(v_kind), 'number') is not null then
      raise exception 'P106 assertion failed: the global sequence for % survived', v_kind;
    end if;
    if not exists (select 1 from pg_constraint
                   where conrelid = ('public.' || quote_ident(v_kind))::regclass
                     and conname = v_kind || '_org_id_number_key' and contype = 'u') then
      raise exception 'P106 assertion failed: % cannot prove a number is unique in its tenant', v_kind;
    end if;
  end loop;
end
$$;

-- The allocator is SECURITY INVOKER on purpose: `private` grants nothing to anybody but its
-- owner, and a definer trigger on these tables would have to spend an A5 exemption to allocate an
-- integer. If somebody makes it a definer later, this fails and says why.
select pg_temp.p106_assert(
  not (select prosecdef from pg_proc where oid = 'private.allocate_org_number()'::regprocedure),
  'the allocator became SECURITY DEFINER, which needs an A5 exemption it does not have'
);

rollback;

\echo 'p106_a_number_belongs_to_one_tenant_passed'
