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
$qaMutexName = "Local\SupplyFlow-supplyflow-p0-qa"
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
$interpretCronSecret = "quality-$([guid]::NewGuid().ToString('N'))"
$supplierPortalRateLimitPepper = "quality-$([guid]::NewGuid().ToString('N'))"
$cleanupPhase = $false
$credentialSeed = $null
$ocrBrowserFixtureCleanupRequired = $false
# Every stage that runs through Invoke-GateStage records its wall time here. Without it a
# twenty-minute run leaves no evidence of WHERE the twenty minutes went, so every attempt to
# make the gate faster is a guess.
$stageTimings = @()

# ===== This gate runs on CI now. Local runs are opt-in. =====
# Between 23.07 and 09.08.2026 this script ran 415 times on the owner's machine and took 24.0
# hours of it. 160 of those runs died without writing one artifact and only 80 reached PASS —
# the losses were almost entirely environmental (a bound port, the dev server holding a DB
# connection into a deadlock, a second agent holding the QA mutex), none of which can happen
# on a runner that starts empty. `.github/workflows/quality-gate.yml` does this work now.
#
# The refusal is deliberately at the very top: it must cost milliseconds, not the four minutes
# a doomed run used to burn before anyone learned it was doomed.
if (-not $env:CI -and -not $env:SUPPLYFLOW_ALLOW_LOCAL_QUALITY) {
  # A LITERAL here-string (@'...'@). The message contains $env: and command names, and an
  # expandable @"..."@ ate them: the backtick in `npm became an escape and printed "pm".
  # Written straight to stderr rather than through Write-Error, because under
  # $ErrorActionPreference = "Stop" a Write-Error terminates the script with exit 1 and never
  # reaches the `exit 3` that tells "refused" apart from "ran and failed".
  [Console]::Error.WriteLine(@'

The heavy quality gate runs on CI, not on this machine.

  Open a PR, push to main, or trigger it directly:
      gh workflow run quality-gate.yml
      gh run watch

  Evidence (screenshots, the PDF and the browser report) is uploaded as the
  "browser-evidence" artifact on the browser job.

If you genuinely need a local run -- debugging a failure CI already reported, or working on
this script itself -- opt in explicitly for that one command:

      $env:SUPPLYFLOW_ALLOW_LOCAL_QUALITY = '1'; npm run quality

Before you do: stop "npm run dev" (it holds port 5199 and a writing DB connection) and make
sure no other agent is mid-run, or this will fail on infrastructure rather than on the code.

'@)
  exit 3
}

function Enter-QaMutex {
  $mutex = [System.Threading.Mutex]::new($false, $qaMutexName)
  try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "The shared InPlace QA/quality mutex is held by another process." }
    return $mutex
  }
  catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-QaMutex([System.Threading.Mutex]$Mutex) {
  if (-not $Mutex) { return }
  $Mutex.ReleaseMutex()
  $Mutex.Dispose()
}

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

# ===== Failure classification (wave 10, 10-FINAL-AUDIT Finding 2) =====
# Wave 3 taught the two CHILD script sites to speak ##GATE-INFRA## (:833-836, :855-858).
# Every stage that runs in THIS process still threw a bare string into the catch-all at the
# bottom of the file, which stamps FAIL/product unconditionally. That is how wave 5's libuv
# teardown crash -- a build that SUCCEEDED, whose Node process then died on exit -- was
# recorded as a product regression, and how a Docker hiccup during `docker cp` reads the
# same as a broken invoice command. In a repo with no CI and a ~40-minute manual run, a gate
# whose worst infrastructure day is indistinguishable from a real regression trains its only
# operator to discount FAIL.
#
# The list is deliberately short and literal: only signatures a PRODUCT defect cannot
# produce. A failed SQL assertion, a failed Deno contract, a failed browser scenario, a tsc
# error and a real npm audit finding all match nothing here and stay FAIL/product -- that is
# the entire point. Adding a signature is a decision to stop trusting a class of failure;
# keep it rare and keep it specific.
$script:infrastructureSignatures = @(
  @{ Reason = "node_libuv_teardown_crash";
     Pattern = 'Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)' },
  @{ Reason = "docker_container_run_failed";
     # `Container <id> is not running` is anchored on the daemon's exact wording: a bare
     # "is not running" also appears inside the daemon-unavailable message below, and the
     # first match wins, so the loose form would mislabel a dead daemon as a dead container.
     Pattern = 'error running container|OCI runtime create failed|failed to create task for container|Container \S+ is not running' },
  @{ Reason = "docker_daemon_unavailable";
     Pattern = 'Cannot connect to the Docker daemon|error during connect:|docker daemon is not running|Is the docker daemon running' },
  @{ Reason = "docker_stream_truncated";
     Pattern = 'unexpected EOF' },
  @{ Reason = "chromium_launch_failed";
     Pattern = 'Failed to launch the browser process|browserType\.launch:' }
)

function Get-InfrastructureFailureReason($Output) {
  if ($null -eq $Output) { return $null }
  $text = (@($Output) | ForEach-Object { "$_" }) -join "`n"
  if (-not $text) { return $null }
  foreach ($signature in $script:infrastructureSignatures) {
    if ($text -match $signature.Pattern) { return $signature.Reason }
  }
  return $null
}

# $Output, when the caller captured it, is scanned for the signatures above.
# $InfrastructureReason names a stage whose non-zero exit is environmental BY CONSTRUCTION --
# `docker cp` moves a file that was already verified to exist: no product code runs inside
# it, so there is no product regression it could be reporting.
# $ExitCode lets a caller that captured output pass the real code explicitly instead of
# depending on $LASTEXITCODE surviving the intervening pipeline.
function Assert-ExitCode {
  param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Label,
    [Parameter(Position = 1)]$Output = $null,
    [string]$InfrastructureReason = "",
    [Nullable[int]]$ExitCode = $null
  )
  $exit = if ($null -ne $ExitCode) { [int]$ExitCode } else { $LASTEXITCODE }
  if ($exit -eq 0) { return }
  if ($InfrastructureReason) {
    Stop-WithInfrastructureBlock $InfrastructureReason "$Label failed with exit code $exit. That stage runs no product code, so this is local infrastructure, not a regression."
  }
  $detected = Get-InfrastructureFailureReason $Output
  if ($detected) {
    Stop-WithInfrastructureBlock $detected "$Label failed with exit code $exit on a known-environmental signature ($detected), not on a product regression."
  }
  throw "$Label failed with exit code $exit."
}

# Runs one native stage, streaming its combined output to the console AS PLAIN TEXT while
# collecting it for classification, then asserts the exit code through Assert-ExitCode.
#
# Why the stringify-in-pipeline shape rather than `@(& cmd 2>&1)`: at
# $ErrorActionPreference = "Continue" (mandatory here -- under "Stop" PS 5.1 turns a native
# command's stderr into a terminating NativeCommandError even with 2>$null, AGENT-BRIEF §1)
# a captured stderr line arrives as an ErrorRecord, and re-emitting it renders a multi-line
# red block. psql NOTICEs, `supabase db reset` progress and `deno test` all write ordinary
# progress to stderr, so that would make the gate's own output unreadable. Stringifying
# inside the pipeline keeps the lines plain AND keeps them live -- a captured-then-replayed
# stage would go silent for minutes on the longest steps.
function Invoke-GateStage {
  param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Label,
    [Parameter(Mandatory = $true, Position = 1)][scriptblock]$Command,
    [string]$InfrastructureReason = ""
  )
  $collected = New-Object System.Collections.ArrayList
  $stageExit = 0
  $previousPreference = $ErrorActionPreference
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $ErrorActionPreference = "Continue"
    & $Command 2>&1 | ForEach-Object {
      $text = "$_"
      [void]$collected.Add($text)
      Write-Output $text
    }
    $stageExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
    # Recorded in `finally` so a failing stage still reports the time it burned before failing.
    $stopwatch.Stop()
    $seconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    $script:stageTimings += [pscustomobject]@{ Label = $Label; Seconds = $seconds }
    # The per-stage line is for the human watching a long run. The ~30 `docker cp` stages take
    # well under a second each and would bury it, so only stages worth optimising announce.
    if ($seconds -ge 5) { Write-Output ("-- $Label took {0:F1}s" -f $seconds) }
  }
  Assert-ExitCode $Label $collected.ToArray() -ExitCode $stageExit -InfrastructureReason $InfrastructureReason
}

# Printed from the outermost `finally`, so a run that fails halfway still shows what it spent
# getting there.
function Write-StageTimings {
  if (-not $script:stageTimings.Count) { return }
  $total = ($script:stageTimings | Measure-Object -Property Seconds -Sum).Sum
  # A run that fails before any stage takes a measurable second must not die dividing by zero
  # inside the cleanup path and hide the real failure. The guard belongs to the share
  # arithmetic only -- the printed total stays the measured one, or this table would report a
  # second that nothing spent.
  $divisor = if ($total -gt 0) { $total } else { 1 }
  Write-Output ""
  Write-Output "== Stage timings (slowest first)"
  foreach ($stage in ($script:stageTimings | Sort-Object Seconds -Descending)) {
    Write-Output ("{0,8:F1}s {1,6:P1}  {2}" -f $stage.Seconds, ($stage.Seconds / $divisor), $stage.Label)
  }
  Write-Output ("{0,8:F1}s         TOTAL measured across {1} stages" -f $total, $script:stageTimings.Count)
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

  # This advisory is limited to React Router RSC Actions. InPlace is a Vite SPA; fail this
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
  # Disable keep-alive because Windows PowerShell can retain Kong connections across replacement.
  $deadline = (Get-Date).AddSeconds(180)
  do {
    try {
      $authStatus = (Invoke-WebRequest -UseBasicParsing -DisableKeepAlive `
        -Uri "$expectedApiUrl/auth/v1/health" -Headers $headers -TimeoutSec 2).StatusCode
    } catch { $authStatus = -1 }
    try {
      $restStatus = (Invoke-WebRequest -UseBasicParsing -DisableKeepAlive `
        -Uri "$expectedApiUrl/rest/v1/" `
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
  # Classified, not blanket-infrastructure: a reset that fails because a MIGRATION fails is a
  # product regression and must stay FAIL/product. Only the Docker-level signatures divert.
  Invoke-GateStage "Local Supabase reset" { supabase db reset }
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
  # The file was just verified to exist and `docker cp` runs no product code, so every way
  # this can fail is environmental -- a stopped container, a dead daemon, a full disk.
  Invoke-GateStage "Copying $RelativePath to the local database container" `
    { docker cp $source "${dbContainer}:$ContainerPath" } `
    -InfrastructureReason "docker_cp_failed"
}

function Invoke-SqlTest([string]$RelativePath, [string]$Label, [string]$DatabaseUser = "postgres") {
  $containerPath = "/var/lib/postgresql/p4-$([IO.Path]::GetFileName($RelativePath))"
  Copy-SqlToDatabase $RelativePath $containerPath
  Write-Gate $Label
  # Classified, never blanket-infrastructure: a failed SQL assertion is THE product signal of
  # this gate and must always reach FAIL/product. Only a container that died between the
  # `docker cp` above and this exec matches a signature and diverts.
  Invoke-GateStage $Label {
    docker exec -e PGPASSWORD=postgres -e PGTZ=Asia/Jerusalem $dbContainer `
      psql -U $DatabaseUser -d postgres -v ON_ERROR_STOP=1 -f $containerPath
  }
}

function Invoke-Preflight {
  $containerPath = "/var/lib/postgresql/p4-p1_preflight.sql"
  Copy-SqlToDatabase "supabase\tests\p1_preflight.sql" $containerPath
  Write-Gate "P1 preflight (46 anomaly checks)"
  # Kept as a plain capture (the rows are parsed, not streamed), but the classification
  # material is now handed to Assert-ExitCode instead of falling to the catch-all.
  $output = @(& docker exec -e PGPASSWORD=postgres $dbContainer psql -qAt -F "|" -U postgres -d postgres -v ON_ERROR_STOP=1 -f $containerPath)
  Assert-ExitCode "P1 preflight" $output
  $rows = @($output | Where-Object { $_ -match '^([^|]+)\|([0-9]+)\|' })
  if ($rows.Count -ne 46) { throw "P1 preflight returned $($rows.Count) result rows instead of 46." }
  $bad = @($rows | Where-Object { [int](($_ -split '\|')[1]) -ne 0 })
  $rows | ForEach-Object { Write-Output $_ }
  if ($bad.Count) { throw "P1 preflight found local fixture anomalies: $($bad -join '; ')" }
  Write-Output "P1 preflight passed: 46/46 checks returned rows_found=0."
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
  $roles = @("owner", "office", "accountant")
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

function Get-QualityPreviewPort {
  # The real recovery link must exactly match the local Auth allow-list. Refuse an occupied
  # canonical port instead of silently testing a redirect GoTrue will replace with site_url.
  $port = 5199
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try {
    $listener.Start()
  }
  catch {
    Stop-WithInfrastructureBlock "preview_port_unavailable" "The allow-listed quality preview port 5199 is already in use."
  }
  finally {
    $listener.Stop()
  }
  return $port
}

function Start-PreviewServer {
  $script:previewPort = Get-QualityPreviewPort
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
# nowhere else, and every generated secret carries the per-run `quality-<guid>` shape minted at
# the top of this script. A developer's real .env cannot match every marker.
function Test-AbandonedFunctionsEnvironment([string]$Path) {
  $values = @{}
  foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $separator = $line.IndexOf("=")
    if ($separator -gt 0) { $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
  }
  return ($values.Count -eq 9 -and
    $values["OPENAI_API_KEY"] -eq "local-provider-mock-not-sent" -and
    $values["APP_BASE_URL"] -eq "http://127.0.0.1:5199" -and
    $values["VAPID_SUBJECT"] -eq "mailto:quality-local@example.test" -and
    $values["OCR_WORKER_TOKEN"] -match '^quality-[0-9a-f]{32}$' -and
    $values["INTERPRET_DOCUMENT_CRON_SECRET"] -match '^quality-[0-9a-f]{32}$' -and
    $values["SUPPLIER_PORTAL_RATE_LIMIT_PEPPER"] -match '^quality-[0-9a-f]{32}$' -and
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
    "INTERPRET_DOCUMENT_CRON_SECRET=$interpretCronSecret",
    "OPENAI_API_KEY=local-provider-mock-not-sent",
    "APP_BASE_URL=http://127.0.0.1:5199",
    "SUPPLIER_PORTAL_RATE_LIMIT_PEPPER=$supplierPortalRateLimitPepper",
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
    Invoke-GateStage "P1B local Edge runtime smoke" {
      node (Join-Path $PSScriptRoot "check-p1b-edge-smoke.cjs")
    }
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
    Invoke-GateStage "OCR Edge and provider-mock integration" {
      npx.cmd --yes deno run `
        --config (Join-Path $repoRoot "supabase\functions\interpret-document\deno.json") `
        --allow-env --allow-net=127.0.0.1:55431 `
        (Join-Path $repoRoot "scripts\fixtures\ocr\edge-smoke.ts")
    }
  }
  finally {
    foreach ($name in $edgeEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEdgeEnvironment[$name], "Process")
    }
  }
}

function Invoke-InterpretDocumentContractTests {
  Write-Gate "Document automation and branding upload security contracts"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $testOutput = @(& npx.cmd --yes deno test `
      --config (Join-Path $repoRoot "supabase\functions\interpret-document\deno.json") `
      --allow-read=$repoRoot `
      (Join-Path $repoRoot "supabase\functions\interpret-document\core.test.ts") `
      (Join-Path $repoRoot "supabase\functions\interpret-document\split.test.ts") `
      (Join-Path $repoRoot "supabase\functions\interpret-document\authorization.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\organization-access.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\organization-egress.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\reserved-egress.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\billing-adapter.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\provision.test.ts") `
      (Join-Path $repoRoot "supabase\functions\_shared\edge-organization-access-wiring.test.ts") `
      (Join-Path $repoRoot "supabase\functions\document-processing\contract_test.ts") `
      (Join-Path $repoRoot "supabase\functions\document-preprocessing\contract_test.ts") `
      (Join-Path $repoRoot "supabase\functions\upload-organization-logo\core.test.ts") 2>&1)
    $testExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  $testOutput | ForEach-Object { Write-Output $_ }
  Assert-ExitCode "Interpret-document contract tests" $testOutput -ExitCode $testExit
  $testText = $testOutput -join "`n"
  if ($testText -notmatch '(?i)\b[1-9][0-9]*\s+passed\b') {
    throw "Interpret-document contract tests did not report any completed test."
  }
  if ($testText -match '(?i)\b[1-9][0-9]*\s+(?:ignored|skipped)\b') {
    throw "Interpret-document contract tests reported ignored or skipped cases."
  }
  $recoveryFunctionRoot = Join-Path $repoRoot "supabase\functions\recover-document-processing"
  $recoveryLock = Join-Path $recoveryFunctionRoot "deno.lock"
  try {
    $ErrorActionPreference = "Continue"
    $recoveryTestOutput = @(& npx.cmd --yes deno test `
      --config (Join-Path $recoveryFunctionRoot "deno.json") `
      --lock $recoveryLock `
      --frozen `
      --allow-read=$recoveryFunctionRoot `
      (Join-Path $recoveryFunctionRoot "contract_test.ts") 2>&1)
    $recoveryTestExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  $recoveryTestOutput | ForEach-Object { Write-Output $_ }
  Assert-ExitCode "Document-processing recovery contract tests" $recoveryTestOutput -ExitCode $recoveryTestExit
  $recoveryTestText = $recoveryTestOutput -join "`n"
  if ($recoveryTestText -notmatch '(?i)\b[1-9][0-9]*\s+passed\b') {
    throw "Document-processing recovery tests did not report any completed test."
  }
  if ($recoveryTestText -match '(?i)\b[1-9][0-9]*\s+(?:ignored|skipped)\b') {
    throw "Document-processing recovery tests reported ignored or skipped cases."
  }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\upload-organization-logo\deno.json") `
    (Join-Path $repoRoot "supabase\functions\upload-organization-logo\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Branding upload Edge Function failed Deno typecheck." }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\interpret-document\deno.json") `
    (Join-Path $repoRoot "supabase\functions\interpret-document\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Interpret-document Edge Function failed Deno typecheck." }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\document-processing\deno.json") `
    (Join-Path $repoRoot "supabase\functions\document-processing\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Document-processing Edge Function failed Deno typecheck." }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\document-preprocessing\deno.json") `
    (Join-Path $repoRoot "supabase\functions\document-preprocessing\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Document-preprocessing Edge Function failed Deno typecheck." }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\recover-document-processing\deno.json") `
    --lock (Join-Path $repoRoot "supabase\functions\recover-document-processing\deno.lock") `
    --frozen `
    (Join-Path $repoRoot "supabase\functions\recover-document-processing\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Document-processing recovery Edge Function failed Deno typecheck." }
  npx.cmd --yes deno check --allow-import --node-modules-dir=auto `
    (Join-Path $repoRoot "supabase\functions\submit-price-list\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Submit-price-list Edge Function failed Deno typecheck." }
}

function Invoke-OutboxWorkerContractTests {
  # The outbox-worker delivery contract: target resolution, verbatim signed body, the
  # five mandatory headers, and the HMAC known-answer vector shared with
  # p7_integration_adapters.sql. Runs under the worker's OWN deno.json (no lock, no
  # remote imports) -- never under interpret-document's frozen-lock config.
  Write-Gate "Outbox-worker delivery, header and signature contracts"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $testOutput = @(& npx.cmd --yes deno test `
      --config (Join-Path $repoRoot "supabase\functions\outbox-worker\deno.json") `
      (Join-Path $repoRoot "supabase\functions\outbox-worker\core.test.ts") 2>&1)
    $testExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  $testOutput | ForEach-Object { Write-Output $_ }
  Assert-ExitCode "Outbox-worker contract tests" $testOutput -ExitCode $testExit
  $testText = $testOutput -join "`n"
  if ($testText -notmatch '(?i)\b[1-9][0-9]*\s+passed\b') {
    throw "Outbox-worker contract tests did not report any completed test."
  }
  if ($testText -match '(?i)\b[1-9][0-9]*\s+(?:ignored|skipped)\b') {
    throw "Outbox-worker contract tests reported ignored or skipped cases."
  }
}

function Invoke-TenantExportContractTests {
  Write-Gate "Tenant export streaming and delivery contracts"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $testOutput = @(& npx.cmd --yes deno test `
      --config (Join-Path $repoRoot "supabase\functions\tenant-export\deno.json") `
      --allow-read=$repoRoot `
      (Join-Path $repoRoot "supabase\functions\tenant-export\core.test.ts") `
      (Join-Path $repoRoot "supabase\functions\tenant-export\index_wiring.test.ts") 2>&1)
    $testExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
  $testOutput | ForEach-Object { Write-Output $_ }
  Assert-ExitCode "Tenant export contract tests" $testOutput -ExitCode $testExit
  $testText = $testOutput -join "`n"
  if ($testText -notmatch '(?i)\b[1-9][0-9]*\s+passed\b') {
    throw "Tenant export contract tests did not report any completed test."
  }
  if ($testText -match '(?i)\b[1-9][0-9]*\s+(?:ignored|skipped)\b') {
    throw "Tenant export contract tests reported ignored or skipped cases."
  }
  npx.cmd --yes deno check `
    --config (Join-Path $repoRoot "supabase\functions\tenant-export\deno.json") `
    (Join-Path $repoRoot "supabase\functions\tenant-export\index.ts")
  if ($LASTEXITCODE -ne 0) { throw "Tenant export Edge Function failed Deno typecheck." }
}

function Invoke-OcrWorkerSelfCheck {
  Write-Gate "OCR worker image and no-GPU/no-model self-check"
  # Compose validation reads a COMMITTED file, so its failure is a repo defect: left product.
  # The build and the run can both fail on the daemon, so both are classified.
  & docker compose -f (Join-Path $repoRoot "docker-compose.ocr.yml") config --quiet
  Assert-ExitCode "OCR worker Compose validation"
  Invoke-GateStage "OCR worker image build" {
    docker build --pull=false -t supplyflow-ocr-worker:acceptance (Join-Path $repoRoot "worker\ocr")
  }
  Invoke-GateStage "OCR worker self-check" {
    docker run --rm --network none --entrypoint python `
      supplyflow-ocr-worker:acceptance /app/self_check.py
  }
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
    "supabase\migrations\0080_server_price_submission_actor.sql",
    "supabase\migrations\0081_automatic_interpretation_and_price_list_intake.sql",
    "supabase\migrations\0082_fix_document_interpretation_dispatch.sql",
    "supabase\migrations\0083_fix_document_interpretation_claim.sql",
    "supabase\migrations\0084_automatic_document_classification.sql",
    "supabase\migrations\0085_reprocess_reviewed_document.sql",
    "supabase\migrations\0093_document_reprocess_and_price_list_safety.sql",
    "supabase\migrations\0094_inactive_supplier_commerce_guards.sql",
    "supabase\migrations\0095_harden_scope_enforcement_source_markers.sql",
    "supabase\migrations\0096_document_automation_calibration_shadow_operations.sql",
    "supabase\migrations\0097_financial_supplier_read_boundary.sql",
    "supabase\migrations\0098_organization_branding.sql",
    "supabase\migrations\0099_invoice_line_three_way_match.sql",
    "supabase\migrations\0100_management_dashboard_snapshot.sql",
    "supabase\migrations\0092_trial_grace_read_only_enforcement.sql",
    "supabase\migrations\0101_supplier_purchase_order_portal.sql",
    "supabase\migrations\0102_inventory_intelligence_read_model.sql",
    "supabase\migrations\0103_tenant_offboarding_export.sql",
    "supabase\migrations\0133_remove_retired_persona_surfaces.sql",
    "supabase\migrations\0134_retire_trial_lifecycle.sql",
    "supabase\migrations\0135_document_control_safe_read_models.sql",
    "supabase\migrations\0137_consolidated_supplier_invoice.sql",
    "supabase\tests\smart_document_processing.sql",
    "supabase\tests\document_learning.sql",
    "supabase\tests\document_export_templates.sql",
    "supabase\tests\p1_price_submissions.sql",
    "supabase\tests\p1_price_submissions_concurrency.sql",
    "supabase\tests\p15_automatic_price_list_intake.sql",
    "supabase\tests\p16_automatic_delivery_note_receiving.sql",
    "supabase\tests\p16_inactive_supplier_semantics.sql",
    "supabase\tests\p17_financial_supplier_view.sql",
    "supabase\tests\p18_document_automation_calibration.sql",
    "supabase\tests\p18_price_list_concurrency.sql",
    "supabase\tests\p19_organization_branding.sql",
    "supabase\tests\p20_invoice_three_way_match.sql",
    "supabase\tests\p20_invoice_approval_concurrency.sql",
    "supabase\tests\p21_dashboard_snapshot.sql",
    "supabase\tests\p44_trial_retirement_document_control.sql",
    "supabase\tests\p46_consolidated_supplier_invoice.sql",
    "supabase\tests\p24_inventory_intelligence.sql",
    "supabase\tests\p25_tenant_offboarding_export.sql",
    "supabase\tests\p26_price_baseline.sql",
    "supabase\tests\p78_price_newest_effective_date.sql",
    "supabase\tests\p79_plan_capability_ladder.sql",
    "supabase\tests\p84_plan_capability_enforcement.sql",
    "supabase\tests\p27_document_supplier_resolution.sql",
    "supabase\tests\p28_document_order_resolution.sql",
    "supabase\tests\p29_document_reconciliation_assessment.sql",
    "supabase\tests\p30_document_review_assessment_read.sql",
    "supabase\tests\p31_apply_reviewed_document.sql",
    "supabase\tests\p33_canonical_purchase_metrics.sql",
    "supabase\tests\p34_product_purchase_summary.sql",
    "supabase\tests\p35_preferred_supplier_tiebreak.sql",
    "supabase\tests\p36_document_removal_impact.sql",
    "supabase\tests\p37_document_overcharge_credit.sql",
    "supabase\tests\p38_export_report_templates.sql",
    "supabase\tests\p43_active_persona_surface.sql",
    "supabase\functions\_shared\organization-access.ts",
    "supabase\functions\_shared\organization-access.test.ts",
    "supabase\functions\_shared\organization-egress.ts",
    "supabase\functions\_shared\organization-egress.test.ts",
    "supabase\functions\_shared\reserved-egress.ts",
    "supabase\functions\_shared\reserved-egress.test.ts",
    "supabase\functions\_shared\edge-organization-access-wiring.test.ts",
    "supabase\functions\document-processing\index.ts",
    "supabase\functions\document-preprocessing\contract.ts",
    "supabase\functions\document-preprocessing\contract_test.ts",
    "supabase\functions\document-preprocessing\deno.json",
    "supabase\functions\document-preprocessing\index.ts",
    "worker\ocr\test_scan_gateway.py",
    "worker\ocr\test_scanning.py",
    "supabase\functions\recover-document-processing\core.ts",
    "supabase\functions\recover-document-processing\index.ts",
    "supabase\functions\recover-document-processing\contract_test.ts",
    "supabase\functions\recover-document-processing\deno.json",
    "supabase\functions\recover-document-processing\deno.lock",
    "supabase\functions\interpret-document\index.ts",
    "supabase\functions\interpret-document\core.test.ts",
    "supabase\functions\interpret-document\authorization.test.ts",
    "supabase\functions\upload-organization-logo\index.ts",
    "supabase\functions\upload-organization-logo\core.ts",
    "supabase\functions\upload-organization-logo\core.test.ts",
    "supabase\functions\upload-organization-logo\deno.json",
    "supabase\functions\submit-price-list\index.ts",
    "supabase\functions\tenant-export\index.ts",
    "supabase\functions\tenant-export\core.ts",
    "supabase\functions\tenant-export\core.test.ts",
    "supabase\functions\tenant-export\deno.json",
    "supabase\functions\tenant-export\index_wiring.test.ts",
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
    "document-preprocessing" = "false"
    "interpret-document" = "false"
    "recover-document-processing" = "true"
    "submit-price-list" = "true"
    "upload-organization-logo" = "true"
    "send-push" = "false"
    "outbox-worker" = "false"
    "assistant" = "true"
    "supplier-portal" = "false"
    "email-sender" = "true"
    "billing-webhook" = "false"
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
$qaMutex = Enter-QaMutex
Push-Location -LiteralPath $repoRoot
$repoLocationPushed = $true
try {
  $localEnvironment = Get-LocalSupabaseEnvironment -TimeoutSeconds 180
  $supabaseWasRunning = $null -ne $localEnvironment
  New-LocalFunctionsEnvironment
  if ($supabaseWasRunning) {
    Write-Gate "Restart isolated local Supabase for the configured Edge runtime"
    # Stopping containers runs no product code; `supabase start` two lines below already
    # classifies its own failure as local_supabase_start_failed for the same reason.
    & supabase stop | Out-Null
    Assert-ExitCode "Stopping the pre-existing isolated Supabase stack" `
      -InfrastructureReason "local_supabase_stop_failed"
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
    # THE wave-5 entry point (audit Finding 2): the build succeeded and Node crashed on
    # teardown, and this line reported it as a product regression. tsc errors, check:* script
    # failures and vitest failures match no signature and still reach FAIL/product.
    Invoke-GateStage "npm run build" { npm.cmd run build }

    Write-Gate "Dependency audit"
    Invoke-DependencyAudit

    Invoke-InterpretDocumentContractTests
    Invoke-OutboxWorkerContractTests
    Invoke-TenantExportContractTests
    Invoke-OcrWorkerSelfCheck

    Write-Gate "P0 tenant security, Storage and local Push"
    $previousPreference = $ErrorActionPreference
    try {
      # Child PowerShell forwards native Supabase progress on stderr. Preserve and inspect
      # the child's real exit code instead of letting PS 5 turn progress into an exception.
      $ErrorActionPreference = "Continue"
      $p0Output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check-p0-security.ps1") `
        -ResetLocalDatabase -KeepFixture -PushSecret $pushFunctionSecret -QaMutexAlreadyHeld 2>&1)
      $p0Exit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousPreference
    }
    $p0Output | ForEach-Object { Write-Output $_ }
    if ($p0Exit -ne 0) {
      # The child cannot write this gate's summary itself; it marks local-stack failures
      # with a ##GATE-INFRA##<reason> sentinel on stdout so they are classified BLOCKED/
      # infrastructure here instead of FAIL/product.
      $p0Infra = @($p0Output | ForEach-Object { "$_" } | Where-Object { $_ -match '##GATE-INFRA##' }) | Select-Object -First 1
      if ("$p0Infra" -match '##GATE-INFRA##([A-Za-z0-9_-]+)') {
        Stop-WithInfrastructureBlock $Matches[1] "P0 security acceptance was blocked by local infrastructure ($($Matches[1])), not by a product regression."
      }
      throw "P0 security acceptance failed with exit code $p0Exit."
    }
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
    if ($upgradeExit -ne 0) {
      # Same sentinel contract as the P0 security child above.
      $upgradeInfra = @($upgradeOutput | ForEach-Object { "$_" } | Where-Object { $_ -match '##GATE-INFRA##' }) | Select-Object -First 1
      if ("$upgradeInfra" -match '##GATE-INFRA##([A-Za-z0-9_-]+)') {
        Stop-WithInfrastructureBlock $Matches[1] "P0 upgrade path was blocked by local infrastructure ($($Matches[1])), not by a product regression."
      }
      throw "P0 upgrade path failed with exit code $upgradeExit."
    }
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
    Invoke-SqlTest "supabase\tests\p18_price_list_concurrency.sql" "Concurrent price-list reprocess and scope idempotency serialization" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p20_invoice_approval_concurrency.sql" "Concurrent invoice approvals serialize cumulative receipt consumption" "supabase_admin"
    Write-Gate "Reset after committed OCR queue fixtures"
    Reset-LocalDatabase
    Invoke-SqlTest "supabase\tests\document_learning.sql" "Document interpretation, learning and review mutations"
    Invoke-SqlTest "supabase\tests\document_export_templates.sql" "Document export scope, approval, precedence and immutable ledger"
    Invoke-SqlTest "supabase\tests\p11_document_filing.sql" "Archive filing target, filing ledger, reasoned rescue and the storage read path"
    Invoke-SqlTest "supabase\tests\p13_document_autonomy_config.sql" "Autonomy default-off, the reasoned platform write path and the uncalibrated threshold floor"
    Invoke-SqlTest "supabase\tests\p14_apply_interpretation.sql" "Machine-written invoices: the switch, min(type,supplier) confidence, idempotency and the untouched order"
    Invoke-SqlTest "supabase\tests\p15_automatic_price_list_intake.sql" "Automatic price lists: default-off, ambiguity, partial intake, idempotency and reasoned reversal"
    Invoke-SqlTest "supabase\tests\p16_automatic_delivery_note_receiving.sql" "Automatic delivery notes: draft-only receipts, three-tier order resolution, and a financial footprint that never moves"
    Invoke-SqlTest "supabase\tests\p16_inactive_supplier_semantics.sql" "Inactive suppliers block new orders and price-list mutations while history remains readable"
    Invoke-SqlTest "supabase\tests\p17_financial_supplier_view.sql" "Financial supplier identity projection, role boundary and tenant isolation"
    Invoke-SqlTest "supabase\tests\p18_document_automation_calibration.sql" "Document automation: immutable shadow predictions, reviewed calibration, drift, tenant isolation and no business mutation"
    Invoke-SqlTest "supabase\tests\p19_organization_branding.sql" "Organization branding immutable paths, server-only uploads and storage limits"
    Invoke-SqlTest "supabase\tests\p20_invoice_three_way_match.sql" "Invoice line evidence, true three-way assessment, approval blocks, override and tenant isolation"
    Invoke-SqlTest "supabase\tests\p21_dashboard_snapshot.sql" "Management dashboard snapshot, evidence-aware metrics and tenant isolation"
    Invoke-SqlTest "supabase\tests\p44_trial_retirement_document_control.sql" "Trial retirement, active-only writes and owner-only customer-safe document-control read models"
    Invoke-SqlTest "supabase\tests\p46_consolidated_supplier_invoice.sql" "One supplier-month payable anchor, immutable supporting evidence, three reconciliation channels and concurrent intake fencing" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p47_mixed_document_packets.sql" "Mixed PDFs split only from a complete reviewed manifest into isolated child documents and jobs" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p48_product_display_name.sql" "Canonical product names: owner/office only, reason mandatory, blank unrepresentable, no direct column write, every rename audited, and the switched read models render the approved name only once one exists"
    Invoke-SqlTest "supabase\tests\p49_platform_capabilities.sql" "Platform capabilities narrow operator authority: a tenant reads none of it, an operator without customer.view reads nothing, and the customer list filters, pages and counts activity without counting the console itself"
    Invoke-SqlTest "supabase\tests\p50_customer_operations_record.sql" "The internal customer record is unreachable from a tenant, notes are append-only, the platform timeline cannot be edited, and a suspended customer still takes an operator note"
    Invoke-SqlTest "supabase\tests\p51_plan_entitlements.sql" "One resolution rule for entitlements: an override beats the plan, a limit nobody stated is unknown rather than infinite, a tenant reads its own plan and no other, and the money commands demand a capability, a reason and a fresh password"
    Invoke-SqlTest "supabase\tests\p52_usage_limit_enforcement.sql" "The document limit counts one unit of work once, refuses before any row is written, treats a limit nobody stated as a refusal rather than as infinity, and never hides what the customer already has"
    Invoke-SqlTest "supabase\tests\p53_activation_onboarding_health.sql" "Activation is derived from the audit ledger rather than accumulated, an operator note never overrules a product event that actually happened, an unmeasurable milestone says so instead of reading as not-done, and health returns the reasons that produced it with no score and no prediction"
    Invoke-SqlTest "supabase\tests\p54_billing_boundary_and_funnel.sql" "A billing event is attributed only through a link we wrote ourselves and never from its payload, a replay is a no-op, an unattributable event dead-letters instead of guessing an owner, the quota crossing is recorded once per period on the write that exhausts it, and the funnel names the three stages it cannot see"
    Invoke-SqlTest "supabase\tests\p55_self_signup_rate_limit.sql" "The anonymous signup door is bounded by a limit the database counts rather than a function remembers, stores hashes and never a readable address or email, records refusals as well as acceptances, and is unreachable from any browser role"
    Invoke-SqlTest "supabase\tests\p56_assistant_foundations.sql" "A conversation belongs to the person who had it: the owner reads cost and health but never text, an unstated assistant quota refuses rather than allows, the hourly rate limit is counted in the database, the confirmed-actions switch is a reasoned policy and not a flag, and deletion and retention remove dialogue while the audit ledger does not move"
    Invoke-SqlTest "supabase\tests\p57_business_summary_parity.sql" "The business summary has one definition rather than two: the read model re-derives each of the five metrics against independently written queries, a metric that fails comes back unmeasured while its four neighbours keep their exact values, and a second tenant sees only its own numbers"
    Invoke-SqlTest "supabase\tests\p58_assistant_egress_kind.sql" "Assistant and supplier email reserve under the same service-only, active-tenant, TTL-bounded, idempotent fencing as the seven original egress kinds, with no expiry carve-out and a boundary closed to a tenth value"
    Invoke-SqlTest "supabase\tests\p59_supplier_order_portal.sql" "Supplier order portal: hashed one-order tokens, immutable structured proposals, reasoned decisions, revisions that never mutate history, and zero browser or cross-tenant surface"
    Invoke-SqlTest "supabase\tests\p59_supplier_order_portal_concurrency.sql" "Concurrent supplier submissions serialize to one immutable proposal and one named conflict" "supabase_admin"
    Write-Gate "Reset after committed supplier-portal concurrency fixtures"
    Reset-LocalDatabase
    Invoke-SqlTest "supabase\tests\p60_email_order_delivery.sql" "Email order delivery: fail-closed communication preferences, the claim/settle ledger with attempt ceilings and ambiguous-send freezes, and sent stamped only by the observed provider event"
    Invoke-SqlTest "supabase\tests\p61_assistant_history_ui.sql" "Assistant history reaches the browser through service-only RPCs that return candidate ids and structured run evidence rather than raw tables or the service snapshot, and the Edge reauthorizes every fact and source before a title, date, question or answer is emitted"
    Invoke-SqlTest "supabase\tests\p62_financial_bank_contracts.sql" "A supplier payment destination is structured rather than free text: the shape is Israeli or international and never both, the browser reaches the table through no privilege of its own, the shared directory renders a country and a last four and nothing more, the legacy text waits in a private queue that only a human save closes, and the bank import refuses anything but the canonical workbook"
    Invoke-SqlTest "supabase\tests\p63_financial_credit_contracts.sql" "An approved credit note becomes one received credit only when its invoice is unambiguous, a credit is consumed to its remainder and never against another invoice, an unlinked credit fails closed by name, and no financial reader answers from lifecycle labels"
    Invoke-SqlTest "supabase\tests\p64_financial_reversal_audit_metrics.sql" "One-time owner reversal releases consumed quantity without touching evidence, audit rows carry a deterministic legal entity or fail closed, raw history is immutable outside a declared purge, and supplier metrics read 90 days"
    Invoke-SqlTest "supabase\tests\p65_document_product_name_repair.sql" "Product names are repaired only from the checksum-bound original submission: a wrong checksum mints no preview, a requester without authority is refused, a target missing from the source stays blocked, one approval renames one product with actor, reason and source row, and the same command retried is idempotent"
    Invoke-SqlTest "supabase\tests\p66_document_kind_history.sql" "Historical document kinds resolve through one visible precedence -- human, verified interpretation, existing non-other kind, allowlisted entity inference, then other -- where the interpretation map is an allowlist that can never propose a kind the live documents CHECK cannot store, and every applied decision carries its source in an append-only ledger"
    Invoke-SqlTest "supabase\tests\p67_document_media_contracts.sql" "HEIC derivative provenance is immutable and server-written with source hash, dimensions and decoder version, decompression and pixel ceilings are structural rather than advisory, and full_frame_fallback is an explicit third scan source instead of an inference from coordinates"
    Invoke-SqlTest "supabase\tests\p68_document_calibration_automation.sql" "Owner calibration and Platform activation under step-up and completeness, a qualified-product dry-run that counts without writing, and the #245/#251/#252 negative guards proven by falsification to fire on a real violation rather than merely to return no rows"
    Invoke-SqlTest "supabase\tests\p70_launch_plans_and_usage_anchor.sql" "The launch ladder is ordered, priced in two versioned pre-tax catalogues and never lets a caller name its own currency; Legacy retires through an idempotent, audited, reasoned command whose dry run names every organization the new ceilings drop beneath; the usage period is anchored to the organization's signup instant, so no payment, renewal, tier change, cancellation, delinquency, late payment or refund resets a counter; and a referral pays both sides once, in their own periods, with only the unused remainder ever reversible"
    Invoke-SqlTest "supabase\tests\p71_billing_provider_event_processing.sql" "A provider event is recorded before anything acts on it and applied exactly once: a forged organization in the payload moves no entitlement, an unrecognized or undecided event type dead-letters without touching a plan, a merchant of record that is not enabled refuses even a correctly signed activation, no transition writes a usage counter or period, and a tenant reads none of the platform reconciliation surface"
    Invoke-SqlTest "supabase\tests\p72_email_delivery_events.sql" "The signed Resend delivery ledger de-duplicates events in the database rather than in the handler, keeps the channel monotonic so a late callback cannot regress it, records delivery_failed without touching the order's own status, bounds the reason code in the schema itself, and mints a new portal link on retry while killing the previous one immediately"
    Invoke-SqlTest "supabase\tests\p73_whatsapp_provider_neutral.sql" "The WhatsApp ledger stops assuming one vendor: identity is checked per provider, message uniqueness is provider-scoped, webhook de-duplication is enforced by the database, status stays monotonic against a late callback, and inbound is refused by name"
    Invoke-SqlTest "supabase\tests\p24_inventory_intelligence.sql" "Inventory consumption evidence, incoming supply, suggestions, price context and tenant isolation"
    Invoke-SqlTest "supabase\tests\p25_tenant_offboarding_export.sql" "Tenant offboarding, durable export parts, revocable delivery, egress fencing and lifecycle recovery" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p26_price_baseline.sql" "Contractual price baseline as of the document date, reversal ordering, undisclosed fallbacks and read-only guarantee"
    Invoke-SqlTest "supabase\tests\p78_price_newest_effective_date.sql" "Newest effective date wins the present: a backdated price records history and answers the as-of baseline for its own period, but never moves current_price -- on both the single write and the bulk import"
    Invoke-SqlTest "supabase\tests\p79_plan_capability_ladder.sql" "The plan ladder is monotonic and enforced: Free gets the Basic capability set for the existing 30-day clock then falls back, automatic interpretation spends its own quota once, user and branch limits refuse at the write, protected Data API paths fail closed, and both display catalogues remain separate from the verified billing currency"
    Invoke-SqlTest "supabase\tests\p84_plan_capability_enforcement.sql" "The plan refuses on the server: an owner on free cannot read or write the bank tables their tenant holds, the same owner on pro can, an unmeasured plan refuses nothing, a live override reopens and an expired one does not, and users.max counts an outstanding invitation as a seat already spent"
    Invoke-SqlTest "supabase\tests\p27_document_supplier_resolution.sql" "Deterministic supplier resolution from document evidence: rung order, ambiguity, tenancy and the model's guess as advisory only"
    Invoke-SqlTest "supabase\tests\p28_document_order_resolution.sql" "Per-subtype order resolution: an invoice is never matched by the single open order, a delivery note may be, and no tier ever chooses among candidates"
    Invoke-SqlTest "supabase\tests\p29_document_reconciliation_assessment.sql" "Four-source document assessment: baseline as of the document date, draft receipts are not arrivals, absence from a partial document is not a shortage, and assessing writes nothing"
    Invoke-SqlTest "supabase\tests\p30_document_review_assessment_read.sql" "The review screen's single door to the private resolvers: role boundary, unit scope inside a definer body, and file-stored versus data-approved kept apart"
    Invoke-SqlTest "supabase\tests\p31_apply_reviewed_document.sql" "Applying an approved document: the server recomputes the assessment rather than trusting the proposal, an invoice never receives goods, a delivery note only drafts, and a tax receipt creates no payable"
    Invoke-SqlTest "supabase\tests\p80_multi_currency_intake.sql" "Multi-currency intake: ISO currency is evidence, manual invoices require it, minor units are enforced, and duplicate/order checks stay inside one currency"
    Invoke-SqlTest "supabase\tests\p81_multi_currency_payments_and_bank.sql" "Multi-currency payments: requests and credits stay in one currency, bank rows match settlement money, direct cross-currency matching is refused, and no FX rate is stored"
    Invoke-SqlTest "supabase\tests\p82_currencies_in_use.sql" "currencies_in_use() answers the history of currencies rather than the open balance, stays inside one tenant through RLS rather than through a definer, and returns nothing to a retired role"
    Invoke-SqlTest "supabase\tests\p83_intake_says_when_it_could_not_check.sql" "Intake reports an amount check it could not run instead of skipping it in silence, keeps the document unblocked while it warns, and leaves a shekel business with exactly the findings it had before"
    Invoke-SqlTest "supabase\tests\p33_canonical_purchase_metrics.sql" "One definition per money question: the business day rather than the UTC day, snapshot prices, approved invoices only, and only credits that actually reduced a balance"
    Invoke-SqlTest "supabase\tests\p34_product_purchase_summary.sql" "One delivery counted once: the order item is the de-duplication grain, a completed receipt beats a supplier bill, and products are never merged by name"
    Invoke-SqlTest "supabase\tests\p35_preferred_supplier_tiebreak.sql" "A supplier preference breaks a tie and never wins one: price orders first, both recommendation sites carry the rule, and setting it takes a reason"
    Invoke-SqlTest "supabase\tests\p36_document_removal_impact.sql" "Document removal states what it destroys before it destroys it: an approved, paid or reported record blocks the destructive option, and every refusal names itself"
    Invoke-SqlTest "supabase\tests\p37_document_overcharge_credit.sql" "One overcharge, one draft credit request: a retry drafts nothing, being undercharged drafts nothing, and the price list is never touched"
    Invoke-SqlTest "supabase\tests\p38_export_report_templates.sql" "The accountants own workbook becomes the export: the document contract validator is untouched, an approved report template has a file, and an approved file is never swapped"
    Invoke-SqlTest "supabase\tests\p39_retired_personas.sql" "Retired kitchen, payer and supplier identities preserve history but cannot be invited, activated or restored as product accounts"
    Invoke-SqlTest "supabase\tests\p40_storage_browser_upload.sql" "Browser Storage inserts work with service-populated fields absent while tenant paths and the three active product roles remain enforced"
    # Both suites open real dblink worker sessions. Supabase's current local image makes
    # `postgres` a non-superuser and authenticates loopback with trust, a combination dblink
    # deliberately rejects even when a password appears in the connection string. Run these
    # concurrency harnesses like the older smart-document suite: as the local test superuser,
    # while every product call still SET ROLEs to the exact browser/service role under test.
    Invoke-SqlTest "supabase\tests\p41_document_upload_registration.sql" "Idempotent document registration survives response loss without duplicate rows, object deletion, tenant crossing or export drift" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p42_document_processing_recovery.sql" "Owner recovery consumes settled provider evidence first, fences live work and creates at most one successor" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p43_active_persona_surface.sql" "Retired personas cannot authenticate or return; owner and office keep procurement while accountant keeps finance and payment-proof upload"
    Invoke-SqlTest "supabase\tests\p45_document_scan_preprocessing.sql" "Images require a human-approved perspective-corrected scan derivative before OCR" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p4_purchase_order_status.sql" "P4 reasoned purchase-order status boundary"
    Invoke-SqlTest "supabase\tests\live_schema_alignment.sql" "Production/remediation schema alignment"
    Invoke-SqlTest "supabase\tests\p3_org_scope.sql" "Org scope riders, closure sync and completeness assertions"
    Invoke-SqlTest "supabase\tests\p4_flags_identity.sql" "P4 feature flags, identity tables and the step-up boundary"
    Invoke-SqlTest "supabase\tests\p4b_correlation.sql" "P4b correlation id header/GUC route and fail-to-NULL contract"
    Invoke-SqlTest "supabase\tests\p5_domain_events.sql" "P5 domain-event fan-out, outbox lifecycle and map mutation proof"
    Invoke-SqlTest "supabase\tests\p6b_upload_reservations.sql" "P6b upload-reservation renewal, sweep grace and column guard"
    Invoke-SqlTest "supabase\tests\p7_integration_adapters.sql" "P7 webhook subscriptions, enqueue trigger, signed claim and failure ledger"
    Invoke-SqlTest "supabase\tests\p9_five_domains.sql" "P9 notification preferences, search type gate, approval policy and the transition mirror"
    Invoke-SqlTest "supabase\tests\p74_mfa_assurance.sql" "P74 role-based MFA assurance in the step-up primitive, fail-closed aal parsing and the no-bypass proof"
    Invoke-SqlTest "supabase\tests\p75_platform_lifecycle.sql" "P75 platform lifecycle: the suspension reason splits, an unclassified table blocks deletion instead of being missed, a reminder cannot claim a send with no provider, and a purge replays an approved manifest under a per-tenant re-check"
    Invoke-SqlTest "supabase\tests\p76_owner_webhook_verification.sql" "P76 owner webhook registration, verification handshake, SSRF corpus and the offboarding claim fence"
    Invoke-SqlTest "supabase\tests\p77_assistant_quota_and_read_models.sql" "P77 the assistant quota stops refusing everybody: 50 runs inside an immutable 30-day introduction anchored to the owner's first email verification, the plan figures #198 decided after it, a contract-priced rung that still refuses until an override exists, no reset from a tier change or the Legacy cutover, and two concurrent runs at limit-minus-one serialising to exactly one; plus the two read models the assistant explains but never computes -- calendar-month supplier price rises carrying baseline, source and as-of where an unmeasurable row is excluded rather than zeroed, and a purchase comparison that returns supplier-minimum breaches instead of raising a quantity" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p85_platform_user_administration.sql" "P85 cross-tenant user administration and the operator roster's write path: the directory is readable only under user.view and is no oracle for platform authority, a change demands the capability, a reason and a fresh password, the supplier role and the last active owner are both refused, both audit trails are written and a no-op writes neither, the profiles guard still refuses a direct write once the command's handshake closes, and nobody may change their own authority"
    Invoke-SqlTest "supabase\tests\p90_dashboard_period_comparison.sql" "The control centre compares periods in one place: the month-to-date baseline ends on the same day number and is clamped to the length of the previous month so July 31 meets June 30 and March 31 meets February 28, the invoiced comparison stays whole month against whole month, each currency carries its own pair with a measured zero where it did not trade and no row where it never traded, drafts and soft-deleted invoices stay out, and a role that may not read the dashboard gets nothing"
    Invoke-SqlTest "supabase\tests\p92_scheduled_payments_outlook.sql" "Scheduled payments are reported with the coverage they have and never as a forecast: the horizon figure is dated active in-window money only, coverage comes back in rows AND in money on a fixture where the two ratios disagree, each currency keeps its own row, undated order commitments sit beside the horizon and never inside it, office is refused in words instead of with zeros while the accountant is answered, and the monthly writer freezes a cohort that refuses every later update and delete"
    Invoke-SqlTest "supabase\tests\p91_invoice_due_date.sql" "An invoice can carry the date it is due and nothing invents one: a supplier stating net-60 terms still leaves the invoice undated because nobody parses that free text, a direct update is refused so the audited command is the only door, the command is owner and office only and idempotent and never writes a reasonless audit row, clearing the date is an answer rather than a deletion, a date ten years from its invoice is refused, and the definer function is pinned to the scope ledger"
    Invoke-SqlTest "supabase\tests\payment_credit_override.sql" "Payment approval with legal-entity scoped open-credit override"
    Invoke-SqlTest "supabase\tests\monthly_report_snapshots.sql" "Immutable legal-entity monthly accountant snapshots"
    Invoke-Preflight
    Invoke-SqlTest "supabase\tests\p1_financial_commands.sql" "P1 financial commands, rollback and idempotency"
    Invoke-SqlTest "supabase\tests\p1_price_submissions.sql" "Owner and office price-list reservation, registration, intake, review and evidence"
    Invoke-SqlTest "supabase\tests\p1_price_submissions_concurrency.sql" "Concurrent owner and office price-list submission and idempotency" "supabase_admin"
    Write-Gate "Reset after committed price-list concurrency fixtures"
    Reset-LocalDatabase
    Invoke-SqlTest "supabase\tests\p2_data_reliability.sql" "P2 retry, alerts, pagination and reliability"
    Invoke-SqlTest "supabase\tests\server_list_contracts.sql" "Server list predicates, duplicate key across pages and tenant scope"
    Invoke-SqlTest "supabase\tests\roadmap_db_contracts.sql" "Roadmap supplier, inventory, savings and WhatsApp contracts"
    Invoke-SqlTest "supabase\tests\p1_concurrency.sql" "P1 real concurrent sessions" "supabase_admin"
    Invoke-SqlTest "supabase\tests\payment_credit_override_concurrency.sql" "Concurrent payment replay, approval, execution and credit creation" "supabase_admin"
    Invoke-SqlTest "supabase\tests\monthly_report_snapshots_concurrency.sql" "Concurrent immutable monthly snapshot version allocation" "supabase_admin"
    Invoke-SqlTest "supabase\tests\p63_financial_credit_concurrency.sql" "Two accountants racing for one credit remainder: one payment, one named refusal, no double allocation" "supabase_admin"

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
      Invoke-GateStage "P4 integrated journey" {
        node (Join-Path $PSScriptRoot "check-p4-integrated-journey.cjs")
      }
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
      Invoke-GateStage "Browser smoke" {
        node (Join-Path $PSScriptRoot "check-browser-smoke.cjs")
      }
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
  # The default is still FAIL/product, and that is correct: an unrecognised failure in a gate
  # whose job is to catch product regressions must be treated as one. What changed in wave 10
  # (audit Finding 2) is that the stages which CAN fail environmentally no longer arrive here
  # unclassified -- Assert-ExitCode / Invoke-GateStage divert them to BLOCKED/infrastructure
  # with a named reason first.
  #
  # Still unclassified, stated so nobody reads this line as complete coverage: the demo/OCR
  # fixture installers (Install-DemoFixture, Install-OcrBrowserFixture, Remove-OcrBrowserFixture)
  # and Invoke-DependencyAudit's unapproved-advisory throw. Those can each fail for product
  # reasons too, so blanket classification would be a lie; adding signatures for them needs
  # observed failures to name, which this campaign does not have.
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

      # The reset above drops the demo tenant, and this run rewrote the three demo passwords to
      # a per-run random seed. Both are deliberate; together they leave a stack nobody can sign
      # in to. CLAUDE.md makes restoring it a duty of whoever ran the reset -- doing it here is
      # the only version of that duty that cannot be forgotten. Best-effort by design: -Quiet
      # exits 0 when there is no external manifest, which is the normal state in CI.
      Write-Gate "Restore the local demo accounts"
      try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "restore-demo-local.ps1") -Quiet
        if ($LASTEXITCODE -ne 0) { throw "restore-demo-local.ps1 exited with code $LASTEXITCODE." }
      }
      catch { $cleanupErrors += "Local demo restore failed: $($_.Exception.Message)" }
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
    Write-StageTimings
    if ($repoLocationPushed) {
      Pop-Location
      $repoLocationPushed = $false
    }
    Exit-QaMutex $qaMutex
    $qaMutex = $null
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
