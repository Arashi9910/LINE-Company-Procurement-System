import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWritebackArguments,
  runFlyingMouseInventoryWriteback
} from '../scripts/flyingmouse-inventory-writeback.mjs';
import { WRITEBACK_HEADERS } from '../src/flyingmouse/sheets-writeback.js';

test('parseWritebackArguments defaults to dry-run and requires an explicit live mode', () => {
  assert.deepEqual(parseWritebackArguments([], { SPREADSHEET_ID: 'sheet-123' }), {
    spreadsheetId: 'sheet-123',
    mode: 'dry-run',
    limit: 20,
    credentials: '.env.flyingmouse-login.txt',
    ensureSheet: false,
    setupOnly: false,
    headless: true,
    help: false
  });
  assert.equal(parseWritebackArguments([
    '--spreadsheet-id', 'sheet-456', '--mode', 'live', '--limit', '5', '--ensure-sheet'
  ], {}).mode, 'live');
  assert.throws(
    () => parseWritebackArguments(['--spreadsheet-id', 'sheet-123', '--mode', 'unsafe'], {}),
    /dry-run 或 live/
  );
  assert.throws(() => parseWritebackArguments([], {}), /SPREADSHEET_ID/);
});

test('runFlyingMouseInventoryWriteback skips login when the queue is empty', async () => {
  let configCalls = 0;
  const sheets = {
    spreadsheets: {
      values: {
        async get() { return { data: { values: [WRITEBACK_HEADERS] } }; }
      }
    }
  };
  const result = await runFlyingMouseInventoryWriteback({
    spreadsheetId: 'sheet-123',
    mode: 'dry-run',
    limit: 20,
    credentials: '.env.flyingmouse-login.txt',
    ensureSheet: false,
    setupOnly: false,
    headless: true,
    help: false
  }, {
    sheetsFactory: () => sheets,
    async configFactory() { configCalls += 1; },
    now: () => new Date('2026-07-16T02:05:00Z'),
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(result.found, 0);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.sheetCreated, false);
  assert.equal(configCalls, 0);
});
