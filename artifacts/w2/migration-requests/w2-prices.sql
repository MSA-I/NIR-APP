-- =====================================================================================
-- WAVE 2 MIGRATION REQUEST -- the price parser, and the currency the writer never named.
--
-- THIS FILE IS NOT A MIGRATION. It is the SQL Wave 2 needs, handed to the agent that owns
-- `supabase/migrations/`. Take a number with `npm run next-number -- migration` at the moment
-- you create the file; nothing here hard-codes one, because two agents picking the same number
-- is the failure this repository has already paid for six times.
--
-- EVERY DB CHANGE BELOW IS AN ANCHORED PATCH OF THE LIVE BODY. None of these functions is
-- re-declared from the migration that created it: `p1_import_supplier_prices_internal` was last
-- patched by 0207, `apply_price_list_interpretation` was renamed by 0182, and re-declaring either
-- from 0032/0048/0081 would silently revert every patch applied since. Each anchor is a verbatim
-- slice of what `pg_get_functiondef` returns today, and each is asserted to match exactly once.
-- Every definition is read as `replace(pg_get_functiondef(...), e'\r', '')`, because a body
-- applied from Windows carries CRLF and one applied on CI does not (`check:anchored-replacements`).
--
-- ---------------------------------------------------------------------------------------------
-- THE LIVE BODIES THIS FILE WAS WRITTEN AGAINST (printed, not inferred, 2026-09-03)
--
--   public.p1_import_supplier_prices_internal(jsonb,date,text)
--     `insert into supplier_products (org_id, supplier_id, product_id, current_price,
--      price_effective_date, available)` -- no currency column named, so the ILS default decides.
--
--   public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)
--     `v_price_text := regexp_replace(trim(coalesce(v_item ->> 'price_text', '')),
--      '[[:space:]₪,]', '', 'g');`
--
--   public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)
--     `v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');`
--
--   public.run_price_list_shadow(uuid,uuid,uuid)
--     `v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');`
--
--   public.get_qualified_product_creation_dry_run(uuid)
--     `v_price_text:=regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[^0-9.]','','g');`
--     -- the ONE place in the whole history carrying `[^0-9.]`. It is NOT a corrected expression:
--     it destroys the sign (`-5` becomes `5`) and swallows letters (`12.5USD` becomes `12.5`), so
--     the preview accepts rows the three writers then refuse. It is replaced here, not adopted.
--
--   private.resolve_document_currency(uuid,uuid,jsonb)
--     returns {status, currency, printed_currency, assumed_from_supplier}; `unrecognised` when the
--     printed token is not an active currency. Unchanged by this file.
--
-- WHAT IS NOT A LIMITATION, MEASURED: `supplier_products.current_price`, `previous_price` and
-- `price_history.price` are `numeric(14,3)` today (0217 widened them; nothing narrows them again),
-- and `currencies.minor_units` is CHECKed to 0..3. So minor_units 0 through 3 are supported in
-- full and there is no debt to record.
-- =====================================================================================


-- =====================================================================================
-- 1. THE CANONICAL PARSER
--
-- One reading of a price text, shared by the preview, the three writers and the shadow run.
--
-- IT NEVER RAISES. The three writers mark a bad row and continue; a parser that raised would turn
-- a partial intake into a total failure, which is a regression rather than a fix. Every refusal is
-- a value in the result.
--
-- IT NEVER COERCES A CURRENCY. A cell that names a currency other than the list's is refused by
-- name (`price_currency_mismatch`), never converted and never relabelled. There is no conversion
-- and no external rate source anywhere in this system.
--
-- IT PRESERVES THE SIGN. `-5` comes back as `-5` with `price_not_positive`, not as `5`. The dry
-- run's `[^0-9.]` strip is exactly the bug this replaces.
-- =====================================================================================

create or replace function private.parse_price(p_text text, p_expected_currency text)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $parse_price$
declare
  -- Currency-bearing tokens a supplier actually prints, and nothing else. A three-letter ASCII
  -- token is resolved against public.currencies rather than assumed, so `USD` is a currency and
  -- `KGM` is junk that makes the cell unreadable instead of silently vanishing.
  v_expected text := upper(nullif(btrim(coalesce(p_expected_currency, '')), ''));
  v_minor smallint;
  v_raw text := btrim(coalesce(p_text, ''));
  v_body text;
  v_token text;
  v_token_code text;
  v_printed text;
  v_negative boolean := false;
  v_value numeric;
  v_rounded numeric;
  v_match text[];
begin
  if v_expected is not null then
    select currency.minor_units into v_minor
    from public.currencies currency
    where currency.code = v_expected and currency.active;
  end if;
  if v_minor is null then
    -- The caller could not say which currency this list is in. Reading the number anyway would be
    -- a number without a unit, which is the failure this whole wave exists to end.
    return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_currency_unknown',
      'currency', v_expected, 'printed_currency', null, 'minor_units', null, 'rounded', false);
  end if;

  if v_raw = '' then
    return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_missing',
      'currency', v_expected, 'printed_currency', null, 'minor_units', v_minor, 'rounded', false);
  end if;
  if length(v_raw) > 64 then
    return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
      'currency', v_expected, 'printed_currency', null, 'minor_units', v_minor, 'rounded', false);
  end if;

  -- Invisible bidirectional marks travel inside Hebrew price cells and are not part of the number.
  v_body := replace(replace(replace(v_raw, chr(8206), ''), chr(8207), ''), chr(1564), '');
  -- Non-breaking, figure, narrow and thin spaces are spaces.
  v_body := translate(v_body, chr(160) || chr(8199) || chr(8239) || chr(8201), '    ');
  v_body := btrim(regexp_replace(v_body, '[[:space:]]+', ' ', 'g'));

  -- Currency markers, one at a time, left to right. Each is either recognised and removed, or it
  -- is junk and the cell is unreadable. Nothing is stripped without being understood first.
  loop
    v_match := regexp_match(v_body, '(₪|\$|€|£|¥|ש"ח|ש״ח|שח|ש\.ח|[[:alpha:]]+)');
    exit when v_match is null;
    v_token := v_match[1];
    v_token_code := case upper(v_token)
      when '₪' then 'ILS' when 'ILS' then 'ILS' when 'NIS' then 'ILS'
      when 'ש"ח' then 'ILS' when 'ש״ח' then 'ILS' when 'שח' then 'ILS' when 'ש.ח' then 'ILS'
      when 'שקל' then 'ILS' when 'שקלים' then 'ILS'
      when '$' then 'USD' when 'דולר' then 'USD'
      when '€' then 'EUR' when 'אירו' then 'EUR' when 'יורו' then 'EUR'
      when '£' then 'GBP'
      else null
    end;
    if v_token_code is null and upper(v_token) ~ '^[A-Z]{3}$' then
      select currency.code into v_token_code
      from public.currencies currency
      where currency.code = upper(v_token) and currency.active;
    end if;
    if v_token_code is null then
      -- A word this parser does not recognise as a currency. `12.5 KGM` is not a price in an
      -- unknown currency; it is a cell this parser will not guess at.
      return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
        'currency', v_expected, 'printed_currency', null,
        'minor_units', v_minor, 'rounded', false);
    end if;
    if v_printed is null then
      v_printed := v_token_code;
    elsif v_printed <> v_token_code then
      return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_currency_mismatch',
        'currency', v_expected, 'printed_currency', v_printed,
        'minor_units', v_minor, 'rounded', false);
    end if;
    v_body := btrim(regexp_replace(v_body, '(₪|\$|€|£|¥|ש"ח|ש״ח|שח|ש\.ח|[[:alpha:]]+)', ' '));
    v_body := btrim(regexp_replace(v_body, '[[:space:]]+', ' ', 'g'));
  end loop;

  if v_printed is not null and v_printed <> v_expected then
    -- REFUSED, NEVER COERCED. The row keeps its own currency in the result so the message can
    -- name both, and no conversion is attempted anywhere.
    return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_currency_mismatch',
      'currency', v_expected, 'printed_currency', v_printed,
      'minor_units', v_minor, 'rounded', false);
  end if;

  -- Accounting negatives are negatives, and stay negative.
  if v_body ~ '^\(.*\)$' then
    v_negative := true;
    v_body := btrim(substring(v_body from 2 for greatest(length(v_body) - 2, 0)));
  end if;
  v_body := replace(v_body, chr(8722), '-');
  if v_body ~ '^[+-]' then
    v_negative := v_negative or left(v_body, 1) = '-';
    v_body := btrim(substring(v_body from 2));
  end if;
  v_body := replace(v_body, ' ', '');

  -- A comma is a thousands separator ONLY when it groups in threes. `1,234.50` is 1234.50;
  -- `1,5` is refused rather than silently read as 15, which is what stripping every comma did.
  if v_body ~ '^[0-9]{1,3}(,[0-9]{3})+([.][0-9]+)?$' then
    v_body := replace(v_body, ',', '');
  end if;

  if v_body !~ '^[0-9]+([.][0-9]+)?$' or length(v_body) > 20 then
    return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
      'currency', v_expected, 'printed_currency', v_printed,
      'minor_units', v_minor, 'rounded', false);
  end if;

  v_value := v_body::numeric;
  if v_negative then
    v_value := -v_value;
  end if;
  v_rounded := round(v_value, v_minor);

  if v_value <= 0 then
    -- The signed value travels back with the refusal: a reader can see it was minus five, not a
    -- five that failed some unnamed test.
    return jsonb_build_object('ok', false, 'value', v_value, 'reason', 'price_not_positive',
      'currency', v_expected, 'printed_currency', v_printed,
      'minor_units', v_minor, 'rounded', false);
  end if;
  if v_rounded <= 0 then
    -- Positive, but smaller than this currency's smallest unit. Storing 0 would assert a free
    -- product; rounding up would invent money.
    return jsonb_build_object('ok', false, 'value', v_value, 'reason', 'price_below_minor_unit',
      'currency', v_expected, 'printed_currency', v_printed,
      'minor_units', v_minor, 'rounded', false);
  end if;
  if v_rounded > 1000000 then
    -- A ceiling on the SIZE OF THE NUMBER, carrying no currency -- the same bare 1000000 the three
    -- writers have always used. Calling it ₪1,000,000 would describe a shekel limit that does not
    -- exist and would read as a far tighter rule to anyone importing in another currency.
    return jsonb_build_object('ok', false, 'value', v_value, 'reason', 'price_above_cap',
      'currency', v_expected, 'printed_currency', v_printed,
      'minor_units', v_minor, 'rounded', false);
  end if;

  return jsonb_build_object('ok', true, 'value', v_rounded, 'reason', null,
    'currency', v_expected, 'printed_currency', v_printed,
    'minor_units', v_minor, 'rounded', v_rounded <> v_value);
end
$parse_price$;

revoke all on function private.parse_price(text, text) from public, anon, authenticated;

comment on function private.parse_price(text, text) is
  'The one reading of a price text. Returns {ok, value, reason, currency, printed_currency, '
  'minor_units, rounded} and never raises, because the three writers mark a bad row and continue. '
  'A currency other than the expected one is REFUSED (price_currency_mismatch), never converted. '
  'The sign is preserved: -5 comes back as -5 with price_not_positive.';


-- =====================================================================================
-- 2. THE WRITER -- p1_import_supplier_prices_internal
--
-- This is the function that actually writes. The three parsers above it hand it
-- (supplier_id, product_id, price, available) with NO currency, it rounds to two decimals, and it
-- inserts into supplier_products and price_history without naming the currency column -- so both
-- take the ILS default. A supplier who quotes dollars is stored as shekels, and the upload
-- preview even labels the row with the supplier's real currency while the row lands as ILS.
--
-- After this patch the currency is the caller's declaration, or the currency the supplier trades
-- in (`suppliers.default_currency`, NOT NULL). It is never the column default.
-- =====================================================================================

do $patch_p1_import_prices$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
  procedure_note text := 'w2-prices';
begin
  -- (a) declarations
  v_anchor := $a0$  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;$a0$;
  v_replacement := $r0$  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  -- The writer names the currency it writes. Before this the column default decided, and every
  -- price a supplier quoted in another currency was stored as shekels with nothing recording it.
  v_currency text;
  v_minor smallint;
  v_price numeric;
  v_rejections jsonb := '[]'::jsonb;
  v_rejected int := 0;
  v_by_currency jsonb := '{}'::jsonb;$r0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import declarations anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (b) the bulk range gate stops assuming two decimals, so a three-minor-unit currency is not
  -- rejected for the whole call before the per-row gate ever sees it.
  v_anchor := $a1$       where supplier_id is null or product_id is null or price is null
          or round(price, 2) <= 0 or round(price, 2) > 1000000$a1$;
  v_replacement := $r1$       where supplier_id is null or product_id is null or price is null
          or price <= 0 or price > 1000000$r1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import bulk gate anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (c) the row loop carries the currency, and resolves it BEFORE the row is locked. Nothing is
  -- inserted between that SELECT and the `if not found` that reads its FOUND.
  v_anchor := $a2$  for v_row in
    select supplier_id, product_id, round(price, 2) as price, coalesce(available, true) as available
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    order by supplier_id, product_id
  loop
    v_existing := null;$a2$;
  v_replacement := $r2$  for v_row in
    select input.supplier_id, input.product_id, input.price as quoted_price,
           coalesce(input.available, true) as available,
           upper(nullif(btrim(coalesce(input.currency, '')), '')) as declared_currency,
           supplier.default_currency as supplier_currency
    from jsonb_to_recordset(p_rows) as input(
      supplier_id uuid, product_id uuid, price numeric, available boolean, currency text
    )
    join public.suppliers supplier
      on supplier.org_id = v_org and supplier.id = input.supplier_id
     and supplier.deleted_at is null
    order by input.supplier_id, input.product_id
  loop
    -- The currency of a price is what the caller declared, or -- when the caller declares nothing
    -- -- the currency this supplier trades in. It is never the column default.
    v_currency := coalesce(v_row.declared_currency, v_row.supplier_currency);
    select currency.minor_units into v_minor
    from public.currencies currency
    where currency.code = v_currency and currency.active;
    if v_minor is null then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'supplier_id', v_row.supplier_id, 'product_id', v_row.product_id,
        'reason', 'price_currency_unknown', 'currency', v_currency));
      v_rejected := v_rejected + 1;
      continue;
    end if;
    v_price := round(v_row.quoted_price, v_minor);
    if v_price <= 0 or v_price > 1000000 then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'supplier_id', v_row.supplier_id, 'product_id', v_row.product_id,
        'reason', case when v_price <= 0 then 'price_below_minor_unit' else 'price_above_cap' end,
        'currency', v_currency));
      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_existing := null;$r2$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import row loop anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (d) the write block: currency written explicitly, rounding follows minor_units, and a
  -- currency change on an existing row is refused by name.
  v_anchor := $a3$    if not found then
      insert into supplier_products (
        org_id, supplier_id, product_id, current_price,
        price_effective_date, available
      ) values (
        v_org, v_row.supplier_id, v_row.product_id, v_row.price,
        p_effective_date, v_row.available
      ) returning * into v_existing;

      insert into price_history (
        org_id, supplier_product_id, price, effective_date, created_by
      ) values (
        v_org, v_existing.id, v_row.price, p_effective_date, v_user
      );
      v_created := v_created + 1;
    elsif round(v_existing.current_price, 2) <> v_row.price
       or v_existing.price_effective_date <> p_effective_date
       or v_existing.available <> v_row.available then
      update supplier_products
      set current_price = case
            when p_effective_date >= v_existing.price_effective_date then v_row.price
            else v_existing.current_price
          end,
          previous_price = case
            when p_effective_date >= v_existing.price_effective_date
                 and round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price
            else v_existing.previous_price
          end,
          price_effective_date = greatest(v_existing.price_effective_date, p_effective_date),
          available = v_row.available
      where id = v_existing.id;

      if round(v_existing.current_price, 2) <> v_row.price
         or v_existing.price_effective_date <> p_effective_date then
        insert into price_history (
          org_id, supplier_product_id, price, effective_date, created_by
        ) values (
          v_org, v_existing.id, v_row.price, p_effective_date, v_user
        );
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;$a3$;
  v_replacement := $r3$    if not found then
      insert into supplier_products (
        org_id, supplier_id, product_id, current_price,
        price_effective_date, available, currency
      ) values (
        v_org, v_row.supplier_id, v_row.product_id, v_price,
        p_effective_date, v_row.available, v_currency
      ) returning * into v_existing;

      insert into price_history (
        org_id, supplier_product_id, price, effective_date, created_by, currency
      ) values (
        v_org, v_existing.id, v_price, p_effective_date, v_user, v_currency
      );
      v_created := v_created + 1;
    elsif v_existing.currency <> v_currency then
      -- supplier_products is unique (supplier_id, product_id) and holds ONE currency, one
      -- current_price and one previous_price. A dollar list arriving for a shekel-priced product
      -- has no representable outcome. The row is refused by name: never converted, the currency
      -- never overwritten, and no second row attempted. Changing the currency a supplier trades
      -- in is a deliberate act with its own migration path, and it is not this one.
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'supplier_id', v_row.supplier_id, 'product_id', v_row.product_id,
        'reason', 'currency_mismatch_existing_price',
        'currency', v_currency, 'existing_currency', v_existing.currency));
      v_rejected := v_rejected + 1;
    elsif round(v_existing.current_price, v_minor) <> v_price
       or v_existing.price_effective_date <> p_effective_date
       or v_existing.available <> v_row.available then
      update supplier_products
      set current_price = case
            when p_effective_date >= v_existing.price_effective_date then v_price
            else v_existing.current_price
          end,
          previous_price = case
            when p_effective_date >= v_existing.price_effective_date
                 and round(v_existing.current_price, v_minor) <> v_price then v_existing.current_price
            else v_existing.previous_price
          end,
          price_effective_date = greatest(v_existing.price_effective_date, p_effective_date),
          available = v_row.available
      where id = v_existing.id;

      if round(v_existing.current_price, v_minor) <> v_price
         or v_existing.price_effective_date <> p_effective_date then
        insert into price_history (
          org_id, supplier_product_id, price, effective_date, created_by, currency
        ) values (
          v_org, v_existing.id, v_price, p_effective_date, v_user, v_currency
        );
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;$r3$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import write block anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (e) the per-currency breakdown, computed once after the loop. ONE ROW PER CURRENCY: this
  -- repository never adds two currencies together, not even inside an audit row.
  v_anchor := $a4$  end loop;

  insert into audit_logs ($a4$;
  v_replacement := $r4$  end loop;

  select coalesce(jsonb_object_agg(grouped.currency, grouped.row_count), '{}'::jsonb)
    into v_by_currency
  from (
    select coalesce(upper(nullif(btrim(coalesce(input.currency, '')), '')),
                    supplier.default_currency) as currency,
           count(*) as row_count
    from jsonb_to_recordset(p_rows) as input(
      supplier_id uuid, product_id uuid, price numeric, available boolean, currency text
    )
    join public.suppliers supplier
      on supplier.org_id = v_org and supplier.id = input.supplier_id
     and supplier.deleted_at is null
    group by 1
  ) grouped;

  insert into audit_logs ($r4$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import breakdown anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (f) the audit row states what was refused and in which currencies it wrote.
  v_anchor := $a5$      'row_count', v_count,
      'created', v_created,
      'updated', v_updated,
      'unchanged', v_unchanged,
      'effective_date', p_effective_date$a5$;
  v_replacement := $r5$      'row_count', v_count,
      'created', v_created,
      'updated', v_updated,
      'unchanged', v_unchanged,
      'rejected', v_rejected,
      'by_currency', v_by_currency,
      'effective_date', p_effective_date$r5$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import audit anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (g) the result carries the refusals instead of swallowing them.
  v_anchor := $a6$  return jsonb_build_object(
    'row_count', v_count,
    'created', v_created,
    'updated', v_updated,
    'unchanged', v_unchanged
  );$a6$;
  v_replacement := $r6$  return jsonb_build_object(
    'row_count', v_count,
    'created', v_created,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'rejected', v_rejected,
    'rejections', v_rejections,
    'by_currency', v_by_currency
  );$r6$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: import return anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
  raise notice '% : p1_import_supplier_prices_internal patched', procedure_note;
end
$patch_p1_import_prices$;


-- =====================================================================================
-- 3. CONSUMER ONE -- p1b_submit_supplier_price_list_internal (the spreadsheet and OCR intake)
-- =====================================================================================

do $patch_p1b_submit$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- (a) declarations
  v_anchor := $b0$  v_price_text text;
  v_price numeric;$b0$;
  v_replacement := $s0$  v_price_text text;
  v_price numeric;
  v_currency text;
  v_parsed jsonb;$s0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: p1b declarations anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (b) resolve the currency once, right after the supplier row is locked. Two sources, chosen by
  -- path: a submission that came from a document uses the document's own currency resolution; a
  -- spreadsheet uploaded by hand has no document, so it uses the currency this supplier trades in.
  v_anchor := $b1$  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  for update;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;$b1$;
  v_replacement := $s1$  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  for update;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;

  if v_intake.source_interpretation_id is not null then
    select private.resolve_document_currency(v_org, p_supplier_id, i.payload) ->> 'currency'
      into v_currency
    from public.document_interpretations i
    where i.org_id = v_org and i.id = v_intake.source_interpretation_id;
  end if;
  if v_currency is null then
    select s2.default_currency into v_currency
    from public.suppliers s2
    where s2.org_id = v_org and s2.id = p_supplier_id and s2.deleted_at is null;
  end if;
  if v_currency is null then
    -- The document printed a currency this system does not recognise. "I could not read it" is
    -- not "shekels", so the whole submission stops rather than inventing a unit for every row.
    raise exception 'price_submission_currency_unresolved' using errcode = '22023';
  end if;$s1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: p1b currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (c) one parser, and a message that names the actual cause.
  v_anchor := $b2$    v_price_text := regexp_replace(
      trim(coalesce(v_item ->> 'price_text', '')),
      '[[:space:]₪,]', '', 'g'
    );
    if length(v_price_text) > 16 or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'נדרש מחיר חיובי ותקין'
      ));
      continue;
    end if;
    v_price := round(v_price_text::numeric, 2);
    if v_price <= 0 or v_price > 1000000 then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'המחיר חייב להיות גדול מאפס ועד 1,000,000'
      ));
      continue;
    end if;$b2$;
  v_replacement := $s2$    v_price_text := trim(coalesce(v_item ->> 'price_text', ''));
    v_parsed := private.parse_price(v_price_text, v_currency);
    if not (v_parsed ->> 'ok')::boolean then
      -- The reason travels as a CODE. The sentence beside it is the fallback for a client that
      -- does not know the code yet, and it names the cause rather than repeating "invalid price"
      -- over five different failures.
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', v_parsed ->> 'reason',
        'currency', v_currency,
        'printed_currency', v_parsed ->> 'printed_currency',
        'message', case v_parsed ->> 'reason'
          when 'price_missing' then 'תא המחיר ריק'
          when 'price_currency_mismatch' then
            'המחיר נקוב ב-' || coalesce(v_parsed ->> 'printed_currency', '?')
            || ' והמחירון הזה ב-' || v_currency || '; אין המרה בין מטבעות'
          when 'price_currency_unknown' then 'מטבע המחירון אינו מטבע פעיל מוכר'
          when 'price_not_positive' then 'המחיר שנקרא אינו חיובי'
          when 'price_below_minor_unit' then 'המחיר קטן מהיחידה הקטנה ביותר של ' || v_currency
          when 'price_above_cap' then 'המחיר חורג מהתקרה של 1,000,000'
          else 'לא ניתן לקרוא את המחיר בתא'
        end
      ));
      continue;
    end if;
    v_price := (v_parsed ->> 'value')::numeric;$s2$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: p1b parse anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (d) the rows handed to the writer name their currency.
  v_anchor := $b3$    v_valid_rows := v_valid_rows || jsonb_build_array(jsonb_build_object(
      'supplier_id', p_supplier_id,
      'product_id', v_product_id,
      'price', v_price,
      'available', v_available
    ));$b3$;
  v_replacement := $s3$    v_valid_rows := v_valid_rows || jsonb_build_array(jsonb_build_object(
      'supplier_id', p_supplier_id,
      'product_id', v_product_id,
      'price', v_price,
      'available', v_available,
      'currency', v_currency,
      -- Carried so a refusal the WRITER makes can be reported against the file row a person can
      -- actually find. `jsonb_to_recordset` in the writer names neither key, so both are inert
      -- there and exist only for the merge below.
      'source_row', v_source_row,
      'product_name', nullif(v_product_name, '')
    ));$s3$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: p1b valid rows anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (e) the writer can now refuse a row of its own (a currency change on an existing price). Those
  -- refusals are merged into the submission's rejections instead of disappearing into a count.
  v_anchor := $b4$  v_rejected := jsonb_array_length(v_rejections);
  if jsonb_array_length(v_valid_rows) > 0 then
    v_import_result := public.p1_import_supplier_prices_internal(
      v_valid_rows, p_target_month, v_reason
    );
    v_created := coalesce((v_import_result ->> 'created')::integer, 0);
    v_updated := coalesce((v_import_result ->> 'updated')::integer, 0);
    v_unchanged := coalesce((v_import_result ->> 'unchanged')::integer, 0);
    v_accepted := v_created + v_updated;
  end if;$b4$;
  v_replacement := $s4$  if jsonb_array_length(v_valid_rows) > 0 then
    v_import_result := public.p1_import_supplier_prices_internal(
      v_valid_rows, p_target_month, v_reason
    );
    v_created := coalesce((v_import_result ->> 'created')::integer, 0);
    v_updated := coalesce((v_import_result ->> 'updated')::integer, 0);
    v_unchanged := coalesce((v_import_result ->> 'unchanged')::integer, 0);
    v_accepted := v_created + v_updated;
    v_rejections := v_rejections || coalesce(
      (select jsonb_agg(jsonb_build_object(
                'row', (valid.value ->> 'source_row')::integer,
                'product', valid.value ->> 'product_name',
                'reason', refused.value ->> 'reason',
                'currency', refused.value ->> 'currency',
                'existing_currency', refused.value ->> 'existing_currency',
                'message', case refused.value ->> 'reason'
                  when 'currency_mismatch_existing_price' then
                    'למוצר כבר יש מחיר ב-' || coalesce(refused.value ->> 'existing_currency', '?')
                    || ' והמחירון הזה ב-' || coalesce(refused.value ->> 'currency', '?')
                    || '; שינוי מטבע של מוצר אינו נעשה דרך העלאת מחירון'
                  else 'השורה נדחתה בכתיבה: ' || coalesce(refused.value ->> 'reason', 'unknown')
                end))
       from jsonb_array_elements(coalesce(v_import_result -> 'rejections', '[]'::jsonb)) refused
       left join lateral (
         select value from jsonb_array_elements(v_valid_rows) row_value(value)
         where row_value.value ->> 'product_id' = refused.value ->> 'product_id'
         limit 1
       ) valid on true),
      '[]'::jsonb);
  end if;
  v_rejected := jsonb_array_length(v_rejections);$s4$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: p1b import call anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_p1b_submit$;

-- ORDERING NOTE FOR THE MIGRATION OWNER. Anchor (d) adds `source_row` and `product_name` to the
-- rows p1b builds, and anchor (e) reads them back when it merges the writer's own refusals. The
-- two must stay in this order inside one DO block: (e) is applied to the definition (d) already
-- produced, so splitting them across two migrations would leave one release in which the merge
-- reports `null` for every row number.


-- =====================================================================================
-- 4. CONSUMER TWO -- apply_price_list_interpretation_qualified_impl (the automatic path)
-- =====================================================================================

do $patch_apply_price_list$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := $c0$  v_price_text text;
  v_price numeric;$c0$;
  v_replacement := $t0$  v_price_text text;
  v_price numeric;
  v_currency text;
  v_parsed jsonb;$t0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: apply declarations anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- The currency is resolved once for the whole interpretation, after the supplier is known and
  -- before any line is read. An unrecognised printed currency queues the interpretation for review
  -- under the reason code the review screen already renders -- it does not fall back to shekels.
  v_anchor := $c1$  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;$c1$;
  v_replacement := $t1$  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  if v_reason_code is null then
    v_currency := private.resolve_document_currency(
      v_i.org_id, v_supplier_id, v_i.payload) ->> 'currency';
    if v_currency is null then
      v_reason_code := 'currency_unrecognised';
    end if;
  end if;$t1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: apply currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $c2$    if v_line_reason_code is null then
      v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');
      if length(v_price_text) > 16
         or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
        v_line_reason_code := 'line_price_unreadable';
      else
        v_price := round(v_price_text::numeric, 2);
        if v_price <= 0 or v_price > 1000000 then
          v_line_reason_code := 'line_price_unreadable';
        end if;
      end if;
    end if;$c2$;
  v_replacement := $t2$    if v_line_reason_code is null then
      v_parsed := private.parse_price(v_price_text, v_currency);
      if (v_parsed ->> 'ok')::boolean then
        v_price := (v_parsed ->> 'value')::numeric;
      else
        -- Five different failures used to arrive as one code, so the review screen told a person
        -- the price was unreadable when the real answer was "this line is priced in dollars".
        v_line_reason_code := case v_parsed ->> 'reason'
          when 'price_currency_mismatch' then 'line_price_currency_mismatch'
          when 'price_currency_unknown' then 'currency_unrecognised'
          when 'price_not_positive' then 'line_price_not_positive'
          when 'price_below_minor_unit' then 'line_price_below_minor_unit'
          when 'price_above_cap' then 'line_price_above_cap'
          else 'line_price_unreadable'
        end;
      end if;
    end if;$t2$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: apply parse anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_apply_price_list$;


-- =====================================================================================
-- 5. CONSUMER THREE -- run_price_list_shadow
--
-- The shadow run exists to predict what the writer would do. If it parses differently from the
-- writer it is not a shadow, it is a second opinion -- so it gets the same parser and the same
-- currency resolution, and nothing else changes.
-- =====================================================================================

do $patch_price_list_shadow$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.run_price_list_shadow(uuid,uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := $d0$  v_price_text text;
  v_price numeric;$d0$;
  v_replacement := $u0$  v_price_text text;
  v_price numeric;
  v_currency text;
  v_parsed jsonb;$u0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: shadow declarations anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $d1$  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;$d1$;
  v_replacement := $u1$  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  if v_global_reason is null then
    v_currency := private.resolve_document_currency(
      v_i.org_id, v_supplier_id, v_i.payload) ->> 'currency';
    if v_currency is null then
      v_global_reason := 'currency_unrecognised';
    end if;
  end if;$u1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: shadow currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $d2$    if v_line_reason is null then
      v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');
      if length(v_price_text) > 16
         or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
        v_line_reason := 'line_price_unreadable';
      else
        v_price := round(v_price_text::numeric, 2);
        if v_price <= 0 or v_price > 1000000 then
          v_line_reason := 'line_price_unreadable';
        end if;
      end if;
    end if;$d2$;
  v_replacement := $u2$    if v_line_reason is null then
      v_parsed := private.parse_price(v_price_text, v_currency);
      if (v_parsed ->> 'ok')::boolean then
        v_price := (v_parsed ->> 'value')::numeric;
      else
        v_line_reason := case v_parsed ->> 'reason'
          when 'price_currency_mismatch' then 'line_price_currency_mismatch'
          when 'price_currency_unknown' then 'currency_unrecognised'
          when 'price_not_positive' then 'line_price_not_positive'
          when 'price_below_minor_unit' then 'line_price_below_minor_unit'
          when 'price_above_cap' then 'line_price_above_cap'
          else 'line_price_unreadable'
        end;
      end if;
    end if;$u2$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: shadow parse anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_price_list_shadow$;


-- =====================================================================================
-- 6. THE PREVIEW -- get_qualified_product_creation_dry_run
--
-- This is where `[^0-9.]` lives: the one expression in the whole history that swallows letters and
-- destroys the sign. It is the reason the preview says a row is fine and the writer then refuses
-- it. It is replaced by the same parser the writers use, so preview and write can no longer
-- disagree about a price, and the preview reports WHY rather than a single `invalid_price`.
-- =====================================================================================

do $patch_dry_run$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.get_qualified_product_creation_dry_run(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := $e0$    v_price_text:=regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[^0-9.]','','g');
    v_price:=null; v_outcome:=null;
    if length(v_price_text)<=16 and v_price_text~'^[0-9]+([.][0-9]{1,4})?$' then
      v_price:=round(v_price_text::numeric,v_minor_units);
    end if;
    if v_price is null or v_price<=0 or v_price>1000000 then
      v_outcome:='invalid_price'; v_invalid:=v_invalid+1;$e0$;
  v_replacement := $f0$    v_parsed:=private.parse_price(v_values->>'unit_price',v_currency);
    v_price:=case when (v_parsed->>'ok')::boolean then (v_parsed->>'value')::numeric end;
    v_outcome:=null;
    if v_price is null then
      v_outcome:=v_parsed->>'reason'; v_invalid:=v_invalid+1;$f0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: dry run parse anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $e1$  v_currency text; v_minor_units smallint;$e1$;
  v_replacement := $f1$  v_currency text; v_minor_units smallint; v_parsed jsonb;$f1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w2-prices: dry run declarations anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_dry_run$;

-- NOTE FOR THE MIGRATION OWNER. The dry run returns `invalid_price_count` and per-row `outcome`.
-- After this patch a row's `outcome` carries the parser's reason code instead of the single
-- `invalid_price`. `PriceListAutomationReadiness.tsx` types that union and must be widened in the
-- same package -- the frontend change is in this wave and is already written.


-- =====================================================================================
-- 7. POSTFLIGHT -- the assertions this migration must not be allowed to skip
-- =====================================================================================

do $assert_w2_prices$
declare v_violations text; v_probe jsonb;
begin
  -- The parser exists and refuses rather than raises.
  v_probe := private.parse_price('12.50 USD', 'ILS');
  if (v_probe ->> 'ok')::boolean or v_probe ->> 'reason' <> 'price_currency_mismatch' then
    raise exception 'w2-prices: a foreign currency is not refused by name: %', v_probe;
  end if;
  v_probe := private.parse_price('-5', 'ILS');
  if (v_probe ->> 'value')::numeric <> -5 or v_probe ->> 'reason' <> 'price_not_positive' then
    raise exception 'w2-prices: the sign was not preserved: %', v_probe;
  end if;
  v_probe := private.parse_price('1,234.50', 'ILS');
  if not (v_probe ->> 'ok')::boolean or (v_probe ->> 'value')::numeric <> 1234.50 then
    raise exception 'w2-prices: a grouped thousands separator was not read: %', v_probe;
  end if;
  v_probe := private.parse_price('1,5', 'ILS');
  if (v_probe ->> 'ok')::boolean then
    raise exception 'w2-prices: an ambiguous comma was silently read as 15: %', v_probe;
  end if;
  v_probe := private.parse_price('12.345', 'KWD');
  if not (v_probe ->> 'ok')::boolean or (v_probe ->> 'value')::numeric <> 12.345 then
    raise exception 'w2-prices: three minor units are not supported: %', v_probe;
  end if;
  v_probe := private.parse_price('12.5', 'JPY');
  if not (v_probe ->> 'ok')::boolean or (v_probe ->> 'value')::numeric <> 13
     or not (v_probe ->> 'rounded')::boolean then
    raise exception 'w2-prices: a zero-minor-unit currency was not rounded and flagged: %', v_probe;
  end if;

  -- The writer names the currency column in both tables it writes.
  if position('currency' in (select prosrc from pg_proc where oid =
       'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure)) = 0 then
    raise exception 'w2-prices: the writer still does not name a currency';
  end if;
  if position('currency_mismatch_existing_price' in (select prosrc from pg_proc where oid =
       'public.p1_import_supplier_prices_internal(jsonb,date,text)'::regprocedure)) = 0 then
    raise exception 'w2-prices: a currency change on an existing price is not refused by name';
  end if;

  -- The narrow strip expression is gone from every live body, and so is the dry run's [^0-9.].
  if exists (
    select 1 from pg_proc p
    where p.oid in (
      'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)'::regprocedure,
      'public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)'::regprocedure,
      'public.run_price_list_shadow(uuid,uuid,uuid)'::regprocedure)
      and p.prosrc like '%[[:space:]' || chr(8362) || ',]%'
  ) then
    raise exception 'w2-prices: a writer still carries the narrow strip expression';
  end if;
  if position('[^0-9.]' in (select prosrc from pg_proc where oid =
       'public.get_qualified_product_creation_dry_run(uuid)'::regprocedure)) <> 0 then
    raise exception 'w2-prices: the dry run still swallows letters and the sign';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'w2-prices scope failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'w2-prices export failed:\n%', v_violations; end if;
end
$assert_w2_prices$;


-- =====================================================================================
-- SUITE ASSERTIONS REQUESTED -- named by the existing file each belongs in
--
-- These are the assertions I want; I have not written them into the suites because the suites run
-- against the shared local stack and running one resets it.
--
-- supabase/tests/p1_price_submissions.sql   (the spreadsheet and OCR intake, p1b)
--   1. A supplier whose `default_currency` is 'USD' submits a price list. Assert
--      `supplier_products.currency = 'USD'` and `price_history.currency = 'USD'` for every row
--      written. TODAY THIS FAILS: both land as 'ILS' from the column default. This is the single
--      most important assertion in the wave.
--   2. Same supplier, a cell reading '12.50 ILS'. Assert the row is rejected with
--      `reason = 'price_currency_mismatch'`, that `printed_currency = 'ILS'`, that NO row is
--      written for that product, and that the OTHER rows in the same file are still accepted --
--      per-row rejection, not a total failure.
--   3. A product already priced in ILS receives a USD list. Assert exactly one rejection with
--      `reason = 'currency_mismatch_existing_price'`, that `supplier_products.current_price` and
--      `.currency` are UNCHANGED, that no second row appeared for the pair, and that
--      `price_history` gained no row.
--   4. A cell reading '-5'. Assert `reason = 'price_not_positive'` and NOT `invalid_price` --
--      the sign survived the parser and the message names the cause.
--   5. A cell reading '1,234.50' is accepted as 1234.50; a cell reading '1,5' is rejected as
--      `price_unreadable` rather than silently read as 15.
--   6. The submission's `rejected_count` equals `jsonb_array_length(rejections)` after the
--      writer's own refusals are merged in -- the count and the list cannot disagree.
--
-- supabase/tests/p15_automatic_price_list_intake.sql   (apply_price_list_interpretation)
--   7. An interpretation whose payload prints '$' for a supplier trading in ILS: assert every
--      line waits with `line_price_currency_mismatch`, and that the decision's outcome is
--      `queued_for_review` rather than a partial application in the wrong currency.
--   8. An interpretation printing a currency `resolve_document_currency` cannot recognise: assert
--      the decision reason is `currency_unrecognised` and that NOTHING was written. "I could not
--      read it" must not become "shekels".
--   9. A well-formed USD interpretation for a USD supplier writes `supplier_products.currency`
--      = 'USD' end to end, through `prepare_ocr_supplier_price_intake` and p1b.
--
-- supabase/tests/p18_document_automation_calibration.sql   (run_price_list_shadow)
--  10. For one interpretation, the shadow's per-line `reason_code` set equals the apply path's
--      per-line reason set. A shadow that parses differently from the writer is not a shadow.
--
-- supabase/tests/p26_price_baseline.sql   (the money shape)
--  11. `select count(*) from price_history where currency is distinct from
--      (select currency from supplier_products sp where sp.id = supplier_product_id)` is zero --
--      a price and its history never disagree about the unit.
-- =====================================================================================
