import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import {
  FLYINGMOUSE_HEADERS,
  diffCatalog,
  parseFlyingMouseWorkbook,
  parseReferenceCatalogWorkbook
} from '../src/flyingmouse/catalog.js';

async function temporaryWorkbook(t, headers, rows) {
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'catalog.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test('parseFlyingMouseWorkbook validates and normalizes the official export', async (t) => {
  const filePath = await temporaryWorkbook(t, FLYINGMOUSE_HEADERS, [
    ['001-A', ' 商品 A ', '紅', '', 7, '001234', 'A-01'],
    ['002-B', '商品 B', '', '大', '1,000', '', '']
  ]);

  const result = await parseFlyingMouseWorkbook(filePath);

  assert.equal(result.metadata.rowCount, 2);
  assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.items[0], {
    rowNumber: 2,
    partNumber: '001-A',
    productName: '商品 A',
    spec1: '紅',
    spec2: '',
    stock: 7,
    gtin: '001234',
    location: 'A-01'
  });
  assert.equal(result.items[1].stock, 1000);
});

test('parseFlyingMouseWorkbook rejects a changed header', async (t) => {
  const headers = [...FLYINGMOUSE_HEADERS];
  headers[4] = '可用庫存';
  const filePath = await temporaryWorkbook(t, headers, [
    ['A', '商品', '', '', 1, '', '']
  ]);
  await assert.rejects(parseFlyingMouseWorkbook(filePath), /表頭不符/);
});

test('parseFlyingMouseWorkbook rejects duplicate keys and invalid stock', async (t) => {
  const duplicatePath = await temporaryWorkbook(t, FLYINGMOUSE_HEADERS, [
    ['A', '商品', '', '', 1, '', ''],
    ['A', '商品', '', '', 2, '', '']
  ]);
  await assert.rejects(parseFlyingMouseWorkbook(duplicatePath), /重複/);

  const invalidStockPath = await temporaryWorkbook(t, FLYINGMOUSE_HEADERS, [
    ['B', '商品', '', '', -1, '', '']
  ]);
  await assert.rejects(parseFlyingMouseWorkbook(invalidStockPath), /非負整數/);
});

test('parseReferenceCatalogWorkbook locates the SKU columns by header', async (t) => {
  const filePath = await temporaryWorkbook(
    t,
    ['SPU', '商品名稱', '規格 1', '規格 2', 'SKU', '售價'],
    [['P-1', '商品 A', '紅', '大', '001-A', 100]]
  );
  const result = await parseReferenceCatalogWorkbook(filePath);
  assert.deepEqual(result.items, [{
    rowNumber: 2,
    partNumber: '001-A',
    productName: '商品 A',
    spec1: '紅',
    spec2: '大'
  }]);
});

test('diffCatalog classifies new, changed, missing and duplicate reference keys', () => {
  const source = [
    { rowNumber: 2, partNumber: 'A', productName: '商品 A', spec1: '', spec2: '', stock: 2 },
    { rowNumber: 3, partNumber: 'B', productName: '商品 B 新名', spec1: '', spec2: '', stock: 4 },
    { rowNumber: 4, partNumber: 'C', productName: '商品 C', spec1: '', spec2: '', stock: 9 },
    { rowNumber: 5, partNumber: 'D', productName: '商品 D', spec1: '', spec2: '', stock: 1 }
  ];
  const reference = [
    { rowNumber: 2, partNumber: 'A', productName: '商品 A', spec1: '', spec2: '' },
    { rowNumber: 3, partNumber: 'B', productName: '商品 B', spec1: '', spec2: '' },
    { rowNumber: 4, partNumber: 'C', productName: '商品 C', spec1: '', spec2: '' },
    { rowNumber: 5, partNumber: 'C', productName: '商品 C', spec1: '', spec2: '' },
    { rowNumber: 6, partNumber: 'Z', productName: '商品 Z', spec1: '', spec2: '' },
    { rowNumber: 7, partNumber: '', productName: '沒有 SKU', spec1: '', spec2: '' }
  ];

  const result = diffCatalog(source, reference);

  assert.deepEqual(result.summary, {
    sourceRows: 4,
    referenceRows: 6,
    referenceUniqueKeys: 4,
    matchingKeys: 3,
    newItems: 1,
    changedItems: 1,
    unchangedItems: 1,
    sourceMissingKeys: 1,
    conflictGroups: 2
  });
  assert.equal(result.newItems[0].partNumber, 'D');
  assert.equal(result.changedItems[0].partNumber, 'B');
  assert.equal(result.sourceMissingItems[0].partNumber, 'Z');
  assert.deepEqual(result.conflicts.map((item) => item.type).sort(), [
    'duplicate-reference-key',
    'missing-reference-key'
  ]);
});

test('diffCatalog ignores stock-only changes for catalog descriptions', () => {
  const source = [{
    rowNumber: 2,
    partNumber: 'A',
    productName: '商品 A',
    spec1: '',
    spec2: '',
    stock: 99
  }];
  const reference = [{
    rowNumber: 2,
    partNumber: 'A',
    productName: '商品 A',
    spec1: '',
    spec2: '',
    stock: 1
  }];
  assert.equal(diffCatalog(source, reference).summary.unchangedItems, 1);
});
