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
      async saveNotificationGroupId(groupId) {
        calls.groups.push(groupId);
        return calls.groupAllowed !== false;
      },
      async listRequestRows() {
        calls.statusReads = (calls.statusReads ?? 0) + 1;
        return calls.rows ?? [];
      },
      async listAvailableSkus() { return []; },
      async listOpenRequests() { return []; }
    },
    identityVerifier: { async verify() { return { userId: 'U1' }; } },
    messenger: {
      async replyReplenishmentLink(replyToken, url) { calls.links.push({ replyToken, url }); },
      async replyText(replyToken, text) { calls.texts.push({ replyToken, text }); },
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
