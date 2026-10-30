import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const roots = ['src', 'public', 'scripts', 'test'];
const files = [];
const powershellFiles = [];

function collect(path) {
  for (const entry of readdirSync(path)) {
    const fullPath = join(path, entry);
    if (statSync(fullPath).isDirectory()) collect(fullPath);
    else if (/\.(js|mjs)$/.test(entry)) files.push(fullPath);
    else if (/\.ps1$/.test(entry)) powershellFiles.push(fullPath);
  }
}

for (const root of roots) collect(root);

// Windows PowerShell 5.1 reads a BOM-less file as the system ANSI codepage. On a zh-TW machine
// that is cp950, where a UTF-8 comment's trailing bytes can swallow the following newline and
// absorb the next line into the comment. On 2026-10-30 that silently dropped a variable
// assignment in deploy-flyingmouse-job.ps1 and shipped an empty environment variable.
// Keeping these scripts ASCII-only avoids depending on how any given host decodes them.
for (const file of powershellFiles) {
  const text = readFileSync(file, 'utf8');
  const line = text.split('\n').findIndex((value) => /[^\t\n\r\x20-\x7e]/.test(value));
  if (line !== -1) {
    console.error(`${file}:${line + 1} PowerShell scripts must stay ASCII-only.`);
    process.exit(1);
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax check passed (${files.length} files, ${powershellFiles.length} PowerShell ASCII-only)`);
