// 庫存看板的執行流程：讀資料 → 算 → 寫分頁。數字怎麼算在 inventory-dashboard.js（純計算），
// 這裡只負責 IO 與失敗處理。依 docs/inventory-dashboard-plan.md 步驟 5、規格第 5 節。
//
// 這一步**必須排在到貨回寫之後**。repository 在登記到貨當下就把補貨追蹤的未到量減掉，
// 但飛鼠庫存要等 completeWritebackEvent 才寫進 SKU主檔的庫存快照；夾在中間跑的話，
// 「已叫貨未到」已經歸零而「飛鼠庫存」還沒加上去，缺口會被高估並觸發多餘的叫貨提醒。
import { readWritebackEvents } from '../flyingmouse/sheets-writeback.js';
import {
  DASHBOARD_SYNC_FAILED,
  DASHBOARD_SYNC_OK,
  readCatalogSnapshots,
  readDashboardSyncStatus,
  readPreorderAllowances,
  safeSyncMessage,
  writeDashboardSyncStatus,
  writeInventoryDashboard
} from '../sheets/inventory-dashboard.js';
import { buildInventoryDashboard } from './inventory-dashboard.js';

// 要擋的是「除了已完成以外的全部」。WRITEBACK_STATUSES 共五種：
// 待處理、已準備、等待重試、已完成、需人工確認。
const WRITEBACK_DONE = '已完成';

function log(logger, level, data) {
  const writer = logger?.[level];
  if (typeof writer === 'function') writer.call(logger, data);
}

// 只要該 SKU 還有任何未完成的回寫事件，缺口就不發布。
// 不可用 listProcessableWritebacks：它會跳過 nextRetryAt 還沒到期的「等待重試」、
// 不回「需人工確認」，而且有批次上限（預設 20），代表不了「所有未完成的回寫」。
export function pendingWritebackSkus(events) {
  const skus = new Set();
  for (const event of events) {
    if (event.status === WRITEBACK_DONE) continue;
    const sku = String(event.sku ?? '').trim();
    if (sku) skus.add(sku);
  }
  return [...skus];
}

export async function runInventoryDashboard({
  sheets,
  spreadsheetId,
  readOrders,
  listTrackingRows,
  updatedAt,
  logger = null
}) {
  if (!sheets || !spreadsheetId) throw new Error('庫存看板執行設定不完整');
  if (typeof readOrders !== 'function') throw new Error('庫存看板缺少訂單讀取器');
  if (typeof listTrackingRows !== 'function') throw new Error('庫存看板缺少補貨追蹤讀取器');
  const attemptedAt = String(updatedAt ?? '').trim();
  if (!attemptedAt) throw new Error('庫存看板缺少更新時間');

  try {
    // 訂單要先讀：它最慢（要登入飛鼠），失敗的話就不必動任何分頁。
    const orders = await readOrders();

    // 回寫之後重新讀，不可重用回寫前讀到的值。
    const [catalog, tracking, events, preorders] = await Promise.all([
      readCatalogSnapshots({ sheets, spreadsheetId }),
      listTrackingRows(),
      readWritebackEvents({ sheets, spreadsheetId }),
      readPreorderAllowances({ sheets, spreadsheetId })
    ]);
    const writebackPendingSkus = pendingWritebackSkus(events);

    const dashboard = buildInventoryDashboard({
      catalog,
      orderQuantities: orders.parts,
      tracking,
      preorders,
      writebackPendingSkus,
      updatedAt: attemptedAt
    });
    const written = await writeInventoryDashboard({ sheets, spreadsheetId, dashboard });
    const syncStatus = await writeDashboardSyncStatus({
      sheets,
      spreadsheetId,
      status: DASHBOARD_SYNC_OK,
      lastSuccessAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      message: ''
    });

    log(logger, 'info', {
      component: 'inventory-dashboard',
      status: 'completed',
      rows: written.rows,
      clearedRows: written.clearedRows,
      writebackPendingSkus: writebackPendingSkus.length,
      orderCounts: orders.orderCounts
    });
    return Object.freeze({
      ok: true,
      rows: written.rows,
      clearedRows: written.clearedRows,
      writebackPendingSkus: writebackPendingSkus.length,
      syncStatus
    });
  } catch (error) {
    // 規格第 5 節：失敗時不覆寫看板，保留上一次的數值與最後成功時間。
    const message = safeSyncMessage(error?.message ?? '未知錯誤');
    let previous = null;
    try {
      previous = await readDashboardSyncStatus({ sheets, spreadsheetId });
    } catch (readError) {
      // 連狀態都讀不到時，寧可讓「最後成功時間」空白，也不要謊報一個時間。
      log(logger, 'warn', {
        component: 'inventory-dashboard',
        status: 'sync-status-unreadable',
        error: safeSyncMessage(readError?.message ?? '未知錯誤')
      });
    }
    let syncStatus = null;
    try {
      syncStatus = await writeDashboardSyncStatus({
        sheets,
        spreadsheetId,
        status: DASHBOARD_SYNC_FAILED,
        lastSuccessAt: previous?.lastSuccessAt ?? '',
        lastAttemptAt: attemptedAt,
        message
      });
    } catch (writeError) {
      log(logger, 'error', {
        component: 'inventory-dashboard',
        status: 'sync-status-unwritable',
        error: safeSyncMessage(writeError?.message ?? '未知錯誤')
      });
    }
    log(logger, 'error', { component: 'inventory-dashboard', status: 'failed', error: message });
    return Object.freeze({
      ok: false,
      error: message,
      lastSuccessAt: previous?.lastSuccessAt ?? '',
      syncStatus
    });
  }
}
