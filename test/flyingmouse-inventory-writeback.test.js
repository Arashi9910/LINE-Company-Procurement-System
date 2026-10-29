import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FlyingMouseWritebackError,
  applyPreparedFlyingMouseWriteback,
  buildPartUpdatePayload,
  createFlyingMousePartClient,
  expectedStock,
  prepareFlyingMouseWriteback
} from '../src/flyingmouse/inventory-writeback.js';

function part(overrides = {}) {
  return {
    id: 933,
    no: 'SKU-A',
    mpn: null,
    gtin: null,
    name: '商品 A',
    spec_y: '紅色',
    spec_x: null,
    storage_location: null,
    op_remark: '既有備註',
    create_time: '2026-07-01 10:00:00',
    update_time: '2026-07-16 10:00:00',
    stock: 10,
    stock_history: [{ stock: 10 }],
    unexpected: '不得送出',
    ...overrides
  };
}

function pendingEvent(overrides = {}) {
  return {
    eventId: 'receipt-key-123456:SKU-A',
    requestId: 'RQ-1',
    sku: 'SKU-A',
    receivedQuantity: 2,
    status: '待處理',
    attempts: 0,
    ...overrides
  };
}

function preparedEvent(overrides = {}) {
  return pendingEvent({
    status: '已準備',
    partId: 933,
    beforeStock: 10,
    targetStock: 12,
    ...overrides
  });
}

test('expectedStock and payload validation permit only safe inventory values', () => {
  assert.equal(expectedStock(10, 2), 12);
  // 飛鼠超賣後庫存是負的，到貨就是要從負的加上來，不可擋。
  assert.equal(expectedStock(-1, 2), 1);
  assert.equal(expectedStock(-5, 5), 0);
  // 但補不滿超賣時不可自動處理：飛鼠存檔會把負數正規化為 0，送出去等於抹掉超賣帳。
  assert.throws(() => expectedStock(-5, 2), (error) => error instanceof FlyingMouseWritebackError &&
    error.code === 'NEGATIVE_TARGET_STOCK' && error.manualReview === true);
  assert.throws(() => buildPartUpdatePayload(part(), -1), /負數/);
  assert.throws(() => expectedStock(10, 0), /正整數/);
  assert.throws(() => expectedStock(Number.MAX_SAFE_INTEGER, 1), /安全整數/);
  // Number() 會把這些都變成 0，解析庫存時等於把「欄位不見了」當成「庫存 0」。
  for (const broken of [null, undefined, '', ' ', false, [], '10.5', '一百']) {
    assert.throws(() => expectedStock(broken, 2), /必須是整數/);
  }

  const payload = buildPartUpdatePayload(part(), 12);
  assert.deepEqual(Object.keys(payload).sort(), [
    'gtin', 'id', 'mpn', 'name', 'no', 'op_remark', 'spec_x', 'spec_y',
    'stock', 'storage_location'
  ]);
  assert.equal(payload.stock, 12);
  assert.equal(payload.op_remark, '既有備註');
  assert.equal(Object.hasOwn(payload, 'stock_history'), false);
  assert.equal(Object.hasOwn(payload, 'unexpected'), false);
});

test('prepareFlyingMouseWriteback works from a negative FlyingMouse stock', async () => {
  const client = { async getBySku() { return part({ stock: -1 }); } };

  const result = await prepareFlyingMouseWriteback({ client, event: pendingEvent() });

  assert.deepEqual(result, { partId: 933, beforeStock: -1, targetStock: 1 });
});

test('prepareFlyingMouseWriteback refuses a part whose stock field is missing', async () => {
  for (const stock of [null, '', 'N/A']) {
    const client = { async getBySku() { return part({ stock }); } };
    await assert.rejects(
      prepareFlyingMouseWriteback({ client, event: pendingEvent() }),
      (error) => error instanceof FlyingMouseWritebackError &&
        error.code === 'INVALID_PART' &&
        error.manualReview === true &&
        /飛鼠庫存必須是整數/.test(error.message)
    );
  }
});

test('applyPreparedFlyingMouseWriteback climbs out of a negative stock', async () => {
  const reads = [part({ stock: -1 }), part({ stock: 1 })];
  const puts = [];
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart(id, payload) { puts.push({ id, payload }); }
  };

  const result = await applyPreparedFlyingMouseWriteback({
    client,
    event: preparedEvent({ beforeStock: -1, targetStock: 1 }),
    mode: 'live'
  });

  assert.deepEqual(result, { action: 'applied', partId: 933, beforeStock: -1, targetStock: 1 });
  assert.deepEqual(puts.map((entry) => entry.payload.stock), [1]);
});

test('applyPreparedFlyingMouseWriteback sends no PUT when the target is still negative', async () => {
  const puts = [];
  const client = {
    async getBySku() { return part({ stock: -5 }); },
    async putPart(id, payload) { puts.push(payload.stock); }
  };

  // 飛鼠存檔會把負數正規化為 0，送 −3 等於把 5 個超賣帳無聲抹掉。
  await assert.rejects(applyPreparedFlyingMouseWriteback({
    client,
    event: preparedEvent({ beforeStock: -5, targetStock: -3 }),
    mode: 'live'
  }), (error) => error instanceof FlyingMouseWritebackError &&
    error.code === 'NEGATIVE_TARGET_STOCK' && error.manualReview === true);
  assert.deepEqual(puts, []);
});

test('prepareFlyingMouseWriteback refuses to queue a target that stays negative', async () => {
  const client = { async getBySku() { return part({ stock: -5 }); } };

  await assert.rejects(prepareFlyingMouseWriteback({
    client,
    event: pendingEvent({ receivedQuantity: 2 })
  }), (error) => error instanceof FlyingMouseWritebackError &&
    error.code === 'NEGATIVE_TARGET_STOCK' && error.manualReview === true);

  // 補得滿就照常準備：−5 收 5 件剛好回到 0。
  assert.deepEqual(await prepareFlyingMouseWriteback({
    client,
    event: pendingEvent({ receivedQuantity: 5 })
  }), { partId: 933, beforeStock: -5, targetStock: 0 });
});

test('prepareFlyingMouseWriteback reads an exact SKU and computes before and target', async () => {
  const client = { async getBySku() { return part(); } };

  const result = await prepareFlyingMouseWriteback({ client, event: pendingEvent() });

  assert.deepEqual(result, { partId: 933, beforeStock: 10, targetStock: 12 });
});

test('applyPreparedFlyingMouseWriteback performs PUT then verifies the exact target', async () => {
  const reads = [part(), part({ stock: 12 })];
  const puts = [];
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart(id, payload) { puts.push({ id, payload }); }
  };

  const result = await applyPreparedFlyingMouseWriteback({
    client,
    event: preparedEvent(),
    mode: 'live'
  });

  assert.deepEqual(result, { action: 'applied', partId: 933, beforeStock: 10, targetStock: 12 });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].id, 933);
  assert.equal(puts[0].payload.stock, 12);
  assert.equal(puts[0].payload.op_remark, '既有備註');
});

test('applyPreparedFlyingMouseWriteback treats an existing target as already applied', async () => {
  let puts = 0;
  const client = {
    async getBySku() { return part({ stock: 12 }); },
    async putPart() { puts += 1; }
  };

  const result = await applyPreparedFlyingMouseWriteback({
    client,
    event: preparedEvent(),
    mode: 'live'
  });

  assert.equal(result.action, 'already-applied');
  assert.equal(puts, 0);
});

test('applyPreparedFlyingMouseWriteback never PUTs an ambiguous current stock', async () => {
  let puts = 0;
  const client = {
    async getBySku() { return part({ stock: 11 }); },
    async putPart() { puts += 1; }
  };

  await assert.rejects(
    applyPreparedFlyingMouseWriteback({ client, event: preparedEvent(), mode: 'live' }),
    (error) => error instanceof FlyingMouseWritebackError &&
      error.code === 'AMBIGUOUS_STOCK' && error.manualReview === true
  );
  assert.equal(puts, 0);
});

test('dry-run calculates the update but guarantees PUT is never called', async () => {
  let puts = 0;
  const client = {
    async getBySku() { return part(); },
    async putPart() { puts += 1; }
  };

  const result = await applyPreparedFlyingMouseWriteback({
    client,
    event: preparedEvent(),
    mode: 'dry-run'
  });

  assert.deepEqual(result, { action: 'dry-run', partId: 933, beforeStock: 10, targetStock: 12 });
  assert.equal(puts, 0);
});

test('verification mismatch becomes manual review instead of another PUT', async () => {
  const reads = [part(), part({ stock: 13 })];
  let puts = 0;
  const client = {
    async getBySku() { return reads.shift(); },
    async putPart() { puts += 1; }
  };

  await assert.rejects(
    applyPreparedFlyingMouseWriteback({ client, event: preparedEvent(), mode: 'live' }),
    (error) => error instanceof FlyingMouseWritebackError &&
      error.code === 'VERIFY_MISMATCH' && error.manualReview === true
  );
  assert.equal(puts, 1);
});

test('createFlyingMousePartClient uses only the scoped part endpoints', async () => {
  const requests = [];
  const page = {
    async evaluate(_fn, input) {
      requests.push(input);
      return input.method === 'GET'
        ? { status: 200, body: { part: part() } }
        : { status: 200, body: { code: 0 } };
    }
  };
  const client = createFlyingMousePartClient(page);

  assert.equal((await client.getBySku('SKU A')).id, 933);
  await client.putPart(933, buildPartUpdatePayload(part(), 12));

  assert.equal(requests[0].path, '/api/admin/part/no/SKU%20A');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[1].path, '/api/admin/part/id/933');
  assert.equal(requests[1].method, 'PUT');
});

test('createFlyingMousePartClient classifies 5xx as retryable without response details', async () => {
  const client = createFlyingMousePartClient({
    async evaluate() { return { status: 503, body: { secret: 'do-not-expose' } }; }
  });

  await assert.rejects(
    client.getBySku('SKU-A'),
    (error) => error.code === 'HTTP_503' && error.retryable === true &&
      !error.message.includes('do-not-expose')
  );
});
