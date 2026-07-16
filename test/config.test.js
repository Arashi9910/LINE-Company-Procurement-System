import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig accepts a minimal test configuration', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SPREADSHEET_ID: 'sheet-123',
    PORT: '9090'
  });

  assert.equal(config.port, 9090);
  assert.equal(config.spreadsheetId, 'sheet-123');
  assert.equal(config.lineChannelSecret, '');
  assert.equal(config.flyingmouseWritebackEnabled, false);
});

test('loadConfig rejects missing production secrets', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SPREADSHEET_ID: 'sheet-123' }),
    /LINE_LOGIN_CHANNEL_ID/
  );
});

test('loadConfig uses the LINE Login channel ID for LIFF identity verification', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SPREADSHEET_ID: 'sheet-123',
    LINE_LOGIN_CHANNEL_ID: 'login-channel-123',
    LINE_CHANNEL_SECRET: 'messaging-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'messaging-token',
    LIFF_ID: 'liff-123',
    LINK_SIGNING_SECRET: 'signing-secret',
    JOB_TOKEN: 'job-token'
  });

  assert.equal(config.lineLoginChannelId, 'login-channel-123');
});

test('loadConfig exposes deployment metadata with safe local defaults', () => {
  const local = loadConfig({
    NODE_ENV: 'test',
    SPREADSHEET_ID: 'sheet-123'
  });
  assert.deepEqual({
    appVersion: local.appVersion,
    gitCommit: local.gitCommit,
    deployedAt: local.deployedAt,
    serviceName: local.serviceName,
    serviceRevision: local.serviceRevision
  }, {
    appVersion: '0.1.0',
    gitCommit: 'development',
    deployedAt: '',
    serviceName: 'line-replenishment',
    serviceRevision: ''
  });

  const deployed = loadConfig({
    NODE_ENV: 'test',
    SPREADSHEET_ID: 'sheet-123',
    APP_VERSION: '0.1.0+abc123def456',
    GIT_COMMIT: 'abc123def456abc123def456abc123def456abcd',
    DEPLOYED_AT: '2026-07-15T07:30:00Z',
    K_SERVICE: 'line-replenishment',
    K_REVISION: 'line-replenishment-00013-xyz'
  });
  assert.equal(deployed.appVersion, '0.1.0+abc123def456');
  assert.equal(deployed.gitCommit, 'abc123def456abc123def456abc123def456abcd');
  assert.equal(deployed.deployedAt, '2026-07-15T07:30:00Z');
  assert.equal(deployed.serviceRevision, 'line-replenishment-00013-xyz');
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', SPREADSHEET_ID: 'sheet-123', PORT: '99999' }),
    /PORT/
  );
});

test('loadConfig parses and validates the FlyingMouse writeback feature flag', () => {
  const enabled = loadConfig({
    NODE_ENV: 'test',
    SPREADSHEET_ID: 'sheet-123',
    FLYINGMOUSE_WRITEBACK_ENABLED: 'true'
  });
  assert.equal(enabled.flyingmouseWritebackEnabled, true);

  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      SPREADSHEET_ID: 'sheet-123',
      FLYINGMOUSE_WRITEBACK_ENABLED: 'yes'
    }),
    /FLYINGMOUSE_WRITEBACK_ENABLED/
  );
});
