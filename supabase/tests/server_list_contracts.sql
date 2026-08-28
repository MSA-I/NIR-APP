-- Server-side list contract harness for 0053_server_side_list_contracts.sql. Run only against an
-- isolated local database with every migration applied. The transaction is rolled back.
--
-- The claim under test is not "the predicate returns some duplicates". It is that the server
-- predicate returns EXACTLY the id set the browser computes today over the whole result array
-- (`Invoices.tsx:77-84`), including the pair that server-side paging would otherwise hide.
\set ON_ERROR_STOP on

begin;

-- Legacy invoice fixtures in this transaction predate multi-currency and are explicitly ILS.
alter table public.invoices alter column currency set default 'ILS';

create function pg_temp.slc_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Server list contract assertion failed: %', p_message;
  end if;
end
$$;

-- The browser's duplicate key, re-implemented from `Invoices.tsx:23-24` rather than reused from
-- the migration, so that this reference and the predicate can disagree. The separator differs:
-- JavaScript uses U+0000, which PostgreSQL text cannot hold. A uuid prefix is fixed width, so any
-- separator is unambiguous -- and ':' is the one `0017:161` already uses for the same key.
--
-- What this reference CANNOT see, stated here so the identity claim below is not read as wider than
-- it is: this is SQL `trim()`, which is `btrim()` and strips spaces only, while the real browser
-- calls JavaScript `.trim()`, which also strips tabs, newlines and NBSP. Claim 1 therefore proves
-- identity under the normalisation the two languages SHARE -- case and space padding. The case they
-- do not share is pinned separately, by name, in the tenant B section.
create function pg_temp.slc_client_key(p_supplier_id uuid, p_invoice_number text)
returns text
language sql
immutable
as $$
  select p_supplier_id::text || ':' || lower(trim(p_invoice_number))
$$;

-- ===== Fixture =====

insert into organizations (id, name, status) values
  ('13000000-0000-0000-0000-000000000001', 'List contract tenant A', 'active'),
  ('13000000-0000-0000-0000-000000000002', 'List contract tenant B', 'active');

insert into auth.users (id, email) values
  ('23000000-0000-0000-0000-000000000001', 'slc-owner-a@example.test'),
  ('23000000-0000-0000-0000-000000000002', 'slc-owner-b@example.test');

insert into profiles (id, org_id, full_name, role, active) values
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'List contract owner A', 'owner', true),
  ('23000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', 'List contract owner B', 'owner', true);

insert into suppliers (id, org_id, name) values
  ('33000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'Tenant A supplier one'),
  ('33000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', 'Tenant A supplier two'),
  ('33000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000002', 'Tenant B supplier one');

-- Tenant A. Dates are distinct so the paged ordering below is deterministic.
--
--   ...01  '  INV-100 '  supplier one   twin of ...09, and nine days apart so they page apart
--   ...02  'INV-200'     supplier one   same number as ...03 but a DIFFERENT supplier: not a twin
--   ...03  'inv-200'     supplier two
--   ...04  'INV-300'     supplier one   SOFT DELETED
--   ...05  'inv-300'     supplier one   its only twin is deleted, so it is not a duplicate
--   ...06  'INV-400'     supplier one   unique
--   ...07  'INV-500'     supplier one   twin of ...08, adjacent -- the case paging cannot break
--   ...08  'inv-500'     supplier one
--   ...09  'inv-100'     supplier one   twin of ...01
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount, deleted_at
) values
  ('43000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', '  INV-100 ', '2026-01-01', '2026-01-01', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'INV-200',    '2026-01-02', '2026-01-02', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000002', 'inv-200',    '2026-01-03', '2026-01-03', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'INV-300',    '2026-01-04', '2026-01-04', 100, 18, 118, now()),
  ('43000000-0000-0000-0000-000000000005', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'inv-300',    '2026-01-05', '2026-01-05', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000006', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'INV-400',    '2026-01-06', '2026-01-06', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000007', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'INV-500',    '2026-01-07', '2026-01-07', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000008', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'inv-500',    '2026-01-08', '2026-01-08', 100, 18, 118, null),
  ('43000000-0000-0000-0000-000000000009', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'inv-100',    '2026-01-09', '2026-01-09', 100, 18, 118, null);

-- Tenant B. ...01 carries the SAME normalised number as tenant A's duplicate pair and must stay
-- clean; ...02 and ...03 are tenant B's own pair and must not reach tenant A. ...04 and ...05 pin
-- the trim divergence: they differ only by a leading TAB, so they are grouped by the browser and
-- not by the server. Because they are not a duplicate pair here, they leave every expected array
-- in this file unchanged -- and any change to the normalisation makes them appear in one.
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount
) values
  ('53000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'INV-100', '2026-01-01', '2026-01-01', 100, 18, 118),
  ('53000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'INV-700', '2026-01-02', '2026-01-02', 100, 18, 118),
  ('53000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'inv-700', '2026-01-03', '2026-01-03', 100, 18, 118),
  ('53000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'INV-800', '2026-01-04', '2026-01-04', 100, 18, 118),
  ('53000000-0000-0000-0000-000000000005', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', chr(9) || 'INV-800', '2026-01-05', '2026-01-05', 100, 18, 118);

-- Two of tenant A's invoices are linked to an order; every other live one is "without order".
insert into purchase_orders (id, org_id, supplier_id, status) values
  ('63000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', 'sent');

insert into invoice_order_links (org_id, invoice_id, order_id) values
  ('13000000-0000-0000-0000-000000000001', '43000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000001'),
  ('13000000-0000-0000-0000-000000000001', '43000000-0000-0000-0000-000000000007', '63000000-0000-0000-0000-000000000001');

-- ===== Claim 1: the predicate equals the browser's whole-set computation =====
--
-- Read as the tenant's own user, because that is the row set the browser actually receives. The
-- expected literal is spelled out as well: if the predicate and the re-implementation ever drift
-- together, the literal is what still fails.

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where public.invoice_has_duplicate(i)
  ) = array[
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000007',
    '43000000-0000-0000-0000-000000000008',
    '43000000-0000-0000-0000-000000000009'
  ]::uuid[],
  'the server duplicate predicate does not return the expected id set'
);

select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where public.invoice_has_duplicate(i)
  ) = (
    -- The old client computation, on the full set: count occurrences of the key, keep members of
    -- any group larger than one.
    with client_rows as (
      select i.id, pg_temp.slc_client_key(i.supplier_id, i.invoice_number) as dup_key
      from invoices i
      where i.deleted_at is null
    ),
    repeated as (
      select dup_key from client_rows group by dup_key having count(*) > 1
    )
    select array_agg(c.id order by c.id)
    from client_rows c
    join repeated r on r.dup_key = c.dup_key
  ),
  'the server predicate and the browser whole-set computation disagree'
);

-- The supplier is part of the key: the same normalised number under two suppliers is not a twin.
select pg_temp.slc_assert(
  not exists (
    select 1 from invoices i
    where i.id in (
      '43000000-0000-0000-0000-000000000002',
      '43000000-0000-0000-0000-000000000003'
    )
      and public.invoice_has_duplicate(i)
  ),
  'two suppliers sharing one invoice number were reported as duplicates'
);

-- ===== Claim 2: a pair split across pages is still flagged on both pages =====
--
-- Page size three over the live rows ordered `invoice_date desc, id`:
--   page 0: ...09 ...08 ...07   page 1: ...06 ...05 ...03   page 2: ...02 ...01
-- so the ...01/...09 twins are two pages apart. A per-page computation flags neither.

select pg_temp.slc_assert(
  (
    select count(distinct page.n)
    from generate_series(0, 2) page(n)
    cross join lateral (
      select i.id
      from invoices i
      where i.deleted_at is null
      order by i.invoice_date desc, i.id
      offset page.n * 3 limit 3
    ) paged
    where paged.id in (
      '43000000-0000-0000-0000-000000000001',
      '43000000-0000-0000-0000-000000000009'
    )
  ) = 2,
  'the fixture no longer splits the duplicate pair across two pages'
);

select pg_temp.slc_assert(
  (
    select array_agg(paged.id order by paged.id)
    from generate_series(0, 2) page(n)
    cross join lateral (
      select i.id, public.invoice_has_duplicate(i) as is_duplicate
      from invoices i
      where i.deleted_at is null
      order by i.invoice_date desc, i.id
      offset page.n * 3 limit 3
    ) paged
    where paged.is_duplicate
  ) = array[
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000007',
    '43000000-0000-0000-0000-000000000008',
    '43000000-0000-0000-0000-000000000009'
  ]::uuid[],
  'paging the query changed which rows are flagged as duplicates'
);

-- And the failure this replaces, spelled out rather than described: the same computation done
-- per page -- which is what server-side paging plus a client-side group-by amounts to -- sees only
-- the adjacent pair and reports the split pair as clean. If this assertion ever stops holding, the
-- fixture has stopped exercising the case the predicate exists for.
select pg_temp.slc_assert(
  (
    select array_agg(t.id order by t.id)
    from (
      select paged.id, count(*) over (partition by page.n, paged.dup_key) as same_page_count
      from generate_series(0, 2) page(n)
      cross join lateral (
        select i.id, pg_temp.slc_client_key(i.supplier_id, i.invoice_number) as dup_key
        from invoices i
        where i.deleted_at is null
        order by i.invoice_date desc, i.id
        offset page.n * 3 limit 3
      ) paged
    ) t
    where t.same_page_count > 1
  ) = array[
    '43000000-0000-0000-0000-000000000007',
    '43000000-0000-0000-0000-000000000008'
  ]::uuid[],
  'the per-page computation no longer misses the split pair, so claim 2 proves nothing'
);

-- ===== Claim 4: without-order returns exactly the invoices with no link =====

select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where public.invoice_without_order(i)
  ) = array[
    '43000000-0000-0000-0000-000000000002',
    '43000000-0000-0000-0000-000000000003',
    '43000000-0000-0000-0000-000000000005',
    '43000000-0000-0000-0000-000000000006',
    '43000000-0000-0000-0000-000000000008',
    '43000000-0000-0000-0000-000000000009'
  ]::uuid[],
  'the without-order predicate does not return the expected id set'
);

select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where public.invoice_without_order(i)
  ) = (
    -- What the browser does today: `r.order_links.length === 0` over the embedded links.
    select array_agg(i.id order by i.id)
    from invoices i
    where i.deleted_at is null
      and not exists (
        select 1 from invoice_order_links l
        where l.org_id = i.org_id and l.invoice_id = i.id
      )
  ),
  'the without-order predicate and the embedded-link computation disagree'
);

-- ===== Claim 5: a soft-deleted row is neither counted nor returned =====

select pg_temp.slc_assert(
  not exists (
    select 1 from invoices i
    where i.id = '43000000-0000-0000-0000-000000000004'
      and (public.invoice_has_duplicate(i) or public.invoice_without_order(i))
  ),
  'a soft-deleted invoice was returned by an attention predicate'
);

select pg_temp.slc_assert(
  not (select public.invoice_has_duplicate(i) from invoices i where i.id = '43000000-0000-0000-0000-000000000005'),
  'a live invoice was flagged as duplicate by a soft-deleted twin'
);

-- ===== Claim 6: an exact count under RLS returns a number, never null =====
--
-- `readExactCount` (`queryResult.ts:7`) throws `count_unavailable` on null rather than showing a
-- zero. The server half of that contract is that a filtered count under RLS is a real number: it
-- agrees with the row set, it is tenant-scoped, and an empty result is 0 rather than null.

select pg_temp.slc_assert(
  (select count(*) from invoices i where public.invoice_has_duplicate(i)) is not null
  and (select count(*) from invoices i where public.invoice_has_duplicate(i)) = 4,
  'the exact duplicate count under RLS is null or disagrees with the row set'
);

select pg_temp.slc_assert(
  (select count(*) from invoices i where public.invoice_without_order(i)) = 6,
  'the exact without-order count under RLS disagrees with the row set'
);

select pg_temp.slc_assert(
  (
    select count(*) from invoices i
    where i.supplier_id = '33000000-0000-0000-0000-000000000002'
      and public.invoice_has_duplicate(i)
  ) is not distinct from 0::bigint,
  'an empty exact count came back as null instead of zero'
);

-- ===== Claim 3: tenant isolation =====
--
-- Tenant A saw only its own four above -- none of tenant B's ids appear in that array. Now the
-- other direction, and then the same question with RLS out of the picture entirely.

reset role;
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000002', true);
set local role authenticated;

-- ===== The trim divergence, pinned rather than described =====
--
-- Claim 1 compares the predicate against a re-implementation of the browser's key written in SQL.
-- Both use SQL `trim()`, which is `btrim()` and strips spaces only, so that comparison is blind to
-- exactly one case: JavaScript `.trim()` ALSO strips tabs, newlines and NBSP. The direction matters
-- -- the browser is the more aggressive one. For `'INV-800'` and `chr(9) || 'INV-800'` the browser
-- groups them and the server does not, so the server returns the NARROWER set.
--
-- This asserts what the server does today, which is the documented decision, not an oversight. If
-- it ever fails, the normalisation was changed -- and that is a business decision about what
-- "duplicate" means, not a bug fix. `docs/OPEN-DECISIONS.md` and the server-list contract are where it is argued,
-- and the same change would have to reach `p2_duplicate_invoice_group_count()` (0024:399) and
-- `private.notify_duplicate_invoice_check()` (0017:150-168) in the same commit.
select pg_temp.slc_assert(
  (select invoice_number from invoices where id = '53000000-0000-0000-0000-000000000005')
    = chr(9) || 'INV-800'
  and trim((select invoice_number from invoices where id = '53000000-0000-0000-0000-000000000005'))
    = chr(9) || 'INV-800',
  'the tab-padding fixture lost its tab, so the divergence below is no longer being exercised'
);

select pg_temp.slc_assert(
  not exists (
    select 1 from invoices i
    where i.id in (
      '53000000-0000-0000-0000-000000000004',
      '53000000-0000-0000-0000-000000000005'
    )
      and public.invoice_has_duplicate(i)
  ),
  'tab-padded invoice numbers are now grouped as duplicates: the normalisation was widened beyond '
  || 'lower(trim(...)), which redefines "duplicate" for the business rather than fixing a bug'
);

-- Deliberately after the pin above: a widened normalisation breaks this array too, and the first
-- assertion to fire should be the one that names the cause.
select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where public.invoice_has_duplicate(i)
  ) = array[
    '53000000-0000-0000-0000-000000000002',
    '53000000-0000-0000-0000-000000000003'
  ]::uuid[],
  'tenant B sees the wrong duplicate set'
);

select pg_temp.slc_assert(
  (select count(*) from invoices i where public.invoice_has_duplicate(i)) = 2,
  'the exact duplicate count is not scoped to the reading tenant'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- With policies bypassed the row that shares tenant A's normalised number is still clean, and
-- neither tenant's set has grown.
select pg_temp.slc_assert(
  (
    select array_agg(i.id order by i.id)
    from invoices i
    where i.org_id in (
      '13000000-0000-0000-0000-000000000001',
      '13000000-0000-0000-0000-000000000002'
    )
      and public.invoice_has_duplicate(i)
  ) = array[
    '43000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000007',
    '43000000-0000-0000-0000-000000000008',
    '43000000-0000-0000-0000-000000000009',
    '53000000-0000-0000-0000-000000000002',
    '53000000-0000-0000-0000-000000000003'
  ]::uuid[],
  'the duplicate key leaks across tenants once RLS is bypassed'
);

-- The lock underneath that result. A supplier belongs to exactly one organization, and
-- `p0_invoices_supplier_tenant_fk` (`0021`) makes an invoice's tenant agree with its supplier's,
-- so `supplier_id` equality already implies same-tenant. That is why the assertion above holds --
-- and it holds only as long as this constraint does.
do $$
begin
  insert into invoices (
    id, org_id, supplier_id, invoice_number, invoice_date, received_date,
    amount_before_vat, vat_amount, total_amount
  ) values (
    '43000000-0000-0000-0000-0000000000ff',
    '13000000-0000-0000-0000-000000000002',
    '33000000-0000-0000-0000-000000000001',
    'INV-100', '2026-01-01', '2026-01-01', 100, 18, 118
  );
  raise exception 'Server list contract assertion failed: an invoice borrowed another tenant''s supplier';
exception
  when foreign_key_violation then null;
end
$$;

-- The org_id term in the predicate is therefore not what isolates tenants -- the constraint above
-- is. It is the leading column of the duplicate index and a second lock, so no behavioural test can
-- catch its removal: dropping it changes no answer, only the plan. This is the A3-style guard for
-- exactly that case -- a weakened predicate, not only a missing one.
select pg_temp.slc_assert(
  (
    select p.prosrc
    from pg_proc p
    where p.oid = 'public.invoice_has_duplicate(public.invoices)'::regprocedure
  ) like '%twin.org_id = $1.org_id%',
  'the duplicate predicate no longer scopes its probe by org_id'
);

-- ===== Soft delete is dynamic, not just a fixture property =====
-- Deleting one of a live pair must clear the flag on the other one.

update invoices set deleted_at = now() where id = '43000000-0000-0000-0000-000000000008';

select pg_temp.slc_assert(
  not (select public.invoice_has_duplicate(i) from invoices i where i.id = '43000000-0000-0000-0000-000000000007'),
  'soft-deleting a twin left the surviving invoice flagged as a duplicate'
);

-- ===== The shape the predicates and the paging depend on =====
--
-- The index carries the canonical key expression, and it is compared exactly rather than by
-- existence: an index that was silently rewritten to a different normalisation would still exist.

select pg_temp.slc_assert(
  (
    select pg_get_indexdef(i.indexrelid)
    from pg_index i
    where i.indexrelid = 'public.invoices_org_live_duplicate_key_idx'::regclass
  ) = 'CREATE INDEX invoices_org_live_duplicate_key_idx ON public.invoices'
    || ' USING btree (org_id, supplier_id, lower(TRIM(BOTH FROM invoice_number)))'
    || ' WHERE (deleted_at IS NULL)',
  'the duplicate-key index is missing or no longer carries the canonical normalisation'
);

-- Validity, not just existence: a failed CREATE INDEX leaves an index whose definition still reads
-- correctly and which the planner will never use.
select pg_temp.slc_assert(
  (
    select count(*)
    from (values
      ('invoices_org_live_duplicate_key_idx'),
      ('invoices_org_live_date_idx'),
      ('invoices_org_live_review_date_idx'),
      ('invoices_org_live_payment_date_idx'),
      ('invoices_org_live_export_date_idx'),
      ('invoice_order_links_org_invoice_idx'),
      ('documents_org_live_created_idx'),
      ('payments_org_paid_date_idx'),
      ('bank_transactions_org_date_idx'),
      ('bank_transactions_org_status_date_idx'),
      ('purchase_orders_org_created_idx'),
      ('purchase_orders_org_status_created_idx'),
      ('payment_allocations_org_invoice_idx'),
      ('credit_requests_org_invoice_settled_idx')
    ) expected(name)
    join pg_class c on c.oid = to_regclass('public.' || expected.name)
    join pg_index i on i.indexrelid = c.oid
    where i.indisvalid and i.indisready
  ) = 14,
  'a list-screen index from 0053 is missing or invalid'
);

-- The tie-breaker index has to be readable in the direction the screens actually order in.
select pg_temp.slc_assert(
  (
    select pg_get_indexdef(i.indexrelid)
    from pg_index i
    where i.indexrelid = 'public.invoices_org_live_date_idx'::regclass
  ) = 'CREATE INDEX invoices_org_live_date_idx ON public.invoices'
    || ' USING btree (org_id, invoice_date DESC, id)'
    || ' WHERE (deleted_at IS NULL)',
  'the invoices ordering index no longer matches `.order(invoice_date desc).order(id)`'
);

-- ===== The probe is a lookup, not a full scan =====
--
-- An index whose expression does not match the predicate's expression still exists, still passes
-- every assertion above, and is never used. A third tenant, large enough for the planner to have a
-- real choice, is what makes this measurable; its rows are outside every set asserted above.

insert into organizations (id, name, status) values
  ('13000000-0000-0000-0000-000000000003', 'List contract tenant C', 'active');
insert into suppliers (id, org_id, name) values
  ('33000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000003', 'Tenant C supplier');
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount
)
select
  gen_random_uuid(),
  '13000000-0000-0000-0000-000000000003',
  '33000000-0000-0000-0000-000000000004',
  'SCALE-' || n,
  '2026-02-01', '2026-02-01', 1, 0, 1
from generate_series(1, 400) n;

analyze invoices;

create function pg_temp.slc_duplicate_probe_plan()
returns text
language plpgsql
as $fn$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in execute $q$
    explain (costs off)
    select 1
    from invoices twin
    where twin.org_id = '13000000-0000-0000-0000-000000000003'::uuid
      and twin.supplier_id = '33000000-0000-0000-0000-000000000004'::uuid
      and twin.deleted_at is null
      and lower(trim(twin.invoice_number)) = lower(trim('SCALE-1'))
  $q$
  loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end
$fn$;

select pg_temp.slc_assert(
  strpos(pg_temp.slc_duplicate_probe_plan(), 'invoices_org_live_duplicate_key_idx') > 0
  and strpos(pg_temp.slc_duplicate_probe_plan(), 'Seq Scan on invoices') = 0,
  'the duplicate probe does not use the duplicate-key index -- it is a scan, not a lookup'
);

-- Both predicates must stay callable from the browser role and stay invoker-rights: a definer
-- rewrite would bypass RLS and quietly answer for rows the caller cannot see.
select pg_temp.slc_assert(
  (
    select count(*) from pg_proc p
    where p.oid in (
      'public.invoice_has_duplicate(public.invoices)'::regprocedure,
      'public.invoice_without_order(public.invoices)'::regprocedure
    )
      and not p.prosecdef
      and p.provolatile = 's'
  ) = 2,
  'a list predicate is no longer a stable, invoker-rights function'
);

select pg_temp.slc_assert(
  has_function_privilege('authenticated', 'public.invoice_has_duplicate(public.invoices)', 'execute')
  and has_function_privilege('authenticated', 'public.invoice_without_order(public.invoices)', 'execute')
  and not has_function_privilege('anon', 'public.invoice_has_duplicate(public.invoices)', 'execute')
  and not has_function_privilege('anon', 'public.invoice_without_order(public.invoices)', 'execute'),
  'the list predicates are not granted to authenticated only'
);

rollback;

\echo 'server_list_contracts_passed'
