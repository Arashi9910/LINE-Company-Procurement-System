// 庫存看板的純計算：只吃資料、只吐結果，不讀也不寫任何資料來源。
// 公式與欄位依 docs/inventory-dashboard-spec.md 第 3、4.1、5 節。
import { DEFAULT_COVER_DAYS, STOCK_MODE, safetyStockFromVelocity } from './stock-mode.js';

// 預購額度與安全庫存從哪裡來。看板上會標明，否則人看到數字不知道是誰填的。
export const ALLOWANCE_SOURCE = Object.freeze({
  MANUAL: '人工填寫',
  PREORDER: '名稱推導：預購',
  PHYSICAL: '名稱推導：現貨'
});

export const DASHBOARD_STATUS = Object.freeze({
  REORDER: '要叫貨',
  ANOMALY: '異常',
  WRITEBACK_PENDING: '回寫未完成',
  NORMAL: '正常'
});

// 規格第 2 節：只有這兩個狀態算「已叫貨未到」。
const OUTSTANDING_STATUSES = Object.freeze(new Set(['已下單', '部分到貨']));

// 排序優先度（規格第 4.1 節）：要叫貨最前、接著異常，正常最後。
// 回寫未完成是缺口被壓下來的狀態，排在異常之後、正常之前。
const STATUS_ORDER = Object.freeze({
  [DASHBOARD_STATUS.REORDER]: 0,
  [DASHBOARD_STATUS.ANOMALY]: 1,
  [DASHBOARD_STATUS.WRITEBACK_PENDING]: 2,
  [DASHBOARD_STATUS.NORMAL]: 3
});

function text(value) {
  return String(value ?? '').trim();
}

// Number() 會把 null、''、false、[] 都變成 0，拿來驗證等於放行壞資料。
function integer(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label}必須是整數`);
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    if (!Number.isSafeInteger(number)) throw new Error(`${label}必須是整數`);
    return number;
  }
  throw new Error(`${label}必須是整數`);
}

function nonNegativeInteger(value, label) {
  const number = integer(value, label);
  if (number < 0) throw new Error(`${label}不可為負`);
  return number;
}

// 試算表的空白儲存格代表「沒填」，當 0 處理；但 null 以外的垃圾值仍要擋下來。
function optionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string' && value.trim() === '') return 0;
  return nonNegativeInteger(value, label);
}

function requireSku(value, label) {
  const sku = text(value);
  if (!sku) throw new Error(`${label}不可空白`);
  return sku;
}

// 規格修正的驗證歸 src/sheets/order-spec-correction.js，不在這裡重做。
// 那邊的 resolveOrderSpecCorrection 對「合法且已生效」的修正，會直接把 item.sku
// 換成修正後 SKU（order-spec-correction.js:112），錯誤時則保留原 SKU 並填
// skuCorrectionError。所以這裡一律以 item.sku 為準。
//
// 完整驗證需要 SKU主檔的「是否可補貨」與商品名稱（判斷是否同一商品），
// 本模組的 catalog 只有庫存與顯示名稱，無法自行判定。因此看到還沒被解析掉的
// correctionSku 時，不猜它合不合法，直接當成未驗證並標異常。
export function describeCorrectionIssue(item) {
  const upstream = text(item?.skuCorrectionError);
  if (upstream) return upstream;
  const sku = text(item?.sku);
  const correctionSku = text(item?.correctionSku);
  if (!correctionSku || correctionSku === sku) return '';
  return '補貨追蹤帶有尚未驗證的規格修正，請改用 repository 解析後的資料';
}

export function resolveTrackingSku(item) {
  // 規格第 2 節的「貨號優先用修正後規格」已由上游解析完成，item.sku 就是生效的貨號。
  const sku = text(item?.sku);
  if (!text(item?.skuCorrectionError)) return sku;
  // flagDuplicateEffectiveSkus 是在 resolveOrderSpecCorrection 換過 sku 之後才標錯誤的，
  // 所以「尚未套用的修正」失敗時 sku 已經是修正後的值，但貨還是會以原 SKU 進來。
  // 已經套用過的修正（skuCorrectionPending 為 false）不可退回歷史 SKU。
  if (item?.skuCorrectionPending !== true) return sku;
  const original = text(item?.skuCorrectionOriginalSku);
  return original || sku;
}

export function collectCorrectionIssues(tracking = []) {
  const issues = new Map();
  for (const item of tracking) {
    if (!OUTSTANDING_STATUSES.has(text(item?.status))) continue;
    const issue = describeCorrectionIssue(item);
    if (!issue) continue;
    // 未到量算到哪個 SKU，異常就標在哪個 SKU，兩者不可分家。
    const effective = resolveTrackingSku(item);
    // 備註要講實際歸屬，不可一律宣稱算回原 SKU：已套用的修正是留在現行 SKU 的。
    const note = effective ? `${issue}，未到量算在 ${effective}` : issue;
    for (const sku of new Set([effective, text(item?.sku)])) {
      if (sku && !issues.has(sku)) issues.set(sku, note);
    }
  }
  return issues;
}

export function sumOutstandingBySku(tracking = []) {
  const sums = new Map();
  for (const item of tracking) {
    if (!OUTSTANDING_STATUSES.has(text(item?.status))) continue;
    const sku = requireSku(resolveTrackingSku(item), '補貨追蹤的貨號');
    const ordered = optionalNonNegativeInteger(item?.orderedQuantity, `補貨追蹤 ${sku} 的下單量`);
    const received = optionalNonNegativeInteger(item?.receivedQuantity, `補貨追蹤 ${sku} 的到貨量`);
    // 規格第 2 節明定用下單量減到貨量，不吃現成的未到量欄位（可能是公式或過期值）。
    const outstanding = Math.max(0, ordered - received);
    if (outstanding === 0) continue;
    sums.set(sku, (sums.get(sku) ?? 0) + outstanding);
  }
  return sums;
}

function indexCatalog(catalog) {
  const bySku = new Map();
  for (const entry of catalog) {
    const sku = requireSku(entry?.sku, 'SKU主檔的 SKU');
    if (bySku.has(sku)) throw new Error(`SKU主檔的 SKU 重複：${sku}`);
    bySku.set(sku, {
      displayName: text(entry?.displayName),
      // 空白代表同步沒跑完，不可當成 0，否則會憑空算出缺口去叫貨。
      stock: integer(entry?.stock, `SKU主檔 ${sku} 的庫存快照`)
    });
  }
  return bySku;
}

function indexPreorders(preorders) {
  const bySku = new Map();
  for (const entry of preorders) {
    const sku = requireSku(entry?.sku, '預購額度的 SKU');
    if (bySku.has(sku)) throw new Error(`預購額度的 SKU 重複：${sku}`);
    bySku.set(sku, {
      // 規格第 2 節：安全庫存可以不填，預設 0。
      preorderAllowance: optionalNonNegativeInteger(entry?.preorderAllowance, `預購額度 ${sku} 的預購額度`),
      safetyStock: optionalNonNegativeInteger(entry?.safetyStock, `預購額度 ${sku} 的安全庫存`)
    });
  }
  return bySku;
}

function indexOrders(orderQuantities) {
  const bySku = new Map();
  for (const entry of orderQuantities) {
    const sku = requireSku(entry?.partNo, '訂單統計的貨號');
    const processing = optionalNonNegativeInteger(entry?.processing, `訂單統計 ${sku} 的處理中數量`);
    const preparing = optionalNonNegativeInteger(entry?.preparing, `訂單統計 ${sku} 的備貨中數量`);
    const previous = bySku.get(sku) ?? { processing: 0, preparing: 0 };
    // 共用貨號在上游已彙總；這裡再合併一次，確保同一貨號只會有一列。
    bySku.set(sku, {
      processing: previous.processing + processing,
      preparing: previous.preparing + preparing
    });
  }
  return bySku;
}

// 「預購額度」分頁填了就以它為準；沒填才用名稱推導。
// 使用者說名稱不保證 100% 正確，所以人工永遠贏過推導。
function resolveAllowance({ override, mode, flyingmouseStock, unshipped, units, coverDays }) {
  if (override) {
    return {
      preorderAllowance: override.preorderAllowance,
      safetyStock: override.safetyStock,
      allowanceSource: ALLOWANCE_SOURCE.MANUAL
    };
  }
  if (mode === STOCK_MODE.PREORDER) {
    // 手上沒有實體：飛鼠那個數字整個是放出去的額度，推算實際因此恆為 0，
    // 缺口收斂成「未寄 + 安全庫存 − 已叫貨未到」＝我欠客戶幾件還沒去訂。
    return {
      preorderAllowance: flyingmouseStock + unshipped,
      safetyStock: 0,
      allowanceSource: ALLOWANCE_SOURCE.PREORDER
    };
  }
  // 有實體（或看不出來）：飛鼠的數字就是真實可賣量，靠安全庫存觸發叫貨。
  return {
    preorderAllowance: 0,
    safetyStock: safetyStockFromVelocity(units, coverDays),
    allowanceSource: ALLOWANCE_SOURCE.PHYSICAL
  };
}

function decide({ known, writebackPending, correctionIssue, estimatedStock, gap }) {
  if (writebackPending) {
    return { status: DASHBOARD_STATUS.WRITEBACK_PENDING, note: '回寫尚未完成，暫不計算缺口' };
  }
  if (!known) {
    return { status: DASHBOARD_STATUS.ANOMALY, note: '這個貨號不在 SKU主檔，請人工確認' };
  }
  if (correctionIssue) {
    return { status: DASHBOARD_STATUS.ANOMALY, note: `規格修正不會生效：${correctionIssue}` };
  }
  if (estimatedStock < 0) {
    return {
      status: DASHBOARD_STATUS.ANOMALY,
      note: '推算實際庫存為負，通常是預購額度填錯或飛鼠庫存被手動改過，請人工檢查'
    };
  }
  if (gap > 0) return { status: DASHBOARD_STATUS.REORDER, note: '' };
  return { status: DASHBOARD_STATUS.NORMAL, note: '' };
}

export function buildInventoryDashboard({
  catalog = [],
  orderQuantities = [],
  tracking = [],
  preorders = [],
  writebackPendingSkus = [],
  // 從商品名稱推導出來的「有沒有實體庫存」，以及近 30 天售出件數。
  // 沒給就全部當 unknown、件數 0，行為跟以前一樣（額度與安全庫存都是 0）。
  stockModes = new Map(),
  recentUnits = new Map(),
  coverDays = DEFAULT_COVER_DAYS,
  updatedAt = ''
} = {}) {
  const catalogBySku = indexCatalog(catalog);
  const preorderBySku = indexPreorders(preorders);
  const orderBySku = indexOrders(orderQuantities);
  const outstandingBySku = sumOutstandingBySku(tracking);
  const correctionIssues = collectCorrectionIssues(tracking);
  const pendingSkus = new Set(writebackPendingSkus.map((sku) => requireSku(sku, '回寫未完成的 SKU')));

  // 規格第 4.1 節：只列有庫存、有訂單、有叫貨中，或有填預購額度的 SKU。
  // 訂單或補貨追蹤帶進來、但主檔沒有的貨號也要列出來，才不會默默吃掉數量。
  const candidates = new Set([
    ...[...catalogBySku].filter(([, entry]) => entry.stock !== 0).map(([sku]) => sku),
    ...orderBySku.keys(),
    ...outstandingBySku.keys(),
    ...preorderBySku.keys(),
    ...correctionIssues.keys(),
    // 到貨已登記、追蹤已結案，但回寫還沒跑完的 SKU 可能四項都沒有，
    // 仍要列出來才看得到「回寫未完成」。
    ...pendingSkus
  ]);

  const rows = [...candidates].map((sku) => {
    const known = catalogBySku.has(sku);
    const catalogEntry = catalogBySku.get(sku);
    const orders = orderBySku.get(sku) ?? { processing: 0, preparing: 0 };

    const flyingmouseStock = catalogEntry?.stock ?? 0;
    const unshipped = orders.processing + orders.preparing;
    const onOrder = outstandingBySku.get(sku) ?? 0;
    const { preorderAllowance, safetyStock, allowanceSource } = resolveAllowance({
      override: preorderBySku.get(sku),
      mode: stockModes.get(sku),
      flyingmouseStock,
      unshipped,
      units: recentUnits.get(sku) ?? 0,
      coverDays
    });

    // 規格第 3 節。
    const estimatedStock = flyingmouseStock + unshipped - preorderAllowance;
    const gap = preorderAllowance + safetyStock - flyingmouseStock - onOrder;

    const writebackPending = pendingSkus.has(sku);
    const correctionIssue = correctionIssues.get(sku) ?? '';
    const { status, note } = decide({ known, writebackPending, correctionIssue, estimatedStock, gap });
    const publishable = status !== DASHBOARD_STATUS.WRITEBACK_PENDING;

    // 規格第 3 節最後一列：還有單沒寄而實際不夠時，現在不能關閉預購。
    // 只對人工填的額度有意義——額度是從名稱推導出來的話，推算實際恆為 0，
    // 這個數字就永遠等於未寄量，跟缺口講同一件事，變成每一列都掛一句廢話。
    const closeShortfall = publishable
      && preorderAllowance > 0
      && allowanceSource === ALLOWANCE_SOURCE.MANUAL
      ? Math.max(0, unshipped - estimatedStock)
      : null;
    const notes = [note];
    // 數字不可發布時，備註也不能帶出來，否則等於把壓下來的缺貨量又publish 一次。
    if (publishable && closeShortfall > 0) {
      notes.push(`目前不能關閉預購，還差 ${closeShortfall} 個`);
    }

    return {
      sku,
      displayName: catalogEntry?.displayName ?? '',
      flyingmouseStock,
      processing: orders.processing,
      preparing: orders.preparing,
      unshipped,
      onOrder,
      preorderAllowance,
      safetyStock,
      allowanceSource,
      estimatedStock: publishable ? estimatedStock : null,
      gap: publishable ? gap : null,
      status,
      // 只有主檔有資料、回寫也跑完的要叫貨列，才可以拿去推播叫貨提醒。
      reorderable: status === DASHBOARD_STATUS.REORDER,
      preorderCloseShortfall: closeShortfall,
      note: notes.filter(Boolean).join('；'),
      updatedAt
    };
  });

  rows.sort((left, right) => {
    const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (byStatus !== 0) return byStatus;
    // 同一類裡缺口大的排前面；缺口被壓下來的列一律靠後。
    const byGap = (right.gap ?? Number.NEGATIVE_INFINITY) - (left.gap ?? Number.NEGATIVE_INFINITY);
    if (Number.isFinite(byGap) && byGap !== 0) return byGap;
    return left.sku.localeCompare(right.sku);
  });

  return { rows, updatedAt };
}
