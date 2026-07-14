import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const scripts = ['scripts/configure-secrets.ps1', 'scripts/deploy-gcp.ps1'];

test('PowerShell scripts prefer gcloud.cmd on Windows', async () => {
  for (const path of scripts) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /Get-Command 'gcloud\.cmd'/);
    const [wrapperSource, commandUsage] = source.split("(Invoke-Gcloud -Arguments @('config'");
    assert.match(wrapperSource, /& \$gcloud /);
    assert.doesNotMatch(commandUsage, /& \$gcloud /);
    assert.doesNotMatch(source, /& gcloud /);
  }
});

test('PowerShell scripts find a per-user Google Cloud CLI install when PATH is stale', async () => {
  for (const path of scripts) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /\$env:LOCALAPPDATA/);
    assert.match(source, /Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud\.cmd/);
    assert.match(source, /Test-Path -LiteralPath \$candidate/);
  }
});

test('gcloud stderr is handled by exit code instead of Stop preference', async () => {
  for (const path of scripts) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /function Invoke-Gcloud/);
    assert.match(source, /\$ErrorActionPreference = 'Continue'/);
    assert.match(source, /\$exitCode = \$LASTEXITCODE/);
    assert.match(source, /\$ErrorActionPreference = \$previousErrorActionPreference/);
  }
});

test('secret generation supports Windows PowerShell 5.1', async () => {
  const source = await readFile('scripts/configure-secrets.ps1', 'utf8');
  assert.match(source, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(source, /\.GetBytes\(\$bytes\)/);
  assert.doesNotMatch(source, /RandomNumberGenerator\]::Fill/);
});

test('secret setup resumes without rotating completed values', async () => {
  const source = await readFile('scripts/configure-secrets.ps1', 'utf8');
  assert.match(source, /\[switch\]\$RotateExistingSecrets/);
  assert.match(source, /\[switch\]\$RotateLineCredentials/);
  assert.match(source, /function Test-SecretHasEnabledVersion/);
  assert.match(source, /--filter=state=ENABLED/);
  assert.match(
    source,
    /-not \(\$RotateExistingSecrets -or \$RotateLineCredentials\) -and \(Test-SecretHasEnabledVersion \$Name\)/
  );
  assert.match(source, /-not \$RotateExistingSecrets -and \(Test-SecretHasEnabledVersion \$Name\)/);
  assert.match(source, /Keeping existing Secret Manager version/);
});

test('LINE credential rotation rejects masked or truncated values', async () => {
  const source = await readFile('scripts/configure-secrets.ps1', 'utf8');
  assert.match(source, /\$plain\.Length -ge \$MinimumLength/);
  assert.match(source, /\$plain -notmatch '\^\\\*\+\$'/);
  assert.match(source, /'line-channel-secret'.* 16/);
  assert.match(source, /'line-channel-access-token'.* 32/);
});

test('secret uploads do not add PowerShell pipeline line endings', async () => {
  const source = await readFile('scripts/configure-secrets.ps1', 'utf8');
  assert.doesNotMatch(source, /\$InputText \| & \$gcloud/);
  assert.match(source, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(source, /WriteAllText\(\$temporaryInputPath, \$InputText, \$utf8WithoutBom\)/);
  assert.match(source, /"--data-file=\$temporaryInputPath"/);
  assert.match(source, /WriteAllBytes\(\$temporaryInputPath, \[byte\[\]\]::new\(0\)\)/);
  assert.match(source, /Remove-Item -LiteralPath \$temporaryInputPath -Force/);
});

test('deployment trims trailing blank gcloud output safely', async () => {
  const source = await readFile('scripts/deploy-gcp.ps1', 'utf8');
  assert.match(source, /function Get-GcloudOutputText/);
  assert.match(source, /-join \[Environment\]::NewLine\)\.Trim\(\)/);
  assert.match(source, /\$jobToken = Get-GcloudOutputText \$jobTokenResult/);
  assert.doesNotMatch(source, /Output \| Select-Object -Last 1/);
});

test('Scheduler updates use the update-only header flag', async () => {
  const source = await readFile('scripts/deploy-gcp.ps1', 'utf8');
  assert.match(
    source,
    /\$jobHeaderFlag = if \(\$jobCommand -eq 'update'\) \{ '--update-headers' \} else \{ '--headers' \}/
  );
  assert.match(source, /\$jobHeaderFlag, "Authorization=Bearer \$jobToken/);
});
