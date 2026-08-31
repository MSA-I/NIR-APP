-- 0263 — the dashboard's three period comparisons stop being three implementations.
--
-- WHAT WAS WRONG. The control centre compares this month with last month three times: money paid,
-- money ordered, and money invoiced. All three were computed in `Dashboard.tsx` from rows the
-- browser had already fetched for other reasons, each with its own null rule and its own idea of
-- where the previous period ends. `PeriodComparison` unified how they are DRAWN; this unifies what
-- they are. A comparison the browser derives is a second definition of a business figure, and the
-- constitution's rule about one source of truth for money does not stop at the network boundary.
--
-- ADDITIVE, SO AN OLD CLIENT CANNOT BREAK. One new key on the snapshot object. Every existing key
-- keeps its exact value — asserted below by re-finding each of them rather than by claiming it —
-- so a browser holding a cached bundle simply does not see the new block. This also means the
-- migration can ship before the client that reads it, which is the order the rollout needs.
--
-- THE BASELINE IS DAY-ALIGNED, AND THAT IS THE WHOLE POINT OF PUTTING IT HERE. A month-to-date
-- figure compared against a WHOLE previous month is not a comparison, it is a shrinking number
-- that looks like a decline. The previous window therefore ends on the same day number, clamped to
-- the length of that month — the 31st of a month compared against the 30th of a thirty-day one.
-- February is why the clamp exists and why it is now written once.
--
-- ONE CURRENCY PER ROW, ALWAYS. No sum across currencies and no conversion: a row is emitted for
-- every currency that appears in EITHER window, carrying both figures. A currency present in one
-- window and absent from the other reports a measured zero for the empty side, which is a fact;
-- a currency absent from both produces no row at all, and the client draws no comparison. The
-- difference between "nothing happened" and "we did not look" survives to the screen.
--
-- NO DISPLAY STRINGS. The boundaries come back as DATES. `fmtMonth` and the day-range label are
-- the client's business, in the client's locale — the same rule `0262` states for plan keys, and
-- for the same reason: `profiles.locale` exists and a Hebrew string from the server would land on
-- an English screen with no guard between them.

do $patch_dashboard_0263$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
  v_count int;
begin
  if to_regprocedure('public.management_dashboard_snapshot(date)') is null then
    raise exception '0263: public.management_dashboard_snapshot is absent';
  end if;

  v_definition := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure), e'\r', '');

  -- ---- 1. The four windows, named once. ------------------------------------------------------
  v_anchor := e'  top_balances as (\n';
  v_replacement := e'  -- 0263: the four boundaries the three comparisons share. The month-to-date\n'
    || e'  -- baseline ends on the same DAY NUMBER, clamped to the length of the previous month, so\n'
    || e'  -- a partial month is never compared against a whole one.\n'
    || e'  comparison_window as (\n'
    || e'    select\n'
    || e'      date_trunc(''month'', p_today)::date as month_from,\n'
    || e'      p_today as month_to_date_to,\n'
    || e'      (date_trunc(''month'', p_today) + interval ''1 month'' - interval ''1 day'')::date\n'
    || e'        as month_to,\n'
    || e'      (date_trunc(''month'', p_today) - interval ''1 month'')::date as previous_from,\n'
    || e'      (date_trunc(''month'', p_today) - interval ''1 day'')::date as previous_to,\n'
    || e'      least(\n'
    || e'        (date_trunc(''month'', p_today) - interval ''1 month'')::date\n'
    || e'          + (extract(day from p_today)::int - 1),\n'
    || e'        (date_trunc(''month'', p_today) - interval ''1 day'')::date\n'
    || e'      ) as previous_to_date_to\n'
    || e'  ),\n'
    -- Ordered, not draft or cancelled, valued at the snapshot prices the order carries. The same
    -- filter the browser applied; stated once instead of three times.
    || e'  comparison_purchased as (\n'
    || e'    select purchase_order.currency,\n'
    || e'      coalesce(sum(item.qty * item.unit_price) filter (\n'
    || e'        where (purchase_order.created_at at time zone ''Asia/Jerusalem'')::date\n'
    || e'                between window_row.month_from and window_row.month_to_date_to), 0) as current_amount,\n'
    || e'      coalesce(sum(item.qty * item.unit_price) filter (\n'
    || e'        where (purchase_order.created_at at time zone ''Asia/Jerusalem'')::date\n'
    || e'                between window_row.previous_from and window_row.previous_to_date_to), 0) as previous_amount\n'
    || e'    from public.purchase_orders purchase_order\n'
    || e'    join public.purchase_order_items item on item.order_id = purchase_order.id\n'
    || e'    cross join comparison_window window_row\n'
    || e'    join actor on actor.org_id = purchase_order.org_id\n'
    || e'    where purchase_order.status not in (''draft'', ''cancelled'')\n'
    || e'      and (purchase_order.created_at at time zone ''Asia/Jerusalem'')::date\n'
    || e'            between window_row.previous_from and window_row.month_to_date_to\n'
    || e'    group by purchase_order.currency\n'
    || e'  ),\n'
    || e'  comparison_paid as (\n'
    || e'    select payment.currency,\n'
    || e'      coalesce(sum(payment.amount) filter (\n'
    || e'        where payment.paid_date between window_row.month_from and window_row.month_to_date_to), 0)\n'
    || e'        as current_amount,\n'
    || e'      coalesce(sum(payment.amount) filter (\n'
    || e'        where payment.paid_date between window_row.previous_from and window_row.previous_to_date_to), 0)\n'
    || e'        as previous_amount\n'
    || e'    from public.payments payment\n'
    || e'    cross join comparison_window window_row\n'
    || e'    join actor on actor.org_id = payment.org_id\n'
    || e'    where payment.paid_date between window_row.previous_from and window_row.month_to_date_to\n'
    || e'    group by payment.currency\n'
    -- Two WHOLE months here, so this one uses the month boundaries rather than the day-aligned
    -- ones. A finished month compares whole to whole; that is why there are four dates and not two.
    || e'  ),\n'
    || e'  comparison_invoiced as (\n'
    || e'    select invoice.currency,\n'
    || e'      coalesce(sum(invoice.total_amount) filter (\n'
    || e'        where invoice.invoice_date between window_row.month_from and window_row.month_to), 0)\n'
    || e'        as current_amount,\n'
    || e'      coalesce(sum(invoice.total_amount) filter (\n'
    || e'        where invoice.invoice_date between window_row.previous_from and window_row.previous_to), 0)\n'
    || e'        as previous_amount\n'
    || e'    from public.invoices invoice\n'
    || e'    cross join comparison_window window_row\n'
    || e'    join actor on actor.org_id = invoice.org_id\n'
    || e'    where invoice.financial_role = ''payable'' and invoice.deleted_at is null\n'
    || e'      and invoice.invoice_date between window_row.previous_from and window_row.month_to\n'
    || e'    group by invoice.currency\n'
    || e'  ),\n'
    || v_anchor;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0263: top_balances anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- ---- 2. One new key, beside the ones that were already there. -------------------------------
  v_anchor := e'    ''openSupplierCount'', sbm.open_supplier_count,\n';
  v_replacement := e'    ''openSupplierCount'', sbm.open_supplier_count,\n'
    || e'    -- 0263: the three comparisons the control centre draws, computed once, here. Dates\n'
    || e'    -- rather than labels: the client owns the locale, and a month name from the server\n'
    || e'    -- would be Hebrew on an English screen.\n'
    || e'    ''periodComparison'', jsonb_build_object(\n'
    || e'      ''monthFrom'', (select month_from from comparison_window),\n'
    || e'      ''monthToDateTo'', (select month_to_date_to from comparison_window),\n'
    || e'      ''monthTo'', (select month_to from comparison_window),\n'
    || e'      ''previousFrom'', (select previous_from from comparison_window),\n'
    || e'      ''previousToDateTo'', (select previous_to_date_to from comparison_window),\n'
    || e'      ''previousTo'', (select previous_to from comparison_window),\n'
    || e'      ''purchasedByCurrency'', (\n'
    || e'        select coalesce(jsonb_agg(jsonb_build_object(\n'
    || e'          ''currency'', c.currency, ''current'', c.current_amount, ''previous'', c.previous_amount)\n'
    || e'          order by (c.currency = (select base_currency from base)) desc, c.currency), ''[]''::jsonb)\n'
    || e'        from comparison_purchased c),\n'
    || e'      ''paidByCurrency'', (\n'
    || e'        select coalesce(jsonb_agg(jsonb_build_object(\n'
    || e'          ''currency'', c.currency, ''current'', c.current_amount, ''previous'', c.previous_amount)\n'
    || e'          order by (c.currency = (select base_currency from base)) desc, c.currency), ''[]''::jsonb)\n'
    || e'        from comparison_paid c),\n'
    || e'      ''invoicedByCurrency'', (\n'
    || e'        select coalesce(jsonb_agg(jsonb_build_object(\n'
    || e'          ''currency'', c.currency, ''current'', c.current_amount, ''previous'', c.previous_amount)\n'
    || e'          order by (c.currency = (select base_currency from base)) desc, c.currency), ''[]''::jsonb)\n'
    || e'        from comparison_invoiced c)\n'
    || e'    ),\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0263: openSupplierCount anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_dashboard_0263$;

comment on function public.management_dashboard_snapshot(date) is
  'The control centre in one call. From 0263 it also publishes periodComparison: the four window '
  'boundaries as dates and, per currency, what was ordered, paid and invoiced in the current '
  'window against the same window a month earlier. The month-to-date baseline is day-aligned and '
  'clamped to the previous month''s length; the invoiced comparison is whole month against whole '
  'month. No sum across currencies, no conversion, and no display strings — the client owns the '
  'locale. Additive: every key that existed before is unchanged.';

do $verify_dashboard_0263$
declare
  v_body text;
  v_violations text;
begin
  v_body := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure), e'\r', '');

  if position('''periodComparison''' in v_body) = 0
     or position('comparison_purchased' in v_body) = 0
     or position('comparison_paid' in v_body) = 0
     or position('comparison_invoiced' in v_body) = 0 then
    raise exception '0263: the comparison block is not published';
  end if;

  -- The clamp is the reason this is on the server. Without it, the 31st is compared against a
  -- month that has no 31st and the baseline silently becomes the whole month.
  if position('least(' in v_body) = 0
     or position('extract(day from p_today)::int - 1' in v_body) = 0 then
    raise exception '0263: the day-aligned baseline is not clamped to the previous month';
  end if;

  -- Whole month against whole month for invoices, day-aligned for the other two. Four windows,
  -- not two, and each comparison uses the pair that belongs to it.
  if position('between window_row.previous_from and window_row.previous_to)' in v_body) = 0 then
    raise exception '0263: the invoiced comparison is not whole month against whole month';
  end if;

  -- ADDITIVE. Every key the snapshot published before this migration is still published. Counted
  -- one by one because a cached client reading a vanished key gets a blank card, not an error.
  if position('''openBalanceByCurrency''' in v_body) = 0
     or position('''openInvoiceCount''' in v_body) = 0
     or position('''paymentRequests''' in v_body) = 0
     or position('''overdueAmountByCurrency''' in v_body) = 0
     or position('''dueWithin7AmountByCurrency''' in v_body) = 0
     or position('''credits''' in v_body) = 0
     or position('''bank''' in v_body) = 0
     or position('''invoices''' in v_body) = 0
     or position('''openOrders''' in v_body) = 0
     or position('''committedByCurrency''' in v_body) = 0
     or position('''remainingByCurrency''' in v_body) = 0
     or position('''openSupplierCount''' in v_body) = 0
     or position('''topBalancesByCurrency''' in v_body) = 0 then
    raise exception '0263: an existing snapshot key was lost';
  end if;
  -- And the evidence guards that keep a missing measurement from becoming a zero. SIX, measured
  -- on the live body rather than guessed — an equality rather than a floor, so a guard that
  -- quietly appears is reported as loudly as one that quietly goes.
  if (length(v_body) - length(replace(v_body, 'else null end', '')))
       / length('else null end') <> 6 then
    raise exception '0263: the number of evidence guards changed';
  end if;

  -- The reader is still owner/office only, and the function is still not a definer.
  if position('public.auth_role() in (''owner'', ''office'')' in v_body) = 0 then
    raise exception '0263: the snapshot stopped restricting its reader';
  end if;
  if (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'management_dashboard_snapshot') then
    raise exception '0263: management_dashboard_snapshot became SECURITY DEFINER';
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0263 scope assertions failed:\n%', v_violations;
  end if;
end
$verify_dashboard_0263$;
