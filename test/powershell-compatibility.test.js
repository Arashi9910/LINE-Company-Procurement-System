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
