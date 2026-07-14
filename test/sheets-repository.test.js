import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsRepository } from '../src/sheets/repository.js';

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
  assert.deepEqual(ranges, ["'補貨追蹤'!A2:A5000", "'補貨追蹤'!A3:S4"]);
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

function workflowSheets(trackingRow, onWrite) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('操作紀錄')) return { data: { values: [] } };
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
