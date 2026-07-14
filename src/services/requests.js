import { ValidationError } from '../errors.js';

const MAX_ITEMS = 50;
const MAX_NOTE_LENGTH = 500;

export async function listSearchableSkus(repository) {
  const imageRows = typeof repository.listProductImages === 'function'
    ? repository.listProductImages()
    : Promise.resolve([]);
  const [skus, openRequests, productImages] = await Promise.all([
    repository.listAvailableSkus(),
    repository.listOpenRequests(),
    imageRows
  ]);
  const openCounts = new Map();
  const imagesBySku = new Map(productImages.map((item) => [item.sku, item]));

  for (const request of openRequests) {
    if (!request.sku) continue;
    openCounts.set(request.sku, (openCounts.get(request.sku) ?? 0) + 1);
  }

  return skus.map((sku) => ({
    ...sku,
    productId: imagesBySku.get(sku.sku)?.productId ?? '',
    productCode: imagesBySku.get(sku.sku)?.productCode ?? '',
    productName: imagesBySku.get(sku.sku)?.productName || sku.productName,
    variantName: imagesBySku.get(sku.sku)?.variantName ?? '',
    mainImageUrl: imagesBySku.get(sku.sku)?.mainImageUrl ?? '',
    variantImageUrl: imagesBySku.get(sku.sku)?.variantImageUrl ?? '',
    listImageUrl: imagesBySku.get(sku.sku)?.listImageUrl ?? '',
    imageStatus: imagesBySku.get(sku.sku)?.imageStatus ?? '',
    bindingStatus: imagesBySku.get(sku.sku)?.bindingStatus ?? '',
    openCount: openCounts.get(sku.sku) ?? 0
  }));
}

export async function submitRequest(input, repository) {
  const actor = input?.actor;
  if (!actor?.userId) {
    throw new ValidationError('缺少已驗證的 LINE 身分');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError('至少需要一個補貨品項');
  }
  if (input.items.length > MAX_ITEMS) {
    throw new ValidationError(`單次最多可申請 ${MAX_ITEMS} 個品項`);
  }

  const seen = new Set();
  const items = input.items.map((item, index) => {
    const sku = String(item?.sku ?? '').trim();
    const quantity = Number(item?.quantity);
    if (!sku) throw new ValidationError(`第 ${index + 1} 個品項缺少 SKU`);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ValidationError(`SKU ${sku} 的數量必須是正整數`);
    }
    if (seen.has(sku)) throw new ValidationError(`SKU ${sku} 重複出現在同一張申請`);
    seen.add(sku);
    return { sku, quantity };
  });

  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    throw new ValidationError('操作金鑰格式不正確，請重新整理後再試');
  }

  const note = String(input.note ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ValidationError(`備註最多 ${MAX_NOTE_LENGTH} 個字`);
  }

  return repository.createRequest({
    actor: {
      userId: actor.userId,
      displayName: String(actor.displayName ?? 'LINE 使用者').trim() || 'LINE 使用者'
    },
    items,
    note,
    groupId: input.groupId ?? '',
    idempotencyKey
  });
}
