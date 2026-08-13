# Creates the active demo Auth users. Passwords come from an external per-user manifest and
# ACTIVE PRODUCT CONTRACT: only owner, office and accountant are created. Any legacy
# kitchen/payer/supplier identities are banned. Passwords are never printed and the manifest must
# live outside this repository.
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
$activeEmails = @(
  "owner@demo.supplyflow.local",
  "office@demo.supplyflow.local",
  "accountant@demo.supplyflow.local"
)
$retiredEmails = @(
  "kitchen@demo.supplyflow.local",
  "payer@demo.supplyflow.local",
  "supplier@demo.supplyflow.local"
)
$allowedEmails = $activeEmails

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
if ($accounts.Count -ne 3) {
  throw "Credentials manifest must contain exactly the three active demo accounts."
}

$seenEmails = @{}
$seenPasswords = @{}
foreach ($account in $accounts) {
  $email = ([string]$account.email).Trim().ToLowerInvariant()
  $password = [string]$account.password
  if ($allowedEmails -notcontains $email) { throw "Unexpected demo account in credentials manifest: $email" }
  if ($seenEmails.ContainsKey($email)) { throw "Duplicate demo account in credentials manifest: $email" }
  if ($password.Length -lt 16) { throw "Each demo password must contain at least 16 characters." }
  if ($seenPasswords.ContainsKey($password)) { throw "Every demo account must use a unique password." }
  $seenEmails[$email] = $true
  $seenPasswords[$password] = $true
}
foreach ($email in $activeEmails) {
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

foreach ($account in @($accounts | Where-Object { $activeEmails -contains ([string]$_.email).Trim().ToLowerInvariant() })) {
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

# Older local stacks may still carry kitchen/payer/supplier Auth users. Never recreate them; if
# they exist, block sign-in without changing the password or deleting the historical identity.
foreach ($email in $retiredEmails) {
  if (-not $existingByEmail.ContainsKey($email)) { continue }
  $attributes = @{ ban_duration = "876000h" }
  $response = Invoke-RestMethod -Method Put -Uri "$adminBase/users/$($existingByEmail[$email])" `
    -Headers $headers -ContentType "application/json" -Body ($attributes | ConvertTo-Json -Compress)
  Write-Output "retired $email -> $($response.id)"
}
