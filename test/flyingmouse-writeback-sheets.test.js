import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITEBACK_HEADERS,
  WRITEBACK_SHEET_NAME,
  buildWritebackEvent,
  completeWritebackEvent,
  ensureWritebackSheet,
  listProcessableWritebacks,
  parseWritebackRows,
  prepareWritebackEvent,
  transitionWritebackEvent,
  writeWritebackEventState,
  writebackEventRow
} from '../src/flyingmouse/sheets-writeback.js';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';

function event(overrides = {}) {
  return buildWritebackEvent({
    idempotencyKey: 'receipt-key-123456',
    requestId: 'RQ-20260716-001',
    sku: 'SKU-A',
    receivedQuantity: 2,
    actorUserId: 'U123',
    createdAt: new Date('2026-07-16T02:03:04Z'),
    ...overrides
  });
}

test('buildWritebackEvent creates a stable per-SKU event and row', () => {
  const item = event();

  assert.equal(item.eventId, 'receipt-key-123456:SKU-A');
  assert.equal(item.createdAt, '2026-07-16 10:03:04');
  assert.equal(item.status, '待處理');
  assert.deepEqual(writebackEventRow(item), [
    'receipt-key-123456:SKU-A',
    '2026-07-16 10:03:04',
    'RQ-20260716-001',
    'SKU-A',
    2,
    '待處理',
    0,
    '',
    '',
    '',
    '',
    '',
    '',
    'U123',
    ''
  ]);
});

test('parseWritebackRows validates headers, values, and duplicate event IDs', () => {
  const row = writebackEventRow(event());
  const parsed = parseWritebackRows([WRITEBACK_HEADERS, row]);

  assert.equal(parsed[0].rowNumber, 2);
  assert.equal(parsed[0].receivedQuantity, 2);
  assert.throws(
    () => parseWritebackRows([WRITEBACK_HEADERS, row, row]),
    /事件 ID 重複/
  );
  assert.throws(
    () => parseWritebackRows([['錯誤表頭'], row]),
    /表頭不符/
  );
  assert.throws(
    () => parseWritebackRows([WRITEBACK_HEADERS, [...row.slice(0, 4), 0, ...row.slice(5)]]),
    /到貨量必須是正整數/
  );
});

test('ensureWritebackSheet creates and formats a native queue sheet', async () => {
  const structural = [];
  const values = [];
  const sheets = {
    spreadsheets: {
      async get() {
        return { data: { sheets: [] } };
      },
      async batchUpdate(request) {
        structural.push(request);
        if (structural.length === 1) {
          return {
            data: {
              replies: [{ addSheet: { properties: {
                sheetId: 88,
                title: WRITEBACK_SHEET_NAME,
                gridProperties: { rowCount: 5000, columnCount: WRITEBACK_HEADERS.length }
              } } }]
            }
          };
        }
        return { data: {} };
      },
      values: {
        async update(request) {
          values.push(request);
          return { data: {} };
        }
      }
    }
  };

  const result = await ensureWritebackSheet({ sheets, spreadsheetId: 'sheet-123' });

  assert.equal(result.created, true);
  assert.equal(values[0].range, `'${WRITEBACK_SHEET_NAME}'!A1:O1`);
  assert.deepEqual(values[0].requestBody.values[0], WRITEBACK_HEADERS);
  const formatRequests = structural[1].requestBody.requests;
  assert.equal(formatRequests.some((request) => request.setBasicFilter), true);
  assert.equal(formatRequests.some((request) => request.setDataValidation), true);
});

test('listProcessableWritebacks orders events and blocks later events for the same SKU', async () => {
  const first = event({ idempotencyKey: 'receipt-key-111111', createdAt: new Date('2026-07-16T01:00:00Z') });
  const laterSameSku = event({ idempotencyKey: 'receipt-key-222222', createdAt: new Date('2026-07-16T01:01:00Z') });
  const otherSku = event({
    idempotencyKey: 'receipt-key-333333',
    sku: 'SKU-B',
    createdAt: new Date('2026-07-16T01:02:00Z')
  });
  const retryLater = transitionWritebackEvent(otherSku, {
    status: '等待重試',
    nextRetryAt: '2026-07-16 11:30:00',
    attempts: 1
  });
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return {
            data: {
              values: [
                WRITEBACK_HEADERS,
                writebackEventRow(first),
                writebackEventRow(laterSameSku),
                writebackEventRow(retryLater)
              ]
            }
          };
        }
      }
    }
  };

  const result = await listProcessableWritebacks({
    sheets,
    spreadsheetId: 'sheet-123',
    now: new Date('2026-07-16T03:00:00Z'),
    limit: 20
  });

  assert.deepEqual(result.map((item) => item.eventId), ['receipt-key-111111:SKU-A']);
});

test('transition and writeWritebackEventState update only mutable F:O columns', async () => {
  const prepared = transitionWritebackEvent({ ...event(), rowNumber: 7 }, {
    status: '已準備',
    attempts: 1,
    partId: 933,
    beforeStock: 10,
    targetStock: 12,
    processedAt: '2026-07-16 10:05:00'
  });
  let write;
  const sheets = {
    spreadsheets: {
      values: {
        async update(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  await writeWritebackEventState({ sheets, spreadsheetId: 'sheet-123', event: prepared });

  assert.equal(write.range, `'${WRITEBACK_SHEET_NAME}'!F7:O7`);
  assert.deepEqual(write.requestBody.values[0], [
    '已準備', 1, '', 933, 10, 12, '', '', 'U123', '2026-07-16 10:05:00'
  ]);
  assert.throws(
    () => transitionWritebackEvent(prepared, { status: '待處理' }),
    /不允許的狀態轉換/
  );
});

test('completeWritebackEvent atomically completes the queue and refreshes SKU主檔 stock', async () => {
  const prepared = transitionWritebackEvent({ ...event(), rowNumber: 7 }, {
    status: '已準備',
    attempts: 1,
    partId: 933,
    beforeStock: 10,
    targetStock: 12,
    processedAt: '2026-07-16 10:05:00'
  });
  let write;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return { data: { values: [MAIN_HEADERS.slice(0, 5), ['SKU-A', '商品 A', '', '', 10]] } };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const completed = await completeWritebackEvent({
    sheets,
    spreadsheetId: 'sheet-123',
    event: prepared,
    completedAt: '2026-07-16 10:06:00'
  });

  assert.equal(completed.status, '已完成');
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    `'${WRITEBACK_SHEET_NAME}'!F7:O7`,
    "'SKU主檔'!E2"
  ]);
  assert.equal(write.requestBody.data[1].values[0][0], 12);
});

test('prepareWritebackEvent atomically persists prepared state and refreshes the current SKU snapshot', async () => {
  const prepared = transitionWritebackEvent({ ...event(), rowNumber: 7 }, {
    status: '已準備',
    attempts: 1,
    partId: 933,
    beforeStock: 10,
    targetStock: 12,
    processedAt: '2026-07-16 10:05:00'
  });
  let write;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return { data: { values: [MAIN_HEADERS.slice(0, 5), ['SKU-A', '商品 A', '', '', 99]] } };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await prepareWritebackEvent({
    sheets,
    spreadsheetId: 'sheet-123',
    event: prepared
  });

  assert.equal(result.status, '已準備');
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    `'${WRITEBACK_SHEET_NAME}'!F7:O7`,
    "'SKU主檔'!E2"
  ]);
  assert.equal(write.requestBody.data[0].values[0][0], '已準備');
  assert.equal(write.requestBody.data[1].values[0][0], 10);
});
