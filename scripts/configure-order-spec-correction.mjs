import { parseArgs } from 'node:util';
import { createGoogleSheetsClient } from '../src/sheets/repository.js';
import { ensureOrderSpecCorrectionSheet } from '../src/sheets/order-spec-correction.js';

function spreadsheetIdFromArguments() {
  const { values } = parseArgs({
    options: {
      'spreadsheet-id': { type: 'string' }
    }
  });
  const spreadsheetId = String(values['spreadsheet-id'] ?? process.env.SPREADSHEET_ID ?? '').trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) {
    throw new Error('請提供有效的 --spreadsheet-id');
  }
  return spreadsheetId;
}

const spreadsheetId = spreadsheetIdFromArguments();
const result = await ensureOrderSpecCorrectionSheet({
  sheets: createGoogleSheetsClient(),
  spreadsheetId
});
console.log(JSON.stringify({
  event: 'order_spec_correction_sheet_ready',
  installed: result.installed,
  sheetId: result.sheetId
}));
