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

// 同步狀態單獨一張分頁。放在「庫存看板」裡的話，整張覆寫會把它蓋掉——
// 而這張表存在的意義正是「看板覆寫失敗時還看得到上一次成功是什麼時候」。
export const SYNC_STATUS_SHEET_NAME = '看板同步狀態';
export const SYNC_STATUS_HEADERS = Object.freeze([
  '狀態',
  '最後成功時間',
  '最後嘗試時間',
  '訊息'
]);
export const SYNC_STATUS_ROW_COUNT = 10;
export const DASHBOARD_SYNC_OK = '正常';
export const DASHBOARD_SYNC_FAILED = '同步失敗';

// 讀取 SKU主檔 只為了取 SKU、顯示名稱與庫存快照。**絕不寫入**：
// 目錄同步每次寫入前都會比對 A:N 的欄位名稱，動了就會讓整批同步停止。
export const CATALOG_SHEET_NAME = 'SKU主檔';

function columnLetter(count) {
  if (count < 1 || count > 26) throw new Error('欄數超出支援範圍');
  return String.fromCharCode(64 + count);
}

const PREORDER_LAST_COLUMN = columnLetter(PREORDER_HEADERS.length);
const DASHBOARD_LAST_COLUMN = columnLetter(DASHBOARD_HEADERS.length);
const SYNC_STATUS_LAST_COLUMN = columnLetter(SYNC_STATUS_HEADERS.length);

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
    // 不綁列數上限：人工可以把分頁加長，寫在上限外的那一列會被無聲漏掉，
    // 計算層只會看到「沒填預購額度」，缺口直接少算整個額度。
    range: `'${PREORDER_SHEET_NAME}'!A:${PREORDER_LAST_COLUMN}`,
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

// 整張覆寫 + 同步狀態，**同一次 values.batchUpdate**。
// 分兩次請求的話：看板已經換成新的、狀態寫入卻失敗，就留下「看板是新的、
// 狀態說同步失敗、最後成功時間還是舊的」這種對不起來的組合，而且舊看板已經沒了。
// 看板內部也只用一次寫入：新表格後面補整列空白蓋掉上一輪多出來的列。
// 另外送一次 clear 的話，中間失敗會留下新舊混在一起的看板。
export async function writeInventoryDashboard({ sheets, spreadsheetId, dashboard, syncStatus }) {
  if (!sheets || !spreadsheetId) throw new Error('庫存看板寫入設定不完整');
  const values = buildDashboardValues(dashboard);
  const status = normalizeSyncStatus(syncStatus);
  if (status.status !== DASHBOARD_SYNC_OK) {
    throw new Error('庫存看板寫入只接受成功狀態，失敗請用 writeDashboardSyncStatus');
  }

  // 兩張分頁的表頭都要先驗過，不要只驗一張就把資料送出去。
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      `'${DASHBOARD_SHEET_NAME}'!A:${DASHBOARD_LAST_COLUMN}`,
      `'${SYNC_STATUS_SHEET_NAME}'!A1:${SYNC_STATUS_LAST_COLUMN}2`
    ],
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const existing = response.data.valueRanges?.[0]?.values ?? [];
  assertSheetHeaders(existing[0] ?? [], DASHBOARD_HEADERS, DASHBOARD_SHEET_NAME);
  assertSheetHeaders(
    response.data.valueRanges?.[1]?.values?.[0] ?? [],
    SYNC_STATUS_HEADERS,
    SYNC_STATUS_SHEET_NAME
  );

  // existing 的尾端空白列不會回傳，所以 existing.length 就是上一輪的實際高度。
  const blankRows = Math.max(0, existing.length - values.length);
  const payload = [
    ...values,
    ...Array.from({ length: blankRows }, () => DASHBOARD_HEADERS.map(() => ''))
  ];
  if (payload.length > DASHBOARD_ROW_COUNT) {
    throw new Error(`${DASHBOARD_SHEET_NAME} 需要 ${payload.length} 列，超過上限 ${DASHBOARD_ROW_COUNT}`);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        {
          range: `'${DASHBOARD_SHEET_NAME}'!A1:${DASHBOARD_LAST_COLUMN}${payload.length}`,
          values: payload
        },
        {
          range: `'${SYNC_STATUS_SHEET_NAME}'!A2:${SYNC_STATUS_LAST_COLUMN}2`,
          values: [syncStatusValues(status)]
        }
      ]
    }
  });

  return Object.freeze({
    sheet: DASHBOARD_SHEET_NAME,
    rows: values.length - 1,
    clearedRows: blankRows,
    updatedAt: normalizeText(dashboard?.updatedAt),
    syncStatus: status
  });
}

// 只取看板要用的三個欄位。庫存快照原樣傳下去：空白或壞值由
// src/services/inventory-dashboard.js 的 indexCatalog 丟錯，這裡不先猜成 0。
export async function readCatalogSnapshots({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('SKU主檔讀取設定不完整');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CATALOG_SHEET_NAME}'!A2:N`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return (response.data.values ?? [])
    .filter((row) => normalizeText(row?.[0]))
    .map((row) => Object.freeze({
      sku: normalizeText(row[0]),
      // 補貨顯示名稱優先，沒有才用商品名稱，比照 repository 的 catalogSku。
      displayName: normalizeText(row[7]) || normalizeText(row[1]) || normalizeText(row[0]),
      stock: row[4]
    }));
}

export function parseSyncStatusRows(values) {
  assertSheetHeaders(values?.[0] ?? [], SYNC_STATUS_HEADERS, SYNC_STATUS_SHEET_NAME);
  const row = paddedRow(values?.[1], SYNC_STATUS_HEADERS.length);
  return Object.freeze({
    status: normalizeText(row[0]),
    lastSuccessAt: normalizeText(row[1]),
    lastAttemptAt: normalizeText(row[2]),
    message: normalizeText(row[3])
  });
}

export async function readDashboardSyncStatus({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('看板同步狀態讀取設定不完整');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SYNC_STATUS_SHEET_NAME}'!A1:${SYNC_STATUS_LAST_COLUMN}2`
  });
  return parseSyncStatusRows(response.data.values ?? []);
}

// 錯誤訊息會寫進試算表，也可能被 LINE 指令帶出去。
// 用黑名單只遮「關鍵字後面第一個詞」是擋不住的：
//   Authorization: Bearer secret123   → 只遮掉 Bearer，secret123 還在
//   Cookie: a=1; session=secret123    → 只遮掉 a=1
//   {"password":"secret123"}          → 引號格式根本不匹配
// 所以改成**截斷**：看到敏感關鍵字就把那個字之後的全部砍掉，不去猜值在哪裡結束。
// 另外把 32 字以上、長得像 token 的連續字串整段換掉。
const SENSITIVE_KEYWORD = /(password|passwd|cookie|authorization|bearer|credential|secret|token|api[-_ ]?key|private[-_ ]?key)/i;
const OPAQUE_RUN = /[A-Za-z0-9._\-+/=]{32,}/g;

export function safeSyncMessage(value) {
  const flat = String(value ?? '').replace(/[\r\n]+/g, ' ');
  const hit = SENSITIVE_KEYWORD.exec(flat);
  const truncated = hit ? `${flat.slice(0, hit.index)}<redacted>` : flat;
  return truncated.replace(OPAQUE_RUN, '<redacted>').trim().slice(0, 300);
}

function normalizeSyncStatus({ status, lastSuccessAt = '', lastAttemptAt, message = '' } = {}) {
  if (![DASHBOARD_SYNC_OK, DASHBOARD_SYNC_FAILED].includes(status)) {
    throw new Error(`看板同步狀態不正確：${status}`);
  }
  const attemptedAt = normalizeText(lastAttemptAt);
  if (!attemptedAt) throw new Error('看板同步狀態缺少最後嘗試時間');
  return Object.freeze({
    status,
    lastSuccessAt: normalizeText(lastSuccessAt),
    lastAttemptAt: attemptedAt,
    message: safeSyncMessage(message)
  });
}

function syncStatusValues(status) {
  return [status.status, status.lastSuccessAt, status.lastAttemptAt, status.message];
}

export async function writeDashboardSyncStatus({
  sheets,
  spreadsheetId,
  status,
  lastSuccessAt = '',
  lastAttemptAt,
  message = ''
}) {
  if (!sheets || !spreadsheetId) throw new Error('看板同步狀態寫入設定不完整');
  const normalized = normalizeSyncStatus({ status, lastSuccessAt, lastAttemptAt, message });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SYNC_STATUS_SHEET_NAME}'!A2:${SYNC_STATUS_LAST_COLUMN}2`,
    valueInputOption: 'RAW',
    requestBody: { values: [syncStatusValues(normalized)] }
  });
  return normalized;
}
