-- The standing filing-reason report (package 3; DEBT-REGISTER §19's measurement, now runnable).
--
-- What it answers: per prompt_version, what did the autonomy layer DO and WHY — filings by
-- reason_code (0079's column), plus the unmeasured tail of interpretations that never became
-- a filing (their stop-reason lives only in Edge logs — §19's red note, still true; the tail
-- is counted so the report can never silently pretend to cover everything).
--
-- ONE statement on purpose: the Management API query endpoint returns only the LAST
-- statement's rows (measured 09.08.2026 — the first of two selects was silently dropped).
--
-- Read-only. Run against production with:
--   $env:SUPABASE_ACCESS_TOKEN = (Get-Content <NIR-APP-DOCS>\NIR-TOKEN-SUPABASE.txt -Raw).Trim()
--   powershell -File scripts/db-query.ps1 -SqlFile scripts/calibration/filing-reason-report.sql `
--     -ProjectRef rkftlbctohswhbbiaqin -AllowProduction

select 'filings_by_reason' as section,
       coalesce(i.prompt_version, '(no interpretation)') as prompt_version,
       coalesce(f.reason_code, '(none recorded)')        as key,
       count(*)::int                                     as n,
       min(f.decided_at)                                 as first_seen,
       max(f.decided_at)                                 as last_seen
from document_filings f
left join document_interpretations i on i.id = f.interpretation_id
group by 2, 3

union all

select 'interpretations_without_filing',
       i.prompt_version,
       'unfiled_tail',
       count(*) filter (where f.id is null)::int,
       min(i.created_at),
       max(i.created_at)
from document_interpretations i
left join document_filings f on f.interpretation_id = i.id
group by 2

order by 1, 2, 4 desc;
