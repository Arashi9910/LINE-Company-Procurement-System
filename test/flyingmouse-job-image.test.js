import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 從進入點沿著 import 走一遍，算出 Job 真正需要的本地檔案。
// 這支測試存在的原因：步驟 5 把看板接進每小時 Job，但 Dockerfile 只複製了
// src/flyingmouse 與三支腳本，少了 9 個檔案——容器會在 import 階段就掛掉，
// 而所有單元測試都在本機完整的檔案樹上跑，一條都不會紅。
function localDependencies(entries) {
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        if (!spec.startsWith('node:')) external.add(spec);
        continue;
      }
      walk(join(dirname(file), spec));
    }
  };
  for (const entry of entries) walk(join(ROOT, entry));
  return {
    external,
    files: [...seen]
      .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
      .filter((file) => file.startsWith('src/') || file.startsWith('scripts/'))
      .sort()
  };
}

function copiedPaths(dockerfile) {
  const paths = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^COPY\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const parts = match[1].split(/\s+/);
    // 最後一個是目的地。
    for (const source of parts.slice(0, -1)) {
      if (source.startsWith('src/') || source.startsWith('scripts/')) paths.push(source);
    }
  }
  return paths;
}

test('the FlyingMouse job image copies every file the job imports', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile.flyingmouse-job'), 'utf8');
  const copied = copiedPaths(dockerfile);
  const { files } = localDependencies(['scripts/flyingmouse-combined-job.mjs']);

  assert.ok(files.length > 10, '相依閉包看起來太小，檢查這支測試是不是算錯了');
  const missing = files.filter((file) =>
    !copied.some((source) => file === source || file.startsWith(`${source}/`)));
  assert.deepEqual(missing, [], `Dockerfile.flyingmouse-job 少複製了：${missing.join('、')}`);
  // 看板階段的進入點與三個新模組都要在清單裡，否則代表閉包算錯了。
  for (const expected of [
    'scripts/flyingmouse-dashboard.mjs',
    'src/services/inventory-dashboard.js',
    'src/services/inventory-dashboard-job.js',
    'src/sheets/inventory-dashboard.js'
  ]) {
    assert.ok(files.includes(expected), `相依閉包應該包含 ${expected}`);
  }
});

test('the job image package.json covers every external package the job imports', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'jobs/flyingmouse/package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const { external } = localDependencies(['scripts/flyingmouse-combined-job.mjs']);

  const missing = [...external].filter((name) => !declared.has(name.split('/')[0]));
  assert.deepEqual(missing, [], `jobs/flyingmouse/package.json 缺少：${missing.join('、')}`);
});

test('the web image does not pretend to reach FlyingMouse', () => {
  // web 映像是 node:22-slim、而且只複製 src 與 public，沒有 Playwright 也沒有 scripts。
  // 叫貨提醒的排程端點跑在 web 服務上，所以它拿不到動銷清單——
  // runReorderAlerts 的 readRecentlyOrdered 在那裡一定是 null，這是刻意的。
  const web = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.equal(web.includes('playwright'), false);
  assert.equal(/^COPY\s+scripts/m.test(web), false);
  assert.ok(posix.basename('src/server.js'));
});
