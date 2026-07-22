# Creates the demo auth users via the Supabase Admin API. ASCII only (PS 5.1 reads no-BOM files as ANSI).
# Neutral Hebrew display names are set by supabase/demo/demo_seed.sql.
# Usage: $env:SUPABASE_SERVICE_KEY = "..."; .\scripts\create-users.ps1
param([string]$ProjectUrl = "https://rkftlbctohswhbbiaqin.supabase.co")
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_SERVICE_KEY) { throw "SUPABASE_SERVICE_KEY not set" }

$emails = @("owner@demo.supplyflow.local", "kitchen@demo.supplyflow.local", "office@demo.supplyflow.local", "payer@demo.supplyflow.local", "accountant@demo.supplyflow.local")

$headers = @{
  apikey        = $env:SUPABASE_SERVICE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_KEY)"
}

foreach ($email in $emails) {
  $body = @{ email = $email; password = "SupplyFlowDemo2026!"; email_confirm = $true } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$ProjectUrl/auth/v1/admin/users" -Headers $headers -ContentType "application/json" -Body $body
    Write-Output "created $email -> $($resp.id)"
  } catch {
    Write-Output "FAILED ${email}: $($_.Exception.Message)"
  }
}
