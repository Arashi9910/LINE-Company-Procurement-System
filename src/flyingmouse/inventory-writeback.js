const PART_UPDATE_FIELDS = Object.freeze([
  'id',
  'no',
  'mpn',
  'name',
  'spec_y',
  'spec_x',
  'gtin',
  'storage_location',
  'stock',
  'op_remark'
]);

export class FlyingMouseWritebackError extends Error {
  constructor(message, { code = 'WRITEBACK_ERROR', retryable = false, manualReview = false } = {}) {
    super(message);
    this.name = 'FlyingMouseWritebackError';
    this.code = code;
    this.retryable = retryable;
    this.manualReview = manualReview;
  }
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function safeNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new FlyingMouseWritebackError(`${label}必須是非負整數且在安全範圍內`, {
      code: 'INVALID_PART',
      manualReview: true
    });
  }
  return number;
}

function optionalString(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new FlyingMouseWritebackError(`${label}欄位型別已改變`, {
      code: 'INVALID_PART',
      manualReview: true
    });
  }
  return value;
}

function normalizePart(raw, expectedSku) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FlyingMouseWritebackError('飛鼠貨品資料格式不正確', {
      code: 'INVALID_PART',
      manualReview: true
    });
  }
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new FlyingMouseWritebackError('飛鼠貨品 ID 不正確', {
      code: 'INVALID_PART',
      manualReview: true
    });
  }
  const no = normalizeText(raw.no);
  if (!no || no !== normalizeText(expectedSku)) {
    throw new FlyingMouseWritebackError('飛鼠查詢結果與目標 SKU 不一致', {
      code: 'SKU_MISMATCH',
      manualReview: true
    });
  }
  const name = optionalString(raw.name, 'name');
  if (!normalizeText(name)) {
    throw new FlyingMouseWritebackError('飛鼠貨品缺少名稱', {
      code: 'INVALID_PART',
      manualReview: true
    });
  }
  return Object.freeze({
    id,
    no,
    mpn: optionalString(raw.mpn, 'mpn'),
    name,
    spec_y: optionalString(raw.spec_y, 'spec_y'),
    spec_x: optionalString(raw.spec_x, 'spec_x'),
    gtin: optionalString(raw.gtin, 'gtin'),
    storage_location: optionalString(raw.storage_location, 'storage_location'),
    stock: safeNonNegativeInteger(raw.stock, '飛鼠庫存'),
    op_remark: optionalString(raw.op_remark, 'op_remark')
  });
}

export function expectedStock(currentStock, receivedQuantity) {
  const current = safeNonNegativeInteger(currentStock, '目前庫存');
  const increment = Number(receivedQuantity);
  if (!Number.isSafeInteger(increment) || increment < 1) {
    throw new FlyingMouseWritebackError('本次到貨量必須是正整數', {
      code: 'INVALID_QUANTITY',
      manualReview: true
    });
  }
  const result = current + increment;
  if (!Number.isSafeInteger(result)) {
    throw new FlyingMouseWritebackError('更新後庫存超出安全整數範圍', {
      code: 'INVALID_QUANTITY',
      manualReview: true
    });
  }
  return result;
}

export function buildPartUpdatePayload(rawPart, targetStock) {
  const part = normalizePart(rawPart, rawPart?.no);
  const stock = safeNonNegativeInteger(targetStock, '目標庫存');
  const payload = { ...part, stock };
  return Object.freeze(Object.fromEntries(PART_UPDATE_FIELDS.map((field) => [field, payload[field]])));
}

function validateClient(client, { requirePut = true } = {}) {
  if (!client || typeof client.getBySku !== 'function' ||
    (requirePut && typeof client.putPart !== 'function')) {
    throw new Error('飛鼠貨品 client 設定不完整');
  }
}

function validateEventIdentity(event) {
  const sku = normalizeText(event?.sku);
  if (!sku) throw new Error('回寫事件缺少 SKU');
  const receivedQuantity = Number(event?.receivedQuantity);
  if (!Number.isSafeInteger(receivedQuantity) || receivedQuantity < 1) {
    throw new Error('回寫事件到貨量不正確');
  }
  return { sku, receivedQuantity };
}

export async function prepareFlyingMouseWriteback({ client, event }) {
  validateClient(client, { requirePut: false });
  const { sku, receivedQuantity } = validateEventIdentity(event);
  const part = normalizePart(await client.getBySku(sku), sku);
  return Object.freeze({
    partId: part.id,
    beforeStock: part.stock,
    targetStock: expectedStock(part.stock, receivedQuantity)
  });
}

export async function applyPreparedFlyingMouseWriteback({ client, event, mode = 'dry-run' }) {
  validateClient(client);
  if (!['dry-run', 'live'].includes(mode)) throw new Error('飛鼠庫存回寫模式不正確');
  const { sku, receivedQuantity } = validateEventIdentity(event);
  const partId = Number(event?.partId);
  const beforeStock = safeNonNegativeInteger(event?.beforeStock, '準備階段庫存');
  const targetStock = safeNonNegativeInteger(event?.targetStock, '準備階段目標庫存');
  if (!Number.isSafeInteger(partId) || partId < 1) throw new Error('已準備事件缺少飛鼠貨品 ID');
  if (targetStock !== expectedStock(beforeStock, receivedQuantity)) {
    throw new FlyingMouseWritebackError('已準備事件的目標庫存不一致', {
      code: 'INVALID_PREPARED_EVENT',
      manualReview: true
    });
  }

  const current = normalizePart(await client.getBySku(sku), sku);
  if (current.id !== partId) {
    throw new FlyingMouseWritebackError('飛鼠貨品 ID 已改變', {
      code: 'PART_ID_MISMATCH',
      manualReview: true
    });
  }
  if (current.stock === targetStock) {
    return Object.freeze({ action: 'already-applied', partId, beforeStock, targetStock });
  }
  if (current.stock !== beforeStock) {
    throw new FlyingMouseWritebackError(
      `飛鼠目前庫存 ${current.stock} 同時不等於更新前 ${beforeStock} 與目標 ${targetStock}`,
      { code: 'AMBIGUOUS_STOCK', manualReview: true }
    );
  }
  if (mode === 'dry-run') {
    return Object.freeze({ action: 'dry-run', partId, beforeStock, targetStock });
  }

  await client.putPart(partId, buildPartUpdatePayload(current, targetStock));
  const verified = normalizePart(await client.getBySku(sku), sku);
  if (verified.id !== partId || verified.stock !== targetStock) {
    throw new FlyingMouseWritebackError('飛鼠 PUT 後的庫存驗證不一致', {
      code: 'VERIFY_MISMATCH',
      manualReview: true
    });
  }
  return Object.freeze({ action: 'applied', partId, beforeStock, targetStock });
}

function responseError(operation, status) {
  const retryable = status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
  return new FlyingMouseWritebackError(`${operation}失敗（HTTP ${status}）`, {
    code: `HTTP_${status}`,
    retryable,
    manualReview: !retryable
  });
}

async function pageRequest(page, request) {
  try {
    return await page.evaluate(async (input) => {
      const response = await fetch(input.path, {
        method: input.method,
        credentials: 'same-origin',
        headers: input.body ? { 'Content-Type': 'application/json; charset=UTF-8' } : undefined,
        body: input.body ? JSON.stringify(input.body) : undefined,
        cache: 'no-store'
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status, body };
    }, request);
  } catch (error) {
    throw new FlyingMouseWritebackError('飛鼠 API 網路請求失敗', {
      code: 'NETWORK_ERROR',
      retryable: true,
      cause: error
    });
  }
}

export function createFlyingMousePartClient(page) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('飛鼠頁面 session 不完整');
  return Object.freeze({
    async getBySku(sku) {
      const normalizedSku = normalizeText(sku);
      if (!normalizedSku) throw new Error('查詢 SKU 不可空白');
      const response = await pageRequest(page, {
        method: 'GET',
        path: `/api/admin/part/no/${encodeURIComponent(normalizedSku)}`
      });
      if (response.status < 200 || response.status >= 300) throw responseError('飛鼠貨品查詢', response.status);
      if (!response.body?.part) {
        throw new FlyingMouseWritebackError('飛鼠貨品查詢缺少 part', {
          code: 'INVALID_RESPONSE',
          manualReview: true
        });
      }
      return response.body.part;
    },
    async putPart(partId, payload) {
      const id = Number(partId);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('更新貨品 ID 不正確');
      const response = await pageRequest(page, {
        method: 'PUT',
        path: `/api/admin/part/id/${id}`,
        body: payload
      });
      if (response.status < 200 || response.status >= 300) throw responseError('飛鼠庫存更新', response.status);
      return response.body;
    }
  });
}
