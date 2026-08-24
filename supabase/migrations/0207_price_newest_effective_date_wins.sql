-- 0207 -- A price with an OLDER effective date stops overwriting a newer one.
--
-- THE DEFECT (owner review, 24.08.2026). Both live price writers decide whether to move
-- `supplier_products.current_price` by asking whether the incoming effective date is
-- DIFFERENT from the stored one:
--
--     v_existing.price_effective_date <> p_effective_date        -- 0032, the import loop
--     v_row.price_effective_date <> p_effective_date             -- 0025, the single set
--
-- `<>` is true in both directions. So a price list carrying an effective date EARLIER than the
-- one already on the row silently replaced the current price with the older figure, and every
-- order priced afterwards used it. Nothing warned, because from the writer's point of view
-- something had changed and it duly wrote it.
--
-- The read side has been right the whole time: `private.supplier_price_effective_on`
-- (0105:76-83) resolves `effective_date <= p_on_date order by effective_date desc`. Only the
-- write side disagreed with it, which is exactly why the disagreement was invisible -- the
-- as-of query kept answering correctly about the past while `current_price` was wrong about
-- the present.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT.
--   * `current_price`, `previous_price` and `price_effective_date` move only when the incoming
--     date is >= the stored one. A backdated write leaves the present alone.
--   * `price_history` is still written, unconditionally, exactly as before. A backdated price
--     IS a fact -- it says what was charged during an earlier period, and 0105's as-of
--     resolution starts answering with it for that period, which is correct. ARCHITECTURE.md:178
--     says price_history keeps every change; this migration does not narrow that.
--   * `available` still follows the incoming row in both writers. It is a statement about now,
--     not about a date, so an older price list may still report a product out of stock.
--   * The audit row gains `superseded_by_newer_effective_date`, so a backdated write is
--     legible afterwards rather than looking like a change that did not happen.
--
-- NO UNIQUE INDEX ON price_history, and that is a decision rather than an omission. It was
-- considered: `unique (org_id, supplier_product_id, effective_date)` would make "the newest
-- row" singular by construction. It is not added because (a) the guard above already fixes the
-- reported defect without it, (b) there is no unique constraint today, so production may
-- already hold same-date rows and the index could fail an apply on live data, and (c) the only
-- way to keep such an index satisfiable is `on conflict do update`, which would overwrite a
-- same-date correction instead of appending it -- narrowing the very history ARCHITECTURE.md
-- promises. Revisit only with a measurement of how many same-date rows actually exist.
--
-- SCOPE -- exactly two live writers, verified rather than assumed. 0030:16 dropped
-- `import_supplier_prices(jsonb,date,text,uuid)`, and 0032:405-418 redefined the 3-arg overload
-- to delegate, so every client path (PriceListUpload, QuickCreateProduct, Onboarding,
-- PriceLists) funnels through `p1_import_supplier_prices_internal`. The compensating writer
-- `revert_price_list_auto_action` (0093:209) is INTENTIONALLY not guarded: its whole job is to
-- restore a previous state, and it already refuses when a later change superseded it.
--
-- ANCHORED REPLACEMENT (the 0137/0145/0148/0168 pattern): read the live definition, normalise
-- \r, replace named anchors, fail loudly if any anchor moved or matched a different number of
-- times. Both functions have been redefined across migrations, so pasting an older body back
-- would revert whatever the later ones changed.

do $newest_date_wins$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
  v_hits int;
begin
  -- ===== 1. public.set_supplier_product_price -- the single, manual write =====
  v_def := replace(pg_get_functiondef(
    'public.set_supplier_product_price(uuid, numeric, date, boolean, text)'::regprocedure), e'\r', '');

  if position('greatest(v_row.price_effective_date, p_effective_date)' in v_def) = 0 then
    -- (1a) The row update: each column decides for itself whether this write is the newer one.
    v_anchor := concat_ws(e'\n',
      '  update supplier_products',
      '  set current_price = v_price,',
      '      previous_price = case when v_price_changed then v_row.current_price else v_row.previous_price end,',
      '      price_effective_date = p_effective_date,',
      '      available = p_available',
      '  where id = v_row.id;');
    v_replacement := concat_ws(e'\n',
      '  update supplier_products',
      '  set current_price = case',
      '        when p_effective_date >= v_row.price_effective_date then v_price',
      '        else v_row.current_price',
      '      end,',
      '      previous_price = case',
      '        when p_effective_date >= v_row.price_effective_date and v_price_changed then v_row.current_price',
      '        else v_row.previous_price',
      '      end,',
      '      price_effective_date = greatest(v_row.price_effective_date, p_effective_date),',
      '      available = p_available',
      '  where id = v_row.id;');
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 1 then
      raise exception '0207: set_supplier_product_price row update found % times, expected 1. '
        'Fix the anchor deliberately rather than letting the migration guess.', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);

    -- (1b) The audit row must not claim a change the guard just refused.
    v_anchor := concat_ws(e'\n',
      '      ''price'', v_price, ''effective_date'', p_effective_date, ''available'', p_available,',
      '      ''price_changed'', v_price_changed, ''history_changed'', v_history_changed');
    v_replacement := concat_ws(e'\n',
      '      ''price'', v_price, ''effective_date'', p_effective_date, ''available'', p_available,',
      '      ''price_changed'', v_price_changed, ''history_changed'', v_history_changed,',
      '      ''superseded_by_newer_effective_date'', p_effective_date < v_row.price_effective_date');
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 1 then
      raise exception '0207: set_supplier_product_price audit payload found % times, expected 1.', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);

    execute v_def;
  end if;

  -- ===== 2. public.p1_import_supplier_prices_internal -- the bulk path every import uses =====
  v_def := replace(pg_get_functiondef(
    'public.p1_import_supplier_prices_internal(jsonb, date, text)'::regprocedure), e'\r', '');

  if position('greatest(v_existing.price_effective_date, p_effective_date)' in v_def) = 0 then
    -- The branch predicate is left exactly as it was: a backdated row still counts as UPDATED
    -- and still writes history. What changes is only which columns of the present it may move.
    v_anchor := concat_ws(e'\n',
      '      update supplier_products',
      '      set current_price = v_row.price,',
      '          previous_price = case',
      '            when round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price',
      '            else v_existing.previous_price',
      '          end,',
      '          price_effective_date = p_effective_date,',
      '          available = v_row.available',
      '      where id = v_existing.id;');
    v_replacement := concat_ws(e'\n',
      '      update supplier_products',
      '      set current_price = case',
      '            when p_effective_date >= v_existing.price_effective_date then v_row.price',
      '            else v_existing.current_price',
      '          end,',
      '          previous_price = case',
      '            when p_effective_date >= v_existing.price_effective_date',
      '                 and round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price',
      '            else v_existing.previous_price',
      '          end,',
      '          price_effective_date = greatest(v_existing.price_effective_date, p_effective_date),',
      '          available = v_row.available',
      '      where id = v_existing.id;');
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 1 then
      raise exception '0207: the import loop row update found % times, expected 1. '
        'Fix the anchor deliberately rather than letting the migration guess.', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);

    execute v_def;
  end if;
end
$newest_date_wins$;

comment on function public.set_supplier_product_price(uuid, numeric, date, boolean, text) is
  'Single reasoned price write. 0207: an effective date older than the stored one records '
  'history but does not move current_price / price_effective_date; the audit row carries '
  'superseded_by_newer_effective_date so a refused move is legible.';

comment on function public.p1_import_supplier_prices_internal(jsonb, date, text) is
  'Bulk price import, the path every client import funnels through. 0207: a row whose effective '
  'date is older than the stored one still writes price_history and still counts as updated, '
  'but leaves current_price and price_effective_date on the newer figure.';

-- ===== A1/A3/A5 re-assertion (the 0058:207-218 idiom) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0207 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors -- assert the RESULT, not the intent =====
do $$
declare
  v_set text;
  v_import text;
begin
  v_set := replace(pg_get_functiondef(
    'public.set_supplier_product_price(uuid, numeric, date, boolean, text)'::regprocedure), e'\r', '');
  v_import := replace(pg_get_functiondef(
    'public.p1_import_supplier_prices_internal(jsonb, date, text)'::regprocedure), e'\r', '');

  if position('greatest(v_row.price_effective_date, p_effective_date)' in v_set) = 0 then
    raise exception '0207 anchor: set_supplier_product_price still moves the effective date unconditionally.';
  end if;
  if position('greatest(v_existing.price_effective_date, p_effective_date)' in v_import) = 0 then
    raise exception '0207 anchor: the import loop still moves the effective date unconditionally.';
  end if;
  if position('''superseded_by_newer_effective_date''' in v_set) = 0 then
    raise exception '0207 anchor: the audit payload does not record a refused move.';
  end if;

  -- price_history is still written by both, unconditionally. This is the check that would catch
  -- a future "simplification" that stopped recording backdated facts.
  if position('insert into price_history' in v_set) = 0
     or position('insert into price_history' in v_import) = 0 then
    raise exception '0207 anchor: a writer stopped recording price_history.';
  end if;

  -- Both stay SECURITY DEFINER behind the financial-writer fence; 0207 changes arithmetic, not
  -- the security posture, and a definer that lost its guard call would be a far worse defect
  -- than the one being fixed.
  if position('app.p1_financial_writer' in v_set) = 0
     or position('app.p1_financial_writer' in v_import) = 0 then
    raise exception '0207 anchor: a writer lost its p1_financial_command_guard handshake.';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.set_supplier_product_price(uuid, numeric, date, boolean, text)'::regprocedure
      and prosecdef
  ) then
    raise exception '0207 anchor: set_supplier_product_price is no longer SECURITY DEFINER.';
  end if;
end
$$;
