# Replays the local project through migration 0019, loads a valid two-tenant fixture, then
# applies the P0 migrations. The final reset restores the isolated local database to HEAD.
param([switch]$ResetUpgradeDatabase)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$container = "supabase_db_supplyflow-p0"
$expectedProjectId = "supplyflow-p0"
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root "supabase\config.toml") -Raw -Encoding UTF8

if (-not $ResetUpgradeDatabase) {
  throw "This check resets the isolated local database. Re-run with -ResetUpgradeDatabase."
}
if ($config -notmatch "(?m)^project_id\s*=\s*`"$([regex]::Escape($expectedProjectId))`"\s*$") {
  throw "Refusing to run outside the isolated $expectedProjectId project."
}

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed." }
}

# A local-stack failure (docker, supabase reset) is not a product regression. The sentinel
# on stdout lets check-quality-gates.ps1 classify the captured child failure as an
# infrastructure block instead of FAIL/product. Write-Host so the line reaches the child
# process stdout regardless of any pipeline capture around the caller.
function Stop-Infrastructure([string]$Reason, [string]$Message) {
  Write-Host "##GATE-INFRA##$Reason"
  throw $Message
}

function Copy-And-RunSql([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $target = "/var/lib/postgresql/p0-upgrade-$([System.IO.Path]::GetFileName($resolved))"
  & docker cp $resolved "$container`:$target"
  if ($LASTEXITCODE -ne 0) { Stop-Infrastructure "local_database_reset_failed" "copying $resolved failed." }
  & docker exec $container psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f $target
  if ($LASTEXITCODE -ne 0) { throw "running $resolved failed." }
}

try {
  # The two `supabase db reset` invocations are environment plumbing, so their failures are
  # infrastructure; `supabase migration up` exercises the migrations under test, so its
  # failure stays a product failure (the bare Invoke-Checked throw).
  & supabase db reset --version 0019 --no-seed
  if ($LASTEXITCODE -ne 0) { Stop-Infrastructure "local_database_reset_failed" "reset through 0019 failed." }
  Copy-And-RunSql (Join-Path $PSScriptRoot "p0-upgrade-fixture.sql")
  Invoke-Checked { & supabase migration up --local } "P0 migration upgrade"
  Copy-And-RunSql (Join-Path $PSScriptRoot "p0-upgrade-verify.sql")
}
finally {
  & supabase db reset
  if ($LASTEXITCODE -ne 0) { Stop-Infrastructure "local_database_reset_failed" "restoring local database failed." }
}
