import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_HEADERS,
  DASHBOARD_ROW_COUNT,
  DASHBOARD_SHEET_NAME,
  PREORDER_HEADERS,
  PREORDER_SHEET_NAME,
  SYNC_STATUS_HEADERS,
  SYNC_STATUS_SHEET_NAME,
  DASHBOARD_SYNC_OK,
  DASHBOARD_SYNC_FAILED,
  buildDashboardValues,
  dashboardRowValues,
  parsePreorderRows,
  readPreorderAllowances,
  writeInventoryDashboard
} from '../src/sheets/inventory-dashboard.js';
import { DASHBOARD_STATUS, buildInventoryDashboard } from '../src/services/inventory-dashboard.js';
import { initializeInventoryDashboard } from '../scripts/setup-inventory-dashboard.mjs';

function row(overrides = {}) {
  return {
    sku: 'SKU-A',
    displayName: '商品 A',
    flyingmouseStock: 7,
    processing: 3,
    preparing: 0,
    unshipped: 3,
    onOrder: 0,
    preorderAllowance: 10,
    safetyStock: 0,
    estimatedStock: 0,
    gap: 3,
    status: DASHBOARD_STATUS.REORDER,
    reorderable: true,
    preorderCloseShortfall: 3,
    note: '目前不能關閉預購，還差 3 個',
    updatedAt: '2026-10-29 14:00:00',
    ...overrides
  };
}

function sheetsFor({ dashboard = null, preorder = null, syncStatus = null } = {}) {
  const calls = { updates: [], clears: [], reads: [] };
  const rangeValues = (range) => {
    if (range.includes(DASHBOARD_SHEET_NAME)) return dashboard;
    if (range.includes(SYNC_STATUS_SHEET_NAME)) return syncStatus ?? [[...SYNC_STATUS_HEADERS]];
    if (range.includes(PREORDER_SHEET_NAME)) return preorder;
    throw new Error(`unexpected range: ${range}`);
  };
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          calls.reads.push(range);
          return { data: { values: rangeValues(range) } };
        },
        async batchGet({ ranges }) {
          calls.reads.push(...ranges);
          return { data: { valueRanges: ranges.map((range) => ({ values: rangeValues(range) })) } };
        },
        async update(request) {
          calls.updates.push({ range: request.range, values: request.requestBody.values });
          return { data: {} };
        },
        async batchUpdate(request) {
          calls.updates.push(...request.requestBody.data.map((entry) => ({
            range: entry.range,
            values: entry.values
          })));
          return { data: {} };
        },
        // clear 只留著當警報器：整張覆寫是一次寫入，不該再有人呼叫它。
        async clear(request) {
          calls.clears.push(request);
          return { data: {} };
        }
      }
    }
  };
  return { sheets, calls };
}

const OK_STATUS = Object.freeze({
  status: DASHBOARD_SYNC_OK,
  lastSuccessAt: '2026-10-29 14:00:00',
  lastAttemptAt: '2026-10-29 14:00:00',
  message: ''
});

function boardWrite(calls) {
  return calls.updates.find((entry) => entry.range.includes(DASHBOARD_SHEET_NAME));
}

test('preorder headers and dashboard headers match the spec', () => {
  assert.deepEqual([...PREORDER_HEADERS], ['SKU', '預購額度', '安全庫存', '備註', '最後修改人', '最後修改時間']);
  assert.deepEqual([...DASHBOARD_HEADERS], [
    'SKU', '商品名稱', '飛鼠庫存', '處理中', '備貨中', '賣掉還沒寄', '已叫貨未到',
    '預購額度', '安全庫存', '推算實際庫存', '缺口', '狀態', '備註', '更新時間'
  ]);
});

test('parsePreorderRows keeps raw numbers and records row numbers', () => {
  const rows = parsePreorderRows([
    [...PREORDER_HEADERS],
    ['SKU-A', 10, 2, '雙 11 預購', '老闆', '2026-10-01 09:00:00'],
    [],
    ['  SKU-B  ', '', '', '', '', ''],
    ['SKU-C', 5, '', '', '', '']
  ]);

  assert.deepEqual(rows.map((item) => [item.rowNumber, item.sku]), [[2, 'SKU-A'], [4, 'SKU-B'], [5, 'SKU-C']]);
  assert.equal(rows[0].preorderAllowance, 10);
  assert.equal(rows[0].safetyStock, 2);
  assert.equal(rows[0].note, '雙 11 預購');
  // 空白原樣傳下去，由 services 那層當成 0；這裡不先猜。
  assert.equal(rows[1].preorderAllowance, '');
  assert.equal(rows[2].safetyStock, '');
});

test('parsePreorderRows rejects a changed header, a blank SKU and duplicates', () => {
  assert.throws(() => parsePreorderRows([['SKU', '預購量', '安全庫存', '備註', '最後修改人', '最後修改時間']]),
    /預購額度 表頭不符/);
  assert.throws(() => parsePreorderRows([[...PREORDER_HEADERS], ['', 10, 0, '', '', '']]),
    /第 2 列缺少 SKU/);
  assert.throws(() => parsePreorderRows([
    [...PREORDER_HEADERS],
    ['SKU-A', 10, 0, '', '', ''],
    ['SKU-A', 4, 0, '', '', '']
  ]), /SKU SKU-A 在第 2、3 列重複/);
});

test('readPreorderAllowances reads the whole sheet, not a fixed row budget', async () => {
  // 人工把分頁加長、把額度填在上限外的那一列時，綁死列數會讓那筆無聲消失，
  // 計算層只會看到「沒填預購額度」，缺口就少算整個額度。
  const preorder = [[...PREORDER_HEADERS]];
  while (preorder.length < 2000) preorder.push([]);
  preorder.push(['SKU-FAR', 10, 0, '加在上限外', '', '']);
  const state = sheetsFor({ preorder });

  const rows = await readPreorderAllowances({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(state.calls.reads, ["'預購額度'!A:F"]);
  assert.deepEqual(rows.map((item) => [item.rowNumber, item.sku]), [[2001, 'SKU-FAR']]);
});

test('parsePreorderRows still catches a duplicate beyond the old row budget', () => {
  const values = [[...PREORDER_HEADERS], ['SKU-A', 10, 0, '', '', '']];
  while (values.length < 2000) values.push([]);
  values.push(['SKU-A', 4, 0, '', '', '']);

  assert.throws(() => parsePreorderRows(values), /SKU SKU-A 在第 2、2001 列重複/);
});

test('dashboardRowValues writes suppressed numbers as blank, never zero', () => {
  const published = dashboardRowValues(row(), '2026-10-29 14:00:00');
  assert.deepEqual(published, [
    'SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '目前不能關閉預購，還差 3 個', '2026-10-29 14:00:00'
  ]);

  // 回寫未完成時缺口是 null。寫 0 會讓看板看起來像「不缺貨」。
  const suppressed = dashboardRowValues(row({
    estimatedStock: null,
    gap: null,
    status: DASHBOARD_STATUS.WRITEBACK_PENDING,
    reorderable: false,
    preorderCloseShortfall: null,
    note: '到貨已登記，飛鼠庫存回寫尚未完成'
  }), '2026-10-29 14:00:00');
  assert.equal(suppressed[9], '');
  assert.equal(suppressed[10], '');
  assert.equal(suppressed[11], '回寫未完成');
});

test('buildDashboardValues puts the header first and refuses a missing timestamp', () => {
  const values = buildDashboardValues({ rows: [row()], updatedAt: '2026-10-29 14:00:00' });
  assert.deepEqual(values[0], [...DASHBOARD_HEADERS]);
  assert.equal(values.length, 2);

  assert.deepEqual(buildDashboardValues({ rows: [], updatedAt: '2026-10-29 14:00:00' }),
    [[...DASHBOARD_HEADERS]]);
  assert.throws(() => buildDashboardValues({ rows: [row()], updatedAt: '  ' }), /缺少更新時間/);
});

test('writeInventoryDashboard replaces a shrinking table in one request', async () => {
  const stale = (sku) => [sku, `舊商品 ${sku}`, 1, 0, 0, 0, 0, 0, 0, 1, 0, '正常', '', '2026-10-29 13:00:00'];
  const state = sheetsFor({
    dashboard: [[...DASHBOARD_HEADERS], stale('SKU-OLD-1'), stale('SKU-OLD-2'), stale('SKU-OLD-3')]
  });

  const result = await writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row()], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  });

  assert.deepEqual(result, {
    sheet: DASHBOARD_SHEET_NAME,
    rows: 1,
    clearedRows: 2,
    updatedAt: '2026-10-29 14:00:00',
    syncStatus: OK_STATUS
  });
  // 分成寫入與清除兩次請求的話，中間失敗會留下 C、B、C 這種新舊混合的看板。
  // 看板與同步狀態在同一次 batchUpdate 裡，所以是兩筆 range、一次請求。
  assert.deepEqual(state.calls.updates.map((entry) => entry.range),
    ["'庫存看板'!A1:N4", "'看板同步狀態'!A2:D2"]);
  assert.deepEqual(state.calls.clears, []);
  const sent = boardWrite(state.calls);
  assert.deepEqual(sent.values[0], [...DASHBOARD_HEADERS]);
  assert.equal(sent.values[1][0], 'SKU-A');
  // 多出來的兩列在同一次寫入裡被蓋成整列空白，不是留著舊值。
  assert.deepEqual(sent.values.slice(2), [
    DASHBOARD_HEADERS.map(() => ''),
    DASHBOARD_HEADERS.map(() => '')
  ]);
});

test('writeInventoryDashboard pads nothing when the table grew', async () => {
  const state = sheetsFor({ dashboard: [[...DASHBOARD_HEADERS]] });

  const result = await writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row(), row({ sku: 'SKU-B' })], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  });

  assert.equal(result.clearedRows, 0);
  assert.deepEqual(state.calls.clears, []);
  assert.equal(boardWrite(state.calls).values.length, 3);
  assert.equal(boardWrite(state.calls).range, "'庫存看板'!A1:N3");
});

test('writeInventoryDashboard empties every old row when nothing qualifies', async () => {
  const state = sheetsFor({
    dashboard: [[...DASHBOARD_HEADERS], ['SKU-OLD', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '正常', '', '']]
  });

  const result = await writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  });

  assert.equal(result.rows, 0);
  assert.deepEqual(boardWrite(state.calls).values, [
    [...DASHBOARD_HEADERS],
    DASHBOARD_HEADERS.map(() => '')
  ]);
  assert.deepEqual(state.calls.clears, []);
});

test('writeInventoryDashboard refuses a missing sheet or a changed header', async () => {
  const missing = sheetsFor({ dashboard: [] });
  await assert.rejects(writeInventoryDashboard({
    sheets: missing.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row()], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  }), /庫存看板 表頭不符/);
  assert.deepEqual(missing.calls.updates, []);

  const renamed = sheetsFor({ dashboard: [[...DASHBOARD_HEADERS.slice(0, 13), '最後更新']] });
  await assert.rejects(writeInventoryDashboard({
    sheets: renamed.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row()], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  }), /庫存看板 表頭不符/);
  assert.deepEqual(renamed.calls.updates, []);
});

test('writeInventoryDashboard also refuses when 看板同步狀態 is missing or renamed', async () => {
  const state = sheetsFor({
    dashboard: [[...DASHBOARD_HEADERS]],
    syncStatus: [['狀態', '最後成功', '最後嘗試時間', '訊息']]
  });

  await assert.rejects(writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row()], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  }), /看板同步狀態 表頭不符/);
  // 兩張分頁的表頭都要先驗過，不可以只驗一張就把看板寫下去。
  assert.deepEqual(state.calls.updates, []);
});

test('writeInventoryDashboard refuses to publish a failed status', async () => {
  const state = sheetsFor({ dashboard: [[...DASHBOARD_HEADERS]] });

  await assert.rejects(writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows: [row()], updatedAt: '2026-10-29 14:00:00' },
    syncStatus: { ...OK_STATUS, status: DASHBOARD_SYNC_FAILED }
  }), /只接受成功狀態/);
  assert.deepEqual(state.calls.updates, []);
});

test('writeInventoryDashboard refuses to exceed the sheet row budget', async () => {
  const state = sheetsFor({ dashboard: [[...DASHBOARD_HEADERS]] });
  const rows = Array.from({ length: DASHBOARD_ROW_COUNT }, (_, index) => row({ sku: `SKU-${index}` }));

  await assert.rejects(writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard: { rows, updatedAt: '2026-10-29 14:00:00' },
    syncStatus: OK_STATUS
  }), /超過上限 5000/);
  assert.deepEqual(state.calls.updates, []);
});

test('the sheet layer carries a real dashboard end to end', async () => {
  // 規格第 3 節商品 A 的「賣 3」那一列：飛鼠 7、未寄 3、叫貨中 0、推算實際 0、缺口 3。
  const dashboard = buildInventoryDashboard({
    catalog: [{ sku: 'SKU-A', displayName: '商品 A', stock: 7 }],
    orderQuantities: [{ partNo: 'SKU-A', processing: 3, preparing: 0 }],
    tracking: [],
    preorders: parsePreorderRows([
      [...PREORDER_HEADERS],
      ['SKU-A', 10, '', '雙 11 預購', '老闆', '2026-10-01 09:00:00']
    ]),
    updatedAt: '2026-10-29 14:00:00'
  });
  const state = sheetsFor({ dashboard: [[...DASHBOARD_HEADERS]] });

  await writeInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    dashboard,
    syncStatus: OK_STATUS
  });

  assert.deepEqual(boardWrite(state.calls).values[1], [
    'SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '目前不能關閉預購，還差 3 個', '2026-10-29 14:00:00'
  ]);
});

function metadataFor(titles) {
  return {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: titles.map((title, index) => ({
              properties: {
                sheetId: 900 + index,
                title,
                gridProperties: { rowCount: 10_000, columnCount: 26 }
              }
            }))
          }
        };
      }
    }
  };
}

test('initializeInventoryDashboard creates both sheets with frozen bold headers', async () => {
  let batch;
  const sheets = {
    spreadsheets: {
      ...metadataFor(['SKU主檔', '補貨追蹤']).spreadsheets,
      async batchUpdate(request) {
        batch = request;
        return { data: {} };
      },
      values: {
        async get() { throw new Error('不該讀不存在的分頁'); }
      }
    }
  };

  const result = await initializeInventoryDashboard({ sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(result, {
    created: [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME],
    checked: [],
    changes: 6
  });
  const added = batch.requestBody.requests.filter((entry) => entry.addSheet);
  assert.deepEqual(added.map((entry) => entry.addSheet.properties.title),
    [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME]);
  assert.equal(added[1].addSheet.properties.gridProperties.frozenRowCount, 1);
  assert.equal(added[1].addSheet.properties.gridProperties.columnCount, DASHBOARD_HEADERS.length);
  const headers = batch.requestBody.requests.filter((entry) => entry.updateCells);
  assert.deepEqual(headers[1].updateCells.rows[0].values.map((cell) => cell.userEnteredValue.stringValue),
    [...DASHBOARD_HEADERS]);
  // 同步狀態必須自成一張分頁：看板每輪整張覆寫，放在裡面會被蓋掉。
  assert.deepEqual(headers[2].updateCells.rows[0].values.map((cell) => cell.userEnteredValue.stringValue),
    [...SYNC_STATUS_HEADERS]);
  // SKU主檔 每次寫入前都會比對欄位名稱，初始化絕不可以碰它。
  assert.equal(JSON.stringify(batch).includes('SKU主檔'), false);
});

test('initializeInventoryDashboard is repeatable and verifies existing headers', async () => {
  const batches = [];
  const sheets = {
    spreadsheets: {
      ...metadataFor([PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME]).spreadsheets,
      async batchUpdate(request) {
        batches.push(request);
        return { data: {} };
      },
      values: {
        async get({ range }) {
          if (range.includes(PREORDER_SHEET_NAME)) return { data: { values: [[...PREORDER_HEADERS]] } };
          if (range.includes(SYNC_STATUS_SHEET_NAME)) return { data: { values: [[...SYNC_STATUS_HEADERS]] } };
          return { data: { values: [[...DASHBOARD_HEADERS]] } };
        }
      }
    }
  };

  const result = await initializeInventoryDashboard({ sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(result, {
    created: [],
    checked: [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME],
    changes: 0
  });
  assert.deepEqual(batches, []);
});

test('initializeInventoryDashboard stops when an existing header was changed', async () => {
  const sheets = {
    spreadsheets: {
      ...metadataFor([PREORDER_SHEET_NAME]).spreadsheets,
      async batchUpdate() { throw new Error('不該在表頭不符時寫入'); },
      values: {
        async get() {
          return { data: { values: [['SKU', '預購量', '安全庫存', '備註', '最後修改人', '最後修改時間']] } };
        }
      }
    }
  };

  await assert.rejects(initializeInventoryDashboard({ sheets, spreadsheetId: 'sheet-123' }),
    /預購額度 表頭不符/);
});
