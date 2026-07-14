import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

test('health endpoint reports a healthy service', async (t) => {
  const app = createApp({ config: { liffId: 'test-liff' } });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});
