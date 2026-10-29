import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_SKIP_REASONS,
  decideReorderAlerts,
  taipeiDateKey
} from '../src/services/reorder-alerts.js';
import { runReorderAlerts } from '../src/services/reorder-alert-job.js';
import {
  DASHBOARD_HEADERS,
  DASHBOARD_SYNC_FAILED,
  DASHBOARD_SYNC_OK,
  REORDER_ALERT_HEADERS,
  SYNC_STATUS_HEADERS,
  parseReorderAlertRows
} from '../src/sheets/inventory-dashboard.js';

const TODAY = '2026-10-29';

function row(sku, gap, overrides = {}) {
  return {
    sku,
    displayName: `商品 ${sku}`,
    flyingmouseStock: 0,
    processing: 0,
    preparing: 0,
    unshipped: 0,
    onOrder: 0,
    preorderAllowance: 10,
    safetyStock: 0,
    estimatedStock: 0,
    gap,
    status: '要叫貨',
    note: '',
    updatedAt: '2026-10-29 09:00:00',
    ...overrides
  };
}

function baselines(entries) {
  return new Map(entries.map(([sku, date, gap], index) =>
    [sku, { rowNumber: index + 2, sku, date, gap, at: '' }]));
}

// ---- 純決策 ----

test('taipeiDateKey 用台北日曆日，不看主機時區', () => {
  assert.equal(taipeiDateKey(new Date('2026-10-29T00:00:01+08:00')), '2026-10-29');
  assert.equal(taipeiDateKey(new Date('2026-10-28T16:00:01Z')), '2026-10-29');
  assert.equal(taipeiDateKey(new Date('2026-10-28T23:59:59+08:00')), '2026-10-28');
  assert.throws(() => taipeiDateKey(new Date('nope')), /時間不正確/);
});

test('同一天缺口變小不再提醒，變大才提醒', () => {
  // 計畫步驟 6 的重點：把缺口放進去重鍵的話，10 → 5 會產生新鍵而再推一次，
  // 跟「同一天只提醒一次，除非缺口又變大」正好相反。這裡比的是大小。
  const shrunk = decideReorderAlerts({
    rows: [row('SKU-A', 5)],
    baselines: baselines([['SKU-A', TODAY, 10]]),
    today: TODAY
  });
  assert.deepEqual(shrunk.alerts, []);
  assert.equal(shrunk.skipped[ALERT_SKIP_REASONS.ALREADY_ALERTED], 1);

  const grew = decideReorderAlerts({
    rows: [row('SKU-A', 12)],
    baselines: baselines([['SKU-A', TODAY, 10]]),
    today: TODAY
  });
  assert.deepEqual(grew.alerts.map((alert) => [alert.sku, alert.gap, alert.previousGap]),
    [['SKU-A', 12, 10]]);

  const same = decideReorderAlerts({
    rows: [row('SKU-A', 10)],
    baselines: baselines([['SKU-A', TODAY, 10]]),
    today: TODAY
  });
  assert.deepEqual(same.alerts, [], '一樣大不算變大');
});

test('跨日重置，前一天的基準不算數', () => {
  const result = decideReorderAlerts({
    rows: [row('SKU-A', 5)],
    baselines: baselines([['SKU-A', '2026-10-28', 10]]),
    today: TODAY
  });
  assert.deepEqual(result.alerts.map((alert) => [alert.sku, alert.previousGap]), [['SKU-A', null]]);
});

test('基準壞掉時寧可多推一次，不要漏推', () => {
  const result = decideReorderAlerts({
    rows: [row('SKU-A', 5)],
    baselines: baselines([['SKU-A', TODAY, null]]),
    today: TODAY
  });
  assert.equal(result.alerts.length, 1);
});

test('只推「要叫貨」，異常與回寫未完成都不推', () => {
  const result = decideReorderAlerts({
    rows: [
      row('SKU-OK', 5),
      // 異常的缺口也是正的，但要人先確認，不可以自動催叫貨。
      row('SKU-GHOST', 10, { status: '異常', note: '這個貨號不在 SKU主檔，請人工確認' }),
      row('SKU-PENDING', null, { status: '回寫未完成', gap: null }),
      row('SKU-FINE', -3, { status: '正常' })
    ],
    baselines: new Map(),
    today: TODAY
  });
  assert.deepEqual(result.alerts.map((alert) => alert.sku), ['SKU-OK']);
  assert.equal(result.skipped[ALERT_SKIP_REASONS.NOT_REORDERABLE], 3);
});

test('動銷篩選：沒在動的不推，查不到清單時照舊全推', () => {
  const rows = [row('SKU-HOT', 5), row('SKU-COLD', 8)];

  const filtered = decideReorderAlerts({
    rows,
    recentlyOrderedSkus: new Set(['SKU-HOT']),
    baselines: new Map(),
    today: TODAY
  });
  assert.deepEqual(filtered.alerts.map((alert) => alert.sku), ['SKU-HOT']);
  assert.equal(filtered.skipped[ALERT_SKIP_REASONS.NOT_RECENTLY_ORDERED], 1);
  assert.equal(filtered.filtered, true);

  // 計畫步驟 6：動銷判定失敗時不可整批停推。
  const unfiltered = decideReorderAlerts({
    rows,
    recentlyOrderedSkus: null,
    baselines: new Map(),
    today: TODAY
  });
  assert.deepEqual(unfiltered.alerts.map((alert) => alert.sku), ['SKU-COLD', 'SKU-HOT']);
  assert.equal(unfiltered.filtered, false);
});

test('缺口大的排前面', () => {
  const result = decideReorderAlerts({
    rows: [row('SKU-A', 3), row('SKU-B', 9), row('SKU-C', 9)],
    baselines: new Map(),
    today: TODAY
  });
  assert.deepEqual(result.alerts.map((alert) => alert.sku), ['SKU-B', 'SKU-C', 'SKU-A']);
});

// ---- 整個流程 ----

function jobSheets({
  dashboard,
  syncStatus = [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_OK, '2026-10-29 09:00:00', '2026-10-29 09:00:00', '']],
  alerts = [[...REORDER_ALERT_HEADERS]],
  failWrite = false
} = {}) {
  const calls = { updates: [] };
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          if (range.includes('叫貨提醒紀錄')) return { data: { values: alerts } };
          throw new Error(`unexpected get: ${range}`);
        },
        async batchGet({ ranges }) {
          return {
            data: {
              valueRanges: ranges.map((range) => ({
                values: range.includes('庫存看板') ? dashboard : syncStatus
              }))
            }
          };
        },
        async update(request) {
          if (failWrite) throw new Error('寫入失敗');
          calls.updates.push({ range: request.range, values: request.requestBody.values[0] });
          return { data: {} };
        }
      }
    }
  };
  return { sheets, calls };
}

function boardValues(rows) {
  return [
    [...DASHBOARD_HEADERS],
    ...rows.map((item) => [
      item.sku, item.displayName, item.flyingmouseStock, item.processing, item.preparing,
      item.unshipped, item.onOrder, item.preorderAllowance, item.safetyStock,
      item.estimatedStock, item.gap, item.status, item.note, item.updatedAt
    ])
  ];
}

function messengerSpy(onPush) {
  const pushes = [];
  return {
    pushes,
    messenger: {
      async pushReorderAlert(groupId, alerts, options) {
        pushes.push({ groupId, alerts, options });
        if (onPush) await onPush();
      }
    }
  };
}

const repository = { async getNotificationGroupId() { return 'COMPANY'; } };
const silentLogger = { info() {}, warn() {}, error() {} };

test('runReorderAlerts pushes once and records the baseline per SKU', async () => {
  const state = jobSheets({ dashboard: boardValues([row('SKU-A', 7), row('SKU-B', 3)]) });
  const spy = messengerSpy();

  const result = await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  assert.equal(result.sent, 1);
  assert.equal(result.alerts, 2);
  assert.equal(result.recorded, 2);
  assert.deepEqual(spy.pushes[0].alerts.map((alert) => alert.sku), ['SKU-A', 'SKU-B']);
  // 每個 SKU 一列，日期與缺口都記下來。
  assert.deepEqual(state.calls.updates.map((entry) => [entry.range, entry.values[0], entry.values[2]]), [
    ["'叫貨提醒紀錄'!A2:D2", 'SKU-A', 7],
    ["'叫貨提醒紀錄'!A3:D3", 'SKU-B', 3]
  ]);
});

test('runReorderAlerts stops entirely while the dashboard sync is failing', async () => {
  const state = jobSheets({
    dashboard: boardValues([row('SKU-A', 7)]),
    syncStatus: [[...SYNC_STATUS_HEADERS], [DASHBOARD_SYNC_FAILED, '2026-10-29 08:00:00', '2026-10-29 09:00:00', '飛鼠逾時']]
  });
  const spy = messengerSpy();

  const result = await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  // 規格第 5 節：看板上的數字是上一次的，照著推會叫到已經補過的貨。
  assert.deepEqual(result, { skipped: 'sync-failed', sent: 0, alerts: 0 });
  assert.deepEqual(spy.pushes, []);
  assert.deepEqual(state.calls.updates, []);
});

test('a failed push leaves no baseline, so the next run retries', async () => {
  const state = jobSheets({ dashboard: boardValues([row('SKU-A', 7)]) });
  const spy = messengerSpy(() => { throw new Error('LINE 推播失敗'); });

  await assert.rejects(runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  }), /LINE 推播失敗/);

  // 先記基準再推的話，推失敗就再也不會補推。
  assert.deepEqual(state.calls.updates, []);
});

test('runReorderAlerts keeps pushing when the movement list cannot be read', async () => {
  const state = jobSheets({ dashboard: boardValues([row('SKU-A', 7)]) });
  const spy = messengerSpy();

  const result = await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    readRecentlyOrdered: async () => { throw new Error('飛鼠登入逾時'); },
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  // 計畫步驟 6：動銷判定失敗時不可整批停推，要記錄並照舊推播。
  assert.equal(result.sent, 1);
  assert.equal(result.filtered, false);
  assert.match(result.movementError, /飛鼠登入逾時/);
  assert.equal(spy.pushes[0].options.filtered, false);
});

test('runReorderAlerts filters out SKUs that have not moved in 30 days', async () => {
  const state = jobSheets({ dashboard: boardValues([row('SKU-HOT', 7), row('SKU-COLD', 9)]) });
  const spy = messengerSpy();

  const result = await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    readRecentlyOrdered: async () => ({ skus: new Set(['SKU-HOT']) }),
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  assert.equal(result.filtered, true);
  assert.deepEqual(spy.pushes[0].alerts.map((alert) => alert.sku), ['SKU-HOT']);
  assert.equal(result.skipped[ALERT_SKIP_REASONS.NOT_RECENTLY_ORDERED], 1);
});

test('runReorderAlerts sends nothing when today is already covered', async () => {
  const state = jobSheets({
    dashboard: boardValues([row('SKU-A', 5)]),
    alerts: [[...REORDER_ALERT_HEADERS], ['SKU-A', TODAY, 10, '2026-10-29 09:00:00']]
  });
  const spy = messengerSpy();

  const result = await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  assert.equal(result.sent, 0);
  assert.deepEqual(spy.pushes, []);
  assert.deepEqual(state.calls.updates, []);
});

test('an existing baseline row is overwritten in place, not appended', async () => {
  const state = jobSheets({
    dashboard: boardValues([row('SKU-A', 12)]),
    alerts: [
      [...REORDER_ALERT_HEADERS],
      ['SKU-OTHER', TODAY, 1, ''],
      ['SKU-A', '2026-10-28', 10, '']
    ]
  });
  const spy = messengerSpy();

  await runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  });

  assert.deepEqual(state.calls.updates.map((entry) => entry.range), ["'叫貨提醒紀錄'!A3:D3"]);
  assert.deepEqual(state.calls.updates[0].values.slice(0, 3), ['SKU-A', TODAY, 12]);
});

test('runReorderAlerts refuses a duplicate SKU in the baseline sheet', async () => {
  const state = jobSheets({
    dashboard: boardValues([row('SKU-A', 5)]),
    alerts: [[...REORDER_ALERT_HEADERS], ['SKU-A', TODAY, 1, ''], ['SKU-A', TODAY, 2, '']]
  });
  const spy = messengerSpy();

  await assert.rejects(runReorderAlerts({
    sheets: state.sheets,
    spreadsheetId: 'sheet-123',
    repository,
    messenger: spy.messenger,
    at: new Date('2026-10-29T10:00:00+08:00'),
    logger: silentLogger
  }), /在第 2、3 列重複/);
  assert.deepEqual(spy.pushes, [], '基準讀不準就不要推');
});

test('parseReorderAlertRows validates the header and reports the next free row', () => {
  const parsed = parseReorderAlertRows([
    [...REORDER_ALERT_HEADERS],
    ['SKU-A', TODAY, 4, '2026-10-29 09:00:00'],
    [],
    ['SKU-B', TODAY, 'x', '']
  ]);
  assert.equal(parsed.bySku.get('SKU-A').gap, 4);
  assert.equal(parsed.bySku.get('SKU-B').gap, null, '壞掉的基準讀成 null');
  assert.equal(parsed.nextRow, 5);
  assert.throws(() => parseReorderAlertRows([['SKU', '日期', '已提醒缺口', '最後提醒時間']]),
    /叫貨提醒紀錄 表頭不符/);
});
