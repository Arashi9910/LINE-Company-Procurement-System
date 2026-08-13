import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exactOrderSpecCorrectionHeaders,
  flagDuplicateEffectiveSkus,
  orderSpecCorrectionStatusFormula,
  resolveOrderSpecCorrection
} from '../src/sheets/order-spec-correction.js';

const catalogBySku = new Map([
  ['SKU-RED', {
    sku: 'SKU-RED', productName: '收納盒', displayName: '收納盒｜紅色', unit: '個', available: true
  }],
  ['SKU-BLUE', {
    sku: 'SKU-BLUE', productName: '收納盒', displayName: '收納盒｜藍色', unit: '個', available: true
  }],
  ['SKU-OFF', {
    sku: 'SKU-OFF', productName: '收納盒', displayName: '收納盒｜停用色', unit: '個', available: false
  }],
  ['SKU-CUP', {
    sku: 'SKU-CUP', productName: '水杯', displayName: '水杯｜透明', unit: '個', available: true
  }]
]);

function item(overrides = {}) {
  return {
    sku: 'SKU-RED',
    displayName: '收納盒｜紅色',
    unit: '個',
    status: '已下單',
    receivedQuantity: 0,
    correctionSku: '',
    originalSku: '',
    ...overrides
  };
}

test('order spec correction headers and status formula keep the Sheet contract explicit', () => {
  assert.equal(exactOrderSpecCorrectionHeaders([
    '修正後規格（SKU）', '修正狀態', '原始SKU（系統）'
  ]), true);
  assert.throws(() => exactOrderSpecCorrectionHeaders(['錯誤', '修正狀態', '原始SKU（系統）']), /表頭不符/);
  const formula = orderSpecCorrectionStatusFormula();
  assert.match(formula, /已有到貨/);
  assert.match(formula, /不同商品/);
  assert.match(formula, /已套用後不可再修改/);
});

test('a valid same-product correction becomes the effective SKU before receipt', () => {
  const result = resolveOrderSpecCorrection({
    item: item({ correctionSku: 'SKU-BLUE' }),
    catalogBySku
  });

  assert.equal(result.sku, 'SKU-BLUE');
  assert.equal(result.canonicalSku, 'SKU-RED');
  assert.equal(result.displayName, '收納盒｜藍色');
  assert.equal(result.skuCorrectionPending, true);
  assert.equal(result.skuCorrectionOriginalSku, 'SKU-RED');
  assert.equal(result.skuCorrectionError, '');
});

test('a correction is rejected after receipt, for another product, or for an unavailable SKU', () => {
  const received = resolveOrderSpecCorrection({
    item: item({ correctionSku: 'SKU-BLUE', status: '部分到貨', receivedQuantity: 1 }),
    catalogBySku
  });
  assert.match(received.skuCorrectionError, /已有到貨/);
  assert.equal(received.sku, 'SKU-RED');

  const anotherProduct = resolveOrderSpecCorrection({
    item: item({ correctionSku: 'SKU-CUP' }),
    catalogBySku
  });
  assert.match(anotherProduct.skuCorrectionError, /同一商品/);

  const unavailable = resolveOrderSpecCorrection({
    item: item({ correctionSku: 'SKU-OFF' }),
    catalogBySku
  });
  assert.match(unavailable.skuCorrectionError, /不可補貨/);
});

test('an applied correction remains canonical and blocks later edits', () => {
  const applied = resolveOrderSpecCorrection({
    item: item({
      sku: 'SKU-BLUE',
      correctionSku: 'SKU-BLUE',
      originalSku: 'SKU-RED',
      status: '部分到貨',
      receivedQuantity: 1,
      displayName: '收納盒｜藍色'
    }),
    catalogBySku
  });
  assert.equal(applied.sku, 'SKU-BLUE');
  assert.equal(applied.skuCorrectionApplied, true);
  assert.equal(applied.skuCorrectionError, '');

  const changedAgain = resolveOrderSpecCorrection({
    item: item({
      sku: 'SKU-BLUE', correctionSku: 'SKU-CUP', originalSku: 'SKU-RED', receivedQuantity: 1
    }),
    catalogBySku
  });
  assert.equal(changedAgain.sku, 'SKU-BLUE');
  assert.match(changedAgain.skuCorrectionError, /不可再修改/);
});

test('duplicate effective SKUs are marked invalid', () => {
  const rows = flagDuplicateEffectiveSkus([
    resolveOrderSpecCorrection({ item: item({ correctionSku: 'SKU-BLUE' }), catalogBySku }),
    resolveOrderSpecCorrection({ item: item({ sku: 'SKU-BLUE', displayName: '收納盒｜藍色' }), catalogBySku })
  ]);

  assert.equal(rows[0].sku, 'SKU-BLUE');
  assert.match(rows[0].skuCorrectionError, /重複 SKU/);
  assert.match(rows[1].skuCorrectionError, /重複 SKU/);
});
