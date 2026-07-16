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
  assert.throws(() => expectedStock(-1, 2), /非負整數/);
  assert.throws(() => expectedStock(10, 0), /正整數/);
  assert.throws(() => expectedStock(Number.MAX_SAFE_INTEGER, 1), /安全整數/);

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
