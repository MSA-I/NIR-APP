# Creates the six demo Auth users. Passwords come from an external per-user manifest and
# are never printed. The manifest must live outside this repository.
#
# Manifest shape:
# { "accounts": [ { "email": "owner@demo.supplyflow.local", "password": "..." }, ... ] }
#
# Usage:
#   $env:SUPABASE_SERVICE_KEY = "<service_role key>"
#   .\scripts\create-users.ps1 -ProjectUrl "http://127.0.0.1:55431" -CredentialsPath "C:\secure\demo-users.json"
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectUrl,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialsPath,
  [switch]$AllowProduction
)

$ErrorActionPreference = "Stop"
$knownProductionHost = "rkftlbctohswhbbiaqin.supabase.co"
$requiredEmails = @(
  "owner@demo.supplyflow.local",
  "kitchen@demo.supplyflow.local",
  "office@demo.supplyflow.local",
  "payer@demo.supplyflow.local",
  "accountant@demo.supplyflow.local",
  "supplier@demo.supplyflow.local"
)

if (-not $env:SUPABASE_SERVICE_KEY) { throw "SUPABASE_SERVICE_KEY not set" }

$target = [Uri]$ProjectUrl
if (-not $target.IsAbsoluteUri -or $target.Scheme -notin @("http", "https")) {
  throw "ProjectUrl must be an absolute HTTP or HTTPS URL."
}
if ($target.Host -eq $knownProductionHost -and -not $AllowProduction) {
  throw "Refusing to create demo users in the known production project without -AllowProduction."
}

$manifestFile = (Resolve-Path -LiteralPath $CredentialsPath).Path
$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$repoPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($manifestFile.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $manifestFile.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "CredentialsPath must be outside the repository."
}

$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$accounts = @($manifest.accounts)
if ($accounts.Count -ne $requiredEmails.Count) {
  throw "Credentials manifest must contain exactly the six demo accounts."
}

$seenEmails = @{}
$seenPasswords = @{}
foreach ($account in $accounts) {
  $email = ([string]$account.email).Trim().ToLowerInvariant()
  $password = [string]$account.password
  if ($requiredEmails -notcontains $email) { throw "Unexpected demo account in credentials manifest: $email" }
  if ($seenEmails.ContainsKey($email)) { throw "Duplicate demo account in credentials manifest: $email" }
  if ($password.Length -lt 16) { throw "Each demo password must contain at least 16 characters." }
  if ($seenPasswords.ContainsKey($password)) { throw "Every demo account must use a unique password." }
  $seenEmails[$email] = $true
  $seenPasswords[$password] = $true
}
foreach ($email in $requiredEmails) {
  if (-not $seenEmails.ContainsKey($email)) { throw "Missing demo account in credentials manifest: $email" }
}

$headers = @{
  apikey        = $env:SUPABASE_SERVICE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_KEY)"
}

# Local gates recreate the database but can leave Auth users behind with a per-run random password.
# Resolve the existing users once so this script can restore a known external manifest instead of
# failing with "email already exists". CI still takes the create branch on its empty stack.
$adminBase = "$($target.AbsoluteUri.TrimEnd('/'))/auth/v1/admin"
$listed = Invoke-RestMethod -Method Get -Uri "$adminBase/users?page=1&per_page=1000" -Headers $headers
$existingByEmail = @{}
foreach ($user in @($listed.users)) {
  $listedEmail = ([string]$user.email).Trim().ToLowerInvariant()
  if ($listedEmail) { $existingByEmail[$listedEmail] = [string]$user.id }
}

foreach ($account in $accounts) {
  $email = ([string]$account.email).Trim().ToLowerInvariant()
  $attributes = @{
    email = $email
    password = [string]$account.password
    email_confirm = $true
  }

  if ($existingByEmail.ContainsKey($email)) {
    $attributes["ban_duration"] = "none"
    $response = Invoke-RestMethod -Method Put -Uri "$adminBase/users/$($existingByEmail[$email])" `
      -Headers $headers -ContentType "application/json" -Body ($attributes | ConvertTo-Json -Compress)
    Write-Output "updated $email -> $($response.id)"
  }
  else {
    $response = Invoke-RestMethod -Method Post -Uri "$adminBase/users" `
      -Headers $headers -ContentType "application/json" -Body ($attributes | ConvertTo-Json -Compress)
    Write-Output "created $email -> $($response.id)"
  }
}
