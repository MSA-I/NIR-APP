# Builds and runs the OCR worker pool that serves a live SupplyFlow project.
#
# This file exists because the production worker had no committed launch path. It was started by
# hand, so docker-compose.ocr.yml described an image tag that was not the one running, nothing
# recorded how many workers there were, and "is the fix deployed?" could only be answered by
# reading job timings out of the database. One script, one answer.
#
# Secrets are read from files outside the repository at run time (see docs/LOCAL-CREDENTIALS-PATH.md)
# and are never printed, logged, or written back to disk.
#
# ASCII only, deliberately: this repository lives under a Hebrew path, and Windows PowerShell 5.1
# reads a BOM-less .ps1 as ANSI. A non-ASCII character anywhere in this file -- including inside a
# default parameter value -- turns the whole script into a parser error. DocsRoot is therefore
# derived from the repository location rather than written out.
#
# Usage:
#   .\scripts\run-ocr-worker.ps1                     # 2 workers against production, image = HEAD
#   .\scripts\run-ocr-worker.ps1 -Replicas 3
#   .\scripts\run-ocr-worker.ps1 -Canary mistral   # replica 1 on mistral, the rest on -Adapter
#   .\scripts\run-ocr-worker.ps1 -Adapter mistral  # the whole pool on mistral
#   .\scripts\run-ocr-worker.ps1 -Status             # report what is running, change nothing
[CmdletBinding()]
param(
  [ValidateRange(1, 8)][int]$Replicas = 2,
  [ValidateSet("openai", "mistral")][string]$Adapter = "openai",
  # A canary is only evidence while another worker still runs the old engine on the same queue,
  # so it is a separate switch from -Adapter rather than a value of it.
  [ValidateSet("", "openai", "mistral")][string]$Canary = "",
  [string]$SupabaseUrl = "https://rkftlbctohswhbbiaqin.supabase.co",
  [string]$DocsRoot,
  [string]$Tag,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DocsRoot) { $DocsRoot = Join-Path (Split-Path -Parent $repoRoot) "NIR-APP-DOCS" }
$namePrefix = "supplyflow-ocr-live"

function Invoke-Docker {
  param([string[]]$DockerArgs, [switch]$IgnoreFailure)
  # Same dance as scripts/check-quality-gates.ps1: redirecting a native exe's stderr in Windows
  # PowerShell 5.1 wraps every line in an ErrorRecord, so a `docker build` that succeeded while
  # printing ordinary progress to stderr would otherwise throw NativeCommandError. The exit code
  # is the verdict; the text is only evidence.
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& docker @DockerArgs 2>&1) | ForEach-Object { "$_" }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0 -and -not $IgnoreFailure) {
    throw "docker $($DockerArgs -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return $output
}

# Reports what is actually running. Prints setting names and values, never credentials.
function Show-Pool {
  $names = @(Invoke-Docker @("ps", "--filter", "name=$namePrefix", "--format", "{{.Names}}") -IgnoreFailure)
  if ($names.Count -eq 0) {
    Write-Host "No $namePrefix container is running."
    return
  }
  foreach ($name in $names) {
    $env = @(Invoke-Docker @("inspect", $name, "--format", "{{range .Config.Env}}{{println .}}{{end}}") -IgnoreFailure)
    $shown = @($env | Where-Object { $_ -match "^(OCR_WORKER_ID|OCR_JOB_TIMEOUT_SECONDS|OCR_PAGE_CONCURRENCY|OCR_QA_PASSES)=" })
    $image = (Invoke-Docker @("inspect", $name, "--format", "{{.Config.Image}}") -IgnoreFailure) -join ""
    Write-Host "$name  $image  [$($shown -join ' ')]"
  }
}

if ($Status) {
  Show-Pool
  return
}

if (-not $Tag) {
  $sha = (& git -C $repoRoot rev-parse --short HEAD)
  if ($LASTEXITCODE -ne 0) { throw "Could not resolve HEAD for the image tag." }
  $Tag = "$sha".Trim()
}
if (-not $Tag) { throw "Empty image tag." }
$image = "supplyflow-ocr-worker:$Tag"

if ($Canary -and $Replicas -lt 2) {
  # A canary that is the entire pool is not a canary; it is a deploy without a control.
  throw "-Canary needs at least 2 replicas so one worker keeps running $Adapter."
}
$engines = @($Adapter); if ($Canary) { $engines += $Canary }

$tokenPath = Join-Path $DocsRoot "NIR-OCR-WORKER-TOKEN.txt"
$openAiPath = Join-Path $DocsRoot "NIR-API-OPENAI.txt"
# The file name is the one that exists on this machine, typo and all; renaming it here would
# only move the failure to a different line.
$mistralPath = Join-Path $DocsRoot "NIR-AP-MISTRAL.txt"
# Only the keys the configured engines actually need, so a pool that has finished moving off one
# vendor is not blocked by that vendor's missing file.
$required = @($tokenPath)
if ($engines -contains "openai") { $required += $openAiPath }
if ($engines -contains "mistral") { $required += $mistralPath }
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Credential file not found: $path" }
}
$workerToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
$openAiKey = ""
if ($engines -contains "openai") { $openAiKey = (Get-Content -LiteralPath $openAiPath -Raw).Trim() }
$mistralKey = ""
if ($engines -contains "mistral") { $mistralKey = (Get-Content -LiteralPath $mistralPath -Raw).Trim() }
if (-not $workerToken) { throw "A credential file is empty." }
if (($engines -contains "openai") -and -not $openAiKey) { throw "A credential file is empty." }
if (($engines -contains "mistral") -and -not $mistralKey) { throw "A credential file is empty." }

Write-Host "Building $image ..."
Invoke-Docker @("build", "--tag", $image, (Join-Path $repoRoot "worker\ocr")) | Out-Null

# Replace the whole pool rather than adding to it. Two generations of worker running at once is
# exactly the state that made a fixed 900-second ceiling look like it was still 300: half the jobs
# were being claimed by the old image.
$existing = @(Invoke-Docker @("ps", "-aq", "--filter", "name=$namePrefix") -IgnoreFailure)
if ($existing.Count -gt 0) {
  Write-Host "Removing $($existing.Count) existing container(s) named $namePrefix* ..."
  Invoke-Docker (@("rm", "-f") + $existing) -IgnoreFailure | Out-Null
}

for ($index = 1; $index -le $Replicas; $index += 1) {
  $name = "$namePrefix-$index"
  # The worker id is written into job leases, so it has to say which build and which replica --
  # the previous pool reported supplyflow-prod-c1b4490, a commit that had not been running in days.
  # Replica 1 carries the canary when one is asked for; every other replica runs the pool default.
  $engine = if ($index -eq 1 -and $Canary) { $Canary } else { $Adapter }
  # The engine is part of the worker id because the id is what job leases record. Without it a
  # canary produces two populations of documents that cannot be told apart afterwards.
  $workerId = "supplyflow-$Tag-$index-$engine"
  $runArgs = @(
    "run", "--detach", "--name", $name,
    "--init", "--restart", "unless-stopped", "--stop-timeout", "45",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "256",
    "--tmpfs", "/var/tmp/supplyflow-ocr:rw,noexec,nosuid,nodev,size=512m,mode=0700,uid=10001,gid=10001",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
    "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    "--env", "SUPABASE_URL=$SupabaseUrl",
    "--env", "OCR_WORKER_TOKEN=$workerToken",
    "--env", "OPENAI_API_KEY=$openAiKey",
    "--env", "MISTRAL_API_KEY=$mistralKey",
    "--env", "OCR_WORKER_ID=$workerId",
    "--env", "OCR_ADAPTER=$engine",
    "--env", "OCR_OPENAI_MODEL=gpt-5.6-terra",
    "--env", "OCR_QA_PASSES=3",
    "--env", "OCR_PAGE_CONCURRENCY=3",
    "--env", "OCR_JOB_TIMEOUT_SECONDS=900",
    "--env", "OCR_TEMP_ROOT=/var/tmp/supplyflow-ocr",
    $image
  )
  Invoke-Docker $runArgs | Out-Null
  Write-Host "Started $name as $workerId"
}

# Read the settings back off the running containers instead of repeating what was requested.
# The whole reason this script exists is that "we set it to 900" and "it is running with 900"
# turned out to be different claims.
Write-Host ""
Write-Host "Running pool:"
Show-Pool
