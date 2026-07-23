# Full P4 quality gate. This script is intentionally destructive only to the isolated
# local Supabase project declared in supabase/config.toml. It never accepts a remote URL.
#
# Usage: npm.cmd run quality

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$userProfilePath = [Environment]::GetFolderPath("UserProfile")
$expectedProjectId = "supplyflow-p0"
$expectedApiUrl = "http://127.0.0.1:55431"
$dbContainer = "supabase_db_supplyflow-p0"
$previewPort = 5204
$previewProcess = $null
$previewStdout = $null
$previewStderr = $null
$priceFunctionProcess = $null
$priceFunctionStdout = $null
$priceFunctionStderr = $null
$priceFunctionEnvFile = $null
$manifestPath = $null
$artifactDirectory = $null
$gateSummaryPath = $null
$gateSummaryWritten = $false
$startedSupabase = $false
$localEnvironment = $null
$databaseWasUsed = $false

function Write-Gate([string]$Label) {
  Write-Output ""
  Write-Output "== $Label"
}

function Write-GateSummary([string]$Status, [string]$Scope, [string]$Reason) {
  if (-not $gateSummaryPath -or $script:gateSummaryWritten) { return }
  [ordered]@{
    status = $Status
    scope = $Scope
    reason = $Reason
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $gateSummaryPath -Encoding UTF8
  $script:gateSummaryWritten = $true
}

function Stop-WithInfrastructureBlock([string]$Reason, [string]$Message) {
  Write-GateSummary "BLOCKED" "infrastructure" $Reason
  throw $Message
}

function Assert-ExitCode([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Get-LocalSupabaseEnvironment([int]$Attempts = 1) {
  $required = @("API_URL", "ANON_KEY", "SERVICE_ROLE_KEY")
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $values = @{}
    $previousPreference = $ErrorActionPreference
    try {
      # Supabase reports intentionally disabled local services on stderr even when status
      # succeeds. PowerShell 5 turns that stream into a terminating NativeCommandError under
      # ErrorAction=Stop, so decide by the native exit code instead.
      $ErrorActionPreference = "Continue"
      $raw = @(& supabase status -o env 2>$null)
      $statusExitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($statusExitCode -eq 0) {
      foreach ($line in $raw) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') {
          $values[$Matches[1]] = $Matches[2].Trim('"')
        }
      }
      if ($values.ContainsKey("API_URL") -and $values.API_URL -ne $expectedApiUrl) {
        throw "Refusing non-test Supabase URL: $($values.API_URL)"
      }
      $missing = @($required | Where-Object { -not $values.ContainsKey($_) -or -not $values[$_] })
      if (-not $missing.Count) { return $values }
    }
    if ($attempt + 1 -lt $Attempts) { Start-Sleep -Milliseconds 250 }
  }
  return $null
}

function Wait-LocalApiReady([hashtable]$Environment) {
  $headers = @{
    apikey = [string]$Environment.SERVICE_ROLE_KEY
    Authorization = "Bearer $($Environment.SERVICE_ROLE_KEY)"
  }
  $authStatus = 0
  $restStatus = 0
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    try {
      $authStatus = (Invoke-WebRequest -UseBasicParsing -Uri "$expectedApiUrl/auth/v1/health" `
        -Headers $headers -TimeoutSec 2).StatusCode
    } catch { $authStatus = -1 }
    try {
      $restStatus = (Invoke-WebRequest -UseBasicParsing `
        -Uri "$expectedApiUrl/rest/v1/organizations?select=id&limit=0" `
        -Headers $headers -TimeoutSec 2).StatusCode
    } catch { $restStatus = -1 }
    if ($authStatus -eq 200 -and $restStatus -eq 200) { return }
    Start-Sleep -Milliseconds 250
  }
  Stop-WithInfrastructureBlock "local_api_not_ready" "Local API readiness failed after reset (Auth=$authStatus, PostgREST=$restStatus)."
}

function Wait-LocalStackReady {
  $environment = Get-LocalSupabaseEnvironment -Attempts 80
  if (-not $environment) {
    Stop-WithInfrastructureBlock "local_supabase_environment_not_ready" "Local Supabase environment did not become ready."
  }
  Wait-LocalApiReady $environment
  return $environment
}

function Reset-LocalDatabase {
  & supabase db reset
  Assert-ExitCode "Local Supabase reset"
  $script:localEnvironment = Wait-LocalStackReady
}

function Copy-SqlToDatabase([string]$RelativePath, [string]$ContainerPath) {
  $source = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing SQL test: $source" }
  & docker cp $source "${dbContainer}:$ContainerPath"
  Assert-ExitCode "Copying $RelativePath to the local database container"
}

function Invoke-SqlTest([string]$RelativePath, [string]$Label, [string]$DatabaseUser = "postgres") {
  $containerPath = "/var/lib/postgresql/p4-$([IO.Path]::GetFileName($RelativePath))"
  Copy-SqlToDatabase $RelativePath $containerPath
  Write-Gate $Label
  & docker exec -e PGPASSWORD=postgres $dbContainer psql -U $DatabaseUser -d postgres -v ON_ERROR_STOP=1 -f $containerPath
  Assert-ExitCode $Label
}

function Invoke-Preflight {
  $containerPath = "/var/lib/postgresql/p4-p1_preflight.sql"
  Copy-SqlToDatabase "supabase\tests\p1_preflight.sql" $containerPath
  Write-Gate "P1 preflight (20 anomaly checks)"
  $output = @(& docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -F "|" -U postgres -d postgres -v ON_ERROR_STOP=1 -f $containerPath)
  Assert-ExitCode "P1 preflight"
  $rows = @($output | Where-Object { $_ -match '^([^|]+)\|([0-9]+)\|' })
  if ($rows.Count -ne 20) { throw "P1 preflight returned $($rows.Count) result rows instead of 20." }
  $bad = @($rows | Where-Object { [int](($_ -split '\|')[1]) -ne 0 })
  $rows | ForEach-Object { Write-Output $_ }
  if ($bad.Count) { throw "P1 preflight found local fixture anomalies: $($bad -join '; ')" }
  Write-Output "P1 preflight passed: 20/20 checks returned rows_found=0."
}

function Assert-PowerShellSyntax {
  $syntaxErrors = @()
  foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1" -File) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    foreach ($error in @($errors)) { $syntaxErrors += "$($file.Name): $($error.Message)" }
  }
  if ($syntaxErrors.Count) { throw "PowerShell syntax errors: $($syntaxErrors -join '; ')" }
  Write-Output "PowerShell syntax passed for all scripts/*.ps1 files."
}

function New-DemoManifest([string]$Seed) {
  $roles = @("owner", "kitchen", "office", "payer", "accountant", "supplier")
  $accounts = foreach ($role in $roles) {
    [ordered]@{
      email = "$role@demo.supplyflow.local"
      password = "P4!$Seed-$role-Aa7"
    }
  }
  $path = Join-Path ([IO.Path]::GetTempPath()) "supplyflow-p4-$Seed.json"
  @{ accounts = @($accounts) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
  return $path
}

function Install-DemoFixture([string]$Seed) {
  $script:manifestPath = New-DemoManifest $Seed
  $previousServiceKey = [Environment]::GetEnvironmentVariable("SUPABASE_SERVICE_KEY", "Process")
  try {
    [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_KEY", [string]$localEnvironment.SERVICE_ROLE_KEY, "Process")
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "create-users.ps1") `
      -ProjectUrl $expectedApiUrl -CredentialsPath $script:manifestPath
    Assert-ExitCode "Creating isolated demo Auth users"
  }
  finally {
    [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_KEY", $previousServiceKey, "Process")
  }

  Invoke-SqlTest "supabase\demo\demo_seed.sql" "Load isolated browser fixture"

  $containerPath = "/var/lib/postgresql/p4-demo_verify.sql"
  Copy-SqlToDatabase "supabase\demo\demo_verify.sql" $containerPath
  Write-Gate "Verify isolated browser fixture"
  $verify = @(& docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -F "|" -U postgres -d postgres -v ON_ERROR_STOP=1 -f $containerPath)
  Assert-ExitCode "Demo fixture verification"
  $integrityRows = @($verify | Where-Object { $_ -match '^[BC]\.' })
  if (-not $integrityRows.Count) { throw "Demo verification returned no integrity rows." }
  $badRows = @($integrityRows | Where-Object { [int](($_ -split '\|')[-1]) -ne 0 })
  if ($badRows.Count) { throw "Demo fixture contains cross-tenant rows: $($badRows -join '; ')" }
  Write-Output "Demo fixture verification passed: $($integrityRows.Count) tenant-integrity checks returned 0."
}

function Find-ChromiumExecutable {
  $candidates = @(
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "Chrome or Edge is required for the browser gate; no installed executable was found."
}

function Find-PlaywrightCore {
  if ($env:PLAYWRIGHT_CORE_PATH -and (Test-Path -LiteralPath $env:PLAYWRIGHT_CORE_PATH)) {
    return (Resolve-Path -LiteralPath $env:PLAYWRIGHT_CORE_PATH).Path
  }
  $pnpmRoot = Join-Path $userProfilePath ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\.pnpm"
  if (Test-Path -LiteralPath $pnpmRoot) {
    $match = Get-ChildItem -LiteralPath $pnpmRoot -Directory -Filter "playwright-core@*" |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "node_modules\playwright-core" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($match) { return $match }
  }
  throw "The existing Playwright runtime was not found. No fallback test is reported as passed."
}

function Start-PreviewServer {
  $script:previewStdout = [IO.Path]::GetTempFileName()
  $script:previewStderr = [IO.Path]::GetTempFileName()
  $script:previewProcess = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @("node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "$previewPort", "--strictPort") `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $script:previewStdout -RedirectStandardError $script:previewStderr

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($script:previewProcess.HasExited) { break }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$previewPort/login" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) {
    $detail = (Get-Content -LiteralPath $script:previewStderr -Raw -ErrorAction SilentlyContinue).Trim()
    Stop-WithInfrastructureBlock "preview_not_ready" "Vite preview did not become ready on the isolated port $previewPort. $detail"
  }
}

function Stop-PriceListFunction {
  if ($script:priceFunctionProcess -and -not $script:priceFunctionProcess.HasExited) {
    Stop-Process -Id $script:priceFunctionProcess.Id -Force -ErrorAction SilentlyContinue
  }
  $script:priceFunctionProcess = $null
  foreach ($path in @($script:priceFunctionStdout, $script:priceFunctionStderr, $script:priceFunctionEnvFile)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  $script:priceFunctionStdout = $null
  $script:priceFunctionStderr = $null
  $script:priceFunctionEnvFile = $null
}

function Start-PriceListFunction([hashtable]$Environment) {
  $script:priceFunctionStdout = [IO.Path]::GetTempFileName()
  $script:priceFunctionStderr = [IO.Path]::GetTempFileName()
  $script:priceFunctionEnvFile = [IO.Path]::GetTempFileName()
  $envLines = @(
    "SUPABASE_URL=$($Environment.API_URL)",
    "SUPABASE_ANON_KEY=$($Environment.ANON_KEY)",
    "SUPABASE_SERVICE_ROLE_KEY=$($Environment.SERVICE_ROLE_KEY)",
    "APP_BASE_URL=http://127.0.0.1:5199"
  )
  [IO.File]::WriteAllLines($script:priceFunctionEnvFile, $envLines, (New-Object Text.UTF8Encoding($false)))
  $script:priceFunctionProcess = Start-Process -FilePath (Get-Command supabase).Source `
    -ArgumentList @("functions", "serve", "submit-price-list", "--no-verify-jwt", "--env-file", $script:priceFunctionEnvFile) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $script:priceFunctionStdout -RedirectStandardError $script:priceFunctionStderr

  $readyStatus = 0
  for ($attempt = 0; $attempt -lt 160; $attempt++) {
    if ($script:priceFunctionProcess.HasExited) { break }
    try {
      $readyStatus = (Invoke-WebRequest -UseBasicParsing `
        -Uri "$expectedApiUrl/functions/v1/submit-price-list" -Method Post `
        -ContentType "application/json" -Body "{}" -TimeoutSec 2).StatusCode
    }
    catch {
      $readyStatus = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 }
    }
    if ($readyStatus -eq 401) { return }
    Start-Sleep -Milliseconds 250
  }
  Stop-WithInfrastructureBlock "submit_price_list_not_ready" "Local submit-price-list readiness failed (status=$readyStatus)."
}

function Invoke-PriceListEdgeSmoke {
  $edgeEnvironment = @{
    P1B_API_URL = [string]$localEnvironment.API_URL
    P1B_ANON_KEY = [string]$localEnvironment.ANON_KEY
    P1B_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
  }
  $previousEdgeEnvironment = @{}
  foreach ($name in $edgeEnvironment.Keys) {
    $previousEdgeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    foreach ($name in $edgeEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, [string]$edgeEnvironment[$name], "Process")
    }
    Start-PriceListFunction $localEnvironment
    & node (Join-Path $PSScriptRoot "check-p1b-edge-smoke.cjs")
    Assert-ExitCode "P1B local Edge runtime smoke"
  }
  finally {
    foreach ($name in $edgeEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEdgeEnvironment[$name], "Process")
    }
    Stop-PriceListFunction
  }
}

$configPath = Join-Path $repoRoot "supabase\config.toml"
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
if ($config -notmatch "(?m)^project_id\s*=\s*`"$([regex]::Escape($expectedProjectId))`"\s*$") {
  throw "Refusing to run: supabase/config.toml is not the isolated $expectedProjectId project."
}

foreach ($command in @("node", "npm.cmd", "supabase", "docker", "powershell")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command not found: $command" }
}

$artifactDate = Get-Date -Format "yyyy\\MM\\dd"
$artifactStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$visualizationsRoot = if ($env:QUALITY_ARTIFACT_ROOT) {
  $env:QUALITY_ARTIFACT_ROOT
} else {
  Join-Path $userProfilePath ".codex\visualizations"
}
$artifactRoot = Join-Path $visualizationsRoot $artifactDate
$artifactDirectory = Join-Path $artifactRoot "$artifactStamp-p4-quality-gates"
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$gateSummaryPath = Join-Path $artifactDirectory "gate-summary.json"

try {
  $localEnvironment = Get-LocalSupabaseEnvironment
  if (-not $localEnvironment) {
    Write-Gate "Start isolated local Supabase"
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $startOutput = @(& supabase start 2>&1)
      $startExit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($startExit -ne 0) {
      Stop-WithInfrastructureBlock "local_supabase_start_failed" "Unable to start the isolated local Supabase stack."
    }
    $startedSupabase = $true
  }
  $localEnvironment = Wait-LocalStackReady
  $databaseWasUsed = $true

  Write-Gate "PowerShell syntax"
  Assert-PowerShellSyntax

  $previousUrl = [Environment]::GetEnvironmentVariable("VITE_SUPABASE_URL", "Process")
  $previousAnon = [Environment]::GetEnvironmentVariable("VITE_SUPABASE_ANON_KEY", "Process")
  try {
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_URL", [string]$localEnvironment.API_URL, "Process")
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_ANON_KEY", [string]$localEnvironment.ANON_KEY, "Process")

    Write-Gate "Build and existing pure checks"
    & npm.cmd run build
    Assert-ExitCode "npm run build"

    Write-Gate "Dependency audit"
    & npm.cmd audit --audit-level=high
    Assert-ExitCode "npm audit"

    Write-Gate "P0 tenant security, Storage and local Push"
    $previousPreference = $ErrorActionPreference
    try {
      # Child PowerShell forwards native Supabase progress on stderr. Preserve and inspect
      # the child's real exit code instead of letting PS 5 turn progress into an exception.
      $ErrorActionPreference = "Continue"
      $p0Output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check-p0-security.ps1") `
        -ResetLocalDatabase -KeepFixture -ServePushFunction 2>&1)
      $p0Exit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousPreference
    }
    $p0Output | ForEach-Object { Write-Output $_ }
    if ($p0Exit -ne 0) { throw "P0 security acceptance failed with exit code $p0Exit." }
    if ($p0Output -match '(?i)\bSKIP(?:PED)?\b') { throw "P0 security emitted a skipped test; the gate cannot report success." }

    Write-Gate "P0 upgrade path"
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $upgradeOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check-p0-upgrade.ps1") `
        -ResetUpgradeDatabase 2>&1)
      $upgradeExit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousPreference
    }
    $upgradeOutput | ForEach-Object { Write-Output $_ }
    if ($upgradeExit -ne 0) { throw "P0 upgrade path failed with exit code $upgradeExit." }
    $localEnvironment = Wait-LocalStackReady

    Invoke-SqlTest "supabase\tests\p0_client_dml_acl.sql" "P0 browser DML ACL and trusted-server CRUD"
    Invoke-SqlTest "supabase\tests\p4_purchase_order_status.sql" "P4 reasoned purchase-order status boundary"
    Invoke-Preflight
    Invoke-SqlTest "supabase\tests\p1_financial_commands.sql" "P1 financial commands, rollback and idempotency"
    Invoke-SqlTest "supabase\tests\p1_price_submissions.sql" "P1B trusted price-list intake, tenant isolation and rollback"
    Invoke-SqlTest "supabase\tests\p2_data_reliability.sql" "P2 retry, alerts, pagination and reliability"
    Invoke-SqlTest "supabase\tests\p1_price_submissions_concurrency.sql" "P1B real concurrent revisions and checksum retries" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p1_concurrency.sql" "P1 real concurrent sessions" "supabase_admin"

    Write-Gate "P1B local Edge runtime, 10/100/1,000 rows and failure recovery"
    Invoke-PriceListEdgeSmoke

    Write-Gate "Reset after committed concurrency fixtures"
    Reset-LocalDatabase

    $credentialSeed = [guid]::NewGuid().ToString("N")
    Install-DemoFixture $credentialSeed

    Write-Gate "P4 integrated supplier-to-credit journey"
    $journeyEnvironment = @{
      P4_API_URL = [string]$localEnvironment.API_URL
      P4_ANON_KEY = [string]$localEnvironment.ANON_KEY
      P4_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
      P4_PASSWORD_SEED = $credentialSeed
      P4_ARTIFACT_DIR = $artifactDirectory
    }
    $previousJourneyEnvironment = @{}
    try {
      foreach ($name in $journeyEnvironment.Keys) {
        $previousJourneyEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, [string]$journeyEnvironment[$name], "Process")
      }
      Start-PriceListFunction $localEnvironment
      & node (Join-Path $PSScriptRoot "check-p4-integrated-journey.cjs")
      Assert-ExitCode "P4 integrated journey"
    }
    finally {
      Stop-PriceListFunction
      foreach ($name in $journeyEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousJourneyEnvironment[$name], "Process")
      }
    }

    Write-Gate "Browser, keyboard, print/PDF and accessibility smoke"
    Start-PreviewServer

    $browserEnvironment = @{
      QUALITY_BASE_URL = "http://127.0.0.1:$previewPort"
      QUALITY_ARTIFACT_DIR = $artifactDirectory
      QUALITY_PASSWORD_SEED = $credentialSeed
      QUALITY_BROWSER_PATH = Find-ChromiumExecutable
      PLAYWRIGHT_CORE_PATH = Find-PlaywrightCore
    }
    $previousBrowserEnvironment = @{}
    try {
      foreach ($name in $browserEnvironment.Keys) {
        $previousBrowserEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, [string]$browserEnvironment[$name], "Process")
      }
      & node (Join-Path $PSScriptRoot "check-browser-smoke.cjs")
      Assert-ExitCode "Browser smoke"
    }
    finally {
      foreach ($name in $browserEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousBrowserEnvironment[$name], "Process")
      }
    }

    Write-Output ""
    Write-GateSummary "PASS" "quality" "all_gates_passed"
    Write-Output "P4 quality gates passed with no skipped tests."
    Write-Output "Browser evidence: $artifactDirectory"
  }
  finally {
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_URL", $previousUrl, "Process")
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_ANON_KEY", $previousAnon, "Process")
  }
}
catch {
  if (-not $gateSummaryWritten) {
    Write-GateSummary "FAIL" "product" "quality_gate_failed"
  }
  throw
}
finally {
  Stop-PriceListFunction
  if ($previewProcess -and -not $previewProcess.HasExited) {
    Stop-Process -Id $previewProcess.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($path in @($previewStdout, $previewStderr, $priceFunctionStdout, $priceFunctionStderr, $priceFunctionEnvFile, $manifestPath)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  if ($databaseWasUsed) {
    Write-Gate "Final isolated database reset"
    try { Reset-LocalDatabase }
    catch { Write-Warning "Final local database reset failed: $($_.Exception.Message)" }
  }
  if ($startedSupabase) {
    & supabase stop | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "The local Supabase stack could not be stopped." }
  }
}
