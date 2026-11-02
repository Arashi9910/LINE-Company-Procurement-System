import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkuRetirement, RETIREMENT_STATUS } from '../src/services/sku-retirement.js';

function catalogRow(sku, overrides = {}) {
  return { sku, displayName: sku, stock: 0, available: false, ...overrides };
}

const OLD = '069A04-舊款拉絲黑';
const NEW = '830941146509-0-0';

function base(overrides = {}) {
  return {
    retirements: [{ rowNumber: 2, oldSku: OLD, newSku: NEW }],
    catalog: [catalogRow(OLD), catalogRow(NEW, { available: true, stock: 4 })],
    orderQuantities: [{ partNo: OLD, processing: 2, preparing: 1 }],
    tracking: [],
    recentUnits: new Map([[OLD, 5], [NEW, 2]]),
    ...overrides
  };
}

test('未寄與近 30 天售出搬到新貨號，舊貨號不再出現', () => {
  const result = applySkuRetirement(base());

  assert.equal(result.applied, 1);
  assert.equal(result.results[0].status, RETIREMENT_STATUS.APPLIED);
  // 未寄：舊的 processing+preparing 併到新貨號那一列。
  assert.deepEqual(result.orderQuantities, [{ partNo: NEW, processing: 2, preparing: 1 }]);
  // 近 30 天：5（舊）+ 2（新）= 7，每筆訂單只記在一個貨號下，相加不重複。
  assert.equal(result.recentUnits.get(NEW), 7);
  assert.equal(result.recentUnits.has(OLD), false);
  assert.deepEqual(result.catalog.map((row) => row.sku), [NEW]);
  // 數字變大要講得出來自哪裡。
  assert.match(result.notes.get(NEW), /含已汰換 069A04-舊款拉絲黑 的未寄 3 件、近 30 天 5 件/);
});

test('多個舊貨號指到同一個新貨號時數字相加', () => {
  const second = '155118-舊款胡桃色';
  const result = applySkuRetirement(base({
    retirements: [
      { rowNumber: 2, oldSku: OLD, newSku: NEW },
      { rowNumber: 3, oldSku: second, newSku: NEW }
    ],
    catalog: [catalogRow(OLD), catalogRow(second), catalogRow(NEW, { available: true })],
    orderQuantities: [
      { partNo: OLD, processing: 2, preparing: 0 },
      { partNo: second, processing: 1, preparing: 1 }
    ],
    recentUnits: new Map([[OLD, 5], [second, 3]])
  }));

  assert.equal(result.applied, 2);
  assert.equal(result.recentUnits.get(NEW), 8);
  const unshipped = result.orderQuantities
    .filter((entry) => entry.partNo === NEW)
    .reduce((sum, entry) => sum + entry.processing + entry.preparing, 0);
  assert.equal(unshipped, 4);
  assert.match(result.notes.get(NEW), /；/, '兩條來源都要寫進備註');
});

// 擋下的每一條都只影響自己，不可以讓整輪同步失敗。
const blockedCases = [
  ['新貨號不在 SKU主檔', { catalog: [catalogRow(OLD)] }, /不在 SKU主檔/],
  ['新貨號不可補貨', { catalog: [catalogRow(OLD), catalogRow(NEW)] }, /不可補貨/],
  ['舊貨號仍可補貨', {
    catalog: [catalogRow(OLD, { available: true }), catalogRow(NEW, { available: true })]
  }, /仍是可補貨/],
  ['舊貨號還有庫存', {
    catalog: [catalogRow(OLD, { stock: 3 }), catalogRow(NEW, { available: true })]
  }, /庫存是 3/],
  ['舊貨號還有未到量', {
    tracking: [{ sku: OLD, status: '已下單', orderedQuantity: 5, receivedQuantity: 1 }]
  }, /還有 4 件已叫貨未到/],
  ['自我對應', { retirements: [{ rowNumber: 2, oldSku: OLD, newSku: OLD }] }, /相同/],
  ['舊貨號空白', { retirements: [{ rowNumber: 2, oldSku: '', newSku: NEW }] }, /空白/]
];

for (const [name, overrides, pattern] of blockedCases) {
  test(`擋下：${name}`, () => {
    const result = applySkuRetirement(base(overrides));

    assert.equal(result.applied, 0);
    assert.equal(result.results[0].status, RETIREMENT_STATUS.BLOCKED);
    assert.match(result.results[0].reason, pattern);
    // 擋下就什麼都不搬，輸入原樣回去。
    assert.equal(result.recentUnits.has(OLD), true);
    assert.equal(result.orderQuantities[0].partNo, OLD);
  });
}

test('擋下鏈狀對應，不讓結果取決於套用順序', () => {
  const middle = 'MID-中間貨號';
  const result = applySkuRetirement(base({
    retirements: [
      { rowNumber: 2, oldSku: OLD, newSku: middle },
      { rowNumber: 3, oldSku: middle, newSku: NEW }
    ],
    catalog: [catalogRow(OLD), catalogRow(middle), catalogRow(NEW, { available: true })]
  }));

  assert.equal(result.applied, 0);
  assert.equal(result.results.every((row) => row.status === RETIREMENT_STATUS.BLOCKED), true);
  assert.match(result.results.map((row) => row.reason).join('｜'), /鏈狀/);
});

test('同一個舊貨號填兩次就兩條都擋下', () => {
  const result = applySkuRetirement(base({
    retirements: [
      { rowNumber: 2, oldSku: OLD, newSku: NEW },
      { rowNumber: 3, oldSku: OLD, newSku: '830941146509-0-1' }
    ]
  }));

  assert.equal(result.applied, 0);
  assert.match(result.results[0].reason, /出現多次/);
  assert.match(result.results[1].reason, /出現多次/);
});

test('沒有對應時完全不動原本的輸入', () => {
  const input = base({ retirements: [] });
  const result = applySkuRetirement(input);

  assert.equal(result.applied, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.catalog, input.catalog);
  assert.equal(result.orderQuantities, input.orderQuantities);
  assert.equal(result.recentUnits, input.recentUnits);
  assert.equal(result.notes.size, 0);
});
