import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGoogleSheetsClient } from '../src/sheets/repository.js';
import { DRAFT_TABLES, DRAFT_MAX_ROWS, assertDraftHeaders } from '../src/sheets/purchase-drafts.js';

export async function initializePurchaseDrafts({ sheets, spreadsheetId }) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = metadata.data.sheets ?? [];
  const requests = [];
  for (const [index, table] of Object.values(DRAFT_TABLES).entries()) {
    const sheet = existing.find(item => item.properties.title === table.name);
    if (sheet) {
      const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${table.name}'!A1:L1` });
      assertDraftHeaders(result.data.values?.[0] ?? [], table);
      if (sheet.properties.gridProperties.rowCount < DRAFT_MAX_ROWS) requests.push({ updateSheetProperties: {
        properties: { sheetId: sheet.properties.sheetId, gridProperties: { rowCount: DRAFT_MAX_ROWS } }, fields: 'gridProperties.rowCount'
      } });
      continue;
    }
    const sheetId = 1710000000 + index;
    if (existing.some(item => item.properties.sheetId === sheetId)) throw new Error('草稿分頁 ID 衝突，請調整初始化腳本');
    requests.push({ addSheet: { properties: { sheetId, title: table.name,
      gridProperties: { rowCount: DRAFT_MAX_ROWS, columnCount: 12, frozenRowCount: 1 } } } });
    requests.push({ updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 },
      rows: [{ values: table.headers.map(value => ({ userEnteredValue: { stringValue: value } })) }], fields: 'userEnteredValue' } });
  }
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return { ready: true, changes: requests.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false }, spreadsheet: { type: 'string' } } });
  if (!values.apply) console.log(JSON.stringify({ mode: 'preview', sheets: Object.values(DRAFT_TABLES),
    note: '尚未連線或修改資料。正式啟用前另需檢查補貨追蹤狀態驗證與公式能否接受已轉單。' }, null, 2));
  else {
    const spreadsheetId = values.spreadsheet || process.env.SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error('缺少 --spreadsheet 或 SPREADSHEET_ID');
    console.log(await initializePurchaseDrafts({ sheets: createGoogleSheetsClient(), spreadsheetId }));
  }
}
