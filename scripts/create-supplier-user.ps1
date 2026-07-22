# Creates one supplier agent through the Auth Admin and PostgREST APIs. No operator input is
# concatenated into SQL, and a failed profile insert rolls back the newly-created Auth user.
#
# Usage:
#   $env:SUPABASE_SERVICE_KEY = "<service_role key>"
#   .\scripts\create-supplier-user.ps1 -ProjectUrl "http://127.0.0.1:55431" `
#     -Email "agent@example.test" -Password "<unique 16+ chars>" `
#     -OrgId "<uuid>" -SupplierId "<uuid>" -FullName "<display name>"
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectUrl,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Email,
  [Parameter(Mandatory = $true)][ValidateLength(16, 256)][string]$Password,
  [Parameter(Mandatory = $true)][Guid]$OrgId,
  [Parameter(Mandatory = $true)][Guid]$SupplierId,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$FullName,
  [switch]$AllowProduction
)

$ErrorActionPreference = "Stop"
$knownProductionHost = "rkftlbctohswhbbiaqin.supabase.co"
if (-not $env:SUPABASE_SERVICE_KEY) { throw "SUPABASE_SERVICE_KEY not set" }

$target = [Uri]$ProjectUrl
if (-not $target.IsAbsoluteUri -or $target.Scheme -notin @("http", "https")) {
  throw "ProjectUrl must be an absolute HTTP or HTTPS URL."
}
if ($target.Host -eq $knownProductionHost -and -not $AllowProduction) {
  throw "Refusing to provision a user in the known production project without -AllowProduction."
}

try { $parsedEmail = [System.Net.Mail.MailAddress]$Email } catch { throw "Email is not valid." }
if ($parsedEmail.Address -ne $Email.Trim()) { throw "Email is not valid." }
if (-not $FullName.Trim()) { throw "FullName cannot be blank." }

$baseUrl = $target.AbsoluteUri.TrimEnd('/')
$headers = @{
  apikey        = $env:SUPABASE_SERVICE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_KEY)"
}

$supplierQuery = "$baseUrl/rest/v1/suppliers?id=eq.$SupplierId&org_id=eq.$OrgId&select=id"
$supplierRows = @(Invoke-RestMethod -Method Get -Uri $supplierQuery -Headers $headers)
if ($supplierRows.Count -ne 1) { throw "SupplierId does not belong to OrgId." }

$authBody = @{
  email = $Email.Trim().ToLowerInvariant()
  password = $Password
  email_confirm = $true
} | ConvertTo-Json -Compress

$user = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/admin/users" `
  -Headers $headers -ContentType "application/json" -Body $authBody

try {
  $profileBody = @{
    id = [string]$user.id
    org_id = [string]$OrgId
    full_name = $FullName.Trim()
    role = "supplier"
    supplier_id = [string]$SupplierId
  } | ConvertTo-Json -Compress

  Invoke-RestMethod -Method Post -Uri "$baseUrl/rest/v1/profiles" -Headers ($headers + @{ Prefer = "return=minimal" }) `
    -ContentType "application/json" -Body $profileBody | Out-Null
} catch {
  Invoke-RestMethod -Method Delete -Uri "$baseUrl/auth/v1/admin/users/$($user.id)" -Headers $headers | Out-Null
  throw
}

Write-Output "supplier profile created: $($user.id)"
