// 貨號汰換：把停用舊貨號上的需求折疊到重新上架後的新貨號。純函式，不讀不寫。
//
// 折疊在資料進入 buildInventoryDashboard 之前完成，計算本身完全不用改（規格第 4 節）。
// 對應一律人工填寫：款式名稱兩邊一致，但顏色（珍珠白→暖白色、胡桃色→胡桃木）
// 是商品個別的命名習慣，推導不出來。猜錯就是照著錯的顏色去叫貨，而且沒人會發現。
import { sumOutstandingBySku } from './inventory-dashboard.js';

export const RETIREMENT_STATUS = Object.freeze({
  APPLIED: '已套用',
  BLOCKED: '已擋下'
});

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function indexCatalogRows(catalog) {
  const index = new Map();
  for (const entry of catalog) {
    const sku = text(entry?.sku);
    if (sku) index.set(sku, entry);
  }
  return index;
}

// 只接受一層對應。鏈狀（A→B 且 B→C）會讓結果取決於套用順序，也可能成環，
// 寧可擋下讓人把表填清楚。
function blockedReason({ oldSku, newSku, catalogBySku, outstandingBySku, sources, targets }) {
  if (!oldSku || !newSku) return '舊貨號或新貨號空白';
  if (oldSku === newSku) return '舊貨號與新貨號相同';
  if (sources.get(oldSku) > 1) return '同一個舊貨號出現多次';
  if (sources.has(newSku)) return '新貨號本身也被汰換了，不接受鏈狀對應';
  if (targets.has(oldSku)) return '舊貨號同時是別條對應的新貨號，不接受鏈狀對應';

  const target = catalogBySku.get(newSku);
  if (!target) return '新貨號不在 SKU主檔';
  if (target.available === false) return '新貨號在 SKU主檔 是不可補貨';

  const source = catalogBySku.get(oldSku);
  // 舊貨號不在主檔是可以的：它可能已經被刪掉，需求仍留在訂單與銷量裡。
  if (source?.available === true) return '舊貨號在 SKU主檔 仍是可補貨，請確認是否填錯';
  if (source && Number(source.stock ?? 0) !== 0) {
    return `舊貨號的飛鼠庫存是 ${source.stock}，不為 0 不自動搬移`;
  }
  const outstanding = outstandingBySku.get(oldSku) ?? 0;
  if (outstanding > 0) return `舊貨號還有 ${outstanding} 件已叫貨未到，請先結清`;
  return '';
}

export function applySkuRetirement({
  retirements = [],
  catalog = [],
  orderQuantities = [],
  tracking = [],
  recentUnits = new Map()
} = {}) {
  const catalogBySku = indexCatalogRows(catalog);
  const outstandingBySku = sumOutstandingBySku(tracking);

  const sources = new Map();
  const targets = new Set();
  for (const entry of retirements) {
    const oldSku = text(entry?.oldSku);
    if (oldSku) sources.set(oldSku, (sources.get(oldSku) ?? 0) + 1);
    const newSku = text(entry?.newSku);
    if (newSku) targets.add(newSku);
  }

  const results = [];
  const applied = new Map();
  for (const entry of retirements) {
    const oldSku = text(entry?.oldSku);
    const newSku = text(entry?.newSku);
    const reason = blockedReason({
      oldSku, newSku, catalogBySku, outstandingBySku, sources, targets
    });
    if (reason) {
      results.push(Object.freeze({
        rowNumber: entry?.rowNumber ?? 0,
        oldSku,
        newSku,
        status: RETIREMENT_STATUS.BLOCKED,
        reason
      }));
      continue;
    }
    applied.set(oldSku, newSku);
    results.push(Object.freeze({
      rowNumber: entry?.rowNumber ?? 0,
      oldSku,
      newSku,
      status: RETIREMENT_STATUS.APPLIED,
      reason: ''
    }));
  }

  if (applied.size === 0) {
    return Object.freeze({
      catalog,
      orderQuantities,
      recentUnits,
      notes: new Map(),
      results: Object.freeze(results),
      applied: 0
    });
  }

  // 未寄：客戶在等的貨要從新貨號出，需求屬於新貨號。
  // 累計要記在「來源貨號」上而不是目標上：目標可能有多個來源（例如只差空白的
  // 孿生貨號），記在目標上會讓每一條備註都印出同一個累計值，讀起來對不起來。
  const movedUnshipped = new Map();
  const nextOrders = [];
  for (const entry of orderQuantities) {
    const sku = text(entry?.partNo);
    const target = applied.get(sku);
    if (!target) {
      nextOrders.push(entry);
      continue;
    }
    const units = Number(entry?.processing ?? 0) + Number(entry?.preparing ?? 0);
    if (units > 0) movedUnshipped.set(sku, (movedUnshipped.get(sku) ?? 0) + units);
    nextOrders.push({ ...entry, partNo: target });
  }

  // 近 30 天售出：同一件商品的銷量，每筆訂單只記在其中一個貨號下，相加不會重複計算。
  const movedUnits = new Map();
  const nextUnits = new Map();
  for (const [sku, units] of recentUnits) {
    const key = text(sku);
    const target = applied.get(key) ?? key;
    if (target !== key && units > 0) {
      movedUnits.set(key, (movedUnits.get(key) ?? 0) + Number(units ?? 0));
    }
    nextUnits.set(target, (nextUnits.get(target) ?? 0) + Number(units ?? 0));
  }

  // 舊貨號不列進看板：它不能補，留著只會讓人以為要處理它。
  const nextCatalog = catalog.filter((entry) => !applied.has(text(entry?.sku)));

  // 數字變大要說得出來自哪裡，否則沒人敢相信看板（規格第 7 節）。
  const notes = new Map();
  for (const [oldSku, newSku] of applied) {
    const parts = [];
    const unshipped = movedUnshipped.get(oldSku) ?? 0;
    const units = movedUnits.get(oldSku) ?? 0;
    if (unshipped > 0) parts.push(`未寄 ${unshipped} 件`);
    if (units > 0) parts.push(`近 30 天 ${units} 件`);
    if (parts.length === 0) continue;
    const note = `含已汰換 ${oldSku} 的${parts.join('、')}`;
    notes.set(newSku, notes.has(newSku) ? `${notes.get(newSku)}；${note}` : note);
  }

  return Object.freeze({
    catalog: nextCatalog,
    orderQuantities: nextOrders,
    recentUnits: nextUnits,
    notes,
    results: Object.freeze(results),
    applied: applied.size
  });
}
