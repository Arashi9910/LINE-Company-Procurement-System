import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_HEADERS,
  DASHBOARD_SYNC_FAILED,
  DASHBOARD_SYNC_OK,
  PREORDER_HEADERS,
  SYNC_STATUS_HEADERS,
  readCatalogSnapshots,
  readDashboardSyncStatus,
  safeSyncMessage,
  writeDashboardSyncStatus
} from '../src/sheets/inventory-dashboard.js';
import { WRITEBACK_HEADERS, buildWritebackEvent, writebackEventRow } from '../src/flyingmouse/sheets-writeback.js';
import { MAIN_HEADERS } from '../src/flyingmouse/sheets-review.js';
import { pendingWritebackSkus, runInventoryDashboard } from '../src/services/inventory-dashboard-job.js';
import { runFlyingMouseCombinedJob } from '../scripts/flyingmouse-combined-job.mjs';

const UPDATED_AT = '2026-10-29 15:00:00';

function catalogRow(sku, stock, displayName = `商品 ${sku}`) {
  return [sku, displayName, '', '', stock, '', '', displayName, '一般SKU', '是', '', '件', '飛鼠', ''];
}

function writebackRow(sku, status, overrides = {}) {
  const base = buildWritebackEvent({
    idempotencyKey: `receipt-key-${sku}-000000`,
    requestId: `RQ-${sku}`,
    sku,
    receivedQuantity: 1,
    actorUserId: 'U1',
    createdAt: new Date('2026-10-29T01:00:00Z')
  });
  return writebackEventRow({ ...base, status, ...overrides });
}

function sheetsFor({
  catalog = [],
  catalogHeaders = MAIN_HEADERS,
  preorder = [[...PREORDER_HEADERS]],
  writeback = [[...WRITEBACK_HEADERS]],
  writebackSequence = null,
  dashboard = [[...DASHBOARD_HEADERS]],
  syncStatus = [[...SYNC_STATUS_HEADERS]],
  failOn = null
} = {}) {
  const calls = { reads: [], updates: [], writebackReads: 0 };
  const rangeValues = (range) => {
    if (failOn && range.includes(failOn)) throw new Error(`讀取 ${failOn} 失敗`);
    if (range.includes('SKU主檔')) return [[...catalogHeaders], ...catalog];
    if (range.includes('預購額度')) return preorder;
    if (range.includes('飛鼠庫存回寫')) {
      const index = calls.writebackReads;
      calls.writebackReads += 1;
      if (!writebackSequence) return writeback;
      return writebackSequence[Math.min(index, writebackSequence.length - 1)];
    }
    if (range.includes('庫存看板')) return dashboard;
    if (range.includes('看板同步狀態')) return syncStatus;
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
        }
      }
    }
  };
  return { sheets, calls };
}

function dashboardWrites(calls) {
  return calls.updates.filter((entry) => entry.range.includes('庫存看板'));
}

function statusWrite(calls) {
  return calls.updates.find((entry) => entry.range.includes('看板同步狀態'))?.values[0];
}

const silentLogger = { info() {}, warn() {}, error() {} };

test('pendingWritebackSkus blocks every status except 已完成', () => {
  const events = ['待處理', '已準備', '等待重試', '需人工確認', '已完成']
    .map((status, index) => ({ sku: `SKU-${index}`, status }));

  // 計畫步驟 5：要擋的是除了「已完成」以外的全部四種。
  assert.deepEqual(pendingWritebackSkus(events), ['SKU-0', 'SKU-1', 'SKU-2', 'SKU-3']);
  assert.deepEqual(pendingWritebackSkus([{ sku: ' SKU-A ', status: '待處理' }, { sku: 'SKU-A', status: '等待重試' }]),
    ['SKU-A']);
  assert.deepEqual(pendingWritebackSkus([{ sku: '', status: '待處理' }]), []);
});

test('runInventoryDashboard writes the board and marks the sync successful', async () => {
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    preorder: [[...PREORDER_HEADERS], ['SKU-A', 10, '', '', '', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({
      parts: [{ partNo: 'SKU-A', processing: 3, preparing: 0, total: 3 }],
      orderCounts: { processing: 1, preparing: 0 },
      driftedOrderIds: []
    }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows, 1);
  // 規格第 3 節商品 A「賣 3」：飛鼠 7、未寄 3、推算實際 0、缺口 3。
  const written = dashboardWrites(state.calls)[0].values;
  assert.deepEqual(written[1].slice(0, 12),
    ['SKU-A', '商品 SKU-A', 7, 3, 0, 3, 0, 10, 0, 0, 3, '要叫貨']);
  assert.deepEqual(statusWrite(state.calls), [DASHBOARD_SYNC_OK, UPDATED_AT, UPDATED_AT, '']);
});

test('runInventoryDashboard suppresses a SKU that still has an unfinished writeback', async () => {
  for (const status of ['待處理', '已準備', '等待重試', '需人工確認']) {
    const state = sheetsFor({
      catalog: [catalogRow('SKU-A', 7)],
      preorder: [[...PREORDER_HEADERS], ['SKU-A', 10, '', '', '', '']],
      writeback: [[...WRITEBACK_HEADERS], writebackRow('SKU-A', status, {
        ...(status === '已準備' ? { partId: 1, beforeStock: 7, targetStock: 8 } : {}),
        ...(status === '等待重試' ? { nextRetryAt: '2099-01-01 00:00:00' } : {})
      })]
    });

    const result = await runInventoryDashboard({
      sheets: state.sheets,
      spreadsheetId: 'sheet-123',
      readOrders: async () => ({
        parts: [{ partNo: 'SKU-A', processing: 3, preparing: 0, total: 3 }],
        orderCounts: { processing: 1, preparing: 0 },
        driftedOrderIds: []
      }),
      listTrackingRows: async () => [],
      updatedAt: UPDATED_AT,
      logger: silentLogger
    });

    assert.equal(result.writebackPendingSkus, 1, `${status} 應該被擋下來`);
    const row = dashboardWrites(state.calls)[0].values[1];
    assert.equal(row[11], '回寫未完成', `${status} 的狀態欄不對`);
    // 缺口與推算實際要空白，不可寫 0——寫 0 在看板上看起來就是「不缺貨」。
    assert.equal(row[9], '', `${status} 的推算實際庫存應該空白`);
    assert.equal(row[10], '', `${status} 的缺口應該空白`);
  }
});

test('runInventoryDashboard never reads the processable-only writeback view', async () => {
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 1)] });

  await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({ parts: [], orderCounts: { processing: 0, preparing: 0 }, driftedOrderIds: [] }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  // listProcessableWritebacks 會跳過還沒到期的重試、不回需人工確認、還有批次上限，
  // 代表不了「所有未完成的回寫」，所以整張讀。
  const writebackReads = state.calls.reads.filter((range) => range.includes('飛鼠庫存回寫'));
  // 一輪讀兩次：讀其他分頁之前與之後各一次，用來偵測讀取途中的變動。
  assert.deepEqual(writebackReads, ["'飛鼠庫存回寫'!A1:O5000", "'飛鼠庫存回寫'!A1:O5000"]);
});

test('a receipt landing mid-read makes the round start over, not publish a half snapshot', async () => {
  // 登記到貨會在同一批 update 裡把補貨追蹤的未到量減掉、並附上一筆回寫事件。
  // 如果先讀到「沒有待回寫事件」、再讀到「未到量已歸零」，就會發布一個
  // 該被「回寫未完成」擋下來的缺口——飛鼠庫存還沒回寫加上去，缺口整個高估。
  const empty = [[...WRITEBACK_HEADERS]];
  const withEvent = [[...WRITEBACK_HEADERS], writebackRow('SKU-A', '待處理')];
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    preorder: [[...PREORDER_HEADERS], ['SKU-A', 10, '', '', '', '']],
    // 第 1 輪：讀前沒事件、讀後有事件（到貨剛落地）→ 必須重讀。
    // 第 2 輪：前後都有事件 → 一致，採用。
    writebackSequence: [empty, withEvent, withEvent, withEvent]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({
      parts: [{ partNo: 'SKU-A', processing: 3, preparing: 0, total: 3 }],
      orderCounts: { processing: 1, preparing: 0 },
      driftedOrderIds: []
    }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, true);
  assert.equal(result.writebackPendingSkus, 1);
  assert.equal(state.calls.writebackReads, 4);
  assert.equal(dashboardWrites(state.calls)[0].values[1][11], '回寫未完成');
});

test('a queue that keeps changing gives up instead of publishing', async () => {
  const empty = [[...WRITEBACK_HEADERS]];
  const withEvent = [[...WRITEBACK_HEADERS], writebackRow('SKU-A', '待處理')];
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    // 每一輪的前後都不一樣，三輪都失敗。
    writebackSequence: [empty, withEvent, empty, withEvent, empty, withEvent],
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_OK, '2026-10-29 14:00:00', '2026-10-29 14:00:00', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({ parts: [], orderCounts: { processing: 0, preparing: 0 }, driftedOrderIds: [] }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /讀取途中持續變動/);
  // 寧可保留上一次的看板，也不要發布一份對不起來的。
  assert.deepEqual(dashboardWrites(state.calls), []);
  assert.equal(statusWrite(state.calls)[1], '2026-10-29 14:00:00');
});

test('runInventoryDashboard reads the sheets fresh, after the writeback phase', async () => {
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 1)] });
  let trackingReads = 0;

  await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({ parts: [], orderCounts: { processing: 0, preparing: 0 }, driftedOrderIds: [] }),
    listTrackingRows: async () => { trackingReads += 1; return []; },
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(trackingReads, 1);
  assert.equal(state.calls.reads.some((range) => range.includes('SKU主檔')), true);
  assert.equal(state.calls.reads.some((range) => range.includes('預購額度')), true);
});

test('a failed order read leaves the board untouched and records the failure', async () => {
  const previousBoard = [
    [...DASHBOARD_HEADERS],
    ['SKU-OLD', '舊商品', 1, 0, 0, 0, 0, 0, 0, 1, 0, '正常', '', '2026-10-29 14:00:00']
  ];
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    dashboard: previousBoard,
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_OK, '2026-10-29 14:00:00', '2026-10-29 14:00:00', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => { throw new Error('飛鼠訂單筆數不符：去重後 96，API total 97'); },
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  // 規格第 5 節：不覆寫看板，保留上一次的數值與最後成功時間。
  assert.deepEqual(dashboardWrites(state.calls), []);
  assert.deepEqual(statusWrite(state.calls), [
    DASHBOARD_SYNC_FAILED,
    '2026-10-29 14:00:00',
    UPDATED_AT,
    '飛鼠訂單筆數不符：去重後 96，API total 97'
  ]);
  assert.equal(result.lastSuccessAt, '2026-10-29 14:00:00');
});

test('a failed sheet read also leaves the board untouched', async () => {
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    failOn: '預購額度',
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_OK, '2026-10-29 14:00:00', '2026-10-29 14:00:00', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({ parts: [], orderCounts: { processing: 0, preparing: 0 }, driftedOrderIds: [] }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  assert.deepEqual(dashboardWrites(state.calls), []);
  assert.equal(statusWrite(state.calls)[0], DASHBOARD_SYNC_FAILED);
  assert.equal(statusWrite(state.calls)[1], '2026-10-29 14:00:00');
});

test('a blank 庫存快照 fails the sync instead of inventing a zero', async () => {
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', '')] });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({
      parts: [{ partNo: 'SKU-A', processing: 1, preparing: 0, total: 1 }],
      orderCounts: { processing: 1, preparing: 0 },
      driftedOrderIds: []
    }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /庫存快照/);
  assert.deepEqual(dashboardWrites(state.calls), []);
});

test('the failure path keeps no last-success time when the status sheet cannot be read', async () => {
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 7)], failOn: '看板同步狀態' });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => { throw new Error('登入失敗'); },
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  // 讀不到就留空白，不可謊報一個最後成功時間。
  assert.equal(result.ok, false);
  assert.equal(result.lastSuccessAt, '');
  assert.deepEqual(statusWrite(state.calls), [DASHBOARD_SYNC_FAILED, '', UPDATED_AT, '登入失敗']);
});

test('a swapped 看板同步狀態 header stops every write, including the failure note', async () => {
  // 使用者把「最後成功時間」和「訊息」對調。照固定位置寫 A2:D2 的話，
  // 會把錯誤摘要寫進時間欄、順手清掉最後成功時間——補救動作變成第二次破壞。
  const swapped = [...SYNC_STATUS_HEADERS];
  [swapped[1], swapped[3]] = [swapped[3], swapped[1]];
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    syncStatus: [swapped, [DASHBOARD_SYNC_OK, '2026-10-29 14:00:00', '2026-10-29 14:00:00', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({
      parts: [{ partNo: 'SKU-A', processing: 3, preparing: 0, total: 3 }],
      orderCounts: { processing: 1, preparing: 0 },
      driftedOrderIds: []
    }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  assert.equal(result.structurallyBroken, true);
  assert.match(result.error, /看板同步狀態 表頭不符/);
  // 看板沒寫、狀態列也沒寫：結構壞掉時什麼都不碰，交給人去修。
  assert.deepEqual(state.calls.updates, []);
});

test('a broken SKU主檔 header also stops the failure note', async () => {
  const moved = [...MAIN_HEADERS];
  [moved[4], moved[7]] = [moved[7], moved[4]];
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 7)], catalogHeaders: moved });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => ({ parts: [], orderCounts: { processing: 0, preparing: 0 }, driftedOrderIds: [] }),
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  assert.equal(result.ok, false);
  assert.equal(result.structurallyBroken, true);
  assert.deepEqual(state.calls.updates, []);
});

test('a transient read failure still records the failure note', async () => {
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7)],
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_OK, '2026-10-29 14:00:00', '2026-10-29 14:00:00', '']]
  });

  const result = await runInventoryDashboard({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    readOrders: async () => { throw new Error('飛鼠登入逾時'); },
    listTrackingRows: async () => [],
    updatedAt: UPDATED_AT,
    logger: silentLogger
  });

  // 表頭沒問題、只是這次失敗 → 照常記錄，並保留最後成功時間。
  assert.equal(result.ok, false);
  assert.equal(result.structurallyBroken, false);
  assert.deepEqual(statusWrite(state.calls), [
    DASHBOARD_SYNC_FAILED, '2026-10-29 14:00:00', UPDATED_AT, '飛鼠登入逾時'
  ]);
  assert.deepEqual(dashboardWrites(state.calls), []);
});

test('safeSyncMessage truncates at the first sensitive keyword', () => {
  assert.equal(safeSyncMessage('第一行\n第二行\r\n第三行'), '第一行 第二行 第三行');
  // 只遮「關鍵字後面第一個詞」會漏：Bearer 之後、分號之後、引號格式都擋不住。
  assert.equal(safeSyncMessage('login failed password=hunter2'), 'login failed <redacted>');
  assert.equal(safeSyncMessage('HTTP 401 Authorization: Bearer secret123'), 'HTTP 401 <redacted>');
  assert.equal(safeSyncMessage('Cookie: a=1; session=secret123'), '<redacted>');
  assert.equal(safeSyncMessage('{"password":"secret123"}'), '{"<redacted>');
  assert.equal(safeSyncMessage('api_key 用完了'), '<redacted>');
  // 長得像 token 的連續字串也整段換掉。
  assert.equal(safeSyncMessage(`refresh 失敗 ya29.${'A'.repeat(40)}`), 'refresh 失敗 <redacted>');
  assert.equal(safeSyncMessage('讀取逾時'), '讀取逾時');
  assert.equal(safeSyncMessage('第 5 列的庫存快照必須是整數'), '第 5 列的庫存快照必須是整數');
  assert.equal(safeSyncMessage('垮'.repeat(400)).length, 300);
});

test('readCatalogSnapshots prefers 補貨顯示名稱 and passes the stock through raw', async () => {
  const state = sheetsFor({
    catalog: [
      catalogRow('SKU-A', -1, '顯示名稱 A'),
      ['SKU-B', '商品 B', '', '', '', '', '', '', '', '', '', '', '', ''],
      []
    ]
  });

  const rows = await readCatalogSnapshots({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  assert.deepEqual(rows, [
    { sku: 'SKU-A', displayName: '顯示名稱 A', stock: -1 },
    { sku: 'SKU-B', displayName: '商品 B', stock: '' }
  ]);
  // 要從第 1 列讀起才驗得到表頭。
  assert.deepEqual(state.calls.reads.filter((range) => range.includes('SKU主檔')), ["'SKU主檔'!A1:N"]);
});

test('readCatalogSnapshots stops when a SKU主檔 column moved', async () => {
  // 這裡是用固定欄位序號取值的。庫存快照搬到別欄而第 5 欄剛好還是整數時，
  // 會把別的數字當成庫存發布出去，缺口整個錯而且沒人會發現。
  const moved = [...MAIN_HEADERS];
  [moved[4], moved[5]] = [moved[5], moved[4]];
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 7)], catalogHeaders: moved });

  await assert.rejects(readCatalogSnapshots({ sheets: state.sheets, spreadsheetId: 'sheet-123' }),
    /SKU主檔 表頭不符/);
});

test('readCatalogSnapshots refuses a non-empty row without a SKU', async () => {
  const state = sheetsFor({
    catalog: [catalogRow('SKU-A', 7), ['', '沒有 SKU 的商品', '', '', 99, '', '', '', '', '', '', '', '', '']]
  });

  // 默默跳過的話，那一列的庫存就這樣從帳上消失了。
  await assert.rejects(readCatalogSnapshots({ sheets: state.sheets, spreadsheetId: 'sheet-123' }),
    /SKU主檔 第 3 列缺少 SKU/);
});

test('readCatalogSnapshots never writes to SKU主檔', async () => {
  const state = sheetsFor({ catalog: [catalogRow('SKU-A', 1)] });

  await readCatalogSnapshots({ sheets: state.sheets, spreadsheetId: 'sheet-123' });

  // SKU主檔 每次寫入前都會比對 A:N 的欄位名稱，動了就會讓目錄同步整批停止。
  assert.deepEqual(state.calls.updates, []);
});

test('the sync status round-trips and refuses an unknown status', async () => {
  const state = sheetsFor({
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_FAILED, '2026-10-29 14:00:00', UPDATED_AT, '讀取逾時']]
  });

  assert.deepEqual(await readDashboardSyncStatus({ sheets: state.sheets, spreadsheetId: 'sheet-123' }), {
    status: DASHBOARD_SYNC_FAILED,
    lastSuccessAt: '2026-10-29 14:00:00',
    lastAttemptAt: UPDATED_AT,
    message: '讀取逾時'
  });
  assert.deepEqual(await readDashboardSyncStatus({
    sheets: sheetsFor().sheets,
    spreadsheetId: 'sheet-123'
  }), { status: '', lastSuccessAt: '', lastAttemptAt: '', message: '' });

  await assert.rejects(writeDashboardSyncStatus({
    sheets: state.sheets, spreadsheetId: 'sheet-123', status: '還好', lastAttemptAt: UPDATED_AT
  }), /看板同步狀態不正確/);
  await assert.rejects(writeDashboardSyncStatus({
    sheets: state.sheets, spreadsheetId: 'sheet-123', status: DASHBOARD_SYNC_OK, lastAttemptAt: ' '
  }), /缺少最後嘗試時間/);
});

test('the combined job runs the dashboard last and survives its failure', async () => {
  const phases = [];
  const result = await runFlyingMouseCombinedJob({
    catalog: {}, writeback: {}, dashboard: {}
  }, {
    runCatalog: async () => { phases.push('catalog'); return { ok: true }; },
    runWriteback: async () => { phases.push('writeback'); return { completed: 1 }; },
    runDashboard: async () => { phases.push('dashboard'); throw new Error('看板炸了\n第二行'); },
    logger: silentLogger
  });

  assert.deepEqual(phases, ['catalog', 'writeback', 'dashboard']);
  // 看板失敗不得影響商品同步與回寫的結果。
  assert.deepEqual(result.catalog, { ok: true });
  assert.deepEqual(result.writeback, { completed: 1 });
  assert.deepEqual(result.dashboard, { ok: false, error: '看板炸了 第二行' });
});

test('the combined job keeps the dashboard result when it succeeds', async () => {
  const result = await runFlyingMouseCombinedJob({
    catalog: {}, writeback: {}, dashboard: {}
  }, {
    runCatalog: async () => ({ ok: true }),
    runWriteback: async () => ({ completed: 0 }),
    runDashboard: async () => ({ ok: true, rows: 1447 }),
    logger: silentLogger
  });

  assert.deepEqual(result.dashboard, { ok: true, rows: 1447 });
});

test('MAIN_HEADERS still matches the columns readCatalogSnapshots relies on', () => {
  // 讀 SKU主檔 用的是固定欄位序號，欄位搬家就會讀到別的東西。
  assert.equal(MAIN_HEADERS[0], 'SKU');
  assert.equal(MAIN_HEADERS[1], '商品名稱');
  assert.equal(MAIN_HEADERS[4], '庫存快照');
  assert.equal(MAIN_HEADERS[7], '補貨顯示名稱');
});
