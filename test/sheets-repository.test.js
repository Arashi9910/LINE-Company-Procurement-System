import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsRepository } from '../src/sheets/repository.js';

function fakeSheets({ ids = [['RQ-1'], ['RQ-2'], ['RQ-3'], ['RQ-4']], keys = [], onWrite } = {}) {
  return {
    spreadsheets: {
      values: {
        async get({ range }) {
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
