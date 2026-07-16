import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadFlyingMouseConfig,
  loadFlyingMouseConfigFromEnv
} from '../src/flyingmouse/credentials.js';
import { withAuthenticatedFlyingMousePage } from '../src/flyingmouse/exporter.js';
import { createFlyingMousePartClient } from '../src/flyingmouse/inventory-writeback.js';
import { createGoogleSheetsReviewClient } from '../src/flyingmouse/sheets-review.js';
import { ensureWritebackSheet } from '../src/flyingmouse/sheets-writeback.js';
import { processWritebackQueue } from '../src/flyingmouse/writeback-worker.js';

const FLYINGMOUSE_ENV_KEYS = Object.freeze([
  'FLYINGMOUSE_ADMIN_URL',
  'FLYINGMOUSE_PRODUCT_LIST_URL',
  'FLYINGMOUSE_USERNAME',
  'FLYINGMOUSE_PASSWORD'
]);

const HELP = `飛鼠到貨庫存回寫

用法：
  node scripts/flyingmouse-inventory-writeback.mjs --spreadsheet-id <ID> [選項]

選項：
  --spreadsheet-id <id>  Google Sheet ID；也可使用 SPREADSHEET_ID
  --mode <mode>          dry-run 或 live；預設 dry-run
  --limit <count>        單次最多處理筆數，1–100；預設 20
  --credentials <path>   本機帳密檔；預設 .env.flyingmouse-login.txt
  --ensure-sheet         建立或驗證「飛鼠庫存回寫」分頁
  --setup-only           只建立／驗證分頁，不登入飛鼠或處理事件
  --headed               顯示 Playwright 瀏覽器
  --help                 顯示說明
`;

export function parseWritebackArguments(argv, env = process.env) {
  const options = {
    spreadsheetId: env.SPREADSHEET_ID ?? '',
    mode: env.FLYINGMOUSE_WRITEBACK_MODE ?? 'dry-run',
    limit: Number.parseInt(env.FLYINGMOUSE_WRITEBACK_LIMIT ?? '20', 10),
    credentials: '.env.flyingmouse-login.txt',
    ensureSheet: false,
    setupOnly: false,
    headless: true,
    help: false
  };
  const valueOptions = new Map([
    ['--spreadsheet-id', 'spreadsheetId'],
    ['--mode', 'mode'],
    ['--limit', 'limit'],
    ['--credentials', 'credentials']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headed') {
      options.headless = false;
      continue;
    }
    if (argument === '--ensure-sheet') {
      options.ensureSheet = true;
      continue;
    }
    if (argument === '--setup-only') {
      options.setupOnly = true;
      options.ensureSheet = true;
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
    options[key] = key === 'limit' ? Number.parseInt(value, 10) : value;
    index += 1;
  }
  if (!['dry-run', 'live'].includes(options.mode)) throw new Error('mode 必須是 dry-run 或 live');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('limit 必須是 1 到 100 的整數');
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

export async function runFlyingMouseInventoryWriteback(options, {
  env = process.env,
  sheetsFactory = createGoogleSheetsReviewClient,
  configFactory = defaultConfigFactory,
  withAuthenticatedPage = withAuthenticatedFlyingMousePage,
  partClientFactory = createFlyingMousePartClient,
  now = () => new Date(),
  logger = jsonLogger
} = {}) {
  const sheets = sheetsFactory();
  let sheetSetup = null;
  if (options.ensureSheet) {
    sheetSetup = await ensureWritebackSheet({
      sheets,
      spreadsheetId: options.spreadsheetId
    });
  }
  if (options.setupOnly) {
    return Object.freeze({
      mode: options.mode,
      setupOnly: true,
      sheetCreated: sheetSetup?.created === true
    });
  }
  const withClient = async (operation) => {
    const config = await configFactory({ options, env });
    return withAuthenticatedPage({
      config,
      headless: options.headless,
      timeoutMs: 45_000
    }, async (page) => operation(partClientFactory(page)));
  };
  const result = await processWritebackQueue({
    sheets,
    spreadsheetId: options.spreadsheetId,
    withClient,
    mode: options.mode,
    now,
    limit: options.limit,
    logger
  });
  return Object.freeze({
    ...result,
    sheetCreated: sheetSetup?.created === true
  });
}

async function main() {
  try {
    const options = parseWritebackArguments(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const result = await runFlyingMouseInventoryWriteback(options);
    console.log(JSON.stringify({ ok: true, ...result }));
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
