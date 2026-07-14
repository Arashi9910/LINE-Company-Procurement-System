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

test('loadConfig rejects an invalid port', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', SPREADSHEET_ID: 'sheet-123', PORT: '99999' }),
    /PORT/
  );
});
