import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('FlyingMouse job pins the Playwright package and image to the same version', async () => {
  const packageJson = JSON.parse(await read('jobs/flyingmouse/package.json'));
  const dockerfile = await read('Dockerfile.flyingmouse-job');
  const version = packageJson.dependencies.playwright;

  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(dockerfile, new RegExp(`FROM mcr\\.microsoft\\.com/playwright:v${version}-noble`));
  assert.match(dockerfile, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/);
});

test('FlyingMouse Cloud Build context is an allow-list that never includes secrets', async () => {
  const ignore = await read('.gcloudignore.flyingmouse');
  const lines = ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  assert.equal(lines.includes('*'), true);
  assert.equal(lines.includes('!src/flyingmouse/**'), true);
  assert.equal(lines.includes('!scripts/flyingmouse-sync.mjs'), true);
  assert.equal(lines.some((line) => /^!.*\.env/i.test(line)), false);
  assert.equal(lines.some((line) => /claude/i.test(line)), false);
});

test('FlyingMouse deployment keeps credentials in Secret Manager and requires an explicit review mode', async () => {
  const deploy = await read('scripts/deploy-flyingmouse-job.ps1');
  const sheets = await read('src/flyingmouse/sheets-baseline.js');
  const review = await read('src/flyingmouse/sheets-review.js');

  assert.match(deploy, /FLYINGMOUSE_USERNAME=flyingmouse-username:latest/);
  assert.match(deploy, /FLYINGMOUSE_PASSWORD=flyingmouse-password:latest/);
  assert.doesNotMatch(deploy, /\.env\.flyingmouse-login\.txt/);
  assert.match(deploy, /\[string\]\$SheetMode = 'read-only'/);
  assert.match(deploy, /FLYINGMOUSE_SHEET_MODE=\$SheetMode/);
  assert.match(sheets, /spreadsheets\.readonly/);
  assert.doesNotMatch(sheets, /values\.(?:update|append|batchUpdate)/);
  assert.match(review, /auth\/spreadsheets'/);
  assert.match(review, /核准匯入/);
});
