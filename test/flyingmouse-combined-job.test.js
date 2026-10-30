import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlyingMouseCombinedOptions,
  runFlyingMouseCombinedJob
} from '../scripts/flyingmouse-combined-job.mjs';

test('createFlyingMouseCombinedOptions builds the production-safe two-phase configuration', () => {
  const options = createFlyingMouseCombinedOptions({
    SPREADSHEET_ID: 'sheet-123',
    FLYINGMOUSE_SHEET_MODE: 'auto',
    FLYINGMOUSE_WRITEBACK_MODE: 'live',
    FLYINGMOUSE_WRITEBACK_LIMIT: '12'
  });

  assert.equal(options.catalog.spreadsheetId, 'sheet-123');
  assert.equal(options.catalog.sheetMode, 'auto');
  assert.equal(options.catalog.downloadDir, '/tmp/flyingmouse/downloads');
  assert.equal(options.catalog.outputDir, '/tmp/flyingmouse/previews');
  assert.equal(options.writeback.spreadsheetId, 'sheet-123');
  assert.equal(options.writeback.mode, 'live');
  assert.equal(options.writeback.limit, 12);
  assert.equal(options.writeback.ensureSheet, true);
});

test('runFlyingMouseCombinedJob completes catalog before inventory writeback', async () => {
  const calls = [];
  const catalogResult = { catalogSync: { inserted: 2 }, imageSync: { inserted: 2 } };
  const writebackResult = { found: 1, completed: 1, errors: 0 };

  const dashboardResult = { ok: true, rows: 3 };

  const result = await runFlyingMouseCombinedJob({
    catalog: { sheetMode: 'auto' },
    writeback: { mode: 'live' },
    dashboard: { enabled: true }
  }, {
    async runCatalog(options) {
      calls.push(`catalog:${options.sheetMode}`);
      return catalogResult;
    },
    async runWriteback(options) {
      calls.push(`writeback:${options.mode}`);
      return writebackResult;
    },
    async runDashboard(options) {
      calls.push(`dashboard:${options.enabled}`);
      return dashboardResult;
    },
    logger: { info() {} }
  });

  // 看板一定排在回寫之後，否則「已叫貨未到」已歸零而飛鼠庫存還沒加上去，缺口會被高估。
  assert.deepEqual(calls, ['catalog:auto', 'writeback:live', 'dashboard:true']);
  assert.deepEqual(result, {
    catalog: catalogResult,
    writeback: writebackResult,
    dashboard: dashboardResult
  });
  assert.equal(Object.isFrozen(result), true);
});

test('runFlyingMouseCombinedJob does not write inventory when catalog sync fails', async () => {
  let writebackCalls = 0;

  await assert.rejects(
    runFlyingMouseCombinedJob({
      catalog: { sheetMode: 'auto' },
      writeback: { mode: 'live' }
    }, {
      async runCatalog() { throw new Error('catalog safety check failed'); },
      async runWriteback() { writebackCalls += 1; },
      logger: { info() {} }
    }),
    /catalog safety check failed/
  );

  assert.equal(writebackCalls, 0);
});
