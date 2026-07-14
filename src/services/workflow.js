import { AuthenticationError, AuthorizationError, ValidationError } from '../errors.js';

const ORDER_ROLES = new Set(['採購確認', '管理員']);
const RECEIPT_ROLES = new Set(['到貨確認', '管理員']);

function operationKey(value) {
  const key = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new ValidationError('操作金鑰格式不正確，請重新整理後再試');
  }
  return key;
}

function requireActor(actor) {
  if (!actor?.userId) throw new AuthenticationError();
}

async function requireRole(actor, repository, allowed) {
  requireActor(actor);
  const authorization = await repository.getAuthorization(actor.userId);
  if (!authorization.enabled || !allowed.has(authorization.role)) {
    throw new AuthorizationError();
  }
  return authorization;
}

export async function getRequestDetails({ actor, requestId }, repository) {
  requireActor(actor);
  const [request, authorization] = await Promise.all([
    repository.getRequest(String(requestId ?? '').trim()),
    repository.getAuthorization(actor.userId)
  ]);
  return { ...request, actorRole: authorization.enabled ? authorization.role : '' };
}

export async function confirmOrder(input, repository) {
  await requireRole(input.actor, repository, ORDER_ROLES);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError('至少需要一個下單品項');
  }

  const seen = new Set();
  const items = input.items.map((item) => {
    const sku = String(item?.sku ?? '').trim();
    const orderedQuantity = Number(item?.orderedQuantity);
    const expectedDate = String(item?.expectedDate ?? '').trim();
    if (!sku || seen.has(sku)) throw new ValidationError('下單品項 SKU 缺少或重複');
    seen.add(sku);
    if (!Number.isInteger(orderedQuantity) || orderedQuantity < 0) {
      throw new ValidationError(`SKU ${sku} 的下單數量必須是 0 或正整數`);
    }
    if (orderedQuantity > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) {
      throw new ValidationError(`SKU ${sku} 必須填寫預計到貨日`);
    }
    return { sku, orderedQuantity, expectedDate: orderedQuantity > 0 ? expectedDate : '' };
  });

  return repository.confirmOrder({
    actor: input.actor,
    requestId: String(input.requestId ?? '').trim(),
    items,
    idempotencyKey: operationKey(input.idempotencyKey)
  });
}

export async function confirmReceipt(input, repository) {
  await requireRole(input.actor, repository, RECEIPT_ROLES);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError('至少需要一個到貨品項');
  }

  const seen = new Set();
  const items = input.items.map((item) => {
    const sku = String(item?.sku ?? '').trim();
    const receivedQuantity = Number(item?.receivedQuantity);
    if (!sku || seen.has(sku)) throw new ValidationError('到貨品項 SKU 缺少或重複');
    seen.add(sku);
    if (!Number.isInteger(receivedQuantity) || receivedQuantity < 1) {
      throw new ValidationError(`SKU ${sku} 的本次到貨量必須是正整數`);
    }
    return { sku, receivedQuantity };
  });

  return repository.confirmReceipt({
    actor: input.actor,
    requestId: String(input.requestId ?? '').trim(),
    items,
    idempotencyKey: operationKey(input.idempotencyKey)
  });
}
