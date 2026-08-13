-- P35 -- a preference breaks a tie, and never wins one.
--
-- The risk this feature carries is that it quietly becomes a price override. "Preferred" is a
-- reasonable thing for an owner to want, and it is one small step from there to a recommendation
-- that costs the business money on every order while looking helpful. So the first assertion below
-- is the one that matters: a preferred supplier who charges MORE is not recommended, and no amount
-- of preference changes that.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p35_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P35 preference assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('10350000-0000-4000-8000-000000000001', 'P35 tenant', 'active');
insert into auth.users (id, email) values
  ('20350000-0000-4000-8000-000000000001', 'owner-p35@example.test'),
  ('20350000-0000-4000-8000-000000000002', 'accountant-p35@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20350000-0000-4000-8000-000000000001', '10350000-0000-4000-8000-000000000001',
   'P35 owner', 'owner'),
  ('20350000-0000-4000-8000-000000000002', '10350000-0000-4000-8000-000000000001',
   'P35 accountant', 'accountant');

insert into public.suppliers (id, org_id, name, status) values
  ('40350000-0000-4000-8000-000000000001', '10350000-0000-4000-8000-000000000001',
   'P35 זול', 'active'),
  ('40350000-0000-4000-8000-000000000002', '10350000-0000-4000-8000-000000000001',
   'P35 יקר אך מועדף', 'active'),
  ('40350000-0000-4000-8000-000000000003', '10350000-0000-4000-8000-000000000001',
   'P35 באותו מחיר', 'active');

-- ===== 1. THE ORDERING ITSELF: price first, always =====
--
-- Read as data rather than through the draft command, because this is a claim about the ordering
-- rule and it should fail on the rule, not on a fixture the command happens to need.

insert into public.products (id, org_id, name, unit) values
  ('30350000-0000-4000-8000-000000000001', '10350000-0000-4000-8000-000000000001',
   'P35 מוצר', 'unit');
insert into public.supplier_products
  (org_id, supplier_id, product_id, current_price, available) values
  ('10350000-0000-4000-8000-000000000001', '40350000-0000-4000-8000-000000000001',
   '30350000-0000-4000-8000-000000000001', 10, true),
  ('10350000-0000-4000-8000-000000000001', '40350000-0000-4000-8000-000000000002',
   '30350000-0000-4000-8000-000000000001', 12, true),
  ('10350000-0000-4000-8000-000000000001', '40350000-0000-4000-8000-000000000003',
   '30350000-0000-4000-8000-000000000001', 10, true);

update public.suppliers set preferred = true
where id = '40350000-0000-4000-8000-000000000002';

select pg_temp.p35_assert(
  (select sp.supplier_id = '40350000-0000-4000-8000-000000000001'
          or sp.supplier_id = '40350000-0000-4000-8000-000000000003'
   from public.supplier_products sp
   join public.suppliers s on s.id = sp.supplier_id
   where sp.org_id = '10350000-0000-4000-8000-000000000001'
     and sp.product_id = '30350000-0000-4000-8000-000000000001'
   order by sp.current_price, s.preferred desc, sp.supplier_id
   limit 1),
  'A PREFERRED SUPPLIER WHO CHARGES MORE WAS RECOMMENDED. Preference orders offers that already '
  'cost the same; it is not a price override, and a recommendation engine that quietly prefers '
  'the expensive supplier costs the business money on every single order while looking helpful');

-- Now the tie. Two suppliers at ₪10; the preference decides, in place of the arbitrary
-- supplier_id ordering that decided it before — a judgement replacing a coin flip.
update public.suppliers set preferred = false
where id = '40350000-0000-4000-8000-000000000002';
update public.suppliers set preferred = true
where id = '40350000-0000-4000-8000-000000000003';

select pg_temp.p35_assert(
  (select sp.supplier_id = '40350000-0000-4000-8000-000000000003'
   from public.supplier_products sp
   join public.suppliers s on s.id = sp.supplier_id
   where sp.org_id = '10350000-0000-4000-8000-000000000001'
     and sp.product_id = '30350000-0000-4000-8000-000000000001'
   order by sp.current_price, s.preferred desc, sp.supplier_id
   limit 1),
  'the preference did not break a tie between two offers at the same price, which is the only '
  'thing it is for');

-- ===== 2. Both live recommendation sites carry the rule =====

select pg_temp.p35_assert(
  (select count(*) >= 2
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc like '%order by sp.current_price, s.preferred desc, sp.supplier_id%'),
  'fewer than two recommendation sites carry the preference tie-break. 0018 and 0043 both choose '
  'a supplier, and a rule that lives in one of them is a rule two screens disagree about');

select pg_temp.p35_assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%s.preferred desc%'
      and p.prosrc not like '%order by sp.current_price, s.preferred desc%'),
  'a recommendation orders by preference BEFORE price somewhere');

-- ===== 3. Setting it is a reasoned, audited decision =====

set local role authenticated;
select set_config('request.jwt.claim.sub', '20350000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select pg_temp.p35_assert(
  (select (r ->> 'changed')::boolean = true and (r ->> 'preferred')::boolean = true
   from public.set_supplier_preferred(
     '40350000-0000-4000-8000-000000000001', true, 'P35 מגיע בזמן') r),
  'the owner could not mark a supplier preferred');

select pg_temp.p35_assert(
  (select (r ->> 'changed')::boolean = false
   from public.set_supplier_preferred(
     '40350000-0000-4000-8000-000000000001', true, 'P35 שוב') r),
  're-affirming an existing preference reported a change. Writing an audit row for a repetition '
  'buries the rows that recorded an actual decision');

do $$
begin
  perform public.set_supplier_preferred('40350000-0000-4000-8000-000000000001', false, '   ');
  raise exception 'P35 preference assertion failed: a preference was changed without a reason. '
    'When order recommendations shift, "why" has to have an answer';
exception when sqlstate '22023' then
  if sqlerrm <> 'set_supplier_preferred_invalid' then raise; end if;
end
$$;

select set_config('request.jwt.claim.sub', '20350000-0000-4000-8000-000000000002', true);
do $$
begin
  perform public.set_supplier_preferred(
    '40350000-0000-4000-8000-000000000001', false, 'P35 מטבח מנסה');
  raise exception 'P35 preference assertion failed: an accountant changed a supplier '
    'preference, which changes what every order screen recommends';
exception when sqlstate '42501' then
  if sqlerrm <> 'set_supplier_preferred_not_authorized' then raise; end if;
end
$$;

reset role;
select pg_temp.p35_assert(
  exists (
    select 1 from public.audit_logs a
    where a.org_id = '10350000-0000-4000-8000-000000000001'
      and a.action = 'supplier_preference_changed'
      and a.entity_id = '40350000-0000-4000-8000-000000000001'
      and a.reason = 'P35 מגיע בזמן'),
  'the preference change left no audit row carrying its reason');

-- ===== 4. The column is readable, and not directly writable =====
--
-- 0112 replaced the table SELECT grant on suppliers with per-column grants. A column added
-- afterwards is invisible until granted — and an invisible one here is a badge that never appears,
-- with no error to explain it.

select pg_temp.p35_assert(
  has_column_privilege('authenticated', 'public.suppliers', 'preferred', 'select'),
  'the preferred column is not readable, so the badge and the filter have nothing to read');

select pg_temp.p35_assert(
  not has_column_privilege('authenticated', 'public.suppliers', 'preferred', 'update'),
  'a client can write preferred directly, bypassing the required reason and the audit row');

select pg_temp.p35_assert(
  not has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'select'),
  'adding a column re-granted the whole table and undid 0112''s bank-details boundary');

rollback;
