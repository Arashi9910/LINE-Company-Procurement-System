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
    /LINE_CHANNEL_ID/
  );
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', SPREADSHEET_ID: 'sheet-123', PORT: '99999' }),
    /PORT/
  );
});
