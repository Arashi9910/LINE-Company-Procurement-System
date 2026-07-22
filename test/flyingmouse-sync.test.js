import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { FLYINGMOUSE_HEADERS } from '../src/flyingmouse/catalog.js';
import { MAIN_HEADERS, REVIEW_HEADERS, REVIEW_SHEET_NAME } from '../src/flyingmouse/sheets-review.js';
import { parseArguments, runFlyingMouseSync } from '../scripts/flyingmouse-sync.mjs';

async function writeWorkbook(filePath, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  await workbook.xlsx.writeFile(filePath);
}

test('parseArguments defaults to read-only browser export paths', () => {
  assert.deepEqual(parseArguments([], {}), {
    input: '',
    baseline: '',
    spreadsheetId: '',
    sheetMode: 'read-only',
    credentials: '.env.flyingmouse-login.txt',
    downloadDir: 'work/flyingmouse/downloads',
    outputDir: 'work/flyingmouse/previews',
    headless: true,
    help: false
  });
  assert.equal(parseArguments(['--headed'], {}).headless, false);
  assert.equal(parseArguments([], { SPREADSHEET_ID: 'sheet-123' }).spreadsheetId, 'sheet-123');
  assert.equal(parseArguments([], { FLYINGMOUSE_SHEET_MODE: 'review', SPREADSHEET_ID: 'sheet-123' }).sheetMode, 'review');
  assert.equal(parseArguments([], { FLYINGMOUSE_SHEET_MODE: 'auto', SPREADSHEET_ID: 'sheet-123' }).sheetMode, 'auto');
  assert.throws(() => parseArguments(['--sheet-mode', 'review'], {}), /需要 --spreadsheet-id/);
  assert.throws(() => parseArguments(['--sheet-mode', 'auto'], {}), /需要 --spreadsheet-id/);
  assert.throws(() => parseArguments(['--sheet-mode', 'unsafe'], {}), /不支援的 sheet mode/);
  assert.throws(() => parseArguments(['--unknown'], {}), /未知參數/);
});

test('runFlyingMouseSync writes an offline preview report atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.xlsx');
  const baselinePath = join(directory, 'baseline.xlsx');
  const outputDir = join(directory, 'reports');
  await writeWorkbook(sourcePath, FLYINGMOUSE_HEADERS, [
    ['A', '商品 A', '', '', 3, '', ''],
    ['B', '商品 B', '', '', 4, '', '']
  ]);
  await writeWorkbook(
    baselinePath,
    ['SPU', '商品名稱', '規格 1', '規格 2', 'SKU'],
    [['P-A', '商品 A', '', '', 'A']]
  );

  const result = await runFlyingMouseSync({
    ...parseArguments([], {}),
    input: sourcePath,
    baseline: baselinePath,
    outputDir
  }, { now: () => new Date('2026-07-15T10:20:30.000Z') });
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'));

  assert.equal(result.mode, 'offline');
  assert.equal(report.readOnly, true);
  assert.equal(report.sheetMode, 'read-only');
  assert.equal(report.summary.newItems, 1);
  assert.equal(report.diff.newItems[0].partNumber, 'B');
});

test('runFlyingMouseSync can use the read-only Google Sheet baseline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-sheet-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.xlsx');
  await writeWorkbook(sourcePath, FLYINGMOUSE_HEADERS, [
    ['A', '商品 A', '', '', 3, '', ''],
    ['B', '商品 B', '', '', 4, '', '']
  ]);
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          return { data: { values: [['A', '商品 A', '', '']] } };
        }
      }
    }
  };

  const result = await runFlyingMouseSync({
    ...parseArguments([], {}),
    input: sourcePath,
    spreadsheetId: 'sheet-123',
    outputDir: join(directory, 'reports')
  }, {
    now: () => new Date('2026-07-15T10:20:30.000Z'),
    env: {},
    sheetsFactory: () => sheets
  });

  assert.equal(result.summary.referenceRows, 1);
  assert.equal(result.summary.newItems, 1);
});

test('runFlyingMouseSync review mode performs a zero-diff review pass without main-sheet writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-review-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.xlsx');
  await writeWorkbook(sourcePath, FLYINGMOUSE_HEADERS, [
    ['A', '商品 A', '', '', 3, '', '']
  ]);
  let writes = 0;
  let writable;
  const mainHeaders = [
    'SKU', '商品名稱', '蝦皮規格1（原始）', '蝦皮規格2（原始）', '庫存快照', 'GTIN', '儲位',
    '補貨顯示名稱', '品項類型', '是否可補貨', '搜尋關鍵字', '單位', '主要供應商', '資料更新日'
  ];
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [
              { properties: { sheetId: 2, title: REVIEW_SHEET_NAME, gridProperties: { rowCount: 5000, columnCount: 19 } } },
              { properties: { sheetId: 3, title: 'SKU主檔', gridProperties: { rowCount: 1000, columnCount: 14 } } }
            ]
          }
        };
      },
      values: {
        async get({ range }) {
          if (range === "'SKU主檔'!A2:D") return { data: { values: [['A', '商品 A', '', '']] } };
          if (range.endsWith('A1:E')) {
            return { data: { values: [mainHeaders.slice(0, 5), ['A', '商品 A', '', '', 3]] } };
          }
          if (range.endsWith('A1:S1')) return { data: { values: [[...REVIEW_HEADERS]] } };
          if (range.includes('A2:S5000')) return { data: { values: [] } };
          throw new Error(`unexpected range: ${range}`);
        },
        async batchGet() {
          return {
            data: {
              valueRanges: [
                { values: [[...REVIEW_HEADERS]] },
                { values: [mainHeaders, ['A', '商品 A', '', '']] }
              ]
            }
          };
        },
        async batchUpdate() {
          writes += 1;
          return { data: {} };
        }
      }
    }
  };
  const options = parseArguments([
    '--input', sourcePath,
    '--spreadsheet-id', 'sheet-123',
    '--sheet-mode', 'review',
    '--output-dir', join(directory, 'reports')
  ], {});

  const result = await runFlyingMouseSync(options, {
    now: () => new Date('2026-07-15T10:20:30.000Z'),
    env: {},
    sheetsFactory: (input) => {
      writable = input.writable;
      return sheets;
    }
  });

  assert.equal(writable, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.reviewSync.review.findings, 0);
  assert.equal(result.reviewSync.approvals.approved, 0);
  assert.equal(writes, 0);
});

test('runFlyingMouseSync auto mode bypasses approvals and writes the source catalog directly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-auto-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.xlsx');
  await writeWorkbook(sourcePath, FLYINGMOUSE_HEADERS, [
    ['A', '新版商品 A', '紅色', '', 8, '001', 'A-01'],
    ['B', '全新商品 B', '', '二入組', 4, '002', 'B-02']
  ]);
  let write;
  let writable;
  const sheets = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{
              properties: {
                sheetId: 3,
                title: 'SKU主檔',
                gridProperties: { rowCount: 10, columnCount: MAIN_HEADERS.length }
              }
            }]
          }
        };
      },
      values: {
        async get({ range }) {
          if (range === "'SKU主檔'!A2:D") {
            return { data: { values: [['A', '舊商品 A', '', '']] } };
          }
          if (range === "'SKU主檔'!A1:N10") {
            return {
              data: {
                values: [
                  [...MAIN_HEADERS],
                  ['A', '舊商品 A', '', '', 3, '', '', '人工舊名', '一般SKU', '是', '', '件', '飛鼠', '']
                ]
              }
            };
          }
          throw new Error(`unexpected range: ${range}`);
        },
        async batchUpdate(request) {
          write = request;
          return { data: {} };
        }
      }
    }
  };
  const options = parseArguments([
    '--input', sourcePath,
    '--spreadsheet-id', 'sheet-123',
    '--sheet-mode', 'auto',
    '--output-dir', join(directory, 'reports')
  ], {});

  const result = await runFlyingMouseSync(options, {
    now: () => new Date('2026-07-22T10:20:30.000Z'),
    env: {},
    sheetsFactory: (input) => {
      writable = input.writable;
      return sheets;
    }
  });

  assert.equal(writable, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.reviewSync, null);
  assert.equal(result.inventorySync, null);
  assert.equal(result.catalogSync.inserted, 1);
  assert.equal(result.catalogSync.updated, 1);
  assert.deepEqual(write.requestBody.data.map((entry) => entry.range), [
    "'SKU主檔'!B2:H2",
    "'SKU主檔'!A3:J3",
    "'SKU主檔'!L3:M3"
  ]);
});
