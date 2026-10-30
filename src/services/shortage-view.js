// LIFF 缺貨清單的資料組裝。純函式，不讀不寫。
//
// 分組一律走 groupShortageRows，與 LINE 的文字回覆同一份邏輯（規格第 5 節）：
// 兩邊若各自分組，遲早會出現「訊息說 27 個、頁面列出 25 個」這種對不起來的情況。
import { groupShortageRows } from './inventory-dashboard.js';

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// 規格圖對得到實際規格，最能讓採購認出要補的是哪一個顏色／尺寸；
// 沒有才退到商品首圖，再退到列表圖。都沒有就回空字串，由前端顯示佔位方塊。
export function pickImageUrl(item) {
  return text(item?.variantImageUrl)
    || text(item?.mainImageUrl)
    || text(item?.listImageUrl);
}

// 圖片對照涵蓋所有貨號（含停用的），可補貨清單只有能下單的那些。兩份都要：
// 2026-10-30 的正式資料裡，28 筆要叫貨中有 7 筆在 SKU主檔 標記為不可補貨。
// 那些列照樣該出現在清單上（確實缺貨），但不能讓人勾選——submitRequest 會擋下來，
// 等送出才失敗比一開始就講清楚更糟。
export function buildCatalogIndex({ images = [], orderableSkus = [] } = {}) {
  const index = new Map();
  for (const image of images) {
    const sku = text(image?.sku);
    if (!sku || index.has(sku)) continue;
    index.set(sku, { imageUrl: pickImageUrl(image), unit: '件', stockMode: '', orderable: false });
  }
  for (const item of orderableSkus) {
    const sku = text(item?.sku);
    if (!sku) continue;
    const entry = index.get(sku) ?? { imageUrl: '', unit: '件', stockMode: '', orderable: false };
    entry.unit = text(item?.unit) || '件';
    // 出貨型態的單一真相是 SKU主檔 的 O 欄，由每小時同步從銷售商品名稱寫入。
    entry.stockMode = text(item?.stockMode);
    entry.orderable = true;
    if (!entry.imageUrl) entry.imageUrl = pickImageUrl(item);
    index.set(sku, entry);
  }
  return index;
}

function shortageItem(row, catalog) {
  const entry = catalog.get(row.sku);
  return Object.freeze({
    sku: row.sku,
    displayName: row.displayName || row.sku,
    imageUrl: entry?.imageUrl ?? '',
    unit: entry?.unit ?? '件',
    stockMode: entry?.stockMode ?? '',
    orderable: entry?.orderable === true,
    gap: row.gap,
    unshipped: row.unshipped,
    onOrder: row.onOrder,
    flyingmouseStock: row.flyingmouseStock,
    allowanceSource: row.allowanceSource,
    note: row.note
  });
}

export function buildShortageView({ dashboard, images = [], orderableSkus = [] }) {
  const { active, anomaly, quiet } = groupShortageRows(dashboard);
  const catalog = buildCatalogIndex({ images, orderableSkus });
  const rows = (list) => Object.freeze(list.map((row) => shortageItem(row, catalog)));
  const reorder = rows(active);
  return Object.freeze({
    updatedAt: text(dashboard?.rows?.[0]?.updatedAt),
    syncStatus: dashboard?.syncStatus ?? null,
    reorder,
    anomaly: rows(anomaly),
    quiet,
    // 前端用這個數字在頁首講清楚有幾筆不能直接下單。
    blockedCount: reorder.filter((item) => !item.orderable).length
  });
}
