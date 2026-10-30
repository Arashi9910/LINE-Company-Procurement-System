export const ORDER_SPEC_CORRECTION_HEADERS = Object.freeze([
  '修正後規格（SKU）',
  '修正狀態',
  '原始SKU（系統）'
]);

// 補貨追蹤的完整表頭。trackingItem 是用固定欄位序號取值的
// （G 狀態、H 下單量、J 到貨量…），欄位對調就會把下單量當成到貨量，
// 未到量算成 0、缺口整個錯，而且回寫佇列的前後指紋偵測不到這種結構錯誤。
// 最後三欄直接接 ORDER_SPEC_CORRECTION_HEADERS，不另外抄一份。
export const TRACKING_HEADERS = Object.freeze([
  '補貨單號',
  '申請時間',
  '申請人',
  '品項',
  '單位',
  '申請數量',
  '狀態',
  '下單數量',
  '預計到貨日',
  '實到數量',
  '未到數量',
  '重複警示',
  '備註',
  'SKU',
  'LINE使用者ID',
  '來源群組ID',
  '最後操作人ID',
  '最後更新時間',
  '操作金鑰',
  ...ORDER_SPEC_CORRECTION_HEADERS,
  // 每小時由同步從 SKU主檔 帶過來，只更新還在流程中的單（規格第 4.3 節）。
  '出貨型態'
]);

export const TRACKING_LAST_COLUMN = 'W';
export const TRACKING_ITEM_INDEX = 3;
export const TRACKING_STATUS_INDEX = 6;
export const TRACKING_SKU_INDEX = 13;
export const TRACKING_STOCK_MODE_INDEX = 22;
export const CORRECTION_SKU_INDEX = 19;
export const CORRECTION_STATUS_INDEX = 20;
export const ORIGINAL_SKU_INDEX = 21;

const TRACKING_SHEET = '補貨追蹤';
const SKU_SHEET = 'SKU主檔';
const TRACKING_ROW_COUNT = 5000;
const REQUIRED_COLUMN_COUNT = 22;

function text(value) {
  return String(value ?? '').trim();
}

function errorResult(item, message, extra = {}) {
  return {
    ...item,
    canonicalSku: text(item.sku),
    skuCorrectionRequested: Boolean(text(item.correctionSku) || text(item.originalSku)),
    skuCorrectionPending: false,
    skuCorrectionApplied: Boolean(text(item.originalSku)),
    skuCorrectionOriginalSku: text(item.originalSku),
    skuCorrectionError: message,
    ...extra
  };
}

export function exactOrderSpecCorrectionHeaders(headers) {
  const normalized = Array.from(
    { length: ORDER_SPEC_CORRECTION_HEADERS.length },
    (_, index) => String(headers?.[index] ?? '')
  );
  if (normalized.some((header, index) => header !== ORDER_SPEC_CORRECTION_HEADERS[index])) {
    throw new Error('補貨追蹤的規格修正欄位表頭不符');
  }
  return true;
}

export function orderSpecCorrectionStatusFormula() {
  return '=ARRAYFORMULA(IF(A2:A="","",IF(T2:T="","",IF(V2:V<>"",'
    + 'IF(T2:T=N2:N,"✅ 已套用","⛔ 已套用後不可再修改"),'
    + 'IF(N2:N=T2:T,"⚠ 與原規格相同",'
    + 'IF(J2:J>0,"⛔ 已有到貨，不可修改",'
    + 'IF(G2:G<>"已下單","⛔ 只有已下單可修改",'
    + 'IF(COUNTIF(\'SKU主檔\'!A:A,T2:T)=0,"⛔ SKU 不存在",'
    + 'IF(XLOOKUP(T2:T,\'SKU主檔\'!A:A,\'SKU主檔\'!J:J,"否")<>"是","⛔ 目標不可補貨",'
    + 'IF(XLOOKUP(N2:N,\'SKU主檔\'!A:A,\'SKU主檔\'!B:B,"")'
    + '<>XLOOKUP(T2:T,\'SKU主檔\'!A:A,\'SKU主檔\'!B:B,""),'
    + '"⛔ 不同商品，只能換規格","✅ 可套用"))))))))))';
}

export function resolveOrderSpecCorrection({ item, catalogBySku = new Map() }) {
  const canonicalSku = text(item?.sku);
  const correctionSku = text(item?.correctionSku);
  const originalSku = text(item?.originalSku);
  const base = {
    ...item,
    sku: canonicalSku,
    canonicalSku,
    correctionSku,
    originalSku,
    skuCorrectionRequested: Boolean(correctionSku || originalSku),
    skuCorrectionPending: false,
    skuCorrectionApplied: false,
    skuCorrectionOriginalSku: originalSku,
    skuCorrectionError: ''
  };

  if (originalSku) {
    if (!correctionSku) {
      return errorResult(base, '已套用的規格修正缺少修正後 SKU');
    }
    if (correctionSku !== canonicalSku) {
      return errorResult(base, '規格修正已套用，第一次到貨後不可再修改');
    }
    return {
      ...base,
      skuCorrectionApplied: true
    };
  }

  if (!correctionSku) return base;
  if (correctionSku === canonicalSku) {
    return errorResult(base, '修正後 SKU 與原規格相同');
  }
  if (Number(item?.receivedQuantity ?? 0) > 0) {
    return errorResult(base, '此品項已有到貨，不能修改規格');
  }
  if (text(item?.status) !== '已下單') {
    return errorResult(base, '只有已下單且尚未到貨的品項可以修改規格');
  }

  const current = catalogBySku.get(canonicalSku);
  const target = catalogBySku.get(correctionSku);
  if (!current) return errorResult(base, `原始 SKU ${canonicalSku} 不存在於 SKU主檔`);
  if (!target) return errorResult(base, `修正後 SKU ${correctionSku} 不存在於 SKU主檔`);
  if (target.available !== true) {
    return errorResult(base, `修正後 SKU ${correctionSku} 目前不可補貨`);
  }
  if (!text(current.productName) || text(current.productName) !== text(target.productName)) {
    return errorResult(base, '只能修改為同一商品的其他規格');
  }

  return {
    ...base,
    sku: correctionSku,
    displayName: text(target.displayName) || text(target.productName) || correctionSku,
    // 型態要換成修正後 SKU 的，不能留著原 SKU 的：同商品的兩個規格可能一個現貨
    // 一個預購。查不到就寫「未知」，不沿用舊值。
    stockMode: text(target.stockMode),
    unit: text(target.unit) || text(item?.unit) || '件',
    skuCorrectionPending: true,
    skuCorrectionOriginalSku: canonicalSku
  };
}

export function flagDuplicateEffectiveSkus(items) {
  const counts = new Map();
  for (const item of items) {
    const sku = text(item?.sku);
    const key = `${text(item?.requestId)}\u0000${sku}`;
    if (sku) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return items.map((item) => {
    const sku = text(item?.sku);
    const key = `${text(item?.requestId)}\u0000${sku}`;
    if (!sku || counts.get(key) === 1 || item.skuCorrectionError) return item;
    return {
      ...item,
      skuCorrectionError: `規格修正後，補貨單內出現重複 SKU ${sku}`
    };
  });
}

function columnLetter(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function headerCell(value) {
  return {
    userEnteredValue: { stringValue: value },
    userEnteredFormat: {
      backgroundColorStyle: { rgbColor: { red: 0.9294, green: 0.9294, blue: 0.9294 } },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
      textFormat: { bold: true }
    }
  };
}

function statusRule(sheetId, textValue, color, index) {
  return {
    addConditionalFormatRule: {
      index,
      rule: {
        ranges: [{
          sheetId,
          startRowIndex: 1,
          endRowIndex: TRACKING_ROW_COUNT,
          startColumnIndex: CORRECTION_STATUS_INDEX,
          endColumnIndex: CORRECTION_STATUS_INDEX + 1
        }],
        booleanRule: {
          condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: textValue }] },
          format: { backgroundColorStyle: { rgbColor: color } }
        }
      }
    }
  };
}

export async function ensureOrderSpecCorrectionSheet({ sheets, spreadsheetId }) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),conditionalFormats)'
  });
  const tracking = metadata.data.sheets?.find((sheet) => sheet.properties?.title === TRACKING_SHEET);
  const sku = metadata.data.sheets?.find((sheet) => sheet.properties?.title === SKU_SHEET);
  if (!tracking || !sku) throw new Error('Google Sheet 缺少補貨追蹤或 SKU主檔分頁');

  const sheetId = tracking.properties.sheetId;
  const columnCount = Number(tracking.properties.gridProperties?.columnCount ?? 0);
  const inspectColumnCount = Math.max(0, Math.min(REQUIRED_COLUMN_COUNT, columnCount) - CORRECTION_SKU_INDEX);
  let existingValues = [];
  if (inspectColumnCount > 0) {
    const endColumn = columnLetter(CORRECTION_SKU_INDEX + inspectColumnCount - 1);
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${TRACKING_SHEET}'!T1:${endColumn}${TRACKING_ROW_COUNT}`,
      valueRenderOption: 'FORMULA'
    });
    existingValues = existing.data.values ?? [];
  }

  const existingHeaders = Array.from(
    { length: ORDER_SPEC_CORRECTION_HEADERS.length },
    (_, index) => String(existingValues[0]?.[index] ?? '')
  );
  const hasAnyExistingValue = existingValues.some((row) => row.some((value) => value !== '' && value !== null));
  const installed = existingHeaders.every(
    (header, index) => header === ORDER_SPEC_CORRECTION_HEADERS[index]
  );
  if (hasAnyExistingValue && !installed) {
    throw new Error('補貨追蹤 T:V 已有其他資料，停止建立規格修正欄位');
  }

  const requests = [];
  if (columnCount < REQUIRED_COLUMN_COUNT) {
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { columnCount: REQUIRED_COLUMN_COUNT }
        },
        fields: 'gridProperties.columnCount'
      }
    });
  }
  if (!installed) {
    requests.push(
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: CORRECTION_SKU_INDEX,
            endColumnIndex: REQUIRED_COLUMN_COUNT
          },
          rows: [{ values: ORDER_SPEC_CORRECTION_HEADERS.map(headerCell) }],
          fields: 'userEnteredValue,userEnteredFormat'
        }
      },
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: TRACKING_ROW_COUNT,
            startColumnIndex: CORRECTION_SKU_INDEX,
            endColumnIndex: REQUIRED_COLUMN_COUNT
          },
          cell: {
            userEnteredFormat: { verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' }
          },
          fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)'
        }
      }
    );
    const conditionalIndex = tracking.conditionalFormats?.length ?? 0;
    requests.push(
      statusRule(sheetId, '✅', { red: 0.847, green: 0.929, blue: 0.827 }, conditionalIndex),
      statusRule(sheetId, '⚠', { red: 1, green: 0.949, blue: 0.776 }, conditionalIndex + 1),
      statusRule(sheetId, '⛔', { red: 0.957, green: 0.8, blue: 0.8 }, conditionalIndex + 2)
    );
  }

  requests.push(
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: CORRECTION_STATUS_INDEX,
          endColumnIndex: CORRECTION_STATUS_INDEX + 1
        },
        rows: [{ values: [{ userEnteredValue: { formulaValue: orderSpecCorrectionStatusFormula() } }] }],
        fields: 'userEnteredValue'
      }
    },
    {
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: TRACKING_ROW_COUNT,
          startColumnIndex: CORRECTION_SKU_INDEX,
          endColumnIndex: CORRECTION_SKU_INDEX + 1
        },
        rule: {
          condition: {
            type: 'ONE_OF_RANGE',
            values: [{ userEnteredValue: `='${SKU_SHEET}'!$A$2:$A` }]
          },
          strict: true,
          showCustomUi: true
        }
      }
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: CORRECTION_SKU_INDEX,
          endIndex: CORRECTION_SKU_INDEX + 1
        },
        properties: { pixelSize: 360 },
        fields: 'pixelSize'
      }
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: CORRECTION_STATUS_INDEX,
          endIndex: CORRECTION_STATUS_INDEX + 1
        },
        properties: { pixelSize: 220 },
        fields: 'pixelSize'
      }
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: ORIGINAL_SKU_INDEX,
          endIndex: ORIGINAL_SKU_INDEX + 1
        },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser'
      }
    }
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests }
  });

  const verification = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${TRACKING_SHEET}'!T1:V2`,
    valueRenderOption: 'FORMULA'
  });
  const values = verification.data.values ?? [];
  exactOrderSpecCorrectionHeaders(values[0] ?? []);
  if (values[1]?.[1] !== orderSpecCorrectionStatusFormula()) {
    throw new Error('規格修正狀態公式驗證失敗');
  }
  return {
    sheetId,
    installed: !installed,
    headers: [...ORDER_SPEC_CORRECTION_HEADERS]
  };
}
