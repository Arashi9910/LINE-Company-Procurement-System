import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createGroupContext } from '../src/line/context.js';
import { PILOT_COUNT_SKU, readCountPreview } from '../src/sheets/count-preview.js';
import { WRITEBACK_HEADERS, buildWritebackEvent, writebackEventRow } from '../src/flyingmouse/sheets-writeback.js';

function fixture() {
  const calls = {
    create: [], order: [], receipt: [], push: [], approvedImports: 0,
    writebackStarts: 0, sequence: []
  };
  const repository = {
    async checkHealth() { return true; },
    async listAvailableSkus() {
      return [{ sku: 'SKU-A', displayName: '商品 A', unit: '件' }];
    },
    async listOpenRequests() { return [{ sku: 'SKU-A' }]; },
    async getNotificationGroupId() { return 'C-FALLBACK'; },
    async listReminderCandidates() { return []; },
    async reserveReminder() { return true; },
    async importApprovedCatalogSnapshots() {
      calls.approvedImports += 1;
      return { approved: 1, imported: 1, idempotent: 0, stale: 0 };
    },
    async getAuthorization() { return { role: '管理員', enabled: true }; },
    async getRequest(requestId) {
      return {
        requestId,
        groupId: 'C123',
        items: [{ sku: 'SKU-A', status: '待確認', requestedQuantity: 2 }]
      };
    },
    async createRequest(input) {
      calls.create.push(input);
      return { requestId: 'RQ-TEST', idempotentReplay: false, items: [{
        sku: 'SKU-A', displayName: '商品 A', quantity: 2, unit: '件', duplicateWarning: true
      }] };
    },
    async confirmOrder(input) {
      calls.order.push(input);
      return { requestId: input.requestId, groupId: 'C123', items: [], idempotentReplay: false };
    },
    async confirmReceipt(input) {
      calls.receipt.push(input);
      calls.sequence.push('receipt-saved');
      return calls.receiptResult ?? {
        requestId: input.requestId, groupId: 'C123', items: [], idempotentReplay: false
      };
    }
  };
  const identityVerifier = {
    async verify(token) {
      assert.equal(token, 'valid-token');
      return { userId: 'U123', displayName: '小明' };
    }
  };
  const messenger = {
    async pushRequestCreated(...args) { calls.push.push(args); },
    async pushOrderConfirmed(...args) { calls.push.push(args); },
    async pushReceiptConfirmed(...args) { calls.push.push(args); },
    async pushReminder(...args) { calls.push.push(args); },
    async replyReplenishmentLink() {},
    async replyText() {}
  };
  const config = {
    liffId: 'liff-123',
    linkSigningSecret: 'link-secret',
    lineChannelSecret: 'line-secret',
    jobToken: 'test-job-token'
  };
  const writebackRunner = {
    async start() {
      calls.writebackStarts += 1;
      calls.sequence.push('writeback-started');
      if (calls.writebackStartError) throw calls.writebackStartError;
      return { state: 'accepted', operation: 'operation-123', execution: 'writeback-run-123' };
    }
  };
  return { calls, repository, identityVerifier, messenger, config, writebackRunner };
}

async function start(t, dependencies) {
  const server = createApp(dependencies).listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('盤點預覽只向有權限的明細讀取顯示一般款，讀取錯誤保留單據', async t => {
  const deps = fixture();
  deps.repository.getRequest = async () => ({ requestId: 'RQ-T', items: [{ sku: PILOT_COUNT_SKU }, { sku: 'OTHER' }] });
  let reads = 0;
  deps.repository.getCountPreview = async () => { reads++; return { physical: 9 }; };
  const base = await start(t, deps);
  const read = async suffix => (await fetch(base + '/api/requests/RQ-T' + suffix, {
    headers: { authorization: 'Bearer valid-token' }
  })).json();
  assert.equal((await read('')).items[0].countPreview, undefined);
  const preview = await read('?preview=count');
  assert.equal(preview.items[0].countPreview.physical, 9);
  assert.equal(preview.items[1].countPreview, undefined);
  deps.repository.getAuthorization = async () => ({ role: '申請人', enabled: true });
  assert.equal((await read('?preview=count')).items[0].countPreview, undefined);
  assert.equal(reads, 1);
  deps.repository.getAuthorization = async () => ({ role: '採購確認', enabled: true });
  deps.repository.getCountPreview = async () => { throw Error('offline'); };
  assert.equal((await read('?preview=count')).items[0].countPreview.unavailable, true);
});

test('正式盤點表依 SKU、台北盤點時間切分已登記到貨，不推估實寄或結餘', async () => {
  const time = (Date.UTC(2026, 10, 2, 18, 19) - Date.UTC(1899, 11, 30)) / 86400000;
  const header = ['紀錄類型', 'SKU', '規格', '盤點基準時間（台北）', '實盤件數', '關聯單號', '依據與適用範圍'];
  const counts = [header, ['實盤起點', PILOT_COUNT_SKU, '一般款', time, 9],
    ['排除舊單', PILOT_COUNT_SKU, '一般款', time, '', 'old-order']];
  function event(clock, qty, sku = PILOT_COUNT_SKU) {
    return writebackEventRow(buildWritebackEvent({ sku, createdAt: new Date('2026-11-02T' + clock + '+08:00'),
      idempotencyKey: 'simulation-pilot-' + qty, requestId: 'test', actorUserId: 'test', receivedQuantity: qty }));
  }
  const receipts = [WRITEBACK_HEADERS, event('17:27:03', 5), event('19:00:00', 4), event('19:01:00', 7, 'other')];
  const deps = { sheets: { spreadsheets: { values: { batchGet: async () => ({
    data: { valueRanges: [{ values: counts }, { values: receipts }] }
  }) } } }, spreadsheetId: 'test' };
  assert.deepEqual(await readCountPreview(deps), { countedAt: '2026-11-02 18:19', physical: 9, received: 4, excludedOrders: ['old-order'] });
  receipts.push(event('18:19:30', 1));
  await assert.rejects(readCountPreview(deps), /同分鐘/);
});

test('SKU API requires LINE authentication and returns duplicate counts', async (t) => {
  const dependencies = fixture();
  const baseUrl = await start(t, dependencies);
  const unauthorized = await fetch(`${baseUrl}/api/skus`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/skus`, {
    headers: { authorization: 'Bearer valid-token' }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items[0].openCount, 1);
});

test('request API verifies the signed group context and pushes a summary', async (t) => {
  const dependencies = fixture();
  const baseUrl = await start(t, dependencies);
  const contextToken = createGroupContext({ groupId: 'C123' }, 'link-secret');
  const response = await fetch(`${baseUrl}/api/requests`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', quantity: 2 }],
      idempotencyKey: 'abcdefghijklmnop',
      contextToken
    })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.requestId, 'RQ-TEST');
  assert.deepEqual(body.notification, { sent: true });
  assert.equal(dependencies.calls.create[0].groupId, 'C123');
  assert.equal(dependencies.calls.push[0][0], 'C123');
});

test('request API reports LINE quota failures without losing the created request', async (t) => {
  const dependencies = fixture();
  t.mock.method(console, 'warn', () => {});
  dependencies.messenger.pushRequestCreated = async () => {
    const error = new Error('429 - Too Many Requests');
    error.status = 429;
    error.body = JSON.stringify({ message: 'You have reached your monthly limit.' });
    throw error;
  };
  const baseUrl = await start(t, dependencies);
  const response = await fetch(`${baseUrl}/api/requests`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', quantity: 2 }],
      idempotencyKey: 'quota-failure-key',
      contextToken: createGroupContext({ groupId: 'C123' }, 'link-secret')
    })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.requestId, 'RQ-TEST');
  assert.deepEqual(body.notification, { sent: false, reason: 'quota_exceeded' });
  assert.equal(dependencies.calls.create.length, 1);
});

test('workflow API returns role and enforces order and receipt service paths', async (t) => {
  const dependencies = fixture();
  const baseUrl = await start(t, dependencies);
  const details = await fetch(`${baseUrl}/api/requests/RQ-1`, {
    headers: { authorization: 'Bearer valid-token' }
  });
  const detailBody = await details.json();
  assert.equal(details.status, 200);
  assert.equal(detailBody.actorRole, '管理員');

  const order = await fetch(`${baseUrl}/api/requests/RQ-1/order`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { sku: 'SKU-A', orderedQuantity: 2, expectedDate: '2026-07-20' },
        { sku: 'SKU-B', orderedQuantity: 1, expectedDate: '2026-07-21' }
      ],
      idempotencyKey: 'order-key-123456'
    })
  });
  assert.equal(order.status, 201);
  assert.deepEqual(dependencies.calls.order[0].items.map((item) => item.sku), ['SKU-A', 'SKU-B']);

  const receipt = await fetch(`${baseUrl}/api/requests/RQ-1/receipt`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { sku: 'SKU-A', receivedQuantity: 1 },
        { sku: 'SKU-B', receivedQuantity: 0 }
      ],
      idempotencyKey: 'receipt-key-1234'
    })
  });
  assert.equal(receipt.status, 201);
  const receiptBody = await receipt.json();
  assert.deepEqual(receiptBody.writebackTrigger, {
    started: true,
    operation: 'operation-123',
    execution: 'writeback-run-123'
  });
  assert.equal(dependencies.calls.writebackStarts, 1);
  assert.deepEqual(dependencies.calls.sequence, ['receipt-saved', 'writeback-started']);
  assert.deepEqual(dependencies.calls.receipt[0].items, [{ sku: 'SKU-A', receivedQuantity: 1 }]);
});

test('receipt API does not trigger writeback again for an idempotent replay', async (t) => {
  const dependencies = fixture();
  dependencies.calls.receiptResult = {
    requestId: 'RQ-1', groupId: 'C123', items: [], idempotentReplay: true
  };
  const baseUrl = await start(t, dependencies);

  const response = await fetch(`${baseUrl}/api/requests/RQ-1/receipt`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', receivedQuantity: 1 }],
      idempotencyKey: 'receipt-replay-key'
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.writebackTrigger, { started: false, reason: 'idempotent_replay' });
  assert.equal(dependencies.calls.writebackStarts, 0);
});

test('receipt API preserves the receipt when writeback is already running', async (t) => {
  const dependencies = fixture();
  const error = new Error('writeback is already running');
  error.code = 'CONFLICT';
  dependencies.calls.writebackStartError = error;
  t.mock.method(console, 'warn', () => {});
  const baseUrl = await start(t, dependencies);

  const response = await fetch(`${baseUrl}/api/requests/RQ-1/receipt`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', receivedQuantity: 1 }],
      idempotencyKey: 'receipt-active-job'
    })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.writebackTrigger, { started: false, reason: 'already_running' });
  assert.equal(dependencies.calls.receipt.length, 1);
});

test('receipt API preserves the receipt when the immediate trigger fails', async (t) => {
  const dependencies = fixture();
  dependencies.calls.writebackStartError = new Error('temporary Cloud Run API failure');
  t.mock.method(console, 'warn', () => {});
  const baseUrl = await start(t, dependencies);

  const response = await fetch(`${baseUrl}/api/requests/RQ-1/receipt`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', receivedQuantity: 1 }],
      idempotencyKey: 'receipt-trigger-failure'
    })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.writebackTrigger, { started: false, reason: 'trigger_failed' });
  assert.equal(dependencies.calls.receipt.length, 1);
});

test('reminder job rejects missing credentials and accepts the scheduler token', async (t) => {
  const dependencies = fixture();
  const baseUrl = await start(t, dependencies);
  const denied = await fetch(`${baseUrl}/jobs/reminders`, { method: 'POST' });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/jobs/reminders`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-job-token' }
  });
  const body = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.deepEqual(body, { candidates: 0, sent: [] });
});

test('approved catalog import job is token-protected and returns its import summary', async (t) => {
  const dependencies = fixture();
  const baseUrl = await start(t, dependencies);
  const denied = await fetch(`${baseUrl}/jobs/flyingmouse-approved-imports`, { method: 'POST' });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/jobs/flyingmouse-approved-imports`, {
    method: 'POST',
    headers: { 'x-job-token': 'test-job-token' }
  });
  const body = await accepted.json();

  assert.equal(accepted.status, 200);
  assert.deepEqual(body, { approved: 1, imported: 1, idempotent: 0, stale: 0 });
  assert.equal(dependencies.calls.approvedImports, 1);
});
