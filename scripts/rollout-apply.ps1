# Applies a RANGE of migrations to a Supabase project, in order, writing the ledger row after
# each one -- and stopping dead on the first failure.
#
# WHY THIS EXISTS RATHER THAN 25 PAIRS OF COMMANDS BY HAND.
#
#   1. `db-query.ps1` DOES NOT WRITE THE LEDGER. It applies SQL and returns. The row in
#      `supabase_migrations.schema_migrations` is a separate write, and forgetting it is silent:
#      the schema moves, the ledger does not, and the next run re-applies everything. Here the
#      two are one step and cannot come apart.
#
#   2. THE FAILURE MODE IS EXPECTED, NOT EXCEPTIONAL. Fourteen of these migrations rewrite a
#      live function by matching an exact anchor in its current body, and raise if it is not
#      there. The `0171`-`0205` rollout stopped at `0181` for exactly that. So the loop is built
#      around stopping cleanly: the file that failed gets NO ledger row, every file before it
#      keeps its row, and re-running resumes from the failure instead of starting over.
#
#   3. `tee` MASKS AN EXIT CODE. Piping this to a log file reports success even when a step
#      threw, so the transcript is written from inside instead.
#
# Each migration is one request, and Postgres runs a multi-statement batch as one implicit
# transaction, so a single file is all-or-nothing. A failure never leaves half a migration.
#
# Read `docs/ROLLOUT-0243-0283-20260902.md` before running this. (The 0243-0267 document it
# used to name is superseded; it still holds the per-migration detail for that first stretch.)
#
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
#   .\scripts\rollout-apply.ps1 -From 0243 -To 0267 -ProjectRef rkftlbctohswhbbiaqin -AllowProduction
#   .\scripts\rollout-apply.ps1 -From 0243 -To 0267 -ProjectRef rkftlbctohswhbbiaqin -WhatIf
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{4}$')][string]$From,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{4}$')][string]$To,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [switch]$AllowProduction,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

if (-not $env:SUPABASE_ACCESS_TOKEN) { throw 'SUPABASE_ACCESS_TOKEN not set' }
if ($ProjectRef -eq 'rkftlbctohswhbbiaqin' -and -not $AllowProduction -and -not $WhatIf) {
  throw 'Refusing to run against the known production project without -AllowProduction.'
}

$root = Split-Path -Parent $PSScriptRoot
$migrationDir = Join-Path $root 'supabase\migrations'
$transcript = Join-Path $root ("rollout-{0}-{1}-{2}.log" -f $From, $To, (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-Both([string]$Text) {
  Write-Host $Text
  Add-Content -LiteralPath $transcript -Value $Text -Encoding utf8
}

function Invoke-Sql([string]$Sql) {
  # Normalised to LF before it leaves this machine, for the same reason db-query.ps1 does it: a
  # function body is stored as the bytes it was created from, and CRLF in `prosrc` is what makes
  # a later anchored migration search for text that cannot exist.
  $clean = $Sql.Replace("`r`n", "`n").Replace("`r", "`n")
  $body = @{ query = $clean } | ConvertTo-Json -Depth 3 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod -Method Post `
    -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
    -Headers @{ Authorization = "Bearer $($env:SUPABASE_ACCESS_TOKEN)" } `
    -ContentType 'application/json' -Body $bytes
}

# The files in range, in order.
$files = Get-ChildItem -LiteralPath $migrationDir -Filter '*.sql' |
  Where-Object { $_.Name.Substring(0, 4) -ge $From -and $_.Name.Substring(0, 4) -le $To } |
  Sort-Object Name
if (-not $files) { throw "no migrations between $From and $To" }

# Whatever the ledger already carries is skipped, so a resumed run does not re-apply.
$appliedRaw = Invoke-Sql "select version from supabase_migrations.schema_migrations where version >= '$From' and version <= '$To' order by version"
$applied = @($appliedRaw | ForEach-Object { $_.version })

Write-Both "rollout $From -> $To on $ProjectRef"
Write-Both "started $(Get-Date -Format o)"
Write-Both "$($files.Count) file(s) in range, $($applied.Count) already in the ledger"
if ($WhatIf) { Write-Both 'WHATIF: nothing will be applied.' }
Write-Both ''

$done = 0
foreach ($file in $files) {
  $version = $file.Name.Substring(0, 4)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name).Substring(5)

  if ($applied -contains $version) { Write-Both "  skip   $version  already in the ledger"; continue }
  if ($WhatIf) { Write-Both "  would  $version  $name"; continue }

  Write-Both "  apply  $version  $name"
  $sql = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
  try {
    Invoke-Sql $sql | Out-Null
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    Write-Both ''
    Write-Both "  FAILED at $version"
    Write-Both "  $detail"
    Write-Both ''
    Write-Both '  No ledger row was written for this migration, and nothing after it ran.'
    Write-Both '  Every migration before it is applied and recorded.'
    Write-Both '  Read the message above in full before changing anything. Do not re-run it'
    Write-Both '  unchanged, and do not force an anchor: fix the migration against the LIVE'
    Write-Both '  body, then run this script again -- it resumes from here.'
    Write-Both "  transcript: $transcript"
    exit 1
  }

  # The ledger row, and it is not optional. Written only after the apply returned.
  $escaped = $name.Replace("'", "''")
  Invoke-Sql "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$escaped')" | Out-Null

  # And proved, because an insert that silently did nothing would leave the same lie behind.
  $check = Invoke-Sql "select count(*) n from supabase_migrations.schema_migrations where version = '$version'"
  if ([int]$check.n -ne 1) {
    Write-Both "  LEDGER ROW MISSING for $version after insert -- stopping. The schema moved and the ledger did not."
    exit 1
  }
  $done++
}

Write-Both ''
Write-Both "applied $done migration(s)"
$head = Invoke-Sql 'select max(version) v, count(*) n from supabase_migrations.schema_migrations'
Write-Both "ledger head is now $($head.v) with $($head.n) row(s)"
Write-Both "finished $(Get-Date -Format o)"
Write-Both ''
Write-Both 'Next: node scripts/rollout-preflight.mjs --compare rollout-before.json'
Write-Both "transcript: $transcript"
