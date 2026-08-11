-- 0105 -- What did we agree to pay for this, on the day the document is dated?
--
-- The system cannot answer that question today. Measured, not assumed: `price_history` is written
-- by three commands (0023:2239, 0023:2414, 0025:482 and the price-list intake that followed) and
-- read by exactly two, 0027:611 and 0031:358 -- both of which use it only to COUNT changes for
-- supplier metrics. No function anywhere returns "the price in effect on a date". Every price
-- comparison in the product therefore reaches for `supplier_products.current_price`, which is
-- today's price, and compares it against a document that may be weeks old.
--
-- That is not a cosmetic inaccuracy. A supplier who raised a price on 01.08 is, under a
-- current_price comparison, retroactively overcharging on every July invoice -- and the campaign
-- this migration belongs to turns "price above baseline" into an exception, an alert and a draft
-- credit request. A wrong baseline does not produce a wrong number on a screen; it produces a
-- credit request against a supplier who did nothing wrong. The baseline has to be as-of the
-- document, or the finding built on it must not exist.
--
-- WHAT THIS MIGRATION IS, AND IS NOT. It is one read-only helper. It writes nothing, it decides
-- nothing, and it has no automatic effect: the price list is the contractual baseline and is never
-- updated from a document (OPEN-DECISIONS #144). It deliberately does not touch
-- `get_invoice_three_way_match` (0099:1872) -- see the risk note in the campaign plan: that
-- function's approval guard recomputes `private.invoice_three_way_raw` itself and compares against
-- its own `assessment_hash` (0099:2051-2093), so a wrapper around it is advisory by construction.
-- The consumer of this helper is the document-review assessment, where blocking is already the
-- rule and a human approves before anything financial happens.
--
-- WHERE IT LIVES AND WHY THAT MATTERS. `private`, which carries no USAGE grant -- so the browser
-- cannot call it and PostgREST cannot expose it. It follows `private.match_price_list_line`
-- (0081) exactly: STABLE SECURITY DEFINER, `search_path` pinned, tenancy passed in as an argument
-- rather than read from the ambient session, every query filtered on it. `price_history` and
-- `supplier_products` are both `enforced = false` in `private.scope_registry`, so A5 does not
-- require an exemption row for this definer and the registry count does not move.

create or replace function private.supplier_price_effective_on(
  p_org_id uuid,
  p_supplier_id uuid,
  p_product_id uuid,
  p_on_date date
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sp record;
  v_hist record;
begin
  if p_org_id is null or p_supplier_id is null or p_product_id is null then
    return jsonb_build_object('status', 'unknown', 'reason', 'missing_identifiers');
  end if;

  -- (supplier_id, product_id) is UNIQUE, so this can never be ambiguous. Section 2 below pins
  -- that constraint: if it is ever relaxed, this `select into` would start picking a row at
  -- random, and the assertion fails loudly instead.
  select sp.id, sp.current_price, sp.package_size, sp.available, sp.price_effective_date
    into v_sp
  from public.supplier_products sp
  where sp.org_id = p_org_id
    and sp.supplier_id = p_supplier_id
    and sp.product_id = p_product_id;

  if not found then
    -- The supplier does not list this product at all. There is no contractual baseline to compare
    -- against, and inventing one from another supplier's price would be a fabricated number.
    return jsonb_build_object('status', 'unknown', 'reason', 'supplier_does_not_list_product');
  end if;

  -- A price row may be future-dated: `set_supplier_product_price` takes `p_effective_date` from
  -- its caller and does not require it to be today. `effective_date <= p_on_date` is therefore
  -- doing real work -- a price that starts next week was not in effect on the document's date.
  -- The tie-break `(effective_date, created_at, id)` is the ordering 0027:611 and 0031:358
  -- already use for this table, including for the compensating rows a price-list reversal writes
  -- (0081:865): the compensating row is the later `created_at` for the same effective_date and so
  -- wins, which is what reversal means.
  if p_on_date is not null then
    select h.id, h.price, h.effective_date
      into v_hist
    from public.price_history h
    where h.org_id = p_org_id
      and h.supplier_product_id = v_sp.id
      and h.effective_date <= p_on_date
    order by h.effective_date desc, h.created_at desc, h.id desc
    limit 1;

    if found then
      return jsonb_build_object(
        'status', 'resolved',
        'supplier_product_id', v_sp.id,
        'baseline_price', v_hist.price,
        'baseline_source', 'price_history',
        'baseline_effective_date', v_hist.effective_date,
        'price_history_id', v_hist.id,
        'as_of', p_on_date,
        'package_size', v_sp.package_size,
        'available', v_sp.available
      );
    end if;

    -- History exists, but all of it starts after the document. The document predates our records.
    -- Returning today's price here would be the worst available answer: it is the end of a chain
    -- of increases the document could not have known about. The earliest price we ever recorded is
    -- the closest thing to the truth, and it is labelled so the screen can say so.
    select h.id, h.price, h.effective_date
      into v_hist
    from public.price_history h
    where h.org_id = p_org_id
      and h.supplier_product_id = v_sp.id
    order by h.effective_date asc, h.created_at asc, h.id asc
    limit 1;

    if found then
      return jsonb_build_object(
        'status', 'resolved',
        'supplier_product_id', v_sp.id,
        'baseline_price', v_hist.price,
        'baseline_source', 'earliest_price_history',
        'baseline_effective_date', v_hist.effective_date,
        'price_history_id', v_hist.id,
        'as_of', p_on_date,
        'package_size', v_sp.package_size,
        'available', v_sp.available
      );
    end if;
  end if;

  -- Either the document carries no readable date (`as_of` is null and the reader must be told
  -- that), or this supplier_product has no history rows at all. Both fall back to the current
  -- price, and both say `current_price` so that no screen can present it as an as-of answer.
  return jsonb_build_object(
    'status', 'resolved',
    'supplier_product_id', v_sp.id,
    'baseline_price', v_sp.current_price,
    'baseline_source', 'current_price',
    'baseline_effective_date', v_sp.price_effective_date,
    'price_history_id', null,
    'as_of', p_on_date,
    'package_size', v_sp.package_size,
    'available', v_sp.available
  );
end
$function$;

comment on function private.supplier_price_effective_on(uuid, uuid, uuid, date) is
  'The contractual baseline price for a supplier''s product on a given date, read from '
  'price_history (0105). Returns baseline_source: `price_history` when a row was in effect on '
  'that date; `earliest_price_history` when the document predates every recorded price; '
  '`current_price` when the product has no history or the document has no readable date -- and '
  '`as_of` is null in that second case. Read-only: the price list is the contractual baseline and '
  'is never updated from a document (OPEN-DECISIONS #144). Callers must disclose any source other '
  'than `price_history` to the human reviewing the document.';

-- ===== 2. Anchors this function silently depends on =====
--
-- Each of these is a fact the body above would keep compiling without, and would return a wrong
-- number without. They are asserted here rather than trusted.
do $$
declare
  v_secdef boolean;
  v_volatile "char";
  v_settings text[];
begin
  -- (a) The uniqueness that makes the `select into` deterministic.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.supplier_products'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (supplier_id, product_id)'
  ) then
    raise exception
      '0105: supplier_products no longer carries UNIQUE (supplier_id, product_id). '
      'supplier_price_effective_on would pick one row of several at random.';
  end if;

  -- (b) The columns read from price_history, by name and type. A rename would still compile at
  -- CREATE time and fail at call time, in a money path.
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'price_history'
        and (column_name, data_type) in (
          ('price', 'numeric'), ('effective_date', 'date'),
          ('supplier_product_id', 'uuid'), ('org_id', 'uuid'))) <> 4 then
    raise exception '0105: price_history no longer has the four columns this baseline reads.';
  end if;

  -- (c) Money stays numeric. `check:money` guards the client; this guards the server.
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'supplier_products'
        and column_name = 'current_price') <> 'numeric' then
    raise exception '0105: supplier_products.current_price is no longer numeric.';
  end if;

  -- (d) The function was created with the security properties the comment above claims.
  select p.prosecdef, p.provolatile, p.proconfig
    into v_secdef, v_volatile, v_settings
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'supplier_price_effective_on';
  if not v_secdef or v_volatile <> 's'
     or not ('search_path=public, pg_temp' = any(v_settings)) then
    raise exception
      '0105: supplier_price_effective_on was not created STABLE SECURITY DEFINER with a pinned '
      'search_path (secdef=%, volatile=%, settings=%).', v_secdef, v_volatile, v_settings;
  end if;

  -- (e) `private` still has no USAGE grant, so the browser cannot reach this.
  if (select nspacl from pg_namespace where nspname = 'private') is not null then
    raise exception
      '0105: the private schema has acquired an ACL. supplier_price_effective_on takes org_id as '
      'an argument and would trust a caller that can now reach it directly.';
  end if;
end $$;

-- ===== 3. A1/A3/A5 re-assertion =====
--
-- Required of every migration after 0057. This one adds a SECURITY DEFINER function in `private`,
-- which is exactly what A5 inspects: it reads `supplier_products` and `price_history`, both
-- `enforced = false` in the registry, so no exemption row is required and the count must not move.
-- If a future migration marks either table enforced, this assertion is where that shows up.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0105 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
