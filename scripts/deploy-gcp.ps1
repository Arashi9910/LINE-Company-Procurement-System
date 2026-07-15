param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$LineLoginChannelId,

  [Parameter(Mandatory = $true)]
  [string]$LiffId,

  [string]$SpreadsheetId = '16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8',
  [string]$Region = 'asia-east1',
  [string]$ServiceName = 'line-replenishment',
  [string]$BillingAccountId = '',
  [string]$BudgetAmount = '300TWD'
)

$ErrorActionPreference = 'Stop'
$serviceAccountName = 'line-replenishment'
$serviceAccountEmail = "$serviceAccountName@$ProjectId.iam.gserviceaccount.com"
$secretNames = @(
  'line-channel-secret',
  'line-channel-access-token',
  'line-link-signing-secret',
  'line-job-token'
)

if (-not (Get-Command 'git' -ErrorAction SilentlyContinue)) {
  throw 'git was not found. Install Git and run this script from the repository root.'
}

$workingTreeStatus = @(& git status --porcelain --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to inspect the Git working tree.'
}
if ($workingTreeStatus.Count -gt 0) {
  throw 'Working tree must be clean before deployment. Commit or remove local changes first.'
}

$gitCommit = [string](& git rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $gitCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Unable to resolve a full Git commit for deployment.'
}
$gitCommit = $gitCommit.ToLowerInvariant()
$gitShort = $gitCommit.Substring(0, 12)
$packageJsonPath = Join-Path $PSScriptRoot '..\package.json'
$packageVersion = [string]((Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version)
if ($packageVersion -notmatch '^\d+\.\d+\.\d+') {
  throw 'package.json does not contain a valid application version.'
}
$appVersion = "$packageVersion+$gitShort"
$deployedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')

function Resolve-GcloudCommand {
  $command = Get-Command 'gcloud.cmd' -ErrorAction SilentlyContinue
  if (-not $command) {
    $command = Get-Command 'gcloud' -ErrorAction SilentlyContinue
  }
  if ($command) {
    return $command
  }

  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
  }
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) {
    $candidates += Join-Path $programFilesX86 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return [PSCustomObject]@{ Source = $candidate }
    }
  }

  return $command
}

$gcloudCommand = Resolve-GcloudCommand
if (-not $gcloudCommand) {
  throw 'gcloud was not found. Install Google Cloud CLI and run gcloud auth login.'
}
$gcloud = $gcloudCommand.Source

function Invoke-Gcloud {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [switch]$AllowFailure
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $gcloud @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    $operation = ($Arguments | Select-Object -First 3) -join ' '
    throw "gcloud command failed: $operation"
  }

  return [PSCustomObject]@{
    ExitCode = $exitCode
    Output = $output
  }
}

function Get-GcloudOutputText($Result) {
  return (($Result.Output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
}

(Invoke-Gcloud -Arguments @('config', 'set', 'project', $ProjectId)).Output | Out-Null

if ($BillingAccountId) {
  (Invoke-Gcloud -Arguments @(
    'billing', 'projects', 'link', $ProjectId,
    '--billing-account', $BillingAccountId
  )).Output | Out-Null
}

(Invoke-Gcloud -Arguments @(
  'services', 'enable',
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudscheduler.googleapis.com',
  'sheets.googleapis.com',
  'billingbudgets.googleapis.com',
  '--project', $ProjectId
)).Output | Out-Null

$serviceAccountProbe = Invoke-Gcloud -Arguments @(
  'iam', 'service-accounts', 'describe', $serviceAccountEmail,
  '--project', $ProjectId
) -AllowFailure
if ($serviceAccountProbe.ExitCode -ne 0) {
  (Invoke-Gcloud -Arguments @(
    'iam', 'service-accounts', 'create', $serviceAccountName,
    '--project', $ProjectId,
    '--display-name', 'LINE Replenishment Cloud Run'
  )).Output | Out-Null
}

foreach ($secret in $secretNames) {
  $secretProbe = Invoke-Gcloud -Arguments @(
    'secrets', 'versions', 'access', 'latest',
    '--secret', $secret,
    '--project', $ProjectId
  ) -AllowFailure
  if ($secretProbe.ExitCode -ne 0) {
    throw "Secret $secret has no accessible version. Run scripts/configure-secrets.ps1 first."
  }
  (Invoke-Gcloud -Arguments @(
    'secrets', 'add-iam-policy-binding', $secret,
    '--project', $ProjectId,
    '--member', "serviceAccount:$serviceAccountEmail",
    '--role', 'roles/secretmanager.secretAccessor',
    '--quiet'
  )).Output | Out-Null
}

(Invoke-Gcloud -Arguments @(
  'run', 'deploy', $ServiceName,
  '--source', '.',
  '--project', $ProjectId,
  '--region', $Region,
  '--allow-unauthenticated',
  '--service-account', $serviceAccountEmail,
  '--max-instances', '1',
  '--concurrency', '20',
  '--set-env-vars', "SPREADSHEET_ID=$SpreadsheetId,LINE_LOGIN_CHANNEL_ID=$LineLoginChannelId,LIFF_ID=$LiffId,GOOGLE_CLOUD_PROJECT=$ProjectId,APP_VERSION=$appVersion,GIT_COMMIT=$gitCommit,DEPLOYED_AT=$deployedAt",
  '--update-labels', "git-commit=$gitCommit",
  '--startup-probe', 'httpGet.path=/ready,httpGet.port=8080,timeoutSeconds=5,periodSeconds=10,failureThreshold=12',
  '--liveness-probe', 'httpGet.path=/health,httpGet.port=8080,timeoutSeconds=5,periodSeconds=30,failureThreshold=3',
  '--readiness-probe', 'httpGet.path=/ready,httpGet.port=8080,timeoutSeconds=5,periodSeconds=60,failureThreshold=3',
  '--set-secrets', 'LINE_CHANNEL_SECRET=line-channel-secret:latest,LINE_CHANNEL_ACCESS_TOKEN=line-channel-access-token:latest,LINK_SIGNING_SECRET=line-link-signing-secret:latest,JOB_TOKEN=line-job-token:latest',
  '--quiet'
)).Output | Out-Null

$serviceUrlResult = Invoke-Gcloud -Arguments @(
  'run', 'services', 'describe', $ServiceName,
  '--project', $ProjectId,
  '--region', $Region,
  '--format=value(status.url)'
)
$serviceUrl = Get-GcloudOutputText $serviceUrlResult
if (-not $serviceUrl) {
  throw 'Cloud Run did not return a service URL.'
}

$revisionResult = Invoke-Gcloud -Arguments @(
  'run', 'services', 'describe', $ServiceName,
  '--project', $ProjectId,
  '--region', $Region,
  '--format=value(status.latestReadyRevisionName)'
)
$readyRevision = Get-GcloudOutputText $revisionResult
if (-not $readyRevision) {
  throw 'Cloud Run did not return a ready revision.'
}

$ready = $null
for ($attempt = 1; $attempt -le 6; $attempt += 1) {
  try {
    $ready = Invoke-RestMethod -Method Get -Uri "$serviceUrl/ready" -TimeoutSec 15
    if ($ready.ok -and $ready.commit -eq $gitCommit) {
      break
    }
  } catch {
    $ready = $null
  }
  if ($attempt -lt 6) {
    Start-Sleep -Seconds 5
  }
}
if (-not $ready -or -not $ready.ok -or $ready.commit -ne $gitCommit) {
  throw 'The deployed service did not become ready with the expected Git commit.'
}

$jobTokenResult = Invoke-Gcloud -Arguments @(
  'secrets', 'versions', 'access', 'latest',
  '--secret', 'line-job-token',
  '--project', $ProjectId
)
$jobToken = Get-GcloudOutputText $jobTokenResult
if (-not $jobToken) {
  throw 'The reminder job token is empty.'
}
$jobName = 'line-replenishment-reminders'
$jobProbe = Invoke-Gcloud -Arguments @(
  'scheduler', 'jobs', 'describe', $jobName,
  '--project', $ProjectId,
  '--location', $Region
) -AllowFailure
$jobCommand = if ($jobProbe.ExitCode -eq 0) { 'update' } else { 'create' }
$jobHeaderFlag = if ($jobCommand -eq 'update') { '--update-headers' } else { '--headers' }

(Invoke-Gcloud -Arguments @(
  'scheduler', 'jobs', $jobCommand, 'http', $jobName,
  '--project', $ProjectId,
  '--location', $Region,
  '--schedule', '0 10 * * 1-5',
  '--time-zone', 'Asia/Taipei',
  '--uri', "$serviceUrl/jobs/reminders",
  '--http-method', 'POST',
  $jobHeaderFlag, "Authorization=Bearer $jobToken,Content-Type=application/json",
  '--message-body', '{}',
  '--quiet'
)).Output | Out-Null
$jobToken = $null

if ($BillingAccountId) {
  $budgetName = "$ProjectId-monthly-alert"
  $budgetResult = Invoke-Gcloud -Arguments @(
    'billing', 'budgets', 'list',
    '--billing-account', $BillingAccountId,
    '--filter', "displayName=$budgetName",
    '--format=value(name)'
  )
  $existingBudget = Get-GcloudOutputText $budgetResult
  if (-not $existingBudget) {
    (Invoke-Gcloud -Arguments @(
      'billing', 'budgets', 'create',
      '--billing-account', $BillingAccountId,
      '--display-name', $budgetName,
      '--budget-amount', $BudgetAmount,
      '--filter-projects', "projects/$ProjectId",
      '--threshold-rule', 'percent=0.50',
      '--threshold-rule', 'percent=0.90',
      '--threshold-rule', 'percent=1.00'
    )).Output | Out-Null
  }
}

Write-Host "Service account: $serviceAccountEmail"
Write-Host "Cloud Run URL: $serviceUrl"
Write-Host "Application version: $appVersion"
Write-Host "Git commit: $gitCommit"
Write-Host "Ready revision: $readyRevision"
Write-Host 'Budget alerts do not cap spending or stop the service.'
