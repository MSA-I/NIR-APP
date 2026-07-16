# Creates the demo auth users via the Supabase Admin API. ASCII only (PS 5.1 reads no-BOM files as ANSI).
# Hebrew display names are set on the profiles rows by supabase/seed.sql.
# Usage: $env:SUPABASE_SERVICE_KEY = "..."; .\scripts\create-users.ps1
param([string]$ProjectUrl = "https://rkftlbctohswhbbiaqin.supabase.co")
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_SERVICE_KEY) { throw "SUPABASE_SERVICE_KEY not set" }

$emails = @("owner@gamos.demo", "nir@gamos.demo", "office@gamos.demo", "payer@gamos.demo", "accountant@gamos.demo")

$headers = @{
  apikey        = $env:SUPABASE_SERVICE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_KEY)"
}

foreach ($email in $emails) {
  $body = @{ email = $email; password = "Gamos2026!"; email_confirm = $true } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$ProjectUrl/auth/v1/admin/users" -Headers $headers -ContentType "application/json" -Body $body
    Write-Output "created $email -> $($resp.id)"
  } catch {
    Write-Output "FAILED ${email}: $($_.Exception.Message)"
  }
}
