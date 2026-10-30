import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_IMAGE_HEADERS,
  refreshTrackingDisplayNames,
  syncCatalogItems,
  syncInventorySnapshots,
  syncProductImages
} from '../src/flyingmouse/sheets-operational.js';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';
import { TRACKING_HEADERS } from '../src/sheets/order-spec-correction.js';

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

function catalogSheets({ rows, rowCount = 20, onWrite, onStructuralWrite }) {
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
      async batchUpdate(request) {
        onStructuralWrite?.(request);
        return { data: {} };
      },
      values: {
        async get({ range }) {
          assert.equal(range, `'SKU主檔'!A1:O${rowCount}`);
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
    mainOnly: 0,
    expandedRows: 0
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

test('catalog sync preserves source-missing rows and expands capacity for new SKUs', async () => {
  // 已遷移過的分頁會帶著 O 欄，這個案例要驗的是「來源沒變就不寫」。
  const rows = [
    ['SKU-A', '商品 A', '', '', 1, '', '', '商品 A', '一般SKU', '是', '', '件', '飛鼠', '', '未知'],
    ['SKU-B', '商品 B', '', '', 1, '', '', '商品 B', '一般SKU', '是', '', '件', '飛鼠', '', '未知']
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

  let write;
  const structuralWrites = [];
  const expanded = await syncCatalogItems({
    sheets: catalogSheets({
      rows: [rows[0]],
      rowCount: 2,
      onWrite: (request) => { write = request; },
      onStructuralWrite: (request) => { structuralWrites.push(request); }
    }),
    spreadsheetId: 'sheet-123',
    sourceItems: [
      catalogSource({ partNumber: 'SKU-A', productName: '商品 A', spec1: '', spec2: '', stock: 1, gtin: '', location: '' }),
      catalogSource({ partNumber: 'SKU-C', productName: '商品 C' })
    ]
  });
  assert.equal(expanded.inserted, 1);
  assert.equal(expanded.expandedRows, 100);
  assert.deepEqual(structuralWrites[0].requestBody.requests, [{
    appendDimension: { sheetId: 3, dimension: 'ROWS', length: 100 }
  }]);
  assert.deepEqual(write.requestBody.data.slice(-2), [
    {
      range: "'SKU主檔'!A3:J3",
      values: [[
        'SKU-C', '商品 C', '紅色', '大', 8, '0012345', 'A-01', '商品 C｜紅色｜大',
        '一般SKU', '是'
      ]]
    },
    { range: "'SKU主檔'!L3:M3", values: [['件', '飛鼠']] }
  ]);
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

test('catalog sync disables a new unbound whitespace alias when a bound twin exists', async () => {
  const unboundSku = 'C7FCA2-IVE 芙官方應援棒收納盒（無應援棒）';
  const boundSku = 'C7FCA2-IVE芙官方應援棒收納盒（無應援棒）';
  const spec = 'IVE手燈收納盒(無應援棒)*1';
  let write;

  await syncCatalogItems({
    sheets: catalogSheets({ rows: [], onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [
      catalogSource({
        partNumber: unboundSku,
        productName: 'HANNYA原創 IVE 二代應援棒底座',
        spec1: spec,
        spec2: '',
        stock: 0
      }),
      catalogSource({
        partNumber: boundSku,
        productName: 'IVE 二代應援棒底座',
        spec1: spec,
        spec2: '',
        stock: 20
      })
    ],
    imageItems: [
      image({
        partId: '1072',
        sku: unboundSku,
        productId: '',
        productCode: '',
        productName: 'HANNYA原創 IVE 二代應援棒底座',
        spec,
        sourceSpec: spec,
        sourceImageUrl: 'https://img.fslol.com/10371/a/example.jpg',
        mainImageUrl: '',
        bindingStatus: '未綁定銷售商品'
      }),
      image({
        partId: '1074',
        sku: boundSku,
        productId: '236',
        productCode: '1056740319141',
        productName: 'IVE 二代應援棒底座',
        spec: `${spec}(商品頁名稱)`,
        sourceSpec: spec,
        sourceImageUrl: 'https://img.fslol.com/10371/a/example.jpg',
        bindingStatus: '已綁定銷售商品'
      })
    ]
  });

  const insertedRows = write.requestBody.data
    .filter((entry) => entry.range.includes(':J'))
    .map((entry) => entry.values[0]);
  assert.equal(insertedRows.find((row) => row[0] === unboundSku)[9], '否');
  assert.equal(insertedRows.find((row) => row[0] === boundSku)[9], '是');
});

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

test('inventory sync writes a negative FlyingMouse stock and still stops on garbage', async () => {
  let write;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return {
            data: {
              values: [
                MAIN_HEADERS.slice(0, 5),
                ['SKU-A', '商品 A', '', '', 0]
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

  // 超賣的 −1 是真實庫存，寫 0 會讓看板的缺口少算 1。
  const result = await syncInventorySnapshots({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [source('SKU-A', -1)]
  });

  assert.equal(result.updated, 1);
  assert.deepEqual(write.requestBody.data, [{ range: "'SKU主檔'!E2", values: [[-1]] }]);

  await assert.rejects(syncInventorySnapshots({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [source('SKU-A', 1.5)]
  }), /不是安全整數/);
});

test('inventory sync leaves an already negative cell alone', async () => {
  let writes = 0;
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return {
            data: {
              values: [
                MAIN_HEADERS.slice(0, 5),
                ['SKU-A', '商品 A', '', '', -1]
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

  // 主檔現值若只認非負，−1 會被當成「讀不到」，於是每輪都重寫一次同樣的值。
  const result = await syncInventorySnapshots({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [source('SKU-A', -1)]
  });

  assert.equal(result.unchanged, 1);
  assert.equal(result.updated, 0);
  assert.equal(writes, 0);
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
                gridProperties: { rowCount: 4, columnCount: 16 }
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
  assert.equal(write.requestBody.data[0].range, "'商品圖片對照'!A4:P4");
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
                gridProperties: { rowCount: 2, columnCount: 16 }
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
    "'商品圖片對照'!A2:P2",
    "'商品圖片對照'!A3:P3"
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
                gridProperties: { rowCount: 1000, columnCount: 16 }
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

// 2026-10-30 查出來的實際狀況：飛鼠的貨品名稱是建檔當下的快照，
// 上架後把前綴改成「隔日到貨」不會同步回貨品層。整份目錄有 215 列因此
// 標著舊的「預購」，採購看了以為還在等上游，就會重複下單。
test('catalog sync writes the sales product name into 補貨顯示名稱', async () => {
  let write;
  await syncCatalogItems({
    sheets: catalogSheets({
      rows: [[
        'SKU-A', '預售✨ 收納盒', '紅色', '大', 8, '0012345', 'A-01', '預售✨ 收納盒｜紅色｜大',
        '一般SKU', '是', '', '件', '飛鼠', '', '預購'
      ]],
      onWrite: (request) => { write = request; }
    }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource({ productName: '預售✨ 收納盒' })],
    imageItems: [image({
      sku: 'SKU-A',
      productBindings: [{ productName: '隔日到貨⚡️ 收納盒' }]
    })]
  });

  const byRange = new Map(write.requestBody.data.map((entry) => [entry.range, entry.values[0]]));
  // B 欄必須還是官方 Excel 的貨品名稱，否則 sheets-baseline 的差異比對會整份爆掉。
  assert.equal(byRange.get("'SKU主檔'!B2:H2")[0], '預售✨ 收納盒');
  assert.equal(byRange.get("'SKU主檔'!B2:H2")[6], '隔日到貨⚡️ 收納盒｜紅色｜大');
  assert.deepEqual(byRange.get("'SKU主檔'!O2"), ['現貨']);
});

// 未綁定銷售商品的貨品，只有貨品列表那一行的字串，沒有銷售商品記錄可對照。
// 名稱可以沿用，型態不行——貨品層的前綴正是整件事不可信的來源。
test('catalog sync marks an unbound part as 未知 instead of reading its prefix', async () => {
  let write;
  await syncCatalogItems({
    sheets: catalogSheets({ rows: [], onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [
      catalogSource({ partNumber: 'SKU-A', productName: '預售✨ 收納盒' }),
      catalogSource({ partNumber: 'SKU-Z', productName: '預售✨ 沒綁定的貨品' })
    ],
    imageItems: [
      image({ sku: 'SKU-A', productBindings: [{ productName: '隔日到貨⚡️ 收納盒' }] }),
      // mergeProductDetails 對未綁定的貨品原樣回傳，沒有 productBindings。
      image({ partId: '2', sku: 'SKU-Z', productId: '', productName: '預售✨ 沒綁定的貨品' })
    ]
  });

  const byRange = new Map(write.requestBody.data.map((entry) => [entry.range, entry.values[0]]));
  const unbound = [...byRange].find(([range]) => range.endsWith(':J3'))[1];
  assert.equal(unbound[0], 'SKU-Z');
  assert.equal(unbound[7], '預售✨ 沒綁定的貨品｜紅色｜大');
  assert.deepEqual(byRange.get("'SKU主檔'!O3"), ['未知']);
});

// 整輪都沒有銷售商品資料（--input 走既有 Excel、不開瀏覽器）時，H 可以回退到
// 貨品名稱，但 O 欄一個字都不能碰：那不是「都不知道」，是「這輪沒查」，
// 照寫下去會把上一輪正確的值全部洗成「未知」。
test('catalog sync leaves 出貨型態 untouched when no product list was captured', async () => {
  let write;
  await syncCatalogItems({
    sheets: catalogSheets({
      rows: [[
        'SKU-A', '舊名', '紅色', '大', 1, '', '', '舊顯示名', '一般SKU', '是',
        '', '件', '飛鼠', '', '現貨'
      ]],
      onWrite: (request) => { write = request; }
    }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource({ productName: '預售✨ 收納盒' })],
    imageItems: []
  });

  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), ["'SKU主檔'!B2:H2"]);
  assert.equal(write.requestBody.data[0].values[0][6], '預售✨ 收納盒｜紅色｜大');
});

// 一個貨號綁多個銷售商品時，兩邊前綴不一樣就無從判斷。名稱還是取第一個綁定
// （那就是採購會看到的標題），但型態必須是「未知」——猜錯任何一邊都會讓缺口算錯。
//
// 貨品名稱刻意帶「預售」前綴：若實作是退回貨品名稱再重新分類，這裡會寫出
// 「預購」而不是「未知」，等於把不知道偷換成一個猜測。
test('catalog sync refuses to guess the mode when bound products disagree', async () => {
  let write;
  await syncCatalogItems({
    sheets: catalogSheets({ rows: [], onWrite: (request) => { write = request; } }),
    spreadsheetId: 'sheet-123',
    sourceItems: [catalogSource({ productName: '預售✨ 收納盒' })],
    imageItems: [image({
      sku: 'SKU-A',
      productName: '隔日到貨⚡️ 收納盒',
      productBindings: [
        { productName: '隔日到貨⚡️ 收納盒' },
        { productName: '預購 收納盒' }
      ]
    })]
  });

  const inserted = write.requestBody.data
    .find((entry) => entry.range === "'SKU主檔'!A2:J2").values[0];
  assert.equal(inserted[7], '隔日到貨⚡️ 收納盒｜紅色｜大');
  assert.deepEqual(
    write.requestBody.data.find((entry) => entry.range === "'SKU主檔'!O2").values[0],
    ['未知']
  );
});

function trackingRow({ requestId, item, status, sku, stockMode = '' }) {
  const row = new Array(TRACKING_HEADERS.length).fill('');
  row[0] = requestId;
  row[3] = item;
  row[6] = status;
  row[13] = sku;
  row[22] = stockMode;
  return row;
}

// freshTracking 讓測試模擬「讀完之後、寫入之前有人動了那一列」。
function trackingSheets({ catalog, tracking, freshTracking, onWrite }) {
  const calls = { rereads: 0 };
  return {
    calls,
    spreadsheets: {
      values: {
        async batchGet({ ranges }) {
          assert.deepEqual(ranges, ["'SKU主檔'!A1:O", "'補貨追蹤'!A1:W"]);
          return {
            data: {
              valueRanges: [
                { values: [[...MAIN_HEADERS], ...catalog] },
                { values: [[...TRACKING_HEADERS], ...tracking] }
              ]
            }
          };
        },
        async get({ range }) {
          assert.equal(range, "'補貨追蹤'!A1:W");
          calls.rereads += 1;
          return { data: { values: [[...TRACKING_HEADERS], ...(freshTracking ?? tracking)] } };
        },
        async batchUpdate(request) {
          onWrite?.(request);
          return { data: {} };
        }
      }
    }
  };
}

// 補貨追蹤的「品項」是建單當下複製的快照。這正是會害採購重複下單的地方：
// 單上寫「預購」，實際上貨早就到了、改成現貨在賣了。
test('tracking refresh updates in-flight rows and leaves closed rows alone', async () => {
  let write;
  const result = await refreshTrackingDisplayNames({
    sheets: trackingSheets({
      catalog: [[
        'SKU-A', '預售✨ 收納盒', '', '', 3, '', '', '隔日到貨⚡️ 收納盒', '一般SKU', '是',
        '', '件', '飛鼠', '', '現貨'
      ]],
      tracking: [
        trackingRow({ requestId: 'RQ-1', item: '預售✨ 收納盒', status: '已下單', sku: 'SKU-A' }),
        trackingRow({ requestId: 'RQ-2', item: '預售✨ 收納盒', status: '已到貨', sku: 'SKU-A' })
      ],
      onWrite: (request) => { write = request; }
    }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(result, { refreshed: 1, unchanged: 0, skipped: 0, dryRun: false });
  assert.deepEqual(write.requestBody.data, [
    { range: "'補貨追蹤'!D2", values: [['隔日到貨⚡️ 收納盒']] },
    { range: "'補貨追蹤'!W2", values: [['現貨']] }
  ]);
});

test('tracking refresh writes nothing when the in-flight row already matches', async () => {
  let writes = 0;
  const result = await refreshTrackingDisplayNames({
    sheets: trackingSheets({
      catalog: [[
        'SKU-A', '貨品名', '', '', 3, '', '', '隔日到貨⚡️ 收納盒', '一般SKU', '是',
        '', '件', '飛鼠', '', '現貨'
      ]],
      tracking: [trackingRow({
        requestId: 'RQ-1', item: '隔日到貨⚡️ 收納盒', status: '待確認', sku: 'SKU-A', stockMode: '現貨'
      })],
      onWrite: () => { writes += 1; }
    }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(result, { refreshed: 0, unchanged: 1, skipped: 0, dryRun: false });
  assert.equal(writes, 0);
});

// 停用或改過編號的舊單在 SKU主檔 查不到，不該讓整輪同步失敗。
test('tracking refresh skips rows whose SKU is gone from the catalog', async () => {
  const result = await refreshTrackingDisplayNames({
    sheets: trackingSheets({
      catalog: [],
      tracking: [trackingRow({ requestId: 'RQ-1', item: '舊名稱', status: '部分到貨', sku: 'SKU-X' })]
    }),
    spreadsheetId: 'sheet-123'
  });

  assert.deepEqual(result, { refreshed: 0, unchanged: 0, skipped: 1, dryRun: false });
});

// Codex SNS-004 指出的交錯：刷新讀到 SKU-A／已下單之後，使用者登記到貨並帶規格修正，
// repository 會改寫同一列的 D、N 並把狀態推進成已完成。若刷新仍照舊讀寫回去，
// 會變成 N 是新 SKU、D 是舊名稱，而且該列已結案、往後不再刷新，錯誤永久留著。
test('tracking refresh drops a row that left the flow between the two reads', async () => {
  let writes = 0;
  const state = trackingSheets({
    catalog: [
      ['SKU-A', '甲貨品', '', '', 1, '', '', '隔日到貨⚡️ 甲', '一般SKU', '是', '', '件', '飛鼠', '', '現貨'],
      ['SKU-B', '乙貨品', '', '', 1, '', '', '預購 乙', '一般SKU', '是', '', '件', '飛鼠', '', '預購']
    ],
    tracking: [trackingRow({ requestId: 'RQ-1', item: '預售✨ 甲', status: '已下單', sku: 'SKU-A' })],
    freshTracking: [trackingRow({
      requestId: 'RQ-1', item: '預購 乙', status: '已完成', sku: 'SKU-B', stockMode: '預購'
    })],
    onWrite: () => { writes += 1; }
  });

  const result = await refreshTrackingDisplayNames({ sheets: state, spreadsheetId: 'sheet-123' });

  assert.equal(state.calls.rereads, 1);
  assert.equal(writes, 0);
  assert.deepEqual(result, { refreshed: 0, unchanged: 0, skipped: 0, dryRun: false });
});

test('tracking refresh uses the SKU the row holds at write time', async () => {
  let write;
  const state = trackingSheets({
    catalog: [
      ['SKU-A', '甲貨品', '', '', 1, '', '', '隔日到貨⚡️ 甲', '一般SKU', '是', '', '件', '飛鼠', '', '現貨'],
      ['SKU-B', '乙貨品', '', '', 1, '', '', '預購 乙', '一般SKU', '是', '', '件', '飛鼠', '', '預購']
    ],
    tracking: [trackingRow({ requestId: 'RQ-1', item: '預售✨ 甲', status: '已下單', sku: 'SKU-A' })],
    // 規格修正把這一列換成了 SKU-B，但單還在流程中。
    freshTracking: [trackingRow({ requestId: 'RQ-1', item: '預售✨ 甲', status: '部分到貨', sku: 'SKU-B' })],
    onWrite: (request) => { write = request; }
  });

  await refreshTrackingDisplayNames({ sheets: state, spreadsheetId: 'sheet-123' });

  assert.deepEqual(write.requestBody.data, [
    { range: "'補貨追蹤'!D2", values: [['預購 乙']] },
    { range: "'補貨追蹤'!W2", values: [['預購']] }
  ]);
});

test('tracking refresh never re-reads or writes when nothing needs changing', async () => {
  let writes = 0;
  const state = trackingSheets({
    catalog: [[
      'SKU-A', '甲貨品', '', '', 1, '', '', '隔日到貨⚡️ 甲', '一般SKU', '是', '', '件', '飛鼠', '', '現貨'
    ]],
    tracking: [trackingRow({
      requestId: 'RQ-1', item: '隔日到貨⚡️ 甲', status: '已下單', sku: 'SKU-A', stockMode: '現貨'
    })],
    onWrite: () => { writes += 1; }
  });

  const result = await refreshTrackingDisplayNames({ sheets: state, spreadsheetId: 'sheet-123' });

  assert.equal(state.calls.rereads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(result, { refreshed: 0, unchanged: 1, skipped: 0, dryRun: false });
});
