-- =====================================================================================
-- MIGRATION REQUEST — a currency marker may not sit between two digits.
--
-- THIS FILE IS NOT A MIGRATION. It is the SQL this fix needs, handed to the agent that owns
-- `supabase/migrations/`. Take a number with `npm run next-number -- migration` at the moment you
-- create the file; nothing here hard-codes one, because two agents picking the same number is a
-- failure this repository has already paid for.
--
-- WHAT IS WRONG, REPRODUCED AGAINST THE LIVE DATABASE (2026-09-03, local `supplyflow-p0`):
--
--   private.parse_price('1 USD 2', 'USD')  ->  {"ok": true, "value": 12.00}
--   private.parse_price('1USD2',   'USD')  ->  {"ok": true, "value": 12.00}
--
-- The marker loop replaces each recognised marker with a SPACE, and a few lines later every space
-- is deleted (`v_body := replace(v_body, ' ', '')`). So the digits on either side of the marker
-- are concatenated and `1 USD 2` is read as the number TWELVE. That is a silently WRONG PRICE,
-- not a refused row — the one outcome this parser exists to prevent.
--
-- THE RULE: a currency marker belongs at one end of the cell. `₪12.50` and `12.50 ILS` are how
-- suppliers print a price; `1 USD 2` is not a price at all. A marker with digits on BOTH sides is
-- refused. `price_unreadable` is the honest existing reason and no new reason code is added, so
-- nothing has to be added to `PriceRejectionReason` in `src/lib/price.ts` or to the i18n keys.
--
-- THE CLIENT HALF IS ALREADY DONE. `parsePrice` in `src/lib/price.ts` carried the same defect and
-- now applies the same rule, with the cases above pinned in `src/lib/price.spec.ts`. The two
-- implementations must agree; this file is the other half.
--
-- IT IS AN ANCHORED PATCH OF THE LIVE BODY. `private.parse_price(text,text)` was created by
-- `0298_one_parser_for_a_price.sql`; re-declaring it from there would silently revert anything
-- patched into it since. Every anchor below is a verbatim slice of what `pg_get_functiondef`
-- returns today, read as `replace(pg_get_functiondef(...), e'\r', '')` because a body applied from
-- Windows carries CRLF and one applied on CI does not (`check:anchored-replacements`), and each is
-- asserted to match exactly once.
--
-- THE LIVE BODY THIS WAS WRITTEN AGAINST:
--   private.parse_price(text,text) — md5 of the CR-stripped definition:
--     bf17eb786745c4bf0039e428ef426f93   (7189 characters)
--   Both anchors below were counted against that definition and each occurs exactly once.
-- =====================================================================================

do $patch_parse_price_marker$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.parse_price(text,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- 1. One more local: where in the remaining body the marker actually sits. `regexp_match`
  --    returns the token but not its position, and `strpos` is exact here because the token IS
  --    the leftmost match of the same pattern — an earlier occurrence of that exact substring
  --    would itself have been the leftmost match.
  v_anchor := e'  v_match text[];\nbegin';
  v_replacement := e'  v_match text[];\n  v_marker_at integer;\nbegin';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'parse_price: declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 2. The refusal itself, placed after the token is known to BE a currency marker and before the
  --    marker is recorded, so an unrecognised word keeps its existing path and its existing
  --    reason. A marker with digits on both sides ends the read.
  v_anchor := $anchor$    if v_token_code is null then
      -- A word this parser does not recognise as a currency. `12.5 KGM` is not a price in an
      -- unknown currency; it is a cell this parser will not guess at.
      return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
        'currency', v_expected, 'printed_currency', null,
        'minor_units', v_minor, 'rounded', false);
    end if;
    if v_printed is null then$anchor$;
  v_replacement := $replacement$    if v_token_code is null then
      -- A word this parser does not recognise as a currency. `12.5 KGM` is not a price in an
      -- unknown currency; it is a cell this parser will not guess at.
      return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
        'currency', v_expected, 'printed_currency', null,
        'minor_units', v_minor, 'rounded', false);
    end if;
    -- A CURRENCY MARKER BELONGS AT ONE END OF THE CELL, NEVER BETWEEN TWO DIGITS. Removing the
    -- marker leaves a space, and every space is deleted below, so `1 USD 2` and `1USD2` were both
    -- read as the number TWELVE -- a wrong price that looked like a clean parse. A cell with
    -- digits on both sides of a marker is not one price, and this parser says so.
    v_marker_at := strpos(v_body, v_token);
    if v_marker_at > 0
       and left(v_body, v_marker_at - 1) ~ '[0-9]'
       and substring(v_body from v_marker_at + length(v_token)) ~ '[0-9]' then
      return jsonb_build_object('ok', false, 'value', null, 'reason', 'price_unreadable',
        'currency', v_expected, 'printed_currency', v_printed,
        'minor_units', v_minor, 'rounded', false);
    end if;
    if v_printed is null then$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'parse_price: marker loop anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_parse_price_marker$;


-- =====================================================================================
-- POSTFLIGHT — the defect, and everything the fix must not have moved.
--
-- The five cases below the rule change are the ones `src/lib/price.spec.ts` asserts on the client
-- side. Two implementations of one rule are only safe while one set of cases holds both to it.
-- =====================================================================================

do $assert_parse_price_marker$
declare
  v_result jsonb;
  v_case record;
begin
  -- The reported defect, both spellings, in both a code and a symbol marker.
  for v_case in
    select * from (values
      ('1 USD 2',   'USD'),
      ('1USD2',     'USD'),
      ('1 ILS 2',   'ILS'),
      ('1₪2',       'ILS'),
      ('1 ₪ 2',     'ILS'),
      ('12.5 ILS 0','ILS')
    ) as t(cell, currency)
  loop
    v_result := private.parse_price(v_case.cell, v_case.currency);
    if coalesce((v_result->>'ok')::boolean, true)
       or v_result->>'reason' <> 'price_unreadable'
       or v_result->'value' <> 'null'::jsonb then
      raise exception 'parse_price: a marker between digits was not refused: % -> %',
        v_case.cell, v_result;
    end if;
  end loop;

  -- ...and a marker at either end is exactly where a marker belongs, and still reads.
  for v_case in
    select * from (values
      ('12.50',     'ILS', 12.50),
      ('₪12.50',    'ILS', 12.50),
      ('12.50 ILS', 'ILS', 12.50),
      ('12.50 ₪',   'ILS', 12.50),
      ('1,234.50',  'ILS', 1234.50)
    ) as t(cell, currency, expected)
  loop
    v_result := private.parse_price(v_case.cell, v_case.currency);
    if not coalesce((v_result->>'ok')::boolean, false)
       or (v_result->>'value')::numeric <> v_case.expected then
      raise exception 'parse_price: a marker at the edge stopped reading: % -> %',
        v_case.cell, v_result;
    end if;
  end loop;

  -- Nothing else moved. Each of these was already true and each names a different refusal, so a
  -- patch that collapsed them all into `price_unreadable` would be caught here.
  if private.parse_price('$12.50', 'ILS')->>'reason' <> 'price_currency_mismatch' then
    raise exception 'parse_price: a foreign currency stopped being a mismatch';
  end if;
  if private.parse_price('12.50 USD ILS', 'ILS')->>'reason' <> 'price_currency_mismatch' then
    raise exception 'parse_price: two currencies stopped being a mismatch';
  end if;
  if private.parse_price('12.5 KGM', 'ILS')->>'reason' <> 'price_unreadable' then
    raise exception 'parse_price: an unknown word stopped being unreadable';
  end if;
  if private.parse_price('-5', 'ILS')->>'reason' <> 'price_not_positive'
     or (private.parse_price('-5', 'ILS')->>'value')::numeric <> -5 then
    raise exception 'parse_price: the sign stopped travelling with the refusal';
  end if;
  if private.parse_price('1,5', 'ILS')->>'reason' <> 'price_unreadable' then
    raise exception 'parse_price: an ambiguous comma stopped being refused';
  end if;
  if private.parse_price('12.50', null)->>'reason' <> 'price_currency_unknown' then
    raise exception 'parse_price: an unnamed currency stopped being refused';
  end if;
end
$assert_parse_price_marker$;
