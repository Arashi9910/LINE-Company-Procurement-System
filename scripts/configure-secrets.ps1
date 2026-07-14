param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId
)

$ErrorActionPreference = 'Stop'

function Resolve-GcloudCommand {
  $command = Get-Command 'gcloud.cmd' -ErrorAction SilentlyContinue
  if (-not $command) {
    $command = Get-Command 'gcloud' -ErrorAction SilentlyContinue
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

    [switch]$AllowFailure,

    [AllowEmptyString()]
    [string]$InputText
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if ($PSBoundParameters.ContainsKey('InputText')) {
      $output = @($InputText | & $gcloud @Arguments 2>$null)
    } else {
      $output = @(& $gcloud @Arguments 2>$null)
    }
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

(Invoke-Gcloud -Arguments @('config', 'set', 'project', $ProjectId)).Output | Out-Null

function Ensure-Secret([string]$Name) {
  $probe = Invoke-Gcloud -Arguments @(
    'secrets', 'describe', $Name,
    '--project', $ProjectId,
    '--format=value(name)'
  ) -AllowFailure
  if ($probe.ExitCode -ne 0) {
    (Invoke-Gcloud -Arguments @(
      'secrets', 'create', $Name,
      '--project', $ProjectId,
      '--replication-policy=automatic'
    )).Output | Out-Null
  }
}

function Add-SecureVersion([string]$Name, [string]$Prompt) {
  Ensure-Secret $Name
  $secure = Read-Host $Prompt -AsSecureString
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  try {
    if ([string]::IsNullOrWhiteSpace($plain)) {
      throw 'Secret values cannot be empty.'
    }
    (Invoke-Gcloud -Arguments @(
      'secrets', 'versions', 'add', $Name,
      '--project', $ProjectId,
      '--data-file=-'
    ) -InputText $plain).Output | Out-Null
  } finally {
    $plain = $null
    $secure.Dispose()
  }
}

function Add-GeneratedVersion([string]$Name) {
  Ensure-Secret $Name
  $bytes = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $plain = [Convert]::ToBase64String($bytes)
  try {
    (Invoke-Gcloud -Arguments @(
      'secrets', 'versions', 'add', $Name,
      '--project', $ProjectId,
      '--data-file=-'
    ) -InputText $plain).Output | Out-Null
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $plain = $null
  }
}

Add-SecureVersion 'line-channel-secret' 'Enter the LINE Messaging API Channel Secret'
Add-SecureVersion 'line-channel-access-token' 'Enter the LINE Messaging API Channel Access Token'
Add-GeneratedVersion 'line-link-signing-secret'
Add-GeneratedVersion 'line-job-token'

Write-Host 'Secret Manager setup is complete. No secret was written to project files.'
