import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

test('cutover maintenance rejects every write before auth and leaves health and static reads available', async t => {
  const app = createApp({ config: { maintenanceMode: true },
    repository: { checkHealth: async () => true },
    identityVerifier: { verify: async () => { throw new Error('must not authenticate a write'); } }, messenger: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/webhook', '/api/requests', '/jobs/reminders', '/api/purchase-drafts/id/submit']) {
    const response = await fetch(base + path, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await response.json()).error.code, 'MAINTENANCE');
  }
  assert.equal((await fetch(base + '/ready')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
});
