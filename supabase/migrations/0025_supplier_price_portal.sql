-- Supplier upload-only portal: supplier invitations, isolated reads and monthly submissions.

-- ===== Supplier invitations =====

alter table invitations add column supplier_id uuid;
alter table invitations drop constraint invitations_role_invitable;
alter table invitations add constraint invitations_supplier_role_check check (
  (role = 'supplier' and supplier_id is not null)
  or (role <> 'supplier' and supplier_id is null)
);
alter table invitations add constraint invitations_supplier_tenant_fk
  foreign key (org_id, supplier_id) references suppliers(org_id, id) on delete restrict not valid;
alter table invitations validate constraint invitations_supplier_tenant_fk;
create index invitations_org_supplier_idx on invitations (org_id, supplier_id);

create or replace function create_invitation(
  p_email text,
  p_role user_role,
  p_supplier_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_uid uuid := auth.uid();
  v_email text := lower(trim(p_email));
  v_raw text;
  v_expires timestamptz;
  v_id uuid;
  v_name text;
  v_existing invitations;
  v_has_existing boolean := false;
  v_cooldown int;
  v_daily_limit int;
begin
  if v_org is null or v_actor <> 'owner' or v_uid is null then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if (p_role = 'supplier') is distinct from (p_supplier_id is not null) then
    raise exception 'supplier_invitation_requires_supplier' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from suppliers s
    where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  ) then
    raise exception 'supplier_outside_organization' using errcode = '23514';
  end if;
  if exists (
    select 1 from profiles p join auth.users u on u.id = p.id
    where p.org_id = v_org and lower(u.email) = v_email
  ) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  select * into v_existing
  from invitations
  where org_id = v_org and lower(email) = v_email
    and accepted_at is null and revoked_at is null
  for update;
  v_has_existing := found;

  select cooldown_seconds, daily_limit into v_cooldown, v_daily_limit
  from invitation_rate_limits(v_org);
  if v_has_existing and v_existing.last_sent_at > now() - make_interval(secs => v_cooldown) then
    raise exception 'invite_cooldown' using errcode = '42900';
  end if;
  if (select count(*) from audit_logs
      where org_id = v_org and user_id = v_uid
        and action = 'invitation_delivery_requested'
        and created_at >= now() - interval '24 hours') >= v_daily_limit then
    raise exception 'invite_daily_limit' using errcode = '42900';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));
  insert into invitations (
    org_id, email, role, supplier_id, token_hash, expires_at, invited_by
  ) values (
    v_org, v_email, p_role, p_supplier_id,
    encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'), v_expires, v_uid
  )
  on conflict (org_id, lower(email)) where accepted_at is null and revoked_at is null
  do update set role = excluded.role,
                supplier_id = excluded.supplier_id,
                token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                invited_by = excluded.invited_by,
                last_sent_at = now(),
                send_count = invitations.send_count + 1
  returning id into v_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_uid, 'invitation_delivery_requested', 'invitations', v_id,
    jsonb_build_object('email', v_email, 'role', p_role, 'supplier_id', p_supplier_id),
    'יצירת הזמנה ומשלוח קישור'
  );
  select name into v_name from organizations where id = v_org;
  return jsonb_build_object(
    'invitation_id', v_id, 'token', v_raw, 'email', v_email,
    'role', p_role, 'supplier_id', p_supplier_id,
    'org_name', v_name, 'expires_at', v_expires
  );
end
$$;

-- Backward-compatible staff invitation. Supplier invitations must use the supplier-bound overload.
create or replace function create_invitation(p_email text, p_role user_role)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_role = 'supplier' then
    raise exception 'supplier_invitation_requires_supplier' using errcode = '22023';
  end if;
  return create_invitation(p_email, p_role, null);
end
$$;

create or replace function accept_invitation(p_token text, p_full_name text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  inv invitations;
  v_uid uuid := auth.uid();
  v_email text := lower(auth.jwt() ->> 'email');
  v_name text := trim(coalesce(p_full_name, ''));
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'full_name_required' using errcode = '22023'; end if;
  if p_token is null or length(p_token) <> 64 then
    raise exception 'invitation_unknown' using errcode = 'P0002';
  end if;

  select * into inv from invitations
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;
  if inv.expires_at <= now() then raise exception 'invitation_expired' using errcode = 'P0002'; end if;
  if v_email is null or v_email <> inv.email then
    raise exception 'email_mismatch' using errcode = '42501';
  end if;
  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'profile_exists' using errcode = '23505';
  end if;
  if exists (select 1 from organizations o where o.id = inv.org_id and o.status = 'suspended') then
    raise exception 'org_suspended' using errcode = 'P0002';
  end if;
  if inv.supplier_id is not null and not exists (
    select 1 from suppliers s
    where s.org_id = inv.org_id and s.id = inv.supplier_id and s.deleted_at is null
  ) then
    raise exception 'invitation_supplier_unavailable' using errcode = 'P0002';
  end if;

  insert into profiles (id, org_id, full_name, role, phone, active, supplier_id)
  values (
    v_uid, inv.org_id, v_name, inv.role,
    nullif(trim(coalesce(p_phone, '')), ''), true, inv.supplier_id
  );
  update invitations set accepted_at = now(), accepted_by = v_uid where id = inv.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    inv.org_id, v_uid, 'invitation_accepted', 'invitations', inv.id,
    jsonb_build_object('email', inv.email, 'role', inv.role, 'supplier_id', inv.supplier_id),
    'קבלת הזמנה והצטרפות לארגון'
  );
  return jsonb_build_object('org_id', inv.org_id, 'role', inv.role, 'supplier_id', inv.supplier_id);
end
$$;

create or replace function resend_invitation(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_uid uuid := auth.uid();
  inv invitations;
  v_raw text;
  v_expires timestamptz;
  v_name text;
  v_cooldown int;
  v_daily_limit int;
begin
  if v_org is null or v_actor <> 'owner' or v_uid is null then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select * into inv from invitations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;
  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;
  if inv.supplier_id is not null and not exists (
    select 1 from suppliers s
    where s.org_id = v_org and s.id = inv.supplier_id and s.deleted_at is null
  ) then
    raise exception 'supplier_outside_organization' using errcode = '23514';
  end if;

  select cooldown_seconds, daily_limit into v_cooldown, v_daily_limit
  from invitation_rate_limits(v_org);
  if inv.last_sent_at > now() - make_interval(secs => v_cooldown) then
    raise exception 'invite_cooldown' using errcode = '42900';
  end if;
  if (select count(*) from audit_logs
      where org_id = v_org and user_id = v_uid
        and action = 'invitation_delivery_requested'
        and created_at >= now() - interval '24 hours') >= v_daily_limit then
    raise exception 'invite_daily_limit' using errcode = '42900';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));
  update invitations
  set token_hash = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
      expires_at = v_expires, last_sent_at = now(), send_count = send_count + 1
  where id = inv.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, v_uid, 'invitation_delivery_requested', 'invitations', inv.id,
    jsonb_build_object('last_sent_at', inv.last_sent_at, 'send_count', inv.send_count),
    jsonb_build_object('last_sent_at', now(), 'send_count', inv.send_count + 1),
    'שליחה מחדש של הזמנה'
  );
  select name into v_name from organizations where id = v_org;
  return jsonb_build_object(
    'invitation_id', inv.id, 'token', v_raw, 'email', inv.email,
    'role', inv.role, 'supplier_id', inv.supplier_id,
    'org_name', v_name, 'expires_at', v_expires
  );
end
$$;

create or replace function lookup_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  inv invitations;
  v_name text;
  v_labels jsonb;
begin
  if p_token is null or length(p_token) <> 64 then
    return jsonb_build_object('status', 'unknown');
  end if;
  select * into inv from invitations
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  if inv.supplier_id is not null and not exists (
    select 1 from suppliers s
    where s.org_id = inv.org_id and s.id = inv.supplier_id and s.deleted_at is null
  ) then
    return jsonb_build_object('status', 'unknown');
  end if;

  select o.name, o.settings->'role_labels' into v_name, v_labels
  from organizations o where o.id = inv.org_id;
  return jsonb_build_object(
    'status', case when inv.revoked_at is not null then 'revoked'
                   when inv.accepted_at is not null then 'accepted'
                   when inv.expires_at <= now() then 'expired'
                   else 'valid' end,
    'email', inv.email, 'role', inv.role, 'org_name', v_name,
    'role_labels', v_labels, 'expires_at', inv.expires_at
  );
end
$$;

revoke all on function create_invitation(text, user_role, uuid) from public, anon;
revoke all on function create_invitation(text, user_role) from public, anon;
revoke all on function accept_invitation(text, text, text) from public;
revoke all on function resend_invitation(uuid) from public, anon;
revoke all on function lookup_invitation(text) from public;
grant execute on function create_invitation(text, user_role, uuid) to authenticated;
grant execute on function create_invitation(text, user_role) to authenticated;
grant execute on function accept_invitation(text, text, text) to authenticated;
grant execute on function resend_invitation(uuid) to authenticated;
grant execute on function lookup_invitation(text) to anon, authenticated;

-- ===== Immutable monthly submission ledger =====

create table supplier_price_submissions (
  id uuid primary key,
  org_id uuid not null default auth_org() references organizations(id),
  supplier_id uuid not null,
  effective_month date not null,
  correction_number integer not null,
  payload_hash text not null,
  row_count integer not null,
  created_count integer not null default 0,
  updated_count integer not null,
  unchanged_count integer not null,
  submitted_by uuid not null,
  submitted_at timestamptz not null default now(),
  constraint supplier_price_submissions_org_id_id_key unique (org_id, id),
  constraint supplier_price_submissions_supplier_fk
    foreign key (org_id, supplier_id) references suppliers(org_id, id) on delete restrict,
  constraint supplier_price_submissions_actor_fk
    foreign key (org_id, submitted_by) references profiles(org_id, id) on delete restrict,
  constraint supplier_price_submissions_month_check
    check (effective_month = date_trunc('month', effective_month)::date),
  constraint supplier_price_submissions_correction_check check (correction_number > 0),
  constraint supplier_price_submissions_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint supplier_price_submissions_counts_check check (
    row_count > 0 and created_count >= 0 and updated_count >= 0 and unchanged_count >= 0
    and row_count = created_count + updated_count + unchanged_count
  ),
  unique (org_id, supplier_id, effective_month, correction_number)
);

create index supplier_price_submissions_org_supplier_month_idx
  on supplier_price_submissions (org_id, supplier_id, effective_month desc, submitted_at desc);

alter table supplier_price_submissions enable row level security;
create policy supplier_price_submissions_select on supplier_price_submissions for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office')
    or (auth_role() = 'supplier' and supplier_id = auth_supplier())
  )
);

revoke all on table supplier_price_submissions from public, anon, authenticated;
grant select (
  id, org_id, supplier_id, effective_month, correction_number, row_count,
  created_count, updated_count, unchanged_count, submitted_by, submitted_at
) on supplier_price_submissions to authenticated;

create or replace function reject_supplier_price_submission_mutation()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'supplier_price_submissions_are_immutable' using errcode = '42501';
end
$$;

create trigger supplier_price_submissions_immutable
before update or delete on supplier_price_submissions
for each row execute function reject_supplier_price_submission_mutation();

revoke all on function reject_supplier_price_submission_mutation()
  from public, anon, authenticated;

-- ===== Supplier reads use one projection; base tables no longer expose whole rows =====

drop policy if exists org_select on organizations;
create policy org_select on organizations for select to authenticated
  using (id = auth_org() and auth_role() <> 'supplier');

drop policy if exists suppliers_select on suppliers;
create policy suppliers_select on suppliers for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner','office','kitchen','accountant')
    or (auth_role() = 'payer' and exists (
      select 1 from payment_requests pr
      where pr.org_id = suppliers.org_id and pr.supplier_id = suppliers.id
        and pr.status in ('approved','sent_for_execution','executed','matched')
    ))
  )
);

drop policy if exists products_select on products;
create policy products_select on products for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant')
);

drop policy if exists sp_supplier_select on supplier_products;
drop policy if exists sp_supplier_insert on supplier_products;
drop policy if exists sp_supplier_update on supplier_products;
drop policy if exists ph_supplier_select on price_history;
drop policy if exists ph_supplier_insert on price_history;

create or replace function supplier_portal_context()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_supplier uuid := auth_supplier();
  v_org_name text;
  v_supplier_name text;
  v_prices jsonb;
begin
  if v_org is null or auth.uid() is null or auth_role() <> 'supplier' or v_supplier is null then
    raise exception 'supplier_portal_not_authorized' using errcode = '42501';
  end if;

  select o.name, s.name into v_org_name, v_supplier_name
  from organizations o
  join suppliers s on s.org_id = o.id and s.id = v_supplier and s.deleted_at is null
  where o.id = v_org;
  if not found then raise exception 'supplier_portal_not_authorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier_product_id', sp.id,
    'product_id', p.id,
    'product_name', p.name,
    'unit', p.unit,
    'current_price', sp.current_price,
    'previous_price', sp.previous_price,
    'price_effective_date', sp.price_effective_date,
    'available', sp.available,
    'supplier_sku', sp.supplier_sku,
    'min_qty', sp.min_qty,
    'package_size', sp.package_size,
    'updated_at', sp.updated_at
  ) order by p.name, p.id), '[]'::jsonb)
  into v_prices
  from supplier_products sp
  join products p on p.org_id = sp.org_id and p.id = sp.product_id and p.active
  where sp.org_id = v_org and sp.supplier_id = v_supplier;

  return jsonb_build_object(
    'organization_name', v_org_name,
    'supplier', jsonb_build_object('id', v_supplier, 'name', v_supplier_name),
    'current_month', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date,
    'prices', v_prices
  );
end
$$;

revoke all on function supplier_portal_context() from public, anon;
grant execute on function supplier_portal_context() to authenticated;

-- ===== Price commands =====

create or replace function set_supplier_product_price(
  p_supplier_product_id uuid,
  p_price numeric,
  p_effective_date date,
  p_available boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_row supplier_products;
  v_reason text := nullif(trim(p_reason), '');
  v_price numeric := round(p_price, 2);
  v_price_changed boolean;
  v_history_changed boolean;
begin
  if v_org is null or v_user is null or auth_role() not in ('owner', 'office') then
    raise exception 'price_write_not_authorized' using errcode = '42501';
  end if;
  if p_supplier_product_id is null or p_price is null or p_effective_date is null
     or p_available is null or v_reason is null or v_price <= 0 or v_price > 1000000 then
    raise exception 'price_values_invalid' using errcode = '22023';
  end if;

  select * into v_row from supplier_products sp
  where sp.id = p_supplier_product_id and sp.org_id = v_org
  for update;
  if not found then raise exception 'supplier_product_not_found' using errcode = 'P0002'; end if;

  v_price_changed := round(v_row.current_price, 2) <> v_price;
  v_history_changed := v_price_changed or v_row.price_effective_date <> p_effective_date;
  if not v_price_changed
     and v_row.price_effective_date = p_effective_date
     and v_row.available = p_available then
    return jsonb_build_object(
      'supplier_product_id', v_row.id, 'price', v_row.current_price,
      'available', v_row.available, 'price_changed', false, 'idempotent', true
    );
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  update supplier_products
  set current_price = v_price,
      previous_price = case when v_price_changed then v_row.current_price else v_row.previous_price end,
      price_effective_date = p_effective_date,
      available = p_available
  where id = v_row.id;

  if v_history_changed then
    insert into price_history (org_id, supplier_product_id, price, effective_date, created_by)
    values (v_org, v_row.id, v_price, p_effective_date, v_user);
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_product_price_set', 'supplier_products', v_row.id,
    jsonb_build_object(
      'price', v_row.current_price,
      'effective_date', v_row.price_effective_date,
      'available', v_row.available
    ),
    jsonb_build_object(
      'price', v_price, 'effective_date', p_effective_date, 'available', p_available,
      'price_changed', v_price_changed, 'history_changed', v_history_changed
    ),
    v_reason
  );

  return jsonb_build_object(
    'supplier_product_id', v_row.id, 'price', v_price,
    'available', p_available, 'price_changed', v_price_changed, 'idempotent', false
  );
end
$$;

revoke all on function set_supplier_product_price(uuid, numeric, date, boolean, text) from public, anon;
grant execute on function set_supplier_product_price(uuid, numeric, date, boolean, text) to authenticated;

-- Existing three-argument import remains the owner/office bulk-maintenance command.
create or replace function import_supplier_prices(
  p_rows jsonb,
  p_effective_date date,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_count int;
  v_distinct_count int;
  v_row record;
  v_existing supplier_products;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
begin
  if v_org is null or v_user is null or auth_role() not in ('owner', 'office') then
    raise exception 'price_import_not_authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or p_effective_date is null or v_reason is null then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct (supplier_id, product_id))
  into v_count, v_distinct_count
  from jsonb_to_recordset(p_rows) as row(
    supplier_id uuid, product_id uuid, price numeric, available boolean
  );
  if v_count = 0 or v_count > 5000 or v_count <> v_distinct_count
     or exists (
       select 1 from jsonb_to_recordset(p_rows) as row(
         supplier_id uuid, product_id uuid, price numeric, available boolean
       )
       where supplier_id is null or product_id is null or price is null
          or round(price, 2) <= 0 or round(price, 2) > 1000000
     ) then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  perform 1
  from suppliers s
  join (
    select distinct supplier_id from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = s.id
  where s.org_id = v_org and s.deleted_at is null
  order by s.id for update of s;

  perform 1
  from products p
  join (
    select distinct product_id from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.product_id = p.id
  where p.org_id = v_org and p.active
  order by p.id for update of p;

  perform 1
  from supplier_products sp
  join (
    select supplier_id, product_id from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = sp.supplier_id and input.product_id = sp.product_id
  where sp.org_id = v_org
  order by sp.id for update of sp;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    left join suppliers s
      on s.id = row.supplier_id and s.org_id = v_org and s.deleted_at is null
    left join products p
      on p.id = row.product_id and p.org_id = v_org and p.active
    where s.id is null or p.id is null
  ) then
    raise exception 'price_import_target_invalid' using errcode = '22023';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  for v_row in
    select supplier_id, product_id, round(price, 2) as price, coalesce(available, true) as available
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    order by supplier_id, product_id
  loop
    v_existing := null;
    select * into v_existing from supplier_products sp
    where sp.org_id = v_org
      and sp.supplier_id = v_row.supplier_id
      and sp.product_id = v_row.product_id
    for update;

    if not found then
      insert into supplier_products (
        org_id, supplier_id, product_id, current_price, price_effective_date, available
      ) values (
        v_org, v_row.supplier_id, v_row.product_id, v_row.price,
        p_effective_date, v_row.available
      ) returning * into v_existing;
      insert into price_history (org_id, supplier_product_id, price, effective_date, created_by)
      values (v_org, v_existing.id, v_row.price, p_effective_date, v_user);
      v_created := v_created + 1;
    elsif round(v_existing.current_price, 2) <> v_row.price
       or v_existing.price_effective_date <> p_effective_date
       or v_existing.available <> v_row.available then
      update supplier_products
      set current_price = v_row.price,
          previous_price = case
            when round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price
            else v_existing.previous_price end,
          price_effective_date = p_effective_date,
          available = v_row.available
      where id = v_existing.id;
      if round(v_existing.current_price, 2) <> v_row.price
         or v_existing.price_effective_date <> p_effective_date then
        insert into price_history (org_id, supplier_product_id, price, effective_date, created_by)
        values (v_org, v_existing.id, v_row.price, p_effective_date, v_user);
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'supplier_prices_imported', 'supplier_products', null,
    jsonb_build_object(
      'row_count', v_count, 'created', v_created, 'updated', v_updated,
      'unchanged', v_unchanged, 'effective_date', p_effective_date
    ),
    v_reason
  );
  return jsonb_build_object(
    'row_count', v_count, 'created', v_created,
    'updated', v_updated, 'unchanged', v_unchanged
  );
end
$$;

revoke all on function import_supplier_prices(jsonb, date, text) from public, anon;
grant execute on function import_supplier_prices(jsonb, date, text) to authenticated;

-- Supplier upload command. It can update only pre-existing supplier/product pairs.
create or replace function import_supplier_prices(
  p_rows jsonb,
  p_effective_date date,
  p_reason text,
  p_submission_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_supplier uuid := auth_supplier();
  v_reason text := nullif(trim(p_reason), '');
  v_month date := date_trunc('month', p_effective_date)::date;
  v_current_month date := date_trunc('month', now() at time zone 'Asia/Jerusalem')::date;
  v_hash text;
  v_count int;
  v_distinct_count int;
  v_row record;
  v_existing supplier_products;
  v_submission supplier_price_submissions;
  v_correction int;
  v_updated int := 0;
  v_unchanged int := 0;
begin
  if v_org is null or v_user is null or auth_role() <> 'supplier' or v_supplier is null then
    raise exception 'price_import_not_authorized' using errcode = '42501';
  end if;
  if p_submission_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or p_effective_date is null or v_reason is null then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;
  if p_effective_date <> v_current_month then
    raise exception 'supplier_submission_month_invalid' using errcode = '22023';
  end if;

  select encode(sha256(convert_to(
    coalesce(jsonb_agg(jsonb_build_object(
      'supplier_id', supplier_id,
      'product_id', product_id,
      'price', round(price, 2)
    ) order by product_id), '[]'::jsonb)::text || '|' || v_month::text,
    'UTF8'
  )), 'hex') into v_hash
  from jsonb_to_recordset(p_rows) as row(
    supplier_id uuid, product_id uuid, price numeric, available boolean
  );
  perform pg_advisory_xact_lock(hashtextextended(p_submission_id::text, 0));
  select * into v_submission from supplier_price_submissions s
  where s.org_id = v_org and s.id = p_submission_id
  for update;
  if found then
    if v_submission.supplier_id <> v_supplier
       or v_submission.effective_month <> v_month
       or v_submission.payload_hash <> v_hash then
      raise exception 'supplier_submission_id_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'submission_id', v_submission.id,
      'effective_month', v_submission.effective_month,
      'correction_number', v_submission.correction_number,
      'row_count', v_submission.row_count,
      'created', v_submission.created_count,
      'updated', v_submission.updated_count,
      'unchanged', v_submission.unchanged_count,
      'idempotent', true
    );
  end if;

  select count(*), count(distinct product_id)
  into v_count, v_distinct_count
  from jsonb_to_recordset(p_rows) as row(
    supplier_id uuid, product_id uuid, price numeric, available boolean
  );
  if v_count = 0 or v_count > 5000 or v_count <> v_distinct_count
     or exists (
       select 1 from jsonb_to_recordset(p_rows) as row(
         supplier_id uuid, product_id uuid, price numeric, available boolean
       )
       where supplier_id is null or supplier_id <> v_supplier
          or product_id is null or price is null
          or round(price, 2) <= 0 or round(price, 2) > 1000000
     ) then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  -- Serializes correction numbers and keeps the established supplier -> product -> price lock order.
  perform 1 from suppliers s
  where s.org_id = v_org and s.id = v_supplier and s.deleted_at is null
  for update;
  if not found then raise exception 'price_import_not_authorized' using errcode = '42501'; end if;

  perform 1
  from products p
  join (
    select distinct product_id from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.product_id = p.id
  where p.org_id = v_org and p.active
  order by p.id for update of p;

  perform 1
  from supplier_products sp
  join (
    select product_id from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.product_id = sp.product_id
  where sp.org_id = v_org and sp.supplier_id = v_supplier
  order by sp.id for update of sp;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    left join products p
      on p.org_id = v_org and p.id = row.product_id and p.active
    left join supplier_products sp
      on sp.org_id = v_org and sp.supplier_id = v_supplier and sp.product_id = row.product_id
    where p.id is null or sp.id is null
  ) then
    raise exception 'supplier_price_pair_unknown' using errcode = '22023';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  for v_row in
    select product_id, round(price, 2) as price, coalesce(available, true) as available
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    order by product_id
  loop
    select * into strict v_existing from supplier_products sp
    where sp.org_id = v_org and sp.supplier_id = v_supplier and sp.product_id = v_row.product_id
    for update;

    if round(v_existing.current_price, 2) <> v_row.price
       or v_existing.price_effective_date <> v_month then
      update supplier_products
      set current_price = v_row.price,
          previous_price = case
            when round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price
            else v_existing.previous_price end,
          price_effective_date = v_month
      where id = v_existing.id;
      if round(v_existing.current_price, 2) <> v_row.price
         or v_existing.price_effective_date <> v_month then
        insert into price_history (org_id, supplier_product_id, price, effective_date, created_by)
        values (v_org, v_existing.id, v_row.price, v_month, v_user);
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  select count(*) + 1 into v_correction
  from supplier_price_submissions s
  where s.org_id = v_org and s.supplier_id = v_supplier and s.effective_month = v_month;

  insert into supplier_price_submissions (
    id, org_id, supplier_id, effective_month, correction_number, payload_hash,
    row_count, created_count, updated_count, unchanged_count, submitted_by
  ) values (
    p_submission_id, v_org, v_supplier, v_month, v_correction, v_hash,
    v_count, 0, v_updated, v_unchanged, v_user
  );

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'supplier_prices_submitted', 'supplier_price_submissions', p_submission_id,
    jsonb_build_object(
      'supplier_id', v_supplier, 'effective_month', v_month,
      'correction_number', v_correction, 'row_count', v_count,
      'updated', v_updated, 'unchanged', v_unchanged
    ),
    v_reason
  );

  return jsonb_build_object(
    'submission_id', p_submission_id, 'effective_month', v_month,
    'correction_number', v_correction, 'row_count', v_count,
    'created', 0, 'updated', v_updated, 'unchanged', v_unchanged,
    'idempotent', false
  );
exception
  when no_data_found then
    raise exception 'supplier_price_pair_unknown' using errcode = '22023';
end
$$;

revoke all on function import_supplier_prices(jsonb, date, text, uuid) from public, anon;
grant execute on function import_supplier_prices(jsonb, date, text, uuid) to authenticated;
