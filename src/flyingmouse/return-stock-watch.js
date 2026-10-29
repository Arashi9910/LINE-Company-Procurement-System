// 觀察「待取消/退貨」訂單結案後，飛鼠會不會自動把庫存加回去。
// 全程唯讀：只整理訂單與庫存快照，不產生任何寫入動作。

export const RETURN_PENDING_STATUS = 9;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label}必須是正整數`);
  }
  return number;
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label}必須是整數`);
  return number;
}

export function collectReturnParts(orders) {
  if (!Array.isArray(orders)) throw new Error('訂單清單格式不正確');
  const byPart = new Map();
  for (const order of orders) {
    const orderNo = normalizeText(order?.no);
    if (!orderNo) throw new Error('訂單缺少訂單編號');
    for (const product of order?.products ?? []) {
      const partList = product?.part_list ?? [];
      // 折價列與沒有對應貨號的列不扣庫存，直接跳過。
      if (!Array.isArray(partList) || partList.length === 0) continue;
      const productQty = positiveInteger(product?.qty, `訂單 ${orderNo} 的購買數量`);
      for (const part of partList) {
        const partNo = normalizeText(part?.no);
        if (!partNo) throw new Error(`訂單 ${orderNo} 的 part_list 缺少貨號`);
        const partQty = positiveInteger(part?.qty, `訂單 ${orderNo} 貨號 ${partNo} 的數量`);
        const qty = productQty * partQty;
        if (!byPart.has(partNo)) byPart.set(partNo, { partNo, qty: 0, orders: new Map() });
        const entry = byPart.get(partNo);
        entry.qty += qty;
        entry.orders.set(orderNo, (entry.orders.get(orderNo) ?? 0) + qty);
      }
    }
  }
  return [...byPart.values()].map(({ partNo, qty, orders }) => ({
    partNo,
    qty,
    orders: [...orders].map(([no, orderQty]) => ({ no, qty: orderQty }))
  }));
}

// onMissingStock：'throw' 直接失敗；'skip' 把查不到貨品的貨號放進 unresolved，不中斷整批。
export function buildReturnSnapshot({ orders, stocks, capturedAt, onMissingStock = 'throw' }) {
  if (!['throw', 'skip'].includes(onMissingStock)) throw new Error('onMissingStock 只能是 throw 或 skip');
  const parts = collectReturnParts(orders);
  const withStock = [];
  const unresolved = [];
  for (const part of parts) {
    if (!Object.hasOwn(stocks ?? {}, part.partNo)) {
      if (onMissingStock === 'throw') throw new Error(`缺少貨號 ${part.partNo} 的庫存`);
      unresolved.push(part.partNo);
      continue;
    }
    withStock.push({ ...part, baselineStock: safeInteger(stocks[part.partNo], `貨號 ${part.partNo} 的庫存`) });
  }
  return Object.freeze({
    capturedAt,
    orders: orders.map((order) => ({
      id: Number(order.id),
      no: normalizeText(order.no),
      createTime: normalizeText(order.create_time)
    })),
    parts: withStock,
    unresolved
  });
}

export function compareReturnSnapshot({ snapshot, currentStatusByOrderNo, currentStocks }) {
  const statuses = currentStatusByOrderNo ?? {};
  const settledOrders = [];
  const pendingOrders = [];
  for (const order of snapshot.orders) {
    if (!Object.hasOwn(statuses, order.no)) throw new Error(`找不到訂單 ${order.no} 目前的狀態`);
    const status = Number(statuses[order.no]);
    if (status === RETURN_PENDING_STATUS) pendingOrders.push(order.no);
    else settledOrders.push({ no: order.no, status });
  }
  const settledSet = new Set(settledOrders.map((order) => order.no));

  const rows = snapshot.parts.map((part) => {
    if (!Object.hasOwn(currentStocks ?? {}, part.partNo)) {
      throw new Error(`缺少貨號 ${part.partNo} 的庫存`);
    }
    const currentStock = safeInteger(currentStocks[part.partNo], `貨號 ${part.partNo} 的庫存`);
    const settledQty = part.orders
      .filter((order) => settledSet.has(order.no))
      .reduce((sum, order) => sum + order.qty, 0);
    const hasPending = part.orders.some((order) => !settledSet.has(order.no));
    const delta = currentStock - part.baselineStock;
    let verdict;
    if (settledQty === 0) verdict = 'PENDING';
    else if (delta === settledQty) verdict = 'RESTOCKED';
    else if (delta === 0) verdict = 'NOT_RESTOCKED';
    else verdict = 'INCONCLUSIVE';
    return { partNo: part.partNo, settledQty, hasPending, baselineStock: part.baselineStock, currentStock, delta, verdict };
  });

  return { settledOrders, pendingOrders, rows };
}
