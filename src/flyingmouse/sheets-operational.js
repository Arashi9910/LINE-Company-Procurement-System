import { MAIN_HEADERS, MAIN_SHEET_NAME } from './sheets-review.js';

export const PRODUCT_IMAGES_SHEET_NAME = '商品圖片對照';
export const PRODUCT_IMAGE_HEADERS = Object.freeze([
  '飛鼠貨品ID',
  '貨品編號',
  '銷售商品ID',
  '銷售商品編號',
  '商品名稱',
  '規格',
  '商品首圖網址',
  '規格圖片網址',
  '列表圖片網址',
  '圖片採用類型',
  '圖片狀態',
  '綁定狀態',
  'SKU主檔配對',
  '資料來源',
  '擷取時間'
]);

const AUTOMATED_IMAGE_SOURCE = '飛鼠貨品列表';

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function paddedRow(row, width) {
  return Array.from({ length: width }, (_, index) => row[index] ?? '');
}

function hasValues(row) {
  return row.some((value) => value !== '' && value != null);
}

function exactHeaders(actual, expected, label) {
  const normalized = Array.from({ length: expected.length }, (_, index) => String(actual[index] ?? ''));
  if (normalized.some((header, index) => header !== expected[index])) {
    throw new Error(`${label} 表頭不符合預期，已停止同步`);
  }
}

function uniqueSourceBySku(sourceItems) {
  const result = new Map();
  for (const item of sourceItems ?? []) {
    const sku = normalizeText(item.partNumber);
    if (!sku) throw new Error('官方 Excel 含有空白 SKU');
    if (result.has(sku)) throw new Error(`官方 Excel SKU 重複：${sku}`);
    if (!Number.isSafeInteger(item.stock) || item.stock < 0) {
      throw new Error(`官方 Excel SKU ${sku} 的庫存不是非負安全整數`);
    }
    result.set(sku, item);
  }
  if (result.size === 0) throw new Error('官方 Excel 沒有可同步的庫存資料');
  return result;
}

function uniqueCatalogSourceBySku(sourceItems) {
  const stockValidated = uniqueSourceBySku(sourceItems);
  const result = new Map();
  for (const [sku, item] of stockValidated) {
    const productName = normalizeText(item.productName);
    if (!productName) throw new Error(`官方 Excel SKU ${sku} 缺少商品名稱`);
    result.set(sku, Object.freeze({
      partNumber: sku,
      productName,
      spec1: normalizeText(item.spec1),
      spec2: normalizeText(item.spec2),
      stock: item.stock,
      gtin: normalizeText(item.gtin),
      location: normalizeText(item.location)
    }));
  }
  return result;
}

function buildDisplayName(item) {
  return [item.productName, item.spec1, item.spec2].filter(Boolean).join('｜');
}

function readCatalogRows(values) {
  exactHeaders(values[0] ?? [], MAIN_HEADERS, MAIN_SHEET_NAME);
  const bySku = new Map();
  const rows = [];
  const occupiedRows = new Set([1]);
  for (let index = 1; index < values.length; index += 1) {
    const row = paddedRow(values[index], MAIN_HEADERS.length);
    if (!hasValues(row)) continue;
    const rowNumber = index + 1;
    const sku = normalizeText(row[0]);
    if (!sku) throw new Error(`${MAIN_SHEET_NAME} 第 ${rowNumber} 列缺少 SKU`);
    if (bySku.has(sku)) throw new Error(`${MAIN_SHEET_NAME} SKU 重複：${sku}`);
    const value = { sku, row, rowNumber, supplier: normalizeText(row[12]) };
    bySku.set(sku, value);
    rows.push(value);
    occupiedRows.add(rowNumber);
  }
  return { bySku, rows, occupiedRows };
}

async function getMainSheetProperties({ sheets, spreadsheetId }) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const properties = response.data.sheets
    ?.map((sheet) => sheet.properties)
    .find((sheet) => sheet.title === MAIN_SHEET_NAME);
  if (!properties) throw new Error(`缺少 ${MAIN_SHEET_NAME} 分頁`);
  if ((properties.gridProperties?.columnCount ?? 0) < MAIN_HEADERS.length) {
    throw new Error(`${MAIN_SHEET_NAME} 欄數不足`);
  }
  return properties;
}

export async function syncCatalogItems({
  sheets,
  spreadsheetId,
  sourceItems,
  minimumCoverage = 0.9,
  dryRun = false
}) {
  if (!sheets || !spreadsheetId) throw new Error('商品主檔同步設定不完整');
  if (typeof minimumCoverage !== 'number' || minimumCoverage <= 0 || minimumCoverage > 1) {
    throw new Error('商品主檔最低配對率必須介於 0 與 1 之間');
  }
  const sourceBySku = uniqueCatalogSourceBySku(sourceItems);
  const properties = await getMainSheetProperties({ sheets, spreadsheetId });
  const rowCount = properties.gridProperties?.rowCount ?? 0;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MAIN_SHEET_NAME}'!A1:N${rowCount}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const main = readCatalogRows(response.data.values ?? []);

  for (const [sku] of sourceBySku) {
    const existing = main.bySku.get(sku);
    if (existing && existing.supplier !== '飛鼠') {
      throw new Error(`${MAIN_SHEET_NAME} SKU ${sku} 的主要供應商不是飛鼠，停止自動同步`);
    }
  }

  const managed = main.rows.filter((item) => item.supplier === '飛鼠');
  const matched = managed.filter((item) => sourceBySku.has(item.sku));
  const coverage = managed.length === 0 ? 1 : matched.length / managed.length;
  if (coverage < minimumCoverage) {
    throw new Error(
      `${MAIN_SHEET_NAME} 飛鼠 SKU 配對率 ${(coverage * 100).toFixed(1)}% 低於 ${(minimumCoverage * 100).toFixed(1)}%，已停止寫入`
    );
  }

  const sourceOnly = [...sourceBySku.keys()].filter((sku) => !main.bySku.has(sku));
  const availableRows = Math.max(0, rowCount - main.occupiedRows.size);
  if (sourceOnly.length > availableRows) throw new Error(`${MAIN_SHEET_NAME}已滿，停止自動同步`);

  let nextCandidate = 2;
  const takeEmptyRow = () => {
    while (main.occupiedRows.has(nextCandidate)) nextCandidate += 1;
    if (nextCandidate > rowCount) throw new Error(`${MAIN_SHEET_NAME}已滿，停止自動同步`);
    main.occupiedRows.add(nextCandidate);
    return nextCandidate;
  };

  const data = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [sku, source] of sourceBySku) {
    const catalogValues = [
      source.productName,
      source.spec1,
      source.spec2,
      source.stock,
      source.gtin,
      source.location,
      buildDisplayName(source)
    ];
    const existing = main.bySku.get(sku);
    if (existing) {
      const current = existing.row.slice(1, 8);
      if (catalogValues.every((value, index) => String(current[index] ?? '') === String(value))) {
        unchanged += 1;
        continue;
      }
      data.push({
        range: `'${MAIN_SHEET_NAME}'!B${existing.rowNumber}:H${existing.rowNumber}`,
        values: [catalogValues]
      });
      updated += 1;
      continue;
    }

    const targetRow = takeEmptyRow();
    data.push(
      {
        range: `'${MAIN_SHEET_NAME}'!A${targetRow}:J${targetRow}`,
        values: [[sku, ...catalogValues, '一般SKU', '是']]
      },
      {
        range: `'${MAIN_SHEET_NAME}'!L${targetRow}:M${targetRow}`,
        values: [['件', '飛鼠']]
      }
    );
    inserted += 1;
  }

  if (!dryRun && data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return Object.freeze({
    dryRun,
    sourceRows: sourceBySku.size,
    mainRows: main.rows.length,
    managedRows: managed.length,
    matched: matched.length,
    coverage: Number(coverage.toFixed(4)),
    inserted,
    updated,
    unchanged,
    sourceOnly: sourceOnly.length,
    mainOnly: managed.length - matched.length
  });
}

function readMainRows(values, width = 5) {
  exactHeaders(values[0] ?? [], MAIN_HEADERS.slice(0, width), MAIN_SHEET_NAME);
  const bySku = new Map();
  const rows = [];
  for (let index = 1; index < values.length; index += 1) {
    const row = paddedRow(values[index], width);
    if (!hasValues(row)) continue;
    const rowNumber = index + 1;
    const sku = normalizeText(row[0]);
    if (!sku) throw new Error(`${MAIN_SHEET_NAME} 第 ${rowNumber} 列缺少 SKU`);
    if (bySku.has(sku)) throw new Error(`${MAIN_SHEET_NAME} SKU 重複：${sku}`);
    const value = { sku, row, rowNumber };
    bySku.set(sku, value);
    rows.push(value);
  }
  if (rows.length === 0) throw new Error(`${MAIN_SHEET_NAME} 沒有可同步的 SKU`);
  return { bySku, rows };
}

export async function syncInventorySnapshots({
  sheets,
  spreadsheetId,
  sourceItems,
  minimumCoverage = 0.9,
  dryRun = false
}) {
  if (!sheets || !spreadsheetId) throw new Error('庫存快照同步設定不完整');
  if (typeof minimumCoverage !== 'number' || minimumCoverage <= 0 || minimumCoverage > 1) {
    throw new Error('庫存快照最低配對率必須介於 0 與 1 之間');
  }
  const sourceBySku = uniqueSourceBySku(sourceItems);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MAIN_SHEET_NAME}'!A1:E`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const main = readMainRows(response.data.values ?? []);
  const matched = main.rows.filter(({ sku }) => sourceBySku.has(sku));
  const coverage = matched.length / main.rows.length;
  if (coverage < minimumCoverage) {
    throw new Error(
      `${MAIN_SHEET_NAME} 庫存配對率 ${(coverage * 100).toFixed(1)}% 低於 ${(minimumCoverage * 100).toFixed(1)}%，已停止寫入`
    );
  }

  const data = [];
  let unchanged = 0;
  for (const item of matched) {
    const nextStock = sourceBySku.get(item.sku).stock;
    const currentText = String(item.row[4] ?? '').replaceAll(',', '').trim();
    const currentStock = /^\d+$/.test(currentText) ? Number(currentText) : null;
    if (currentStock === nextStock) {
      unchanged += 1;
      continue;
    }
    data.push({
      range: `'${MAIN_SHEET_NAME}'!E${item.rowNumber}`,
      values: [[nextStock]]
    });
  }
  if (!dryRun && data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return Object.freeze({
    dryRun,
    sourceRows: sourceBySku.size,
    mainRows: main.rows.length,
    matched: matched.length,
    coverage: Number(coverage.toFixed(4)),
    updated: data.length,
    unchanged,
    sourceOnly: [...sourceBySku.keys()].filter((sku) => !main.bySku.has(sku)).length,
    mainOnly: main.rows.length - matched.length
  });
}

async function getSheetProperties({ sheets, spreadsheetId }) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  const properties = response.data.sheets
    ?.map((sheet) => sheet.properties)
    .find((sheet) => sheet.title === PRODUCT_IMAGES_SHEET_NAME);
  if (!properties) throw new Error(`缺少 ${PRODUCT_IMAGES_SHEET_NAME} 分頁`);
  if ((properties.gridProperties?.columnCount ?? 0) < PRODUCT_IMAGE_HEADERS.length) {
    throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} 欄數不足`);
  }
  return properties;
}

function ensureUniqueImageItems(imageItems) {
  const partIds = new Set();
  const skus = new Set();
  for (const item of imageItems ?? []) {
    const partId = normalizeText(item.partId);
    const sku = normalizeText(item.sku);
    if (!partId || !sku) throw new Error('圖片來源含有空白貨品 ID 或 SKU');
    if (partIds.has(partId)) throw new Error(`圖片來源貨品 ID 重複：${partId}`);
    if (skus.has(sku)) throw new Error(`圖片來源 SKU 重複：${sku}`);
    partIds.add(partId);
    skus.add(sku);
  }
  if (partIds.size === 0) throw new Error('圖片來源沒有可同步資料');
}

function imageRow(item, matched) {
  return [
    item.partId,
    item.sku,
    item.productId,
    item.productCode,
    item.productName,
    item.spec,
    item.mainImageUrl,
    item.variantImageUrl,
    item.listImageUrl,
    item.imageType,
    item.imageStatus,
    item.bindingStatus,
    matched ? '已配對' : '未配對',
    item.source,
    item.capturedAt
  ];
}

function sameManagedValues(current, next) {
  return next.slice(0, 14).every((value, index) => String(current[index] ?? '') === String(value ?? ''));
}

function mergeProtectedBinding(current, next) {
  const merged = [...next];
  const protectsBinding = String(current[11] ?? '') === '已綁定銷售商品' &&
    String(next[11] ?? '') === '未綁定銷售商品';
  if (protectsBinding) {
    for (const index of [2, 3, 6, 11]) merged[index] = current[index] ?? '';
  }
  const listImageUrl = String(merged[8] ?? '');
  const isDefault = /(?:^|\/)img\/default-cover\.jpg(?:\?.*)?$/i.test(listImageUrl);
  merged[10] = isDefault ? '待補圖片' : (merged[6] ? '正常' : '待補主圖');
  return { row: merged, protectsBinding };
}

export async function syncProductImages({
  sheets,
  spreadsheetId,
  imageItems,
  dryRun = false
}) {
  if (!sheets || !spreadsheetId) throw new Error('商品圖片同步設定不完整');
  ensureUniqueImageItems(imageItems);
  const properties = await getSheetProperties({ sheets, spreadsheetId });
  const rowCount = properties.gridProperties?.rowCount ?? 0;
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      `'${PRODUCT_IMAGES_SHEET_NAME}'!A1:O${rowCount}`,
      `'${MAIN_SHEET_NAME}'!A1:A`
    ],
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const imageValues = response.data.valueRanges?.[0]?.values ?? [];
  const mainValues = response.data.valueRanges?.[1]?.values ?? [];
  exactHeaders(imageValues[0] ?? [], PRODUCT_IMAGE_HEADERS, PRODUCT_IMAGES_SHEET_NAME);
  exactHeaders(mainValues[0] ?? [], MAIN_HEADERS.slice(0, 1), MAIN_SHEET_NAME);

  const mainSkus = new Set();
  for (let index = 1; index < mainValues.length; index += 1) {
    const sku = normalizeText(mainValues[index]?.[0]);
    if (!sku) continue;
    if (mainSkus.has(sku)) throw new Error(`${MAIN_SHEET_NAME} SKU 重複：${sku}`);
    mainSkus.add(sku);
  }

  const existingByPartId = new Map();
  const existingSkus = new Set();
  const occupiedRows = new Set([1]);
  for (let index = 1; index < imageValues.length; index += 1) {
    const row = paddedRow(imageValues[index], PRODUCT_IMAGE_HEADERS.length);
    if (!hasValues(row)) continue;
    const rowNumber = index + 1;
    const partId = normalizeText(row[0]);
    const sku = normalizeText(row[1]);
    if (!partId || !sku) throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} 第 ${rowNumber} 列缺少貨品 ID 或 SKU`);
    if (existingByPartId.has(partId)) throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} 貨品 ID 重複：${partId}`);
    if (existingSkus.has(sku)) throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} SKU 重複：${sku}`);
    existingByPartId.set(partId, { row, rowNumber });
    existingSkus.add(sku);
    occupiedRows.add(rowNumber);
  }

  const missingItems = imageItems.filter((item) => !existingByPartId.has(normalizeText(item.partId)));
  const availableRows = Math.max(0, rowCount - occupiedRows.size);
  const requiredExtraRows = Math.max(0, missingItems.length - availableRows);
  const expandedRows = requiredExtraRows > 0 ? Math.max(100, requiredExtraRows) : 0;
  if (!dryRun && expandedRows > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: properties.sheetId,
            dimension: 'ROWS',
            length: expandedRows
          }
        }]
      }
    });
  }

  let nextCandidate = 2;
  const maximumRow = rowCount + expandedRows;
  const takeEmptyRow = () => {
    while (occupiedRows.has(nextCandidate)) nextCandidate += 1;
    if (nextCandidate > maximumRow) throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} 沒有可寫入的空白列`);
    occupiedRows.add(nextCandidate);
    return nextCandidate;
  };

  const data = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let protectedRows = 0;
  let preservedBindings = 0;
  for (const item of imageItems) {
    const partId = normalizeText(item.partId);
    let next = imageRow(item, mainSkus.has(normalizeText(item.sku)));
    const existing = existingByPartId.get(partId);
    if (!existing) {
      const rowNumber = takeEmptyRow();
      data.push({ range: `'${PRODUCT_IMAGES_SHEET_NAME}'!A${rowNumber}:O${rowNumber}`, values: [next] });
      inserted += 1;
      continue;
    }
    if (String(existing.row[13] ?? '') !== AUTOMATED_IMAGE_SOURCE) {
      protectedRows += 1;
      continue;
    }
    const merged = mergeProtectedBinding(existing.row, next);
    next = merged.row;
    if (merged.protectsBinding) preservedBindings += 1;
    if (sameManagedValues(existing.row, next)) {
      unchanged += 1;
      continue;
    }
    data.push({
      range: `'${PRODUCT_IMAGES_SHEET_NAME}'!A${existing.rowNumber}:O${existing.rowNumber}`,
      values: [next]
    });
    updated += 1;
  }
  if (!dryRun && data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return Object.freeze({
    dryRun,
    captured: imageItems.length,
    inserted,
    updated,
    unchanged,
    protected: protectedRows,
    preservedBindings,
    matchedMain: imageItems.filter((item) => mainSkus.has(normalizeText(item.sku))).length,
    unmatchedMain: imageItems.filter((item) => !mainSkus.has(normalizeText(item.sku))).length,
    expandedRows
  });
}
