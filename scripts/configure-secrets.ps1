param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [switch]$RotateExistingSecrets,

  [switch]$RotateLineCredentials
)

$ErrorActionPreference = 'Stop'

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

    [switch]$AllowFailure,

    [AllowEmptyString()]
    [string]$InputText
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $temporaryInputPath = $null
  try {
    $ErrorActionPreference = 'Continue'
    if ($PSBoundParameters.ContainsKey('InputText')) {
      $temporaryInputPath = [IO.Path]::GetTempFileName()
      $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
      [IO.File]::WriteAllText($temporaryInputPath, $InputText, $utf8WithoutBom)
      $effectiveArguments = @($Arguments | ForEach-Object {
        if ($_ -eq '--data-file=-') {
          "--data-file=$temporaryInputPath"
        } else {
          $_
        }
      })
      $output = @(& $gcloud @effectiveArguments 2>$null)
    }
    else {
      $output = @(& $gcloud @Arguments 2>$null)
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($temporaryInputPath -and (Test-Path -LiteralPath $temporaryInputPath)) {
      [IO.File]::WriteAllBytes($temporaryInputPath, [byte[]]::new(0))
      Remove-Item -LiteralPath $temporaryInputPath -Force
    }
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

function Test-SecretHasEnabledVersion([string]$Name) {
  $probe = Invoke-Gcloud -Arguments @(
    'secrets', 'versions', 'list', $Name,
    '--project', $ProjectId,
    '--filter=state=ENABLED',
    '--format=value(name)'
  ) -AllowFailure
  return $probe.ExitCode -eq 0 -and $probe.Output.Count -gt 0
}

function Add-SecureVersion(
  [string]$Name,
  [string]$Prompt,
  [int]$MinimumLength
) {
  Ensure-Secret $Name
  if (-not ($RotateExistingSecrets -or $RotateLineCredentials) -and (Test-SecretHasEnabledVersion $Name)) {
    Write-Host "Keeping existing Secret Manager version: $Name"
    return
  }

  $secure = $null
  $plain = $null
  while ($true) {
    $secure = Read-Host $Prompt -AsSecureString
    $plain = [System.Net.NetworkCredential]::new('', $secure).Password
    if (
      -not [string]::IsNullOrWhiteSpace($plain) -and
      $plain.Length -ge $MinimumLength -and
      $plain -notmatch '^\*+$'
    ) {
      break
    }

    $plain = $null
    $secure.Dispose()
    $secure = $null
    Write-Warning "The value was too short or masked. Copy the complete value from LINE Developers and try again."
  }

  try {
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
  if (-not $RotateExistingSecrets -and (Test-SecretHasEnabledVersion $Name)) {
    Write-Host "Keeping existing Secret Manager version: $Name"
    return
  }
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

Add-SecureVersion 'line-channel-secret' 'Paste the complete LINE Messaging API Channel Secret, then press Enter' 16
Add-SecureVersion 'line-channel-access-token' 'Paste the complete LINE Messaging API Channel Access Token, then press Enter' 32
Add-GeneratedVersion 'line-link-signing-secret'
Add-GeneratedVersion 'line-job-token'

Write-Host 'Secret Manager setup is complete. No secret was written to project files.'
