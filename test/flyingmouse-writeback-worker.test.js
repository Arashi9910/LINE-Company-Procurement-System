import test from 'node:test';
import assert from 'node:assert/strict';
import { FlyingMouseWritebackError } from '../src/flyingmouse/inventory-writeback.js';
import {
  WRITEBACK_HEADERS,
  buildWritebackEvent,
  transitionWritebackEvent,
  writebackEventRow
} from '../src/flyingmouse/sheets-writeback.js';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';
import { processWritebackQueue } from '../src/flyingmouse/writeback-worker.js';

function part(stock = 10) {
  return {
    id: 933,
    no: 'SKU-A',
    mpn: null,
    gtin: null,
    name: '商品 A',
    spec_y: '紅色',
    spec_x: null,
    storage_location: null,
    op_remark: null,
    stock
  };
}

function queueEvent(overrides = {}) {
  return {
    ...buildWritebackEvent({
      idempotencyKey: 'receipt-key-123456',
      requestId: 'RQ-1',
      sku: 'SKU-A',
      receivedQuantity: 2,
      actorUserId: 'U1',
      createdAt: new Date('2026-07-16T02:00:00Z')
    }),
    ...overrides
  };
}

function sheetsFor(event, timeline = []) {
  const updates = [];
  const batches = [];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('飛鼠庫存回寫')) {
            return { data: { values: [WRITEBACK_HEADERS, writebackEventRow(event)] } };
          }
          if (range.includes('SKU主檔')) {
            return { data: { values: [MAIN_HEADERS.slice(0, 5), ['SKU-A', '商品 A', '', '', 10]] } };
          }
          throw new Error(`unexpected range: ${range}`);
        },
        async update(request) {
          updates.push(request);
          return { data: {} };
        },
        async batchUpdate(request) {
          batches.push(request);
          const queueStatus = request.requestBody.data?.[0]?.values?.[0]?.[0];
          const snapshot = request.requestBody.data?.[1]?.values?.[0]?.[0];
          timeline.push(`sheet:${queueStatus}:${snapshot}`);
          return { data: {} };
        }
      }
    }
  };
  return { sheets, updates, batches };
}

const silentLogger = { info() {}, warn() {}, error() {} };

test('processWritebackQueue prepares, applies, verifies, and completes one live event', async () => {
  const timeline = [];
  const state = sheetsFor(queueEvent(), timeline);
  const reads = [part(10), part(10), part(12)];
  const puts = [];
  const client = {
    async getBySku() {
      const result = reads.shift();
      timeline.push(`get:${result.stock}`);
      return result;
    },
    async putPart(id, payload) {
      puts.push({ id, payload });
      timeline.push(`put:${payload.stock}`);
    }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.deepEqual(result, {
    mode: 'live', found: 1, completed: 1, dryRun: 0, retryScheduled: 0, manualReview: 0, failed: 0
  });
  assert.equal(puts.length, 1);
  assert.equal(state.updates.length, 0);
  assert.equal(state.batches.length, 2);
  assert.deepEqual(timeline, [
    'get:10',
    'sheet:已準備:10',
    'get:10',
    'put:12',
    'get:12',
    'sheet:已完成:12'
  ]);
});

test('a retry after a successful PUT reuses the saved target instead of adding again', async () => {
  // PUT 已經把 10 加到 12，但驗證 GET 掛掉，事件被退避成「等待重試」。
  // 下一輪若依狀態重新 prepare，就會從 12 再加 2 變成 14，等於重複入庫。
  const waiting = transitionWritebackEvent(
    transitionWritebackEvent(queueEvent(), {
      status: '已準備',
      attempts: 1,
      partId: 933,
      beforeStock: 10,
      targetStock: 12,
      processedAt: '2026-07-16 10:05:00'
    }),
    {
      status: '等待重試',
      attempts: 1,
      nextRetryAt: '2026-07-16 10:10:00',
      lastError: 'NETWORK_ERROR: 驗證 GET 失敗',
      processedAt: '2026-07-16 10:05:00'
    }
  );
  const state = sheetsFor(waiting);
  const puts = [];
  // 有狀態的假飛鼠：PUT 會真的改掉庫存，重複入庫才看得出來。
  let stock = 12;
  const client = {
    async getBySku() { return part(stock); },
    async putPart(id, payload) {
      puts.push(payload.stock);
      stock = payload.stock;
    }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:15:00Z'),
    logger: silentLogger
  });

  // 目前庫存已經等於保存的 target，照規格只補登完成，不再 PUT。
  assert.deepEqual(result, {
    mode: 'live', found: 1, completed: 1, dryRun: 0, retryScheduled: 0, manualReview: 0, failed: 0
  });
  assert.deepEqual(puts, []);
  assert.equal(stock, 12);
});

test('a retry whose PUT never landed resends the same target, not a new one', async () => {
  const waiting = transitionWritebackEvent(
    transitionWritebackEvent(queueEvent(), {
      status: '已準備',
      attempts: 1,
      partId: 933,
      beforeStock: 10,
      targetStock: 12,
      processedAt: '2026-07-16 10:05:00'
    }),
    {
      status: '等待重試',
      attempts: 1,
      nextRetryAt: '2026-07-16 10:10:00',
      lastError: 'NETWORK_ERROR: PUT 失敗',
      processedAt: '2026-07-16 10:05:00'
    }
  );
  const state = sheetsFor(waiting);
  const reads = [part(10), part(12)];
  const puts = [];
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart(id, payload) { puts.push(payload.stock); }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:15:00Z'),
    logger: silentLogger
  });

  assert.equal(result.completed, 1);
  assert.deepEqual(puts, [12]);
});

test('a retry with a saved target still refuses to PUT when SKU主檔 is broken', async () => {
  const waiting = transitionWritebackEvent(
    transitionWritebackEvent(queueEvent(), {
      status: '已準備',
      attempts: 1,
      partId: 933,
      beforeStock: 10,
      targetStock: 12,
      processedAt: '2026-07-16 10:05:00'
    }),
    {
      status: '等待重試',
      attempts: 1,
      nextRetryAt: '2026-07-16 10:10:00',
      lastError: 'NETWORK_ERROR: PUT 失敗',
      processedAt: '2026-07-16 10:05:00'
    }
  );

  // 退避期間主檔被改壞的三種情況。規格第 5 節：這些情況一律不得 PUT。
  const brokenMains = {
    缺列: [MAIN_HEADERS.slice(0, 5), ['SKU-B', '商品 B', '', '', 1]],
    重複: [
      MAIN_HEADERS.slice(0, 5),
      ['SKU-A', '商品 A', '', '', 10],
      ['SKU-A', '商品 A 複製', '', '', 10]
    ],
    表頭不符: [['貨號', '商品名稱', '規格 1', '規格 2', '庫存'], ['SKU-A', '商品 A', '', '', 10]]
  };

  for (const [label, mainValues] of Object.entries(brokenMains)) {
    let puts = 0;
    const sheets = {
      spreadsheets: {
        values: {
          async get({ range }) {
            if (range.includes('飛鼠庫存回寫')) {
              return { data: { values: [WRITEBACK_HEADERS, writebackEventRow(waiting)] } };
            }
            if (range.includes('SKU主檔')) return { data: { values: mainValues } };
            throw new Error(`unexpected range: ${range}`);
          },
          async update() { return { data: {} }; },
          async batchUpdate() { return { data: {} }; }
        }
      }
    };
    const client = {
      async getBySku() { return part(10); },
      async putPart() { puts += 1; }
    };

    const result = await processWritebackQueue({
      sheets,
      spreadsheetId: 'sheet-123',
      withClient: async (operation) => operation(client),
      mode: 'live',
      now: () => new Date('2026-07-16T02:15:00Z'),
      logger: silentLogger
    });

    assert.equal(puts, 0, `${label} 不該送出 PUT`);
    assert.equal(result.completed, 0, `${label} 不該完成`);
    assert.equal(result.manualReview, 1, `${label} 應轉人工確認`);
  }
});

test('processWritebackQueue dry-run performs no PUT and no Sheet writes', async () => {
  const state = sheetsFor(queueEvent());
  const reads = [part(10), part(10)];
  let puts = 0;
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart() { puts += 1; }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'dry-run',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.equal(result.dryRun, 1);
  assert.equal(puts, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.batches.length, 0);
});

test('processWritebackQueue schedules a retry for a temporary API error', async () => {
  const state = sheetsFor(queueEvent());
  const client = {
    async getBySku() {
      throw new FlyingMouseWritebackError('暫時無法登入飛鼠', {
        code: 'NETWORK_ERROR',
        retryable: true
      });
    },
    async putPart() {}
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.equal(result.retryScheduled, 1);
  assert.equal(state.updates[0].requestBody.values[0][0], '等待重試');
  assert.equal(state.updates[0].requestBody.values[0][1], 1);
  assert.equal(state.updates[0].requestBody.values[0][2], '2026-07-16 10:10:00');
});

test('processWritebackQueue moves an ambiguous prepared event to manual review', async () => {
  const state = sheetsFor(queueEvent());
  const reads = [part(10), part(11)];
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart() { throw new Error('must not PUT'); }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.equal(result.manualReview, 1);
  assert.equal(state.batches[0].requestBody.data[0].values[0][0], '已準備');
  assert.deepEqual(state.updates.map((request) => request.requestBody.values[0][0]), ['需人工確認']);
  assert.equal(state.updates[0].requestBody.values[0][3], 933);
  assert.equal(state.updates[0].requestBody.values[0][4], 10);
  assert.equal(state.updates[0].requestBody.values[0][5], 12);
});

test('processWritebackQueue never PUTs when the pre-write snapshot batch fails', async () => {
  const state = sheetsFor(queueEvent());
  state.sheets.spreadsheets.values.batchUpdate = async () => {
    throw new Error('Google Sheets snapshot failed');
  };
  let puts = 0;
  const client = {
    async getBySku() { return part(10); },
    async putPart() { puts += 1; }
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.equal(result.manualReview, 1);
  assert.equal(puts, 0);
  assert.equal(state.updates[0].requestBody.values[0][0], '需人工確認');
  assert.equal(state.updates[0].requestBody.values[0][4], 10);
  assert.equal(state.updates[0].requestBody.values[0][5], 12);
});

test('processWritebackQueue stops retrying after the fifth attempt', async () => {
  const retrying = transitionWritebackEvent(queueEvent(), {
    status: '等待重試',
    attempts: 4,
    nextRetryAt: '2026-07-16 10:00:00'
  });
  const state = sheetsFor(retrying);
  const client = {
    async getBySku() {
      throw new FlyingMouseWritebackError('暫時錯誤', { code: 'HTTP_503', retryable: true });
    },
    async putPart() {}
  };

  const result = await processWritebackQueue({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    withClient: async (operation) => operation(client),
    mode: 'live',
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: silentLogger
  });

  assert.equal(result.manualReview, 1);
  assert.equal(state.updates[0].requestBody.values[0][0], '需人工確認');
  assert.equal(state.updates[0].requestBody.values[0][1], 5);
});
