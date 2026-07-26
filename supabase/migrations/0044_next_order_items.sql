-- 0044 — רשימת "להזמנה הבאה" היא כוונת רכש אישית, לא רשומה כספית:
-- אין RPC ואין audit; user_id נגזר בשרת ואינו פתוח לכתיבה מהדפדפן.
-- התפוגה נאכפת בקריאה בלבד, בלי cron שמוחק כוונה בשקט. דחייה חוזרת
-- מרעננת created_at בשרת כדי שגם פריט שפג יחזור לתצוגה.

create table public.next_order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  user_id uuid not null default auth.uid(),
  product_id uuid not null,
  qty numeric(12,2) not null check (qty > 0),
  source_request_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, product_id)
);

alter table public.next_order_items
  add constraint next_order_items_product_tenant_fk
  foreign key (org_id, product_id) references public.products(org_id, id) on delete cascade;
alter table public.next_order_items
  add constraint next_order_items_user_tenant_fk
  foreign key (org_id, user_id) references public.profiles(org_id, id) on delete cascade;
alter table public.next_order_items
  add constraint next_order_items_source_request_tenant_fk
  foreign key (org_id, source_request_id) references public.purchase_requests(org_id, id)
  on delete set null (source_request_id);

create index next_order_items_user_created_idx
  on public.next_order_items (user_id, created_at desc);

create function public.touch_next_order_item_created_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  return new;
end
$$;

create trigger next_order_items_touch_created_at
  before update on public.next_order_items
  for each row execute function public.touch_next_order_item_created_at();

revoke all on function public.touch_next_order_item_created_at() from public, anon, authenticated;

alter table public.next_order_items enable row level security;

create policy next_order_items_select_own
  on public.next_order_items for select to authenticated
  using (
    org_id = auth_org()
    and user_id = auth.uid()
    and auth_role() in ('owner', 'office', 'kitchen')
  );

create policy next_order_items_insert_own
  on public.next_order_items for insert to authenticated
  with check (
    org_id = auth_org()
    and user_id = auth.uid()
    and auth_role() in ('owner', 'office', 'kitchen')
    and exists (
      select 1
      from public.products p
      where p.org_id = next_order_items.org_id
        and p.id = next_order_items.product_id
        and p.active
    )
  );

create policy next_order_items_update_own
  on public.next_order_items for update to authenticated
  using (
    org_id = auth_org()
    and user_id = auth.uid()
    and auth_role() in ('owner', 'office', 'kitchen')
  )
  with check (
    org_id = auth_org()
    and user_id = auth.uid()
    and auth_role() in ('owner', 'office', 'kitchen')
    and exists (
      select 1
      from public.products p
      where p.org_id = next_order_items.org_id
        and p.id = next_order_items.product_id
        and p.active
    )
  );

create policy next_order_items_delete_own
  on public.next_order_items for delete to authenticated
  using (
    org_id = auth_org()
    and user_id = auth.uid()
    and auth_role() in ('owner', 'office', 'kitchen')
  );

revoke all on table public.next_order_items from anon, authenticated;
grant select on table public.next_order_items to authenticated;
grant insert (org_id, product_id, qty, source_request_id)
  on table public.next_order_items to authenticated;
-- PostgREST includes every insert payload column in ON CONFLICT DO UPDATE.
grant update (org_id, product_id, qty, source_request_id)
  on table public.next_order_items to authenticated;
grant delete on table public.next_order_items to authenticated;
