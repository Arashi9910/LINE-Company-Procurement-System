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
      async saveNotificationGroupId(groupId) { calls.groups.push(groupId); },
      async listAvailableSkus() { return []; },
      async listOpenRequests() { return []; }
    },
    identityVerifier: { async verify() { return { userId: 'U1' }; } },
    messenger: {
      async replyReplenishmentLink(replyToken, url) { calls.links.push({ replyToken, url }); },
      async replyText() {},
      async pushRequestCreated() {}
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('webhook accepts a valid signature and returns a signed LIFF link', async (t) => {
  const calls = { groups: [], links: [] };
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
  const calls = { groups: [], links: [] };
  const baseUrl = await start(t, calls);
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid' },
    body: JSON.stringify({ events: [] })
  });
  assert.equal(response.status, 401);
  assert.equal(calls.links.length, 0);
});
