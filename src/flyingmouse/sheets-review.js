import { createHash } from 'node:crypto';
import { google } from 'googleapis';

export const REVIEW_SHEET_NAME = '飛鼠目錄待確認';
export const REVIEW_HEADERS = Object.freeze([
  '同步鍵',
  '偵測狀態',
  '差異類型',
  '審核狀態',
  'SKU',
  '商品名稱（飛鼠）',
  '規格1（飛鼠）',
  '規格2（飛鼠）',
  '庫存（飛鼠）',
  'GTIN（飛鼠）',
  '儲位（飛鼠）',
  '現有商品名稱',
  '現有規格1',
  '現有規格2',
  '來源指紋',
  '首次偵測時間',
  '最後偵測時間',
  '審核備註',
  '處理時間'
]);

export const MAIN_SHEET_NAME = 'SKU主檔';
export const MAIN_HEADERS = Object.freeze([
  'SKU',
  '商品名稱',
  '蝦皮規格1（原始）',
  '蝦皮規格2（原始）',
  '庫存快照',
  'GTIN',
  '儲位',
  '補貨顯示名稱',
  '品項類型',
  '是否可補貨',
  '搜尋關鍵字',
  '單位',
  '主要供應商',
  '資料更新日'
]);
const REVIEW_ROW_COUNT = 5000;
const REVIEW_STATUS_VALUES = Object.freeze([
  '待確認',
  '核准匯入',
  '略過',
  '已匯入',
  '需重新確認'
]);

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function timestampInTaipei(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

export function sourceFingerprint(item) {
  const fields = [
    item?.partNumber,
    item?.productName,
    item?.spec1,
    item?.spec2,
    item?.gtin,
    item?.location
  ].map(normalizeText);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function findingFingerprint(type, source, reference) {
  return createHash('sha256').update(JSON.stringify([
    type,
    source ? sourceFingerprint(source) : '',
    reference?.partNumber ?? '',
    reference?.productName ?? '',
    reference?.spec1 ?? '',
    reference?.spec2 ?? ''
  ])).digest('hex');
}

function finding({ key, type, source = null, reference = null, partNumber = '' }) {
  return Object.freeze({
    key,
    type,
    source,
    reference,
    partNumber: partNumber || source?.partNumber || reference?.partNumber || '',
    fingerprint: findingFingerprint(type, source, reference)
  });
}

export function buildReviewFindings(diff) {
  if (!diff) return [];
  return [
    ...diff.newItems.map((source) => finding({
      key: `新增:${source.partNumber}`,
      type: '新增',
      source
    })),
    ...diff.changedItems.map((item) => finding({
      key: `描述變更:${item.partNumber}`,
      type: '描述變更',
      source: item.source,
      reference: item.reference,
      partNumber: item.partNumber
    })),
    ...diff.sourceMissingItems.map((item) => finding({
      key: `來源缺漏:${item.partNumber}`,
      type: '來源缺漏',
      reference: item.references[0],
      partNumber: item.partNumber
    })),
    ...diff.conflicts.map((item) => {
      const reference = item.references?.[0] ?? null;
      const identity = item.partNumber || reference?.rowNumber || 'unknown';
      return finding({
        key: `衝突:${item.type}:${identity}`,
        type: '衝突',
        source: item.source ?? null,
        reference,
        partNumber: item.partNumber
      });
    })
  ];
}

export function createGoogleSheetsReviewClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function listSheetProperties({ sheets, spreadsheetId }) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)'
  });
  return response.data.sheets?.map((sheet) => sheet.properties) ?? [];
}

function exactHeaders(actual, expected, label) {
  const normalized = Array.from({ length: expected.length }, (_, index) => String(actual[index] ?? ''));
  if (normalized.some((header, index) => header !== expected[index])) {
    throw new Error(`${label} 表頭不符，停止寫入`);
  }
}

function formatReviewSheetRequests(sheetId, rowCount) {
  const dimensions = [
    [0, 1, 220],
    [1, 4, 120],
    [4, 5, 180],
    [5, 6, 360],
    [6, 8, 220],
    [8, 9, 100],
    [9, 11, 160],
    [11, 14, 260],
    [14, 15, 260],
    [15, 17, 170],
    [17, 18, 260],
    [18, 19, 170]
  ].map(([startIndex, endIndex, pixelSize]) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex },
      properties: { pixelSize },
      fields: 'pixelSize'
    }
  }));
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 19 },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: {
              rgbColor: { red: 0.92941177, green: 0.92941177, blue: 0.92941177 }
            },
            horizontalAlignment: 'CENTER',
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat(backgroundColorStyle,horizontalAlignment,textFormat)'
      }
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount'
      }
    },
    {
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 19 }
        }
      }
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: ['待處理', '已解除'].map((userEnteredValue) => ({ userEnteredValue }))
          },
          strict: true,
          showCustomUi: true
        }
      }
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 3, endColumnIndex: 4 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: REVIEW_STATUS_VALUES.map((userEnteredValue) => ({ userEnteredValue }))
          },
          strict: true,
          showCustomUi: true
        }
      }
    },
    ...dimensions
  ];
}

export async function ensureReviewSheet({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('Google Sheet 審核區設定不完整');
  let properties = (await listSheetProperties({ sheets, spreadsheetId }))
    .find((sheet) => sheet.title === REVIEW_SHEET_NAME);
  let created = false;

  if (!properties) {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: REVIEW_SHEET_NAME,
              gridProperties: { rowCount: REVIEW_ROW_COUNT, columnCount: REVIEW_HEADERS.length }
            }
          }
        }]
      }
    });
    properties = response.data.replies?.[0]?.addSheet?.properties;
    if (!properties) {
      properties = (await listSheetProperties({ sheets, spreadsheetId }))
        .find((sheet) => sheet.title === REVIEW_SHEET_NAME);
    }
    if (!properties) throw new Error('建立飛鼠審核分頁後無法讀回分頁資訊');
    created = true;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${REVIEW_SHEET_NAME}'!A1:S1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...REVIEW_HEADERS]] }
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: formatReviewSheetRequests(properties.sheetId, properties.gridProperties?.rowCount ?? REVIEW_ROW_COUNT)
      }
    });
  } else {
    if ((properties.gridProperties?.columnCount ?? 0) < REVIEW_HEADERS.length) {
      throw new Error('飛鼠審核分頁欄數不足，停止寫入');
    }
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${REVIEW_SHEET_NAME}'!A1:S1`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    exactHeaders(response.data.values?.[0] ?? [], REVIEW_HEADERS, REVIEW_SHEET_NAME);
  }

  return { properties, created };
}

function reviewRow(findingItem, timestamp) {
  const { source, reference } = findingItem;
  return [
    findingItem.key,
    '待處理',
    findingItem.type,
    '待確認',
    findingItem.partNumber,
    source?.productName ?? '',
    source?.spec1 ?? '',
    source?.spec2 ?? '',
    source?.stock ?? '',
    source?.gtin ?? '',
    source?.location ?? '',
    reference?.productName ?? '',
    reference?.spec1 ?? '',
    reference?.spec2 ?? '',
    findingItem.fingerprint,
    timestamp,
    timestamp,
    '',
    ''
  ];
}

function paddedRow(row, width) {
  return Array.from({ length: width }, (_, index) => row[index] ?? '');
}

export async function syncReviewFindings({ sheets, spreadsheetId, diff, generatedAt }) {
  const { properties, created } = await ensureReviewSheet({ sheets, spreadsheetId });
  const rowCount = properties.gridProperties?.rowCount ?? REVIEW_ROW_COUNT;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${REVIEW_SHEET_NAME}'!A2:S${rowCount}`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const existingRows = (response.data.values ?? []).map((row) => paddedRow(row, REVIEW_HEADERS.length));
  const existingByKey = new Map();
  const occupiedRows = new Set();
  existingRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.some((value) => value !== '')) return;
    if (!row[0]) throw new Error(`飛鼠審核分頁第 ${rowNumber} 列有資料但缺少同步鍵`);
    if (existingByKey.has(row[0])) throw new Error(`飛鼠審核分頁同步鍵重複：${row[0]}`);
    existingByKey.set(row[0], { row, rowNumber });
    occupiedRows.add(rowNumber);
  });

  const timestamp = timestampInTaipei(generatedAt);
  const findings = buildReviewFindings(diff);
  const currentKeys = new Set(findings.map((item) => item.key));
  if (currentKeys.size !== findings.length) throw new Error('當次飛鼠差異包含重複同步鍵，停止寫入');
  const data = [];
  let inserted = 0;
  let updated = 0;
  let resolved = 0;
  let staleApprovals = 0;
  let nextCandidate = 2;

  const takeEmptyRow = () => {
    while (occupiedRows.has(nextCandidate)) nextCandidate += 1;
    if (nextCandidate > rowCount) throw new Error('飛鼠審核分頁已滿，停止寫入');
    occupiedRows.add(nextCandidate);
    return nextCandidate;
  };

  for (const item of findings) {
    const next = reviewRow(item, timestamp);
    const existing = existingByKey.get(item.key);
    if (!existing) {
      const rowNumber = takeEmptyRow();
      data.push({ range: `'${REVIEW_SHEET_NAME}'!A${rowNumber}:S${rowNumber}`, values: [next] });
      inserted += 1;
      continue;
    }

    const { row, rowNumber } = existing;
    next[3] = row[3] || '待確認';
    next[15] = row[15] || timestamp;
    data.push(
      { range: `'${REVIEW_SHEET_NAME}'!A${rowNumber}:C${rowNumber}`, values: [[...next.slice(0, 3)]] },
      { range: `'${REVIEW_SHEET_NAME}'!E${rowNumber}:Q${rowNumber}`, values: [[...next.slice(4, 17)]] }
    );
    if (row[14] && row[14] !== item.fingerprint && row[3] === '核准匯入') {
      data.push({ range: `'${REVIEW_SHEET_NAME}'!D${rowNumber}`, values: [['需重新確認']] });
      staleApprovals += 1;
    }
    if (row[1] === '已解除') {
      data.push({ range: `'${REVIEW_SHEET_NAME}'!S${rowNumber}`, values: [['']] });
    }
    updated += 1;
  }

  for (const [key, { row, rowNumber }] of existingByKey) {
    if (!currentKeys.has(key) && row[1] !== '已解除') {
      data.push(
        { range: `'${REVIEW_SHEET_NAME}'!B${rowNumber}`, values: [['已解除']] },
        { range: `'${REVIEW_SHEET_NAME}'!S${rowNumber}`, values: [[timestamp]] }
      );
      resolved += 1;
    }
  }

  if (data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return { created, findings: findings.length, inserted, updated, resolved, staleApprovals };
}

function buildDisplayName(source) {
  return [source.productName, source.spec1, source.spec2].map(normalizeText).filter(Boolean).join('｜');
}

function sameCatalogIdentity(mainRow, source) {
  return normalizeText(mainRow[1]) === normalizeText(source.productName) &&
    normalizeText(mainRow[2]) === normalizeText(source.spec1) &&
    normalizeText(mainRow[3]) === normalizeText(source.spec2) &&
    normalizeText(mainRow[5]) === normalizeText(source.gtin) &&
    normalizeText(mainRow[6]) === normalizeText(source.location);
}

export async function importApprovedNewItems({ sheets, spreadsheetId, sourceItems, generatedAt }) {
  const properties = await listSheetProperties({ sheets, spreadsheetId });
  const reviewSheet = properties.find((sheet) => sheet.title === REVIEW_SHEET_NAME);
  const mainSheet = properties.find((sheet) => sheet.title === MAIN_SHEET_NAME);
  if (!reviewSheet || !mainSheet) throw new Error('Google Sheet 缺少審核分頁或 SKU主檔');

  const reviewRowCount = reviewSheet.gridProperties?.rowCount ?? REVIEW_ROW_COUNT;
  const mainRowCount = mainSheet.gridProperties?.rowCount ?? 0;
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      `'${REVIEW_SHEET_NAME}'!A1:S${reviewRowCount}`,
      `'${MAIN_SHEET_NAME}'!A1:N${mainRowCount}`
    ],
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const reviewValues = response.data.valueRanges?.[0]?.values ?? [];
  const mainValues = response.data.valueRanges?.[1]?.values ?? [];
  exactHeaders(reviewValues[0] ?? [], REVIEW_HEADERS, REVIEW_SHEET_NAME);
  exactHeaders(mainValues[0] ?? [], MAIN_HEADERS, MAIN_SHEET_NAME);

  const reviewRows = reviewValues.slice(1)
    .map((row, index) => ({ row: paddedRow(row, REVIEW_HEADERS.length), rowNumber: index + 2 }));
  const reviewKeys = new Set();
  for (const { row, rowNumber } of reviewRows) {
    if (!row.some((value) => value !== '')) continue;
    if (!row[0]) throw new Error(`飛鼠審核分頁第 ${rowNumber} 列有資料但缺少同步鍵`);
    if (reviewKeys.has(row[0])) throw new Error(`飛鼠審核分頁同步鍵重複：${row[0]}`);
    reviewKeys.add(row[0]);
  }
  const approved = reviewRows
    .filter(({ row }) => row[1] === '待處理' && row[2] === '新增' && row[3] === '核准匯入');
  if (approved.length === 0) return { approved: 0, imported: 0, idempotent: 0, stale: 0 };
  const approvedSkus = approved.map(({ row }) => normalizeText(row[4]));
  if (new Set(approvedSkus).size !== approvedSkus.length) {
    throw new Error('審核分頁有重複核准的 SKU，停止匯入');
  }

  const mainBySku = new Map();
  const occupiedRows = new Set();
  for (let index = 1; index < mainValues.length; index += 1) {
    const row = paddedRow(mainValues[index], MAIN_HEADERS.length);
    const rowNumber = index + 1;
    if (!row.some((value) => value !== '')) continue;
    if (!row[0]) throw new Error(`SKU主檔第 ${rowNumber} 列有資料但缺少 SKU，停止匯入`);
    const sku = normalizeText(row[0]);
    if (mainBySku.has(sku)) throw new Error(`SKU主檔的 SKU 重複：${sku}`);
    mainBySku.set(sku, { row, rowNumber });
    occupiedRows.add(rowNumber);
  }

  const sourceBySku = new Map(sourceItems.map((item) => [normalizeText(item.partNumber), item]));
  const data = [];
  const timestamp = timestampInTaipei(generatedAt);
  let imported = 0;
  let idempotent = 0;
  let stale = 0;
  let nextCandidate = 2;
  const takeEmptyRow = () => {
    while (occupiedRows.has(nextCandidate)) nextCandidate += 1;
    if (nextCandidate > mainRowCount) throw new Error('SKU主檔已滿，停止匯入');
    occupiedRows.add(nextCandidate);
    return nextCandidate;
  };

  for (const approval of approved) {
    const sku = normalizeText(approval.row[4]);
    const source = sourceBySku.get(sku);
    const expectedFingerprint = source ? findingFingerprint('新增', source, null) : '';
    if (!source || approval.row[14] !== expectedFingerprint) {
      data.push(
        { range: `'${REVIEW_SHEET_NAME}'!D${approval.rowNumber}`, values: [['需重新確認']] },
        { range: `'${REVIEW_SHEET_NAME}'!S${approval.rowNumber}`, values: [[timestamp]] }
      );
      stale += 1;
      continue;
    }

    const existing = mainBySku.get(sku);
    if (existing) {
      const status = sameCatalogIdentity(existing.row, source) ? '已匯入' : '需重新確認';
      data.push(
        { range: `'${REVIEW_SHEET_NAME}'!D${approval.rowNumber}`, values: [[status]] },
        { range: `'${REVIEW_SHEET_NAME}'!S${approval.rowNumber}`, values: [[timestamp]] }
      );
      if (status === '已匯入') idempotent += 1;
      else stale += 1;
      continue;
    }

    const targetRow = takeEmptyRow();
    const mainRow = [
      source.partNumber,
      source.productName,
      source.spec1,
      source.spec2,
      source.stock,
      source.gtin,
      source.location,
      buildDisplayName(source),
      '一般SKU',
      '是'
    ];
    data.push(
      { range: `'${MAIN_SHEET_NAME}'!A${targetRow}:J${targetRow}`, values: [mainRow] },
      { range: `'${MAIN_SHEET_NAME}'!L${targetRow}:M${targetRow}`, values: [['件', '飛鼠']] },
      { range: `'${REVIEW_SHEET_NAME}'!D${approval.rowNumber}`, values: [['已匯入']] },
      { range: `'${REVIEW_SHEET_NAME}'!S${approval.rowNumber}`, values: [[timestamp]] }
    );
    mainBySku.set(sku, { row: [...mainRow, '', '件', '飛鼠', ''], rowNumber: targetRow });
    imported += 1;
  }

  if (data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }
  return { approved: approved.length, imported, idempotent, stale };
}

export async function syncReviewAndImport(input) {
  const review = await syncReviewFindings(input);
  const approvals = await importApprovedNewItems({
    sheets: input.sheets,
    spreadsheetId: input.spreadsheetId,
    sourceItems: input.sourceItems,
    generatedAt: input.generatedAt
  });
  return { review, approvals };
}
