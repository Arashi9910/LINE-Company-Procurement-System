import { parseWritebackRows, WRITEBACK_ROW_COUNT } from '../flyingmouse/sheets-writeback.js';

export const PILOT_COUNT_SKU = '830941146509-0-0';
const headers = ['紀錄類型', 'SKU', '規格', '盤點基準時間（台北）', '實盤件數', '關聯單號', '依據與適用範圍'];

// Warehouse dispatches do not have a verified data source yet. Never infer a
// current balance by subtracting sales, or by assuming zero dispatches.
export async function readCountPreview({ sheets, spreadsheetId }) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["'盤點對帳'!A1:G", "'飛鼠庫存回寫'!A1:O" + WRITEBACK_ROW_COUNT],
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const [counts, receipts] = response.data.valueRanges;
  const [header = [], ...rows] = counts.values ?? [];
  if (headers.some((name, index) => header[index] !== name)) throw new Error('盤點對帳表頭不符');
  const selected = rows.filter(row => row[1] === PILOT_COUNT_SKU);
  const starts = selected.filter(row => row[0] === '實盤起點');
  if (starts.length !== 1) throw new Error('請核對盤點起點');
  const [, , , serial, physical] = starts[0];
  if (!Number.isFinite(serial) || serial < 1 || !Number.isSafeInteger(physical) || physical < 0) {
    throw new Error('盤點時間或件數無效');
  }
  const wallTime = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  const countedAt = wallTime.toISOString().slice(0, 16).replace('T', ' ');
  const exclusions = selected.filter(row => row[0] === '排除舊單');
  if (selected.length !== 1 + exclusions.length ||
      exclusions.some(row => row[3] !== serial || typeof row[5] !== 'string' || !row[5].trim())) {
    throw new Error('盤點排除資料不完整');
  }
  const excludedOrders = [...new Set(exclusions.map(row => row[5]))];
  const events = parseWritebackRows(receipts.values ?? []).filter(e => e.sku === PILOT_COUNT_SKU);
  // The original physical count is only precise to the minute.
  if (events.some(e => e.createdAt.slice(0, 16) === countedAt)) throw new Error('同分鐘到貨需人工核對');
  const received = events.filter(e => e.createdAt.slice(0, 16) > countedAt)
    .reduce((sum, e) => sum + e.receivedQuantity, 0);
  return { countedAt, physical, received, excludedOrders };
}
