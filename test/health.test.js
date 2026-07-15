import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

test('health endpoint reports a healthy service', async (t) => {
  const app = createApp({
    config: {
      liffId: 'test-liff',
      serviceName: 'line-replenishment',
      appVersion: '0.1.0+abc123def456',
      gitCommit: 'abc123def456abc123def456abc123def456abcd',
      serviceRevision: 'line-replenishment-00013-xyz',
      deployedAt: '2026-07-15T07:30:00Z'
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    service: 'line-replenishment',
    version: '0.1.0+abc123def456',
    commit: 'abc123def456abc123def456abc123def456abcd',
    revision: 'line-replenishment-00013-xyz',
    deployedAt: '2026-07-15T07:30:00Z'
  });
});
