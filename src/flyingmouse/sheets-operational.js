import { MAIN_HEADERS, MAIN_SHEET_NAME } from './sheets-review.js';
import { classifyStockMode, STOCK_MODE, STOCK_MODE_LABEL } from '../services/stock-mode.js';
import {
  TRACKING_HEADERS,
  TRACKING_ITEM_INDEX,
  TRACKING_LAST_COLUMN,
  TRACKING_SKU_INDEX,
  TRACKING_STATUS_INDEX,
  TRACKING_STOCK_MODE_INDEX
} from '../sheets/order-spec-correction.js';

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
  '擷取時間',
  '銷售商品綁定JSON'
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
    // 負庫存代表飛鼠超賣，是要同步進快照的真實值，只擋非整數與超出安全範圍。
    if (!Number.isSafeInteger(item.stock)) {
      throw new Error(`官方 Excel SKU ${sku} 的庫存不是安全整數`);
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

function unboundWhitespaceAliases(imageItems) {
  const groups = new Map();
  for (const item of imageItems ?? []) {
    const sku = normalizeText(item?.sku);
    const compactSku = sku.replace(/\s+/gu, '');
    const spec = normalizeText(item?.sourceSpec ?? item?.spec);
    const imageUrl = normalizeText(item?.sourceImageUrl ?? item?.variantImageUrl) ||
      normalizeText(item?.listImageUrl);
    const bindingStatus = normalizeText(item?.bindingStatus);
    if (!sku || !compactSku || !spec || !imageUrl ||
      !['已綁定銷售商品', '未綁定銷售商品'].includes(bindingStatus)) continue;
    const key = `${compactSku}\u0000${spec}\u0000${imageUrl}`;
    const group = groups.get(key) ?? { bound: new Set(), unbound: new Set() };
    group[bindingStatus === '已綁定銷售商品' ? 'bound' : 'unbound'].add(sku);
    groups.set(key, group);
  }

  const aliases = new Set();
  for (const group of groups.values()) {
    if (group.bound.size === 0) continue;
    for (const sku of group.unbound) {
      if ([...group.bound].some((boundSku) => boundSku !== sku)) aliases.add(sku);
    }
  }
  return aliases;
}

// 飛鼠的貨品名稱是建檔當下的快照，之後改上架名稱不會同步回來；
// 採購看到的、也是唯一會隨供貨狀況更新的，是銷售商品名稱。
// 規格第 2 節：這份資料每小時由 captureFlyingMouseProductList 取得，
// 不額外增加飛鼠負擔。查不到時沿用貨品名稱，不中斷同步。
function buildDisplayName(item, salesName) {
  const name = salesName || item.productName;
  return [name, item.spec1, item.spec2].filter(Boolean).join('｜');
}

// 一個貨號可能綁多個銷售商品。目前實測衝突數為 0，但不能假設永遠如此：
// 綁定之間若推導出不同的出貨型態，名稱仍取第一個綁定（它就是採購會看到的標題），
// 但型態記為未知——猜錯任何一邊都會讓缺口算錯。
//
// 型態要跟著名稱一起決定，不能讓呼叫端從最後的顯示名稱回推：衝突時顯示名稱
// 只代表其中一個綁定，拿它重新分類等於把「不知道」偷換成一個猜測。
function salesNamesBySku(imageItems) {
  const names = new Map();
  for (const item of imageItems ?? []) {
    const sku = normalizeText(item?.sku);
    if (!sku) continue;
    const bindings = Array.isArray(item?.productBindings) && item.productBindings.length > 0
      ? item.productBindings
      : [{ productName: item?.productName }];
    const candidates = bindings.map((binding) => normalizeText(binding?.productName)).filter(Boolean);
    if (candidates.length === 0) continue;
    const modes = new Set(candidates.map((name) => classifyStockMode(name)));
    names.set(sku, Object.freeze({
      name: candidates[0],
      mode: modes.size === 1 ? [...modes][0] : STOCK_MODE.UNKNOWN
    }));
  }
  return names;
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
  imageItems = [],
  minimumCoverage = 0.9,
  dryRun = false
}) {
  if (!sheets || !spreadsheetId) throw new Error('商品主檔同步設定不完整');
  if (typeof minimumCoverage !== 'number' || minimumCoverage <= 0 || minimumCoverage > 1) {
    throw new Error('商品主檔最低配對率必須介於 0 與 1 之間');
  }
  const sourceBySku = uniqueCatalogSourceBySku(sourceItems);
  const unavailableAliases = unboundWhitespaceAliases(imageItems);
  const salesNames = salesNamesBySku(imageItems);
  const properties = await getMainSheetProperties({ sheets, spreadsheetId });
  const rowCount = properties.gridProperties?.rowCount ?? 0;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MAIN_SHEET_NAME}'!A1:O${rowCount}`,
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
  const requiredExtraRows = Math.max(0, sourceOnly.length - availableRows);
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
  const maximumRow = rowCount + expandedRows;

  let nextCandidate = 2;
  const takeEmptyRow = () => {
    while (main.occupiedRows.has(nextCandidate)) nextCandidate += 1;
    if (nextCandidate > maximumRow) throw new Error(`${MAIN_SHEET_NAME}已滿，停止自動同步`);
    main.occupiedRows.add(nextCandidate);
    return nextCandidate;
  };

  const data = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [sku, source] of sourceBySku) {
    const sales = salesNames.get(sku);
    const displayName = buildDisplayName(source, sales?.name);
    // B 欄要維持官方 Excel 的貨品名稱：sheets-baseline.js 拿 A:D 當差異比對基準，
    // 改成銷售商品名稱會讓每一列都被判定為與 Excel 不符（規格第 3 節）。
    const catalogValues = [
      source.productName,
      source.spec1,
      source.spec2,
      source.stock,
      source.gtin,
      source.location,
      displayName
    ];
    // 有銷售商品資料時以它決定的型態為準；沒有才從（退回貨品層的）顯示名稱推導。
    const stockMode = STOCK_MODE_LABEL[sales?.mode ?? classifyStockMode(displayName)];
    const existing = main.bySku.get(sku);
    if (existing) {
      const current = existing.row.slice(1, 8);
      const sameCatalog = catalogValues
        .every((value, index) => String(current[index] ?? '') === String(value));
      const sameStockMode = String(existing.row[14] ?? '') === stockMode;
      if (sameCatalog && sameStockMode) {
        unchanged += 1;
        continue;
      }
      if (!sameCatalog) {
        data.push({
          range: `'${MAIN_SHEET_NAME}'!B${existing.rowNumber}:H${existing.rowNumber}`,
          values: [catalogValues]
        });
      }
      if (!sameStockMode) {
        data.push({
          range: `'${MAIN_SHEET_NAME}'!O${existing.rowNumber}`,
          values: [[stockMode]]
        });
      }
      updated += 1;
      continue;
    }

    const targetRow = takeEmptyRow();
    data.push(
      {
        range: `'${MAIN_SHEET_NAME}'!A${targetRow}:J${targetRow}`,
        values: [[sku, ...catalogValues, '一般SKU', unavailableAliases.has(sku) ? '否' : '是']]
      },
      {
        range: `'${MAIN_SHEET_NAME}'!L${targetRow}:M${targetRow}`,
        values: [['件', '飛鼠']]
      },
      {
        range: `'${MAIN_SHEET_NAME}'!O${targetRow}`,
        values: [[stockMode]]
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
    mainOnly: managed.length - matched.length,
    expandedRows
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
    // 主檔現值也可能是負的（飛鼠超賣）；只認非負會讓負庫存列每輪都重寫一次。
    const currentStock = /^-?\d+$/.test(currentText) ? Number(currentText) : null;
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
  if ((properties.gridProperties?.columnCount ?? 0) < 15) {
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
    item.capturedAt,
    item.productBindings?.length > 1 ? JSON.stringify(item.productBindings) : ''
  ];
}

function sameManagedValues(current, next) {
  return next.every((value, index) => index === 14 || String(current[index] ?? '') === String(value ?? ''));
}

function mergeProtectedBinding(current, next) {
  const merged = [...next];
  const protectsBinding = String(current[11] ?? '') === '已綁定銷售商品' &&
    String(next[11] ?? '') === '未綁定銷售商品';
  if (protectsBinding) {
    for (const index of [2, 3, 6, 11, 15]) merged[index] = current[index] ?? '';
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
  const lastColumn = properties.gridProperties.columnCount >= 16 ? 'P' : 'O';
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      `'${PRODUCT_IMAGES_SHEET_NAME}'!A1:${lastColumn}${rowCount}`,
      `'${MAIN_SHEET_NAME}'!A1:A`
    ],
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const imageValues = response.data.valueRanges?.[0]?.values ?? [];
  const mainValues = response.data.valueRanges?.[1]?.values ?? [];
  exactHeaders(imageValues[0] ?? [], PRODUCT_IMAGE_HEADERS.slice(0, 15), PRODUCT_IMAGES_SHEET_NAME);
  if (imageValues[0]?.[15] && imageValues[0][15] !== PRODUCT_IMAGE_HEADERS[15]) {
    throw new Error(`${PRODUCT_IMAGES_SHEET_NAME} 綁定欄位已被占用`);
  }
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
  if (!dryRun) {
    if (properties.gridProperties.columnCount < 16) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{
        appendDimension: { sheetId: properties.sheetId, dimension: 'COLUMNS', length: 16 - properties.gridProperties.columnCount }
      }] } });
    }
    if (!imageValues[0]?.[15]) data.push({ range: `'${PRODUCT_IMAGES_SHEET_NAME}'!P1`, values: [[PRODUCT_IMAGE_HEADERS[15]]] });
  }
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
      data.push({ range: `'${PRODUCT_IMAGES_SHEET_NAME}'!A${rowNumber}:P${rowNumber}`, values: [next] });
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
      range: `'${PRODUCT_IMAGES_SHEET_NAME}'!A${existing.rowNumber}:P${existing.rowNumber}`,
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

export const TRACKING_SHEET_NAME = '補貨追蹤';

// 只有還在流程中的單需要跟著現況走。已到貨、已取消的列保留當初下單時看到的
// 名稱當作紀錄，不回頭改寫（規格第 4.3 節，使用者 2026-10-30 選定）。
const REFRESHABLE_TRACKING_STATUSES = Object.freeze(new Set(['待確認', '已下單', '部分到貨']));

function readCatalogDisplayNames(mainValues) {
  exactHeaders(mainValues[0] ?? [], MAIN_HEADERS, MAIN_SHEET_NAME);
  const catalog = new Map();
  for (let index = 1; index < mainValues.length; index += 1) {
    const row = paddedRow(mainValues[index], MAIN_HEADERS.length);
    const sku = normalizeText(row[0]);
    if (!sku) continue;
    const displayName = normalizeText(row[7]) || normalizeText(row[1]);
    if (!displayName) continue;
    catalog.set(sku, { displayName, stockMode: normalizeText(row[14]) });
  }
  return catalog;
}

// 每一列要寫什麼，完全由傳進來的這份追蹤資料決定——尤其是該列當下的 SKU 與狀態。
// 這樣即使中途有人動了那一列，算出來的名稱也是配著新 SKU 的，不會張冠李戴。
function planTrackingNameWrites(catalog, trackingValues) {
  exactHeaders(trackingValues[0] ?? [], TRACKING_HEADERS, TRACKING_SHEET_NAME);
  const data = [];
  let refreshed = 0;
  let unchanged = 0;
  let skipped = 0;
  for (let index = 1; index < trackingValues.length; index += 1) {
    const row = paddedRow(trackingValues[index], TRACKING_HEADERS.length);
    if (!hasValues(row)) continue;
    if (!REFRESHABLE_TRACKING_STATUSES.has(normalizeText(row[TRACKING_STATUS_INDEX]))) continue;
    const entry = catalog.get(normalizeText(row[TRACKING_SKU_INDEX]));
    // SKU主檔 查不到就跳過：停用或改編號的舊單不該讓整輪同步失敗。
    if (!entry) {
      skipped += 1;
      continue;
    }
    const rowNumber = index + 1;
    const sameItem = normalizeText(row[TRACKING_ITEM_INDEX]) === entry.displayName;
    const sameMode = normalizeText(row[TRACKING_STOCK_MODE_INDEX]) === entry.stockMode;
    if (sameItem && sameMode) {
      unchanged += 1;
      continue;
    }
    if (!sameItem) {
      data.push({
        range: `'${TRACKING_SHEET_NAME}'!D${rowNumber}`,
        values: [[entry.displayName]]
      });
    }
    if (!sameMode) {
      data.push({
        range: `'${TRACKING_SHEET_NAME}'!${TRACKING_LAST_COLUMN}${rowNumber}`,
        values: [[entry.stockMode]]
      });
    }
    refreshed += 1;
  }
  return { data, refreshed, unchanged, skipped };
}

// 補貨追蹤的「品項」是建單當下從 SKU主檔 複製的一份快照。飛鼠改了上架名稱之後
// 這份快照不會變，採購就會看著「預購」兩個字以為還在等上游，於是重複下單。
//
// 這支跑在獨立的同步 Job，和 LINE 那邊的寫入不同程序，SheetsRepository 的
// 寫入佇列保護不到。危險的交錯是：到貨時若帶規格修正，repository 會改寫同一列的
// D（品項）、N（SKU）並把狀態推進成已完成；如果我們接著把**讀取當下**那個舊 SKU
// 的名稱寫回 D，就會變成 N 是新 SKU、D 是舊名稱，而該列已結案、往後不再刷新，
// 錯誤永久留著。
//
// 所以寫入前重讀一次追蹤表，並完全依最新那份重算：中途被改過的列，要嘛已經不在
// 流程中而被排除，要嘛算出來的是配著新 SKU 的名稱。殘留的風險只剩重讀到送出
// 之間那一瞬；要完全消除得靠跨程序鎖，那會牽動所有寫入者，不在這次範圍。
export async function refreshTrackingDisplayNames({
  sheets,
  spreadsheetId,
  dryRun = false
}) {
  if (!sheets || !spreadsheetId) throw new Error('補貨追蹤名稱同步設定不完整');
  const trackingRange = `'${TRACKING_SHEET_NAME}'!A1:${TRACKING_LAST_COLUMN}`;
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [`'${MAIN_SHEET_NAME}'!A1:O`, trackingRange],
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const catalog = readCatalogDisplayNames(response.data.valueRanges?.[0]?.values ?? []);
  const planned = planTrackingNameWrites(catalog, response.data.valueRanges?.[1]?.values ?? []);
  if (planned.data.length === 0) {
    return Object.freeze({
      refreshed: planned.refreshed,
      unchanged: planned.unchanged,
      skipped: planned.skipped,
      dryRun
    });
  }
  if (dryRun) {
    return Object.freeze({
      refreshed: planned.refreshed,
      unchanged: planned.unchanged,
      skipped: planned.skipped,
      dryRun
    });
  }

  const fresh = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: trackingRange,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const final = planTrackingNameWrites(catalog, fresh.data.values ?? []);
  if (final.data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: final.data }
    });
  }
  return Object.freeze({
    refreshed: final.refreshed,
    unchanged: final.unchanged,
    skipped: final.skipped,
    dryRun
  });
}
