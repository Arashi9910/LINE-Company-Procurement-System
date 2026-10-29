// 建立「預購額度」與「庫存看板」兩個分頁並寫上表頭。可重跑：已存在就只檢查表頭與列數。
// 不預覽也不修改 SKU主檔——它每次寫入前都會比對欄位名稱，動了就會讓目錄同步整批停止。
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGoogleSheetsClient } from '../src/sheets/repository.js';
import {
  DASHBOARD_HEADERS,
  DASHBOARD_ROW_COUNT,
  DASHBOARD_SHEET_NAME,
  PREORDER_HEADERS,
  PREORDER_ROW_COUNT,
  MOVEMENT_HEADERS,
  MOVEMENT_ROW_COUNT,
  MOVEMENT_SHEET_NAME,
  PREORDER_SHEET_NAME,
  SYNC_STATUS_HEADERS,
  SYNC_STATUS_ROW_COUNT,
  SYNC_STATUS_SHEET_NAME,
  assertSheetHeaders
} from '../src/sheets/inventory-dashboard.js';

// 固定 sheetId 讓重跑不會每次都換 ID；與 1700000000（待辦）、1710000000（採購草稿）錯開。
export const DASHBOARD_TABLES = Object.freeze([
  Object.freeze({
    sheetId: 1720000000,
    name: PREORDER_SHEET_NAME,
    headers: PREORDER_HEADERS,
    rowCount: PREORDER_ROW_COUNT,
    manual: true
  }),
  Object.freeze({
    sheetId: 1720000001,
    name: DASHBOARD_SHEET_NAME,
    headers: DASHBOARD_HEADERS,
    rowCount: DASHBOARD_ROW_COUNT,
    manual: false
  }),
  // 同步狀態不能放在「庫存看板」裡：那張表每輪整張覆寫，會把它蓋掉，
  // 而它存在的意義正是「看板覆寫失敗時還看得到上一次成功是什麼時候」。
  Object.freeze({
    sheetId: 1720000002,
    name: SYNC_STATUS_SHEET_NAME,
    headers: SYNC_STATUS_HEADERS,
    rowCount: SYNC_STATUS_ROW_COUNT,
    manual: false
  }),
  // 近 30 天有訂單的貨號。只有每小時的 Job 進得去飛鼠，web 服務讀這張來篩 查缺貨。
  Object.freeze({
    sheetId: 1720000003,
    name: MOVEMENT_SHEET_NAME,
    headers: MOVEMENT_HEADERS,
    rowCount: MOVEMENT_ROW_COUNT,
    manual: false
  })
]);

function columnLetter(count) {
  return String.fromCharCode(64 + count);
}

export async function initializeInventoryDashboard({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('庫存看板初始化設定不完整');
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = metadata.data.sheets ?? [];
  const requests = [];
  const created = [];
  const checked = [];

  for (const table of DASHBOARD_TABLES) {
    const sheet = existing.find((item) => item.properties?.title === table.name);
    if (sheet) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${table.name}'!A1:${columnLetter(table.headers.length)}1`
      });
      assertSheetHeaders(response.data.values?.[0] ?? [], table.headers, table.name);
      if ((sheet.properties.gridProperties?.columnCount ?? 0) < table.headers.length) {
        throw new Error(`${table.name} 欄數不足，請先手動加欄`);
      }
      if ((sheet.properties.gridProperties?.rowCount ?? 0) < table.rowCount) {
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { rowCount: table.rowCount }
            },
            fields: 'gridProperties.rowCount'
          }
        });
      }
      checked.push(table.name);
      continue;
    }

    if (existing.some((item) => item.properties?.sheetId === table.sheetId)) {
      throw new Error(`分頁 ID ${table.sheetId} 已被佔用，請先調整腳本`);
    }
    requests.push({
      addSheet: {
        properties: {
          sheetId: table.sheetId,
          title: table.name,
          gridProperties: {
            rowCount: table.rowCount,
            columnCount: table.headers.length,
            frozenRowCount: 1
          }
        }
      }
    });
    requests.push({
      updateCells: {
        start: { sheetId: table.sheetId, rowIndex: 0, columnIndex: 0 },
        rows: [{
          values: table.headers.map((value) => ({
            userEnteredValue: { stringValue: value },
            userEnteredFormat: { textFormat: { bold: true } }
          }))
        }],
        fields: 'userEnteredValue,userEnteredFormat.textFormat.bold'
      }
    });
    created.push(table.name);
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
  return { created, checked, changes: requests.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      spreadsheet: { type: 'string' }
    }
  });
  if (!values.apply) {
    console.log(JSON.stringify({
      mode: 'preview',
      sheets: DASHBOARD_TABLES.map((table) => ({
        name: table.name,
        columns: [...table.headers],
        rowCount: table.rowCount,
        maintainedBy: table.manual ? '人工維護' : '系統每小時整張覆寫'
      })),
      note: '未連線也未寫入。確認後執行 --apply --spreadsheet <ID>。不會動到 SKU主檔。'
    }, null, 2));
  } else {
    const spreadsheetId = values.spreadsheet || process.env.SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error('缺少 --spreadsheet 或 SPREADSHEET_ID');
    console.log(await initializeInventoryDashboard({
      sheets: createGoogleSheetsClient(),
      spreadsheetId
    }));
  }
}
