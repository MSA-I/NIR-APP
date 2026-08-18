-- Can the line-arithmetic guard actually run, and does it pass?
--
-- `0108` and `0099` reject a line whose `quantity * unit_price` misses `line_total` by more than
-- 0.05. That guard is the only thing standing between a misread digit and a payable invoice --
-- but it can only fire on a line that carries all three numbers. Measured on production on
-- 19.08.2026, under `gpt-5.6-terra`, 2,908 of 2,911 extracted lines carried a unit price and only
-- 331 carried a quantity: the guard was blind on 89% of the corpus, not because the rule is weak
-- but because the reading never produced the operands.
--
-- That is the number this query exists to watch. `mistral-ocr-latest` associated all three numbers
-- to the right row on 97% of benchmark rows against terra's 42%
-- (NIR-APP-DOCS/ocr-ab/20260818/triage-outcome.md), so the engine change is expected to move
-- `checkable_pct` far more than it moves `broken_pct`. Re-run it while the canary is live: if
-- coverage climbs and the break rate stays flat, the existing guard became real protection and no
-- second OCR vendor needs paying for. If lines keep breaking at the same rate on a much larger
-- denominator, that is the measured case for a second reader, and it will say which lines.
--
-- Read-only. Run:
--   $env:SUPABASE_ACCESS_TOKEN = (Get-Content <token file> -Raw).Trim()
--   .\scripts\db-query.ps1 -SqlFile .\scripts\ocr-line-arithmetic-coverage.sql `
--     -ProjectRef rkftlbctohswhbbiaqin -AllowProduction
with lines as (
  select
    e.engine,
    i.document_id,
    nullif(l -> 'values' ->> 'quantity', '')   as q,
    nullif(l -> 'values' ->> 'unit_price', '') as p,
    nullif(l -> 'values' ->> 'line_total', '') as t
  from document_interpretations i
  join document_extractions e on e.document_id = i.document_id
  cross join lateral jsonb_array_elements(coalesce(i.payload -> 'line_items', '[]'::jsonb)) l
),
typed as (
  -- The interpretation stores every value as text, and a field the model could not read is a word
  -- rather than a number. Casting only what looks numeric keeps an unreadable quantity out of the
  -- denominator instead of turning it into a failed check.
  select
    engine,
    document_id,
    case when q ~ '^-?[0-9]+(\.[0-9]+)?$' then q::numeric end as qty,
    case when p ~ '^-?[0-9]+(\.[0-9]+)?$' then p::numeric end as price,
    case when t ~ '^-?[0-9]+(\.[0-9]+)?$' then t::numeric end as total
  from lines
),
counted as (
  select
    engine,
    count(distinct document_id) as documents,
    count(*) as lines_total,
    count(*) filter (where qty is not null and price is not null and total is not null) as checkable,
    count(*) filter (
      where qty is not null and price is not null and total is not null
        and abs(total - round(qty * price, 2)) > 0.05
    ) as broken
  from typed
  group by engine
)
select
  engine,
  documents,
  lines_total,
  checkable,
  round(100.0 * checkable / nullif(lines_total, 0), 1) as checkable_pct,
  broken,
  round(100.0 * broken / nullif(checkable, 0), 1) as broken_pct
from counted
order by lines_total desc;
