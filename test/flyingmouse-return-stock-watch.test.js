import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReturnParts,
  buildReturnSnapshot,
  compareReturnSnapshot
} from '../src/flyingmouse/return-stock-watch.js';

function order(no, products, extra = {}) {
  return { id: extra.id ?? 1, no, status: extra.status ?? 9, create_time: extra.createTime ?? '2026-10-01 10:00:00', products };
}

function product(sku, qty, parts) {
  return { sku, qty, part_list: parts };
}

test('collectReturnParts 以 products.qty × part_list.qty 累加每個貨號', () => {
  const parts = collectReturnParts([
    order('A1', [product('S1', 2, [{ no: 'S1', qty: 1 }])]),
    order('A2', [product('S1', 3, [{ no: 'S1', qty: 1 }])])
  ]);
  assert.deepEqual(parts, [{ partNo: 'S1', qty: 5, orders: [{ no: 'A1', qty: 2 }, { no: 'A2', qty: 3 }] }]);
});

test('collectReturnParts 處理一列多個貨號的組合包', () => {
  const parts = collectReturnParts([
    order('A1', [product('BUNDLE', 2, [{ no: 'P1', qty: 1 }, { no: 'P2', qty: 3 }])])
  ]);
  assert.deepEqual(parts, [
    { partNo: 'P1', qty: 2, orders: [{ no: 'A1', qty: 2 }] },
    { partNo: 'P2', qty: 6, orders: [{ no: 'A1', qty: 6 }] }
  ]);
});

test('collectReturnParts 跳過沒有 part_list 的折價列，不丟錯', () => {
  const parts = collectReturnParts([
    order('A1', [
      product(null, 1, []),
      { sku: null, qty: 1, price: -49 },
      product('S1', 1, [{ no: 'S1', qty: 1 }])
    ])
  ]);
  assert.deepEqual(parts, [{ partNo: 'S1', qty: 1, orders: [{ no: 'A1', qty: 1 }] }]);
});

test('collectReturnParts 對缺少貨號或數量不合法的列丟出錯誤', () => {
  assert.throws(() => collectReturnParts([order('A1', [product('S1', 1, [{ no: '', qty: 1 }])])]), /貨號/);
  assert.throws(() => collectReturnParts([order('A1', [product('S1', 0, [{ no: 'S1', qty: 1 }])])]), /數量/);
  assert.throws(() => collectReturnParts([order('A1', [product('S1', 1, [{ no: 'S1', qty: -1 }])])]), /數量/);
});

test('buildReturnSnapshot 記下訂單、貨號與當下庫存', () => {
  const snapshot = buildReturnSnapshot({
    orders: [order('A1', [product('S1', 2, [{ no: 'S1', qty: 1 }])], { id: 11 })],
    stocks: { S1: 7 },
    capturedAt: '2026-10-29T12:00:00.000Z'
  });
  assert.equal(snapshot.capturedAt, '2026-10-29T12:00:00.000Z');
  assert.deepEqual(snapshot.orders, [{ id: 11, no: 'A1', createTime: '2026-10-01 10:00:00' }]);
  assert.deepEqual(snapshot.parts, [{ partNo: 'S1', qty: 2, orders: [{ no: 'A1', qty: 2 }], baselineStock: 7 }]);
  assert.deepEqual(snapshot.unresolved, []);
});

test('buildReturnSnapshot 在 skip 模式把查不到貨品的貨號收進 unresolved', () => {
  const snapshot = buildReturnSnapshot({
    orders: [order('A1', [
      product('S1', 1, [{ no: 'S1', qty: 1 }]),
      product('X9', 1, [{ no: 'X9', qty: 1 }])
    ])],
    stocks: { S1: 7 },
    capturedAt: '2026-10-29T12:00:00.000Z',
    onMissingStock: 'skip'
  });
  assert.deepEqual(snapshot.parts.map((p) => p.partNo), ['S1']);
  assert.deepEqual(snapshot.unresolved, ['X9']);
});

test('buildReturnSnapshot 拒絕無效的 onMissingStock', () => {
  assert.throws(() => buildReturnSnapshot({
    orders: [], stocks: {}, capturedAt: '', onMissingStock: 'nope'
  }), /onMissingStock/);
});

test('buildReturnSnapshot 對缺少庫存的貨號丟出錯誤', () => {
  assert.throws(() => buildReturnSnapshot({
    orders: [order('A1', [product('S1', 1, [{ no: 'S1', qty: 1 }])])],
    stocks: {},
    capturedAt: '2026-10-29T12:00:00.000Z'
  }), /庫存/);
});

const SNAPSHOT = Object.freeze({
  capturedAt: '2026-10-29T12:00:00.000Z',
  orders: [{ id: 11, no: 'A1', createTime: '2026-10-01 10:00:00' }],
  parts: [{ partNo: 'S1', qty: 2, orders: [{ no: 'A1', qty: 2 }], baselineStock: 7 }]
});

test('compareReturnSnapshot 在訂單仍停留在待取消/退貨時標為尚未結案', () => {
  const result = compareReturnSnapshot({
    snapshot: SNAPSHOT,
    currentStatusByOrderNo: { A1: 9 },
    currentStocks: { S1: 7 }
  });
  assert.deepEqual(result.pendingOrders, ['A1']);
  assert.deepEqual(result.settledOrders, []);
  assert.equal(result.rows[0].settledQty, 0);
  assert.equal(result.rows[0].hasPending, true);
  assert.equal(result.rows[0].verdict, 'PENDING');
});

test('compareReturnSnapshot 在退貨結案且庫存剛好加回時判定為會自動加回', () => {
  const result = compareReturnSnapshot({
    snapshot: SNAPSHOT,
    currentStatusByOrderNo: { A1: 8 },
    currentStocks: { S1: 9 }
  });
  assert.deepEqual(result.settledOrders, [{ no: 'A1', status: 8 }]);
  assert.deepEqual(result.rows[0], {
    partNo: 'S1',
    settledQty: 2,
    hasPending: false,
    baselineStock: 7,
    currentStock: 9,
    delta: 2,
    verdict: 'RESTOCKED'
  });
});

test('compareReturnSnapshot 在退貨結案但庫存沒動時判定為不會加回', () => {
  const result = compareReturnSnapshot({
    snapshot: SNAPSHOT,
    currentStatusByOrderNo: { A1: 8 },
    currentStocks: { S1: 7 }
  });
  assert.equal(result.rows[0].verdict, 'NOT_RESTOCKED');
});

test('compareReturnSnapshot 在庫存變化對不上退貨量時判定為無法判定', () => {
  const result = compareReturnSnapshot({
    snapshot: SNAPSHOT,
    currentStatusByOrderNo: { A1: 8 },
    currentStocks: { S1: 15 }
  });
  assert.equal(result.rows[0].delta, 8);
  assert.equal(result.rows[0].verdict, 'INCONCLUSIVE');
});

test('compareReturnSnapshot 只把已結案訂單的數量算進 settledQty', () => {
  const snapshot = {
    capturedAt: '2026-10-29T12:00:00.000Z',
    orders: [{ id: 11, no: 'A1', createTime: '' }, { id: 12, no: 'A2', createTime: '' }],
    parts: [{ partNo: 'S1', qty: 5, orders: [{ no: 'A1', qty: 2 }, { no: 'A2', qty: 3 }], baselineStock: 7 }]
  };
  const result = compareReturnSnapshot({
    snapshot,
    currentStatusByOrderNo: { A1: 8, A2: 9 },
    currentStocks: { S1: 7 }
  });
  assert.deepEqual(result.pendingOrders, ['A2']);
  assert.equal(result.rows[0].settledQty, 2, '只算已結案的 A1');
  assert.equal(result.rows[0].hasPending, true, '仍有未結案訂單，數字要標記為可能受干擾');
  assert.equal(result.rows[0].verdict, 'NOT_RESTOCKED');
});

test('compareReturnSnapshot 對消失的訂單與缺少的庫存丟出錯誤', () => {
  assert.throws(() => compareReturnSnapshot({
    snapshot: SNAPSHOT, currentStatusByOrderNo: {}, currentStocks: { S1: 7 }
  }), /找不到訂單/);
  assert.throws(() => compareReturnSnapshot({
    snapshot: SNAPSHOT, currentStatusByOrderNo: { A1: 8 }, currentStocks: {}
  }), /庫存/);
});
