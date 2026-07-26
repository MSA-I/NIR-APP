-- Move routine purchase-order lifecycle changes behind one reasoned, tenant-scoped command.
-- Cancellation remains owned by cancel_purchase_order().

revoke update on table public.purchase_orders from public, anon, authenticated;
revoke update (status, sent_at, confirmed_at, confirmation_note, expected_date)
  on table public.purchase_orders from public, anon, authenticated;

create or replace function public.transition_purchase_order_status(
  p_purchase_order_id uuid,
  p_target_status text,
  p_reason text,
  p_confirmation_note text,
  p_expected_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note text := nullif(btrim(coalesce(p_confirmation_note, '')), '');
  v_target public.po_status;
  v_order public.purchase_orders;
  v_updated public.purchase_orders;
  v_previous_writer text := coalesce(
    current_setting('app.p1_financial_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'purchase_order_status_not_authorized' using errcode = '42501';
  end if;
  if p_purchase_order_id is null or v_reason is null or p_target_status is null
     or p_target_status not in ('ready', 'sent', 'confirmed') then
    raise exception 'purchase_order_status_invalid' using errcode = '22023';
  end if;
  if p_target_status <> 'confirmed'
     and (v_note is not null or p_expected_date is not null) then
    raise exception 'purchase_order_confirmation_fields_invalid' using errcode = '22023';
  end if;
  v_target := p_target_status::public.po_status;

  select po.* into v_order
  from public.purchase_orders po
  where po.id = p_purchase_order_id and po.org_id = v_org
  for update;

  if not found then
    raise exception 'purchase_order_unknown' using errcode = 'P0002';
  end if;

  if v_order.status = v_target then
    if v_target = 'confirmed' and (
      v_order.confirmation_note is distinct from v_note
      or (p_expected_date is not null and v_order.expected_date is distinct from p_expected_date)
    ) then
      raise exception 'purchase_order_status_idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'purchase_order_id', v_order.id,
      'status', v_order.status,
      'sent_at', v_order.sent_at,
      'confirmed_at', v_order.confirmed_at,
      'confirmation_note', v_order.confirmation_note,
      'expected_date', v_order.expected_date,
      'idempotent', true
    );
  end if;

  if not (
       (v_order.status = 'draft' and v_target in ('ready', 'sent'))
    or (v_order.status = 'ready' and v_target = 'sent')
    or (v_order.status = 'sent' and v_target = 'confirmed')
  ) then
    raise exception 'purchase_order_status_transition_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  begin
    update public.purchase_orders
    set status = v_target,
        sent_at = case when v_target = 'sent' then clock_timestamp() else sent_at end,
        confirmed_at = case when v_target = 'confirmed' then clock_timestamp() else confirmed_at end,
        confirmation_note = case when v_target = 'confirmed' then v_note else confirmation_note end,
        expected_date = case
          when v_target = 'confirmed' and p_expected_date is not null then p_expected_date
          else expected_date
        end
    where id = v_order.id and org_id = v_org
    returning * into v_updated;
  exception when others then
    perform set_config('app.p1_financial_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p1_financial_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'purchase_order_status_changed',
    'purchase_orders',
    v_order.id,
    jsonb_build_object(
      'status', v_order.status,
      'sent_at', v_order.sent_at,
      'confirmed_at', v_order.confirmed_at,
      'confirmation_note', v_order.confirmation_note,
      'expected_date', v_order.expected_date
    ),
    jsonb_build_object(
      'status', v_updated.status,
      'sent_at', v_updated.sent_at,
      'confirmed_at', v_updated.confirmed_at,
      'confirmation_note', v_updated.confirmation_note,
      'expected_date', v_updated.expected_date
    ),
    v_reason
  );

  return jsonb_build_object(
    'purchase_order_id', v_updated.id,
    'status', v_updated.status,
    'sent_at', v_updated.sent_at,
    'confirmed_at', v_updated.confirmed_at,
    'confirmation_note', v_updated.confirmation_note,
    'expected_date', v_updated.expected_date,
    'idempotent', false
  );
end
$$;

revoke all on function public.transition_purchase_order_status(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function public.transition_purchase_order_status(uuid, text, text, text, date)
  to authenticated;

comment on function public.transition_purchase_order_status(uuid, text, text, text, date) is
  'Atomically transitions routine purchase-order states and records the authenticated actor and reason.';
