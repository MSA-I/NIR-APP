# Creates a supplier agent login: auth user + profile(role=supplier, supplier_id).
# The agent can only maintain its own price list (enforced by RLS, migration 0004).
# Usage:
#   $env:SUPABASE_SERVICE_KEY  = "<service_role key>"
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
#   .\scripts\create-supplier-user.ps1 -Email meshek@supplier.demo -Password "..." -SupplierId "<uuid>" -FullName "<display name>"
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [Parameter(Mandatory = $true)][string]$SupplierId,
  [Parameter(Mandatory = $true)][string]$FullName,
  [string]$ProjectUrl = "https://rkftlbctohswhbbiaqin.supabase.co",
  [string]$ProjectRef = "rkftlbctohswhbbiaqin",
  [string]$OrgId = "11111111-1111-4111-8111-111111111111"
)
$ErrorActionPreference = "Stop"
if (-not $env:SUPABASE_SERVICE_KEY) { throw "SUPABASE_SERVICE_KEY not set" }
if (-not $env:SUPABASE_ACCESS_TOKEN) { throw "SUPABASE_ACCESS_TOKEN not set" }

# 1. auth user
$headers = @{ apikey = $env:SUPABASE_SERVICE_KEY; Authorization = "Bearer $($env:SUPABASE_SERVICE_KEY)" }
$body = @{ email = $Email; password = $Password; email_confirm = $true } | ConvertTo-Json -Compress
$user = Invoke-RestMethod -Method Post -Uri "$ProjectUrl/auth/v1/admin/users" -Headers $headers -ContentType "application/json" -Body $body
Write-Output "auth user: $($user.id)"

# 2. profile row (via Management API so RLS does not block)
$name = $FullName.Replace("'", "''")
$sql = "insert into profiles (id, org_id, full_name, role, supplier_id) values ('$($user.id)', '$OrgId', '$name', 'supplier', '$SupplierId');"
$qbody = @{ query = $sql } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($qbody)
Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
  -Headers @{ Authorization = "Bearer $($env:SUPABASE_ACCESS_TOKEN)" } -ContentType "application/json" -Body $bytes | Out-Null
Write-Output "profile created: $Email -> supplier $SupplierId"
