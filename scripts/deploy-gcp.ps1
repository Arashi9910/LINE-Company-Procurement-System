param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$LineChannelId,

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

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'gcloud was not found. Install Google Cloud CLI and run gcloud auth login.'
}

& gcloud config set project $ProjectId | Out-Null

if ($BillingAccountId) {
  & gcloud billing projects link $ProjectId --billing-account $BillingAccountId | Out-Null
}

& gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  cloudscheduler.googleapis.com `
  sheets.googleapis.com `
  billingbudgets.googleapis.com `
  --project $ProjectId | Out-Null

& gcloud iam service-accounts describe $serviceAccountEmail --project $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  & gcloud iam service-accounts create $serviceAccountName `
    --project $ProjectId `
    --display-name 'LINE Replenishment Cloud Run' | Out-Null
}

foreach ($secret in $secretNames) {
  & gcloud secrets versions access latest --secret $secret --project $ProjectId 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Secret $secret has no accessible version. Run scripts/configure-secrets.ps1 first."
  }
  & gcloud secrets add-iam-policy-binding $secret `
    --project $ProjectId `
    --member "serviceAccount:$serviceAccountEmail" `
    --role 'roles/secretmanager.secretAccessor' `
    --quiet | Out-Null
}

& gcloud run deploy $ServiceName `
  --source . `
  --project $ProjectId `
  --region $Region `
  --allow-unauthenticated `
  --service-account $serviceAccountEmail `
  --max-instances 1 `
  --concurrency 20 `
  --set-env-vars "SPREADSHEET_ID=$SpreadsheetId,LINE_CHANNEL_ID=$LineChannelId,LIFF_ID=$LiffId,GOOGLE_CLOUD_PROJECT=$ProjectId" `
  --set-secrets 'LINE_CHANNEL_SECRET=line-channel-secret:latest,LINE_CHANNEL_ACCESS_TOKEN=line-channel-access-token:latest,LINK_SIGNING_SECRET=line-link-signing-secret:latest,JOB_TOKEN=line-job-token:latest' `
  --quiet

$serviceUrl = & gcloud run services describe $ServiceName `
  --project $ProjectId `
  --region $Region `
  --format 'value(status.url)'

$jobToken = & gcloud secrets versions access latest --secret 'line-job-token' --project $ProjectId
$jobName = 'line-replenishment-reminders'
$jobExists = & gcloud scheduler jobs describe $jobName --project $ProjectId --location $Region 2>$null
$jobCommand = if ($LASTEXITCODE -eq 0) { 'update' } else { 'create' }

& gcloud scheduler jobs $jobCommand http $jobName `
  --project $ProjectId `
  --location $Region `
  --schedule '0 10 * * 1-5' `
  --time-zone 'Asia/Taipei' `
  --uri "$serviceUrl/jobs/reminders" `
  --http-method POST `
  --headers "Authorization=Bearer $jobToken,Content-Type=application/json" `
  --message-body '{}' `
  --quiet | Out-Null
$jobToken = $null

if ($BillingAccountId) {
  $budgetName = "$ProjectId-monthly-alert"
  $existingBudget = & gcloud billing budgets list `
    --billing-account $BillingAccountId `
    --filter "displayName=$budgetName" `
    --format 'value(name)'
  if (-not $existingBudget) {
    & gcloud billing budgets create `
      --billing-account $BillingAccountId `
      --display-name $budgetName `
      --budget-amount $BudgetAmount `
      --filter-projects "projects/$ProjectId" `
      --threshold-rule 'percent=0.50' `
      --threshold-rule 'percent=0.90' `
      --threshold-rule 'percent=1.00' | Out-Null
  }
}

Write-Host "Service account: $serviceAccountEmail"
Write-Host "Cloud Run URL: $serviceUrl"
Write-Host 'Budget alerts do not cap spending or stop the service.'
