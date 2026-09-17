import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createGoogleSheetsClient, SheetsRepository } from '../src/sheets/repository.js';
import { TODO_TABLES, TODO_MAX_ROWS, assertTodoHeaders } from '../src/sheets/daily-todos.js';

export const INITIAL_TODOS = ['發貨', '缺貨採購', '取退貨', '選品', '上架', '活動策劃'];

export async function initializeDailyTodos({ sheets, spreadsheetId }) {
  const repository = new SheetsRepository({ sheets, spreadsheetId });
  const groupId = await repository.getNotificationGroupId();
  if (!groupId) throw new Error('請先在既有系統設定工作群組，再初始化待辦。');
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = metadata.data.sheets ?? [];
  const requests = [];
  const newTables = [];
  for (const table of Object.values(TODO_TABLES)) {
    const sheet = existing.find((item) => item.properties.title === table.name);
    if (sheet) {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${table.name}'!A1:L1` });
      assertTodoHeaders(response.data.values?.[0] ?? [], table);
      if (sheet.properties.gridProperties.rowCount < TODO_MAX_ROWS) {
        requests.push({ updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, gridProperties: { rowCount: TODO_MAX_ROWS } }, fields: 'gridProperties.rowCount'
        } });
      }
    } else {
      const sheetId = 1700000000 + Object.values(TODO_TABLES).indexOf(table);
      if (existing.some((item) => item.properties.sheetId === sheetId)) throw new Error('初始化分頁 ID 衝突，請先調整腳本。');
      requests.push({ addSheet: { properties: {
        sheetId, title: table.name, gridProperties: { rowCount: TODO_MAX_ROWS, columnCount: 12, frozenRowCount: 1 }
      } } });
      requests.push({ updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows: [{ values: table.headers.map((value) => ({ userEnteredValue: { stringValue: value } })) }], fields: 'userEnteredValue'
      } });
      newTables.push(table.name);
    }
  }
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  await repository.withDailyTodos(async (store) => {
    if (store.state.templates.some((item) => item.groupId === groupId)) return;
    const at = new Date().toISOString();
    store.state.templates.push(...INITIAL_TODOS.map((title, index) => ({
      id: `F-initial-${index + 1}`, title, ownerId: '', ownerName: '', enabled: '是', groupId, updatedAt: at
    })));
    await store.save();
  });
  return { createdTables: newTables, initialTasks: INITIAL_TODOS.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean', default: false }, spreadsheet: { type: 'string' }
  } });
  if (!values.apply) {
    console.log(JSON.stringify({ mode: 'preview', sheets: Object.values(TODO_TABLES).map((table) => ({ name: table.name, columns: table.headers })), tasks: INITIAL_TODOS, owner: '待指派', note: '未連線或寫入正式資料。確認後使用 --apply --spreadsheet <ID>。' }, null, 2));
  } else {
    const spreadsheetId = values.spreadsheet || process.env.SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error('缺少 --spreadsheet 或 SPREADSHEET_ID');
    console.log(await initializeDailyTodos({ sheets: createGoogleSheetsClient(), spreadsheetId }));
  }
}
