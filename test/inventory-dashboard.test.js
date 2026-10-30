import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_STATUS,
  resolveTrackingSku,
  describeCorrectionIssue,
  sumOutstandingBySku,
  buildInventoryDashboard
} from '../src/services/inventory-dashboard.js';
import {
  flagDuplicateEffectiveSkus,
  resolveOrderSpecCorrection
} from '../src/sheets/order-spec-correction.js';

const UPDATED_AT = '2026-10-29T12:00:00.000Z';

function dashboard(overrides = {}) {
  return buildInventoryDashboard({
    catalog: [],
    orderQuantities: [],
    tracking: [],
    preorders: [],
    writebackPendingSkus: [],
    updatedAt: UPDATED_AT,
    ...overrides
  });
}

function rowFor(result, sku) {
  const row = result.rows.find((candidate) => candidate.sku === sku);
  assert.ok(row, `找不到 ${sku} 的看板列`);
  return row;
}

// ── 規格第 3 節的商品 A 驗算表（預購額度 10）──────────────────

const VERIFICATION_TABLE = [
  { label: '賣 3', stock: 7, unshipped: 3, onOrder: 0, estimatedStock: 0, gap: 3 },
  { label: '叫 5', stock: 7, unshipped: 3, onOrder: 5, estimatedStock: 0, gap: -2 },
  { label: '到貨 5（現行回寫：7 + 5）', stock: 12, unshipped: 3, onOrder: 0, estimatedStock: 5, gap: -2 },
  { label: '寄 3', stock: 12, unshipped: 0, onOrder: 0, estimatedStock: 2, gap: -2 },
  { label: '再賣 3', stock: 9, unshipped: 3, onOrder: 0, estimatedStock: 2, gap: 1 }
];

for (const step of VERIFICATION_TABLE) {
  test(`規格第 3 節驗算表：${step.label}`, () => {
    const result = dashboard({
      catalog: [{ sku: 'A', displayName: '商品 A', stock: step.stock }],
      orderQuantities: [{ partNo: 'A', processing: step.unshipped, preparing: 0, total: step.unshipped }],
      tracking: step.onOrder > 0
        ? [{ sku: 'A', status: '已下單', orderedQuantity: step.onOrder, receivedQuantity: 0 }]
        : [],
      preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
    });
    const row = rowFor(result, 'A');
    assert.equal(row.flyingmouseStock, step.stock, '飛鼠庫存');
    assert.equal(row.unshipped, step.unshipped, '賣掉還沒寄');
    assert.equal(row.onOrder, step.onOrder, '已叫貨未到');
    assert.equal(row.estimatedStock, step.estimatedStock, '推算實際庫存');
    assert.equal(row.gap, step.gap, '缺口');
  });
}

test('兩條缺口公式等價：缺口不受訂單狀態分類影響', () => {
  const base = {
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 9 }],
    preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
  };
  // 同樣 3 件未寄，一次全算處理中、一次全算備貨中，缺口必須一樣。
  const allProcessing = dashboard({
    ...base, orderQuantities: [{ partNo: 'A', processing: 3, preparing: 0, total: 3 }]
  });
  const allPreparing = dashboard({
    ...base, orderQuantities: [{ partNo: 'A', processing: 0, preparing: 3, total: 3 }]
  });
  assert.equal(rowFor(allProcessing, 'A').gap, rowFor(allPreparing, 'A').gap);
  assert.equal(rowFor(allProcessing, 'A').gap, 1);
});

// ── 狀態判定 ────────────────────────────────────────────────

test('缺口大於 0 且推算實際庫存不為負時標成要叫貨', () => {
  // 推算實際 1（非負，所以不是異常），缺口 0+3−1−0 = 2。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 1 }],
    preorders: [{ sku: 'A', preorderAllowance: 0, safetyStock: 3 }]
  });
  assert.equal(rowFor(result, 'A').estimatedStock, 1);
  assert.equal(rowFor(result, 'A').gap, 2);
  assert.equal(rowFor(result, 'A').status, DASHBOARD_STATUS.REORDER);
});

test('推算實際庫存為負時，即使缺口大於 0 也先標異常', () => {
  // 庫存 0、預購額度 5：缺口 5 但推算實際 −5，代表帳不對，要先人工看。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    preorders: [{ sku: 'A', preorderAllowance: 5, safetyStock: 0 }]
  });
  const row = rowFor(result, 'A');
  assert.equal(row.gap, 5);
  assert.equal(row.estimatedStock, -5);
  assert.equal(row.status, DASHBOARD_STATUS.ANOMALY);
  assert.equal(row.reorderable, false, '帳不對就不該自動叫貨');
});

test('推算實際庫存小於 0 標成異常', () => {
  // 預購額度填得比實際多，推算實際庫存為負。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 2 }],
    orderQuantities: [{ partNo: 'A', processing: 1, preparing: 0, total: 1 }],
    preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
  });
  const row = rowFor(result, 'A');
  assert.equal(row.estimatedStock, -7);
  assert.equal(row.status, DASHBOARD_STATUS.ANOMALY);
  assert.match(row.note, /預購額度|人工/);
});

test('缺口不大於 0 且推算實際庫存不為負時標成正常', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 12 }],
    preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
  });
  assert.equal(rowFor(result, 'A').status, DASHBOARD_STATUS.NORMAL);
});

test('安全庫存沒填時當作 0', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 3 }],
    preorders: [{ sku: 'A', preorderAllowance: 3 }]
  });
  assert.equal(rowFor(result, 'A').safetyStock, 0);
  assert.equal(rowFor(result, 'A').gap, 0);
});

test('安全庫存會推高缺口', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 3 }],
    preorders: [{ sku: 'A', preorderAllowance: 3, safetyStock: 2 }]
  });
  assert.equal(rowFor(result, 'A').gap, 2);
  assert.equal(rowFor(result, 'A').status, DASHBOARD_STATUS.REORDER);
});

test('回寫未完成的 SKU 不發布缺口，狀態蓋過要叫貨與異常', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    preorders: [{ sku: 'A', preorderAllowance: 5, safetyStock: 0 }],
    writebackPendingSkus: ['A']
  });
  const row = rowFor(result, 'A');
  assert.equal(row.status, DASHBOARD_STATUS.WRITEBACK_PENDING);
  assert.equal(row.gap, null, '回寫沒跑完的數字不可拿來叫貨');
  assert.equal(row.reorderable, false);
});

// ── 關閉預購的判斷（規格第 3 節最後一列）──────────────────────

test('未寄數量超過推算實際庫存時，標出還不能關閉預購與差幾個', () => {
  // 推算實際 2、還有 3 單沒寄 → 差 1 個。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 9 }],
    orderQuantities: [{ partNo: 'A', processing: 3, preparing: 0, total: 3 }],
    preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
  });
  const row = rowFor(result, 'A');
  assert.equal(row.estimatedStock, 2);
  assert.equal(row.preorderCloseShortfall, 1);
  assert.match(row.note, /不能關閉預購/);
});

test('推算實際庫存足夠時沒有關閉預購的缺口', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 12 }],
    orderQuantities: [{ partNo: 'A', processing: 2, preparing: 0, total: 2 }],
    preorders: [{ sku: 'A', preorderAllowance: 10, safetyStock: 0 }]
  });
  assert.equal(rowFor(result, 'A').preorderCloseShortfall, 0);
});

test('沒有預購額度的 SKU 不做關閉預購判斷', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    orderQuantities: [{ partNo: 'A', processing: 3, preparing: 0, total: 3 }]
  });
  assert.equal(rowFor(result, 'A').preorderCloseShortfall, null);
});

// ── 已叫貨未到：狀態篩選、修正後規格、共用貨號 ─────────────────

test('只有已下單與部分到貨算進已叫貨未到', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    tracking: [
      { sku: 'A', status: '已下單', orderedQuantity: 5, receivedQuantity: 0 },
      { sku: 'A', status: '部分到貨', orderedQuantity: 4, receivedQuantity: 1 },
      { sku: 'A', status: '已完成', orderedQuantity: 9, receivedQuantity: 9 },
      { sku: 'A', status: '取消', orderedQuantity: 7, receivedQuantity: 0 },
      { sku: 'A', status: '已轉單', orderedQuantity: 6, receivedQuantity: 0 }
    ],
    preorders: [{ sku: 'A', preorderAllowance: 1 }]
  });
  assert.equal(rowFor(result, 'A').onOrder, 5 + 3, '5 + (4−1)');
});

test('已叫貨未到以下單量減到貨量計算，不吃現成的未到量欄位', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    tracking: [{
      sku: 'A', status: '部分到貨', orderedQuantity: 10, receivedQuantity: 4,
      outstandingQuantity: 999
    }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }]
  });
  assert.equal(rowFor(result, 'A').onOrder, 6);
});

test('到貨量大於下單量時以 0 計，不產生負的已叫貨未到', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    tracking: [{ sku: 'A', status: '部分到貨', orderedQuantity: 3, receivedQuantity: 5 }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }]
  });
  assert.equal(rowFor(result, 'A').onOrder, 0);
});

test('resolveTrackingSku 以上游解析後的 item.sku 為準', () => {
  // resolveOrderSpecCorrection 對合法修正會直接把 sku 換成修正後 SKU。
  assert.equal(resolveTrackingSku({ sku: 'NEW', skuCorrectionPending: true, skuCorrectionOriginalSku: 'OLD' }), 'NEW');
  assert.equal(resolveTrackingSku({ sku: 'OLD' }), 'OLD');
  assert.equal(resolveTrackingSku({ sku: ' OLD ' }), 'OLD');
  // 錯誤時上游保留原 SKU。
  assert.equal(resolveTrackingSku({ sku: 'OLD', skuCorrectionError: '不可補貨' }), 'OLD');
});

test('已叫貨未到算進修正後規格，不算進原 SKU', () => {
  // 上游解析後的形狀：合法的修正已經把 sku 換成 NEW。
  const result = dashboard({
    catalog: [
      { sku: 'OLD', displayName: '原規格', stock: 1 },
      { sku: 'NEW', displayName: '修正後規格', stock: 1 }
    ],
    tracking: [{
      sku: 'NEW', skuCorrectionPending: true, skuCorrectionOriginalSku: 'OLD',
      status: '已下單', orderedQuantity: 4, receivedQuantity: 0
    }]
  });
  assert.equal(rowFor(result, 'NEW').onOrder, 4);
  assert.equal(rowFor(result, 'NEW').status, DASHBOARD_STATUS.NORMAL);
  assert.equal(rowFor(result, 'OLD').onOrder, 0);
});

test('sumOutstandingBySku 把同一貨號的多列相加', () => {
  const sums = sumOutstandingBySku([
    { sku: 'A', status: '已下單', orderedQuantity: 3, receivedQuantity: 0 },
    { sku: 'A', status: '部分到貨', orderedQuantity: 5, receivedQuantity: 2 },
    { sku: 'B', status: '已下單', orderedQuantity: 1, receivedQuantity: 0 }
  ]);
  assert.equal(sums.get('A'), 6);
  assert.equal(sums.get('B'), 1);
});

test('共用貨號只產生一列，數量合併計算', () => {
  // 同一個貨號綁在兩個銷售商品底下，訂單統計已經依貨號彙總。
  const result = dashboard({
    catalog: [{ sku: 'HA-GD-068', displayName: '雛菊積木收納盒', stock: 4 }],
    orderQuantities: [{ partNo: 'HA-GD-068', processing: 2, preparing: 1, total: 3 }],
    tracking: [
      { sku: 'HA-GD-068', status: '已下單', orderedQuantity: 2, receivedQuantity: 0 },
      { sku: 'HA-GD-068', status: '已下單', orderedQuantity: 3, receivedQuantity: 0 }
    ],
    preorders: [{ sku: 'HA-GD-068', preorderAllowance: 6 }]
  });
  const matching = result.rows.filter((row) => row.sku === 'HA-GD-068');
  assert.equal(matching.length, 1, '共用貨號不可重複列');
  assert.equal(matching[0].unshipped, 3);
  assert.equal(matching[0].onOrder, 5);
  assert.equal(matching[0].processing, 2);
  assert.equal(matching[0].preparing, 1);
});

// ── 篩選與排序（規格第 4.1 節）────────────────────────────────

test('只列出有庫存、有訂單、有叫貨中或有填預購額度的 SKU', () => {
  const result = dashboard({
    catalog: [
      { sku: 'STOCK', displayName: '有庫存', stock: 3 },
      { sku: 'ORDER', displayName: '有訂單', stock: 0 },
      { sku: 'ONORDER', displayName: '有叫貨中', stock: 0 },
      { sku: 'PRE', displayName: '有預購額度', stock: 0 },
      { sku: 'QUIET', displayName: '四樣都沒有', stock: 0 },
      { sku: 'NEGATIVE', displayName: '負庫存也要看得到', stock: -2 }
    ],
    orderQuantities: [{ partNo: 'ORDER', processing: 1, preparing: 0, total: 1 }],
    tracking: [{ sku: 'ONORDER', status: '已下單', orderedQuantity: 2, receivedQuantity: 0 }],
    preorders: [{ sku: 'PRE', preorderAllowance: 1 }]
  });
  const skus = result.rows.map((row) => row.sku).sort();
  assert.deepEqual(skus, ['NEGATIVE', 'ONORDER', 'ORDER', 'PRE', 'STOCK']);
});

test('只填安全庫存、沒填預購額度的 SKU 也要列出', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    preorders: [{ sku: 'A', preorderAllowance: 0, safetyStock: 2 }]
  });
  assert.equal(rowFor(result, 'A').safetyStock, 2);
});

test('排序：要叫貨在前、接著異常、回寫未完成，最後正常；同類缺口大的在前', () => {
  const result = dashboard({
    catalog: [
      { sku: 'NORMAL', displayName: '正常', stock: 20 },
      { sku: 'REORDER-SMALL', displayName: '小缺口', stock: 1 },
      { sku: 'REORDER-BIG', displayName: '大缺口', stock: 1 },
      { sku: 'ANOMALY', displayName: '異常', stock: 0 },
      { sku: 'PENDING', displayName: '回寫未完成', stock: 1 }
    ],
    orderQuantities: [{ partNo: 'ANOMALY', processing: 1, preparing: 0, total: 1 }],
    preorders: [
      { sku: 'NORMAL', preorderAllowance: 1 },
      { sku: 'REORDER-SMALL', safetyStock: 3 },
      { sku: 'REORDER-BIG', safetyStock: 10 },
      { sku: 'ANOMALY', preorderAllowance: 50 },
      { sku: 'PENDING', safetyStock: 5 }
    ],
    writebackPendingSkus: ['PENDING']
  });
  assert.deepEqual(result.rows.map((row) => row.sku), [
    'REORDER-BIG', 'REORDER-SMALL', 'ANOMALY', 'PENDING', 'NORMAL'
  ]);
});

test('同類同缺口時依 SKU 排序，輸出穩定', () => {
  const result = dashboard({
    catalog: [
      { sku: 'B', displayName: 'B', stock: 1 },
      { sku: 'A', displayName: 'A', stock: 1 }
    ],
    preorders: [{ sku: 'A', safetyStock: 4 }, { sku: 'B', safetyStock: 4 }]
  });
  assert.deepEqual(result.rows.map((row) => row.sku), ['A', 'B']);
});

// ── 不存在於 SKU主檔 的 SKU（規格第 5 節）─────────────────────

test('預購額度分頁的 SKU 不在 SKU主檔時標成異常，不中斷整批', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 5 }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }, { sku: 'GHOST', preorderAllowance: 3 }]
  });
  const ghost = rowFor(result, 'GHOST');
  assert.equal(ghost.status, DASHBOARD_STATUS.ANOMALY);
  assert.match(ghost.note, /SKU主檔/);
  assert.equal(ghost.reorderable, false, '查不到主檔資料就不該據此叫貨');
  assert.ok(rowFor(result, 'A'), '其他 SKU 仍要照常計算');
});

test('訂單或補貨追蹤出現 SKU主檔沒有的貨號時標成異常，不默默丟掉數量', () => {
  const result = dashboard({
    catalog: [],
    orderQuantities: [{ partNo: 'GHOST-ORDER', processing: 2, preparing: 0, total: 2 }],
    tracking: [{ sku: 'GHOST-TRACK', status: '已下單', orderedQuantity: 1, receivedQuantity: 0 }]
  });
  assert.equal(rowFor(result, 'GHOST-ORDER').status, DASHBOARD_STATUS.ANOMALY);
  assert.equal(rowFor(result, 'GHOST-ORDER').unshipped, 2);
  assert.equal(rowFor(result, 'GHOST-TRACK').status, DASHBOARD_STATUS.ANOMALY);
  assert.equal(rowFor(result, 'GHOST-TRACK').onOrder, 1);
});

test('SKU主檔重複 SKU 要丟錯，避免兩列互相覆蓋', () => {
  assert.throws(() => dashboard({
    catalog: [
      { sku: 'A', displayName: '一', stock: 1 },
      { sku: 'A', displayName: '二', stock: 2 }
    ]
  }), /重複/);
});

test('預購額度分頁重複 SKU 要丟錯', () => {
  assert.throws(() => dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 1 }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }, { sku: 'A', preorderAllowance: 2 }]
  }), /重複/);
});

// ── 輸入驗證 ────────────────────────────────────────────────

test('拒絕不合法的數字，不可用 Number() 把 null 當成 0', () => {
  for (const stock of [null, '', true, {}, [], 1.5, undefined]) {
    assert.throws(() => dashboard({
      catalog: [{ sku: 'A', displayName: '商品 A', stock }]
    }), /庫存/, `stock=${JSON.stringify(stock)} 必須被拒絕`);
  }
  assert.equal(rowFor(dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: '7' }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }]
  }), 'A').flyingmouseStock, 7, '數字字串仍接受');
});

test('拒絕負的預購額度與負的安全庫存', () => {
  assert.throws(() => dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 1 }],
    preorders: [{ sku: 'A', preorderAllowance: -1 }]
  }), /預購額度/);
  assert.throws(() => dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 1 }],
    preorders: [{ sku: 'A', safetyStock: -1 }]
  }), /安全庫存/);
});

test('拒絕空白 SKU', () => {
  assert.throws(() => dashboard({ catalog: [{ sku: '  ', displayName: 'x', stock: 1 }] }), /SKU/);
  assert.throws(() => dashboard({
    catalog: [], orderQuantities: [{ partNo: '', processing: 1, preparing: 0, total: 1 }]
  }), /貨號|SKU/);
});

test('回傳更新時間，且不寫入任何輸入資料', () => {
  const catalog = [{ sku: 'A', displayName: '商品 A', stock: 1 }];
  const preorders = [{ sku: 'A', preorderAllowance: 1 }];
  const snapshot = JSON.stringify({ catalog, preorders });
  const result = dashboard({ catalog, preorders });
  assert.equal(result.updatedAt, UPDATED_AT);
  assert.equal(JSON.stringify({ catalog, preorders }), snapshot, '不可改動輸入');
});

test('沒有任何資料時回傳空清單而不是丟錯', () => {
  const result = dashboard();
  assert.deepEqual(result.rows, []);
  assert.equal(result.updatedAt, UPDATED_AT);
});

test('輸出商品名稱供看板顯示', () => {
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '金屬主機架', stock: 2 }],
    preorders: [{ sku: 'A', preorderAllowance: 1 }]
  });
  assert.equal(rowFor(result, 'A').displayName, '金屬主機架');
});

// ── Codex 檢查發現 ──────────────────────────────────────────

test('回寫未完成時，備註不可洩漏被壓下來的缺貨數字', () => {
  // 計畫的商品 A：快照 7、未寄 3、額度 10，已登記到貨 5 但還沒回寫。
  // 回寫完成後庫存會變 12，其實夠用，這時不該宣稱還差 3 個。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 7 }],
    orderQuantities: [{ partNo: 'A', processing: 3, preparing: 0, total: 3 }],
    preorders: [{ sku: 'A', preorderAllowance: 10 }],
    writebackPendingSkus: ['A']
  });
  const row = rowFor(result, 'A');
  assert.equal(row.status, DASHBOARD_STATUS.WRITEBACK_PENDING);
  assert.equal(row.preorderCloseShortfall, null);
  assert.ok(!row.note.includes('關閉預購'), `備註不該提關閉預購：${row.note}`);
  assert.ok(!/\d/.test(row.note), `備註不該出現任何數字：${row.note}`);
});

test('看到尚未驗證的 correctionSku 時不猜合法性，算回原 SKU 並標異常', () => {
  // 可不可補貨、是否同一商品要靠 SKU主檔才判斷得出來，本模組沒有那些欄位。
  const result = dashboard({
    catalog: [
      { sku: 'OLD', displayName: '原規格', stock: 0 },
      { sku: 'NEW', displayName: '修正後規格', stock: 0 }
    ],
    tracking: [{
      sku: 'OLD', correctionSku: 'NEW', status: '已下單',
      orderedQuantity: 10, receivedQuantity: 0
    }]
  });
  assert.equal(rowFor(result, 'OLD').onOrder, 10, '算回原 SKU');
  assert.equal(rowFor(result, 'OLD').status, DASHBOARD_STATUS.ANOMALY);
  assert.match(rowFor(result, 'OLD').note, /尚未驗證/);
  assert.match(rowFor(result, 'OLD').note, /未到量算在 OLD/);
  assert.equal(rowFor(result, 'OLD').reorderable, false);
  assert.equal(result.rows.find((row) => row.sku === 'NEW'), undefined,
    '不可把無法到貨的數量當成 NEW 的供貨');
});

test('已套用的規格修正（originalSku 已填）照常採用', () => {
  const result = dashboard({
    catalog: [{ sku: 'NEW', displayName: '修正後規格', stock: 0 }],
    tracking: [{
      sku: 'NEW', correctionSku: 'NEW', originalSku: 'OLD',
      status: '部分到貨', orderedQuantity: 6, receivedQuantity: 1
    }]
  });
  assert.equal(rowFor(result, 'NEW').onOrder, 5);
  assert.equal(rowFor(result, 'NEW').status, DASHBOARD_STATUS.NORMAL);
});

test('上游已解析出 skuCorrectionError 時，一律算回原 SKU 並標異常', () => {
  // 涵蓋 order-spec-correction 那些需要 SKU主檔才能判斷的情況：
  // 修正後 SKU 不可補貨、不是同一商品、不存在於主檔。
  for (const reason of [
    '修正後 SKU NEW 目前不可補貨',
    '只能修改為同一商品的其他規格',
    '修正後 SKU NEW 不存在於 SKU主檔'
  ]) {
    const result = dashboard({
      catalog: [{ sku: 'OLD', displayName: '原規格', stock: 0 }],
      tracking: [{
        sku: 'OLD', status: '已下單', orderedQuantity: 3, receivedQuantity: 0,
        skuCorrectionError: reason
      }]
    });
    assert.equal(rowFor(result, 'OLD').onOrder, 3, reason);
    assert.equal(rowFor(result, 'OLD').status, DASHBOARD_STATUS.ANOMALY, reason);
    assert.equal(rowFor(result, 'OLD').reorderable, false, reason);
  }
});

test('repository 的實際輸出形狀：有 skuCorrectionError 但沒有 correctionSku 也要標異常', () => {
  // listOpenRequests / listRequestRows 只輸出 sku 與 skuCorrectionError，不輸出 correctionSku。
  const result = dashboard({
    catalog: [{ sku: 'OLD', displayName: '原規格', stock: 0 }],
    tracking: [{
      sku: 'OLD', status: '部分到貨', orderedQuantity: 10, receivedQuantity: 2,
      skuCorrectionError: '此品項已有到貨，不能修改規格'
    }]
  });
  const row = rowFor(result, 'OLD');
  assert.equal(row.onOrder, 8);
  assert.equal(row.status, DASHBOARD_STATUS.ANOMALY, '到貨流程會因同一個錯誤擋下登記，不可當成正常供貨');
  assert.equal(row.reorderable, false);
  assert.match(row.note, /規格修正/);
});

test('describeCorrectionIssue 先看 skuCorrectionError，不因 correctionSku 空白就放行', () => {
  assert.equal(describeCorrectionIssue({ sku: 'OLD', skuCorrectionError: '壞掉了' }), '壞掉了');
  assert.equal(describeCorrectionIssue({ sku: 'OLD' }), '');
  // 已解析過的合法修正：sku 已換成 NEW，沒有殘留的 correctionSku。
  assert.equal(describeCorrectionIssue({ sku: 'NEW', skuCorrectionPending: true }), '');
  // 已套用：correctionSku 等於現行 sku。
  assert.equal(describeCorrectionIssue({ sku: 'NEW', correctionSku: 'NEW', originalSku: 'OLD' }), '');
  // 未解析的生料：不猜，直接標異常。
  assert.match(describeCorrectionIssue({ sku: 'OLD', correctionSku: 'NEW' }), /尚未驗證/);
});

test('補貨已全數到貨、只剩回寫未完成的 SKU 仍要出現在看板', () => {
  // confirmReceipt 先把追蹤改成已完成，completeWritebackEvent 才更新快照，
  // 中間這段時間該 SKU 沒庫存、沒訂單、沒預購額度、也沒有未到量。
  const result = dashboard({
    catalog: [{ sku: 'A', displayName: '商品 A', stock: 0 }],
    orderQuantities: [],
    tracking: [{ sku: 'A', status: '已完成', orderedQuantity: 5, receivedQuantity: 5 }],
    preorders: [],
    writebackPendingSkus: ['A']
  });
  const row = rowFor(result, 'A');
  assert.equal(row.status, DASHBOARD_STATUS.WRITEBACK_PENDING);
  assert.equal(row.gap, null);
  assert.equal(row.estimatedStock, null);
  assert.equal(row.reorderable, false);
});

test('回寫未完成的 SKU 連 SKU主檔都沒有時，仍列出且標回寫未完成', () => {
  const result = dashboard({ catalog: [], writebackPendingSkus: ['GHOST'] });
  assert.equal(rowFor(result, 'GHOST').status, DASHBOARD_STATUS.WRITEBACK_PENDING);
});

// ── 串接真實的規格修正解析器 + repository 輸出形狀 ──────────────

const CORRECTION_CATALOG = new Map([
  ['OLD', { sku: 'OLD', productName: '收納盒', displayName: '收納盒｜紅', unit: '個', available: true }],
  ['NEW', { sku: 'NEW', productName: '收納盒', displayName: '收納盒｜藍', unit: '個', available: true }]
]);

// 比照 repository.listOpenRequests／listRequestRows 的輸出欄位。
function asRepositoryRow(item) {
  return {
    requestId: item.requestId,
    displayName: item.displayName,
    status: item.status,
    orderedQuantity: item.orderedQuantity,
    receivedQuantity: item.receivedQuantity,
    outstandingQuantity: item.outstandingQuantity,
    sku: item.sku,
    ...(item.skuCorrectionError ? { skuCorrectionError: item.skuCorrectionError } : {}),
    ...(item.skuCorrectionPending ? { skuCorrectionPending: true } : {}),
    ...(item.skuCorrectionOriginalSku ? { skuCorrectionOriginalSku: item.skuCorrectionOriginalSku } : {})
  };
}

function resolvedTracking(items) {
  return flagDuplicateEffectiveSkus(
    items.map((item) => resolveOrderSpecCorrection({ item, catalogBySku: CORRECTION_CATALOG }))
  ).map(asRepositoryRow);
}

test('修正後與既有列撞號時，未到量回到原 SKU，兩個 SKU 都標異常', () => {
  // OLD 要改成 NEW，但同一張單本來就有 NEW → flagDuplicateEffectiveSkus 在換過
  // sku 之後才標錯誤，所以該列的 sku 已經是 NEW，貨卻還是會以 OLD 進來。
  const tracking = resolvedTracking([
    { requestId: 'R1', sku: 'OLD', status: '已下單', receivedQuantity: 0, orderedQuantity: 5, correctionSku: 'NEW', originalSku: '' },
    { requestId: 'R1', sku: 'NEW', status: '已下單', receivedQuantity: 0, orderedQuantity: 2, correctionSku: '', originalSku: '' }
  ]);
  assert.equal(tracking[0].sku, 'NEW', '前提：上游確實已經把 sku 換成 NEW');
  assert.match(tracking[0].skuCorrectionError, /重複 SKU/);

  const result = buildInventoryDashboard({
    catalog: [
      { sku: 'OLD', displayName: '收納盒｜紅', stock: 0 },
      { sku: 'NEW', displayName: '收納盒｜藍', stock: 0 }
    ],
    orderQuantities: [],
    tracking,
    preorders: [{ sku: 'OLD', safetyStock: 5 }],
    writebackPendingSkus: [],
    updatedAt: UPDATED_AT
  });

  assert.equal(rowFor(result, 'OLD').onOrder, 5, '貨會以 OLD 進來，未到量要掛回 OLD');
  assert.equal(rowFor(result, 'OLD').status, DASHBOARD_STATUS.ANOMALY);
  assert.equal(rowFor(result, 'OLD').reorderable, false, '修正出錯時不可自動叫貨');
  assert.match(rowFor(result, 'OLD').note, /未到量算在 OLD/);
  assert.equal(rowFor(result, 'NEW').status, DASHBOARD_STATUS.ANOMALY);
});

test('已套用的修正即使再次出錯，也不可把未到量退回歷史 SKU', () => {
  const tracking = resolvedTracking([
    // originalSku 已填代表修正早就套用完成，現在又想改成別的 → 上游報錯。
    { requestId: 'R2', sku: 'NEW', status: '部分到貨', receivedQuantity: 1, orderedQuantity: 6, correctionSku: 'OLD', originalSku: 'OLD' }
  ]);
  assert.match(tracking[0].skuCorrectionError, /不可再修改/);

  const result = buildInventoryDashboard({
    catalog: [
      { sku: 'OLD', displayName: '收納盒｜紅', stock: 0 },
      { sku: 'NEW', displayName: '收納盒｜藍', stock: 0 }
    ],
    orderQuantities: [],
    tracking,
    preorders: [],
    writebackPendingSkus: [],
    updatedAt: UPDATED_AT
  });

  assert.equal(rowFor(result, 'NEW').onOrder, 5, '貨以現行的 NEW 進來');
  assert.equal(result.rows.find((row) => row.sku === 'OLD'), undefined, '不可退回歷史 SKU');
  assert.match(rowFor(result, 'NEW').note, /未到量算在 NEW/, '備註不可宣稱算回原 SKU');
  assert.ok(!rowFor(result, 'NEW').note.includes('算回原 SKU'),
    `備註與實際歸屬不符會害人工核帳算錯：${rowFor(result, 'NEW').note}`);
});

test('合法且無衝突的修正，未到量算到修正後 SKU 且不標異常', () => {
  const tracking = resolvedTracking([
    { requestId: 'R3', sku: 'OLD', status: '已下單', receivedQuantity: 0, orderedQuantity: 4, correctionSku: 'NEW', originalSku: '' }
  ]);
  assert.equal(tracking[0].skuCorrectionError, undefined);

  const result = buildInventoryDashboard({
    catalog: [
      { sku: 'OLD', displayName: '收納盒｜紅', stock: 0 },
      { sku: 'NEW', displayName: '收納盒｜藍', stock: 0 }
    ],
    orderQuantities: [],
    tracking,
    preorders: [],
    writebackPendingSkus: [],
    updatedAt: UPDATED_AT
  });

  assert.equal(rowFor(result, 'NEW').onOrder, 4);
  assert.equal(rowFor(result, 'NEW').status, DASHBOARD_STATUS.NORMAL);
});
