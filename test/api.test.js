import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createGroupContext } from '../src/line/context.js';

function fixture() {
  const calls = { create: [], push: [] };
  const repository = {
    async listAvailableSkus() {
      return [{ sku: 'SKU-A', displayName: '商品 A', unit: '件' }];
    },
    async listOpenRequests() { return [{ sku: 'SKU-A' }]; },
    async getNotificationGroupId() { return 'C-FALLBACK'; },
    async listReminderCandidates() { return []; },
    async reserveReminder() { return true; },
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
      return { requestId: input.requestId, groupId: 'C123', items: [], idempotentReplay: false };
    },
    async confirmReceipt(input) {
      return { requestId: input.requestId, groupId: 'C123', items: [], idempotentReplay: false };
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
  return { calls, repository, identityVerifier, messenger, config };
}

async function start(t, dependencies) {
  const server = createApp(dependencies).listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

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
  assert.equal(dependencies.calls.create[0].groupId, 'C123');
  assert.equal(dependencies.calls.push[0][0], 'C123');
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
      items: [{ sku: 'SKU-A', orderedQuantity: 2, expectedDate: '2026-07-20' }],
      idempotencyKey: 'order-key-123456'
    })
  });
  assert.equal(order.status, 201);

  const receipt = await fetch(`${baseUrl}/api/requests/RQ-1/receipt`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-A', receivedQuantity: 1 }],
      idempotencyKey: 'receipt-key-1234'
    })
  });
  assert.equal(receipt.status, 201);
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
