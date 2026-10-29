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
      async reserveCatalogSyncTrigger(input) {
        calls.catalogReservations ??= [];
        calls.catalogReservations.push(input);
        return calls.catalogReservation ?? { idempotentReplay: false };
      },
      async listAvailableSkus() { return []; },
      async listOpenRequests() { return []; }
    },
    identityVerifier: { async verify() { return { userId: 'U1' }; } },
    messenger: {
      async replyReplenishmentLink(replyToken, url) { calls.links.push({ replyToken, url }); },
      async replyText(replyToken, text) { calls.texts.push({ replyToken, text }); },
      async replyStatusCards(replyToken, filter, result) {
        calls.statusCards ??= [];
        calls.statusCards.push({ replyToken, filter, result });
      },
      async getGroupMemberProfile(groupId, userId) {
        calls.profileReads ??= [];
        calls.profileReads.push({ groupId, userId });
        return { displayName: calls.profileNames?.[userId] ?? 'LINE 成員' };
      },
      async pushRequestCreated() {}
    },
    catalogSyncRunner: {
      async status() {
        calls.catalogStatusReads = (calls.catalogStatusReads ?? 0) + 1;
        if (calls.catalogStatusError) throw calls.catalogStatusError;
        return calls.catalogStatus ?? { state: 'never' };
      },
      async start() {
        calls.catalogStarts = (calls.catalogStarts ?? 0) + 1;
        if (calls.catalogStartError) throw calls.catalogStartError;
        return calls.catalogStartResult ?? {
          state: 'accepted', operation: 'operation-123', execution: 'execution-123'
        };
      }
    },
    dashboardReader: calls.dashboardReader
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

test('webhook replies with actionable request cards in the company group', async (t) => {
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
  assert.equal(calls.texts.length, 0);
  assert.deepEqual(calls.statusCards, [{
    replyToken: 'reply-status',
    filter: '未結案',
    result: {
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      items: [{
        requestId: 'RQ-1',
        requestedAt: 2,
        applicant: '小明',
        firstItem: '商品 A',
        itemCount: 2,
        status: '待確認'
      }]
    }
  }]);
});

test('webhook returns the requested status-card page', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    rows: Array.from({ length: 12 }, (_, index) => ({
      requestId: `RQ-${index + 1}`,
      requestedAt: index + 1,
      applicant: '小明',
      displayName: `商品 ${index + 1}`,
      status: '待確認'
    }))
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-status-page-2',
    source: { type: 'group', groupId: 'COMPANY' },
    message: { type: 'text', text: '查待確認 2' }
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
  assert.equal(calls.statusCards[0].result.page, 2);
  assert.equal(calls.statusCards[0].result.totalPages, 2);
  assert.deepEqual(
    calls.statusCards[0].result.items.map((item) => item.requestId),
    ['RQ-2', 'RQ-1']
  );
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

test('webhook lets purchasing staff cancel an ordered request', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    authorizations: { BUYER: { role: '採購確認', enabled: true, exists: true } },
    cancellationContext: {
      requestId: 'RQ-20260715-123456-abcd',
      requesterUserId: 'OWNER',
      groupId: 'COMPANY',
      items: [{ sku: 'SKU-A', status: '已下單' }]
    },
    profileNames: { BUYER: '採購小美' }
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-cancel-ordered-123456',
    replyToken: 'reply-cancel-ordered',
    source: { type: 'group', groupId: 'COMPANY', userId: 'BUYER' },
    message: { type: 'text', text: '取消採購 RQ-20260715-123456-abcd' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.cancelWrites, [{
    actor: { userId: 'BUYER' },
    requestId: 'RQ-20260715-123456-abcd',
    idempotencyKey: 'line-event-cancel-ordered-123456',
    mode: 'ordered'
  }]);
  assert.match(calls.texts[0].text, /已取消採購單 RQ-20260715-123456-abcd/);
  assert.match(calls.texts[0].text, /操作人：採購小美/);
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

test('webhook lets an administrator start FlyingMouse catalog sync once', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    authorizations: { ADMIN: { role: '管理員', enabled: true, exists: true } }
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-catalog-sync-123',
    replyToken: 'reply-catalog-sync',
    source: { type: 'group', groupId: 'COMPANY', userId: 'ADMIN' },
    message: { type: 'text', text: '同步飛鼠商品' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.catalogReservations, [{
    actor: { userId: 'ADMIN' },
    idempotencyKey: 'line-event-catalog-sync-123'
  }]);
  assert.equal(calls.catalogStarts, 1);
  assert.match(calls.texts[0].text, /已受理飛鼠商品同步/);
  assert.match(calls.texts[0].text, /execution-123/);
});

test('webhook lets an administrator query FlyingMouse catalog sync status', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    authorizations: { ADMIN: { role: '管理員', enabled: true, exists: true } },
    catalogStatus: {
      state: 'succeeded', execution: 'execution-456', completedAt: '2026-07-22T10:01:00Z'
    }
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    replyToken: 'reply-catalog-status',
    source: { type: 'group', groupId: 'COMPANY', userId: 'ADMIN' },
    message: { type: 'text', text: '查飛鼠同步' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.equal(calls.catalogStatusReads, 1);
  assert.equal(calls.catalogStarts, undefined);
  assert.match(calls.texts[0].text, /同步成功/);
  assert.match(calls.texts[0].text, /execution-456/);
});

test('webhook returns a safe reply when the FlyingMouse catalog job API fails', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    authorizations: { ADMIN: { role: '管理員', enabled: true, exists: true } },
    catalogStartError: Object.assign(new Error('private project id and API detail'), { status: 403 })
  };
  const baseUrl = await start(t, calls);
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: 'event-catalog-sync-failed',
    replyToken: 'reply-catalog-failed',
    source: { type: 'group', groupId: 'COMPANY', userId: 'ADMIN' },
    message: { type: 'text', text: '同步飛鼠商品' }
  }] });
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });

  assert.equal(response.status, 200);
  assert.match(calls.texts[0].text, /同步服務暫時無法使用/);
  assert.doesNotMatch(calls.texts[0].text, /private project id/);
});

function dashboardFixture(overrides = {}) {
  return {
    syncStatus: { status: '正常', lastSuccessAt: '2026-10-29 17:00:00', lastAttemptAt: '2026-10-29 17:00:00', message: '' },
    rows: [
      {
        sku: 'SKU-A', displayName: '雨傘 大', flyingmouseStock: 7, processing: 3, preparing: 0,
        unshipped: 3, onOrder: 0, preorderAllowance: 10, safetyStock: 0,
        estimatedStock: 0, gap: 3, status: '要叫貨', note: '', updatedAt: '2026-10-29 17:00:00'
      },
      {
        sku: 'SKU-B', displayName: '雨衣', flyingmouseStock: 20, processing: 0, preparing: 0,
        unshipped: 0, onOrder: 0, preorderAllowance: 0, safetyStock: 0,
        estimatedStock: 20, gap: -20, status: '正常', note: '', updatedAt: '2026-10-29 17:00:00'
      }
    ],
    ...overrides
  };
}

async function sendText(baseUrl, text) {
  const body = JSON.stringify({ events: [{
    type: 'message',
    webhookEventId: `event-${encodeURIComponent(text)}`,
    replyToken: `reply-${encodeURIComponent(text)}`,
    source: { type: 'group', groupId: 'COMPANY', userId: 'U1' },
    message: { type: 'text', text }
  }] });
  return fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(body, 'line-secret') },
    body
  });
}

test('webhook answers 查缺貨 from the dashboard, not the status cards', async (t) => {
  const calls = { groups: [], links: [], texts: [], dashboardReader: async () => dashboardFixture() };
  const baseUrl = await start(t, calls);

  const response = await sendText(baseUrl, '查缺貨');

  assert.equal(response.status, 200);
  // 計畫步驟 6 的重點：沒有明確分派的話會掉進 listRequestRows → 回出補貨狀態卡片。
  assert.equal(calls.statusReads, undefined, '不該去讀補貨追蹤');
  assert.equal(calls.statusCards, undefined, '不該回狀態卡片');
  assert.match(calls.texts[0].text, /要叫貨 1 個/);
  assert.match(calls.texts[0].text, /雨傘 大/);
  assert.match(calls.texts[0].text, /缺口 3/);
});

test('webhook answers 查庫存 with the four numbers for a keyword', async (t) => {
  const calls = { groups: [], links: [], texts: [], dashboardReader: async () => dashboardFixture() };
  const baseUrl = await start(t, calls);

  await sendText(baseUrl, '查庫存 雨衣');

  assert.equal(calls.statusCards, undefined);
  const reply = calls.texts[0].text;
  assert.match(reply, /SKU SKU-B/);
  assert.match(reply, /飛鼠 20/);
  assert.equal(reply.includes('雨傘'), false, '關鍵字不符的不該出現');
});

test('webhook marks the reply as stale while the dashboard sync is failing', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    dashboardReader: async () => dashboardFixture({
      syncStatus: {
        status: '同步失敗',
        lastSuccessAt: '2026-10-29 16:00:00',
        lastAttemptAt: '2026-10-29 17:00:00',
        message: '飛鼠登入逾時'
      }
    })
  };
  const baseUrl = await start(t, calls);

  await sendText(baseUrl, '查缺貨');

  // 規格第 5 節：同步失敗期間要標明資料是上一次成功的結果與時間。
  assert.match(calls.texts[0].text, /同步失敗/);
  assert.match(calls.texts[0].text, /2026-10-29 16:00:00/);
});

test('webhook explains itself when the dashboard cannot be read', async (t) => {
  const calls = {
    groups: [], links: [], texts: [],
    dashboardReader: async () => { throw new Error('Unable to parse range: 庫存看板'); }
  };
  const baseUrl = await start(t, calls);

  await sendText(baseUrl, '查缺貨');

  // 不可以把原始錯誤丟給群組。
  assert.match(calls.texts[0].text, /讀不到庫存看板/);
  assert.equal(calls.texts[0].text.includes('Unable to parse range'), false);
});

test('webhook says the dashboard is off when no reader is wired', async (t) => {
  const calls = { groups: [], links: [], texts: [] };
  const baseUrl = await start(t, calls);

  await sendText(baseUrl, '查缺貨');

  assert.match(calls.texts[0].text, /尚未啟用/);
  assert.equal(calls.statusCards, undefined);
});

test('查庫存 without a keyword asks for one instead of listing everything', async (t) => {
  const calls = { groups: [], links: [], texts: [], dashboardReader: async () => dashboardFixture() };
  const baseUrl = await start(t, calls);

  await sendText(baseUrl, '查庫存');

  assert.match(calls.texts[0].text, /請輸入要查的 SKU 或關鍵字/);
});
