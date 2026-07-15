import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

function dependencies(checkHealth = async () => true) {
  return {
    config: {
      liffId: 'test-liff',
      serviceName: 'line-replenishment',
      appVersion: '0.1.0+abc123def456',
      gitCommit: 'abc123def456abc123def456abc123def456abcd',
      serviceRevision: 'line-replenishment-00013-xyz',
      deployedAt: '2026-07-15T07:30:00Z'
    },
    repository: { checkHealth },
    identityVerifier: { async verify() { return { userId: 'U1' }; } },
    messenger: {}
  };
}

async function start(t, app) {
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('health endpoint reports a healthy service', async (t) => {
  let readinessChecks = 0;
  const app = createApp(dependencies(async () => { readinessChecks += 1; }));
  const baseUrl = await start(t, app);
  const response = await fetch(`${baseUrl}/health`);
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
  assert.equal(readinessChecks, 0);
});

test('createApp rejects missing core dependencies instead of silently omitting routes', () => {
  const complete = dependencies();
  for (const name of ['repository', 'identityVerifier', 'messenger']) {
    const missing = { ...complete, [name]: undefined };
    assert.throws(() => createApp(missing), new RegExp(name));
  }
});

test('ready endpoint verifies Sheets and returns deployment metadata', async (t) => {
  let checks = 0;
  const app = createApp(dependencies(async () => { checks += 1; }));
  const baseUrl = await start(t, app);
  const response = await fetch(`${baseUrl}/ready`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(checks, 1);
  assert.equal(body.ok, true);
  assert.equal(body.commit, 'abc123def456abc123def456abc123def456abcd');
  assert.equal(body.revision, 'line-replenishment-00013-xyz');
});

test('ready endpoint returns 503 without exposing a Sheets failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = createApp(dependencies(async () => { throw new Error('private spreadsheet detail'); }));
  const baseUrl = await start(t, app);
  const response = await fetch(`${baseUrl}/ready`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.service, 'line-replenishment');
  assert.doesNotMatch(JSON.stringify(body), /private spreadsheet detail/);
});
