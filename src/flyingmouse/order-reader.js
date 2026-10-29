// 讀取飛鼠「處理中」與「備貨中」訂單，換算出每個貨號賣掉還沒寄的數量。
// 只讀取，不寫入。查詢條件依 docs/inventory-dashboard-spec.md 第 7 節的實測結果，不可擅改。

export const ORDER_STATUS_PROCESSING = 0;
export const ORDER_STATUS_PREPARING = 2;
export const ORDER_PAGE_SIZE = 200;
export const MAX_REREADS = 2;

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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new FlyingMouseOrderError(`${label}必須是正整數`, { code: 'INVALID_ORDER' });
  }
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

function accumulate(target, orders, key) {
  for (const order of orders) {
    const orderNo = normalizeText(order?.no) || String(order?.id ?? '');
    for (const product of order?.products ?? []) {
      const partList = product?.part_list;
      // 折價列與沒有對應貨號的列不扣庫存。判斷依據是 part_list，不是 product_type。
      if (!Array.isArray(partList) || partList.length === 0) continue;
      const productQty = positiveInteger(product?.qty, `訂單 ${orderNo} 的購買數量`);
      for (const part of partList) {
        const partNo = normalizeText(part?.no);
        if (!partNo) {
          throw new FlyingMouseOrderError(`訂單 ${orderNo} 的 part_list 缺少貨號`, { code: 'INVALID_ORDER' });
        }
        const partQty = positiveInteger(part?.qty, `訂單 ${orderNo} 貨號 ${partNo} 的數量`);
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
      const result = await fetch(input.path, {
        method: input.method,
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const text = await result.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: result.status, body };
    }, { method: 'GET', path });
  } catch (error) {
    throw new FlyingMouseOrderError('飛鼠訂單 API 網路請求失敗', {
      code: 'NETWORK_ERROR',
      retryable: true,
      cause: error
    });
  }
  if (response.status < 200 || response.status >= 300) {
    // 不帶回應內容，避免把訂單或錯誤細節寫進日誌。
    throw new FlyingMouseOrderError(`飛鼠訂單查詢回應 ${response.status}`, {
      code: `HTTP_${response.status}`,
      retryable: response.status >= 500
    });
  }
  const data = response.body?.data;
  const total = Number(data?.total);
  if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(total) || total < 0) {
    throw new FlyingMouseOrderError('飛鼠訂單回應格式不正確', { code: 'INVALID_RESPONSE' });
  }
  return { total, list: data.list };
}

export function createFlyingMouseOrderClient(page) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('飛鼠頁面 session 不完整');
  return Object.freeze({
    async fetchOrdersByStatus(status) {
      const wanted = Number(status);
      const byId = new Map();
      let expectedTotal = null;
      let offset = 0;
      // 每頁至少要收下 1 筆才算有進展，再加上 2 次寬限，避免 offset 不前進時無限打 API。
      for (let round = 0; ; round += 1) {
        const { total, list } = await requestOrders(page, buildOrderQueryPath({
          status: wanted, offset, size: ORDER_PAGE_SIZE
        }));
        if (expectedTotal === null) expectedTotal = total;
        else if (total !== expectedTotal) {
          throw new FlyingMouseOrderError(
            `飛鼠訂單筆數在翻頁途中變動（${expectedTotal} → ${total}）`,
            { code: 'TOTAL_DRIFT', retryable: true }
          );
        }
        for (const order of list) {
          const id = positiveInteger(order?.id, '訂單 id');
          if (Number(order?.status) !== wanted) {
            throw new FlyingMouseOrderError(
              `訂單 ${normalizeText(order?.no) || id} 的狀態與查詢不符`,
              { code: 'STATUS_MISMATCH', retryable: true }
            );
          }
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
          throw new FlyingMouseOrderError('飛鼠訂單翻頁次數異常，已中止', { code: 'PAGINATION_STUCK' });
        }
        offset += ORDER_PAGE_SIZE;
      }
      // 以去重後的訂單數核對 total，光比對累計列數擋不掉重複頁。
      if (byId.size !== expectedTotal) {
        throw new FlyingMouseOrderError(
          `飛鼠訂單筆數不符：去重後 ${byId.size}，API total ${expectedTotal}`,
          { code: 'COUNT_MISMATCH', retryable: true }
        );
      }
      return [...byId.values()];
    }
  });
}

export async function readOpenOrderQuantities(client, { maxRereads = MAX_REREADS } = {}) {
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
