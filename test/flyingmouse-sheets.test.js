import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReferenceCatalogFromSheet } from '../src/flyingmouse/sheets-baseline.js';

test('loadReferenceCatalogFromSheet reads only SKU主檔 A:D', async () => {
  let request;
  const sheets = {
    spreadsheets: {
      values: {
        async get(input) {
          request = input;
          return {
            data: {
              values: [
                ['A', '商品 A', '紅', '大'],
                ['A', '商品 A 重複', '', ''],
                ['', '缺少 SKU', '', '']
              ]
            }
          };
        }
      }
    }
  };

  const result = await loadReferenceCatalogFromSheet({ sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(request, {
    spreadsheetId: 'sheet-123',
    range: "'SKU主檔'!A2:D",
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  assert.equal(result.metadata.rowCount, 3);
  assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.items.map((item) => item.rowNumber), [2, 3, 4]);
});
