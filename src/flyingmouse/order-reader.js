// 讀取飛鼠「處理中」與「備貨中」訂單，換算出每個貨號賣掉還沒寄的數量。
// 只讀取，不寫入。查詢條件依 docs/inventory-dashboard-spec.md 第 7 節的實測結果，不可擅改。

export const ORDER_STATUS_PROCESSING = 0;
export const ORDER_STATUS_PREPARING = 2;
export const ORDER_PAGE_SIZE = 200;
export const MAX_REREADS = 2;
export const ORDER_REQUEST_TIMEOUT_MS = 60_000;

// 動銷判定用：近 N 天內有訂單就算，不看件數（規格第 4.4 節，使用者決定）。
export const RECENT_ORDER_DAYS = 30;
// 取消與棄單不算「動過」。其餘（含待取消/退貨）都代表有人下過單。
const INACTIVE_ORDER_STATUSES = Object.freeze(new Set([4, 6]));

// 只取算量與查核需要的欄位；products / part_list 由 detail=1 帶出，不受 columns[] 影響。
const ORDER_COLUMNS = Object.freeze(['id', 'no', 'status']);

export class FlyingMouseOrderError extends Error {
  constructor(message, { code = 'ORDER_READ_ERROR', retryable = false } = {}) {
    super(message);
    this.name = 'FlyingMouseOrderError';
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 貨號只接受字串或數字。物件經 String() 會變成 '[object Object]'，看起來像合法貨號。
function partNumber(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new FlyingMouseOrderError(`${label}貨號型別不正確`, { code: 'INVALID_ORDER' });
  }
  const text = String(value).trim();
  if (!text) throw new FlyingMouseOrderError(`${label}缺少貨號`, { code: 'INVALID_ORDER' });
  return text;
}

// Number() 會把 null、''、false、[] 都變成 0，拿來驗證等於放行壞資料。
function strictInteger(value, label, { code = 'INVALID_ORDER' } = {}) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new FlyingMouseOrderError(`${label}必須是整數`, { code });
    }
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    if (!Number.isSafeInteger(number)) {
      throw new FlyingMouseOrderError(`${label}必須是整數`, { code });
    }
    return number;
  }
  throw new FlyingMouseOrderError(`${label}必須是整數`, { code });
}

function positiveInteger(value, label) {
  const number = strictInteger(value, `${label}數量`);
  if (number < 1) throw new FlyingMouseOrderError(`${label}數量必須是正整數`, { code: 'INVALID_ORDER' });
  return number;
}

export function buildOrderQueryPath({ status, offset, size }) {
  const parameters = [
    'detail=1',
    'equals[deleted]=0',
    `equals[status]=${encodeURIComponent(status)}`,
    ...ORDER_COLUMNS.map((column) => `columns[]=${encodeURIComponent(column)}`),
    `offset=${encodeURIComponent(offset)}`,
    `size=${encodeURIComponent(size)}`
  ];
  // 不送 pageCode（實測不生效），也不送 create_time 區間（會漏掉兩個月前的預購單）。
  return `/api/admin/order?${parameters.join('&')}`;
}

// 動銷查詢要帶日期、不帶狀態；跟上面那支「賣掉還沒寄」剛好相反，
// 理由見規格第 7.5 節：未寄訂單裡有舊預購單，帶日期會漏掉。
export function buildRecentOrderQueryPath({ since, offset, size }) {
  const sinceText = String(since ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(sinceText)) {
    throw new FlyingMouseOrderError('動銷查詢的起始時間格式不正確', { code: 'INVALID_RANGE' });
  }
  const parameters = [
    'detail=1',
    'equals[deleted]=0',
    `gtes[create_time]=${encodeURIComponent(sinceText)}`,
    ...ORDER_COLUMNS.map((column) => `columns[]=${encodeURIComponent(column)}`),
    'columns[]=create_time',
    `offset=${encodeURIComponent(offset)}`,
    `size=${encodeURIComponent(size)}`
  ];
  return `/api/admin/order?${parameters.join('&')}`;
}

export function recentOrderSince(now = new Date(), days = RECENT_ORDER_DAYS) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('動銷天數必須是正整數');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('動銷查詢時間不正確');
  // 先換算成台北的日曆日再往前推。用主機時區的話，UTC 主機在台北凌晨會算成前一天，
  // 整個查詢窗口偏掉一天（Dockerfile 沒有設 TZ，看板其他地方都明寫 Asia/Taipei）。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // 台灣沒有日光節約，所以在 UTC 上做日曆加減是安全的。
  const shifted = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day))
    - days * 86_400_000);
  const pad = (input) => String(input).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} 00:00:00`;
}

// 只收貨號，不算數量——判定是「有沒有訂單」，不是「賣了幾件」。
export function collectOrderedSkus(orders) {
  const skus = new Set();
  for (const order of orders) {
    const orderNo = normalizeText(order?.no) || String(order?.id ?? '');
    const status = strictInteger(order?.status, `訂單 ${orderNo} 的狀態`);
    if (INACTIVE_ORDER_STATUSES.has(status)) continue;
    if (!Array.isArray(order?.products)) {
      throw new FlyingMouseOrderError(`訂單 ${orderNo} 缺少 products 明細`, { code: 'INVALID_ORDER' });
    }
    for (const product of order.products) {
      if (!isPlainObject(product)) {
        throw new FlyingMouseOrderError(`訂單 ${orderNo} 的商品列格式不正確`, { code: 'INVALID_ORDER' });
      }
      const partList = product.part_list;
      if (partList === undefined || partList === null) continue;
      if (!Array.isArray(partList)) {
        throw new FlyingMouseOrderError(`訂單 ${orderNo} 的 part_list 型別不正確`, { code: 'INVALID_ORDER' });
      }
      for (const part of partList) {
        if (!isPlainObject(part)) {
          throw new FlyingMouseOrderError(`訂單 ${orderNo} 的 part_list 元素格式不正確`, {
            code: 'INVALID_ORDER'
          });
        }
        skus.add(partNumber(part.no, `訂單 ${orderNo} 的 part_list `));
      }
    }
  }
  return skus;
}

function accumulate(target, orders, key) {
  for (const order of orders) {
    const orderNo = normalizeText(order?.no) || String(order?.id ?? '');
    // 明細缺失不等於沒有未寄商品，必須丟錯讓呼叫端保留上一次看板。
    if (!Array.isArray(order?.products)) {
      throw new FlyingMouseOrderError(`訂單 ${orderNo} 缺少 products 明細`, { code: 'INVALID_ORDER' });
    }
    for (const product of order.products) {
      if (!isPlainObject(product)) {
        throw new FlyingMouseOrderError(`訂單 ${orderNo} 的商品列格式不正確`, { code: 'INVALID_ORDER' });
      }
      const partList = product.part_list;
      // 折價列與沒有對應貨號的列不扣庫存。判斷依據是 part_list，不是 product_type。
      if (partList === undefined || partList === null) continue;
      if (!Array.isArray(partList)) {
        throw new FlyingMouseOrderError(`訂單 ${orderNo} 的 part_list 型別不正確`, { code: 'INVALID_ORDER' });
      }
      if (partList.length === 0) continue;
      const productQty = positiveInteger(product.qty, `訂單 ${orderNo} 的購買`);
      for (const part of partList) {
        if (!isPlainObject(part)) {
          throw new FlyingMouseOrderError(`訂單 ${orderNo} 的 part_list 元素格式不正確，無法取得貨號`, {
            code: 'INVALID_ORDER'
          });
        }
        const partNo = partNumber(part.no, `訂單 ${orderNo} 的 part_list `);
        const partQty = positiveInteger(part.qty, `訂單 ${orderNo} 貨號 ${partNo} 的`);
        if (!target.has(partNo)) target.set(partNo, { processing: 0, preparing: 0 });
        // part_list[].qty 是每 1 件的用量，要乘上購買數量。
        target.get(partNo)[key] += productQty * partQty;
      }
    }
  }
}

export function aggregateOrderQuantities({ processing = [], preparing = [] } = {}) {
  const byPart = new Map();
  accumulate(byPart, processing, 'processing');
  accumulate(byPart, preparing, 'preparing');
  return [...byPart.entries()]
    .map(([partNo, counts]) => ({
      partNo,
      processing: counts.processing,
      preparing: counts.preparing,
      total: counts.processing + counts.preparing
    }))
    .sort((left, right) => left.partNo.localeCompare(right.partNo));
}

async function requestOrders(page, path) {
  let response;
  try {
    response = await page.evaluate(async (input) => {
      // page.evaluate 本身沒有逾時，回應遲遲不結束的話會永遠卡住整個排程。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const result = await fetch(input.path, {
          method: input.method,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal
        });
        // signal 也涵蓋讀取 body，所以慢速回應一樣會被中止。
        const text = await result.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        return { status: result.status, body };
      } catch (error) {
        return { aborted: error?.name === 'AbortError' };
      } finally {
        clearTimeout(timer);
      }
    }, { method: 'GET', path, timeoutMs: ORDER_REQUEST_TIMEOUT_MS });
  } catch (error) {
    throw new FlyingMouseOrderError('飛鼠訂單 API 網路請求失敗', {
      code: 'NETWORK_ERROR',
      retryable: true,
      cause: error
    });
  }
  if (response?.aborted) {
    throw new FlyingMouseOrderError(`飛鼠訂單查詢超過 ${ORDER_REQUEST_TIMEOUT_MS} 毫秒未完成`, {
      code: 'TIMEOUT',
      retryable: true
    });
  }
  if (!Number.isSafeInteger(response?.status)) {
    throw new FlyingMouseOrderError('飛鼠訂單請求未回傳狀態碼', { code: 'NETWORK_ERROR', retryable: true });
  }
  if (response.status < 200 || response.status >= 300) {
    // 不帶回應內容，避免把訂單或錯誤細節寫進日誌。
    throw new FlyingMouseOrderError(`飛鼠訂單查詢回應 ${response.status}`, {
      code: `HTTP_${response.status}`,
      retryable: response.status >= 500
    });
  }
  const data = response.body?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.list)) {
    throw new FlyingMouseOrderError('飛鼠訂單回應格式不正確', { code: 'INVALID_RESPONSE' });
  }
  const total = strictInteger(data.total, '飛鼠訂單 total', { code: 'INVALID_RESPONSE' });
  if (total < 0) throw new FlyingMouseOrderError('飛鼠訂單 total 不可為負', { code: 'INVALID_RESPONSE' });
  return { total, list: data.list };
}

// 翻頁與完整性檢查兩支查詢共用：每頁 total 要一致、訂單 id 不可重複、
// 去重後筆數要等於 total（光比對累計列數擋不掉重複頁），還要有迴圈上限。
async function paginateOrders(page, { buildPath, checkOrder, label }) {
  const byId = new Map();
  let expectedTotal = null;
  let offset = 0;
  for (let round = 0; ; round += 1) {
    const { total, list } = await requestOrders(page, buildPath(offset));
    if (expectedTotal === null) expectedTotal = total;
    else if (total !== expectedTotal) {
      throw new FlyingMouseOrderError(
        `${label}筆數在翻頁途中變動（${expectedTotal} → ${total}）`,
        { code: 'TOTAL_DRIFT', retryable: true }
      );
    }
    for (const order of list) {
      const id = positiveInteger(order?.id, '訂單 id 的');
      checkOrder?.(order, id);
      if (byId.has(id)) {
        throw new FlyingMouseOrderError(`飛鼠訂單 ${id} 在翻頁中重複出現`, {
          code: 'DUPLICATE_ORDER',
          retryable: true
        });
      }
      byId.set(id, order);
    }
    if (byId.size >= expectedTotal || list.length === 0) break;
    if (round > Math.ceil(expectedTotal / ORDER_PAGE_SIZE) + 2) {
      throw new FlyingMouseOrderError(`${label}翻頁次數異常，已中止`, { code: 'PAGINATION_STUCK' });
    }
    offset += ORDER_PAGE_SIZE;
  }
  if (byId.size !== expectedTotal) {
    throw new FlyingMouseOrderError(
      `${label}筆數不符：去重後 ${byId.size}，API total ${expectedTotal}`,
      { code: 'COUNT_MISMATCH', retryable: true }
    );
  }
  return [...byId.values()];
}

export function createFlyingMouseOrderClient(page) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('飛鼠頁面 session 不完整');
  return Object.freeze({
    async fetchOrdersByStatus(status) {
      const wanted = Number(status);
      return paginateOrders(page, {
        label: '飛鼠訂單',
        buildPath: (offset) => buildOrderQueryPath({ status: wanted, offset, size: ORDER_PAGE_SIZE }),
        checkOrder: (order, id) => {
          if (strictInteger(order?.status, `訂單 ${normalizeText(order?.no) || id} 的狀態`) !== wanted) {
            throw new FlyingMouseOrderError(
              `訂單 ${normalizeText(order?.no) || id} 的狀態與查詢不符`,
              { code: 'STATUS_MISMATCH', retryable: true }
            );
          }
        }
      });
    },
    async fetchOrdersSince(since) {
      return paginateOrders(page, {
        label: '飛鼠近期訂單',
        buildPath: (offset) => buildRecentOrderQueryPath({ since, offset, size: ORDER_PAGE_SIZE })
      });
    }
  });
}

export async function readOpenOrderQuantities(client, { maxRereads = MAX_REREADS, logger = null } = {}) {
  if (!client || typeof client.fetchOrdersByStatus !== 'function') {
    throw new Error('飛鼠訂單客戶端不完整');
  }
  let lastError = null;
  for (let attempt = 0; attempt <= maxRereads; attempt += 1) {
    try {
      // 先查處理中、再查備貨中；兩次查詢之間訂單可能轉狀態，由下面去重處理。
      const processing = await client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING);
      const preparing = await client.fetchOrdersByStatus(ORDER_STATUS_PREPARING);

      const preparingIds = new Set(preparing.map((order) => Number(order.id)));
      const driftedOrderIds = processing
        .map((order) => Number(order.id))
        .filter((id) => preparingIds.has(id));
      const settledProcessing = processing.filter((order) => !preparingIds.has(Number(order.id)));
      if (driftedOrderIds.length > 0 && typeof logger?.warn === 'function') {
        // 整批記一次，不是每筆一次。
        logger.warn(
          `飛鼠訂單在查詢途中由處理中轉為備貨中，已以備貨中為準去重：${driftedOrderIds.join(', ')}`
        );
      }

      return {
        parts: aggregateOrderQuantities({ processing: settledProcessing, preparing }),
        orderCounts: { processing: settledProcessing.length, preparing: preparing.length },
        driftedOrderIds
      };
    } catch (error) {
      // 資料在動造成的不一致才重讀；資料本身壞掉（例如貨號空白）重讀也沒用。
      if (!error?.retryable || attempt === maxRereads) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// 回傳近 N 天內有訂單的貨號集合。判定只看「有沒有」，不看件數（規格第 4.4 節）。
export async function readRecentlyOrderedSkus(client, {
  now = new Date(),
  days = RECENT_ORDER_DAYS,
  maxRereads = MAX_REREADS,
  logger = null
} = {}) {
  if (!client || typeof client.fetchOrdersSince !== 'function') {
    throw new Error('飛鼠訂單客戶端不完整');
  }
  const since = recentOrderSince(now, days);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRereads; attempt += 1) {
    try {
      const orders = await client.fetchOrdersSince(since);
      const skus = collectOrderedSkus(orders);
      if (typeof logger?.info === 'function') {
        logger.info({
          component: 'inventory-dashboard',
          status: 'recent-orders',
          since,
          orders: orders.length,
          skus: skus.size
        });
      }
      return { since, skus, orderCount: orders.length };
    } catch (error) {
      if (!error?.retryable || attempt === maxRereads) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
