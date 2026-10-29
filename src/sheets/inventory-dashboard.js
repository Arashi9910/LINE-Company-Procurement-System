// 庫存看板的 Google Sheets 讀寫：讀「預購額度」、整張覆寫「庫存看板」。
// 欄位依 docs/inventory-dashboard-spec.md 第 4.1、4.2 節。
// 這裡只負責搬資料，數字怎麼算在 src/services/inventory-dashboard.js，兩邊不重複驗證。
// 絕不觸碰 SKU主檔：它每次寫入前都會比對欄位名稱，多一個欄位就會讓目錄同步整批停止。

export const PREORDER_SHEET_NAME = '預購額度';
export const PREORDER_HEADERS = Object.freeze([
  'SKU',
  '預購額度',
  '安全庫存',
  '備註',
  '最後修改人',
  '最後修改時間'
]);
export const PREORDER_ROW_COUNT = 2000;

export const DASHBOARD_SHEET_NAME = '庫存看板';
export const DASHBOARD_HEADERS = Object.freeze([
  'SKU',
  '商品名稱',
  '飛鼠庫存',
  '處理中',
  '備貨中',
  '賣掉還沒寄',
  '已叫貨未到',
  '預購額度',
  '安全庫存',
  '推算實際庫存',
  '缺口',
  '狀態',
  '備註',
  '更新時間'
]);
export const DASHBOARD_ROW_COUNT = 5000;

function columnLetter(count) {
  if (count < 1 || count > 26) throw new Error('欄數超出支援範圍');
  return String.fromCharCode(64 + count);
}

const PREORDER_LAST_COLUMN = columnLetter(PREORDER_HEADERS.length);
const DASHBOARD_LAST_COLUMN = columnLetter(DASHBOARD_HEADERS.length);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function paddedRow(row, width) {
  return Array.from({ length: width }, (_, index) => row?.[index] ?? '');
}

function hasValues(row) {
  return row.some((value) => normalizeText(value) !== '');
}

export function assertSheetHeaders(actual, expected, sheetName) {
  const normalized = Array.from({ length: expected.length }, (_, index) => String(actual?.[index] ?? ''));
  if (normalized.some((header, index) => header !== expected[index])) {
    throw new Error(`${sheetName} 表頭不符，預期：${expected.join('、')}；實際：${normalized.join('、')}`);
  }
}

// 數字格式交給 src/services/inventory-dashboard.js 的 indexPreorders 驗證，
// 這裡只處理試算表才有的結構問題：表頭、空白 SKU、重複 SKU，並帶上列號方便人工修。
export function parsePreorderRows(values) {
  assertSheetHeaders(values?.[0] ?? [], PREORDER_HEADERS, PREORDER_SHEET_NAME);
  const rows = [];
  const seen = new Map();
  for (let index = 1; index < (values?.length ?? 0); index += 1) {
    const row = paddedRow(values[index], PREORDER_HEADERS.length);
    if (!hasValues(row)) continue;
    const rowNumber = index + 1;
    const sku = normalizeText(row[0]);
    if (!sku) throw new Error(`${PREORDER_SHEET_NAME} 第 ${rowNumber} 列缺少 SKU`);
    if (seen.has(sku)) {
      throw new Error(`${PREORDER_SHEET_NAME} SKU ${sku} 在第 ${seen.get(sku)}、${rowNumber} 列重複`);
    }
    seen.set(sku, rowNumber);
    rows.push(Object.freeze({
      rowNumber,
      sku,
      // 空白代表沒填，由上游當成 0；其他壞值也由上游丟錯，這裡不先猜。
      preorderAllowance: row[1],
      safetyStock: row[2],
      note: normalizeText(row[3]),
      updatedBy: normalizeText(row[4]),
      updatedAt: normalizeText(row[5])
    }));
  }
  return rows;
}

export async function readPreorderAllowances({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('預購額度讀取設定不完整');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${PREORDER_SHEET_NAME}'!A1:${PREORDER_LAST_COLUMN}${PREORDER_ROW_COUNT}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return parsePreorderRows(response.data.values ?? []);
}

// 缺口與推算實際庫存在「回寫未完成」時是 null，代表這一輪不發布這個數字；
// 寫成空白儲存格，不可寫 0，否則看板上看起來就是「不缺貨」。
function cell(value) {
  return value === null || value === undefined ? '' : value;
}

export function dashboardRowValues(row, updatedAt) {
  return [
    row.sku,
    row.displayName ?? '',
    row.flyingmouseStock,
    row.processing,
    row.preparing,
    row.unshipped,
    row.onOrder,
    row.preorderAllowance,
    row.safetyStock,
    cell(row.estimatedStock),
    cell(row.gap),
    row.status,
    row.note ?? '',
    normalizeText(row.updatedAt) || updatedAt
  ];
}

export function buildDashboardValues({ rows = [], updatedAt = '' } = {}) {
  const timestamp = normalizeText(updatedAt);
  if (!timestamp) throw new Error('庫存看板缺少更新時間');
  return [[...DASHBOARD_HEADERS], ...rows.map((row) => dashboardRowValues(row, timestamp))];
}

// 整張覆寫：先寫新的表格，再清掉上一輪留下來的多餘列。
// 順序不可顛倒——先清再寫的話，中途失敗會留下一張空看板。
export async function writeInventoryDashboard({ sheets, spreadsheetId, dashboard }) {
  if (!sheets || !spreadsheetId) throw new Error('庫存看板寫入設定不完整');
  const values = buildDashboardValues(dashboard);
  if (values.length > DASHBOARD_ROW_COUNT) {
    throw new Error(`${DASHBOARD_SHEET_NAME} 需要 ${values.length} 列，超過上限 ${DASHBOARD_ROW_COUNT}`);
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DASHBOARD_SHEET_NAME}'!A1:${DASHBOARD_LAST_COLUMN}${DASHBOARD_ROW_COUNT}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const existing = response.data.values ?? [];
  // 分頁還沒建立或表頭被改過就停手，不要把資料寫進位置不對的欄。
  assertSheetHeaders(existing[0] ?? [], DASHBOARD_HEADERS, DASHBOARD_SHEET_NAME);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${DASHBOARD_SHEET_NAME}'!A1:${DASHBOARD_LAST_COLUMN}${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  // existing 的尾端空白列不會回傳，所以 existing.length 就是上一輪的實際高度。
  const staleRows = Math.max(0, Math.min(existing.length, DASHBOARD_ROW_COUNT) - values.length);
  if (staleRows > 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${DASHBOARD_SHEET_NAME}'!A${values.length + 1}:${DASHBOARD_LAST_COLUMN}${values.length + staleRows}`
    });
  }

  return Object.freeze({
    sheet: DASHBOARD_SHEET_NAME,
    rows: values.length - 1,
    clearedRows: staleRows,
    updatedAt: normalizeText(dashboard?.updatedAt)
  });
}
