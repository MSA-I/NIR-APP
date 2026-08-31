-- P99 — a supplier logo path is a security boundary, so it is tried rather than described.
--
-- The column is text. Nothing about its type stops a row in one tenant pointing at another
-- tenant's folder in the shared branding bucket, and no RLS policy on `suppliers` would notice --
-- the policy filters which ROWS you see, not what a string inside one of them says. The CHECK in
-- `0275` is what makes the prefix unforgeable, and the only way to know it does is to insert the
-- paths a mistake or an attack would produce and watch them be refused.
--
-- THE MIGRATION'S OWN DO BLOCK TESTS THE REGEX AS A PREDICATE. That is not the same claim: a regex
-- can be right while the constraint is attached to the wrong column, declared NOT VALID and never
-- validated, or dropped by a later statement in the same file. This suite writes rows.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p99_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P99 supplier logo assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p99_refuses(p_sql text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0990000-0000-4000-8000-000000000001', 'P99 org', 'active', 18, 'ILS', 'IL'),
  ('a0990000-0000-4000-8000-000000000002', 'P99 other tenant', 'active', 18, 'ILS', 'IL');
insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
  ('c0990000-0000-4000-8000-000000000001', 'a0990000-0000-4000-8000-000000000001',
   'P99 supplier', 'active', 'ILS', 'IL'),
  ('c0990000-0000-4000-8000-000000000002', 'a0990000-0000-4000-8000-000000000001',
   'P99 second supplier', 'active', 'ILS', 'IL');

-- ===== 1. The path the Edge function builds is accepted =====
update public.suppliers
   set logo_path = 'a0990000-0000-4000-8000-000000000001/suppliers/'
                   || 'c0990000-0000-4000-8000-000000000001/'
                   || '11111111-1111-4111-8111-111111111111.png',
       logo_updated_at = now()
 where id = 'c0990000-0000-4000-8000-000000000001';

select pg_temp.p99_assert(
  (select logo_path is not null from public.suppliers
    where id = 'c0990000-0000-4000-8000-000000000001'),
  'a correctly built path was refused -- every assertion below would then pass for the wrong reason');

-- ===== 2. THE ONE THAT MATTERS: another tenant's folder =====
-- The bucket's policy reads the first segment as the organisation id, so a row that begins with
-- somebody else's id points this tenant's supplier list at that tenant's files.
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = 'a0990000-0000-4000-8000-000000000002/suppliers/'
                       || 'c0990000-0000-4000-8000-000000000001/'
                       || '22222222-2222-4222-8222-222222222222.png',
           logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a path under another organisation was accepted');

-- ===== 3. And another supplier's folder inside the SAME tenant =====
-- Weaker than cross-tenant and still wrong: it lets one supplier's branding be pointed at another's
-- file, which is how a logo ends up on the wrong company's row with nothing in the audit to explain
-- it. A constraint that only pinned `{org_id}/` would accept this.
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = 'a0990000-0000-4000-8000-000000000001/suppliers/'
                       || 'c0990000-0000-4000-8000-000000000002/'
                       || '33333333-3333-4333-8333-333333333333.png',
           logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a path belonging to a different supplier in the same tenant was accepted');

-- ===== 4. The extensions the bucket allows, and nothing else =====
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = 'a0990000-0000-4000-8000-000000000001/suppliers/'
                       || 'c0990000-0000-4000-8000-000000000001/'
                       || '44444444-4444-4444-8444-444444444444.svg',
           logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'an svg path was accepted -- the bucket refuses the upload but the row would have kept a pointer');

-- A path with no organisation prefix at all, which is what a naive "just store the filename"
-- implementation produces.
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = 'logo.png', logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a bare filename was accepted as a logo path');

-- And a traversal dressed as a correct prefix.
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = 'a0990000-0000-4000-8000-000000000001/suppliers/'
                       || 'c0990000-0000-4000-8000-000000000001/'
                       || '../../55555555-5555-4555-8555-555555555555.png',
           logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a path containing a parent-directory traversal was accepted');

-- ===== 5. Both columns or neither =====
select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers set logo_updated_at = null
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a path was allowed to keep no timestamp -- the file could never be cache-busted');

select pg_temp.p99_assert(
  pg_temp.p99_refuses($$
    update public.suppliers
       set logo_path = null, logo_updated_at = now()
     where id = 'c0990000-0000-4000-8000-000000000001'$$),
  'a timestamp was allowed with no path -- a claim about a file that is not there');

-- Clearing BOTH is the removal path and must work, or a logo could never be taken down.
update public.suppliers set logo_path = null, logo_updated_at = null
 where id = 'c0990000-0000-4000-8000-000000000001';
select pg_temp.p99_assert(
  (select logo_path is null and logo_updated_at is null from public.suppliers
    where id = 'c0990000-0000-4000-8000-000000000001'),
  'clearing both columns was refused, so a logo could not be removed');

-- ===== 6. The browser holds no privilege on either column =====
-- This is what stops a tenant PATCHing a path directly and skipping the setter, the actor and the
-- reason. Asked of the catalogue: attempting the write as the wrong role and catching the refusal
-- is the pattern that takes the backend down.
select pg_temp.p99_assert(
  not has_column_privilege('authenticated', 'public.suppliers', 'logo_path', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'logo_updated_at', 'UPDATE'),
  'the browser can write a branding column directly, bypassing the setter and its reason');

-- But it may still READ them, or the supplier list could not show a logo it is allowed to see.
select pg_temp.p99_assert(
  has_column_privilege('authenticated', 'public.suppliers', 'logo_path', 'SELECT'),
  'the browser cannot read logo_path, so SUPPLIER_COLUMNS would 403 the whole supplier list');

-- ===== 7. The setter is reachable by nobody but the service role =====
select pg_temp.p99_assert(
  not has_function_privilege('authenticated',
    'public.set_supplier_branding_reference(uuid,uuid,text,text,timestamptz,text)', 'execute')
  and not has_function_privilege('anon',
    'public.set_supplier_branding_reference(uuid,uuid,text,text,timestamptz,text)', 'execute'),
  'a client role can execute the branding setter directly');

rollback;

select 'P99_supplier_logo_path_passed' as result;
