# Loads (or reloads) the SupplyFlow demo tenant. ASCII only (PS 5.1 reads no-BOM files as ANSI).
#
# The demo org is a normal tenant that happens to be full of showcase data. Loading it does
# not touch any other organization. Live use still requires an explicit target and override.
#
# Prerequisites, once per project:
#   .\scripts\create-users.ps1          # creates the neutral demo auth users
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
#   .\scripts\seed-demo.ps1 -ProjectRef "<project ref>"             # reset + load + verify
#   .\scripts\seed-demo.ps1 -ProjectRef "<project ref>" -ResetOnly  # remove demo tenant
#   .\scripts\seed-demo.ps1 -ProjectRef "<project ref>" -VerifyOnly # read-only audit
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [switch]$ResetOnly,
  [switch]$VerifyOnly,
  [switch]$AllowProduction
)
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_ACCESS_TOKEN) { throw "SUPABASE_ACCESS_TOKEN not set" }
if ($ProjectRef -eq "rkftlbctohswhbbiaqin" -and -not $AllowProduction) {
  throw "Refusing to mutate or inspect demo data in the known production project without -AllowProduction."
}

$root  = Split-Path -Parent $PSScriptRoot
$query = Join-Path $PSScriptRoot "db-query.ps1"

function Invoke-SqlFile([string]$RelativePath, [string]$Label) {
  $full = Join-Path $root $RelativePath
  if (-not (Test-Path -LiteralPath $full)) { throw "missing SQL file: $full" }
  Write-Output ""
  Write-Output "== $Label ($RelativePath)"
  $arguments = @{ SqlFile = $full; ProjectRef = $ProjectRef }
  if ($AllowProduction) { $arguments.AllowProduction = $true }
  & $query @arguments
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
