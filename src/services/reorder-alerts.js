// 叫貨提醒要推給誰：純決策，不讀不寫也不送訊息。
// 規則依 docs/inventory-dashboard-spec.md 第 4.4 節與 docs/inventory-dashboard-plan.md 步驟 6。

export const ALERT_SKIP_REASONS = Object.freeze({
  NOT_REORDERABLE: 'not-reorderable',
  NOT_RECENTLY_ORDERED: 'not-recently-ordered',
  ALREADY_ALERTED: 'already-alerted'
});

const REORDER_STATUS = '要叫貨';

function text(value) {
  return String(value ?? '').trim();
}

export function taipeiDateKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('提醒時間不正確');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

// 「同一天只提醒一次，除非缺口又變大」。
// 把缺口放進去重鍵是錯的：10 → 5 會產生新鍵而再推一次，正好跟規則相反。
// 這裡比的是大小，不是鍵存不存在。
function shouldAlert(gap, baseline, today) {
  if (!baseline || baseline.date !== today) return { alert: true, previousGap: null };
  // 基準壞掉（非整數）時當成今天還沒推過：寧可多推一次，不要漏推。
  if (!Number.isSafeInteger(baseline.gap)) return { alert: true, previousGap: null };
  if (gap > baseline.gap) return { alert: true, previousGap: baseline.gap };
  return { alert: false, previousGap: baseline.gap };
}

export function decideReorderAlerts({
  rows = [],
  recentlyOrderedSkus = null,
  baselines = new Map(),
  today
} = {}) {
  const day = text(today);
  if (!day) throw new Error('叫貨提醒缺少日期');
  const alerts = [];
  const skipped = {
    [ALERT_SKIP_REASONS.NOT_REORDERABLE]: 0,
    [ALERT_SKIP_REASONS.NOT_RECENTLY_ORDERED]: 0,
    [ALERT_SKIP_REASONS.ALREADY_ALERTED]: 0
  };

  for (const row of rows) {
    const sku = text(row?.sku);
    if (!sku) continue;
    // 只推「要叫貨」。異常（查無貨號、規格修正失效、推算實際為負）的缺口
    // 雖然是正的，但要人先確認，不可以自動催叫貨。回寫未完成的缺口是 null。
    if (row.status !== REORDER_STATUS || !Number.isSafeInteger(row.gap) || row.gap <= 0) {
      skipped[ALERT_SKIP_REASONS.NOT_REORDERABLE] += 1;
      continue;
    }
    // 動銷篩選（使用者決定，規格第 4.4 節）。
    // recentlyOrderedSkus 為 null 代表這一輪查不到動銷清單——這時候照舊推播，
    // 不可以因為篩不出來就整批停推（計畫步驟 6 明寫）。
    if (recentlyOrderedSkus && !recentlyOrderedSkus.has(sku)) {
      skipped[ALERT_SKIP_REASONS.NOT_RECENTLY_ORDERED] += 1;
      continue;
    }
    const { alert, previousGap } = shouldAlert(row.gap, baselines.get(sku), day);
    if (!alert) {
      skipped[ALERT_SKIP_REASONS.ALREADY_ALERTED] += 1;
      continue;
    }
    alerts.push(Object.freeze({
      sku,
      displayName: text(row.displayName),
      gap: row.gap,
      unshipped: row.unshipped,
      onOrder: row.onOrder,
      flyingmouseStock: row.flyingmouseStock,
      previousGap
    }));
  }

  alerts.sort((left, right) => right.gap - left.gap || left.sku.localeCompare(right.sku));
  return Object.freeze({ alerts, skipped, today: day, filtered: Boolean(recentlyOrderedSkus) });
}
