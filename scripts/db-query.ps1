# Runs a SQL file against the Supabase project via the Management API.
# Usage: $env:SUPABASE_ACCESS_TOKEN = "sbp_..."; .\scripts\db-query.ps1 -SqlFile path\to\file.sql
param(
  [Parameter(Mandatory = $true)][string]$SqlFile,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [switch]$AllowProduction
)
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_ACCESS_TOKEN) { throw "SUPABASE_ACCESS_TOKEN not set" }
if ($ProjectRef -eq "rkftlbctohswhbbiaqin" -and -not $AllowProduction) {
  throw "Refusing to run SQL against the known production project without -AllowProduction."
}

# Line endings are normalised to LF before the file leaves this machine.
#
# A function body is stored as the bytes it was created from, so a migration applied from Windows
# writes CRLF into `prosrc` while the same file applied on a Linux CI runner writes LF. Every
# later migration that patches a live body by string anchor then matches in CI and fails in
# production, which is exactly how the 0171-0205 rollout aborted at 0181. The environment a
# migration is applied from must not be able to change what the database stores.
$sql = [System.IO.File]::ReadAllText($SqlFile, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n").Replace("`r", "`n")
$body = @{ query = $sql } | ConvertTo-Json -Depth 3 -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

$resp = Invoke-RestMethod -Method Post `
  -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
  -Headers @{ Authorization = "Bearer $($env:SUPABASE_ACCESS_TOKEN)" } `
  -ContentType "application/json" -Body $bytes
$resp | ConvertTo-Json -Depth 6 -Compress
