import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { purchaseFixture } from './helpers/purchase-fixture.js';

test('authenticated draft API persists a merged purchase without draft notifications or repeated submit pushes', async t => {
  const f = purchaseFixture();
  let pushes = 0;
  const app = createApp({ config: { purchaseDraftsEnabled: true }, repository: f.repository,
    identityVerifier: { verify: async token => ({ userId: token, displayName: '老闆' }) },
    messenger: { pushOrderConfirmed: async () => { pushes += 1; } } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const id = `D-${'a'.repeat(32)}`;
  async function call(path, body, token = 'boss') {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await call('/purchase-access')).body.enabled, true);
  assert.equal((await call('/purchase-drafts', null, 'employee')).status, 403);
  const created = await call(`/purchase-drafts/${id}/create`, { sourceIds: ['RQ-1', 'RQ-2'], idempotencyKey: 'api_create_key_123' });
  assert.equal(created.status, 200);
  assert.equal(pushes, 0);
  assert.equal((await call(`/purchase-drafts/${id}`, null, 'other')).status, 403);
  assert.equal((await call(`/purchase-drafts/${id}`)).body.items[0].quantity, 5);
  const saved = await call(`/purchase-drafts/${id}/save`, { version: 1, items: [{ sku: 'A', quantity: 6 }], expectedDate: '2026-10-01', idempotencyKey: 'api_save_key_12345' });
  assert.equal(saved.status, 200);
  assert.equal(pushes, 0);
  const command = { version: 2, idempotencyKey: 'api_submit_key_123' };
  const result = await call(`/purchase-drafts/${id}/submit`, command);
  assert.equal(result.status, 200);
  assert.equal(result.body.notification.sent, true);
  assert.equal((await call(`/purchase-drafts/${id}/submit`, command)).body.idempotentReplay, true);
  assert.equal(pushes, 1);
});
