import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArguments as parseCatalogArguments,
  runFlyingMouseSync
} from './flyingmouse-sync.mjs';
import {
  parseWritebackArguments,
  runFlyingMouseInventoryWriteback
} from './flyingmouse-inventory-writeback.mjs';
import {
  parseDashboardArguments,
  runFlyingMouseDashboard
} from './flyingmouse-dashboard.mjs';

const CLOUD_DOWNLOAD_DIR = '/tmp/flyingmouse/downloads';
const CLOUD_OUTPUT_DIR = '/tmp/flyingmouse/previews';

function safeMessage(error) {
  return String(error?.message ?? '未知錯誤')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

const jsonLogger = Object.freeze({
  info(value) { console.log(JSON.stringify(value)); },
  error(value) { console.error(JSON.stringify(value)); }
});

export function createFlyingMouseCombinedOptions(env = process.env) {
  const catalog = parseCatalogArguments([
    '--download-dir', CLOUD_DOWNLOAD_DIR,
    '--output-dir', CLOUD_OUTPUT_DIR
  ], env);
  const writeback = parseWritebackArguments([], env);
  const dashboard = parseDashboardArguments([], env);

  return Object.freeze({
    catalog: Object.freeze(catalog),
    writeback: Object.freeze({ ...writeback, ensureSheet: true }),
    dashboard: Object.freeze(dashboard)
  });
}

export async function runFlyingMouseCombinedJob(options, {
  runCatalog = runFlyingMouseSync,
  runWriteback = runFlyingMouseInventoryWriteback,
  runDashboard = runFlyingMouseDashboard,
  logger = jsonLogger
} = {}) {
  logger.info({ component: 'flyingmouse-combined', phase: 'catalog', status: 'started' });
  const catalog = await runCatalog(options.catalog);
  logger.info({ component: 'flyingmouse-combined', phase: 'catalog', status: 'completed' });

  logger.info({ component: 'flyingmouse-combined', phase: 'writeback', status: 'started' });
  const writeback = await runWriteback(options.writeback);
  logger.info({ component: 'flyingmouse-combined', phase: 'writeback', status: 'completed' });

  // 看板一定排在回寫之後：回寫才會把飛鼠庫存寫進 SKU主檔的庫存快照。夾在中間跑的話，
  // 「已叫貨未到」已歸零而「飛鼠庫存」還沒加上去，缺口會被高估並觸發多餘的叫貨提醒。
  // 看板失敗不得影響商品同步與回寫的結果，所以這裡吞掉例外只記錄。
  logger.info({ component: 'flyingmouse-combined', phase: 'dashboard', status: 'started' });
  let dashboard;
  try {
    dashboard = await runDashboard(options.dashboard);
  } catch (error) {
    dashboard = { ok: false, error: safeMessage(error) };
  }
  logger.info({
    component: 'flyingmouse-combined',
    phase: 'dashboard',
    status: dashboard.ok === false ? 'failed' : 'completed'
  });

  return Object.freeze({ catalog, writeback, dashboard });
}

async function main() {
  try {
    const options = createFlyingMouseCombinedOptions();
    const result = await runFlyingMouseCombinedJob(options);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      component: 'flyingmouse-combined',
      error: safeMessage(error)
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
