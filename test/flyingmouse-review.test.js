import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_HEADERS,
  REVIEW_SHEET_NAME,
  buildReviewFindings,
  ensureReviewSheet,
  importApprovedNewItems,
  sourceFingerprint,
  syncReviewFindings
} from '../src/flyingmouse/sheets-review.js';

const MAIN_HEADERS = [
  'SKU', '商品名稱', '蝦皮規格1（原始）', '蝦皮規格2（原始）', '庫存快照', 'GTIN', '儲位',
  '補貨顯示名稱', '品項類型', '是否可補貨', '搜尋關鍵字', '單位', '主要供應商', '資料更新日'
];

function emptyDiff(overrides = {}) {
  return {
    newItems: [],
    changedItems: [],
    unchangedItems: [],
    sourceMissingItems: [],
    conflicts: [],
    ...overrides
  };
}

function source(partNumber, overrides = {}) {
  return {
    rowNumber: 2,
    partNumber,
    productName: `商品 ${partNumber}`,
    spec1: '紅色',
    spec2: '',
    stock: 7,
    gtin: '00123',
    location: 'A-01',
    ...overrides
  };
}

function reviewRow(item, reviewStatus = '待確認', fingerprint = item.fingerprint) {
  return [
    item.key, '待處理', item.type, reviewStatus, item.partNumber,
    item.source?.productName ?? '', item.source?.spec1 ?? '', item.source?.spec2 ?? '',
    item.source?.stock ?? '', item.source?.gtin ?? '', item.source?.location ?? '',
    item.reference?.productName ?? '', item.reference?.spec1 ?? '', item.reference?.spec2 ?? '',
    fingerprint, '2026-07-15 10:00:00', '2026-07-15 10:00:00', '', ''
  ];
}

test('review findings keep source inventory fields and stable fingerprints', () => {
  const item = source('SKU-A');
  const first = buildReviewFindings(emptyDiff({ newItems: [item] }))[0];
  const second = buildReviewFindings(emptyDiff({ newItems: [{ ...item }] }))[0];
  const stockChanged = buildReviewFindings(emptyDiff({ newItems: [{ ...item, stock: 8 }] }))[0];
  const identityChanged = buildReviewFindings(emptyDiff({ newItems: [{ ...item, gtin: '00999' }] }))[0];

  assert.equal(first.key, '新增:SKU-A');
  assert.equal(first.source.gtin, '00123');
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, stockChanged.fingerprint);
  assert.notEqual(first.fingerprint, identityChanged.fingerprint);
  assert.match(sourceFingerprint(item), /^[a-f0-9]{64}$/);
});

test('ensureReviewSheet creates a native-style table with filters and validations', async () => {
  const structuralWrites = [];
  let headerWrite;
  const sheets = {
    spreadsheets: {
      async get() {
        return { data: { sheets: [{ properties: { sheetId: 1, title: 'SKU主檔', gridProperties: { rowCount: 1000, columnCount: 14 } } }] } };
      },
      async batchUpdate(request) {
        structuralWrites.push(request);
        if (request.requestBody.requests[0].addSheet) {
          return {
            data: {
              replies: [{ addSheet: { properties: { sheetId: 2, title: REVIEW_SHEET_NAME, gridProperties: { rowCount: 5000, columnCount: 19 } } } }]
            }
          };
        }
        return { data: {} };
      },
      values: {
        async update(request) {
          headerWrite = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await ensureReviewSheet({ sheets, spreadsheetId: 'sheet-123' });

  assert.equal(result.created, true);
  assert.equal(headerWrite.range, `'${REVIEW_SHEET_NAME}'!A1:S1`);
  assert.deepEqual(headerWrite.requestBody.values[0], REVIEW_HEADERS);
  const formatting = structuralWrites[1].requestBody.requests;
  assert.equal(formatting.some((request) => request.setBasicFilter), true);
  assert.equal(formatting.filter((request) => request.setDataValidation).length, 2);
  assert.equal(formatting.some((request) => request.repeatCell), true);
});

test('syncReviewFindings preserves notes, invalidates stale approval, and resolves old findings', async () => {
  const currentSource = source('SKU-A', { productName: '新版商品 A' });
  const currentFinding = buildReviewFindings(emptyDiff({ newItems: [currentSource] }))[0];
  const currentRow = reviewRow(currentFinding, '核准匯入', 'old-fingerprint');
  currentRow[5] = '舊版商品 A';
  currentRow[15] = '2026-07-14 09:00:00';
  currentRow[17] = '保留這段人工備註';
  const oldFinding = buildReviewFindings(emptyDiff({ newItems: [source('OLD')] }))[0];
  const oldRow = reviewRow(oldFinding);
  let write;
  const sheets = {
    spreadsheets: {
      async get() {
        return { data: { sheets: [{ properties: { sheetId: 2, title: REVIEW_SHEET_NAME, gridProperties: { rowCount: 5000, columnCount: 19 } } }] } };
      },
      values: {
        async get({ range }) {
          if (range.endsWith('A1:S1')) return { data: { values: [[...REVIEW_HEADERS]] } };
          return { data: { values: [currentRow, oldRow] } };
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };

  const result = await syncReviewFindings({
    sheets,
    spreadsheetId: 'sheet-123',
    diff: emptyDiff({ newItems: [currentSource] }),
    generatedAt: new Date('2026-07-15T04:34:56.000Z')
  });

  assert.deepEqual(result, {
    created: false, findings: 1, inserted: 0, updated: 1, resolved: 1, staleApprovals: 1
  });
  const data = write.requestBody.data;
  assert.deepEqual(data.find((entry) => entry.range.endsWith('D2')).values, [['需重新確認']]);
  assert.deepEqual(data.find((entry) => entry.range.endsWith('B3')).values, [['已解除']]);
  assert.deepEqual(data.find((entry) => entry.range.endsWith('S3')).values, [['2026-07-15 12:34:56']]);
  const sourceUpdate = data.find((entry) => entry.range.endsWith('E2:Q2'));
  assert.equal(sourceUpdate.values[0][11], '2026-07-14 09:00:00');
  assert.equal(data.some((entry) => entry.range.includes('R2')), false);
});

test('importApprovedNewItems writes only safe main columns and resets a stale approval', async () => {
  const validSource = source('SKU-A');
  const staleSource = source('SKU-B');
  const validFinding = buildReviewFindings(emptyDiff({ newItems: [{ ...validSource, stock: 3 }] }))[0];
  const staleFinding = buildReviewFindings(emptyDiff({ newItems: [staleSource] }))[0];
  let write;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [
              { properties: { sheetId: 2, title: REVIEW_SHEET_NAME, gridProperties: { rowCount: 5000, columnCount: 19 } } },
              { properties: { sheetId: 3, title: 'SKU主檔', gridProperties: { rowCount: 1000, columnCount: 14 } } }
            ]
          }
        };
      },
      values: {
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [[...REVIEW_HEADERS], reviewRow(validFinding, '核准匯入'), reviewRow(staleFinding, '核准匯入', 'stale')] },
                { values: [[...MAIN_HEADERS]] }
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

  const result = await importApprovedNewItems({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [validSource, staleSource],
    generatedAt: new Date('2026-07-15T04:34:56.000Z')
  });

  assert.deepEqual(result, { approved: 2, imported: 1, idempotent: 0, stale: 1 });
  const data = write.requestBody.data;
  assert.deepEqual(data.map((entry) => entry.range), [
    "'SKU主檔'!A2:J2",
    "'SKU主檔'!L2:M2",
    `'${REVIEW_SHEET_NAME}'!D2`,
    `'${REVIEW_SHEET_NAME}'!S2`,
    `'${REVIEW_SHEET_NAME}'!D3`,
    `'${REVIEW_SHEET_NAME}'!S3`
  ]);
  assert.deepEqual(data[0].values[0], [
    'SKU-A', '商品 SKU-A', '紅色', '', 7, '00123', 'A-01', '商品 SKU-A｜紅色', '一般SKU', '是'
  ]);
  assert.equal(data.some((entry) => /![KN]\d/.test(entry.range)), false);
  assert.deepEqual(data[4].values, [['需重新確認']]);
});

test('importApprovedNewItems treats an identical existing SKU as idempotent', async () => {
  const existingSource = source('SKU-A');
  const finding = buildReviewFindings(emptyDiff({ newItems: [existingSource] }))[0];
  let write;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [
              { properties: { title: REVIEW_SHEET_NAME, gridProperties: { rowCount: 5000, columnCount: 19 } } },
              { properties: { title: 'SKU主檔', gridProperties: { rowCount: 1000, columnCount: 14 } } }
            ]
          }
        };
      },
      values: {
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [[...REVIEW_HEADERS], reviewRow(finding, '核准匯入')] },
                { values: [[...MAIN_HEADERS], ['SKU-A', '商品 SKU-A', '紅色', '', 3, '00123', 'A-01']] }
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

  const result = await importApprovedNewItems({
    sheets,
    spreadsheetId: 'sheet-123',
    sourceItems: [existingSource],
    generatedAt: new Date('2026-07-15T04:34:56.000Z')
  });

  assert.deepEqual(result, { approved: 1, imported: 0, idempotent: 1, stale: 0 });
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    `'${REVIEW_SHEET_NAME}'!D2`,
    `'${REVIEW_SHEET_NAME}'!S2`
  ]);
  assert.deepEqual(write.requestBody.data[0].values, [['已匯入']]);
});
