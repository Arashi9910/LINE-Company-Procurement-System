import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_IMAGE_HEADERS,
  syncCatalogItems,
  syncInventorySnapshots,
  syncProductImages
} from '../src/flyingmouse/sheets-operational.js';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';

function source(partNumber, stock) {
  return { partNumber, stock };
}

function catalogSource(overrides = {}) {
  return {
    partNumber: 'SKU-A',
    productName: '新版商品 A',
    spec1: '紅色',
    spec2: '大',
    stock: 8,
    gtin: '0012345',
    location: 'A-01',
    ...overrides
  };
}

function catalogSheets({ rows, rowCount = 20, onWrite }) {
  return {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: 3,
                title: 'SKU主檔',
                gridProperties: { rowCount, columnCount: MAIN_HEADERS.length }
              }
            }]
          }
        };
      },
      values: {
        async get({ range }) {
          assert.equal(range, `'SKU主檔'!A1:N${rowCount}`);
          return { data: { values: [[...MAIN_HEADERS], ...rows] } };
        },
        async batchUpdate(request) {
          onWrite?.(request);
          return { data: {} };
        }
      }
    }
  };
}

test('catalog sync inserts new SKUs and refreshes every source-owned B:H field', async () => {
  const rows = [
    [
      'SKU-A', '舊商品', '藍色', '', 3, 'old-gtin', 'OLD', '人工舊顯示名',
      '組合品', '否', '=FORMULA', '盒', '飛鼠', '=UPDATED'
    ],
    [],
    ['MANUAL', '人工商品', '', '', 2, '', '', '人工商品', '一般SKU', '是', '', '件', '人工', '']
  ];
  let write;
  const result = await syncCatalogItems({
    sheets: catalogSheets({ rows, onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [
      catalogSource(),
      catalogSource({
        partNumber: 'SKU-B', productName: '全新商品', spec1: '', spec2: '二入組',
        stock: 4, gtin: '0099', location: 'B-02'
      })
    ]
  });

  assert.deepEqual(result, {
    dryRun: false,
    sourceRows: 2,
    mainRows: 2,
    managedRows: 1,
    matched: 1,
    coverage: 1,
    inserted: 1,
    updated: 1,
    unchanged: 0,
    sourceOnly: 1,
    mainOnly: 0
  });
  assert.deepEqual(write.requestBody.data, [
    {
      range: "'SKU主檔'!B2:H2",
      values: [['新版商品 A', '紅色', '大', 8, '0012345', 'A-01', '新版商品 A｜紅色｜大']]
    },
    {
      range: "'SKU主檔'!A3:J3",
      values: [[
        'SKU-B', '全新商品', '', '二入組', 4, '0099', 'B-02', '全新商品｜二入組',
        '一般SKU', '是'
      ]]
    },
    { range: "'SKU主檔'!L3:M3", values: [['件', '飛鼠']] }
  ]);
});

test('catalog sync rejects a source collision with a non-FlyingMouse supplier', async () => {
  let writes = 0;
  await assert.rejects(syncCatalogItems({
    sheets: catalogSheets({
      rows: [[
        'SKU-A', '人工商品', '', '', 1, '', '', '人工商品', '一般SKU', '是', '', '件', '人工', ''
      ]],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource()]
  }), /主要供應商不是飛鼠/);
  assert.equal(writes, 0);
});

test('catalog sync stops before writes when managed SKU coverage is too low', async () => {
  let writes = 0;
  const rows = [
    ['SKU-A', '商品 A', '', '', 1, '', '', '商品 A', '一般SKU', '是', '', '件', '飛鼠', ''],
    ['SKU-B', '商品 B', '', '', 1, '', '', '商品 B', '一般SKU', '是', '', '件', '飛鼠', '']
  ];
  await assert.rejects(syncCatalogItems({
    sheets: catalogSheets({ rows, onWrite: () => { writes += 1; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource({ partNumber: 'SKU-A', productName: '商品 A', spec1: '', spec2: '' })]
  }), /配對率 50\.0%/);
  assert.equal(writes, 0);
});

test('catalog sync preserves source-missing rows and fails safely when the sheet is full', async () => {
  const rows = [
    ['SKU-A', '商品 A', '', '', 1, '', '', '商品 A', '一般SKU', '是', '', '件', '飛鼠', ''],
    ['SKU-B', '商品 B', '', '', 1, '', '', '商品 B', '一般SKU', '是', '', '件', '飛鼠', '']
  ];
  const preserved = await syncCatalogItems({
    sheets: catalogSheets({ rows }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource({
      partNumber: 'SKU-A', productName: '商品 A', spec1: '', spec2: '', stock: 1,
      gtin: '', location: ''
    })],
    minimumCoverage: 0.5
  });
  assert.equal(preserved.mainOnly, 1);
  assert.equal(preserved.updated, 0);

  let writes = 0;
  await assert.rejects(syncCatalogItems({
    sheets: catalogSheets({ rows: [rows[0]], rowCount: 2, onWrite: () => { writes += 1; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [
      catalogSource({ partNumber: 'SKU-A', productName: '商品 A', spec1: '', spec2: '', stock: 1, gtin: '', location: '' }),
      catalogSource({ partNumber: 'SKU-C', productName: '商品 C' })
    ]
  }), /SKU主檔已滿/);
  assert.equal(writes, 0);
});

function image(overrides = {}) {
  return {
    partId: '1',
    sku: 'SKU-A',
    productId: '10',
    productCode: '100001',
    productName: '測試商品',
    spec: '藍色',
    mainImageUrl: 'https://img.fslol.com/pic/ss-select/100001/cover.jpg',
    variantImageUrl: 'https://img.fslol.com/10371/a/example.jpg',
    listImageUrl: 'https://img.fslol.com/10371/a/example.jpg',
    imageType: '規格圖',
    imageStatus: '正常',
    bindingStatus: '已綁定銷售商品',
    source: '飛鼠貨品列表',
    capturedAt: '2026-07-15 20:34:56',
    ...overrides
  };
}

function imageRow(item, matched = '已配對', sourceValue = item.source) {
  return [
    item.partId, item.sku, item.productId, item.productCode, item.productName, item.spec,
    item.mainImageUrl, item.variantImageUrl, item.listImageUrl, item.imageType,
    item.imageStatus, item.bindingStatus, matched, sourceValue, item.capturedAt
  ];
}

test('inventory sync writes only changed SKU主檔 E cells', async () => {
  let write;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return {
            data: {
              values: [
                MAIN_HEADERS.slice(0, 5),
                ['SKU-A', '商品 A', '', '', 3],
                ['SKU-B', '商品 B', '', '', 4]
              ]
            }
          };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await syncInventorySnapshots({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [source('SKU-A', 3), source('SKU-B', 9), source('SKU-C', 2)]
  });

  assert.deepEqual(result, {
    dryRun: false,
    sourceRows: 3,
    mainRows: 2,
    matched: 2,
    coverage: 1,
    updated: 1,
    unchanged: 1,
    sourceOnly: 1,
    mainOnly: 0
  });
  assert.deepEqual(write.requestBody.data, [{ range: "'SKU主檔'!E3", values: [[9]] }]);
});

test('inventory sync stops before writes when main coverage is too low', async () => {
  let writes = 0;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return {
            data: {
              values: [
                MAIN_HEADERS.slice(0, 5),
                ['SKU-A', '', '', '', 1],
                ['MISSING', '', '', '', 1]
              ]
            }
          };
        },
        async batchUpdate() {
          writes += 1;
          return { data: {} };
        }
      }
    }
  };

  await assert.rejects(
    syncInventorySnapshots({
      sheets,
      spreadsheetId: 'sheet-123',
      sourceItems: [source('SKU-A', 1)]
    }),
    /配對率 50\.0%/
  );
  assert.equal(writes, 0);
});

test('image sync is idempotent, protects manual rows, and inserts into the first empty row', async () => {
  const unchanged = image();
  const manual = image({ partId: '2', sku: 'SKU-B', productName: '來源新版名稱' });
  const inserted = image({ partId: '3', sku: 'SKU-C', productCode: '300003' });
  const oldManual = imageRow({ ...manual, productName: '人工名稱' }, '未配對', '人工維護');
  let write;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: 7,
                title: '商品圖片對照',
                gridProperties: { rowCount: 4, columnCount: 15 }
              }
            }]
          }
        };
      },
      values: {
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [PRODUCT_IMAGE_HEADERS, imageRow(unchanged), oldManual] },
                { values: [[MAIN_HEADERS[0]], ['SKU-A']] }
              ]
            }
          };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await syncProductImages({
    sheets,
    spreadsheetId: 'sheet-123',
    imageItems: [unchanged, manual, inserted]
  });

  assert.deepEqual(result, {
    dryRun: false,
    captured: 3,
    inserted: 1,
    updated: 0,
    unchanged: 1,
    protected: 1,
    preservedBindings: 0,
    matchedMain: 1,
    unmatchedMain: 2,
    expandedRows: 0
  });
  assert.equal(write.requestBody.data.length, 1);
  assert.equal(write.requestBody.data[0].range, "'商品圖片對照'!A4:O4");
  assert.equal(write.requestBody.data[0].values[0][12], '未配對');
});

test('image sync expands capacity and updates only source-managed changed rows', async () => {
  const changed = image({ productName: '新版名稱' });
  const inserted = image({ partId: '2', sku: 'SKU-B' });
  const structural = [];
  let write;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: 7,
                title: '商品圖片對照',
                gridProperties: { rowCount: 2, columnCount: 15 }
              }
            }]
          }
        };
      },
      async batchUpdate(request) {
        structural.push(request);
        return { data: {} };
      },
      values: {
        async batchGet() {
          const old = imageRow({ ...changed, productName: '舊版名稱' });
          return {
            data: {
              valueRanges: [
                { values: [PRODUCT_IMAGE_HEADERS, old] },
                { values: [[MAIN_HEADERS[0]], ['SKU-A'], ['SKU-B']] }
              ]
            }
          };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await syncProductImages({
    sheets,
    spreadsheetId: 'sheet-123',
    imageItems: [changed, inserted]
  });

  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.expandedRows, 100);
  assert.equal(structural[0].requestBody.requests[0].appendDimension.length, 100);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'商品圖片對照'!A2:O2",
    "'商品圖片對照'!A3:O3"
  ]);
});

test('image sync never downgrades a previously bound product when the page omits its binding', async () => {
  const current = image();
  const sourceNowUnbound = image({
    productId: '',
    productCode: '',
    mainImageUrl: '',
    imageStatus: '待補主圖',
    bindingStatus: '未綁定銷售商品'
  });
  let writes = 0;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: 7,
                title: '商品圖片對照',
                gridProperties: { rowCount: 1000, columnCount: 15 }
              }
            }]
          }
        };
      },
      values: {
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [PRODUCT_IMAGE_HEADERS, imageRow(current)] },
                { values: [[MAIN_HEADERS[0]], ['SKU-A']] }
              ]
            }
          };
        },
        async batchUpdate() {
          writes += 1;
          return { data: {} };
        }
      }
    }
  };

  const result = await syncProductImages({
    sheets,
    spreadsheetId: 'sheet-123',
    imageItems: [sourceNowUnbound]
  });

  assert.equal(result.preservedBindings, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.updated, 0);
  assert.equal(writes, 0);
});
