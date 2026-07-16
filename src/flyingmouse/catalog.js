import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import ExcelJS from 'exceljs';

export const FLYINGMOUSE_HEADERS = Object.freeze([
  '貨品編號',
  '商品名稱',
  '規格 1',
  '規格 2',
  '庫存',
  'GTIN',
  '儲位'
]);

const DESCRIPTION_FIELDS = Object.freeze(['productName', 'spec1', 'spec2']);

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return normalizeText(value.richText.map((part) => part.text ?? '').join(''));
    }
    if (Object.hasOwn(value, 'result')) return normalizeText(value.result);
    if (Object.hasOwn(value, 'text')) return normalizeText(value.text);
  }
  return normalizeText(cell.text || value);
}

function parseStock(cell, rowNumber) {
  const text = cellText(cell).replaceAll(',', '');
  if (!/^\d+$/.test(text)) {
    throw new Error(`第 ${rowNumber} 列的庫存不是非負整數`);
  }
  const stock = Number(text);
  if (!Number.isSafeInteger(stock)) {
    throw new Error(`第 ${rowNumber} 列的庫存超出安全整數範圍`);
  }
  return stock;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function loadWorkbook(filePath) {
  const absolutePath = resolve(filePath);
  if (extname(absolutePath).toLowerCase() !== '.xlsx') {
    throw new Error('只接受 .xlsx Excel 檔案');
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absolutePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('Excel 沒有工作表');
  return { absolutePath, worksheet };
}

function readHeaders(worksheet) {
  const row = worksheet.getRow(1);
  const count = Math.max(worksheet.actualColumnCount, row.cellCount);
  return Array.from({ length: count }, (_, index) => cellText(row.getCell(index + 1)));
}

function baseMetadata({ absolutePath, worksheet, headers, sha256, rowCount }) {
  return Object.freeze({
    sourceFile: basename(absolutePath),
    worksheet: worksheet.name,
    headers,
    sha256,
    rowCount
  });
}

export async function parseFlyingMouseWorkbook(filePath) {
  const loaded = await loadWorkbook(filePath);
  const { absolutePath, worksheet } = loaded;
  const headers = readHeaders(worksheet);
  if (
    headers.length !== FLYINGMOUSE_HEADERS.length ||
    headers.some((header, index) => header !== FLYINGMOUSE_HEADERS[index])
  ) {
    throw new Error(
      `飛鼠 Excel 表頭不符，預期：${FLYINGMOUSE_HEADERS.join('、')}；實際：${headers.join('、')}`
    );
  }

  const items = [];
  const seen = new Map();
  for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = FLYINGMOUSE_HEADERS.map((_, index) => cellText(row.getCell(index + 1)));
    if (values.every((value) => !value)) continue;

    const partNumber = values[0];
    if (!partNumber) throw new Error(`第 ${rowNumber} 列缺少貨品編號`);
    if (seen.has(partNumber)) {
      throw new Error(`貨品編號 ${partNumber} 在第 ${seen.get(partNumber)}、${rowNumber} 列重複`);
    }
    seen.set(partNumber, rowNumber);

    items.push(Object.freeze({
      rowNumber,
      partNumber,
      productName: values[1],
      spec1: values[2],
      spec2: values[3],
      stock: parseStock(row.getCell(5), rowNumber),
      gtin: values[5],
      location: values[6]
    }));
  }
  if (items.length === 0) throw new Error('飛鼠 Excel 沒有貨品資料');

  return Object.freeze({
    metadata: baseMetadata({
      absolutePath,
      worksheet,
      headers,
      sha256: await sha256File(absolutePath),
      rowCount: items.length
    }),
    items: Object.freeze(items)
  });
}

function findHeaderIndex(headers, candidates, label) {
  const index = headers.findIndex((header) => candidates.includes(header));
  if (index < 0) throw new Error(`既有目錄 Excel 缺少 ${label} 欄位`);
  return index + 1;
}

export async function parseReferenceCatalogWorkbook(filePath) {
  const loaded = await loadWorkbook(filePath);
  const { absolutePath, worksheet } = loaded;
  const headers = readHeaders(worksheet);
  const columns = {
    partNumber: findHeaderIndex(headers, ['SKU', '貨品編號'], 'SKU／貨品編號'),
    productName: findHeaderIndex(headers, ['商品名稱'], '商品名稱'),
    spec1: findHeaderIndex(headers, ['規格 1', '規格1'], '規格 1'),
    spec2: findHeaderIndex(headers, ['規格 2', '規格2'], '規格 2')
  };

  const items = [];
  for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [key, cellText(row.getCell(column))])
    );
    if (Object.values(values).every((value) => !value)) continue;
    items.push(Object.freeze({ rowNumber, ...values }));
  }
  if (items.length === 0) throw new Error('既有目錄 Excel 沒有商品資料');

  return Object.freeze({
    metadata: baseMetadata({
      absolutePath,
      worksheet,
      headers,
      sha256: await sha256File(absolutePath),
      rowCount: items.length
    }),
    items: Object.freeze(items)
  });
}

function publicItem(item) {
  return {
    rowNumber: item.rowNumber,
    partNumber: item.partNumber,
    productName: item.productName,
    spec1: item.spec1,
    spec2: item.spec2,
    stock: item.stock,
    gtin: item.gtin,
    location: item.location
  };
}

export function diffCatalog(sourceItems, referenceItems) {
  const sourceByKey = new Map(sourceItems.map((item) => [item.partNumber, item]));
  const referenceByKey = new Map();
  const conflicts = [];

  for (const item of referenceItems) {
    if (!item.partNumber) {
      conflicts.push({ type: 'missing-reference-key', references: [publicItem(item)] });
      continue;
    }
    const group = referenceByKey.get(item.partNumber) ?? [];
    group.push(item);
    referenceByKey.set(item.partNumber, group);
  }

  for (const [partNumber, references] of referenceByKey) {
    if (references.length > 1) {
      conflicts.push({
        type: 'duplicate-reference-key',
        partNumber,
        source: sourceByKey.has(partNumber) ? publicItem(sourceByKey.get(partNumber)) : null,
        references: references.map(publicItem)
      });
    }
  }

  const newItems = [];
  const changedItems = [];
  const unchangedItems = [];
  let matchingKeys = 0;
  for (const source of sourceItems) {
    const references = referenceByKey.get(source.partNumber) ?? [];
    if (references.length === 0) {
      newItems.push(publicItem(source));
      continue;
    }
    matchingKeys += 1;
    if (references.length > 1) continue;

    const reference = references[0];
    const changes = DESCRIPTION_FIELDS.filter(
      (field) => normalizeText(source[field]) !== normalizeText(reference[field])
    ).map((field) => ({ field, before: reference[field], after: source[field] }));
    if (changes.length > 0) {
      changedItems.push({
        partNumber: source.partNumber,
        source: publicItem(source),
        reference: publicItem(reference),
        changes
      });
    } else {
      unchangedItems.push(source.partNumber);
    }
  }

  const sourceMissingItems = [];
  for (const [partNumber, references] of referenceByKey) {
    if (!sourceByKey.has(partNumber)) {
      sourceMissingItems.push({ partNumber, references: references.map(publicItem) });
    }
  }

  return Object.freeze({
    summary: Object.freeze({
      sourceRows: sourceItems.length,
      referenceRows: referenceItems.length,
      referenceUniqueKeys: referenceByKey.size,
      matchingKeys,
      newItems: newItems.length,
      changedItems: changedItems.length,
      unchangedItems: unchangedItems.length,
      sourceMissingKeys: sourceMissingItems.length,
      conflictGroups: conflicts.length
    }),
    newItems,
    changedItems,
    unchangedItems,
    sourceMissingItems,
    conflicts
  });
}
