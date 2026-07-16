param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$SpreadsheetId = '16ko37-omRLDxdKXOX-VRwsCG3VyMerAO4EPBX_T10M8',
  [string]$Region = 'asia-east1',
  [string]$JobName = 'flyingmouse-inventory-writeback',
  [string]$Repository = 'line-automation',
  [string]$ServiceAccountName = 'line-replenishment',
  [string]$Schedule = '*/5 * * * *',
  [string]$TimeZone = 'Asia/Taipei',
  [ValidateSet('dry-run', 'live')]
  [string]$Mode = 'dry-run',
  [ValidateRange(1, 100)]
  [int]$Limit = 20,
  [switch]$ApproveLive,
  [switch]$SkipSchedule,
  [switch]$ExecuteNow
)

$ErrorActionPreference = 'Stop'

if ($Mode -eq 'live' -and -not $ApproveLive) {
  throw 'Live mode requires the explicit -ApproveLive switch.'
}

function Resolve-GcloudCommand {
  $command = Get-Command 'gcloud.cmd' -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command 'gcloud' -ErrorAction SilentlyContinue }
  if ($command) { return $command.Source }
  throw 'gcloud was not found. Install Google Cloud CLI and run gcloud auth login.'
}

$gcloud = Resolve-GcloudCommand

function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFailure)
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $gcloud @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "gcloud command failed: $(($Arguments | Select-Object -First 4) -join ' ')"
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = $output }
}

$serviceAccount = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
$schedulerName = "$JobName-every-5-minutes"
$imageTag = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/flyingmouse-sync:$imageTag"
$secretNames = @('flyingmouse-username', 'flyingmouse-password')

(Invoke-Gcloud -Arguments @('config', 'set', 'project', $ProjectId)).Output | Out-Null
(Invoke-Gcloud -Arguments @(
  'services', 'enable',
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudscheduler.googleapis.com',
  'sheets.googleapis.com',
  '--project', $ProjectId
)).Output | Out-Null

$accountProbe = Invoke-Gcloud -Arguments @(
  'iam', 'service-accounts', 'describe', $serviceAccount,
  '--project', $ProjectId
) -AllowFailure
if ($accountProbe.ExitCode -ne 0) {
  throw "Service account does not exist: $serviceAccount"
}

foreach ($secret in $secretNames) {
  $versionProbe = Invoke-Gcloud -Arguments @(
    'secrets', 'versions', 'list', $secret,
    '--project', $ProjectId,
    '--filter=state=ENABLED',
    '--format=value(name)'
  ) -AllowFailure
  if ($versionProbe.ExitCode -ne 0 -or $versionProbe.Output.Count -eq 0) {
    throw "Secret $secret has no enabled version. Run scripts/configure-flyingmouse-secrets.ps1 first."
  }
  (Invoke-Gcloud -Arguments @(
    'secrets', 'add-iam-policy-binding', $secret,
    '--project', $ProjectId,
    '--member', "serviceAccount:$serviceAccount",
    '--role', 'roles/secretmanager.secretAccessor',
    '--quiet'
  )).Output | Out-Null
}

$repositoryProbe = Invoke-Gcloud -Arguments @(
  'artifacts', 'repositories', 'describe', $Repository,
  '--project', $ProjectId,
  '--location', $Region
) -AllowFailure
if ($repositoryProbe.ExitCode -ne 0) {
  (Invoke-Gcloud -Arguments @(
    'artifacts', 'repositories', 'create', $Repository,
    '--project', $ProjectId,
    '--location', $Region,
    '--repository-format=docker',
    '--description=LINE automation jobs'
  )).Output | Out-Null
}

(Invoke-Gcloud -Arguments @(
  'builds', 'submit', '.',
  '--project', $ProjectId,
  '--region', $Region,
  '--config', 'cloudbuild.flyingmouse.yaml',
  '--ignore-file', '.gcloudignore.flyingmouse',
  '--substitutions', "_IMAGE=$image",
  '--quiet'
)).Output | Out-Null

(Invoke-Gcloud -Arguments @(
  'run', 'jobs', 'deploy', $JobName,
  '--project', $ProjectId,
  '--region', $Region,
  '--image', $image,
  '--service-account', $serviceAccount,
  '--tasks', '1',
  '--max-retries', '0',
  '--task-timeout', '5m',
  '--cpu', '1',
  '--memory', '1Gi',
  '--command', 'node',
  '--args', 'scripts/flyingmouse-inventory-writeback.mjs,--ensure-sheet',
  '--set-env-vars', "SPREADSHEET_ID=$SpreadsheetId,FLYINGMOUSE_WRITEBACK_MODE=$Mode,FLYINGMOUSE_WRITEBACK_LIMIT=$Limit,FLYINGMOUSE_ADMIN_URL=https://ss-select.fslol.com/admin/dashboard,FLYINGMOUSE_PRODUCT_LIST_URL=https://ss-select.fslol.com/admin/part/list/*",
  '--set-secrets', 'FLYINGMOUSE_USERNAME=flyingmouse-username:latest,FLYINGMOUSE_PASSWORD=flyingmouse-password:latest',
  '--labels', "component=flyingmouse-writeback,mode=$Mode",
  '--quiet'
)).Output | Out-Null

if (-not $SkipSchedule) {
  (Invoke-Gcloud -Arguments @(
    'run', 'jobs', 'add-iam-policy-binding', $JobName,
    '--project', $ProjectId,
    '--region', $Region,
    '--member', "serviceAccount:$serviceAccount",
    '--role', 'roles/run.invoker',
    '--quiet'
  )).Output | Out-Null

  $schedulerProbe = Invoke-Gcloud -Arguments @(
    'scheduler', 'jobs', 'describe', $schedulerName,
    '--project', $ProjectId,
    '--location', $Region
  ) -AllowFailure
  $schedulerCommand = if ($schedulerProbe.ExitCode -eq 0) { 'update' } else { 'create' }
  $headerFlag = if ($schedulerCommand -eq 'update') { '--update-headers' } else { '--headers' }
  $jobUri = "https://run.googleapis.com/v2/projects/$ProjectId/locations/$Region/jobs/$JobName`:run"

  (Invoke-Gcloud -Arguments @(
    'scheduler', 'jobs', $schedulerCommand, 'http', $schedulerName,
    '--project', $ProjectId,
    '--location', $Region,
    '--schedule', $Schedule,
    '--time-zone', $TimeZone,
    '--uri', $jobUri,
    '--http-method', 'POST',
    '--oauth-service-account-email', $serviceAccount,
    '--oauth-token-scope', 'https://www.googleapis.com/auth/cloud-platform',
    $headerFlag, 'Content-Type=application/json',
    '--message-body', '{}',
    '--quiet'
  )).Output | Out-Null
}

if ($ExecuteNow) {
  (Invoke-Gcloud -Arguments @(
    'run', 'jobs', 'execute', $JobName,
    '--project', $ProjectId,
    '--region', $Region,
    '--wait'
  )).Output | Out-Null
}

Write-Host "Cloud Run Job: $JobName"
Write-Host "Image: $image"
Write-Host "Mode: $Mode"
if (-not $SkipSchedule) { Write-Host "Schedule: $Schedule ($TimeZone)" }
if ($Mode -eq 'dry-run') {
  Write-Host 'Dry-run is active: the job will not send FlyingMouse PUT requests.'
}
