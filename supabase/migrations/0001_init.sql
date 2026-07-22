-- SupplyFlow initial schema — procurement-to-payment platform
-- Applied via Supabase Management API. All monetary values in ILS (₪), numeric(12,2).

-- ===== Enums =====
create type user_role as enum ('owner','kitchen','office','payer','accountant','supplier');
create type supplier_status as enum ('active','inactive','problematic','pending');
create type request_status as enum ('draft','split','cancelled');
create type po_status as enum ('draft','ready','sent','confirmed','partial','received','cancelled');
create type receipt_status as enum ('draft','completed');
create type receipt_line_status as enum ('full','partial','missing','damaged','returned');
create type invoice_review_status as enum ('received','in_review','pending_approval','approved','investigation');
create type invoice_payment_status as enum ('unpaid','partial','paid');
create type invoice_export_status as enum ('not_sent','sent');
create type credit_reason as enum ('missing','damaged','returned','wrong_price','duplicate_charge','other');
create type credit_status as enum ('open','requested','received','offset','closed');
create type payment_request_status as enum ('draft','pending_approval','approved','sent_for_execution','executed','matched','investigation','suspected_duplicate','cancelled');
create type bank_tx_status as enum ('unmatched','suggested','matched','ignored');
create type exception_type as enum ('payment_without_invoice','invoice_without_payment','amount_mismatch','duplicate_payment','duplicate_invoice','unknown_supplier','unmatched_bank','credit_not_deducted','receipt_mismatch');
create type exception_status as enum ('open','in_progress','resolved','dismissed');

-- ===== Core =====
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vat_rate numeric(5,2) not null default 18.00,
  -- reconciliation matching tolerances (configurable "Open Decisions" values)
  settings jsonb not null default '{"bank_match_days": 7, "bank_match_amount_tolerance": 1.0}'::jsonb,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id),
  full_name text not null,
  role user_role not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===== Auth helpers (security definer so RLS policies can consult profiles without recursion) =====
create or replace function auth_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() and active $$;

create or replace function auth_org() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from profiles where id = auth.uid() and active $$;

-- ===== Catalog =====
create table categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  sort int not null default 0,
  unique (org_id, name)
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  tax_id text,
  contact_name text,
  phone text,
  whatsapp text,
  email text,
  address text,
  delivery_days int[] not null default '{}', -- 0=Sunday .. 6=Saturday
  cutoff_time time,
  min_order_amount numeric(12,2),
  payment_terms text,
  bank_details text, -- shown to the payment executor
  notes text,
  status supplier_status not null default 'active',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table supplier_categories (
  supplier_id uuid not null references suppliers(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  primary key (supplier_id, category_id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  category_id uuid references categories(id),
  unit text not null default 'יח''',
  sku text,
  barcode text,
  notes text,
  active boolean not null default true,
  min_stock numeric(12,2), -- reserved for future inventory module
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table supplier_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  current_price numeric(12,2) not null check (current_price >= 0),
  previous_price numeric(12,2),
  price_effective_date date not null default current_date,
  available boolean not null default true,
  supplier_sku text,
  min_qty numeric(12,2),
  package_size numeric(12,2),
  updated_at timestamptz not null default now(),
  unique (supplier_id, product_id)
);

create table price_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  supplier_product_id uuid not null references supplier_products(id) on delete cascade,
  price numeric(12,2) not null,
  effective_date date not null default current_date,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ===== Purchasing =====
create table purchase_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  status request_status not null default 'draft',
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table purchase_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references purchase_requests(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(12,2) not null check (qty > 0),
  recommended_supplier_id uuid references suppliers(id),
  chosen_supplier_id uuid references suppliers(id),
  unit_price numeric(12,2) -- snapshot of chosen supplier price at selection time
);

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  supplier_id uuid not null references suppliers(id),
  request_id uuid references purchase_requests(id),
  status po_status not null default 'draft',
  expected_date date,
  notes text,
  created_by uuid references profiles(id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(12,2) not null check (qty > 0),
  unit_price numeric(12,2) not null, -- historical price snapshot, required by spec
  received_qty numeric(12,2) not null default 0
);

-- ===== Receiving =====
create table goods_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  order_id uuid not null references purchase_orders(id),
  status receipt_status not null default 'draft',
  received_by uuid references profiles(id),
  received_at timestamptz not null default now(),
  notes text
);

create table goods_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references goods_receipts(id) on delete cascade,
  order_item_id uuid not null references purchase_order_items(id),
  product_id uuid not null references products(id),
  qty_received numeric(12,2) not null default 0,
  status receipt_line_status not null default 'full',
  notes text
);

-- ===== Invoices =====
create table invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  supplier_id uuid not null references suppliers(id),
  invoice_number text not null,
  invoice_date date not null,
  received_date date not null default current_date,
  received_by uuid references profiles(id),
  amount_before_vat numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  review_status invoice_review_status not null default 'received',
  payment_status invoice_payment_status not null default 'unpaid',
  export_status invoice_export_status not null default 'not_sent',
  notes text,
  deleted_at timestamptz, -- soft delete only for financial records
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoices_dup_idx on invoices (supplier_id, invoice_number);

create table invoice_order_links (
  invoice_id uuid not null references invoices(id) on delete cascade,
  order_id uuid not null references purchase_orders(id) on delete cascade,
  primary key (invoice_id, order_id)
);

create table invoice_receipt_links (
  invoice_id uuid not null references invoices(id) on delete cascade,
  receipt_id uuid not null references goods_receipts(id) on delete cascade,
  primary key (invoice_id, receipt_id)
);

-- ===== Credits =====
create table credit_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  supplier_id uuid not null references suppliers(id),
  invoice_id uuid references invoices(id),
  receipt_item_id uuid references goods_receipt_items(id),
  reason credit_reason not null,
  amount numeric(12,2) not null check (amount > 0),
  status credit_status not null default 'open',
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ===== Payment requests & payments =====
create table payment_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  supplier_id uuid not null references suppliers(id),
  amount numeric(12,2) not null check (amount > 0),
  due_date date,
  status payment_request_status not null default 'draft',
  notes text,
  created_by uuid references profiles(id),
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  executor_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payment_request_invoices (
  payment_request_id uuid not null references payment_requests(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  amount_allocated numeric(12,2) not null check (amount_allocated > 0),
  primary key (payment_request_id, invoice_id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  number int generated always as identity,
  supplier_id uuid not null references suppliers(id),
  payment_request_id uuid references payment_requests(id),
  amount numeric(12,2) not null check (amount > 0),
  paid_date date not null default current_date,
  method text, -- העברה בנקאית / צ'ק / מזומן / אשראי
  reference text,
  executed_by uuid references profiles(id),
  notes text,
  created_at timestamptz not null default now()
);

-- Never a single payment_id on invoice: allocations junction (also supports credit offsets)
create table payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  invoice_id uuid references invoices(id),
  credit_id uuid references credit_requests(id),
  amount numeric(12,2) not null,
  check (invoice_id is not null or credit_id is not null)
);

-- ===== Bank reconciliation =====
create table bank_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  filename text not null,
  file_hash text not null, -- prevents accidental duplicate import of the same file
  column_mapping jsonb not null,
  row_count int not null default 0,
  imported_by uuid references profiles(id),
  imported_at timestamptz not null default now(),
  unique (org_id, file_hash)
);

create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  import_id uuid not null references bank_imports(id) on delete cascade,
  tx_date date not null,
  description text not null,
  amount numeric(12,2) not null check (amount >= 0),
  is_debit boolean not null default true,
  reference text,
  raw jsonb not null, -- original imported row, required by spec
  supplier_id uuid references suppliers(id), -- identified/assigned supplier
  status bank_tx_status not null default 'unmatched',
  row_hash text not null -- duplicate row detection across imports
);
create index bank_tx_dup_idx on bank_transactions (org_id, row_hash);

create table bank_allocations (
  id uuid primary key default gen_random_uuid(),
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,
  invoice_id uuid references invoices(id),
  payment_id uuid references payments(id),
  amount numeric(12,2) not null,
  confidence numeric(4,3), -- 0..1 suggestion confidence, null for manual
  confirmed boolean not null default false,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  check (invoice_id is not null or payment_id is not null)
);

-- ===== Exceptions =====
create table exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  type exception_type not null,
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  status exception_status not null default 'open',
  title text not null,
  details jsonb,
  supplier_id uuid references suppliers(id),
  invoice_id uuid references invoices(id),
  payment_id uuid references payments(id),
  payment_request_id uuid references payment_requests(id),
  bank_transaction_id uuid references bank_transactions(id),
  assigned_role user_role,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id),
  resolution_note text
);

-- ===== Documents, comments, audit =====
create table documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  entity_type text not null, -- invoice / receipt / payment / supplier / credit ...
  entity_id uuid not null,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index documents_entity_idx on documents (entity_type, entity_id);

create table comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  entity_type text not null,
  entity_id uuid not null,
  body text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  user_id uuid,
  action text not null, -- insert / update / delete / override_duplicate / approve / ...
  entity_type text not null,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_entity_idx on audit_logs (entity_type, entity_id);

create table monthly_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  month date not null, -- first day of month
  status text not null default 'open' check (status in ('open','sent')),
  sent_at timestamptz,
  sent_by uuid references profiles(id),
  notes text,
  unique (org_id, month)
);

-- ===== updated_at trigger =====
create or replace function set_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['suppliers','products','supplier_products','purchase_orders','invoices','payment_requests']
  loop
    execute format('create trigger %I_touch before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ===== Generic audit trigger for financial tables =====
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values)
  values (
    coalesce(
      case when TG_OP = 'DELETE' then (to_jsonb(old)->>'org_id')::uuid else (to_jsonb(new)->>'org_id')::uuid end,
      auth_org()),
    auth.uid(),
    lower(TG_OP),
    TG_TABLE_NAME,
    case when TG_OP = 'DELETE' then (to_jsonb(old)->>'id')::uuid else (to_jsonb(new)->>'id')::uuid end,
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when TG_OP in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['suppliers','supplier_products','purchase_orders','goods_receipts','invoices',
                           'credit_requests','payment_requests','payments','payment_allocations','bank_allocations']
  loop
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row_change()', t, t);
  end loop;
end $$;

-- ===== Balance views (security_invoker so RLS of underlying tables applies) =====
create view invoice_balances with (security_invoker = on) as
select i.id as invoice_id,
       i.total_amount,
       coalesce(pa.paid, 0)::numeric(12,2) as paid_amount,
       coalesce(cr.credited, 0)::numeric(12,2) as credited_amount,
       (i.total_amount - coalesce(pa.paid, 0) - coalesce(cr.credited, 0))::numeric(12,2) as balance
from invoices i
left join (select invoice_id, sum(amount) as paid from payment_allocations where invoice_id is not null group by invoice_id) pa
  on pa.invoice_id = i.id
left join (select invoice_id, sum(amount) as credited from credit_requests where status in ('offset','closed') and invoice_id is not null group by invoice_id) cr
  on cr.invoice_id = i.id
where i.deleted_at is null;

create view supplier_balances with (security_invoker = on) as
select s.id as supplier_id,
       coalesce(sum(ib.balance), 0)::numeric(12,2) as open_balance,
       count(ib.invoice_id) filter (where ib.balance > 0) as open_invoices
from suppliers s
left join invoices i on i.supplier_id = s.id and i.deleted_at is null
left join invoice_balances ib on ib.invoice_id = i.id
group by s.id;

-- ===== Row Level Security =====
do $$
declare t text;
begin
  foreach t in array array['organizations','profiles','categories','suppliers','supplier_categories','products',
    'supplier_products','price_history','purchase_requests','purchase_request_items','purchase_orders',
    'purchase_order_items','goods_receipts','goods_receipt_items','invoices','invoice_order_links',
    'invoice_receipt_links','credit_requests','payment_requests','payment_request_invoices','payments',
    'payment_allocations','bank_imports','bank_transactions','bank_allocations','exceptions','documents',
    'comments','audit_logs','monthly_exports']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- organizations
create policy org_select on organizations for select using (id = auth_org());
create policy org_update on organizations for update using (id = auth_org() and auth_role() = 'owner');

-- profiles: everyone in org can see members; owner manages; user can update own name/phone
create policy profiles_select on profiles for select using (org_id = auth_org());
create policy profiles_owner_all on profiles for all using (org_id = auth_org() and auth_role() = 'owner');
create policy profiles_self_update on profiles for update using (id = auth.uid());

-- catalog: staff read; office/owner write; products also kitchen write
create policy categories_select on categories for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy categories_write on categories for all using (org_id = auth_org() and auth_role() in ('owner','office'));

create policy suppliers_select on suppliers for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','kitchen','accountant')
  or (auth_role() = 'payer' and exists (select 1 from payment_requests pr where pr.supplier_id = suppliers.id
        and pr.status in ('approved','sent_for_execution','executed','matched')))));
create policy suppliers_write on suppliers for all using (org_id = auth_org() and auth_role() in ('owner','office'));

create policy supplier_categories_select on supplier_categories for select using (
  exists (select 1 from suppliers s where s.id = supplier_id and s.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen','accountant'));
create policy supplier_categories_write on supplier_categories for all using (
  exists (select 1 from suppliers s where s.id = supplier_id and s.org_id = auth_org())
  and auth_role() in ('owner','office'));

create policy products_select on products for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy products_write on products for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

create policy supplier_products_select on supplier_products for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy supplier_products_write on supplier_products for all using (org_id = auth_org() and auth_role() in ('owner','office'));

create policy price_history_select on price_history for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy price_history_write on price_history for insert with check (org_id = auth_org() and auth_role() in ('owner','office'));

-- purchasing: owner/office/kitchen operate, accountant reads
create policy purchase_requests_select on purchase_requests for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy purchase_requests_write on purchase_requests for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

create policy pri_select on purchase_request_items for select using (
  exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen','accountant'));
create policy pri_write on purchase_request_items for all using (
  exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen'));

create policy purchase_orders_select on purchase_orders for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy purchase_orders_write on purchase_orders for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

create policy poi_select on purchase_order_items for select using (
  exists (select 1 from purchase_orders o where o.id = order_id and o.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen','accountant'));
create policy poi_write on purchase_order_items for all using (
  exists (select 1 from purchase_orders o where o.id = order_id and o.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen'));

create policy goods_receipts_select on goods_receipts for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy goods_receipts_write on goods_receipts for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

create policy gri_select on goods_receipt_items for select using (
  exists (select 1 from goods_receipts g where g.id = receipt_id and g.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen','accountant'));
create policy gri_write on goods_receipt_items for all using (
  exists (select 1 from goods_receipts g where g.id = receipt_id and g.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen'));

-- invoices: staff full flow; payer may read invoices referenced by approved payment requests
create policy invoices_select on invoices for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','kitchen','accountant')
  or (auth_role() = 'payer' and exists (
      select 1 from payment_request_invoices pri
      join payment_requests pr on pr.id = pri.payment_request_id
      where pri.invoice_id = invoices.id and pr.status in ('approved','sent_for_execution','executed','matched')))));
create policy invoices_insert on invoices for insert with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy invoices_update on invoices for update using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

create policy iol_select on invoice_order_links for select using (
  exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth_org()));
create policy iol_write on invoice_order_links for all using (
  exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen'));

create policy irl_select on invoice_receipt_links for select using (
  exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth_org()));
create policy irl_write on invoice_receipt_links for all using (
  exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth_org())
  and auth_role() in ('owner','office','kitchen'));

create policy credit_requests_select on credit_requests for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy credit_requests_write on credit_requests for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

-- payment requests: office/owner manage; payer sees approved+, and may advance execution status
create policy payment_requests_select on payment_requests for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','accountant')
  or (auth_role() = 'payer' and status in ('approved','sent_for_execution','executed','matched'))));
create policy payment_requests_write on payment_requests for all using (org_id = auth_org() and auth_role() in ('owner','office'));
create policy payment_requests_payer_update on payment_requests for update
  using (org_id = auth_org() and auth_role() = 'payer' and status in ('approved','sent_for_execution'))
  with check (org_id = auth_org() and status in ('sent_for_execution','executed'));

create policy pri2_select on payment_request_invoices for select using (
  exists (select 1 from payment_requests pr where pr.id = payment_request_id and pr.org_id = auth_org() and (
    auth_role() in ('owner','office','accountant')
    or (auth_role() = 'payer' and pr.status in ('approved','sent_for_execution','executed','matched')))));
create policy pri2_write on payment_request_invoices for all using (
  exists (select 1 from payment_requests pr where pr.id = payment_request_id and pr.org_id = auth_org())
  and auth_role() in ('owner','office'));

-- payments: office/owner manage; payer records the transfer it executed
create policy payments_select on payments for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','accountant')
  or (auth_role() = 'payer' and executed_by = auth.uid())));
create policy payments_write on payments for all using (org_id = auth_org() and auth_role() in ('owner','office'));
create policy payments_payer_insert on payments for insert with check (org_id = auth_org() and auth_role() = 'payer' and executed_by = auth.uid());

create policy pa_select on payment_allocations for select using (
  exists (select 1 from payments p where p.id = payment_id and p.org_id = auth_org())
  and auth_role() in ('owner','office','accountant'));
create policy pa_write on payment_allocations for all using (
  exists (select 1 from payments p where p.id = payment_id and p.org_id = auth_org())
  and auth_role() in ('owner','office'));

-- bank: office/owner manage, accountant reads
create policy bank_imports_select on bank_imports for select using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy bank_imports_write on bank_imports for all using (org_id = auth_org() and auth_role() in ('owner','office'));

create policy bank_tx_select on bank_transactions for select using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy bank_tx_write on bank_transactions for all using (org_id = auth_org() and auth_role() in ('owner','office'));

create policy bank_alloc_select on bank_allocations for select using (
  exists (select 1 from bank_transactions t where t.id = bank_transaction_id and t.org_id = auth_org())
  and auth_role() in ('owner','office','accountant'));
create policy bank_alloc_write on bank_allocations for all using (
  exists (select 1 from bank_transactions t where t.id = bank_transaction_id and t.org_id = auth_org())
  and auth_role() in ('owner','office'));

-- exceptions
create policy exceptions_select on exceptions for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy exceptions_write on exceptions for all using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

-- documents: staff read; uploaders per role; payer sees/uploads its own (proof of transfer)
create policy documents_select on documents for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','kitchen','accountant')
  or (auth_role() = 'payer' and uploaded_by = auth.uid())));
create policy documents_insert on documents for insert with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen','payer'));
create policy documents_delete on documents for delete using (org_id = auth_org() and auth_role() in ('owner','office'));

-- comments
create policy comments_select on comments for select using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy comments_insert on comments for insert with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

-- audit: owner/office/accountant read; inserts come from triggers (definer) or app actions
create policy audit_select on audit_logs for select using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy audit_insert on audit_logs for insert with check (org_id = auth_org());

-- monthly exports
create policy monthly_exports_select on monthly_exports for select using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy monthly_exports_write on monthly_exports for all using (org_id = auth_org() and auth_role() in ('owner','office'));

-- ===== Storage bucket for documents (invoice photos, delivery notes, transfer proofs) =====
insert into storage.buckets (id, name, public) values ('documents', 'documents', false);

create policy docs_storage_read on storage.objects for select
  using (bucket_id = 'documents' and auth_role() in ('owner','office','kitchen','accountant','payer'));
create policy docs_storage_insert on storage.objects for insert
  with check (bucket_id = 'documents' and auth_role() in ('owner','office','kitchen','payer'));
create policy docs_storage_delete on storage.objects for delete
  using (bucket_id = 'documents' and auth_role() in ('owner','office'));
