import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

async function start(t, calls) {
  const app = createApp({
    config: { liffId: 'liff-123', linkSigningSecret: 'link-secret', lineChannelSecret: 'line-secret' },
    repository: {
      async checkHealth() { return true; },
      async saveNotificationGroupId(groupId) {
        calls.groups.push(groupId);
        return calls.groupAllowed !== false;
      },
      async listRequestRows() {
        calls.statusReads = (calls.statusReads ?? 0) + 1;
        return calls.rows ?? [];
      },
      async getAuthorization(userId) {
        calls.authReads ??= [];
        calls.authReads.push(userId);
        return calls.authorizations?.[userId] ?? { role: '申請人', enabled: true, exists: false };
      },
      async updateAuthorization(input) {
        calls.authWrites ??= [];
        calls.authWrites.push(input);
        return { role: input.role ?? '申請人', enabled: input.enabled, idempotentReplay: false };
      },
      async getRequestForCancellation(requestId) {
        calls.cancelReads ??= [];
        calls.cancelReads.push(requestId);
        return calls.cancellationContext ?? {
          requestId,
          requesterUserId: 'OWNER',
          groupId: 'COMPANY',
          items: [{ sku: 'SKU-A', status: '待確認' }]
        };
      },
      async cancelRequest(input) {
        calls.cancelWrites ??= [];
        calls.cancelWrites.push(input);
        return {
          requestId: input.requestId,
          items: [{ sku: 'SKU-A', status: '取消' }],
          idempotentReplay: false
        };
      },
      async listAvailableSkus() { return []; },
      async listOpenRequests() { return []; }
    },
    identityVerifier: { async verify() { return { userId: 'U1' }; } },
    messenger: {
      async replyReplenishmentLink(replyToken, url) { calls.links.push({ replyToken, url }); },
      async replyText(replyToken, text) { calls.texts.push({ replyToken, text }); },
      async getGroupMemberProfile(groupId, userId) {
        calls.profileReads ??= [];
        calls.profileReads.push({ groupId, userId });
        return { displayName: calls.profileNames?.[userId] ?? 'LINE 成員' };
      },
      async pushRequestCreated() {}
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('webhook accepts a valid signature and returns a signed LIFF link', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-123',
    source: { type: 'group', groupId: 'C123' },
    message: { type: 'text', text: '補貨' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': sign(body, 'line-secret')
    },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.groups, ['C123']);
  assert.equal(calls.links[0].replyToken, 'reply-123');
  assert.match(calls.links[0].url, /^https:\/\/liff\.line\.me\/liff-123\?ctx=/);
});

test('webhook rejects an invalid signature before parsing events', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid' },
    body: JSON.stringify({ events: [] })
  });
  assert.equal(response.status, 401);
  assert.equal(calls.links.length, 0);
});

test('webhook keeps the existing private-chat guidance for the replenishment command', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-private',
    source: { type: 'user', userId: 'U1' },
    message: { type: 'text', text: '補貨' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.texts, [{
    replyToken: 'reply-private',
    text: '請在公司的 LINE 工作群組輸入「補貨」。'
  }]);
});

test('webhook replies with request-level status in the company group', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    rows: [
      { requestId: 'RQ-1', requestedAt: 2, applicant: '小明', displayName: '商品 A', status: '待確認' },
      { requestId: 'RQ-1', requestedAt: 2, applicant: '小明', displayName: '商品 B', status: '待確認' }
    ]
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-status',
    source: { type: 'group', groupId: 'COMPANY' },
    message: { type: 'text', text: '查未結案' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(calls.statusReads, 1);
  assert.equal(calls.texts.length, 1);
  assert.match(calls.texts[0].text, /【未結案】共 1 筆/);
  assert.match(calls.texts[0].text, /RQ-1｜待確認｜小明｜2 項/);
});

test('webhook rejects a command from another group without reading requests', async (t) => {
  const calls = { groups: [], links: [], texts: [], groupAllowed: false };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-other',
    source: { type: 'group', groupId: 'OTHER' },
    message: { type: 'text', text: '查已下單' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(calls.statusReads, undefined);
  assert.match(calls.texts[0].text, /未授權/);
});

test('webhook lets an administrator grant a mentioned member role', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    authorizations: { ADMIN: { role: '管理員', enabled: true, exists: true } },
    profileNames: { TARGET: '小明' }
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-1234567890',
    replyToken: 'reply-auth',
    source: { type: 'group', groupId: 'COMPANY', userId: 'ADMIN' },
    message: {
      id: 'message-1',
      type: 'text',
      text: '授權 @小明 採購確認',
      mention: { mentionees: [{ type: 'user', userId: 'TARGET', isSelf: false, index: 3, length: 3 }] }
    }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.profileReads, [{ groupId: 'COMPANY', userId: 'TARGET' }]);
  assert.deepEqual(calls.authWrites[0], {
    actor: { userId: 'ADMIN' },
    target: { userId: 'TARGET', displayName: '小明' },
    role: '採購確認',
    enabled: true,
    idempotencyKey: 'line-event-1234567890'
  });
  assert.match(calls.texts[0].text, /已授權小明/);
});

test('webhook returns a friendly reply when a non-admin tries to authorize', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-0987654321',
    replyToken: 'reply-denied',
    source: { type: 'group', groupId: 'COMPANY', userId: 'MEMBER' },
    message: {
      id: 'message-2',
      type: 'text',
      text: '停用 @小明',
      mention: { mentionees: [{ type: 'user', userId: 'TARGET', isSelf: false }] }
    }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(calls.authWrites, undefined);
  assert.match(calls.texts[0].text, /只有已啟用的管理員/);
});

test('webhook lets the original applicant cancel a pending request', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    profileNames: { OWNER: '小明' }
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-cancel-123456',
    replyToken: 'reply-cancel',
    source: { type: 'group', groupId: 'COMPANY', userId: 'OWNER' },
    message: { type: 'text', text: '取消補貨 RQ-20260715-123456-abcd' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.cancelWrites, [{
    actor: { userId: 'OWNER' },
    requestId: 'RQ-20260715-123456-abcd',
    idempotencyKey: 'line-event-cancel-123456'
  }]);
  assert.match(calls.texts[0].text, /已取消補貨單 RQ-20260715-123456-abcd/);
  assert.match(calls.texts[0].text, /操作人：小明/);
});

test('webhook refuses a cancellation event without an idempotency identifier', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-cancel-missing-id',
    source: { type: 'group', groupId: 'COMPANY', userId: 'OWNER' },
    message: { type: 'text', text: '取消補貨 RQ-20260715-123456-abcd' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(calls.cancelWrites, undefined);
  assert.match(calls.texts[0].text, /缺少識別碼/);
});
