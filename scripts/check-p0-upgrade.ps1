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

function Copy-And-RunSql([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $target = "/var/lib/postgresql/p0-upgrade-$([System.IO.Path]::GetFileName($resolved))"
  & docker cp $resolved "$container`:$target"
  if ($LASTEXITCODE -ne 0) { throw "copying $resolved failed." }
  & docker exec $container psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f $target
  if ($LASTEXITCODE -ne 0) { throw "running $resolved failed." }
}

try {
  Invoke-Checked { & supabase db reset --version 0019 --no-seed } "reset through 0019"
  Copy-And-RunSql (Join-Path $PSScriptRoot "p0-upgrade-fixture.sql")
  Invoke-Checked { & supabase migration up --local } "P0 migration upgrade"
  Copy-And-RunSql (Join-Path $PSScriptRoot "p0-upgrade-verify.sql")
}
finally {
  Invoke-Checked { & supabase db reset } "restoring local database"
}
