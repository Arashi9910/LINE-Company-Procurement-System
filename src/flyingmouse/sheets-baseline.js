import { createHash } from 'node:crypto';
import { google } from 'googleapis';

const SHEET_NAME = 'SKU主檔';
const HEADERS = Object.freeze(['SKU', '商品名稱', '蝦皮規格1（原始）', '蝦皮規格2（原始）']);

export function createGoogleSheetsReadonlyClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

export async function loadReferenceCatalogFromSheet({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('Google Sheet baseline 設定不完整');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A2:D`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const items = (response.data.values ?? [])
    .map((row, index) => ({
      rowNumber: index + 2,
      partNumber: String(row[0] ?? '').trim(),
      productName: String(row[1] ?? '').replace(/\s+/g, ' ').trim(),
      spec1: String(row[2] ?? '').replace(/\s+/g, ' ').trim(),
      spec2: String(row[3] ?? '').replace(/\s+/g, ' ').trim()
    }))
    .filter((item) => item.partNumber || item.productName || item.spec1 || item.spec2);
  if (items.length === 0) throw new Error('Google Sheet 的 SKU主檔沒有商品資料');

  const sha256 = createHash('sha256')
    .update(JSON.stringify(items.map(({ partNumber, productName, spec1, spec2 }) => [
      partNumber,
      productName,
      spec1,
      spec2
    ])))
    .digest('hex');
  return Object.freeze({
    metadata: Object.freeze({
      sourceFile: 'Google Sheets:SKU主檔',
      worksheet: SHEET_NAME,
      headers: HEADERS,
      sha256,
      rowCount: items.length
    }),
    items: Object.freeze(items.map(Object.freeze))
  });
}
