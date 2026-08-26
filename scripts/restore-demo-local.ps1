# Restores the local demo tenant after any `supabase db reset`. ASCII only (PS 5.1 reads
# no-BOM files as ANSI).
#
# WHY THIS EXISTS
# `supabase db reset` -- run by the quality gate, by scripts/ci-sql-suites.mjs without --list,
# and by hand -- drops the demo organization and its profiles. The gate additionally rewrites
# the three demo Auth passwords to a per-run random seed so its browser stage is isolated. Both
# are correct in isolation; together they leave the local stack with demo users nobody can sign
# in as. CLAUDE.md makes restoring them a duty of whoever ran the reset, and a duty that is
# performed by hand is a duty that gets skipped. This script is that duty, executable.
#
# It is idempotent: safe to run on a fresh reset, on an already-restored stack, and twice.
#
# Usage:
#   .\scripts\restore-demo-local.ps1                 # default manifest path
#   .\scripts\restore-demo-local.ps1 -ManifestPath "C:\secure\demo-users.json"
#   .\scripts\restore-demo-local.ps1 -Quiet          # no manifest / no stack -> exit 0, no throw
#
# Passwords are read from the external manifest at run time and are never printed.
param(
  [string]$ManifestPath,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$expectedApiUrl = "http://127.0.0.1:55431"
$dbContainer    = "supabase_db_supplyflow-p0"
$demoOrgId      = "11111111-1111-4111-8111-111111111111"
$activeRoles    = @("owner", "office", "accountant")
$repoRoot       = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Output ""; Write-Output "== $Message" }

# A missing manifest or a stopped stack is a normal state for CI and for a machine that never
# had a demo. Under -Quiet those exit cleanly so a caller can always invoke this; run by hand
# they are errors, because the user asked for a restore that cannot happen.
function Stop-Or-Skip([string]$Message) {
  if ($Quiet) { Write-Output "Demo restore skipped: $Message"; exit 0 }
  throw $Message
}

# ---------- 1. Manifest ----------------------------------------------------------------
if (-not $ManifestPath) { $ManifestPath = $env:INPLACE_DEMO_MANIFEST }
if (-not $ManifestPath) {
  $ManifestPath = Join-Path (Split-Path -Parent $repoRoot) "NIR-APP-DOCS\DEMO-USERS.local.json"
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
  Stop-Or-Skip "the demo manifest was not found at $ManifestPath"
}
$manifestFile = (Resolve-Path -LiteralPath $ManifestPath).Path

$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$byRole = @{}
foreach ($account in @($manifest.accounts)) {
  $email = ([string]$account.email).Trim().ToLowerInvariant()
  $role = ($email -split "@")[0]
  if ($activeRoles -contains $role) { $byRole[$role] = @{ Email = $email; Password = [string]$account.password } }
}
foreach ($role in $activeRoles) {
  if (-not $byRole.ContainsKey($role)) { throw "The manifest is missing the $role demo account." }
}

# ---------- 2. Local stack -------------------------------------------------------------
$previousPreference = $ErrorActionPreference
try {
  # Supabase reports disabled local services on stderr even on success; PS 5.1 turns that into
  # a terminating NativeCommandError under ErrorAction=Stop. Decide by the native exit code.
  $ErrorActionPreference = "Continue"
  $raw = @(& supabase status -o env 2>$null)
  $statusExit = $LASTEXITCODE
}
finally { $ErrorActionPreference = $previousPreference }

if ($statusExit -ne 0) { Stop-Or-Skip "the local Supabase stack is not running (run: supabase start)" }

$values = @{}
foreach ($line in $raw) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim('"') }
}
foreach ($name in @("API_URL", "ANON_KEY", "SERVICE_ROLE_KEY")) {
  if (-not $values.ContainsKey($name) -or -not $values[$name]) { throw "supabase status did not report $name." }
}
# The only guard that matters: this script writes Auth users and tenant rows, so it must never
# reach anything but the loopback stack.
if ($values.API_URL -ne $expectedApiUrl) {
  throw "Refusing to restore demo accounts against $($values.API_URL); only $expectedApiUrl is allowed."
}
$apiUrl = $values.API_URL

# ---------- 3. Auth users --------------------------------------------------------------
Write-Step "Restoring the demo Auth users from the external manifest"
$previousServiceKey = [Environment]::GetEnvironmentVariable("SUPABASE_SERVICE_KEY", "Process")
try {
  [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_KEY", [string]$values.SERVICE_ROLE_KEY, "Process")
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "create-users.ps1") `
    -ProjectUrl $apiUrl -CredentialsPath $manifestFile
  if ($LASTEXITCODE -ne 0) { throw "create-users.ps1 failed with exit code $LASTEXITCODE." }
}
finally { [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_KEY", $previousServiceKey, "Process") }

# ---------- 4. Demo tenant -------------------------------------------------------------
# demo_seed.sql refuses to run twice by design, so ask the database first instead of catching
# its exception -- a caught exception here would hide a real seed failure.
$orgCount = (& docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -U postgres -d postgres `
  -c "select count(*) from organizations where id = '$demoOrgId'")
if ($LASTEXITCODE -ne 0) { throw "Could not query the local database container $dbContainer." }

if ([int]$orgCount -eq 0) {
  Write-Step "Loading the demo tenant (supabase/demo/demo_seed.sql)"
  $source = Join-Path $repoRoot "supabase\demo\demo_seed.sql"
  $containerPath = "/var/lib/postgresql/restore-demo_seed.sql"
  & docker cp $source "${dbContainer}:$containerPath"
  if ($LASTEXITCODE -ne 0) { throw "docker cp of demo_seed.sql failed." }
  & docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -U postgres -d postgres -v ON_ERROR_STOP=1 -f $containerPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Loading demo_seed.sql failed." }
}
else {
  Write-Output "Demo tenant already present; left as it is."
}

# ---------- 5. Proof -------------------------------------------------------------------
# HTTP 200 on a page, or the sign-in buttons merely appearing, are not evidence. A real
# password grant and three profiles in the right role are.
Write-Step "Proving the restore"
$authHeaders = @{ apikey = [string]$values.ANON_KEY; Authorization = "Bearer $([string]$values.ANON_KEY)" }
foreach ($role in $activeRoles) {
  $account = $byRole[$role]
  $body = @{ email = $account.Email; password = $account.Password } | ConvertTo-Json -Compress
  try {
    $granted = Invoke-RestMethod -Method Post -Uri "$apiUrl/auth/v1/token?grant_type=password" `
      -Headers $authHeaders -ContentType "application/json" -Body $body
  }
  catch { throw "Password sign-in failed for $($account.Email): $($_.Exception.Message)" }
  if (-not $granted.access_token) { throw "Password sign-in returned no session for $($account.Email)." }
  Write-Output "  sign-in OK: $($account.Email)"
}

$profileRows = @(& docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -F "|" -U postgres -d postgres `
  -c "select p.role, count(*) from profiles p where p.org_id = '$demoOrgId' group by p.role order by p.role")
if ($LASTEXITCODE -ne 0) { throw "Could not read the demo profiles." }
$roleCounts = @{}
foreach ($row in $profileRows) {
  $parts = $row -split '\|'
  if ($parts.Count -eq 2) { $roleCounts[$parts[0]] = [int]$parts[1] }
}
foreach ($role in $activeRoles) {
  if (-not $roleCounts.ContainsKey($role) -or $roleCounts[$role] -lt 1) {
    throw "The demo organization has no active $role profile."
  }
  Write-Output "  profile OK: $role"
}

# ---------- 6. Quick-fill seed ---------------------------------------------------------
# The login screen's local quick-fill derives the password as P4!<seed>-<role>-Aa7 from
# VITE_DEMO_PASSWORD_SEED (src/pages/Login.tsx). If that seed and the manifest disagree, every
# check above still passes and the buttons still fail -- which is exactly how this looks from
# the outside. Compare, and never print either value.
$envLocalPath = Join-Path $repoRoot ".env.local"
if (Test-Path -LiteralPath $envLocalPath) {
  $seedLine = Select-String -LiteralPath $envLocalPath -Pattern '^VITE_DEMO_PASSWORD_SEED=(.*)$' | Select-Object -First 1
  if (-not $seedLine) {
    Write-Output "  note: .env.local has no VITE_DEMO_PASSWORD_SEED, so the login screen shows no quick-fill buttons."
  }
  else {
    $seed = $seedLine.Matches[0].Groups[1].Value.Trim().Trim('"')
    $mismatched = @($activeRoles | Where-Object { $byRole[$_].Password -ne "P4!$seed-$_-Aa7" })
    if ($mismatched.Count) {
      Write-Output "  WARNING: the quick-fill seed in .env.local does not match the manifest for: $($mismatched -join ', ')."
      Write-Output "  Sign-in works with the manifest password, but the one-click buttons will not."
      Write-Output "  Fix by aligning VITE_DEMO_PASSWORD_SEED with the manifest (or the manifest with it), then run this script again."
    }
    else {
      Write-Output "  quick-fill seed OK: the login buttons match the manifest."
    }
  }
}

Write-Output ""
Write-Output "Demo restore complete: 3 sign-ins proved, 3 profiles present."
