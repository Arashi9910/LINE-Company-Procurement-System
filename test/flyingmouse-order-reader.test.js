import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS_PROCESSING,
  ORDER_STATUS_PREPARING,
  ORDER_PAGE_SIZE,
  buildOrderQueryPath,
  aggregateOrderQuantities,
  createFlyingMouseOrderClient,
  readOpenOrderQuantities,
  buildRecentOrderQueryPath,
  collectOrderedSkus,
  recentOrderSince,
  readRecentlyOrderedSkus,
  RECENT_ORDER_DAYS
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

// ── Codex 檢查發現的格式驗證漏洞 ──────────────────────────────

test('aggregateOrderQuantities 對缺少或型別錯誤的 products 丟錯，不可當成沒有未寄商品', () => {
  const bad = (products) => () => aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products }], preparing: []
  });
  assert.throws(bad(undefined), /products/, '缺 products 是明細不完整，不是沒有商品');
  assert.throws(bad(null), /products/);
  assert.throws(bad({}), /products/);
  assert.throws(bad('x'), /products/);
});

test('aggregateOrderQuantities 允許 part_list 缺省或空陣列，但型別錯誤要丟錯', () => {
  const build = (partList) => ({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty: 1, part_list: partList }] }],
    preparing: []
  });
  assert.deepEqual(aggregateOrderQuantities(build(undefined)), []);
  assert.deepEqual(aggregateOrderQuantities(build(null)), []);
  assert.deepEqual(aggregateOrderQuantities(build([])), []);
  assert.throws(() => aggregateOrderQuantities(build({ no: 'S1', qty: 1 })), /part_list/);
  assert.throws(() => aggregateOrderQuantities(build('S1')), /part_list/);
});

test('aggregateOrderQuantities 拒絕 null、布林與空字串當成數量', () => {
  const bad = (qty) => () => aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty, part_list: [{ no: 'S1', qty: 1 }] }] }],
    preparing: []
  });
  for (const value of [null, undefined, '', '  ', true, [], {}]) {
    assert.throws(bad(value), /數量/, `${JSON.stringify(value)} 不是合法數量`);
  }
  assert.equal(aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty: '2', part_list: [{ no: 'S1', qty: 1 }] }] }],
    preparing: []
  })[0].total, 2, '數字字串仍要接受');
});

test('fetchOrdersByStatus 拒絕 null 或空字串的 total，不可當成 0 筆', async () => {
  for (const total of [null, '', undefined, true]) {
    const client = createFlyingMouseOrderClient({
      async evaluate() { return { status: 200, body: { data: { total, list: [] } } }; }
    });
    await assert.rejects(
      client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
      (error) => error.code === 'INVALID_RESPONSE',
      `total=${JSON.stringify(total)} 必須被拒絕`
    );
  }
});

test('fetchOrdersByStatus 拒絕 null 或空字串的訂單狀態，不可當成狀態 0', async () => {
  for (const status of [null, '', undefined, false]) {
    const client = createFlyingMouseOrderClient({
      async evaluate() {
        return { status: 200, body: { data: { total: 1, list: [{ id: 1, no: 'A1', status, products: [] }] } } };
      }
    });
    await assert.rejects(
      client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
      (error) => error.code === 'INVALID_ORDER' || error.code === 'STATUS_MISMATCH',
      `status=${JSON.stringify(status)} 必須被拒絕`
    );
  }
});

test('readOpenOrderQuantities 在偵測到跨狀態漂移時記錄一次警告', async () => {
  const warnings = [];
  const moved = { id: 1, no: 'A1', status: 0, products: [{ qty: 2, part_list: [{ no: 'S1', qty: 1 }] }] };
  const client = {
    async fetchOrdersByStatus(status) {
      return status === ORDER_STATUS_PROCESSING ? [moved] : [{ ...moved, status: 2 }];
    }
  };

  const result = await readOpenOrderQuantities(client, { logger: { warn: (m) => warnings.push(m) } });

  assert.equal(warnings.length, 1, '漂移要記一次，不是每筆一次');
  assert.match(warnings[0], /1/);
  assert.deepEqual(result.driftedOrderIds, [1]);
});

test('readOpenOrderQuantities 沒有漂移時不記警告', async () => {
  const warnings = [];
  const client = {
    async fetchOrdersByStatus() { return []; }
  };
  await readOpenOrderQuantities(client, { logger: { warn: (m) => warnings.push(m) } });
  assert.equal(warnings.length, 0);
});

// ── Codex 檢查第 2 輪發現 ────────────────────────────────────

test('aggregateOrderQuantities 拒絕 null 或非物件的商品列，不可默默跳過', () => {
  const bad = (products) => () => aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products }], preparing: []
  });
  assert.throws(bad([null]), /商品列/, 'products: [null] 是損壞明細，不是沒有商品');
  assert.throws(bad([undefined]), /商品列/);
  assert.throws(bad(['x']), /商品列/);
  assert.throws(bad([[]]), /商品列/);
});

test('aggregateOrderQuantities 拒絕 null 或非物件的 part_list 元素', () => {
  const bad = (parts) => () => aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty: 1, part_list: parts }] }],
    preparing: []
  });
  assert.throws(bad([null]), /貨號/);
  assert.throws(bad(['S1']), /貨號/);
  assert.throws(bad([[]]), /貨號/);
});

test('aggregateOrderQuantities 拒絕物件或布林當貨號，不可變成 [object Object]', () => {
  const bad = (no) => () => aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty: 1, part_list: [{ no, qty: 1 }] }] }],
    preparing: []
  });
  for (const value of [{}, [], true, null, undefined, '', '   ']) {
    assert.throws(bad(value), /貨號/, `${JSON.stringify(value)} 不是合法貨號`);
  }
  assert.equal(aggregateOrderQuantities({
    processing: [{ id: 1, no: 'A1', status: 0, products: [{ qty: 1, part_list: [{ no: 12345, qty: 1 }] }] }],
    preparing: []
  })[0].partNo, '12345', '數字型貨號仍要接受');
});

test('fetchOrdersByStatus 送出的請求帶有逾時設定', async () => {
  let received = null;
  const client = createFlyingMouseOrderClient({
    async evaluate(_fn, input) {
      received = input;
      return { status: 200, body: { data: { total: 0, list: [] } } };
    }
  });
  await client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING);
  assert.ok(Number.isSafeInteger(received.timeoutMs) && received.timeoutMs > 0,
    '必須把逾時毫秒數傳進瀏覽器端，否則回應不結束時會永遠卡住');
});

test('fetchOrdersByStatus 把瀏覽器端的逾時轉成可重試的錯誤', async () => {
  const client = createFlyingMouseOrderClient({
    async evaluate() { return { aborted: true }; }
  });
  await assert.rejects(
    client.fetchOrdersByStatus(ORDER_STATUS_PROCESSING),
    (error) => error.code === 'TIMEOUT' && error.retryable === true
  );
});

// ---- 動銷（近 30 天有訂單就算，不看件數）----

test('buildRecentOrderQueryPath 帶日期、不帶狀態', () => {
  const path = buildRecentOrderQueryPath({ since: '2026-09-29 00:00:00', offset: 200, size: 200 });
  assert.ok(path.includes('detail=1'));
  assert.ok(path.includes('equals[deleted]=0'));
  // 規格第 7.5 節：查動銷「要」帶日期，跟查未寄訂單剛好相反。
  assert.ok(path.includes(`gtes[create_time]=${encodeURIComponent('2026-09-29 00:00:00')}`));
  assert.ok(path.includes('columns[]=create_time'));
  assert.equal(path.includes('equals[status]'), false, '動銷不限狀態，要在本地篩');
  assert.equal(path.includes('pageCode'), false);
  assert.ok(path.includes('offset=200'));
});

test('buildRecentOrderQueryPath 擋掉壞掉的起始時間', () => {
  for (const since of ['', '2026/09/29', '上個月', null, '2026-09-29T00:00:00Z']) {
    assert.throws(() => buildRecentOrderQueryPath({ since, offset: 0, size: 200 }), /起始時間格式/);
  }
  assert.ok(buildRecentOrderQueryPath({ since: '2026-09-29', offset: 0, size: 200 }));
  assert.ok(buildRecentOrderQueryPath({ since: '2026-09-29 00:00', offset: 0, size: 200 }));
});

test('recentOrderSince 回推 N 天的當天零時', () => {
  assert.equal(recentOrderSince(new Date('2026-10-29T12:00:00'), 30), '2026-09-29 00:00:00');
  assert.equal(recentOrderSince(new Date('2026-03-05T12:00:00'), 7), '2026-02-26 00:00:00');
  assert.equal(RECENT_ORDER_DAYS, 30);
  assert.throws(() => recentOrderSince(new Date(), 0), /正整數/);
});

test('collectOrderedSkus 只看有沒有訂單，取消與棄單不算', () => {
  const skus = collectOrderedSkus([
    order(1, 'A1', 5, [product(3, [{ no: 'SKU-A', qty: 1 }])]),
    order(2, 'A2', 0, [product(1, [{ no: 'SKU-A', qty: 1 }, { no: 'SKU-B', qty: 2 }])]),
    order(3, 'A3', 9, [product(1, [{ no: 'SKU-C', qty: 1 }])]),
    // 取消與棄單不算「動過」。
    order(4, 'A4', 4, [product(1, [{ no: 'SKU-CANCELLED', qty: 1 }])]),
    order(5, 'A5', 6, [product(1, [{ no: 'SKU-ABANDONED', qty: 1 }])]),
    // 折價列沒有 part_list，跳過不算錯。
    order(6, 'A6', 5, [{ qty: 1 }, product(1, [{ no: 'SKU-D', qty: 1 }])])
  ]);

  assert.deepEqual([...skus].sort(), ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D']);
});

test('collectOrderedSkus 對壞掉的明細一樣丟錯', () => {
  assert.throws(() => collectOrderedSkus([order(1, 'A1', 5, null)]), /缺少 products 明細/);
  assert.throws(() => collectOrderedSkus([order(1, 'A1', 5, [null])]), /商品列格式不正確/);
  assert.throws(() => collectOrderedSkus([order(1, 'A1', 5, [product(1, [{ no: {}, qty: 1 }])])]),
    /貨號型別不正確/);
  assert.throws(() => collectOrderedSkus([order(1, 'A1', null, [])]), /狀態必須是整數/);
});

test('readRecentlyOrderedSkus 回傳貨號集合與查詢起點', async () => {
  const calls = [];
  const client = {
    async fetchOrdersSince(since) {
      calls.push(since);
      return [order(1, 'A1', 5, [product(2, [{ no: 'SKU-A', qty: 3 }])])];
    }
  };

  const result = await readRecentlyOrderedSkus(client, { now: new Date('2026-10-29T12:00:00') });

  assert.deepEqual(calls, ['2026-09-29 00:00:00']);
  assert.deepEqual([...result.skus], ['SKU-A']);
  assert.equal(result.orderCount, 1);
  assert.equal(result.since, '2026-09-29 00:00:00');
});

test('readRecentlyOrderedSkus 只重讀可重試的錯誤', async () => {
  let attempts = 0;
  const drifting = {
    async fetchOrdersSince() {
      attempts += 1;
      if (attempts < 2) {
        const error = new Error('筆數在翻頁途中變動');
        error.retryable = true;
        throw error;
      }
      return [order(1, 'A1', 5, [product(1, [{ no: 'SKU-A', qty: 1 }])])];
    }
  };
  assert.deepEqual([...(await readRecentlyOrderedSkus(drifting, {})).skus], ['SKU-A']);
  assert.equal(attempts, 2);

  let fatal = 0;
  const broken = {
    async fetchOrdersSince() {
      fatal += 1;
      throw new Error('貨號型別不正確');
    }
  };
  await assert.rejects(readRecentlyOrderedSkus(broken, {}), /貨號型別不正確/);
  assert.equal(fatal, 1, '資料本身壞掉重讀也沒用');
});

test('fetchOrdersSince 會翻頁並套用同一組完整性檢查', async () => {
  const queries = [];
  const orders = Array.from({ length: 250 }, (_, index) =>
    order(index + 1, `A${index + 1}`, 5, [product(1, [{ no: `SKU-${index % 3}`, qty: 1 }])]));
  const page = {
    async evaluate(_fn, input) {
      queries.push(input.path);
      const url = new URL(input.path, 'https://example.test');
      const offset = Number(url.searchParams.get('offset'));
      const size = Number(url.searchParams.get('size'));
      return {
        status: 200,
        body: { code: 0, data: { total: orders.length, list: orders.slice(offset, offset + size) } }
      };
    }
  };

  const result = await createFlyingMouseOrderClient(page).fetchOrdersSince('2026-09-29 00:00:00');

  assert.equal(result.length, 250);
  assert.equal(queries.length, 2);
  assert.ok(queries[1].includes(`offset=${ORDER_PAGE_SIZE}`));
  assert.deepEqual([...collectOrderedSkus(result)].sort(), ['SKU-0', 'SKU-1', 'SKU-2']);
});
