import { MAIN_HEADERS, MAIN_SHEET_NAME } from './sheets-review.js';

export const WRITEBACK_SHEET_NAME = '飛鼠庫存回寫';
export const WRITEBACK_HEADERS = Object.freeze([
  '事件ID',
  '建立時間',
  '補貨單號',
  'SKU',
  '本次到貨量',
  '狀態',
  '嘗試次數',
  '下次重試時間',
  '飛鼠貨品ID',
  '更新前庫存',
  '預期更新後庫存',
  '完成時間',
  '最後錯誤',
  'LINE操作人ID',
  '最後處理時間'
]);

export const WRITEBACK_STATUSES = Object.freeze([
  '待處理',
  '已準備',
  '等待重試',
  '已完成',
  '需人工確認'
]);

export const WRITEBACK_ROW_COUNT = 5000;

const STATUS_SET = new Set(WRITEBACK_STATUSES);
const TRANSITIONS = Object.freeze({
  待處理: new Set(['已準備', '等待重試', '需人工確認']),
  已準備: new Set(['已準備', '等待重試', '已完成', '需人工確認']),
  等待重試: new Set(['已準備', '等待重試', '需人工確認']),
  已完成: new Set(['已完成']),
  需人工確認: new Set(['需人工確認'])
});

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function timestampInTaipei(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('時間格式不正確');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

export function exactWritebackHeaders(actual) {
  const normalized = Array.from(
    { length: WRITEBACK_HEADERS.length },
    (_, index) => String(actual[index] ?? '')
  );
  if (normalized.some((header, index) => header !== WRITEBACK_HEADERS[index])) {
    throw new Error(`${WRITEBACK_SHEET_NAME} 表頭不符，停止寫入`);
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}必須是正整數`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}必須是非負整數`);
  return number;
}

function optionalNonNegativeInteger(value, label, { positive = false } = {}) {
  if (value === '' || value == null) return '';
  const number = nonNegativeInteger(value, label);
  if (positive && number < 1) throw new Error(`${label}必須是正整數`);
  return number;
}

function timestamp(value, label, { optional = false } = {}) {
  const normalized = normalizeText(value);
  if (!normalized && optional) return '';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    throw new Error(`${label}格式不正確`);
  }
  return normalized;
}

function validateIdentity(input) {
  const eventId = normalizeText(input.eventId);
  const requestId = normalizeText(input.requestId);
  const sku = normalizeText(input.sku);
  const actorUserId = normalizeText(input.actorUserId);
  if (!eventId || eventId.length > 400) throw new Error('回寫事件 ID 不正確');
  if (!requestId || requestId.length > 100) throw new Error('回寫補貨單號不正確');
  if (!sku || sku.length > 200) throw new Error('回寫 SKU 不正確');
  if (!actorUserId || actorUserId.length > 100) throw new Error('LINE 操作人 ID 不正確');
  return { eventId, requestId, sku, actorUserId };
}

function normalizeEvent(input) {
  const identity = validateIdentity(input);
  const status = normalizeText(input.status);
  if (!STATUS_SET.has(status)) throw new Error(`未知的回寫狀態：${status || '空白'}`);
  const event = {
    ...identity,
    rowNumber: input.rowNumber == null ? undefined : positiveInteger(input.rowNumber, '列號'),
    createdAt: timestamp(input.createdAt, '建立時間'),
    receivedQuantity: positiveInteger(input.receivedQuantity, '到貨量'),
    status,
    attempts: nonNegativeInteger(input.attempts ?? 0, '嘗試次數'),
    nextRetryAt: timestamp(input.nextRetryAt, '下次重試時間', { optional: true }),
    partId: optionalNonNegativeInteger(input.partId, '飛鼠貨品 ID', { positive: true }),
    beforeStock: optionalNonNegativeInteger(input.beforeStock, '更新前庫存'),
    targetStock: optionalNonNegativeInteger(input.targetStock, '預期更新後庫存'),
    completedAt: timestamp(input.completedAt, '完成時間', { optional: true }),
    lastError: normalizeText(input.lastError).slice(0, 500),
    processedAt: timestamp(input.processedAt, '最後處理時間', { optional: true })
  };
  if (event.status === '已準備') {
    if (event.partId === '' || event.beforeStock === '' || event.targetStock === '') {
      throw new Error('已準備事件缺少飛鼠貨品或庫存資訊');
    }
    if (event.targetStock !== event.beforeStock + event.receivedQuantity) {
      throw new Error('已準備事件的目標庫存不正確');
    }
  }
  if (event.status === '等待重試' && !event.nextRetryAt) {
    throw new Error('等待重試事件缺少下次重試時間');
  }
  if (event.status === '已完成' && (!event.completedAt || event.targetStock === '')) {
    throw new Error('已完成事件缺少完成時間或目標庫存');
  }
  return Object.freeze(event);
}

export function buildWritebackEvent({
  idempotencyKey,
  requestId,
  sku,
  receivedQuantity,
  actorUserId,
  createdAt = new Date()
}) {
  const key = normalizeText(idempotencyKey);
  const normalizedSku = normalizeText(sku);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new Error('到貨冪等鍵格式不正確');
  return normalizeEvent({
    eventId: `${key}:${normalizedSku}`,
    createdAt: timestampInTaipei(createdAt),
    requestId,
    sku: normalizedSku,
    receivedQuantity,
    status: '待處理',
    attempts: 0,
    nextRetryAt: '',
    partId: '',
    beforeStock: '',
    targetStock: '',
    completedAt: '',
    lastError: '',
    actorUserId,
    processedAt: ''
  });
}

export function writebackEventRow(input) {
  const event = normalizeEvent(input);
  return [
    event.eventId,
    event.createdAt,
    event.requestId,
    event.sku,
    event.receivedQuantity,
    event.status,
    event.attempts,
    event.nextRetryAt,
    event.partId,
    event.beforeStock,
    event.targetStock,
    event.completedAt,
    event.lastError,
    event.actorUserId,
    event.processedAt
  ];
}

export function parseWritebackRows(values) {
  exactWritebackHeaders(values[0] ?? []);
  const result = [];
  const eventIds = new Set();
  for (let index = 1; index < values.length; index += 1) {
    const row = Array.from({ length: WRITEBACK_HEADERS.length }, (_, column) => values[index]?.[column] ?? '');
    if (!row.some((value) => value !== '' && value != null)) continue;
    const event = normalizeEvent({
      rowNumber: index + 1,
      eventId: row[0],
      createdAt: row[1],
      requestId: row[2],
      sku: row[3],
      receivedQuantity: row[4],
      status: row[5],
      attempts: row[6],
      nextRetryAt: row[7],
      partId: row[8],
      beforeStock: row[9],
      targetStock: row[10],
      completedAt: row[11],
      lastError: row[12],
      actorUserId: row[13],
      processedAt: row[14]
    });
    if (eventIds.has(event.eventId)) throw new Error(`回寫事件 ID 重複：${event.eventId}`);
    eventIds.add(event.eventId);
    result.push(event);
  }
  return result;
}

async function listSheetProperties({ sheets, spreadsheetId }) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  return response.data.sheets?.map((sheet) => sheet.properties) ?? [];
}

function formatSheetRequests(sheetId, rowCount) {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 15 },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 0.929, green: 0.929, blue: 0.929 } },
            horizontalAlignment: 'CENTER',
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat(backgroundColorStyle,horizontalAlignment,textFormat)'
      }
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount'
      }
    },
    {
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 15 }
        }
      }
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 5, endColumnIndex: 6 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: WRITEBACK_STATUSES.map((userEnteredValue) => ({ userEnteredValue }))
          },
          strict: true,
          showCustomUi: true
        }
      }
    },
    ...[
      [0, 1, 300], [1, 2, 170], [2, 3, 170], [3, 4, 180], [4, 7, 110],
      [7, 8, 170], [8, 12, 125], [12, 13, 320], [13, 14, 220], [14, 15, 170]
    ].map(([startIndex, endIndex, pixelSize]) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
        properties: { pixelSize },
        fields: 'pixelSize'
      }
    }))
  ];
}

export async function ensureWritebackSheet({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('飛鼠庫存回寫分頁設定不完整');
  let properties = (await listSheetProperties({ sheets, spreadsheetId }))
    .find((sheet) => sheet.title === WRITEBACK_SHEET_NAME);
  let created = false;
  if (!properties) {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: WRITEBACK_SHEET_NAME,
              gridProperties: { rowCount: WRITEBACK_ROW_COUNT, columnCount: WRITEBACK_HEADERS.length }
            }
          }
        }]
      }
    });
    properties = response.data.replies?.[0]?.addSheet?.properties;
    if (!properties) {
      properties = (await listSheetProperties({ sheets, spreadsheetId }))
        .find((sheet) => sheet.title === WRITEBACK_SHEET_NAME);
    }
    if (!properties) throw new Error('建立飛鼠庫存回寫分頁後無法讀回分頁資訊');
    created = true;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${WRITEBACK_SHEET_NAME}'!A1:O1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...WRITEBACK_HEADERS]] }
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: formatSheetRequests(
          properties.sheetId,
          properties.gridProperties?.rowCount ?? WRITEBACK_ROW_COUNT
        )
      }
    });
  } else {
    if ((properties.gridProperties?.columnCount ?? 0) < WRITEBACK_HEADERS.length) {
      throw new Error(`${WRITEBACK_SHEET_NAME} 欄數不足，停止寫入`);
    }
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${WRITEBACK_SHEET_NAME}'!A1:O1`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    exactWritebackHeaders(response.data.values?.[0] ?? []);
  }
  return { properties, created };
}

export async function readWritebackEvents({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('飛鼠庫存回寫佇列設定不完整');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${WRITEBACK_SHEET_NAME}'!A1:O${WRITEBACK_ROW_COUNT}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return parseWritebackRows(response.data.values ?? []);
}

export async function listProcessableWritebacks({
  sheets,
  spreadsheetId,
  now = new Date(),
  limit = 20
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('回寫批次上限不正確');
  const nowText = timestampInTaipei(now);
  const events = (await readWritebackEvents({ sheets, spreadsheetId }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.rowNumber - right.rowNumber);
  const seenOpenSku = new Set();
  const result = [];
  for (const event of events) {
    if (event.status === '已完成') continue;
    if (seenOpenSku.has(event.sku)) continue;
    seenOpenSku.add(event.sku);
    const due = event.status === '待處理' || event.status === '已準備' ||
      (event.status === '等待重試' && event.nextRetryAt <= nowText);
    if (due) result.push(event);
    if (result.length >= limit) break;
  }
  return result;
}

export function transitionWritebackEvent(input, patch) {
  const current = normalizeEvent(input);
  const status = normalizeText(patch.status ?? current.status);
  if (!TRANSITIONS[current.status]?.has(status)) {
    throw new Error(`不允許的狀態轉換：${current.status} → ${status}`);
  }
  return normalizeEvent({
    ...current,
    status,
    attempts: patch.attempts ?? current.attempts,
    nextRetryAt: patch.nextRetryAt ?? current.nextRetryAt,
    partId: patch.partId ?? current.partId,
    beforeStock: patch.beforeStock ?? current.beforeStock,
    targetStock: patch.targetStock ?? current.targetStock,
    completedAt: patch.completedAt ?? current.completedAt,
    lastError: patch.lastError ?? current.lastError,
    processedAt: patch.processedAt ?? current.processedAt
  });
}

function writebackStateValues(event) {
  return [
    event.status,
    event.attempts,
    event.nextRetryAt,
    event.partId,
    event.beforeStock,
    event.targetStock,
    event.completedAt,
    event.lastError,
    event.actorUserId,
    event.processedAt
  ];
}

export async function writeWritebackEventState({ sheets, spreadsheetId, event }) {
  if (!sheets || !spreadsheetId) throw new Error('飛鼠庫存回寫狀態設定不完整');
  const normalized = normalizeEvent(event);
  if (!normalized.rowNumber || normalized.rowNumber < 2) throw new Error('回寫事件缺少有效列號');
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${WRITEBACK_SHEET_NAME}'!F${normalized.rowNumber}:O${normalized.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [writebackStateValues(normalized)]
    }
  });
  return normalized;
}

async function findMainSkuRow({ sheets, spreadsheetId, sku, operation }) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MAIN_SHEET_NAME}'!A1:E`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const values = response.data.values ?? [];
  const headers = Array.from({ length: 5 }, (_, index) => String(values[0]?.[index] ?? ''));
  if (headers.some((header, index) => header !== MAIN_HEADERS[index])) {
    throw new Error(`${MAIN_SHEET_NAME} 表頭不符，停止${operation}`);
  }
  const matches = [];
  for (let index = 1; index < values.length; index += 1) {
    if (normalizeText(values[index]?.[0]) === sku) matches.push(index + 1);
  }
  if (matches.length !== 1) {
    throw new Error(`${MAIN_SHEET_NAME} 必須且只能有一筆 SKU ${sku}`);
  }
  return matches[0];
}

export async function prepareWritebackEvent({ sheets, spreadsheetId, event }) {
  if (!sheets || !spreadsheetId) throw new Error('飛鼠庫存回寫準備設定不完整');
  const prepared = normalizeEvent(event);
  if (prepared.status !== '已準備') throw new Error('只有已準備事件可以刷新庫存快照');
  if (!prepared.rowNumber || prepared.rowNumber < 2) throw new Error('回寫事件缺少有效列號');
  const mainRow = await findMainSkuRow({
    sheets,
    spreadsheetId,
    sku: prepared.sku,
    operation: '準備回寫'
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        {
          range: `'${WRITEBACK_SHEET_NAME}'!F${prepared.rowNumber}:O${prepared.rowNumber}`,
          values: [writebackStateValues(prepared)]
        },
        {
          range: `'${MAIN_SHEET_NAME}'!E${mainRow}`,
          values: [[prepared.beforeStock]]
        }
      ]
    }
  });
  return prepared;
}

export async function completeWritebackEvent({ sheets, spreadsheetId, event, completedAt }) {
  if (!sheets || !spreadsheetId) throw new Error('飛鼠庫存回寫完成設定不完整');
  const completed = transitionWritebackEvent(event, {
    status: '已完成',
    completedAt,
    nextRetryAt: '',
    lastError: '',
    processedAt: completedAt
  });
  if (!completed.rowNumber || completed.rowNumber < 2) throw new Error('回寫事件缺少有效列號');
  const mainRow = await findMainSkuRow({
    sheets,
    spreadsheetId,
    sku: completed.sku,
    operation: '完成回寫'
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        {
          range: `'${WRITEBACK_SHEET_NAME}'!F${completed.rowNumber}:O${completed.rowNumber}`,
          values: [writebackStateValues(completed)]
        },
        {
          range: `'${MAIN_SHEET_NAME}'!E${mainRow}`,
          values: [[completed.targetStock]]
        }
      ]
    }
  });
  return completed;
}
