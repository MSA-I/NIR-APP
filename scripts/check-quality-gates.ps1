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
$restContainer = "supabase_rest_supplyflow-p0"
$kongContainer = "supabase_kong_supplyflow-p0"
$previewPort = $null
$previewProcess = $null
$previewStdout = $null
$previewStderr = $null
$manifestPath = $null
$artifactDirectory = $null
$gateSummaryPath = $null
$gateSummaryWritten = $false
$startedSupabase = $false
$supabaseWasRunning = $false
$localEnvironment = $null
$databaseWasUsed = $false
$functionsEnvPath = Join-Path $repoRoot "supabase\functions\.env"
$functionsEnvCreated = $false
$ocrWorkerToken = "quality-$([guid]::NewGuid().ToString('N'))"
$pushFunctionSecret = "quality-$([guid]::NewGuid().ToString('N'))"
$cleanupPhase = $false
$credentialSeed = $null
$ocrBrowserFixtureCleanupRequired = $false

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
  if ($script:cleanupPhase) { throw $Message }
  Write-GateSummary "BLOCKED" "infrastructure" $Reason
  throw $Message
}

function Assert-ExitCode([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Invoke-DependencyAudit {
  $allowedAdvisory = "https://github.com/advisories/GHSA-qwww-vcr4-c8h2"
  $allowedPackages = @("react-router", "react-router-dom")
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $raw = (& npm.cmd audit --audit-level=high --json 2>$null | Out-String)
    $auditExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($auditExit -eq 0) { return }

  try { $report = $raw | ConvertFrom-Json }
  catch { throw "npm audit failed and did not return valid JSON." }

  if (-not $report) {
    Stop-WithInfrastructureBlock "dependency_audit_unavailable" "npm audit returned no report."
  }
  $vulnerabilities = $report.PSObject.Properties["vulnerabilities"]
  if (-not $vulnerabilities) {
    Stop-WithInfrastructureBlock "dependency_audit_unavailable" "npm audit returned no vulnerability report."
  }
  $high = @($vulnerabilities.Value.PSObject.Properties | Where-Object {
    $_.Value.severity -in @("high", "critical")
  })
  $unexpectedPackages = @($high.Name | Where-Object { $_ -notin $allowedPackages })
  $advisories = @($high | ForEach-Object {
    @($_.Value.via) | Where-Object { $_ -isnot [string] } | ForEach-Object { $_.url }
  } | Sort-Object -Unique)
  $unexpectedAdvisories = @($advisories | Where-Object { $_ -ne $allowedAdvisory })
  $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8

  # This advisory is limited to React Router RSC Actions. SupplyFlow is a Vite SPA; fail this
  # exception closed if framework/RSC packages appear or if any other high finding is reported.
  if (-not $high.Count -or $unexpectedPackages.Count -or $unexpectedAdvisories.Count `
      -or $advisories.Count -ne 1 -or $packageJson -match '"@react-router/') {
    throw "npm audit reported an unapproved high/critical vulnerability."
  }
  Write-Output "npm audit: accepted GHSA-qwww-vcr4-c8h2 only; the RSC Actions runtime is not installed."
}

# Bounded by wall-clock, not by attempt count, for the same reason as Wait-LocalApiReady: a probe
# that fails instantly spends an "80 attempts" budget in seconds, and the containers take longer
# than that to report ready when the host is under disk or memory pressure. The default of a single
# attempt was worse still -- one shot straight after `supabase start`, with no wait at all.
function Get-LocalSupabaseEnvironment([int]$TimeoutSeconds = 0) {
  $required = @("API_URL", "ANON_KEY", "SERVICE_ROLE_KEY")
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
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
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Wait-LocalApiReady([hashtable]$Environment) {
  # The database container itself, before anything is asked of the API. On 2026-08-04 it sat in
  # Docker's "Created" state -- built and never started -- while PostgREST stayed up answering
  # PGRST002 "Could not query the database for the schema cache", and Kong turned that into 502s
  # that surfaced only as a stray console error deep inside the browser run. Measured either way:
  # with the container down every request fails, and with it healthy the same concurrent burst of
  # alert RPCs returned 360/360 OK. A dead database should stop the gate here, by name, not show
  # up later as one unexplained 502.
  # `docker inspect` on a container that does not exist yet -- the normal state in the seconds
  # between `supabase stop` and `supabase start` finishing -- writes "no such object" to stderr.
  # Under this script's `$ErrorActionPreference = "Stop"`, PowerShell 5.1 turns a native command's
  # stderr into a terminating NativeCommandError even with `2>$null`, so the wait aborted instead
  # of waiting. Same fix already used for `npm audit` in Invoke-DependencyAudit: drop to Continue
  # around the native call only, and decide on $LASTEXITCODE.
  $deadline = (Get-Date).AddSeconds(180)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    do {
      $state = (& docker inspect $dbContainer --format "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" 2>$null)
      if ($LASTEXITCODE -eq 0 -and $state -match '^running/(healthy|none)$') { break }
      if ((Get-Date) -ge $deadline) {
        Stop-WithInfrastructureBlock "local_database_not_running" "The local database container is '$state', not running and healthy. PostgREST cannot serve against it and every request would fail as 502/503."
      }
      Start-Sleep -Milliseconds 500
    } while ($true)
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }

  $headers = @{
    apikey = [string]$Environment.SERVICE_ROLE_KEY
    Authorization = "Bearer $($Environment.SERVICE_ROLE_KEY)"
  }
  $authStatus = 0
  $restStatus = 0
  # Bounded by wall-clock, not by attempt count. A refused connection fails instantly, so the old
  # "80 attempts" budget was spent in about twenty seconds -- less than GoTrue needs to come up
  # after a full db reset and container restart. That produced a recurring "Auth=-1, PostgREST=200"
  # failure that looked like a broken gate and was only ever a stopwatch that ran out too early.
  $deadline = (Get-Date).AddSeconds(180)
  do {
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
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Stop-WithInfrastructureBlock "local_api_not_ready" "Local API readiness failed after reset (Auth=$authStatus, PostgREST=$restStatus)."
}

function Wait-LocalStackReady {
  $environment = Get-LocalSupabaseEnvironment -TimeoutSeconds 180
  if (-not $environment) {
    Stop-WithInfrastructureBlock "local_supabase_environment_not_ready" "Local Supabase environment did not become ready."
  }
  Wait-LocalApiReady $environment
  return $environment
}

function Restart-LocalPostgrest {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & docker restart $restContainer | Out-Null
    $restartExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($restartExit -ne 0) {
    Stop-WithInfrastructureBlock "local_postgrest_restart_failed" "Unable to restart the isolated PostgREST service after database reset."
  }
}

function Restart-LocalKong {
  # `supabase db reset` also restarts the auth container, which comes back on a NEW address on
  # the Docker network. Kong caches the resolved upstream, so /auth/v1/* keeps answering 502 --
  # indefinitely, not transiently. Measured 2026-08-04: 90 seconds of polling stayed at auth=502
  # while `docker inspect` reported the auth container running AND healthy, and a wget to
  # http://supabase_auth_supplyflow-p0:9999/health from inside the Kong container returned 200
  # with GoTrue v2.193.1. Restarting Kong alone recovered it in about five seconds. Same class of
  # staleness as the PostgREST pool above, on the path that was never covered.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & docker restart $kongContainer | Out-Null
    $restartExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($restartExit -ne 0) {
    Stop-WithInfrastructureBlock "local_kong_restart_failed" "Unable to restart the isolated Kong gateway after database reset; /auth/v1 would stay 502."
  }
}

function Reset-LocalDatabase {
  & supabase db reset
  Assert-ExitCode "Local Supabase reset"
  # `supabase db reset` replaces PostgreSQL while keeping PostgREST alive. Recycle the
  # isolated REST process so its ten-connection pool cannot retain sessions from the old
  # database; a single sequential readiness request is not enough to exercise that pool.
  Restart-LocalPostgrest
  Restart-LocalKong
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
  & docker exec -e PGPASSWORD=postgres -e PGTZ=Asia/Jerusalem $dbContainer psql -U $DatabaseUser -d postgres -v ON_ERROR_STOP=1 -f $containerPath
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
  # The project's own devDependency, and the reason this gate no longer depends on a cache outside
  # the repository. On 2026-08-04 the machine ran out of disk, the OS reclaimed
  # ~/.cache/codex-runtimes, and the browser gate stopped being able to run at all -- through no
  # change to this repository. `playwright-core` (unlike `playwright`) downloads no browsers on
  # install; the gate launches the system Chrome or Edge that Find-BrowserExecutable locates.
  $projectCore = Join-Path $repoRoot "node_modules\playwright-core"
  if (Test-Path -LiteralPath $projectCore) { return $projectCore }

  # Kept as a fallback so a checkout whose dependencies are not installed still finds a runtime.
  $nodeModulesRoot = Join-Path $userProfilePath ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
  $direct = Join-Path $nodeModulesRoot "playwright-core"
  if (Test-Path -LiteralPath $direct) { return $direct }

  $pnpmRoot = Join-Path $nodeModulesRoot ".pnpm"
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

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Start-PreviewServer {
  $script:previewPort = Get-FreeTcpPort
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

function Get-HttpStatus(
  [string]$Uri,
  [hashtable]$Headers = @{},
  [string]$Body = "{}"
) {
  try {
    return (Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Post -Headers $Headers `
      -ContentType "application/json" -Body $Body -TimeoutSec 2).StatusCode
  }
  catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return -1
  }
}

function Wait-LocalEdgeReady {
  $documentStatus = 0
  $interpretStatus = 0
  $priceStatus = 0
  for ($attempt = 0; $attempt -lt 160; $attempt++) {
    $documentStatus = Get-HttpStatus "$expectedApiUrl/functions/v1/document-processing" `
      @{ "x-ocr-worker-token" = $ocrWorkerToken }
    $interpretStatus = Get-HttpStatus "$expectedApiUrl/functions/v1/interpret-document"
    $priceStatus = Get-HttpStatus "$expectedApiUrl/functions/v1/submit-price-list"
    if ($documentStatus -eq 400 -and $interpretStatus -eq 401 -and $priceStatus -eq 401) {
      Write-Output "Local Edge runtime ready: document-processing=400, interpret-document=401, submit-price-list=401."
      return
    }
    Start-Sleep -Milliseconds 250
  }
  Stop-WithInfrastructureBlock "local_edge_not_ready" `
    "Single local Edge runtime readiness failed (document=$documentStatus, interpret=$interpretStatus, price=$priceStatus)."
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function New-LocalVapidKeys {
  $ecdsa = New-Object System.Security.Cryptography.ECDsaCng 256
  try {
    $parameters = $ecdsa.ExportParameters($true)
    $publicBytes = New-Object byte[] 65
    $publicBytes[0] = 4
    [Array]::Copy($parameters.Q.X, 0, $publicBytes, 1, 32)
    [Array]::Copy($parameters.Q.Y, 0, $publicBytes, 33, 32)
    return [pscustomobject]@{
      PublicKey = ConvertTo-Base64Url $publicBytes
      PrivateKey = ConvertTo-Base64Url $parameters.D
    }
  }
  finally {
    $ecdsa.Dispose()
  }
}

# True only for a file this gate wrote itself: the mock provider key is a literal that exists
# nowhere else, and both secrets carry the per-run `quality-<guid>` shape minted at the top of this
# script. A developer's real .env cannot match all five markers.
function Test-AbandonedFunctionsEnvironment([string]$Path) {
  $values = @{}
  foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $separator = $line.IndexOf("=")
    if ($separator -gt 0) { $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
  }
  return ($values.Count -eq 7 -and
    $values["OPENAI_API_KEY"] -eq "local-provider-mock-not-sent" -and
    $values["APP_BASE_URL"] -eq "http://127.0.0.1:5199" -and
    $values["VAPID_SUBJECT"] -eq "mailto:quality-local@example.test" -and
    $values["OCR_WORKER_TOKEN"] -match '^quality-[0-9a-f]{32}$' -and
    $values["PUSH_FN_SECRET"] -match '^quality-[0-9a-f]{32}$')
}

function New-LocalFunctionsEnvironment {
  # The refusal below is correct -- this file may hold a developer's real secrets -- but it used to
  # be unconditional, and the cleanup that deletes it is gated on $functionsEnvCreated, which only
  # exists inside the run that set it. A run that died therefore left an orphan that blocked EVERY
  # future run permanently, reported as a bare throw and so classified FAIL/product rather than as
  # infrastructure. Observed twice on 2026-08-04. Recognise this gate's own leftover and clear it;
  # refuse anything else, and refuse it as an infrastructure block that says what to do.
  if (Test-Path -LiteralPath $functionsEnvPath) {
    if (Test-AbandonedFunctionsEnvironment $functionsEnvPath) {
      Write-Output "Removing an abandoned local Edge environment left by an interrupted quality run: $functionsEnvPath"
      Remove-Item -LiteralPath $functionsEnvPath -Force
    }
    else {
      Stop-WithInfrastructureBlock "local_edge_env_present" "A local Edge environment already exists and was not written by this gate: $functionsEnvPath. It may hold real secrets, so the gate will not overwrite it. Move it aside and re-run."
    }
  }
  $vapidKeys = New-LocalVapidKeys
  $lines = @(
    "OCR_WORKER_TOKEN=$ocrWorkerToken",
    "OPENAI_API_KEY=local-provider-mock-not-sent",
    "APP_BASE_URL=http://127.0.0.1:5199",
    "PUSH_FN_SECRET=$pushFunctionSecret",
    "VAPID_PUBLIC_KEY=$($vapidKeys.PublicKey)",
    "VAPID_PRIVATE_KEY=$($vapidKeys.PrivateKey)",
    "VAPID_SUBJECT=mailto:quality-local@example.test"
  )
  $script:functionsEnvCreated = $true
  [IO.File]::WriteAllLines($functionsEnvPath, $lines, (New-Object Text.UTF8Encoding($false)))
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
    & node (Join-Path $PSScriptRoot "check-p1b-edge-smoke.cjs")
    Assert-ExitCode "P1B local Edge runtime smoke"
  }
  finally {
    foreach ($name in $edgeEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEdgeEnvironment[$name], "Process")
    }
  }
}

function Invoke-OcrEdgeSmoke {
  $edgeEnvironment = @{
    OCR_ACCEPTANCE_API_URL = [string]$localEnvironment.API_URL
    OCR_ACCEPTANCE_ANON_KEY = [string]$localEnvironment.ANON_KEY
    OCR_ACCEPTANCE_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
    OCR_ACCEPTANCE_WORKER_TOKEN = $ocrWorkerToken
    SUPABASE_URL = [string]$localEnvironment.API_URL
    SUPABASE_ANON_KEY = [string]$localEnvironment.ANON_KEY
    SUPABASE_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
    OPENAI_API_KEY = "local-provider-mock-not-sent"
    APP_BASE_URL = "http://127.0.0.1:5199"
  }
  $previousEdgeEnvironment = @{}
  try {
    foreach ($name in $edgeEnvironment.Keys) {
      $previousEdgeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, [string]$edgeEnvironment[$name], "Process")
    }
    & npx.cmd --yes deno run `
      --config (Join-Path $repoRoot "supabase\functions\interpret-document\deno.json") `
      --allow-env --allow-net=127.0.0.1:55431 `
      (Join-Path $repoRoot "scripts\fixtures\ocr\edge-smoke.ts")
    Assert-ExitCode "OCR Edge and provider-mock integration"
  }
  finally {
    foreach ($name in $edgeEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEdgeEnvironment[$name], "Process")
    }
  }
}

function Invoke-InterpretDocumentContractTests {
  Write-Gate "Interpret-document prompt, provider-failure and authorization contracts"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $testOutput = @(& npx.cmd --yes deno test `
      --config (Join-Path $repoRoot "supabase\functions\interpret-document\deno.json") `
      (Join-Path $repoRoot "supabase\functions\interpret-document\core.test.ts") `
      (Join-Path $repoRoot "supabase\functions\interpret-document\authorization.test.ts") 2>&1)
    $testExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  $testOutput | ForEach-Object { Write-Output $_ }
  if ($testExit -ne 0) { throw "Interpret-document contract tests failed with exit code $testExit." }
  $testText = $testOutput -join "`n"
  if ($testText -notmatch '(?i)\b[1-9][0-9]*\s+passed\b') {
    throw "Interpret-document contract tests did not report any completed test."
  }
  if ($testText -match '(?i)\b[1-9][0-9]*\s+(?:ignored|skipped)\b') {
    throw "Interpret-document contract tests reported ignored or skipped cases."
  }
}

function Invoke-OcrWorkerSelfCheck {
  Write-Gate "OCR worker image and no-GPU/no-model self-check"
  & docker compose -f (Join-Path $repoRoot "docker-compose.ocr.yml") config --quiet
  Assert-ExitCode "OCR worker Compose validation"
  & docker build --pull=false -t supplyflow-ocr-worker:acceptance (Join-Path $repoRoot "worker\ocr")
  Assert-ExitCode "OCR worker image build"
  & docker run --rm --network none --entrypoint python `
    supplyflow-ocr-worker:acceptance /app/self_check.py
  Assert-ExitCode "OCR worker self-check"
}

function Install-OcrBrowserFixture([string]$Seed) {
  $fixtureEnvironment = @{
    OCR_ACCEPTANCE_API_URL = [string]$localEnvironment.API_URL
    OCR_ACCEPTANCE_ANON_KEY = [string]$localEnvironment.ANON_KEY
    OCR_ACCEPTANCE_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
    OCR_ACCEPTANCE_PASSWORD_SEED = $Seed
  }
  $previousFixtureEnvironment = @{}
  try {
    foreach ($name in $fixtureEnvironment.Keys) {
      $previousFixtureEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, [string]$fixtureEnvironment[$name], "Process")
    }
    $script:ocrBrowserFixtureCleanupRequired = $true
    & node (Join-Path $repoRoot "scripts\fixtures\ocr\prepare-browser-fixture.cjs")
    Assert-ExitCode "OCR browser Storage fixture"
  }
  finally {
    foreach ($name in $fixtureEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousFixtureEnvironment[$name], "Process")
    }
  }
  Invoke-SqlTest "scripts\fixtures\ocr\browser-fixture.sql" "OCR browser review, status and export fixture"
}

function Remove-OcrBrowserFixture([string]$Seed) {
  if (-not $localEnvironment -or -not $Seed) {
    throw "OCR browser fixture cleanup prerequisites are unavailable."
  }
  $fixtureEnvironment = @{
    OCR_ACCEPTANCE_API_URL = [string]$localEnvironment.API_URL
    OCR_ACCEPTANCE_ANON_KEY = [string]$localEnvironment.ANON_KEY
    OCR_ACCEPTANCE_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
    OCR_ACCEPTANCE_PASSWORD_SEED = $Seed
    OCR_ACCEPTANCE_FIXTURE_ACTION = "cleanup"
  }
  $previousFixtureEnvironment = @{}
  try {
    foreach ($name in $fixtureEnvironment.Keys) {
      $previousFixtureEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, [string]$fixtureEnvironment[$name], "Process")
    }
    & node (Join-Path $repoRoot "scripts\fixtures\ocr\prepare-browser-fixture.cjs")
    Assert-ExitCode "OCR browser Storage cleanup"
    $script:ocrBrowserFixtureCleanupRequired = $false
  }
  finally {
    foreach ($name in $fixtureEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousFixtureEnvironment[$name], "Process")
    }
  }
}

function Assert-OcrPrerequisites([string]$Config) {
  $requiredFiles = @(
    "supabase\migrations\0045_smart_document_processing.sql",
    "supabase\migrations\0046_document_learning.sql",
    "supabase\migrations\0047_document_export_templates.sql",
    "supabase\migrations\0048_ocr_price_submission_bridge.sql",
    "supabase\migrations\0049_document_review_mutations.sql",
    "supabase\migrations\0050_document_type_review_decisions.sql",
    "supabase\migrations\0051_document_kind_follows_review.sql",
    "supabase\migrations\0052_document_type_correction.sql",
    "supabase\tests\smart_document_processing.sql",
    "supabase\tests\document_learning.sql",
    "supabase\tests\document_export_templates.sql",
    "supabase\tests\p1_price_submissions.sql",
    "supabase\tests\p1_price_submissions_concurrency.sql",
    "supabase\functions\document-processing\index.ts",
    "supabase\functions\interpret-document\index.ts",
    "supabase\functions\interpret-document\core.test.ts",
    "supabase\functions\interpret-document\authorization.test.ts",
    "supabase\functions\submit-price-list\index.ts",
    "worker\ocr\Dockerfile",
    "worker\ocr\self_check.py",
    "docker-compose.ocr.yml",
    "scripts\fixtures\ocr\edge-smoke.ts",
    "scripts\fixtures\ocr\prepare-browser-fixture.cjs",
    "scripts\fixtures\ocr\browser-fixture.sql"
  )
  $missing = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_)) })
  if ($missing.Count) { throw "Missing OCR acceptance prerequisites: $($missing -join ', ')" }
  if ($Config -notmatch '(?ms)^\[edge_runtime\]\s+enabled\s*=\s*true\b') {
    throw "OCR acceptance requires the built-in local Edge runtime."
  }
  $functionJwt = @{
    "document-processing" = "false"
    "interpret-document" = "true"
    "submit-price-list" = "true"
    "send-push" = "false"
  }
  foreach ($functionName in $functionJwt.Keys) {
    $expectedJwt = $functionJwt[$functionName]
    $sectionPattern = "(?m)^\[functions\.$([regex]::Escape($functionName))\]\r?\nverify_jwt\s*=\s*$expectedJwt\s*$"
    if ($Config -notmatch $sectionPattern) {
      throw "Missing or unsafe local Edge config for $functionName (verify_jwt=$expectedJwt required)."
    }
  }
}

$configPath = Join-Path $repoRoot "supabase\config.toml"
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
if ($config -notmatch "(?m)^project_id\s*=\s*`"$([regex]::Escape($expectedProjectId))`"\s*$") {
  throw "Refusing to run: supabase/config.toml is not the isolated $expectedProjectId project."
}
Assert-OcrPrerequisites $config

foreach ($command in @("node", "npm.cmd", "npx.cmd", "supabase", "docker", "powershell")) {
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

$runError = $null
$cleanupErrors = @()
$repoLocationPushed = $false
Push-Location -LiteralPath $repoRoot
$repoLocationPushed = $true
try {
  $localEnvironment = Get-LocalSupabaseEnvironment -TimeoutSeconds 180
  $supabaseWasRunning = $null -ne $localEnvironment
  New-LocalFunctionsEnvironment
  if ($supabaseWasRunning) {
    Write-Gate "Restart isolated local Supabase for the configured Edge runtime"
    & supabase stop | Out-Null
    Assert-ExitCode "Stopping the pre-existing isolated Supabase stack"
  }
  Write-Gate "Start isolated local Supabase with one built-in Edge runtime"
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
  $localEnvironment = Wait-LocalStackReady
  Wait-LocalEdgeReady
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
    Invoke-DependencyAudit

    Invoke-InterpretDocumentContractTests
    Invoke-OcrWorkerSelfCheck

    Write-Gate "P0 tenant security, Storage and local Push"
    $previousPreference = $ErrorActionPreference
    try {
      # Child PowerShell forwards native Supabase progress on stderr. Preserve and inspect
      # the child's real exit code instead of letting PS 5 turn progress into an exception.
      $ErrorActionPreference = "Continue"
      $p0Output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check-p0-security.ps1") `
        -ResetLocalDatabase -KeepFixture -PushSecret $pushFunctionSecret 2>&1)
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
    # check-p0-upgrade.ps1 runs `supabase db reset` in a CHILD process, so this path needs the same
    # two recycles Reset-LocalDatabase performs -- not just PostgREST. The reset restarts the auth
    # container onto a new Docker address while Kong keeps the cached upstream, and the observed
    # signature here was exactly `Auth=-1, PostgREST=200`: REST recycled, auth unreachable. Wave 0
    # diagnosed and fixed this class at Reset-LocalDatabase and missed this second reset path.
    Restart-LocalPostgrest
    Restart-LocalKong
    $localEnvironment = Wait-LocalStackReady

    Invoke-SqlTest "supabase\tests\p0_client_dml_acl.sql" "P0 browser DML ACL and trusted-server CRUD"
    Invoke-SqlTest "supabase\tests\smart_document_processing.sql" "Document queue, tenant boundary, lease fencing and extraction ledger" "supabase_admin"
    Write-Gate "Reset after committed OCR queue fixtures"
    Reset-LocalDatabase
    Invoke-SqlTest "supabase\tests\document_learning.sql" "Document interpretation, learning and review mutations"
    Invoke-SqlTest "supabase\tests\document_export_templates.sql" "Document export scope, approval, precedence and immutable ledger"
    Invoke-SqlTest "supabase\tests\p4_purchase_order_status.sql" "P4 reasoned purchase-order status boundary"
    Invoke-SqlTest "supabase\tests\live_schema_alignment.sql" "Production/remediation schema alignment"
    Invoke-Preflight
    Invoke-SqlTest "supabase\tests\p1_financial_commands.sql" "P1 financial commands, rollback and idempotency"
    Invoke-SqlTest "supabase\tests\p1_price_submissions.sql" "P1B trusted price-list intake, tenant isolation and rollback"
    Invoke-SqlTest "supabase\tests\p2_data_reliability.sql" "P2 retry, alerts, pagination and reliability"
    Invoke-SqlTest "supabase\tests\server_list_contracts.sql" "Server list predicates, duplicate key across pages and tenant scope"
    Invoke-SqlTest "supabase\tests\p1_price_submissions_concurrency.sql" "P1B real concurrent revisions and checksum retries" "supabase_admin"
    Invoke-SqlTest "supabase\tests\roadmap_db_contracts.sql" "Roadmap supplier, inventory, savings and WhatsApp contracts"
    Invoke-SqlTest "supabase\tests\p1_concurrency.sql" "P1 real concurrent sessions" "supabase_admin"

    Write-Gate "P1B local Edge runtime, 10/100/1,000 rows and failure recovery"
    Invoke-PriceListEdgeSmoke

    Write-Gate "Reset after P1B Edge and committed concurrency fixtures"
    Reset-LocalDatabase

    Write-Gate "OCR document-processing HTTP, interpretation handler with provider mock, and single-writer confirm"
    Invoke-OcrEdgeSmoke

    Write-Gate "Reset after OCR Edge fixtures"
    Reset-LocalDatabase

    $credentialSeed = [guid]::NewGuid().ToString("N")
    Install-DemoFixture $credentialSeed
    Install-OcrBrowserFixture $credentialSeed

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
      & node (Join-Path $PSScriptRoot "check-p4-integrated-journey.cjs")
      Assert-ExitCode "P4 integrated journey"
    }
    finally {
      foreach ($name in $journeyEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousJourneyEnvironment[$name], "Process")
      }
    }

    Write-Gate "Browser, keyboard, print/PDF and accessibility smoke"
    Start-PreviewServer

    $browserEnvironment = @{
      QUALITY_BASE_URL = "http://127.0.0.1:$previewPort"
      QUALITY_API_URL = [string]$localEnvironment.API_URL
      QUALITY_SERVICE_ROLE_KEY = [string]$localEnvironment.SERVICE_ROLE_KEY
      QUALITY_ARTIFACT_DIR = $artifactDirectory
      QUALITY_PASSWORD_SEED = $credentialSeed
      QUALITY_BROWSER_PATH = Find-ChromiumExecutable
      PLAYWRIGHT_CORE_PATH = Find-PlaywrightCore
      QUALITY_REQUIRE_ALL = "1"
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

  }
  finally {
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_URL", $previousUrl, "Process")
    [Environment]::SetEnvironmentVariable("VITE_SUPABASE_ANON_KEY", $previousAnon, "Process")
  }
}
catch {
  $runError = $_
  if (-not $gateSummaryWritten) {
    Write-GateSummary "FAIL" "product" "quality_gate_failed"
  }
}
finally {
  $script:cleanupPhase = $true
  try {
    if ($previewProcess -and -not $previewProcess.HasExited) {
      Stop-Process -Id $previewProcess.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($path in @($previewStdout, $previewStderr, $manifestPath)) {
      if ($path -and (Test-Path -LiteralPath $path)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
    if ($ocrBrowserFixtureCleanupRequired) {
      Write-Gate "Remove and verify OCR browser Storage fixtures"
      try { Remove-OcrBrowserFixture $credentialSeed }
      catch { $cleanupErrors += "OCR browser Storage cleanup failed: $($_.Exception.Message)" }
    }
    if ($databaseWasUsed) {
      Write-Gate "Final isolated database reset"
      try { Reset-LocalDatabase }
      catch { $cleanupErrors += "Final local database reset failed: $($_.Exception.Message)" }
    }
    if ($startedSupabase) {
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        & supabase stop | Out-Null
        $stopExit = $LASTEXITCODE
        if ($stopExit -ne 0) { throw "The local Supabase stack could not be stopped (exit $stopExit)." }
      }
      catch { $cleanupErrors += $_.Exception.Message }
      finally { $ErrorActionPreference = $previousPreference }
    }
    if ($functionsEnvCreated) {
      try {
        if (Test-Path -LiteralPath $functionsEnvPath) {
          Remove-Item -LiteralPath $functionsEnvPath -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $functionsEnvPath) {
          throw "The file still exists after deletion."
        }
      }
      catch { $cleanupErrors += "The temporary local Edge environment could not be removed: $($_.Exception.Message)" }
    }
    if ($supabaseWasRunning) {
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        & supabase start | Out-Null
        $restoreExit = $LASTEXITCODE
        if ($restoreExit -ne 0) { throw "The pre-existing local Supabase stack could not be restored (exit $restoreExit)." }
      }
      catch { $cleanupErrors += $_.Exception.Message }
      finally { $ErrorActionPreference = $previousPreference }
    }
  }
  finally {
    if ($repoLocationPushed) {
      Pop-Location
      $repoLocationPushed = $false
    }
  }
}

if ($runError) {
  if ($cleanupErrors.Count) {
    Write-Warning "Quality cleanup also failed: $($cleanupErrors -join '; ')"
  }
  throw $runError
}
if ($cleanupErrors.Count) {
  Write-GateSummary "FAIL" "cleanup" "quality_cleanup_failed"
  throw "Quality cleanup failed: $($cleanupErrors -join '; ')"
}

Write-Output ""
Write-GateSummary "PASS" "quality" "all_gates_passed"
Write-Output "P4 quality gates passed with no skipped tests."
Write-Output "Browser evidence: $artifactDirectory"
