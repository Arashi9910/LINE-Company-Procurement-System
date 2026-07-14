param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'gcloud was not found. Install Google Cloud CLI and run gcloud auth login.'
}

& gcloud config set project $ProjectId | Out-Null

function Ensure-Secret([string]$Name) {
  & gcloud secrets describe $Name --project $ProjectId '--format=value(name)' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & gcloud secrets create $Name --project $ProjectId '--replication-policy=automatic' | Out-Null
  }
}

function Add-SecureVersion([string]$Name, [string]$Prompt) {
  Ensure-Secret $Name
  $secure = Read-Host $Prompt -AsSecureString
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password
  try {
    $plain | & gcloud secrets versions add $Name --project $ProjectId '--data-file=-' | Out-Null
  } finally {
    $plain = $null
    $secure.Dispose()
  }
}

function Add-GeneratedVersion([string]$Name) {
  Ensure-Secret $Name
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $plain = [Convert]::ToBase64String($bytes)
  try {
    $plain | & gcloud secrets versions add $Name --project $ProjectId '--data-file=-' | Out-Null
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
