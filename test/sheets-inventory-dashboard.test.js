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
  MOVEMENT_HEADERS,
  MOVEMENT_SHEET_NAME,
  DASHBOARD_SYNC_OK,
  DASHBOARD_SYNC_FAILED,
  buildDashboardValues,
  dashboardRowValues,
  parsePreorderRows,
  parseDashboardRows,
  parseMovementRows,
  readMovementSkus,
  writeMovementSkus,
  createDashboardReader,
  readInventoryDashboard,
  readPreorderAllowances,
  writeInventoryDashboard
} from '../src/sheets/inventory-dashboard.js';
import { DASHBOARD_STATUS, buildInventoryDashboard } from '../src/services/inventory-dashboard.js';
import { readFile } from 'node:fs/promises';
import { formatShortageReply } from '../src/services/group-commands.js';
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

function sheetsFor({
  dashboard = null,
  preorder = null,
  syncStatus = null,
  movement = [[...MOVEMENT_HEADERS]]
} = {}) {
  const calls = { updates: [], clears: [], reads: [] };
  const rangeValues = (range) => {
    if (range.includes(MOVEMENT_SHEET_NAME)) return movement;
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
    created: [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME, MOVEMENT_SHEET_NAME],
    checked: [],
    changes: 8
  });
  const added = batch.requestBody.requests.filter((entry) => entry.addSheet);
  assert.deepEqual(added.map((entry) => entry.addSheet.properties.title),
    [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME, MOVEMENT_SHEET_NAME]);
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
      ...metadataFor([PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME, MOVEMENT_SHEET_NAME]).spreadsheets,
      async batchUpdate(request) {
        batches.push(request);
        return { data: {} };
      },
      values: {
        async get({ range }) {
          if (range.includes(PREORDER_SHEET_NAME)) return { data: { values: [[...PREORDER_HEADERS]] } };
          if (range.includes(SYNC_STATUS_SHEET_NAME)) return { data: { values: [[...SYNC_STATUS_HEADERS]] } };
          if (range.includes(MOVEMENT_SHEET_NAME)) return { data: { values: [[...MOVEMENT_HEADERS]] } };
          return { data: { values: [[...DASHBOARD_HEADERS]] } };
        }
      }
    }
  };

  const result = await initializeInventoryDashboard({ sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(result, {
    created: [],
    checked: [PREORDER_SHEET_NAME, DASHBOARD_SHEET_NAME, SYNC_STATUS_SHEET_NAME, MOVEMENT_SHEET_NAME],
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

test('parseDashboardRows reads the board back and skips the blanked tail', () => {
  const rows = parseDashboardRows([
    [...DASHBOARD_HEADERS],
    ['SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '備註', '2026-10-29 14:00:00'],
    // 回寫未完成那一列的推算實際與缺口是空白，讀回來要是 null 不是 0。
    ['SKU-B', '商品 B', 0, 0, 0, 0, 0, 0, 0, '', '', '回寫未完成', '回寫尚未完成', '2026-10-29 14:00:00'],
    DASHBOARD_HEADERS.map(() => '')
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].gap, 3);
  assert.equal(rows[1].estimatedStock, null);
  assert.equal(rows[1].gap, null);
  assert.equal(rows[1].status, '回寫未完成');
});

test('parseDashboardRows refuses a changed header', () => {
  assert.throws(() => parseDashboardRows([[...DASHBOARD_HEADERS.slice(0, 13), '最後更新']]),
    /庫存看板 表頭不符/);
});

test('readInventoryDashboard returns the rows and the sync status together', async () => {
  const state = sheetsFor({
    dashboard: [
      [...DASHBOARD_HEADERS],
      ['SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '', '2026-10-29 14:00:00']
    ],
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_FAILED, '2026-10-29 13:00:00', '2026-10-29 14:00:00', '飛鼠登入逾時']]
  });

  const result = await readInventoryDashboard({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(result.rows.map((row) => row.sku), ['SKU-A']);
  assert.equal(result.syncStatus.status, DASHBOARD_SYNC_FAILED);
  assert.equal(result.syncStatus.lastSuccessAt, '2026-10-29 13:00:00');
  // 讀取不可以寫任何東西。
  assert.deepEqual(state.calls.updates, []);
});

test('createDashboardReader honours the feature flag', async () => {
  assert.equal(createDashboardReader({ sheets: {}, spreadsheetId: 'x', enabled: false }), null);
  assert.throws(() => createDashboardReader({ sheets: null, spreadsheetId: 'x', enabled: true }),
    /設定不完整/);

  const state = sheetsFor({
    dashboard: [
      [...DASHBOARD_HEADERS],
      ['SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '', '2026-10-29 14:00:00']
    ]
  });
  const reader = createDashboardReader({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    enabled: true
  });
  assert.equal(typeof reader, 'function');
  assert.deepEqual((await reader()).rows.map((row) => row.sku), ['SKU-A']);
});

test('the production entry point actually wires the dashboard reader', async () => {
  // 整合測試都自己注入假的 reader，所以「正式入口忘了接」不會讓任何測試變紅——
  // 實際上線後兩個指令就一律回「尚未啟用」。這條直接看接線。
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /createDashboardReader/);
  assert.match(source, /enabled: config\.inventoryDashboardEnabled/);
  // createApp 的呼叫裡要真的帶上 dashboardReader 與 sheets（排程端點要用）。
  const call = source.slice(source.indexOf('createApp({'));
  assert.match(call, /\bdashboardReader\b/);

});

test('an anomaly survives calc → board → read back → reply, with its reason', async () => {
  // 預購額度填了一個 SKU主檔 沒有的貨號：上游標「異常」但缺口照樣是正的。
  // 這條走完整條鏈——真的計算、真的序列化成看板列、真的讀回來、真的組回覆。
  const dashboard = buildInventoryDashboard({
    catalog: [{ sku: 'SKU-A', displayName: '商品 A', stock: 7 }],
    orderQuantities: [{ partNo: 'SKU-A', processing: 3, preparing: 0 }],
    tracking: [],
    preorders: [
      { sku: 'SKU-A', preorderAllowance: 10, safetyStock: 0 },
      { sku: 'SKU-GHOST', preorderAllowance: 10, safetyStock: 0 }
    ],
    updatedAt: '2026-10-29 14:00:00'
  });
  const values = buildDashboardValues(dashboard);
  const readBack = parseDashboardRows(values);
  const reply = formatShortageReply({
    rows: readBack,
    syncStatus: { status: DASHBOARD_SYNC_OK, lastSuccessAt: '2026-10-29 14:00:00' }
  });

  assert.equal(readBack.find((row) => row.sku === 'SKU-GHOST').status, DASHBOARD_STATUS.ANOMALY);
  assert.match(reply, /要叫貨 1 個/);
  assert.match(reply, /SKU SKU-A/);
  // 異常列不可以混在「要叫貨」裡——缺口是正的，直接拿去下單就錯了。
  assert.match(reply, /異常 1 個/);
  assert.match(reply, /SKU SKU-GHOST/);
  assert.match(reply, /不在 SKU主檔/);
  assert.equal(reply.indexOf('SKU SKU-A') < reply.indexOf('異常'), true, '要叫貨要排在異常前面');
});

test('the movement list round-trips and overwrites the previous one', async () => {
  const state = sheetsFor({
    movement: [
      [...MOVEMENT_HEADERS],
      ['SKU-OLD-1', '2026-09-01 00:00:00', '2026-10-28 09:00:00'],
      ['SKU-OLD-2', '2026-09-01 00:00:00', '2026-10-28 09:00:00'],
      ['SKU-OLD-3', '2026-09-01 00:00:00', '2026-10-28 09:00:00']
    ]
  });

  const result = await writeMovementSkus({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    skus: new Set(['SKU-B', 'SKU-A', 'SKU-A']),
    since: '2026-09-29 00:00:00',
    updatedAt: '2026-10-29 10:00:00'
  });

  // 舊的 3 列換成 2 列，多出來的 1 列要被蓋成空白（表頭 + 2 + 1 = 4 列）。
  assert.deepEqual(result, { skus: 2, clearedRows: 1, since: '2026-09-29 00:00:00' });
  const sent = state.calls.updates[0];
  assert.equal(sent.range, "'動銷清單'!A1:C4");
  assert.deepEqual(sent.values[1], ['SKU-A', '2026-09-29 00:00:00', '2026-10-29 10:00:00']);
  assert.deepEqual(sent.values[2], ['SKU-B', '2026-09-29 00:00:00', '2026-10-29 10:00:00']);
  assert.deepEqual(sent.values.slice(3), [['', '', '']]);
});

test('writeMovementSkus refuses a missing window or a changed header', async () => {
  const state = sheetsFor();
  await assert.rejects(writeMovementSkus({
    sheets: state.sheets, spreadsheetId: 'sheet-123', skus: new Set(['A']), since: '', updatedAt: 'x'
  }), /缺少起算日或更新時間/);

  const renamed = sheetsFor({ movement: [['SKU', '起算', '更新時間']] });
  await assert.rejects(writeMovementSkus({
    sheets: renamed.sheets,
    spreadsheetId: 'sheet-123',
    skus: new Set(['A']),
    since: '2026-09-29 00:00:00',
    updatedAt: '2026-10-29 10:00:00'
  }), /動銷清單 表頭不符/);
  assert.deepEqual(renamed.calls.updates, []);
});

test('parseMovementRows skips the blanked tail and reports the window', () => {
  const parsed = parseMovementRows([
    [...MOVEMENT_HEADERS],
    ['SKU-A', '2026-09-29 00:00:00', '2026-10-29 10:00:00'],
    ['SKU-B', '2026-09-29 00:00:00', '2026-10-29 10:00:00'],
    ['', '', '']
  ]);
  assert.deepEqual([...parsed.skus], ['SKU-A', 'SKU-B']);
  assert.equal(parsed.since, '2026-09-29 00:00:00');
  assert.equal(parsed.initialized, true);
  // 只有表頭＝建好了但還沒寫過，不是「這 30 天沒人買任何東西」。
  assert.equal(parseMovementRows([[...MOVEMENT_HEADERS]]).initialized, false);
  // 但「查過了、結果是空的」要分得出來，否則會退回列出全部缺貨。
  const emptyButQueried = parseMovementRows([
    [...MOVEMENT_HEADERS],
    ['', '2026-09-29 00:00:00', '2026-10-29 10:00:00']
  ]);
  assert.equal(emptyButQueried.initialized, true);
  assert.equal(emptyButQueried.skus.size, 0);
  assert.equal(emptyButQueried.updatedAt, '2026-10-29 10:00:00');
  // 有內容卻既沒有 SKU 也沒有更新時間：那不是完成標記，是壞掉的列。
  assert.throws(() => parseMovementRows([[...MOVEMENT_HEADERS], ['', '2026-09-29', '']]),
    /第 2 列缺少 SKU/);
});

test('readInventoryDashboard tolerates a missing movement sheet', async () => {
  const state = sheetsFor({
    dashboard: [
      [...DASHBOARD_HEADERS],
      ['SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '', '2026-10-29 14:00:00']
    ],
    movement: [['壞掉的表頭']]
  });

  const result = await readInventoryDashboard({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  // 動銷清單只是篩子，壞了不該讓人連缺貨都查不到。
  assert.equal(result.movement, null);
  assert.deepEqual(result.rows.map((row) => row.sku), ['SKU-A']);
});

test('readInventoryDashboard still answers when the movement sheet does not exist', async () => {
  const state = sheetsFor({
    dashboard: [
      [...DASHBOARD_HEADERS],
      ['SKU-A', '商品 A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨', '', '2026-10-29 14:00:00']
    ]
  });
  // Google 對不存在的分頁會讓整個請求失敗，所以動銷清單不可以跟看板同一次 batchGet。
  const original = state.sheets.spreadsheets.values.get;
  state.sheets.spreadsheets.values.get = async (request) => {
    if (String(request.range).includes(MOVEMENT_SHEET_NAME)) {
      throw new Error("Unable to parse range: '動銷清單'!A:C");
    }
    return original(request);
  };

  const result = await readInventoryDashboard({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.equal(result.movement, null);
  assert.deepEqual(result.rows.map((row) => row.sku), ['SKU-A']);
});

test('readMovementSkus reads the whole column, not a fixed budget', async () => {
  const state = sheetsFor({
    movement: [[...MOVEMENT_HEADERS], ['SKU-A', '2026-09-29 00:00:00', '2026-10-29 10:00:00']]
  });

  const result = await readMovementSkus({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(state.calls.reads.filter((range) => range.includes('動銷清單')), ["'動銷清單'!A:C"]);
  assert.deepEqual([...result.skus], ['SKU-A']);
});

test('a non-empty movement list that becomes empty still filters, end to end', async () => {
  // 近 30 天沒有任何有效訂單是合法結果（例如只剩更早的未寄預購單）。
  // 「查過且為空」若被當成「還沒查過」，就會退回列出全部缺貨。
  const state = sheetsFor({
    movement: [
      [...MOVEMENT_HEADERS],
      ['SKU-A', '2026-09-28 00:00:00', '2026-10-28 14:00:00']
    ]
  });

  const written = await writeMovementSkus({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    skus: new Set(),
    since: '2026-09-29 00:00:00',
    updatedAt: '2026-10-29 14:00:00'
  });
  assert.equal(written.skus, 0);

  const readBack = parseMovementRows(state.calls.updates[0].values);
  assert.equal(readBack.initialized, true, '空集合也要留下完成標記');
  assert.equal(readBack.skus.size, 0);

  const reply = formatShortageReply({
    syncStatus: { status: DASHBOARD_SYNC_OK, lastSuccessAt: '2026-10-29 14:00:00' },
    movement: readBack,
    rows: [{
      sku: 'SKU-OLD', displayName: '只剩舊預購單', flyingmouseStock: 7, processing: 0,
      preparing: 0, unshipped: 3, onOrder: 0, preorderAllowance: 10, safetyStock: 0,
      estimatedStock: 0, gap: 3, status: '要叫貨', note: '', updatedAt: '2026-10-29 14:00:00'
    }]
  });
  assert.match(reply, /目前沒有要叫貨的品項/);
  assert.match(reply, /另有 1 個有缺口但近 30 天沒有訂單/);
  assert.equal(reply.includes('SKU-OLD'), false);
});
