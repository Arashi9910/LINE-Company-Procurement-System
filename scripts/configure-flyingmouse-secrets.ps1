param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$CredentialPath = '.env.flyingmouse-login.txt',

  [switch]$Rotate
)

$ErrorActionPreference = 'Stop'

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
    throw "gcloud command failed: $(($Arguments | Select-Object -First 3) -join ' ')"
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = $output }
}

if (-not (Test-Path -LiteralPath $CredentialPath)) {
  throw "Credential file not found: $CredentialPath"
}

$values = @{}
foreach ($rawLine in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $CredentialPath))) {
  $line = $rawLine.Trim()
  if (-not $line -or $line.StartsWith('#')) { continue }
  $separator = $line.IndexOf('=')
  if ($separator -le 0) { continue }
  $key = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1).Trim()
  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }
  $values[$key] = $value
}

if (-not $values['FLYINGMOUSE_USERNAME'] -or -not $values['FLYINGMOUSE_PASSWORD']) {
  throw 'Credential file must contain FLYINGMOUSE_USERNAME and FLYINGMOUSE_PASSWORD.'
}

(Invoke-Gcloud -Arguments @('config', 'set', 'project', $ProjectId)).Output | Out-Null
(Invoke-Gcloud -Arguments @('services', 'enable', 'secretmanager.googleapis.com', '--project', $ProjectId)).Output | Out-Null

function Ensure-Secret([string]$Name) {
  $probe = Invoke-Gcloud -Arguments @('secrets', 'describe', $Name, '--project', $ProjectId) -AllowFailure
  if ($probe.ExitCode -ne 0) {
    (Invoke-Gcloud -Arguments @(
      'secrets', 'create', $Name,
      '--project', $ProjectId,
      '--replication-policy=automatic'
    )).Output | Out-Null
  }
}

function Test-EnabledVersion([string]$Name) {
  $probe = Invoke-Gcloud -Arguments @(
    'secrets', 'versions', 'list', $Name,
    '--project', $ProjectId,
    '--filter=state=ENABLED',
    '--format=value(name)'
  ) -AllowFailure
  return $probe.ExitCode -eq 0 -and $probe.Output.Count -gt 0
}

function Add-SecretVersion([string]$Name, [string]$Value) {
  Ensure-Secret $Name
  if (-not $Rotate -and (Test-EnabledVersion $Name)) {
    Write-Host "Keeping existing Secret Manager version: $Name"
    return
  }
  $temporaryPath = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($temporaryPath, $Value, [Text.UTF8Encoding]::new($false))
    (Invoke-Gcloud -Arguments @(
      'secrets', 'versions', 'add', $Name,
      '--project', $ProjectId,
      "--data-file=$temporaryPath"
    )).Output | Out-Null
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      [IO.File]::WriteAllBytes($temporaryPath, [byte[]]::new(0))
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

Add-SecretVersion 'flyingmouse-username' ([string]$values['FLYINGMOUSE_USERNAME'])
Add-SecretVersion 'flyingmouse-password' ([string]$values['FLYINGMOUSE_PASSWORD'])

$values.Clear()
Write-Host 'FlyingMouse secrets are configured. No credential was written to the project.'
