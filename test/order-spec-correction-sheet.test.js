import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_SPEC_CORRECTION_HEADERS,
  ensureOrderSpecCorrectionSheet,
  orderSpecCorrectionStatusFormula
} from '../src/sheets/order-spec-correction.js';

function sheetsFixture({ columnCount = 19, existingValues = [] } = {}) {
  const calls = { batch: [], values: [] };
  let migrated = existingValues;
  return {
    calls,
    sheets: {
      spreadsheets: {
        async get() {
          return { data: { sheets: [
            {
              properties: {
                sheetId: 10,
                title: '補貨追蹤',
                gridProperties: { rowCount: 5000, columnCount }
              },
              conditionalFormats: Array.from({ length: 7 }, () => ({}))
            },
            {
              properties: {
                sheetId: 20,
                title: 'SKU主檔',
                gridProperties: { rowCount: 1000, columnCount: 14 }
              }
            }
          ] } };
        },
        values: {
          async get({ range }) {
            calls.values.push(range);
            if (range === "'補貨追蹤'!T1:V2") {
              return { data: { values: migrated } };
            }
            return { data: { values: existingValues } };
          }
        },
        async batchUpdate(request) {
          calls.batch.push(request);
          migrated = [
            [...ORDER_SPEC_CORRECTION_HEADERS],
            ['', orderSpecCorrectionStatusFormula(), '']
          ];
          return { data: {} };
        }
      }
    }
  };
}

test('order spec correction migration creates columns, validation, formula, colors, and hidden audit data', async () => {
  const fixture = sheetsFixture();
  const result = await ensureOrderSpecCorrectionSheet({
    sheets: fixture.sheets,
    spreadsheetId: 'sheet-123'
  });

  assert.equal(result.installed, true);
  const requests = fixture.calls.batch[0].requestBody.requests;
  assert.equal(requests.some((request) => request.updateSheetProperties), true);
  const validation = requests.find((request) => request.setDataValidation);
  assert.equal(validation?.setDataValidation.rule.condition.type, 'ONE_OF_RANGE');
  assert.equal(
    validation?.setDataValidation.rule.condition.values[0].userEnteredValue,
    "='SKU主檔'!$A$2:$A"
  );
  assert.equal(requests.filter((request) => request.addConditionalFormatRule).length, 3);
  assert.equal(requests.some((request) =>
    request.updateDimensionProperties?.properties?.hiddenByUser === true), true);
  assert.equal(requests.some((request) =>
    request.updateCells?.rows?.[0]?.values?.[0]?.userEnteredValue?.stringValue
      === '修正後規格（SKU）'), true);
  assert.deepEqual(fixture.calls.values, ["'補貨追蹤'!T1:V2"]);
});

test('order spec correction migration is rerunnable without duplicating conditional rules', async () => {
  const fixture = sheetsFixture({
    columnCount: 22,
    existingValues: [
      [...ORDER_SPEC_CORRECTION_HEADERS],
      ['', orderSpecCorrectionStatusFormula(), '']
    ]
  });
  const result = await ensureOrderSpecCorrectionSheet({
    sheets: fixture.sheets,
    spreadsheetId: 'sheet-123'
  });

  assert.equal(result.installed, false);
  const requests = fixture.calls.batch[0].requestBody.requests;
  assert.equal(requests.some((request) => request.updateSheetProperties), false);
  assert.equal(requests.some((request) => request.addConditionalFormatRule), false);
  assert.equal(requests.some((request) => request.setDataValidation), true);
});

test('order spec correction migration stops when T:V already contains unrelated data', async () => {
  const fixture = sheetsFixture({ columnCount: 22, existingValues: [['既有欄位']] });
  await assert.rejects(ensureOrderSpecCorrectionSheet({
    sheets: fixture.sheets,
    spreadsheetId: 'sheet-123'
  }), /已有其他資料/);
  assert.equal(fixture.calls.batch.length, 0);
});
