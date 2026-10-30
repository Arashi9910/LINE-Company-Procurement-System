import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSalesNameSync } from '../scripts/setup-sales-name-sync.mjs';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';
import { TRACKING_HEADERS } from '../src/sheets/order-spec-correction.js';

function sheetsFor({ catalogHeader, trackingHeader, catalogColumns, trackingColumns }) {
  const calls = { widen: [], writes: [] };
  return {
    calls,
    sheets: {
      spreadsheets: {
        async get() {
          return {
            data: {
              sheets: [
                {
                  properties: {
                    sheetId: 1,
                    title: 'SKU主檔',
                    gridProperties: { columnCount: catalogColumns }
                  }
                },
                {
                  properties: {
                    sheetId: 2,
                    title: '補貨追蹤',
                    gridProperties: { columnCount: trackingColumns }
                  }
                }
              ]
            }
          };
        },
        async batchUpdate(request) {
          calls.widen.push(...request.requestBody.requests);
          return { data: {} };
        },
        values: {
          // 真實分頁讀不到還不存在的欄。要求超出網格的範圍就是錯，不能賴在 API 會裁切。
          async batchGet({ ranges }) {
            const limits = [catalogColumns, trackingColumns];
            for (const [index, range] of ranges.entries()) {
              const last = /![A-Z]+\d*:([A-Z]+)/.exec(range)[1];
              const width = [...last]
                .reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
              assert.ok(
                width <= limits[index],
                `${range} 超出分頁現有的 ${limits[index]} 欄`
              );
            }
            return {
              data: {
                valueRanges: [{ values: [catalogHeader] }, { values: [trackingHeader] }]
              }
            };
          },
          async batchUpdate(request) {
            calls.writes.push(...request.requestBody.data);
            return { data: {} };
          }
        }
      }
    }
  };
}

test('setup widens both sheets and writes the new headers', async () => {
  const state = sheetsFor({
    catalogHeader: MAIN_HEADERS.slice(0, -1),
    trackingHeader: TRACKING_HEADERS.slice(0, -1),
    catalogColumns: MAIN_HEADERS.length - 1,
    trackingColumns: TRACKING_HEADERS.length - 1
  });

  const result = await setupSalesNameSync({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.equal(result.widened, 2);
  assert.equal(result.headersWritten, 2);
  assert.deepEqual(state.calls.widen.map((request) => request.appendDimension.length), [1, 1]);
  assert.deepEqual(state.calls.writes.map((entry) => entry.range), [
    "'SKU主檔'!A1:O1",
    "'補貨追蹤'!A1:W1"
  ]);
  assert.deepEqual(state.calls.writes[0].values[0], [...MAIN_HEADERS]);
  assert.deepEqual(state.calls.writes[1].values[0], [...TRACKING_HEADERS]);
});

test('setup is a no-op once both headers are in place', async () => {
  const state = sheetsFor({
    catalogHeader: [...MAIN_HEADERS],
    trackingHeader: [...TRACKING_HEADERS],
    catalogColumns: MAIN_HEADERS.length,
    trackingColumns: TRACKING_HEADERS.length
  });

  const result = await setupSalesNameSync({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(result, { widened: 0, headersWritten: 0, changes: [], dryRun: false });
  assert.equal(state.calls.widen.length, 0);
  assert.equal(state.calls.writes.length, 0);
});

// 有人搬過欄位時補表頭會讓既有資料整排錯位，所以要停下來而不是硬寫。
test('setup stops when an existing header does not match', async () => {
  const moved = [...MAIN_HEADERS];
  [moved[4], moved[5]] = [moved[5], moved[4]];
  const state = sheetsFor({
    catalogHeader: moved,
    trackingHeader: [...TRACKING_HEADERS],
    catalogColumns: MAIN_HEADERS.length,
    trackingColumns: TRACKING_HEADERS.length
  });

  await assert.rejects(
    setupSalesNameSync({ sheets: state.sheets, spreadsheetId: 'sheet-123' }),
    /SKU主檔 第 E 欄的表頭/
  );
  assert.equal(state.calls.writes.length, 0);
});

test('setup writes nothing on a dry run', async () => {
  const state = sheetsFor({
    catalogHeader: MAIN_HEADERS.slice(0, -1),
    trackingHeader: TRACKING_HEADERS.slice(0, -1),
    catalogColumns: MAIN_HEADERS.length - 1,
    trackingColumns: TRACKING_HEADERS.length - 1
  });

  const result = await setupSalesNameSync({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dryRun: true
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.headersWritten, 2);
  assert.equal(state.calls.widen.length, 0);
  assert.equal(state.calls.writes.length, 0);
});
