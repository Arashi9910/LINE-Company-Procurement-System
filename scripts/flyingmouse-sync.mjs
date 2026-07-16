import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffCatalog,
  parseFlyingMouseWorkbook,
  parseReferenceCatalogWorkbook
} from '../src/flyingmouse/catalog.js';
import {
  loadFlyingMouseConfig,
  loadFlyingMouseConfigFromEnv
} from '../src/flyingmouse/credentials.js';
import { exportFlyingMouseWorkbook } from '../src/flyingmouse/exporter.js';
import { captureFlyingMouseProductList } from '../src/flyingmouse/image-catalog.js';
import {
  createGoogleSheetsReadonlyClient,
  loadReferenceCatalogFromSheet
} from '../src/flyingmouse/sheets-baseline.js';
import {
  createGoogleSheetsReviewClient,
  syncReviewAndImport
} from '../src/flyingmouse/sheets-review.js';
import {
  syncInventorySnapshots,
  syncProductImages
} from '../src/flyingmouse/sheets-operational.js';

const FLYINGMOUSE_ENV_KEYS = Object.freeze([
  'FLYINGMOUSE_ADMIN_URL',
  'FLYINGMOUSE_PRODUCT_LIST_URL',
  'FLYINGMOUSE_USERNAME',
  'FLYINGMOUSE_PASSWORD'
]);

const SHEET_MODES = new Set(['read-only', 'review']);

const HELP = `飛鼠新品目錄同步

用法：
  npm run flyingmouse:sync -- --input <官方匯出.xlsx> [--baseline <既有目錄.xlsx>]
  npm run flyingmouse:sync -- [--credentials <帳密檔>] [--baseline <既有目錄.xlsx>]

選項：
  --input <path>         使用現有官方 Excel，不啟動瀏覽器
  --baseline <path>      與既有商品目錄 Excel 比對
  --spreadsheet-id <id>  改以 Google Sheet 的 SKU主檔作為 baseline
  --sheet-mode <mode>    read-only（預設）或 review（寫入審核區並處理已核准新品）
  --credentials <path>   帳密檔，預設 .env.flyingmouse-login.txt
  --download-dir <path>  官方下載保存目錄
  --output-dir <path>    差異報告保存目錄
  --headed               顯示 Playwright 瀏覽器，供本機除錯
  --help                 顯示說明

此命令永遠不寫入飛鼠；只有 review 模式會寫入 Google Sheet。`;

export function parseArguments(argv, env = process.env) {
  const options = {
    input: '',
    baseline: '',
    spreadsheetId: env.SPREADSHEET_ID ?? '',
    sheetMode: env.FLYINGMOUSE_SHEET_MODE ?? 'read-only',
    credentials: '.env.flyingmouse-login.txt',
    downloadDir: 'work/flyingmouse/downloads',
    outputDir: 'work/flyingmouse/previews',
    headless: true,
    help: false
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['--baseline', 'baseline'],
    ['--spreadsheet-id', 'spreadsheetId'],
    ['--sheet-mode', 'sheetMode'],
    ['--credentials', 'credentials'],
    ['--download-dir', 'downloadDir'],
    ['--output-dir', 'outputDir']
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
    if (!value || value.startsWith('--')) throw new Error(`${argument} 需要指定值`);
    options[key] = value;
    index += 1;
  }
  if (!SHEET_MODES.has(options.sheetMode)) {
    throw new Error(`不支援的 sheet mode：${options.sheetMode}`);
  }
  if (options.sheetMode === 'review' && !options.spreadsheetId) {
    throw new Error('review 模式需要 --spreadsheet-id 或 SPREADSHEET_ID');
  }
  if (options.sheetMode === 'review' && options.baseline) {
    throw new Error('review 模式必須直接以 SKU主檔作為 baseline');
  }
  return options;
}

function reportTimestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function writeJsonAtomic(filePath, value) {
  const partialPath = `${filePath}.partial`;
  try {
    await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(partialPath, filePath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}

function defaultSheetsFactory({ writable }) {
  return writable ? createGoogleSheetsReviewClient() : createGoogleSheetsReadonlyClient();
}

export async function runFlyingMouseSync(options, {
  now = () => new Date(),
  env = process.env,
  sheetsFactory = defaultSheetsFactory,
  exportWorkbook = exportFlyingMouseWorkbook,
  captureProductList = captureFlyingMouseProductList
} = {}) {
  const mode = options.input ? 'offline' : 'browser-export';
  let sourcePath;
  let config = null;
  if (options.input) {
    sourcePath = resolve(options.input);
  } else {
    const hasCloudConfig = FLYINGMOUSE_ENV_KEYS.some((key) => String(env[key] ?? '').trim());
    config = hasCloudConfig
      ? loadFlyingMouseConfigFromEnv(env)
      : await loadFlyingMouseConfig(resolve(options.credentials));
    sourcePath = await exportWorkbook({
      config,
      downloadDir: options.downloadDir,
      headless: options.headless,
      now
    });
  }

  const source = await parseFlyingMouseWorkbook(sourcePath);
  const imageCatalog = config && options.sheetMode === 'review'
    ? await captureProductList({
        config,
        sourceItems: source.items,
        headless: options.headless,
        now
      })
    : null;
  const sheets = options.spreadsheetId
    ? sheetsFactory({ writable: options.sheetMode === 'review' })
    : null;
  let reference = null;
  if (options.baseline) {
    reference = await parseReferenceCatalogWorkbook(resolve(options.baseline));
  } else if (options.spreadsheetId) {
    reference = await loadReferenceCatalogFromSheet({
      sheets,
      spreadsheetId: options.spreadsheetId
    });
  }
  const diff = reference ? diffCatalog(source.items, reference.items) : null;
  const generatedAt = now();
  const reviewSync = options.sheetMode === 'review'
    ? await syncReviewAndImport({
        sheets,
        spreadsheetId: options.spreadsheetId,
        diff,
        sourceItems: source.items,
        generatedAt
      })
    : null;
  const inventorySync = options.sheetMode === 'review'
    ? await syncInventorySnapshots({
        sheets,
        spreadsheetId: options.spreadsheetId,
        sourceItems: source.items
      })
    : null;
  const imageSync = imageCatalog
    ? await syncProductImages({
        sheets,
        spreadsheetId: options.spreadsheetId,
        imageItems: imageCatalog.items
      })
    : null;
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const reportPath = resolve(outputDir, `catalog-preview_${reportTimestamp(generatedAt)}.json`);
  const report = {
    schemaVersion: 3,
    generatedAt: generatedAt.toISOString(),
    mode,
    sheetMode: options.sheetMode,
    readOnly: options.sheetMode === 'read-only',
    source: source.metadata,
    reference: reference?.metadata ?? null,
    summary: diff?.summary ?? { sourceRows: source.metadata.rowCount },
    diff,
    reviewSync,
    inventorySync,
    imageSync,
    imageSource: imageCatalog?.metadata ?? null
  };
  await writeJsonAtomic(reportPath, report);
  return {
    mode,
    sheetMode: options.sheetMode,
    readOnly: report.readOnly,
    sourcePath,
    reportPath,
    summary: report.summary,
    reviewSync,
    inventorySync,
    imageSync
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const result = await runFlyingMouseSync(options);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(`飛鼠唯讀同步失敗：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
