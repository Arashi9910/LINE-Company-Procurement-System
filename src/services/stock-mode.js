// 從商品名稱判斷這支商品手上有沒有實體庫存。純函式，不讀不寫。
//
// 飛鼠只有一個庫存欄，開預購時那個數字會被灌大，所以它其實是
// 「真的有的 + 預購放出去的」。要把兩者拆開，就得知道這支是哪一種，
// 而唯一的線索是商品名稱前面的標籤（使用者 2026-10-30 說明的實際作法）：
//
//   「預購、預售的商品，若沒改成現貨、隔日到貨，基本上就是完全沒現實庫存」
//
// 所以 現貨／台灣現貨／現貨秒發／隔日到貨 = 有實體；預購／預售 = 沒有實體。
// 使用者也說了「不敢保證 100% 都是正確的」，所以這只是**預設值**：
// 「預購額度」分頁填了哪一列，那一列就贏。

export const STOCK_MODE = Object.freeze({
  // 手上有貨：飛鼠的數字就是真實可賣量，不用拆。
  PHYSICAL: 'physical',
  // 純預購：手上沒貨，飛鼠的數字整個是放出去的額度。
  PREORDER: 'preorder',
  // 看不出來（混合、沒有標籤）：當成有實體處理，比較保守——
  // 猜成預購會讓缺口等於未寄量，可能叫到已經有的貨。
  UNKNOWN: 'unknown'
});

// 只看名稱開頭這一段，後面的商品描述裡常常也會出現「現貨」「預購」這些字。
const LABEL_WINDOW = 16;

// 「現貨+預售」「現貨＋預購」等四種拼法都是混合，要先比對，
// 否則會被後面的「現貨」規則先吃掉而誤判成純現貨。
const MIXED = /現貨\s*[+＋]\s*預[售購]/;
const PHYSICAL = /現貨秒發|台灣現貨|隔日到貨|現貨/;
const PREORDER = /預售|預購/;

export function classifyStockMode(displayName) {
  const head = String(displayName ?? '').slice(0, LABEL_WINDOW);
  if (MIXED.test(head)) return STOCK_MODE.UNKNOWN;
  if (PHYSICAL.test(head)) return STOCK_MODE.PHYSICAL;
  if (PREORDER.test(head)) return STOCK_MODE.PREORDER;
  return STOCK_MODE.UNKNOWN;
}

// 寫進試算表給人看的標籤。採購掃一眼就知道，不用從 40 字的標題裡找前綴。
export const STOCK_MODE_LABEL = Object.freeze({
  [STOCK_MODE.PHYSICAL]: '現貨',
  [STOCK_MODE.PREORDER]: '預購',
  [STOCK_MODE.UNKNOWN]: '未知'
});

export function stockModeLabel(displayName) {
  return STOCK_MODE_LABEL[classifyStockMode(displayName)];
}

const MODE_BY_LABEL = new Map(Object.entries(STOCK_MODE_LABEL).map(([mode, label]) => [label, mode]));

// 讀回試算表上的「出貨型態」。欄位還沒被同步填過（剛遷移完）時回 null，
// 由呼叫端決定要不要退回用名稱推導。
export function stockModeFromLabel(label) {
  return MODE_BY_LABEL.get(String(label ?? '').trim()) ?? null;
}

export const DEFAULT_COVER_DAYS = 14;
const VELOCITY_WINDOW_DAYS = 30;

// 有實體的商品靠安全庫存觸發叫貨：賣得快就多留，賣得慢就少留，
// 完全不動的就不留（使用者：「賣很慢或很差，也沒必要去採購」）。
export function safetyStockFromVelocity(recentUnits, coverDays = DEFAULT_COVER_DAYS) {
  if (!Number.isSafeInteger(recentUnits) || recentUnits < 0) {
    throw new Error('近 30 天售出件數必須是非負整數');
  }
  if (!Number.isSafeInteger(coverDays) || coverDays < 0) {
    throw new Error('覆蓋天數必須是非負整數');
  }
  if (recentUnits === 0 || coverDays === 0) return 0;
  return Math.ceil((recentUnits * coverDays) / VELOCITY_WINDOW_DAYS);
}
