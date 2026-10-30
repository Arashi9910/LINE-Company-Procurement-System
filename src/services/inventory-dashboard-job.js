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
  SYNC_STATUS_SHEET_NAME,
  SheetHeaderError,
  readCatalogSnapshots,
  readDashboardSyncStatus,
  readPreorderAllowances,
  readTrackingRows,
  writeMovementSkus,
  safeSyncMessage,
  writeDashboardSyncStatus,
  writeInventoryDashboard
} from '../sheets/inventory-dashboard.js';
import { buildInventoryDashboard } from './inventory-dashboard.js';
import { classifyStockMode } from './stock-mode.js';

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

// 四筆讀取是四個各自獨立的 HTTP 請求，不是一致快照。
// 危險的那一種交錯是「登記到貨」：repository 會在同一批 update 裡把補貨追蹤的未到量減掉、
// 並附上一筆回寫事件。如果我們先讀到「沒有待回寫事件」，接著到貨登記落地，
// 再讀到「未到量已歸零」，就會發布一個該被「回寫未完成」擋下來的缺口——
// 飛鼠庫存還沒被回寫加上去，缺口整個高估，正好是排在回寫之後要避免的那件事。
//
// 回寫佇列是這類寫入的共同足跡（到貨登記會新增事件、回寫完成會改狀態），
// 所以用它當前後哨兵：讀之前與讀之後各取一次，不一致就重讀。
const MAX_SNAPSHOT_REREADS = 2;

function eventsFingerprint(events) {
  return events
    // 用 JSON 串，避免事件 ID 或狀態裡出現分隔字元造成兩組不同的事件印出同一個指紋。
    .map((event) => JSON.stringify([event.eventId, event.status]))
    .sort()
    .join('|');
}

async function readConsistentSnapshot({ sheets, spreadsheetId, listTrackingRows, logger }) {
  let lastFingerprints = null;
  for (let attempt = 0; attempt <= MAX_SNAPSHOT_REREADS; attempt += 1) {
    const before = await readWritebackEvents({ sheets, spreadsheetId });
    const [catalog, tracking, preorders] = await Promise.all([
      readCatalogSnapshots({ sheets, spreadsheetId }),
      readTrackingRows({ sheets, spreadsheetId, listTrackingRows }),
      readPreorderAllowances({ sheets, spreadsheetId })
    ]);
    const after = await readWritebackEvents({ sheets, spreadsheetId });

    const beforePrint = eventsFingerprint(before);
    const afterPrint = eventsFingerprint(after);
    if (beforePrint === afterPrint) return { catalog, tracking, preorders, events: after };

    lastFingerprints = { before: before.length, after: after.length };
    log(logger, 'warn', {
      component: 'inventory-dashboard',
      status: 'snapshot-drift',
      attempt: attempt + 1,
      ...lastFingerprints
    });
  }
  throw new Error(
    `回寫佇列在讀取途中持續變動（最後一次 ${lastFingerprints?.before} → ${lastFingerprints?.after} 筆），這一輪不發布`
  );
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
    // 動銷件數現在是安全庫存的計算依據，不再只是個篩子。
    // 查不到就當成「沒有動銷」的話，現貨商品的安全庫存會整批變 0，
    // 然後把一張「全部正常」的看板發布出去——比不更新還糟。
    if (orders.recentlyOrderedError) {
      throw new Error(`近 30 天動銷查詢失敗，這一輪不發布：${orders.recentlyOrderedError}`);
    }

    // 回寫之後重新讀，不可重用回寫前讀到的值。
    const { catalog, tracking, preorders, events } = await readConsistentSnapshot({
      sheets,
      spreadsheetId,
      listTrackingRows,
      logger
    });
    const writebackPendingSkus = pendingWritebackSkus(events);

    // 從商品名稱判斷有沒有實體庫存。這只是預設值，「預購額度」分頁填了就以它為準。
    const stockModes = new Map(catalog.map((item) => [item.sku, classifyStockMode(item.displayName)]));
    const recentUnits = orders.recentlyOrdered?.units ?? new Map();

    const dashboard = buildInventoryDashboard({
      catalog,
      orderQuantities: orders.parts,
      tracking,
      preorders,
      writebackPendingSkus,
      stockModes,
      recentUnits,
      updatedAt: attemptedAt
    });
    // 看板與「同步成功」同一批寫入：分兩次的話，看板換新了而狀態寫入失敗，
    // 就會留下「看板是新的、狀態說失敗、最後成功時間是舊的」這種對不起來的組合。
    const written = await writeInventoryDashboard({
      sheets,
      spreadsheetId,
      dashboard,
      syncStatus: {
        status: DASHBOARD_SYNC_OK,
        lastSuccessAt: attemptedAt,
        lastAttemptAt: attemptedAt,
        message: ''
      }
    });
    const syncStatus = written.syncStatus;

    // 動銷清單是給 `查缺貨` 用的附加品，不是看板的一部分。
    // 它失敗不可以把整輪拖成「同步失敗」——看板數字本身是好的。
    // 更新時間刻意用跟看板同一個 attemptedAt：讀取端靠「兩邊時間相同」判斷
    // 這份清單是不是跟看板同一輪寫出來的，不一致就不拿它篩。
    let movement = null;
    if (orders.recentlyOrdered) {
      try {
        movement = await writeMovementSkus({
          sheets,
          spreadsheetId,
          units: orders.recentlyOrdered.units,
          since: orders.recentlyOrdered.since,
          updatedAt: attemptedAt
        });
      } catch (error) {
        log(logger, 'warn', {
          component: 'inventory-dashboard',
          status: 'movement-list-failed',
          error: safeSyncMessage(error?.message ?? '未知錯誤')
        });
      }
    }

    log(logger, 'info', {
      component: 'inventory-dashboard',
      status: 'completed',
      movementSkus: movement?.skus ?? null,
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
      movementSkus: movement?.skus ?? null,
      syncStatus
    });
  } catch (error) {
    // 規格第 5 節：失敗時不覆寫看板，保留上一次的數值與最後成功時間。
    const message = safeSyncMessage(error?.message ?? '未知錯誤');
    let previous = null;
    // 只有「看板同步狀態」自己的表頭壞掉時才不可以寫它：按固定位置寫 A2:D2
    // 會把錯誤摘要塞進別的欄、順手清掉最後成功時間，補救動作變成第二次破壞。
    // 其他分頁（SKU主檔、預購額度、庫存看板）壞掉時，狀態列照寫——
    // 不然這一輪會留下「失敗了但狀態還是正常」，後面依狀態停推播的機制就瞎了。
    let statusSheetBroken = error instanceof SheetHeaderError
      && error.sheetName === SYNC_STATUS_SHEET_NAME;
    try {
      previous = await readDashboardSyncStatus({ sheets, spreadsheetId });
    } catch (readError) {
      if (readError instanceof SheetHeaderError) statusSheetBroken = true;
      // 連狀態都讀不到時，寧可讓「最後成功時間」空白，也不要謊報一個時間。
      log(logger, 'warn', {
        component: 'inventory-dashboard',
        status: 'sync-status-unreadable',
        error: safeSyncMessage(readError?.message ?? '未知錯誤')
      });
    }
    if (statusSheetBroken) {
      log(logger, 'error', {
        component: 'inventory-dashboard',
        status: 'sync-status-structure-broken',
        error: message
      });
      return Object.freeze({
        ok: false,
        error: message,
        lastSuccessAt: previous?.lastSuccessAt ?? '',
        syncStatus: null,
        statusSheetBroken: true
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
      syncStatus,
      statusSheetBroken: false
    });
  }
}
