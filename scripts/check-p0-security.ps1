# End-to-end P0 tenant-security acceptance test.
#
# The test intentionally uses the local Supabase HTTP APIs (Auth, PostgREST, Storage),
# not a privileged SQL connection, so every assertion exercises the deployed grants and
# RLS policies. It refuses non-loopback targets and requires an explicit destructive reset.
#
# Usage:
#   .\scripts\check-p0-security.ps1 -ResetLocalDatabase
#   .\scripts\check-p0-security.ps1 -ResetLocalDatabase -ServePushFunction
#   .\scripts\check-p0-security.ps1 -ResetLocalDatabase -KeepFixture # local debugging only
param(
  [switch]$ResetLocalDatabase,
  [switch]$KeepFixture,
  [switch]$ServePushFunction,
  [string]$PushSecret
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http

$apiUrl = "http://127.0.0.1:55431"
$expectedProjectId = "supplyflow-p0"
$script:Passed = 0
$script:HttpClient = [System.Net.Http.HttpClient]::new()

if (-not $ResetLocalDatabase) {
  throw "This test resets the local database. Re-run with -ResetLocalDatabase to acknowledge that scope."
}

$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "supabase\config.toml"
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
if ($config -notmatch "(?m)^project_id\s*=\s*`"$([regex]::Escape($expectedProjectId))`"\s*$") {
  throw "Refusing to run: supabase/config.toml is not the isolated $expectedProjectId project."
}

function Reset-TestDatabase {
  & supabase db reset
  if ($LASTEXITCODE -ne 0) { throw "supabase db reset failed." }
}

function Get-LocalSupabaseEnvironment {
  $required = @("API_URL", "ANON_KEY", "SERVICE_ROLE_KEY")
  $missing = $required
  $statusExitCode = -1
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    $values = @{}
    $previousPreference = $ErrorActionPreference
    try {
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
      if ($values.ContainsKey("API_URL") -and $values.API_URL -ne $apiUrl) {
        throw "Refusing non-test API URL: $($values.API_URL)"
      }
      $missing = @($required | Where-Object { -not $values.ContainsKey($_) -or -not $values[$_] })
      if (-not $missing.Count) { return $values }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Local Supabase environment readiness timed out (status=$statusExitCode; missing=$($missing -join ','))."
}

function New-Id { return [guid]::NewGuid().Guid }

function New-Password {
  return "P0!$([guid]::NewGuid().ToString('N'))aA7"
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

function Start-LocalPushFunction([hashtable]$Environment, [string]$Secret) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $keys = New-LocalVapidKeys
  $stdoutPath = [IO.Path]::GetTempFileName()
  $stderrPath = [IO.Path]::GetTempFileName()
  $envPath = [IO.Path]::GetTempFileName()
  $envLines = @(
    "PUSH_FN_SECRET=$Secret",
    "VAPID_PUBLIC_KEY=$($keys.PublicKey)",
    "VAPID_PRIVATE_KEY=$($keys.PrivateKey)",
    "VAPID_SUBJECT=mailto:p0-local@example.test",
    "SUPABASE_URL=$($Environment.API_URL)",
    "SUPABASE_SERVICE_ROLE_KEY=$($Environment.SERVICE_ROLE_KEY)"
  )
  [IO.File]::WriteAllLines($envPath, $envLines, (New-Object Text.UTF8Encoding($false)))
  $process = Start-Process -FilePath (Get-Command supabase).Source `
    -ArgumentList @("functions", "serve", "send-push", "--no-verify-jwt", "--env-file", $envPath) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($process.HasExited) { break }
    try {
      $probe = Invoke-JsonRequest -Method Post -Uri "$apiUrl/functions/v1/send-push" `
        -Headers @{ "x-push-secret" = "p0-readiness-probe" } -Body @{ event = "payment_due_scan" }
      if ($probe.Status -eq 403) {
        $ready = $true
        break
      }
    } catch {
      # The local Deno worker is still starting.
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $ready) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    $detail = (Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item -LiteralPath $stdoutPath, $stderrPath, $envPath -Force -ErrorAction SilentlyContinue
    throw "Local send-push function did not become ready. $detail"
  }

  return [pscustomobject]@{
    Process = $process
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    EnvPath = $envPath
  }
}

function New-Headers([string]$ApiKey, [string]$Token, [string]$Prefer = $null) {
  $headers = @{
    apikey = $ApiKey
    Authorization = "Bearer $Token"
  }
  if ($Prefer) { $headers.Prefer = $Prefer }
  return $headers
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [object]$Body
  )

  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::new($Method.ToUpperInvariant()),
    [Uri]$Uri
  )
  foreach ($name in $Headers.Keys) {
    [void]$request.Headers.TryAddWithoutValidation([string]$name, [string]$Headers[$name])
  }
  if ($PSBoundParameters.ContainsKey("Body")) {
    $payload = $Body | ConvertTo-Json -Depth 20 -Compress
    $request.Content = [System.Net.Http.StringContent]::new(
      $payload,
      [System.Text.Encoding]::UTF8,
      "application/json"
    )
  }

  $response = $script:HttpClient.SendAsync($request).GetAwaiter().GetResult()
  $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $json = $null
  if ($content) {
    try { $json = $content | ConvertFrom-Json } catch { $json = $null }
  }
  return [pscustomobject]@{
    Status = [int]$response.StatusCode
    Content = $content
    Json = $json
  }
}

function Invoke-BinaryRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [Parameter(Mandatory = $true)][string]$ContentType,
    [Parameter(Mandatory = $true)][byte[]]$Bytes
  )
  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::new($Method.ToUpperInvariant()),
    [Uri]$Uri
  )
  foreach ($name in $Headers.Keys) {
    [void]$request.Headers.TryAddWithoutValidation([string]$name, [string]$Headers[$name])
  }
  $request.Content = [System.Net.Http.ByteArrayContent]::new($Bytes)
  $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new($ContentType)
  $response = $script:HttpClient.SendAsync($request).GetAwaiter().GetResult()
  $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return [pscustomobject]@{
    Status = [int]$response.StatusCode
    Content = $content
    Json = $null
  }
}

function Assert-True([bool]$Condition, [string]$Label) {
  if (-not $Condition) { throw "FAILED: $Label" }
  $script:Passed++
  Write-Host "PASS $Label"
}

function Assert-Status($Response, [int[]]$Expected, [string]$Label) {
  if ($Expected -notcontains $Response.Status) {
    $detail = if ($Response.Content.Length -gt 800) { $Response.Content.Substring(0, 800) } else { $Response.Content }
    throw "FAILED: $Label (HTTP $($Response.Status), expected $($Expected -join '/')): $detail"
  }
  $script:Passed++
  Write-Host "PASS $Label"
}

function Assert-Blocked($Response, [string]$Label) {
  Assert-True ($Response.Status -lt 200 -or $Response.Status -ge 300) $Label
}

function Assert-Count($Value, [int]$Expected, [string]$Label) {
  $actual = if ($null -eq $Value) { 0 } else { @($Value).Count }
  Assert-True ($actual -eq $Expected) $Label
}

function Invoke-Rest {
  param(
    [string]$Method,
    [string]$Resource,
    [string]$ApiKey,
    [string]$Token,
    [object]$Body,
    [string]$Prefer = $null
  )
  $args = @{
    Method = $Method
    Uri = "$apiUrl/rest/v1/$Resource"
    Headers = New-Headers $ApiKey $Token $Prefer
  }
  if ($PSBoundParameters.ContainsKey("Body")) { $args.Body = $Body }
  return Invoke-JsonRequest @args
}

function Wait-LocalApiReady([string]$ServiceKey) {
  $headers = @{ apikey = $ServiceKey; Authorization = "Bearer $ServiceKey" }
  $authStatus = 0
  $restStatus = 0
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    try {
      $authStatus = (Invoke-JsonRequest -Method Get -Uri "$apiUrl/auth/v1/health" -Headers $headers).Status
    } catch { $authStatus = -1 }
    try {
      $restStatus = (Invoke-Rest -Method Get -Resource "organizations?select=id&limit=0" `
        -ApiKey $ServiceKey -Token $ServiceKey).Status
    } catch { $restStatus = -1 }
    if ($authStatus -eq 200 -and $restStatus -eq 200) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Local API readiness failed after reset (Auth=$authStatus, PostgREST=$restStatus)."
}

function Add-ServiceRow([string]$Table, [hashtable]$Row, [string]$ServiceKey) {
  $response = Invoke-Rest -Method Post -Resource $Table -ApiKey $ServiceKey -Token $ServiceKey `
    -Body $Row -Prefer "return=representation"
  Assert-Status $response @(201) "fixture $Table"
  return @($response.Json)[0]
}

function New-TestUser([string]$Label, [string]$Suffix, [string]$ServiceKey) {
  $email = "p0-$Label-$Suffix@example.test"
  $password = New-Password
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/auth/v1/admin/users" `
    -Headers (New-Headers $ServiceKey $ServiceKey) `
    -Body @{ email = $email; password = $password; email_confirm = $true }
  Assert-Status $response @(200) "create auth user $Label"
  return [pscustomobject]@{
    Id = [string]$response.Json.id
    Email = $email
    Password = $password
    Token = $null
  }
}

function Sign-InTestUser($Account, [string]$AnonKey) {
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $AnonKey } `
    -Body @{ email = $Account.Email; password = $Account.Password }
  Assert-Status $response @(200) "sign in $($Account.Email.Split('@')[0])"
  $Account.Token = [string]$response.Json.access_token
}

function Get-Rows([string]$Resource, $Account, [string]$AnonKey, [string]$Label) {
  $response = Invoke-Rest -Method Get -Resource $Resource -ApiKey $AnonKey -Token $Account.Token
  Assert-Status $response @(200) $Label
  return @($response.Json)
}

Reset-TestDatabase
$environment = Get-LocalSupabaseEnvironment
$anonKey = [string]$environment.ANON_KEY
$serviceKey = [string]$environment.SERVICE_ROLE_KEY
$pushServer = $null
Wait-LocalApiReady $serviceKey

try {
  $suffix = [guid]::NewGuid().ToString("N").Substring(0, 10)
  $orgA = New-Id
  $orgB = New-Id
  $orgSuspended = New-Id

  $accounts = @{
    ownerA = New-TestUser "owner-a" $suffix $serviceKey
    officeA = New-TestUser "office-a" $suffix $serviceKey
    kitchenA = New-TestUser "kitchen-a" $suffix $serviceKey
    payerA = New-TestUser "payer-a" $suffix $serviceKey
    accountantA = New-TestUser "accountant-a" $suffix $serviceKey
    supplierA = New-TestUser "supplier-a" $suffix $serviceKey
    ownerB = New-TestUser "owner-b" $suffix $serviceKey
    officeB = New-TestUser "office-b" $suffix $serviceKey
    kitchenB = New-TestUser "kitchen-b" $suffix $serviceKey
    payerB = New-TestUser "payer-b" $suffix $serviceKey
    accountantB = New-TestUser "accountant-b" $suffix $serviceKey
    supplierB = New-TestUser "supplier-b" $suffix $serviceKey
    ownerSuspended = New-TestUser "owner-suspended" $suffix $serviceKey
    payerSuspended = New-TestUser "payer-suspended" $suffix $serviceKey
    platform = New-TestUser "platform" $suffix $serviceKey
  }

  Add-ServiceRow "organizations" @{ id = $orgA; name = "P0 Tenant A"; status = "active" } $serviceKey | Out-Null
  Add-ServiceRow "organizations" @{ id = $orgB; name = "P0 Tenant B"; status = "active" } $serviceKey | Out-Null
  Add-ServiceRow "organizations" @{ id = $orgSuspended; name = "P0 Tenant Suspended"; status = "active" } $serviceKey | Out-Null

  $supplierA = New-Id
  $supplierB = New-Id
  Add-ServiceRow "suppliers" @{ id = $supplierA; org_id = $orgA; name = "Supplier A" } $serviceKey | Out-Null
  Add-ServiceRow "suppliers" @{ id = $supplierB; org_id = $orgB; name = "Supplier B" } $serviceKey | Out-Null

  $profileRows = @(
    @{ id = $accounts.ownerA.Id; org_id = $orgA; full_name = "Owner A"; role = "owner" },
    @{ id = $accounts.officeA.Id; org_id = $orgA; full_name = "Office A"; role = "office" },
    @{ id = $accounts.kitchenA.Id; org_id = $orgA; full_name = "Kitchen A"; role = "kitchen" },
    @{ id = $accounts.payerA.Id; org_id = $orgA; full_name = "Payer A"; role = "payer" },
    @{ id = $accounts.accountantA.Id; org_id = $orgA; full_name = "Accountant A"; role = "accountant" },
    @{ id = $accounts.supplierA.Id; org_id = $orgA; full_name = "Supplier Agent A"; role = "supplier"; supplier_id = $supplierA },
    @{ id = $accounts.ownerB.Id; org_id = $orgB; full_name = "Owner B"; role = "owner" },
    @{ id = $accounts.officeB.Id; org_id = $orgB; full_name = "Office B"; role = "office" },
    @{ id = $accounts.kitchenB.Id; org_id = $orgB; full_name = "Kitchen B"; role = "kitchen" },
    @{ id = $accounts.payerB.Id; org_id = $orgB; full_name = "Payer B"; role = "payer" },
    @{ id = $accounts.accountantB.Id; org_id = $orgB; full_name = "Accountant B"; role = "accountant" },
    @{ id = $accounts.supplierB.Id; org_id = $orgB; full_name = "Supplier Agent B"; role = "supplier"; supplier_id = $supplierB },
    @{ id = $accounts.ownerSuspended.Id; org_id = $orgSuspended; full_name = "Suspended Owner"; role = "owner" },
    @{ id = $accounts.payerSuspended.Id; org_id = $orgSuspended; full_name = "Suspended Payer"; role = "payer" }
  )
  foreach ($profile in $profileRows) { Add-ServiceRow "profiles" $profile $serviceKey | Out-Null }
  Add-ServiceRow "platform_admins" @{ user_id = $accounts.platform.Id; note = "P0 local acceptance" } $serviceKey | Out-Null

  $categoryA = New-Id
  $categoryB = New-Id
  $productA = New-Id
  $productB = New-Id
  $supplierProductA = New-Id
  $supplierProductB = New-Id
  Add-ServiceRow "categories" @{ id = $categoryA; org_id = $orgA; name = "Category A" } $serviceKey | Out-Null
  Add-ServiceRow "categories" @{ id = $categoryB; org_id = $orgB; name = "Category B" } $serviceKey | Out-Null
  Add-ServiceRow "products" @{ id = $productA; org_id = $orgA; category_id = $categoryA; name = "Product A"; unit = "unit" } $serviceKey | Out-Null
  Add-ServiceRow "products" @{ id = $productB; org_id = $orgB; category_id = $categoryB; name = "Product B"; unit = "unit" } $serviceKey | Out-Null
  Add-ServiceRow "supplier_products" @{ id = $supplierProductA; org_id = $orgA; supplier_id = $supplierA; product_id = $productA; current_price = 10 } $serviceKey | Out-Null
  Add-ServiceRow "supplier_products" @{ id = $supplierProductB; org_id = $orgB; supplier_id = $supplierB; product_id = $productB; current_price = 20 } $serviceKey | Out-Null

  $requestA = New-Id
  $requestB = New-Id
  Add-ServiceRow "purchase_requests" @{ id = $requestA; org_id = $orgA; status = "split"; created_by = $accounts.officeA.Id } $serviceKey | Out-Null
  Add-ServiceRow "purchase_requests" @{ id = $requestB; org_id = $orgB; status = "split"; created_by = $accounts.ownerB.Id } $serviceKey | Out-Null
  $orderA = New-Id
  $orderB = New-Id
  Add-ServiceRow "purchase_orders" @{ id = $orderA; org_id = $orgA; supplier_id = $supplierA; request_id = $requestA; status = "ready"; created_by = $accounts.officeA.Id } $serviceKey | Out-Null
  Add-ServiceRow "purchase_orders" @{ id = $orderB; org_id = $orgB; supplier_id = $supplierB; request_id = $requestB; status = "ready"; created_by = $accounts.ownerB.Id } $serviceKey | Out-Null
  $orderItemA = New-Id
  $orderItemB = New-Id
  Add-ServiceRow "purchase_order_items" @{ id = $orderItemA; org_id = $orgA; order_id = $orderA; product_id = $productA; qty = 2; unit_price = 10 } $serviceKey | Out-Null
  Add-ServiceRow "purchase_order_items" @{ id = $orderItemB; org_id = $orgB; order_id = $orderB; product_id = $productB; qty = 2; unit_price = 20 } $serviceKey | Out-Null
  $receiptA = New-Id
  $receiptB = New-Id
  Add-ServiceRow "goods_receipts" @{ id = $receiptA; org_id = $orgA; order_id = $orderA; status = "completed"; received_by = $accounts.kitchenA.Id } $serviceKey | Out-Null
  Add-ServiceRow "goods_receipts" @{ id = $receiptB; org_id = $orgB; order_id = $orderB; status = "completed"; received_by = $accounts.ownerB.Id } $serviceKey | Out-Null
  $receiptItemA = New-Id
  $receiptItemB = New-Id
  Add-ServiceRow "goods_receipt_items" @{ id = $receiptItemA; org_id = $orgA; receipt_id = $receiptA; order_item_id = $orderItemA; product_id = $productA; qty_received = 2 } $serviceKey | Out-Null
  Add-ServiceRow "goods_receipt_items" @{ id = $receiptItemB; org_id = $orgB; receipt_id = $receiptB; order_item_id = $orderItemB; product_id = $productB; qty_received = 2 } $serviceKey | Out-Null

  $invoiceA = New-Id
  $invoiceAUnapproved = New-Id
  $invoiceB = New-Id
  Add-ServiceRow "invoices" @{ id = $invoiceA; org_id = $orgA; supplier_id = $supplierA; invoice_number = "P0-A"; invoice_date = "2026-07-01"; received_by = $accounts.officeA.Id; amount_before_vat = 100; total_amount = 100; review_status = "approved" } $serviceKey | Out-Null
  Add-ServiceRow "invoices" @{ id = $invoiceAUnapproved; org_id = $orgA; supplier_id = $supplierA; invoice_number = "P0-A-UNAPPROVED"; invoice_date = "2026-07-02"; received_by = $accounts.officeA.Id; amount_before_vat = 40; total_amount = 40; review_status = "in_review" } $serviceKey | Out-Null
  Add-ServiceRow "invoices" @{ id = $invoiceB; org_id = $orgB; supplier_id = $supplierB; invoice_number = "P0-B"; invoice_date = "2026-07-01"; received_by = $accounts.ownerB.Id; amount_before_vat = 200; total_amount = 200; review_status = "approved" } $serviceKey | Out-Null
  Add-ServiceRow "invoice_order_links" @{ org_id = $orgA; invoice_id = $invoiceA; order_id = $orderA } $serviceKey | Out-Null
  Add-ServiceRow "invoice_receipt_links" @{ org_id = $orgA; invoice_id = $invoiceA; receipt_id = $receiptA } $serviceKey | Out-Null

  $paymentRequestA = New-Id
  $paymentRequestB = New-Id
  Add-ServiceRow "payment_requests" @{ id = $paymentRequestA; org_id = $orgA; supplier_id = $supplierA; amount = 100; status = "approved"; created_by = $accounts.officeA.Id; approved_by = $accounts.ownerA.Id } $serviceKey | Out-Null
  Add-ServiceRow "payment_requests" @{ id = $paymentRequestB; org_id = $orgB; supplier_id = $supplierB; amount = 200; status = "approved"; created_by = $accounts.ownerB.Id; approved_by = $accounts.ownerB.Id } $serviceKey | Out-Null
  Add-ServiceRow "payment_request_invoices" @{ org_id = $orgA; payment_request_id = $paymentRequestA; invoice_id = $invoiceA; amount_allocated = 100 } $serviceKey | Out-Null
  Add-ServiceRow "payment_request_invoices" @{ org_id = $orgB; payment_request_id = $paymentRequestB; invoice_id = $invoiceB; amount_allocated = 200 } $serviceKey | Out-Null
  $paymentA = New-Id
  $paymentB = New-Id
  Add-ServiceRow "payments" @{ id = $paymentA; org_id = $orgA; supplier_id = $supplierA; payment_request_id = $paymentRequestA; amount = 30; executed_by = $accounts.payerA.Id } $serviceKey | Out-Null
  Add-ServiceRow "payments" @{ id = $paymentB; org_id = $orgB; supplier_id = $supplierB; payment_request_id = $paymentRequestB; amount = 50; executed_by = $accounts.payerB.Id } $serviceKey | Out-Null
  Add-ServiceRow "payment_allocations" @{ id = (New-Id); org_id = $orgA; payment_id = $paymentA; invoice_id = $invoiceA; amount = 30 } $serviceKey | Out-Null
  Add-ServiceRow "payment_allocations" @{ id = (New-Id); org_id = $orgB; payment_id = $paymentB; invoice_id = $invoiceB; amount = 50 } $serviceKey | Out-Null

  $bankImportA = New-Id
  $bankImportB = New-Id
  $bankTransactionA = New-Id
  $bankTransactionB = New-Id
  Add-ServiceRow "bank_imports" @{ id = $bankImportA; org_id = $orgA; filename = "p0-a.csv"; file_hash = "p0-a-$suffix"; column_mapping = @{ amount = "amount" }; row_count = 1; imported_by = $accounts.officeA.Id } $serviceKey | Out-Null
  Add-ServiceRow "bank_imports" @{ id = $bankImportB; org_id = $orgB; filename = "p0-b.csv"; file_hash = "p0-b-$suffix"; column_mapping = @{ amount = "amount" }; row_count = 1; imported_by = $accounts.officeB.Id } $serviceKey | Out-Null
  Add-ServiceRow "bank_transactions" @{ id = $bankTransactionA; org_id = $orgA; import_id = $bankImportA; tx_date = "2026-07-02"; description = "P0 A"; amount = 30; raw = @{ amount = 30 }; supplier_id = $supplierA; row_hash = "p0-bank-a-$suffix" } $serviceKey | Out-Null
  Add-ServiceRow "bank_transactions" @{ id = $bankTransactionB; org_id = $orgB; import_id = $bankImportB; tx_date = "2026-07-02"; description = "P0 B"; amount = 50; raw = @{ amount = 50 }; supplier_id = $supplierB; row_hash = "p0-bank-b-$suffix" } $serviceKey | Out-Null
  Add-ServiceRow "bank_allocations" @{ id = (New-Id); org_id = $orgA; bank_transaction_id = $bankTransactionA; payment_id = $paymentA; amount = 30; created_by = $accounts.officeA.Id } $serviceKey | Out-Null
  Add-ServiceRow "bank_allocations" @{ id = (New-Id); org_id = $orgB; bank_transaction_id = $bankTransactionB; payment_id = $paymentB; amount = 50; created_by = $accounts.officeB.Id } $serviceKey | Out-Null
  Add-ServiceRow "monthly_exports" @{ id = (New-Id); org_id = $orgA; month = "2026-07-01"; status = "sent"; invoice_ids = @($invoiceA); sent_by = $accounts.accountantA.Id } $serviceKey | Out-Null
  Add-ServiceRow "monthly_exports" @{ id = (New-Id); org_id = $orgB; month = "2026-07-01"; status = "sent"; invoice_ids = @($invoiceB); sent_by = $accounts.accountantB.Id } $serviceKey | Out-Null
  Add-ServiceRow "audit_logs" @{ org_id = $orgA; user_id = $accounts.ownerA.Id; action = "persona_fixture"; entity_type = "suppliers"; entity_id = $supplierA; reason = "P0 persona matrix" } $serviceKey | Out-Null

  foreach ($account in $accounts.Values) { Sign-InTestUser $account $anonKey }

  # One real API policy per tenant role, plus a second tenant and a platform operator.
  $rows = Get-Rows "suppliers?select=id,org_id" $accounts.ownerA $anonKey "owner tenant read"
  Assert-Count $rows 1 "owner sees one own supplier"
  Assert-True ($rows[0].id -eq $supplierA) "owner cannot see tenant B supplier"
  Assert-Count (Get-Rows "invoices?select=id&order=id" $accounts.officeA $anonKey "office tenant read") 2 "office sees tenant A procurement invoices"
  Assert-Count (Get-Rows "products?select=id" $accounts.kitchenA $anonKey "kitchen tenant read") 1 "kitchen sees only tenant A product"
  $accountantInvoices = Get-Rows "invoices?select=id,review_status&order=id" $accounts.accountantA $anonKey "accountant approved invoice read"
  Assert-Count $accountantInvoices 1 "accountant sees approved invoices only"
  Assert-True ($accountantInvoices[0].id -eq $invoiceA -and $accountantInvoices[0].review_status -eq "approved") "accountant cannot see an unapproved invoice"
  $balances = Get-Rows "invoice_balances?select=invoice_id,balance" $accounts.accountantA $anonKey "accountant balance view"
  Assert-Count $balances 1 "accountant balance view is tenant scoped"
  Assert-True ([decimal]$balances[0].balance -eq 70) "invoice balance is computed from tenant-explicit allocations"
  $balancesB = Get-Rows "invoice_balances?select=invoice_id,balance" $accounts.accountantB $anonKey "tenant B accountant balance view"
  Assert-Count $balancesB 1 "tenant B balance view is independently scoped"
  Assert-True ($balancesB[0].invoice_id -eq $invoiceB -and [decimal]$balancesB[0].balance -eq 150) "tenant A allocation cannot affect tenant B balance"
  Assert-Count (Get-Rows "products?select=id" $accounts.accountantA $anonKey "accountant catalog negative read") 0 "accountant cannot read the product catalog"
  Assert-Count (Get-Rows "purchase_requests?select=id" $accounts.accountantA $anonKey "accountant purchase request negative read") 0 "accountant cannot read purchase requests"
  Assert-Count (Get-Rows "purchase_orders?select=id" $accounts.accountantA $anonKey "accountant linked order context") 1 "accountant sees only approved-invoice order context"
  Assert-Count (Get-Rows "goods_receipts?select=id" $accounts.accountantA $anonKey "accountant linked receipt context") 1 "accountant sees only approved-invoice receipt context"
  Assert-Count (Get-Rows "supplier_metrics?select=supplier_id" $accounts.accountantA $anonKey "accountant supplier metrics negative read") 0 "accountant cannot read procurement supplier metrics"
  Assert-Count (Get-Rows "payments?select=id" $accounts.officeA $anonKey "office payments negative read") 0 "office cannot read payments"
  Assert-Count (Get-Rows "bank_transactions?select=id" $accounts.officeA $anonKey "office bank negative read") 0 "office cannot read bank transactions"
  Assert-Count (Get-Rows "monthly_exports?select=id" $accounts.officeA $anonKey "office exports negative read") 0 "office cannot read monthly exports"
  Assert-Count (Get-Rows "audit_logs?action=eq.persona_fixture&select=id" $accounts.officeA $anonKey "office financial audit negative read") 0 "office cannot read financial audit"
  Assert-Count (Get-Rows "payments?select=id" $accounts.accountantA $anonKey "accountant payments read") 1 "accountant reads tenant-scoped payments"
  Assert-Count (Get-Rows "bank_transactions?select=id" $accounts.accountantA $anonKey "accountant bank read") 1 "accountant reads tenant-scoped bank transactions"
  Assert-Count (Get-Rows "monthly_exports?select=id" $accounts.accountantA $anonKey "accountant exports read") 1 "accountant reads tenant-scoped exports"
  Assert-Count (Get-Rows "audit_logs?action=eq.persona_fixture&select=id" $accounts.accountantA $anonKey "accountant financial audit read") 1 "accountant reads tenant-scoped financial audit"
  Assert-Count (Get-Rows "payment_requests?select=id" $accounts.payerA $anonKey "payer approved queue read") 1 "payer sees only tenant A approved request"
  Assert-Count (Get-Rows "supplier_products?select=id" $accounts.supplierA $anonKey "supplier-agent price read") 1 "supplier agent sees only its supplier prices"
  Assert-Count (Get-Rows "suppliers?id=eq.$supplierA&select=id" $accounts.ownerB $anonKey "tenant B negative read") 0 "tenant B cannot read tenant A supplier"
  Assert-Count (Get-Rows "suppliers?select=id" $accounts.platform $anonKey "platform tenant-data negative read") 0 "platform operator has no implicit tenant data access"
  Assert-True ((Get-Rows "rpc/platform_orgs" $accounts.platform $anonKey "platform organization aggregate").Count -ge 3) "platform operator uses aggregate RPC"

  # Immutable identity and reasoned access/lifecycle commands.
  $response = Invoke-Rest -Method Patch -Resource "profiles?id=eq.$($accounts.ownerA.Id)" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ full_name = "Owner A Updated" } -Prefer "return=representation"
  Assert-Status $response @(200) "self-service profile name update"
  Assert-True (@($response.Json)[0].role -eq "owner") "self-service update preserves access fields"
  $response = Invoke-Rest -Method Patch -Resource "profiles?id=eq.$($accounts.ownerA.Id)" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ role = "kitchen" } -Prefer "return=representation"
  Assert-Blocked $response "self-service role escalation blocked"
  $response = Invoke-Rest -Method Patch -Resource "profiles?id=eq.$($accounts.officeA.Id)" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ active = $false } -Prefer "return=representation"
  Assert-Blocked $response "owner direct access-field update blocked"
  $response = Invoke-Rest -Method Patch -Resource "profiles?id=eq.$($accounts.officeA.Id)" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ org_id = $orgB } -Prefer "return=representation"
  Assert-Blocked $response "owner cannot transfer a member to another tenant"
  $response = Invoke-Rest -Method Patch -Resource "profiles?id=eq.$($accounts.ownerA.Id)" -ApiKey $anonKey -Token $accounts.platform.Token -Body @{ role = "kitchen" } -Prefer "return=representation"
  Assert-Status $response @(200) "platform JWT direct profile update returns no rows"
  Assert-Count $response.Json 0 "platform JWT cannot bypass profile guard or RLS"
  $response = Invoke-Rest -Method Post -Resource "rpc/manage_profile_access" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_profile_id = $accounts.officeA.Id; p_role = "office"; p_active = $false; p_supplier_id = $null; p_reason = "P0 temporary access test" }
  Assert-Status $response @(204) "reasoned profile access command"
  Assert-Count (Get-Rows "invoices?select=id" $accounts.officeA $anonKey "inactive profile negative read") 0 "inactive profile loses tenant access"
  $response = Invoke-Rest -Method Post -Resource "rpc/manage_profile_access" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_profile_id = $accounts.officeA.Id; p_role = "office"; p_active = $true; p_supplier_id = $null; p_reason = "P0 restore after test" }
  Assert-Status $response @(204) "restore profile through audited command"
  $response = Invoke-Rest -Method Post -Resource "rpc/manage_profile_access" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_profile_id = $accounts.officeA.Id; p_role = "supplier"; p_active = $true; p_supplier_id = $supplierB; p_reason = "cross-tenant supplier attempt" }
  Assert-Blocked $response "profile access command rejects another tenant supplier"
  $auditRows = Get-Rows "audit_logs?action=eq.profile_access_changed&entity_id=eq.$($accounts.officeA.Id)&select=user_id,reason,old_values,new_values&order=created_at.desc&limit=2" $accounts.ownerA $anonKey "profile access audit read"
  Assert-Count $auditRows 2 "profile access changes are auditable"
  Assert-True ($auditRows[0].user_id -eq $accounts.ownerA.Id -and [bool]$auditRows[0].reason) "profile access audit records actor and reason"

  $response = Invoke-Rest -Method Patch -Resource "organizations?id=eq.$orgA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ name = "P0 Tenant A Renamed" } -Prefer "return=representation"
  Assert-Status $response @(200) "tenant-owned organization field update"
  $response = Invoke-Rest -Method Patch -Resource "organizations?id=eq.$orgA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ status = "suspended" } -Prefer "return=representation"
  Assert-Blocked $response "owner direct organization lifecycle update blocked"
  $response = Invoke-Rest -Method Patch -Resource "organizations?id=eq.$orgSuspended" -ApiKey $anonKey -Token $accounts.platform.Token -Body @{ status = "suspended" } -Prefer "return=representation"
  Assert-Blocked $response "platform direct organization lifecycle update blocked"
  $response = Invoke-Rest -Method Get -Resource "organizations?id=eq.$orgSuspended&select=status" -ApiKey $serviceKey -Token $serviceKey
  Assert-Status $response @(200) "platform direct lifecycle verification read"
  Assert-True (@($response.Json)[0].status -eq "active") "platform direct lifecycle update changes nothing"
  $response = Invoke-Rest -Method Post -Resource "rpc/set_organization_lifecycle" -ApiKey $anonKey -Token $accounts.platform.Token -Body @{ p_org_id = $orgSuspended; p_status = "suspended"; p_trial_ends_at = $null; p_reason = "P0 suspended-tenant test" }
  Assert-Status $response @(204) "platform lifecycle command"
  Assert-Count (Get-Rows "profiles?select=id" $accounts.ownerSuspended $anonKey "suspended tenant negative read") 0 "suspended tenant loses profile and organization plane"
  $response = Invoke-Rest -Method Post -Resource "rpc/execute_payment_request" -ApiKey $anonKey -Token $accounts.payerSuspended.Token -Body @{
    p_payment_request_id = $paymentRequestA
    p_paid_date = "2026-07-22"
    p_method = "bank transfer"
    p_reference = "P0-P1-SUSPENDED"
    p_notes = $null
    p_allocations = @(@{ invoice_id = $invoiceA; credit_id = $null; amount = 100 })
    p_reason = "suspended tenant must not execute payments"
  }
  Assert-Blocked $response "suspended tenant cannot execute P1 payment command"
  $response = Invoke-Rest -Method Get -Resource "audit_logs?action=eq.organization_lifecycle_changed&entity_id=eq.$orgSuspended&select=user_id,reason&limit=1" -ApiKey $serviceKey -Token $serviceKey
  Assert-Status $response @(200) "trusted lifecycle audit verification"
  $lifecycleAudit = @($response.Json)
  Assert-Count $lifecycleAudit 1 "lifecycle command writes audit"
  Assert-True ($lifecycleAudit[0].user_id -eq $accounts.platform.Id -and [bool]$lifecycleAudit[0].reason) "lifecycle audit records actor and reason"

  # Server-authored audit, no browser fabrication, and no financial hard delete.
  $response = Invoke-Rest -Method Patch -Resource "suppliers?id=eq.$supplierA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ notes = "P0 audited update" } -Prefer "return=representation"
  Assert-Status $response @(200) "sensitive row mutation"
  $mutationAudit = Get-Rows "audit_logs?action=eq.update&entity_type=eq.suppliers&entity_id=eq.$supplierA&select=user_id,old_values,new_values&order=created_at.desc&limit=1" $accounts.ownerA $anonKey "server mutation audit read"
  Assert-Count $mutationAudit 1 "real mutation creates server audit row"
  Assert-True ($mutationAudit[0].user_id -eq $accounts.ownerA.Id -and $null -ne $mutationAudit[0].old_values -and $null -ne $mutationAudit[0].new_values) "mutation audit captures actor and before/after values"
  $response = Invoke-Rest -Method Post -Resource "audit_logs" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ org_id = $orgA; action = "fabricated"; entity_type = "suppliers" } -Prefer "return=representation"
  Assert-Blocked $response "browser audit fabrication blocked"
  $response = Invoke-Rest -Method Delete -Resource "invoices?id=eq.$invoiceA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Prefer "return=representation"
  Assert-Blocked $response "financial hard delete grant removed"
  $response = Invoke-Rest -Method Delete -Resource "payments?id=eq.$paymentA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Prefer "return=representation"
  Assert-Blocked $response "payment hard delete grant removed"
  $response = Invoke-Rest -Method Delete -Resource "payment_allocations?payment_id=eq.$paymentA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Prefer "return=representation"
  Assert-Blocked $response "allocation hard delete grant removed"
  $response = Invoke-Rest -Method Post -Resource "payments" -ApiKey $anonKey -Token $accounts.payerA.Token -Body @{ id = (New-Id); org_id = $orgA; supplier_id = $supplierA; amount = 1; executed_by = $accounts.payerA.Id } -Prefer "return=representation"
  Assert-Blocked $response "payer direct payment insert blocked after P1 cutover"
  $response = Invoke-Rest -Method Post -Resource "payment_allocations" -ApiKey $anonKey -Token $accounts.payerA.Token -Body @{ id = (New-Id); org_id = $orgA; payment_id = $paymentA; invoice_id = $invoiceA; amount = 1 } -Prefer "return=representation"
  Assert-Blocked $response "payer direct allocation insert blocked after P1 cutover"
  $response = Invoke-Rest -Method Patch -Resource "payment_requests?id=eq.$paymentRequestA" -ApiKey $anonKey -Token $accounts.payerA.Token -Body @{ status = "sent_for_execution" } -Prefer "return=representation"
  Assert-Blocked $response "payer direct payment-request update blocked after P1 cutover"
  $blockedCreditId = New-Id
  $response = Invoke-Rest -Method Post -Resource "credit_requests" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ id = $blockedCreditId; org_id = $orgA; supplier_id = $supplierA; invoice_id = $invoiceA; reason = "other"; amount = 1; status = "open"; created_by = $accounts.ownerA.Id } -Prefer "return=representation"
  Assert-Blocked $response "owner direct credit insert blocked after P1 cutover"
  $response = Invoke-Rest -Method Patch -Resource "credit_requests?id=eq.$blockedCreditId" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ status = "requested" } -Prefer "return=representation"
  Assert-Blocked $response "owner direct credit update blocked after P1 cutover"

  # Personal drafts are creator-only and item replacement stays behind its RPC.
  $draftBody = @{ p_request_id = $null; p_notes = "Kitchen private draft"; p_expected_date = $null; p_editor_step = 1; p_items = @(@{ product_id = $productA; qty = 2; chosen_supplier_id = $supplierA }) }
  $response = Invoke-Rest -Method Post -Resource "rpc/save_purchase_request_draft" -ApiKey $anonKey -Token $accounts.kitchenA.Token -Body $draftBody
  Assert-Status $response @(200) "kitchen creates personal draft through RPC"
  $kitchenDraft = [string]$response.Json.request_id
  $draftBody.p_notes = "Owner private draft"
  $response = Invoke-Rest -Method Post -Resource "rpc/save_purchase_request_draft" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body $draftBody
  Assert-Status $response @(200) "owner creates separate personal draft"
  $ownerDraft = [string]$response.Json.request_id
  $kitchenRows = Get-Rows "purchase_requests?status=eq.draft&select=id" $accounts.kitchenA $anonKey "kitchen personal drafts read"
  Assert-Count $kitchenRows 1 "kitchen sees only its own draft"
  Assert-True ($kitchenRows[0].id -eq $kitchenDraft) "kitchen cannot see owner draft"
  $ownerRows = Get-Rows "purchase_requests?status=eq.draft&select=id" $accounts.ownerA $anonKey "owner personal drafts read"
  Assert-Count $ownerRows 1 "owner sees only its own draft"
  Assert-True ($ownerRows[0].id -eq $ownerDraft) "owner cannot see kitchen draft"
  Assert-Count (Get-Rows "purchase_requests?status=eq.draft&select=id" $accounts.accountantA $anonKey "accountant draft negative read") 0 "accountant cannot see another user's drafts"
  $draftBody.p_request_id = $kitchenDraft
  $draftBody.p_notes = "Kitchen replaced draft"
  $draftBody.p_items = @(@{ product_id = $productA; qty = 3; chosen_supplier_id = $supplierA })
  $response = Invoke-Rest -Method Post -Resource "rpc/save_purchase_request_draft" -ApiKey $anonKey -Token $accounts.kitchenA.Token -Body $draftBody
  Assert-Status $response @(200) "atomic draft item replacement"
  $draftItems = Get-Rows "purchase_request_items?request_id=eq.$kitchenDraft&select=qty" $accounts.kitchenA $anonKey "draft items read"
  Assert-Count $draftItems 1 "draft replacement leaves one item"
  Assert-True ([decimal]$draftItems[0].qty -eq 3) "draft replacement persists current quantity"
  $response = Invoke-Rest -Method Post -Resource "rpc/cancel_purchase_request_draft" -ApiKey $anonKey -Token $accounts.officeA.Token -Body @{ p_request_id = $kitchenDraft; p_reason = "cross-user attempt" }
  Assert-Blocked $response "same-tenant user cannot cancel another user's draft"
  $response = Invoke-Rest -Method Post -Resource "rpc/cancel_purchase_request_draft" -ApiKey $anonKey -Token $accounts.kitchenA.Token -Body @{ p_request_id = $kitchenDraft; p_reason = "P0 draft cancellation" }
  Assert-Status $response @(204) "creator cancels draft with reason"
  $draftAudit = Get-Rows "audit_logs?action=eq.purchase_request_cancelled&entity_id=eq.$kitchenDraft&select=user_id,reason&limit=1" $accounts.ownerA $anonKey "draft cancellation audit read"
  Assert-Count $draftAudit 1 "draft cancellation is audited"
  Assert-True ($draftAudit[0].user_id -eq $accounts.kitchenA.Id -and [bool]$draftAudit[0].reason) "draft audit records creator and reason"

  # Invitations have bounded delivery and audited revocation.
  $response = Invoke-Rest -Method Post -Resource "rpc/create_invitation" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_email = "invite-$suffix@example.test"; p_role = "office" }
  Assert-Status $response @(200) "owner creates invitation"
  $invitationId = [string]$response.Json.invitation_id
  $response = Invoke-Rest -Method Post -Resource "rpc/resend_invitation" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_id = $invitationId }
  Assert-Blocked $response "invitation resend cooldown enforced"
  Assert-True ($response.Content -match "invite_cooldown") "invitation cooldown exposes a stable error code"
  $response = Invoke-Rest -Method Post -Resource "rpc/revoke_invitation" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ p_id = $invitationId; p_reason = "P0 invitation revocation" }
  Assert-Status $response @(204) "invitation revoked with reason"
  $inviteAudit = Get-Rows "audit_logs?action=eq.invitation_revoked&entity_id=eq.$invitationId&select=user_id,reason&limit=1" $accounts.ownerA $anonKey "invitation audit read"
  Assert-Count $inviteAudit 1 "invitation revocation is audited"
  Assert-True ($inviteAudit[0].user_id -eq $accounts.ownerA.Id -and [bool]$inviteAudit[0].reason) "invitation audit records actor and reason"

  # Composite tenant constraints are tested through service-role PostgREST, which bypasses
  # RLS but not database integrity. Every request below is otherwise structurally valid.
  $crossCases = @(
    @{ table = "supplier_products"; row = @{ id = (New-Id); org_id = $orgA; supplier_id = $supplierA; product_id = $productB; current_price = 5 }; label = "catalog composite tenant FK" },
    @{ table = "price_history"; row = @{ id = (New-Id); org_id = $orgA; supplier_product_id = $supplierProductA; price = 11; created_by = $accounts.ownerB.Id }; label = "actor composite tenant FK" },
    @{ table = "purchase_orders"; row = @{ id = (New-Id); org_id = $orgA; supplier_id = $supplierB; request_id = $requestA; status = "ready"; created_by = $accounts.officeA.Id }; label = "procurement parent composite tenant FK" },
    @{ table = "purchase_order_items"; row = @{ id = (New-Id); org_id = $orgA; order_id = $orderA; product_id = $productB; qty = 1; unit_price = 1 }; label = "procurement child composite tenant FK" },
    @{ table = "invoice_order_links"; row = @{ org_id = $orgA; invoice_id = $invoiceA; order_id = $orderB }; label = "invoice junction composite tenant FK" },
    @{ table = "payment_request_invoices"; row = @{ org_id = $orgA; payment_request_id = $paymentRequestA; invoice_id = $invoiceB; amount_allocated = 1 }; label = "payment request junction composite tenant FK" },
    @{ table = "payment_allocations"; row = @{ id = (New-Id); org_id = $orgA; payment_id = $paymentA; invoice_id = $invoiceB; amount = 1 }; label = "payment allocation composite tenant FK" },
    @{ table = "bank_transactions"; row = @{ id = (New-Id); org_id = $orgA; import_id = $bankImportB; tx_date = "2026-07-03"; description = "cross"; amount = 1; raw = @{ amount = 1 }; row_hash = "cross-bank-$suffix" }; label = "bank transaction composite tenant FK" },
    @{ table = "bank_allocations"; row = @{ id = (New-Id); org_id = $orgA; bank_transaction_id = $bankTransactionA; invoice_id = $invoiceB; amount = 1; created_by = $accounts.officeA.Id }; label = "bank allocation composite tenant FK" },
    @{ table = "documents"; row = @{ id = (New-Id); org_id = $orgA; entity_type = "invoice"; entity_id = $invoiceA; storage_path = "$orgA/invoice/$invoiceA/cross.pdf"; file_name = "cross.pdf"; mime_type = "application/pdf"; uploaded_by = $accounts.ownerB.Id }; label = "document actor composite tenant FK" },
    @{ table = "documents"; row = @{ id = (New-Id); org_id = $orgA; entity_type = "invoice"; entity_id = $invoiceB; storage_path = "$orgA/invoice/$invoiceB/cross-target.pdf"; file_name = "cross-target.pdf"; mime_type = "application/pdf"; uploaded_by = $accounts.ownerA.Id }; label = "document target tenant guard" }
  )
  foreach ($case in $crossCases) {
    $response = Invoke-Rest -Method Post -Resource $case.table -ApiKey $serviceKey -Token $serviceKey -Body $case.row -Prefer "return=representation"
    Assert-Blocked $response $case.label
  }
  $response = Invoke-Rest -Method Post -Resource "suppliers" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ id = (New-Id); org_id = $orgB; name = "Cross tenant RLS" } -Prefer "return=representation"
  Assert-Blocked $response "RLS blocks cross-tenant insert before constraints"
  $response = Invoke-Rest -Method Patch -Resource "suppliers?id=eq.$supplierA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ org_id = $orgB } -Prefer "return=representation"
  Assert-Blocked $response "tenant identity is immutable on update"

  # Storage object access is backed by documents rows and is verified through signed URLs.
  $pdfBytes = [System.Text.Encoding]::UTF8.GetBytes("%PDF-1.4`n% P0 local fixture`n")
  $ownerPath = "$orgA/invoice/$invoiceA/owner-proof.pdf"
  $ownerHeaders = New-Headers $anonKey $accounts.ownerA.Token
  $ownerHeaders["x-upsert"] = "false"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$ownerPath" -Headers $ownerHeaders -ContentType "application/pdf" -Bytes $pdfBytes
  Assert-Status $response @(200) "owner uploads allowlisted object to own tenant prefix"
  $documentA = New-Id
  $response = Invoke-Rest -Method Post -Resource "documents" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ id = $documentA; org_id = $orgA; entity_type = "invoice"; entity_id = $invoiceA; storage_path = $ownerPath; file_name = "owner-proof.pdf"; mime_type = "application/pdf"; uploaded_by = $accounts.ownerA.Id } -Prefer "return=representation"
  Assert-Status $response @(201) "owner registers uploaded object"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.ownerA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "owner obtains signed URL for registered document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.accountantA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "authorized tenant reader obtains signed URL"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.officeA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "office obtains signed URL for allowed document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.kitchenA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "kitchen obtains signed URL for allowed document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.payerA.Token) -Body @{ expiresIn = 60 }
  Assert-Blocked $response "payer cannot sign another user's document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.ownerB.Token) -Body @{ expiresIn = 60 }
  Assert-Blocked $response "other tenant cannot sign document URL"

  $payerPath = "$orgA/payment/$paymentA/payer-proof.pdf"
  $payerHeaders = New-Headers $anonKey $accounts.payerA.Token
  $payerHeaders["x-upsert"] = "false"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$payerPath" -Headers $payerHeaders -ContentType "application/pdf" -Bytes $pdfBytes
  Assert-Status $response @(200) "payer uploads object to own tenant prefix"
  $response = Invoke-Rest -Method Post -Resource "documents" -ApiKey $anonKey -Token $accounts.payerA.Token -Body @{ id = (New-Id); org_id = $orgA; entity_type = "payment"; entity_id = $paymentA; storage_path = $payerPath; file_name = "payer-proof.pdf"; mime_type = "application/pdf"; uploaded_by = $accounts.payerA.Id } -Prefer "return=representation"
  Assert-Status $response @(201) "payer registers only its executed payment document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$payerPath" -Headers (New-Headers $anonKey $accounts.payerA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "payer signs its own document URL"

  $tenantBPath = "$orgB/invoice/$invoiceB/tenant-b-proof.pdf"
  $tenantBHeaders = New-Headers $anonKey $accounts.ownerB.Token
  $tenantBHeaders["x-upsert"] = "false"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$tenantBPath" -Headers $tenantBHeaders -ContentType "application/pdf" -Bytes $pdfBytes
  Assert-Status $response @(200) "tenant B owner uploads own object"
  $response = Invoke-Rest -Method Post -Resource "documents" -ApiKey $anonKey -Token $accounts.ownerB.Token -Body @{ id = (New-Id); org_id = $orgB; entity_type = "invoice"; entity_id = $invoiceB; storage_path = $tenantBPath; file_name = "tenant-b-proof.pdf"; mime_type = "application/pdf"; uploaded_by = $accounts.ownerB.Id } -Prefer "return=representation"
  Assert-Status $response @(201) "tenant B registers its document"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$tenantBPath" -Headers (New-Headers $anonKey $accounts.ownerB.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "tenant B owner signs own document URL"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$tenantBPath" -Headers (New-Headers $anonKey $accounts.ownerA.Token) -Body @{ expiresIn = 60 }
  Assert-Blocked $response "tenant A cannot sign known tenant B document path"

  $crossPath = "$orgB/invoice/$invoiceB/cross-prefix.pdf"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$crossPath" -Headers $ownerHeaders -ContentType "application/pdf" -Bytes $pdfBytes
  Assert-Blocked $response "storage upload rejects another tenant prefix"
  $unsafePath = "$orgA/invoice/$invoiceA/unsafe.txt"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$unsafePath" -Headers $ownerHeaders -ContentType "text/plain" -Bytes ([System.Text.Encoding]::UTF8.GetBytes("unsafe"))
  Assert-Blocked $response "storage upload rejects non-allowlisted MIME"
  $orphanPath = "$orgA/inbox/$($accounts.ownerA.Id)/orphan.pdf"
  $response = Invoke-BinaryRequest -Method Post -Uri "$apiUrl/storage/v1/object/documents/$orphanPath" -Headers $ownerHeaders -ContentType "application/pdf" -Bytes $pdfBytes
  Assert-Status $response @(200) "owner uploads temporary orphan"
  $response = Invoke-JsonRequest -Method Delete -Uri "$apiUrl/storage/v1/object/documents" -Headers (New-Headers $anonKey $accounts.ownerA.Token) -Body @{ prefixes = @($orphanPath) }
  Assert-Status $response @(200) "uploader can delete unregistered orphan"
  $response = Invoke-Rest -Method Patch -Resource "documents?id=eq.$documentA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Body @{ deleted_at = "2026-07-22T12:00:00Z"; deleted_by = $accounts.ownerA.Id } -Prefer "return=representation"
  Assert-Status $response @(200) "document soft delete records actor and timestamp"
  $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/storage/v1/object/sign/documents/$ownerPath" -Headers (New-Headers $anonKey $accounts.ownerA.Token) -Body @{ expiresIn = 60 }
  Assert-Status $response @(200) "soft-deleted document bytes remain retained"
  $response = Invoke-Rest -Method Delete -Resource "documents?id=eq.$documentA" -ApiKey $anonKey -Token $accounts.ownerA.Token -Prefer "return=representation"
  Assert-Blocked $response "document row hard delete grant removed"
  $response = Invoke-JsonRequest -Method Delete -Uri "$apiUrl/storage/v1/object/documents" -Headers (New-Headers $anonKey $accounts.ownerA.Token) -Body @{ prefixes = @($ownerPath) }
  Assert-Status $response @(200) "registered object delete request is safely empty"
  Assert-Count $response.Json 0 "registered document object cannot be hard deleted"

  $response = Invoke-Rest -Method Post -Resource "rpc/set_organization_lifecycle" -ApiKey $anonKey -Token $accounts.platform.Token -Body @{ p_org_id = $orgA; p_status = "suspended"; p_trial_ends_at = $null; p_reason = "P0 all-role suspension test" }
  Assert-Status $response @(204) "suspend active tenant after positive matrix"
  foreach ($roleAccount in @($accounts.ownerA, $accounts.officeA, $accounts.kitchenA, $accounts.payerA, $accounts.accountantA, $accounts.supplierA)) {
    Assert-Count (Get-Rows "profiles?select=id" $roleAccount $anonKey "suspended all-role negative read") 0 "every tenant role loses access after suspension"
  }

  if ($ServePushFunction) {
    if (-not $PushSecret) { $PushSecret = "P0-$([guid]::NewGuid().ToString('N'))" }
    $pushServer = Start-LocalPushFunction $environment $PushSecret
  }

  if ($PushSecret) {
    $activeEventKey = "p0-edge-active-$suffix"
    $suspendedEventKey = "p0-edge-suspended-$suffix"
    $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/functions/v1/send-push" -Headers @{ "x-push-secret" = $PushSecret } -Body @{ event = "price_increase"; org_id = $orgB; payload = @{ count = 1; event_key = $activeEventKey } }
    Assert-Status $response @(200) "active tenant push event accepted"
    Assert-True ([int]$response.Json.notifications -eq 2) "active tenant selects its owner and office recipients"
    $response = Invoke-JsonRequest -Method Post -Uri "$apiUrl/functions/v1/send-push" -Headers @{ "x-push-secret" = $PushSecret } -Body @{ event = "price_increase"; org_id = $orgA; payload = @{ count = 1; event_key = $suspendedEventKey } }
    Assert-Status $response @(200) "suspended tenant push event handled safely"
    Assert-True ([int]$response.Json.notifications -eq 0) "service-role push path selects no suspended recipient"
    $response = Invoke-Rest -Method Get -Resource "notifications?dedupe_key=eq.price_increase:$activeEventKey&select=org_id" -ApiKey $serviceKey -Token $serviceKey
    Assert-Status $response @(200) "trusted active push verification"
    Assert-Count $response.Json 2 "active push writes exactly two notifications"
    $response = Invoke-Rest -Method Get -Resource "notifications?dedupe_key=eq.price_increase:$suspendedEventKey&select=org_id" -ApiKey $serviceKey -Token $serviceKey
    Assert-Status $response @(200) "trusted suspended push verification"
    Assert-Count $response.Json 0 "suspended push writes no notification rows"
  } else {
    Write-Host "SKIP live local send-push check (pass -PushSecret while the function is served)."
  }

  Write-Output "P0 security acceptance passed: $script:Passed assertions."
}
finally {
  if ($pushServer) {
    if (-not $pushServer.Process.HasExited) { Stop-Process -Id $pushServer.Process.Id -Force }
    Remove-Item -LiteralPath $pushServer.StdoutPath, $pushServer.StderrPath, $pushServer.EnvPath -Force -ErrorAction SilentlyContinue
  }
  if (-not $KeepFixture) {
    Reset-TestDatabase
  } else {
    Write-Output "Local P0 fixture retained for debugging; no credentials were printed."
  }
}
