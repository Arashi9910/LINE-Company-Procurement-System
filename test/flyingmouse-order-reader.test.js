import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS_PROCESSING,
  ORDER_STATUS_PREPARING,
  ORDER_PAGE_SIZE,
  buildOrderQueryPath,
  aggregateOrderQuantities,
  createFlyingMouseOrderClient,
  readOpenOrderQuantities
} from '../src/flyingmouse/order-reader.js';

function order(id, no, status, products) {
  return { id, no, status, products };
}

function product(qty, parts) {
  return { qty, part_list: parts };
}

// 依 offset 分頁回傳假資料；queries 會記下每次請求的 path。
function pagedPage(pagesByStatus, queries = []) {
  return {
    async evaluate(_fn, input) {
      queries.push(input.path);
      const url = new URL(input.path, 'https://example.test');
      const status = url.searchParams.get('equals[status]');
      const offset = Number(url.searchParams.get('offset'));
      const size = Number(url.searchParams.get('size'));
      const pages = pagesByStatus[status];
      if (pages === undefined) throw new Error(`未預期的狀態 ${status}`);
      const { total, list } = typeof pages === 'function' ? pages(offset) : pages;
      return { status: 200, body: { code: 0, data: { total, list: list.slice(offset, offset + size) } } };
    }
  };
}

test('buildOrderQueryPath 帶齊實測確認的必要參數', () => {
  const path = buildOrderQueryPath({ status: 0, offset: 400, size: 200 });
  assert.match(path, /^\/api\/admin\/order\?/);
  assert.ok(path.includes('detail=1'), '沒有 detail=1 就不會回 part_list');
  assert.ok(path.includes('equals[deleted]=0'));
  assert.ok(path.includes('equals[status]=0'));
  assert.ok(path.includes('columns[]=id'));
  assert.ok(path.includes('columns[]=no'));
  assert.ok(path.includes('columns[]=status'));
  assert.ok(path.includes('offset=400'));
  assert.ok(path.includes('size=200'));
});

test('buildOrderQueryPath 不可出現 pageCode 或日期條件', () => {
  const path = buildOrderQueryPath({ status: 2, offset: 0, size: 200 });
  assert.ok(!path.includes('pageCode'), 'pageCode 實測不生效，送出去只會誤導');
  assert.ok(!path.includes('create_time'), '帶日期條件會漏掉兩個月前的預購單');
});

test('aggregateOrderQuantities 以 products.qty × part_list.qty 分別累計兩個狀態', () => {
  const result = aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, [product(2, [{ no: 'S1', qty: 1 }])])],
    preparing: [order(2, 'A2', 2, [product(1, [{ no: 'S1', qty: 3 }])])]
  });
  assert.deepEqual(result, [{ partNo: 'S1', processing: 2, preparing: 3, total: 5 }]);
});

test('aggregateOrderQuantities 跳過沒有 part_list 的折價列', () => {
  const result = aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, [
      { qty: 1, price: -49 },
      product(1, []),
      product(1, [{ no: 'S1', qty: 1 }])
    ])],
    preparing: []
  });
  assert.deepEqual(result, [{ partNo: 'S1', processing: 1, preparing: 0, total: 1 }]);
});

test('aggregateOrderQuantities 不以 product_type 判斷，有 part_list 就要算', () => {
  const result = aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, [
      { qty: 1, product_type: null, part_list: [{ no: 'S1', qty: 1 }] }
    ])],
    preparing: []
  });
  assert.equal(result[0].total, 1);
});

test('aggregateOrderQuantities 把組合包的每個貨號分開累加', () => {
  const result = aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, [product(2, [{ no: 'P1', qty: 1 }, { no: 'P2', qty: 3 }])])],
    preparing: []
  });
  assert.deepEqual(result, [
    { partNo: 'P1', processing: 2, preparing: 0, total: 2 },
    { partNo: 'P2', processing: 6, preparing: 0, total: 6 }
  ]);
});

test('aggregateOrderQuantities 依貨號排序，輸出穩定', () => {
  const result = aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, [
      product(1, [{ no: 'B' , qty: 1 }]),
      product(1, [{ no: 'A', qty: 1 }])
    ])],
    preparing: []
  });
  assert.deepEqual(result.map((row) => row.partNo), ['A', 'B']);
});

test('aggregateOrderQuantities 對空白貨號與非正整數數量丟錯', () => {
  const bad = (products) => () => aggregateOrderQuantities({
    processing: [order(1, 'A1', 0, products)], preparing: []
  });
  assert.throws(bad([product(1, [{ no: '  ', qty: 1 }])]), /貨號/);
  assert.throws(bad([product(0, [{ no: 'S1', qty: 1 }])]), /數量/);
  assert.throws(bad([product(1, [{ no: 'S1', qty: 0 }])]), /數量/);
  assert.throws(bad([product(1.5, [{ no: 'S1', qty: 1 }])]), /數量/);
});

test('fetchOrdersByStatus 用 offset 翻完所有頁', async () => {
  const list = Array.from({ length: 450 }, (_, index) =>
    order(index + 1, `A${index + 1}`, 0, [product(1, [{ no: 'S1', qty: 1 }])]));
  const queries = [];
  const client = createFlyingMouseOrderClient(pagedPage({ 0: { total: 450, list } }, queries));

  const orders = await client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING);

  assert.equal(orders.length, 450);
  assert.deepEqual(
    queries.map((path) => Number(new URL(path, 'https://e.test').searchParams.get('offset'))),
    [0, 200, 400]
  );
  assert.equal(ORDER_PAGE_SIZE, 200);
});

test('fetchOrdersByStatus 接受空清單', async () => {
  const client = createFlyingMouseOrderClient(pagedPage({ 2: { total: 0, list: [] } }));
  assert.deepEqual(await client.fetchOrdersByStatus(ORDER_STATUS_PREPARING), []);
});

test('fetchOrdersByStatus 在列數對但訂單 id 重複時丟錯', async () => {
  // 兩頁各回同樣的 2 筆：列數加起來剛好 4，但實際只有 2 張單。
  const dup = [order(1, 'A1', 0, []), order(2, 'A2', 0, [])];
  const client = createFlyingMouseOrderClient({
    async evaluate() { return { status: 200, body: { data: { total: 4, list: dup } } }; }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'DUPLICATE_ORDER'
  );
});

test('fetchOrdersByStatus 在各頁 total 不一致時丟錯', async () => {
  let call = 0;
  const client = createFlyingMouseOrderClient({
    async evaluate() {
      call += 1;
      const total = call === 1 ? 400 : 399;
      return {
        status: 200,
        body: { data: { total, list: Array.from({ length: 200 }, (_, i) => order(call * 1000 + i, `A${call}-${i}`, 0, [])) } }
      };
    }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'TOTAL_DRIFT'
  );
});

test('fetchOrdersByStatus 在回傳狀態與查詢不符時丟錯', async () => {
  const client = createFlyingMouseOrderClient({
    async evaluate() {
      return { status: 200, body: { data: { total: 1, list: [order(1, 'A1', 3, [])] } } };
    }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'STATUS_MISMATCH'
  );
});

test('fetchOrdersByStatus 在去重後筆數少於 total 時丟錯', async () => {
  const client = createFlyingMouseOrderClient({
    async evaluate() { return { status: 200, body: { data: { total: 5, list: [] } } }; }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'COUNT_MISMATCH'
  );
});

test('fetchOrdersByStatus 把 HTTP 錯誤轉成可辨識的錯誤且不外洩回應內容', async () => {
  const client = createFlyingMouseOrderClient({
    async evaluate() { return { status: 503, body: { secret: 'do-not-expose' } }; }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'HTTP_503' && error.retryable === true &&
      !error.message.includes('do-not-expose')
  );
});

test('fetchOrdersByStatus 對格式不正確的回應丟錯', async () => {
  const client = createFlyingMouseOrderClient({
    async evaluate() { return { status: 200, body: { data: null } }; }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'INVALID_RESPONSE'
  );
});

test('readOpenOrderQuantities 合併狀態 0 與 2', async () => {
  const client = createFlyingMouseOrderClient(pagedPage({
    0: { total: 1, list: [order(1, 'A1', 0, [product(2, [{ no: 'S1', qty: 1 }])])] },
    2: { total: 1, list: [order(2, 'A2', 2, [product(1, [{ no: 'S1', qty: 1 }])])] }
  }));

  const result = await readOpenOrderQuantities(client);

  assert.deepEqual(result.parts, [{ partNo: 'S1', processing: 2, preparing: 1, total: 3 }]);
  assert.deepEqual(result.orderCounts, { processing: 1, preparing: 1 });
  assert.deepEqual(result.driftedOrderIds, []);
});

test('readOpenOrderQuantities 對同時出現在兩個狀態的訂單去重，以後查到的備貨中為準', async () => {
  // 查完狀態 0 之後，A1 轉成備貨中，於是狀態 2 也回傳同一張單。
  const moved = order(1, 'A1', 0, [product(2, [{ no: 'S1', qty: 1 }])]);
  const client = createFlyingMouseOrderClient(pagedPage({
    0: { total: 1, list: [moved] },
    2: { total: 1, list: [{ ...moved, status: 2 }] }
  }));

  const result = await readOpenOrderQuantities(client);

  assert.deepEqual(result.parts, [{ partNo: 'S1', processing: 0, preparing: 2, total: 2 }],
    '不可重複計算；備貨中為準');
  assert.deepEqual(result.orderCounts, { processing: 0, preparing: 1 });
  assert.deepEqual(result.driftedOrderIds, [1]);
});

// 與真實客戶端一致：資料在動造成的不一致是可重讀的。
function countMismatch() {
  const error = new Error('筆數不符');
  error.code = 'COUNT_MISMATCH';
  error.retryable = true;
  return error;
}

test('readOpenOrderQuantities 在不一致時重讀，成功就不丟錯', async () => {
  let attempt = 0;
  const client = {
    async fetchOrdersByStatus(status) {
      if (status === ORDER_STATUS_PROCESSING) {
        attempt += 1;
        if (attempt === 1) throw countMismatch();
        return [order(1, 'A1', 0, [product(1, [{ no: 'S1', qty: 1 }])])];
      }
      return [];
    }
  };

  const result = await readOpenOrderQuantities(client);

  assert.equal(attempt, 2, '第一次失敗要重讀');
  assert.deepEqual(result.parts, [{ partNo: 'S1', processing: 1, preparing: 0, total: 1 }]);
});

test('readOpenOrderQuantities 對不可重讀的資料錯誤不重試', async () => {
  let attempts = 0;
  const client = {
    async fetchOrdersByStatus() {
      attempts += 1;
      const error = new Error('訂單 A1 的 part_list 缺少貨號');
      error.code = 'INVALID_ORDER';
      error.retryable = false;
      throw error;
    }
  };

  await assert.rejects(readOpenOrderQuantities(client), (error) => error.code === 'INVALID_ORDER');
  assert.equal(attempts, 1, '資料本身壞掉，重讀也沒用');
});

test('readOpenOrderQuantities 重讀用盡後丟錯，讓呼叫端保留上一次看板', async () => {
  let attempts = 0;
  const client = {
    async fetchOrdersByStatus() {
      attempts += 1;
      throw countMismatch();
    }
  };

  await assert.rejects(readOpenOrderQuantities(client), (error) => error.code === 'COUNT_MISMATCH');
  assert.equal(attempts, 3, '初次加上最多 2 次重讀');
});
