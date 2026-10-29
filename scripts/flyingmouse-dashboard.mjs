// 產生「庫存看板」分頁。只讀取飛鼠訂單，不寫入飛鼠。
// 必須排在到貨回寫之後跑，理由見 src/services/inventory-dashboard-job.js 的檔頭。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadFlyingMouseConfig,
  loadFlyingMouseConfigFromEnv
} from '../src/flyingmouse/credentials.js';
import { withAuthenticatedFlyingMousePage } from '../src/flyingmouse/exporter.js';
import { createFlyingMouseOrderClient, readOpenOrderQuantities } from '../src/flyingmouse/order-reader.js';
import { timestampInTaipei } from '../src/flyingmouse/sheets-writeback.js';
import { createGoogleSheetsClient, SheetsRepository } from '../src/sheets/repository.js';
import { runInventoryDashboard } from '../src/services/inventory-dashboard-job.js';

const FLYINGMOUSE_ENV_KEYS = Object.freeze([
  'FLYINGMOUSE_ADMIN_URL',
  'FLYINGMOUSE_PRODUCT_LIST_URL',
  'FLYINGMOUSE_USERNAME',
  'FLYINGMOUSE_PASSWORD'
]);

const HELP = `庫存看板

用法：
  node scripts/flyingmouse-dashboard.mjs --spreadsheet-id <ID> [選項]

選項：
  --spreadsheet-id <id>  Google Sheet ID；也可使用 SPREADSHEET_ID
  --credentials <path>   本機帳密檔；預設 .env.flyingmouse-login.txt
  --headed               顯示 Playwright 瀏覽器
  --help                 顯示說明

預設關閉，要設 INVENTORY_DASHBOARD_ENABLED=true 才會真的執行。
只讀取飛鼠訂單，不寫入飛鼠；寫入只限 Google Sheet 的「庫存看板」與「看板同步狀態」。
`;

function flag(env, key) {
  return String(env[key] ?? '').trim().toLowerCase() === 'true';
}

export function parseDashboardArguments(argv, env = process.env) {
  const options = {
    spreadsheetId: env.SPREADSHEET_ID ?? '',
    credentials: '.env.flyingmouse-login.txt',
    enabled: flag(env, 'INVENTORY_DASHBOARD_ENABLED'),
    headless: true,
    help: false
  };
  const valueOptions = new Map([
    ['--spreadsheet-id', 'spreadsheetId'],
    ['--credentials', 'credentials']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headed') {
      options.headless = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`未知參數：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    options[key] = value;
    index += 1;
  }
  if (!options.help && !options.spreadsheetId) throw new Error('缺少 --spreadsheet-id 或 SPREADSHEET_ID');
  return Object.freeze(options);
}

async function defaultConfigFactory({ options, env }) {
  const hasCloudConfig = FLYINGMOUSE_ENV_KEYS.some((key) => String(env[key] ?? '').trim());
  return hasCloudConfig
    ? loadFlyingMouseConfigFromEnv(env)
    : loadFlyingMouseConfig(resolve(options.credentials));
}

const jsonLogger = Object.freeze({
  info(value) { console.log(JSON.stringify(value)); },
  warn(value) { console.warn(JSON.stringify(value)); },
  error(value) { console.error(JSON.stringify(value)); }
});

export async function runFlyingMouseDashboard(options, {
  env = process.env,
  sheetsFactory = createGoogleSheetsClient,
  repositoryFactory = (input) => new SheetsRepository(input),
  configFactory = defaultConfigFactory,
  withAuthenticatedPage = withAuthenticatedFlyingMousePage,
  orderClientFactory = createFlyingMouseOrderClient,
  now = () => new Date(),
  logger = jsonLogger
} = {}) {
  if (!options.enabled) {
    logger.info({ component: 'inventory-dashboard', status: 'disabled' });
    return Object.freeze({ ok: true, skipped: true, reason: 'INVENTORY_DASHBOARD_ENABLED 不是 true' });
  }
  const sheets = sheetsFactory();
  const repository = repositoryFactory({ sheets, spreadsheetId: options.spreadsheetId });

  const readOrders = async () => {
    const config = await configFactory({ options, env });
    return withAuthenticatedPage({
      config,
      headless: options.headless,
      timeoutMs: 120_000
    }, async (page, context) => {
      // 第 0 階段只讀飛鼠。即使這條路徑沒有任何寫入程式碼，也在傳輸層再擋一次。
      await context.route('**/api/**', async (route) => {
        if (route.request().method() !== 'GET') return route.abort();
        return route.continue();
      });
      return readOpenOrderQuantities(orderClientFactory(page), { logger });
    });
  };

  return runInventoryDashboard({
    sheets,
    spreadsheetId: options.spreadsheetId,
    readOrders,
    listTrackingRows: () => repository.listRequestRows(),
    updatedAt: timestampInTaipei(now()),
    logger
  });
}

async function main() {
  try {
    const options = parseDashboardArguments(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const result = await runFlyingMouseDashboard(options);
    console.log(JSON.stringify(result));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message ?? '未知錯誤').replace(/[\r\n]+/g, ' ').slice(0, 500)
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
