// 叫貨提醒的執行流程：讀看板 → 篩動銷 → 比缺口基準 → 推播 → 記下基準。
// 要推給誰的規則在 reorder-alerts.js（純決策），這裡只做 IO 與失敗處理。
import {
  DASHBOARD_SYNC_FAILED,
  readInventoryDashboard,
  readReorderAlerts,
  writeReorderAlert
} from '../sheets/inventory-dashboard.js';
import { decideReorderAlerts, taipeiDateKey } from './reorder-alerts.js';

function log(logger, level, data) {
  const writer = logger?.[level];
  if (typeof writer === 'function') writer.call(logger, data);
}

function safeError(error) {
  return String(error?.message ?? '未知錯誤').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

export async function runReorderAlerts({
  sheets,
  spreadsheetId,
  repository,
  messenger,
  readRecentlyOrdered = null,
  at = new Date(),
  logger = null
}) {
  if (!sheets || !spreadsheetId) throw new Error('叫貨提醒設定不完整');
  if (typeof messenger?.pushReorderAlert !== 'function') throw new Error('叫貨提醒缺少推播器');
  const today = taipeiDateKey(at);
  const timestamp = `${today} ${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(at)}`;

  const [dashboard, groupId] = await Promise.all([
    readInventoryDashboard({ sheets, spreadsheetId }),
    repository.getNotificationGroupId()
  ]);

  // 規格第 5 節：同步失敗期間停止叫貨提醒。看板上的數字是上一次的，
  // 照著推會叫到已經補過的貨。
  if (dashboard.syncStatus?.status === DASHBOARD_SYNC_FAILED) {
    log(logger, 'warn', {
      component: 'reorder-alerts',
      status: 'skipped-sync-failed',
      lastSuccessAt: dashboard.syncStatus.lastSuccessAt
    });
    return Object.freeze({ skipped: 'sync-failed', sent: 0, alerts: 0 });
  }
  if (!groupId) {
    log(logger, 'warn', { component: 'reorder-alerts', status: 'skipped-no-group' });
    return Object.freeze({ skipped: 'no-group', sent: 0, alerts: 0 });
  }

  // 動銷清單查不到時照舊推播，不可以整批停推（計畫步驟 6）。
  let recentlyOrderedSkus = null;
  let movementError = '';
  if (typeof readRecentlyOrdered === 'function') {
    try {
      recentlyOrderedSkus = (await readRecentlyOrdered()).skus;
    } catch (error) {
      movementError = safeError(error);
      log(logger, 'warn', {
        component: 'reorder-alerts',
        status: 'movement-filter-unavailable',
        error: movementError
      });
    }
  }

  const { bySku, nextRow } = await readReorderAlerts({ sheets, spreadsheetId });
  const decision = decideReorderAlerts({
    rows: dashboard.rows,
    recentlyOrderedSkus,
    baselines: bySku,
    today
  });
  if (decision.alerts.length === 0) {
    log(logger, 'info', {
      component: 'reorder-alerts', status: 'nothing-to-send', skipped: decision.skipped
    });
    return Object.freeze({
      sent: 0, alerts: 0, skipped: decision.skipped, filtered: decision.filtered, movementError
    });
  }

  await messenger.pushReorderAlert(groupId, decision.alerts, {
    updatedAt: dashboard.rows[0]?.updatedAt ?? '',
    filtered: decision.filtered
  });

  // 推播成功之後才記基準。先記再推的話，推失敗就再也不會補推了。
  // 反過來（推成功但記失敗）最多下一輪重推一次，那比漏推安全。
  let row = nextRow;
  const recorded = [];
  const failures = [];
  for (const alert of decision.alerts) {
    const existing = bySku.get(alert.sku);
    const rowNumber = existing?.rowNumber ?? row;
    if (!existing) row += 1;
    try {
      await writeReorderAlert({
        sheets, spreadsheetId, rowNumber, sku: alert.sku, date: today, gap: alert.gap, at: timestamp
      });
      recorded.push(alert.sku);
    } catch (error) {
      failures.push({ sku: alert.sku, error: safeError(error) });
    }
  }
  if (failures.length > 0) {
    log(logger, 'error', {
      component: 'reorder-alerts', status: 'baseline-write-failed', failures
    });
  }

  log(logger, 'info', {
    component: 'reorder-alerts',
    status: 'sent',
    alerts: decision.alerts.length,
    recorded: recorded.length,
    skipped: decision.skipped,
    filtered: decision.filtered
  });
  return Object.freeze({
    sent: 1,
    alerts: decision.alerts.length,
    recorded: recorded.length,
    baselineFailures: failures.length,
    skipped: decision.skipped,
    filtered: decision.filtered,
    movementError
  });
}
