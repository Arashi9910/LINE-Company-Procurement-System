// 在 SKU主檔 與 補貨追蹤 末端補上「出貨型態」欄。可重跑：欄位已就位就只回報。
//
// 這兩張分頁的表頭都是嚴格比對（exactHeaders / assertSheetHeaders），
// 少一欄整輪同步就會停住，所以程式部署前要先跑這支。
// 只補欄位與表頭，不碰任何資料列。
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGoogleSheetsClient } from '../src/sheets/repository.js';
import { MAIN_HEADERS, MAIN_SHEET_NAME } from '../src/flyingmouse/sheets-review.js';
import { TRACKING_HEADERS } from '../src/sheets/order-spec-correction.js';
import { TRACKING_SHEET_NAME } from '../src/flyingmouse/sheets-operational.js';

export const SALES_NAME_TABLES = Object.freeze([
  Object.freeze({ name: MAIN_SHEET_NAME, headers: MAIN_HEADERS }),
  Object.freeze({ name: TRACKING_SHEET_NAME, headers: TRACKING_HEADERS })
]);

function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export async function setupSalesNameSync({ sheets, spreadsheetId, dryRun = false }) {
  if (!sheets || !spreadsheetId) throw new Error('出貨型態欄位設定不完整');

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const properties = new Map((meta.data.sheets ?? [])
    .map((sheet) => sheet.properties)
    .map((sheet) => [sheet.title, sheet]));

  // 讀取範圍要夾在分頁現有的欄數內。實測 Sheets 的 batchGet 會自行裁切超界範圍，
  // 但這支腳本存在的前提就是欄位還沒補上，不該賴在 API 的寬容上。
  const readWidths = SALES_NAME_TABLES.map((table) => {
    const sheet = properties.get(table.name);
    if (!sheet) throw new Error(`缺少 ${table.name} 分頁`);
    return Math.max(1, Math.min(table.headers.length, sheet.gridProperties?.columnCount ?? 0));
  });
  const ranges = SALES_NAME_TABLES
    .map((table, index) => `'${table.name}'!A1:${columnLetter(readWidths[index] - 1)}1`);
  const read = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });

  const widenRequests = [];
  const headerWrites = [];
  const changes = [];
  for (const [index, table] of SALES_NAME_TABLES.entries()) {
    const sheet = properties.get(table.name);
    if (!sheet) throw new Error(`缺少 ${table.name} 分頁`);

    const columnCount = sheet.gridProperties?.columnCount ?? 0;
    if (columnCount < table.headers.length) {
      widenRequests.push({
        appendDimension: {
          sheetId: sheet.sheetId,
          dimension: 'COLUMNS',
          length: table.headers.length - columnCount
        }
      });
      changes.push(`${table.name} 擴充 ${table.headers.length - columnCount} 欄`);
    }

    const actual = read.data.valueRanges?.[index]?.values?.[0] ?? [];
    // 既有表頭必須是新表頭的前綴，否則代表有人搬過欄位，停下來讓人看。
    for (let column = 0; column < actual.length; column += 1) {
      const current = normalizeText(actual[column]);
      const expected = normalizeText(table.headers[column]);
      if (current && current !== expected) {
        throw new Error(
          `${table.name} 第 ${columnLetter(column)} 欄的表頭是「${current}」，預期「${expected}」，已停止`
        );
      }
    }
    if (actual.length === table.headers.length
      && actual.every((value, column) => normalizeText(value) === normalizeText(table.headers[column]))) {
      continue;
    }
    headerWrites.push({
      range: `'${table.name}'!A1:${columnLetter(table.headers.length - 1)}1`,
      values: [[...table.headers]]
    });
    changes.push(`${table.name} 寫入表頭`);
  }

  if (!dryRun && widenRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: widenRequests } });
  }
  if (!dryRun && headerWrites.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: headerWrites }
    });
  }

  return Object.freeze({
    widened: widenRequests.length,
    headersWritten: headerWrites.length,
    changes: Object.freeze(changes),
    dryRun
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      'spreadsheet-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false }
    }
  });
  const spreadsheetId = values['spreadsheet-id'] ?? process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('需要 --spreadsheet-id 或 SPREADSHEET_ID');

  const result = await setupSalesNameSync({
    sheets: createGoogleSheetsClient(),
    spreadsheetId,
    dryRun: values['dry-run']
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
