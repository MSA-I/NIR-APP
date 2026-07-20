# Loads (or reloads) the SupplyFlow demo tenant. ASCII only (PS 5.1 reads no-BOM files as ANSI).
#
# The demo org is a normal tenant that happens to be full of showcase data. Loading it does
# not touch any other organization, so it is safe to run against a database that already
# holds real customers.
#
# Prerequisites, once per project:
#   .\scripts\create-users.ps1          # creates the demo auth users (owner@gamos.demo etc.)
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
#   .\scripts\seed-demo.ps1             # reset + load + verify
#   .\scripts\seed-demo.ps1 -ResetOnly  # remove the demo tenant and stop
#   .\scripts\seed-demo.ps1 -VerifyOnly # run the isolation audit only
param(
  [string]$ProjectRef = "rkftlbctohswhbbiaqin",
  [switch]$ResetOnly,
  [switch]$VerifyOnly
)
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_ACCESS_TOKEN) { throw "SUPABASE_ACCESS_TOKEN not set" }

$root  = Split-Path -Parent $PSScriptRoot
$query = Join-Path $PSScriptRoot "db-query.ps1"

function Invoke-SqlFile([string]$RelativePath, [string]$Label) {
  $full = Join-Path $root $RelativePath
  if (-not (Test-Path -LiteralPath $full)) { throw "missing SQL file: $full" }
  Write-Output ""
  Write-Output "== $Label ($RelativePath)"
  & $query -SqlFile $full -ProjectRef $ProjectRef
}

if ($VerifyOnly) {
  Invoke-SqlFile "supabase\demo\demo_verify.sql" "tenant isolation audit"
  return
}

Invoke-SqlFile "supabase\demo\demo_reset.sql" "removing any existing demo tenant"

if ($ResetOnly) {
  Write-Output ""
  Write-Output "Demo tenant removed. The demo auth users were left in place."
  return
}

Invoke-SqlFile "supabase\demo\demo_seed.sql"   "loading demo tenant"
Invoke-SqlFile "supabase\demo\demo_verify.sql" "tenant isolation audit"

Write-Output ""
Write-Output "Done. Every bad_rows value in sections B and C above must be 0."
