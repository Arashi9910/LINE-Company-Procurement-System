import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsRepository } from '../src/sheets/repository.js';
import { WRITEBACK_HEADERS } from '../src/flyingmouse/sheets-writeback.js';

function fakeSheets({
  ids = [['RQ-1'], ['RQ-2'], ['RQ-3'], ['RQ-4']],
  keys = [],
  imageRows = [],
  imageError,
  onWrite
} = {}) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('商品圖片對照')) {
            if (imageError) throw imageError;
            return { data: { values: imageRows } };
          }
          if (range.includes('SKU主檔')) {
            return { data: { values: [[
              'SKU-A', '商品 A', '紅色', '', 12, '', '', '商品 A｜紅色',
              '一般SKU', '是', '商品 A 紅色 SKU-A', '', '', '2026-07-13'
            ]] } };
          }
          if (range.includes('補貨追蹤')) return { data: { values: [] } };
          return { data: { values: [] } };
        },
        async batchGet() {
          return { data: { valueRanges: [{ values: ids }, { values: keys }] } };
        },
        async batchUpdate(request) {
          onWrite?.(request);
          return { data: {} };
        },
        async update() {
          return { data: {} };
        }
      }
    }
  };
}

test('SheetsRepository health check reads only the settings header', async () => {
  const ranges = [];
  const repository = new SheetsRepository({
    sheets: {
      spreadsheets: {
        values: {
          async get(request) {
            ranges.push(request);
            return { data: { values: [['Key', 'Value']] } };
          }
        }
      }
    },
    spreadsheetId: 'sheet-123'
  });

  assert.equal(await repository.checkHealth(), true);
  assert.deepEqual(ranges, [{
    spreadsheetId: 'sheet-123',
    range: "'系統設定'!A1:B1",
    valueRenderOption: 'UNFORMATTED_VALUE'
  }]);
});

test('SheetsRepository readiness validates the writeback sheet when the feature is enabled', async () => {
  const ranges = [];
  const repository = new SheetsRepository({
    sheets: {
      spreadsheets: {
        values: {
          async get(request) {
            ranges.push(request.range);
            return request.range.includes('飛鼠庫存回寫')
              ? { data: { values: [WRITEBACK_HEADERS] } }
              : { data: { values: [['Key', 'Value']] } };
          }
        }
      }
    },
    spreadsheetId: 'sheet-123',
    flyingmouseWritebackEnabled: true
  });

  assert.equal(await repository.checkHealth(), true);
  assert.deepEqual(ranges, ["'系統設定'!A1:B1", "'飛鼠庫存回寫'!A1:O1"]);
});

test('SheetsRepository parses product image mappings and tolerates a missing sheet', async () => {
  const imageRow = [
    'PART-1', 'SKU-A', 'PRODUCT-1', 'SALE-001', '商品 A', '紅色',
    'https://img.example/main.jpg', 'https://img.example/red.jpg',
    'https://img.example/list.jpg', '規格圖', '正常', '已綁定', '已配對', '飛鼠', '2026-07-14'
  ];
  const repository = new SheetsRepository({
    sheets: fakeSheets({ imageRows: [imageRow] }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(await repository.listProductImages(), [{
    productId: 'PRODUCT-1',
    sku: 'SKU-A',
    productCode: 'SALE-001',
    productName: '商品 A',
    variantName: '紅色',
    mainImageUrl: 'https://img.example/main.jpg',
    variantImageUrl: 'https://img.example/red.jpg',
    listImageUrl: 'https://img.example/list.jpg',
    imageStatus: '正常',
    bindingStatus: '已綁定'
  }]);

  const missingSheet = new SheetsRepository({
    sheets: fakeSheets({ imageError: Object.assign(new Error('Unable to parse range'), { code: 400 }) }),
    spreadsheetId: 'sheet-123'
  });
  assert.deepEqual(await missingSheet.listProductImages(), []);
});

test('SheetsRepository writes disjoint ranges without blocking spill formulas', async () => {
  let write;
  const repository = new SheetsRepository({
    sheets: fakeSheets({ onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-14T02:03:04.000Z'),
    uuid: () => 'abcd1234-0000-0000-0000-000000000000'
  });

  const result = await repository.createRequest({
    actor: { userId: 'U123', displayName: '小明' },
    items: [{ sku: 'SKU-A', quantity: 5 }],
    note: '測試',
    groupId: 'C123',
    idempotencyKey: 'abcdefghijklmnop'
  });

  assert.match(result.requestId, /^RQ-20260714-100304-abcd$/);
  assert.equal(result.items[0].unit, '件');
  assert.equal(write.requestBody.valueInputOption, 'RAW');
  const expectedTaipeiSerial = Date.UTC(2026, 6, 14, 10, 3, 4) / 86_400_000 + 25_569;
  assert.equal(write.requestBody.data[0].values[0][1], expectedTaipeiSerial);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'補貨追蹤'!A6:D6",
    "'補貨追蹤'!F6:J6",
    "'補貨追蹤'!M6:S6"
  ]);
  assert.equal(write.requestBody.data.some((entry) => /!E|!K|!L/.test(entry.range)), false);
});

test('SheetsRepository returns the prior request on an idempotent replay', async () => {
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: fakeSheets({
      ids: [['RQ-EXISTING']],
      keys: [['abcdefghijklmnop']],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  const result = await repository.createRequest({
    actor: { userId: 'U123', displayName: '小明' },
    items: [{ sku: 'SKU-A', quantity: 1 }],
    note: '',
    groupId: '',
    idempotencyKey: 'abcdefghijklmnop'
  });

  assert.equal(result.requestId, 'RQ-EXISTING');
  assert.equal(result.idempotentReplay, true);
  assert.equal(writes, 0);
});

test('SheetsRepository rejects a disabled or missing SKU before writing', async () => {
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: fakeSheets({ onWrite: () => { writes += 1; } }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.createRequest({
    actor: { userId: 'U123', displayName: '小明' },
    items: [{ sku: 'MISSING', quantity: 1 }],
    note: '',
    groupId: '',
    idempotencyKey: 'abcdefghijklmnop'
  }), /停用或不存在/);
  assert.equal(writes, 0);
});

test('SheetsRepository reads one request without loading the full tracking grid', async () => {
  const ranges = [];
  const rows = [
    ['RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 0, 5, '', '', 'SKU-A'],
    ['RQ-1', '2026/07/14 10:00', '小明', '商品 B', '件', 3, '已下單', 3, '2026/07/20', 0, 3, '', '', 'SKU-B']
  ];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          ranges.push(range);
          if (range === "'補貨追蹤'!A2:A5000") {
            return { data: { values: [['RQ-OTHER'], ['RQ-1'], ['RQ-1']] } };
          }
          if (range === "'補貨追蹤'!A3:S4") return { data: { values: rows } };
          throw new Error(`unexpected range: ${range}`);
        }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });

  const result = await repository.getRequest('RQ-1');

  assert.deepEqual(result.items.map((item) => item.rowNumber), [3, 4]);
  assert.equal('applicantUserId' in result, false);
  assert.equal('applicantUserId' in result.items[0], false);
  assert.deepEqual(ranges, ["'補貨追蹤'!A2:A5000", "'補貨追蹤'!A3:S4"]);
});

test('SheetsRepository exposes requester identity only through cancellation context', async () => {
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    5, '', '', 'SKU-A', 'OWNER', 'COMPANY', 'OWNER', '', 'create-key'
  ];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range === "'補貨追蹤'!A2:A5000") return { data: { values: [['RQ-1']] } };
          if (range === "'補貨追蹤'!A2:S2") return { data: { values: [row] } };
          throw new Error(`unexpected range: ${range}`);
        }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });

  const publicRequest = await repository.getRequest('RQ-1');
  const cancellationContext = await repository.getRequestForCancellation('RQ-1');

  assert.equal('requesterUserId' in publicRequest, false);
  assert.equal(cancellationContext.requesterUserId, 'OWNER');
  assert.equal(cancellationContext.groupId, 'COMPANY');
});

test('SheetsRepository lists tracking rows only through the last request row', async () => {
  const ranges = [];
  const trackingRows = [
    ['RQ-1', 46217.5, '小明', '商品 A', '件', 5, '待確認', '', '', 0, 5, '', '', 'SKU-A'],
    ['RQ-2', 46218.5, '小華', '商品 B', '組', 2, '已下單', 2, '', 0, 2, '', '', 'SKU-B']
  ];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          ranges.push(range);
          if (range === "'補貨追蹤'!A2:A5000") {
            return { data: { values: [['RQ-1'], ['RQ-2'], [], []] } };
          }
          if (range === "'補貨追蹤'!A2:N3") return { data: { values: trackingRows } };
          throw new Error(`unexpected range: ${range}`);
        }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(await repository.listRequestRows(), [
    {
      requestId: 'RQ-1', requestedAt: 46217.5, applicant: '小明', displayName: '商品 A',
      unit: '件', requestedQuantity: 5, status: '待確認', orderedQuantity: 0,
      receivedQuantity: 0, outstandingQuantity: 5, sku: 'SKU-A'
    },
    {
      requestId: 'RQ-2', requestedAt: 46218.5, applicant: '小華', displayName: '商品 B',
      unit: '組', requestedQuantity: 2, status: '已下單', orderedQuantity: 2,
      receivedQuantity: 0, outstandingQuantity: 2, sku: 'SKU-B'
    }
  ]);
  assert.deepEqual(ranges, ["'補貨追蹤'!A2:A5000", "'補貨追蹤'!A2:N3"]);
});

function workflowSheets(trackingRow, onWrite, { operationRows = [], writebackRows = [] } = {}) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('操作紀錄')) return { data: { values: operationRows } };
          if (range.includes('飛鼠庫存回寫')) return { data: { values: writebackRows } };
          if (range.includes('補貨追蹤')) return { data: { values: [trackingRow] } };
          return { data: { values: [] } };
        },
        async batchUpdate(request) {
          onWrite(request);
          return { data: {} };
        }
      }
    }
  };
}

function cancellationSheets({ rows, operationRows = [], onWrite }) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range === "'操作紀錄'!A2:C5000") return { data: { values: operationRows } };
          if (range === "'補貨追蹤'!A2:A5000") {
            return { data: { values: rows.map((row) => [row[0]]) } };
          }
          if (range === `'補貨追蹤'!A2:S${rows.length + 1}`) {
            return { data: { values: rows } };
          }
          throw new Error(`unexpected range: ${range}`);
        },
        async batchUpdate(request) {
          onWrite?.(request);
          return { data: {} };
        }
      }
    }
  };
}

function orderAdditionSheets({ trackingRows, availableSkuRows, onWrite }) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('操作紀錄')) return { data: { values: [] } };
          if (range.includes('SKU主檔')) return { data: { values: availableSkuRows } };
          if (range === "'補貨追蹤'!A2:A5000") {
            return { data: { values: trackingRows.map((row) => [row[0]]) } };
          }
          const match = /!A(\d+):S(\d+)$/.exec(range);
          if (match) {
            const start = Number(match[1]);
            const end = Number(match[2]);
            return { data: { values: trackingRows.slice(start - 2, end - 1) } };
          }
          return { data: { values: [] } };
        },
        async batchUpdate(request) {
          onWrite(request);
          return { data: {} };
        }
      }
    }
  };
}

test('SheetsRepository cancels an entire pending request and records one operation', async () => {
  const rows = [
    ['RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0, 5, '', '', 'SKU-A', 'OWNER', 'COMPANY'],
    ['RQ-1', '2026/07/14 10:00', '小明', '商品 B', '件', 2, '待確認', '', '', 0, 2, '', '', 'SKU-B', 'OWNER', 'COMPANY']
  ];
  let write;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({ rows, onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });

  const result = await repository.cancelRequest({
    actor: { userId: 'OWNER' },
    requestId: 'RQ-1',
    idempotencyKey: 'line-event-cancel-1'
  });

  assert.deepEqual(result.items.map((item) => item.status), ['取消', '取消']);
  assert.equal(result.idempotentReplay, false);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'補貨追蹤'!G2",
    "'補貨追蹤'!Q2:R2",
    "'補貨追蹤'!G3",
    "'補貨追蹤'!Q3:R3",
    "'操作紀錄'!A2:F2"
  ]);
  assert.deepEqual(write.requestBody.data[4].values[0].slice(0, 4), [
    'line-event-cancel-1', '取消補貨', 'RQ-1', 'OWNER'
  ]);
});

test('SheetsRepository rejects cancellation after ordering has started', async () => {
  const rows = [[
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 0,
    5, '', '', 'SKU-A', 'OWNER', 'COMPANY'
  ]];
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({ rows, onWrite: () => { writes += 1; } }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.cancelRequest({
    actor: { userId: 'OWNER' }, requestId: 'RQ-1', idempotencyKey: 'line-event-cancel-2'
  }), /只有尚未下單/);
  assert.equal(writes, 0);
});

test('SheetsRepository cancels ordered items that have not started receiving', async () => {
  const rows = [
    [
      'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 0,
      5, '', '', 'SKU-A', 'OWNER', 'COMPANY'
    ],
    [
      'RQ-1', '2026/07/14 10:00', '小明', '商品 B', '件', 2, '取消', 0, '', 0,
      0, '', '', 'SKU-B', 'OWNER', 'COMPANY'
    ]
  ];
  let write;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({ rows, onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });

  const result = await repository.cancelRequest({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    idempotencyKey: 'line-event-cancel-ordered-1',
    mode: 'ordered'
  });

  assert.deepEqual(result.items.map((item) => item.status), ['取消', '取消']);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'補貨追蹤'!G2",
    "'補貨追蹤'!Q2:R2",
    "'操作紀錄'!A2:F2"
  ]);
  assert.deepEqual(write.requestBody.data[2].values[0].slice(0, 4), [
    'line-event-cancel-ordered-1', '取消採購', 'RQ-1', 'BUYER'
  ]);
});

test('SheetsRepository rejects ordered cancellation after receiving has started', async () => {
  const rows = [[
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '部分到貨', 5, '2026/07/20', 2,
    3, '', '', 'SKU-A', 'OWNER', 'COMPANY'
  ]];
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({ rows, onWrite: () => { writes += 1; } }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.cancelRequest({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    idempotencyKey: 'line-event-cancel-ordered-2',
    mode: 'ordered'
  }), /尚未到貨且狀態為已下單/);
  assert.equal(writes, 0);
});

test('SheetsRepository replays ordered cancellation idempotently', async () => {
  const rows = [[
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '取消', 5, '2026/07/20', 0,
    5, '', '', 'SKU-A', 'OWNER', 'COMPANY'
  ]];
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({
      rows,
      operationRows: [['line-event-cancel-ordered-1', '取消採購', 'RQ-1']],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  const result = await repository.cancelRequest({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    idempotencyKey: 'line-event-cancel-ordered-1',
    mode: 'ordered'
  });

  assert.equal(result.idempotentReplay, true);
  assert.equal(result.items[0].status, '取消');
  assert.equal(writes, 0);
});

test('SheetsRepository treats a repeated cancellation event as idempotent', async () => {
  const rows = [[
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '取消', '', '', 0,
    0, '', '', 'SKU-A', 'OWNER', 'COMPANY'
  ]];
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: cancellationSheets({
      rows,
      operationRows: [['line-event-cancel-1', '取消補貨', 'RQ-1']],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  const result = await repository.cancelRequest({
    actor: { userId: 'OWNER' }, requestId: 'RQ-1', idempotencyKey: 'line-event-cancel-1'
  });
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.items[0].status, '取消');
  assert.equal(writes, 0);
});

test('SheetsRepository confirms an order and records the operation atomically', async () => {
  let write;
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    '', '', '', 'SKU-A', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const repository = new SheetsRepository({
    sheets: workflowSheets(row, (request) => { write = request; }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-14T02:00:00.000Z')
  });

  const result = await repository.confirmOrder({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', orderedQuantity: 5, expectedDate: '2026-07-20' }],
    idempotencyKey: 'order-key-123456'
  });

  assert.equal(result.items[0].status, '已下單');
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'補貨追蹤'!G2:I2",
    "'補貨追蹤'!Q2:R2",
    "'操作紀錄'!A2:F2"
  ]);
  assert.equal(write.requestBody.data[2].values[0][1], '確認下單');
});

test('SheetsRepository appends approved purchase additions without overwriting later rows', async () => {
  let write;
  const original = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    '', '', '急件', 'SKU-A', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const unrelated = [
    'RQ-2', '2026/07/14 11:00', '小華', '商品 C', '件', 1, '待確認', '', '', 0,
    '', '', '', 'SKU-C', 'U2', 'C1', 'U2', '', 'other-key'
  ];
  const availableSkuRows = [[
    'SKU-B', '商品 B', '紅色', '', 7, '', '', '商品 B｜紅色', '', '是', '', '件', '', ''
  ]];
  const repository = new SheetsRepository({
    sheets: orderAdditionSheets({
      trackingRows: [original, unrelated],
      availableSkuRows,
      onWrite: (request) => { write = request; }
    }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-14T02:00:00.000Z')
  });

  const result = await repository.confirmOrder({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    items: [
      { sku: 'SKU-A', orderedQuantity: 5, expectedDate: '2026-07-20' },
      { sku: 'SKU-B', orderedQuantity: 3, expectedDate: '2026-07-21' }
    ],
    idempotencyKey: 'order-addition-1234'
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].requestedQuantity, 0);
  assert.equal(result.items[1].orderedQuantity, 3);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'補貨追蹤'!G2:I2",
    "'補貨追蹤'!Q2:R2",
    "'補貨追蹤'!A4:D4",
    "'補貨追蹤'!F4:J4",
    "'補貨追蹤'!M4:S4",
    "'操作紀錄'!A2:F2"
  ]);
  assert.deepEqual(write.requestBody.data[2].values[0], [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 B｜紅色'
  ]);
  assert.deepEqual(write.requestBody.data[3].values[0].slice(0, 3), [0, '已下單', 3]);
  assert.deepEqual(write.requestBody.data[4].values[0], [
    '急件', 'SKU-B', 'U1', 'C1', 'BUYER', 46217.41666666667, 'order-addition-1234'
  ]);
});

test('SheetsRepository rejects a purchase addition that is unavailable', async () => {
  let writes = 0;
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    '', '', '', 'SKU-A', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const repository = new SheetsRepository({
    sheets: orderAdditionSheets({
      trackingRows: [row],
      availableSkuRows: [],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.confirmOrder({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    items: [
      { sku: 'SKU-A', orderedQuantity: 5, expectedDate: '2026-07-20' },
      { sku: 'SKU-X', orderedQuantity: 1, expectedDate: '2026-07-20' }
    ],
    idempotencyKey: 'order-unavailable-1'
  }), /已停用或不存在/);
  assert.equal(writes, 0);
});

test('SheetsRepository rejects an order that omits an original item before writing', async () => {
  let writes = 0;
  const originalA = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    '', '', '', 'SKU-A', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const originalB = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 B', '件', 2, '待確認', '', '', 0,
    '', '', '', 'SKU-B', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const repository = new SheetsRepository({
    sheets: orderAdditionSheets({
      trackingRows: [originalA, originalB],
      availableSkuRows: [],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.confirmOrder({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', orderedQuantity: 5, expectedDate: '2026-07-20' }],
    idempotencyKey: 'order-missing-item-1'
  }), /原補貨品項不可省略/);
  assert.equal(writes, 0);
});

test('SheetsRepository rejects additions when the tracking sheet is full before writing', async () => {
  let writes = 0;
  const original = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '待確認', '', '', 0,
    '', '', '', 'SKU-A', 'U1', 'C1', 'U1', '', 'create-key'
  ];
  const trackingRows = Array.from({ length: 4999 }, (_, index) => (
    index === 0 ? original : [`RQ-FILL-${index}`]
  ));
  const availableSkuRows = [[
    'SKU-B', '商品 B', '紅色', '', 7, '', '', '商品 B｜紅色', '', '是', '', '件', '', ''
  ]];
  const repository = new SheetsRepository({
    sheets: orderAdditionSheets({
      trackingRows,
      availableSkuRows,
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.confirmOrder({
    actor: { userId: 'BUYER' },
    requestId: 'RQ-1',
    items: [
      { sku: 'SKU-A', orderedQuantity: 5, expectedDate: '2026-07-20' },
      { sku: 'SKU-B', orderedQuantity: 1, expectedDate: '2026-07-20' }
    ],
    idempotencyKey: 'order-sheet-full-1'
  }), /補貨追蹤表已滿/);
  assert.equal(writes, 0);
});

test('SheetsRepository accumulates partial receipts and prevents over-receipt', async () => {
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 2,
    3, '', '', 'SKU-A', 'U1', 'C1', 'BUYER', '', 'create-key'
  ];
  let write;
  const repository = new SheetsRepository({
    sheets: workflowSheets(row, (request) => { write = request; }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-14T03:00:00.000Z')
  });

  const result = await repository.confirmReceipt({
    actor: { userId: 'RECEIVER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', receivedQuantity: 2 }],
    idempotencyKey: 'receipt-key-1234'
  });
  assert.equal(result.items[0].status, '部分到貨');
  assert.equal(result.items[0].receivedQuantity, 4);
  assert.equal(write.requestBody.data[0].values[0][0], '部分到貨');
  assert.equal(write.requestBody.data[1].values[0][0], 4);

  await assert.rejects(repository.confirmReceipt({
    actor: { userId: 'RECEIVER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', receivedQuantity: 4 }],
    idempotencyKey: 'receipt-key-5678'
  }), /不可超過下單量/);
});

test('SheetsRepository atomically enqueues one FlyingMouse event per received SKU when enabled', async () => {
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 2,
    3, '', '', 'SKU-A', 'U1', 'C1', 'BUYER', '', 'create-key'
  ];
  let write;
  const repository = new SheetsRepository({
    sheets: workflowSheets(row, (request) => { write = request; }, {
      writebackRows: [WRITEBACK_HEADERS]
    }),
    spreadsheetId: 'sheet-123',
    flyingmouseWritebackEnabled: true,
    now: () => new Date('2026-07-14T03:00:00.000Z')
  });

  await repository.confirmReceipt({
    actor: { userId: 'RECEIVER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', receivedQuantity: 2 }],
    idempotencyKey: 'receipt-key-1234'
  });

  const ranges = write.requestBody.data.map((entry) => entry.range);
  assert.deepEqual(ranges, [
    "'補貨追蹤'!G2",
    "'補貨追蹤'!J2",
    "'補貨追蹤'!Q2:R2",
    "'操作紀錄'!A2:F2",
    "'飛鼠庫存回寫'!A2:O2"
  ]);
  assert.deepEqual(write.requestBody.data[4].values[0], [
    'receipt-key-1234:SKU-A',
    '2026-07-14 11:00:00',
    'RQ-1',
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
    'RECEIVER',
    ''
  ]);
});

test('SheetsRepository stops the entire receipt when the writeback sheet is invalid', async () => {
  const row = [
    'RQ-1', '2026/07/14 10:00', '小明', '商品 A', '件', 5, '已下單', 5, '2026/07/20', 2,
    3, '', '', 'SKU-A', 'U1', 'C1', 'BUYER', '', 'create-key'
  ];
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: workflowSheets(row, () => { writes += 1; }, { writebackRows: [['錯誤表頭']] }),
    spreadsheetId: 'sheet-123',
    flyingmouseWritebackEnabled: true
  });

  await assert.rejects(repository.confirmReceipt({
    actor: { userId: 'RECEIVER' },
    requestId: 'RQ-1',
    items: [{ sku: 'SKU-A', receivedQuantity: 1 }],
    idempotencyKey: 'receipt-key-invalid'
  }), /表頭不符/);
  assert.equal(writes, 0);
});

test('SheetsRepository finds pending and overdue reminders at Taipei time boundaries', async () => {
  const at = new Date('2026-07-14T02:00:00.000Z');
  const nowSerial = Date.UTC(2026, 6, 14, 10, 0, 0) / 86_400_000 + 25_569;
  const rows = [
    ['RQ-PENDING', nowSerial - 25 / 24, '小明', '商品 A', '件', 1, '待確認', '', '', '', '', '', '', 'A', 'U1', 'C1'],
    ['RQ-TOO-SOON', nowSerial - 23 / 24, '小明', '商品 B', '件', 1, '待確認', '', '', '', '', '', '', 'B', 'U1', 'C1'],
    ['RQ-OVERDUE', nowSerial - 48 / 24, '小明', '商品 C', '件', 2, '已下單', 2, Math.floor(nowSerial) - 1, 0, 2, '', '', 'C', 'U1', 'C2']
  ];
  const sheets = {
    spreadsheets: {
      values: {
        async get() { return { data: { values: rows } }; }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });
  const result = await repository.listReminderCandidates({ at, pendingAfterHours: 24 });

  assert.deepEqual(result.map((item) => [item.requestId, item.kind]), [
    ['RQ-PENDING', 'pending'],
    ['RQ-OVERDUE', 'overdue']
  ]);
});

test('SheetsRepository never overwrites a configured notification group', async () => {
  let writes = 0;
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          assert.equal(range, "'系統設定'!A2:B100");
          return { data: { values: [['NOTIFICATION_GROUP_ID', 'COMPANY']] } };
        },
        async update() {
          writes += 1;
          return { data: {} };
        }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });

  assert.equal(await repository.saveNotificationGroupId('COMPANY'), true);
  assert.equal(await repository.saveNotificationGroupId('OTHER'), false);
  assert.equal(writes, 0);
});

test('SheetsRepository registers the first notification group when the setting is empty', async () => {
  let update;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return { data: { values: [['NOTIFICATION_GROUP_ID', '']] } };
        },
        async update(request) {
          update = request;
          return { data: {} };
        }
      }
    }
  };
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'sheet-123' });

  assert.equal(await repository.saveNotificationGroupId('COMPANY'), true);
  assert.equal(update.range, "'系統設定'!B2");
  assert.deepEqual(update.requestBody.values, [['COMPANY']]);
});

function authorizationSheets({ authRows = [], operationRows = [], onWrite }) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('操作紀錄')) return { data: { values: operationRows } };
          if (range.includes('授權人員')) return { data: { values: authRows } };
          throw new Error(`unexpected range: ${range}`);
        },
        async batchUpdate(request) {
          onWrite?.(request);
          return { data: {} };
        }
      }
    }
  };
}

test('SheetsRepository grants a role and records its actor atomically', async () => {
  let write;
  const repository = new SheetsRepository({
    sheets: authorizationSheets({ onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-14T04:00:00.000Z')
  });

  const result = await repository.updateAuthorization({
    actor: { userId: 'ADMIN' },
    target: { userId: 'TARGET', displayName: '小明' },
    role: '採購確認',
    enabled: true,
    idempotencyKey: 'line-event-123456'
  });

  assert.deepEqual(result, { role: '採購確認', enabled: true, idempotentReplay: false });
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'授權人員'!A2:E2",
    "'操作紀錄'!A2:F2"
  ]);
  assert.deepEqual(write.requestBody.data[0].values[0], ['TARGET', '小明', '採購確認', '是', '']);
  assert.deepEqual(write.requestBody.data[1].values[0].slice(0, 4), [
    'line-event-123456', '授權', 'TARGET', 'ADMIN'
  ]);
});

test('SheetsRepository preserves a role when disabling and blocks self lockout', async () => {
  const authRows = [['ADMIN', '老闆', '管理員', '是', 46217], ['TARGET', '小華', '到貨確認', '是', 46218]];
  let write;
  const repository = new SheetsRepository({
    sheets: authorizationSheets({ authRows, onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123'
  });

  const result = await repository.updateAuthorization({
    actor: { userId: 'ADMIN' },
    target: { userId: 'TARGET', displayName: '小華' },
    enabled: false,
    idempotencyKey: 'line-disable-1234'
  });
  assert.deepEqual(result, { role: '到貨確認', enabled: false, idempotentReplay: false });
  assert.deepEqual(write.requestBody.data[0].values[0], ['TARGET', '小華', '到貨確認', '否', 46218]);

  await assert.rejects(repository.updateAuthorization({
    actor: { userId: 'ADMIN' },
    target: { userId: 'ADMIN', displayName: '老闆' },
    enabled: false,
    idempotencyKey: 'line-disable-self'
  }), /不能停用自己或移除自己的管理員權限/);
  await assert.rejects(repository.updateAuthorization({
    actor: { userId: 'ADMIN' },
    target: { userId: 'ADMIN', displayName: '老闆' },
    role: '申請人',
    enabled: true,
    idempotencyKey: 'line-demote-self-1'
  }), /不能停用自己或移除自己的管理員權限/);
});

test('SheetsRepository treats a repeated authorization event as idempotent', async () => {
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: authorizationSheets({
      authRows: [['TARGET', '小明', '採購確認', '是', '']],
      operationRows: [['line-event-123456', '授權', 'TARGET']],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(await repository.updateAuthorization({
    actor: { userId: 'ADMIN' },
    target: { userId: 'TARGET', displayName: '小明' },
    role: '採購確認',
    enabled: true,
    idempotencyKey: 'line-event-123456'
  }), { role: '採購確認', enabled: true, idempotentReplay: true });
  assert.equal(writes, 0);
});

function catalogTriggerSheets({ operationRows = [], onWrite }) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('操作紀錄')) return { data: { values: operationRows } };
          throw new Error(`unexpected range: ${range}`);
        },
        async update(request) {
          onWrite?.(request);
          return { data: {} };
        }
      }
    }
  };
}

test('SheetsRepository reserves one FlyingMouse catalog trigger in the operation log', async () => {
  let write;
  const repository = new SheetsRepository({
    sheets: catalogTriggerSheets({ onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    now: () => new Date('2026-07-22T04:00:00.000Z')
  });

  const result = await repository.reserveCatalogSyncTrigger({
    actor: { userId: 'ADMIN' },
    idempotencyKey: 'line-sync-123'
  });

  assert.deepEqual(result, { idempotentReplay: false });
  assert.equal(write.range, "'操作紀錄'!A2:F2");
  assert.deepEqual(write.requestBody.values[0].slice(0, 4), [
    'line-sync-123', '同步飛鼠商品', 'flyingmouse-catalog-sync', 'ADMIN'
  ]);
  assert.match(write.requestBody.values[0][5], /LINE 管理員觸發/);
});

test('SheetsRepository treats a repeated FlyingMouse catalog trigger as idempotent', async () => {
  let writes = 0;
  const repository = new SheetsRepository({
    sheets: catalogTriggerSheets({
      operationRows: [['line-sync-123', '同步飛鼠商品', 'flyingmouse-catalog-sync']],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(await repository.reserveCatalogSyncTrigger({
    actor: { userId: 'ADMIN' },
    idempotencyKey: 'line-sync-123'
  }), { idempotentReplay: true });
  assert.equal(writes, 0);
});

test('SheetsRepository rejects a catalog trigger key already used by another operation', async () => {
  const repository = new SheetsRepository({
    sheets: catalogTriggerSheets({
      operationRows: [['line-sync-conflict', '取消補貨', 'RQ-1']]
    }),
    spreadsheetId: 'sheet-123'
  });

  await assert.rejects(repository.reserveCatalogSyncTrigger({
    actor: { userId: 'ADMIN' },
    idempotencyKey: 'line-sync-conflict'
  }), /操作金鑰已被其他操作使用/);
});
