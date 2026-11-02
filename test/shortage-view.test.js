import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortageView, pickImageUrl } from '../src/services/shortage-view.js';
import { groupShortageRows } from '../src/services/inventory-dashboard.js';
import { formatShortageSummary } from '../src/services/group-commands.js';

function row(overrides = {}) {
  return {
    sku: 'SKU-A',
    displayName: '雨傘 大',
    flyingmouseStock: 1,
    processing: 0,
    preparing: 0,
    unshipped: 0,
    onOrder: 0,
    preorderAllowance: 0,
    safetyStock: 0,
    allowanceSource: '名稱推導：現貨',
    estimatedStock: 1,
    gap: 3,
    status: '要叫貨',
    note: '',
    updatedAt: '2026-10-30 20:04:34',
    ...overrides
  };
}

function dashboard(rows, extra = {}) {
  return {
    rows,
    syncStatus: { status: '正常', lastSuccessAt: '2026-10-30 20:04:34', lastAttemptAt: '', message: '' },
    movement: null,
    ...extra
  };
}

test('每一列都帶自己的貨號，名稱截短後長得一樣也分得出來', () => {
  const sameName = '超長商品名稱超長商品名稱超長商品名稱超長商品名稱';
  const view = buildShortageView({
    dashboard: dashboard([
      row({ sku: 'A-紅', displayName: `${sameName}紅色`, gap: 5 }),
      row({ sku: 'A-藍', displayName: `${sameName}藍色`, gap: 3 })
    ]),
    orderableSkus: [{ sku: 'A-紅', unit: '件' }, { sku: 'A-藍', unit: '件' }]
  });

  assert.deepEqual(view.reorder.map((item) => item.sku), ['A-紅', 'A-藍']);
});

test('分組與 LINE 文字摘要走同一份邏輯，筆數不會對不起來', () => {
  const data = dashboard(
    [
      row({ sku: 'SKU-A', gap: 3 }),
      row({ sku: 'SKU-TEST', gap: 2 }),
      row({ sku: 'SKU-BAD', gap: 9, status: '異常', note: '查無貨號' })
    ],
    {
      movement: {
        skus: new Set(['SKU-A']),
        since: '',
        updatedAt: '2026-10-30 20:04:34',
        initialized: true
      }
    }
  );
  const view = buildShortageView({ dashboard: data, orderableSkus: [{ sku: 'SKU-A', unit: '件' }] });
  const grouped = groupShortageRows(data);

  assert.equal(view.reorder.length, grouped.active.length);
  assert.equal(view.anomaly.length, grouped.anomaly.length);
  assert.equal(view.quiet, grouped.quiet);
  // 沒在動的那筆不該出現在清單上。
  assert.equal(view.reorder.some((item) => item.sku === 'SKU-TEST'), false);
  assert.match(formatShortageSummary(data), /要叫貨 1 個/);
  assert.match(formatShortageSummary(data), /需人工確認 1 個/);
  assert.match(formatShortageSummary(data), /近 30 天沒有訂單 1 個/);
});

// 缺貨清單上有些列在 SKU主檔 標記為不可補貨（2026-10-30 的正式資料是 28 筆中 7 筆）。
// 它們確實缺貨所以要列出來，但不能讓人勾選——submitRequest 會擋，等送出才失敗更糟。
test('不在可補貨清單裡的列標成不可下單，但照樣列出來', () => {
  const view = buildShortageView({
    dashboard: dashboard([row({ sku: 'SKU-A' }), row({ sku: 'SKU-OFF', gap: 1 })]),
    images: [{ sku: 'SKU-OFF', mainImageUrl: 'https://img/off.jpg' }],
    orderableSkus: [{ sku: 'SKU-A', unit: '件', stockMode: '現貨' }]
  });

  const [first, second] = view.reorder;
  assert.equal(first.orderable, true);
  assert.equal(first.stockMode, '現貨');
  assert.equal(second.sku, 'SKU-OFF');
  assert.equal(second.orderable, false);
  // 不能下單也要看得到圖，採購才認得出是哪一支。
  assert.equal(second.imageUrl, 'https://img/off.jpg');
  assert.equal(view.blockedCount, 1);
});

test('圖片優先用規格圖，沒有才退到商品首圖與列表圖', () => {
  assert.equal(pickImageUrl({
    variantImageUrl: 'https://img/variant.jpg',
    mainImageUrl: 'https://img/main.jpg',
    listImageUrl: 'https://img/list.jpg'
  }), 'https://img/variant.jpg');
  assert.equal(pickImageUrl({ mainImageUrl: 'https://img/main.jpg', listImageUrl: 'https://img/list.jpg' }),
    'https://img/main.jpg');
  assert.equal(pickImageUrl({ listImageUrl: 'https://img/list.jpg' }), 'https://img/list.jpg');
  assert.equal(pickImageUrl({}), '');
});

test('查無圖片時回空字串，讓前端顯示佔位方塊而不是壞掉的 img', () => {
  const view = buildShortageView({
    dashboard: dashboard([row()]),
    orderableSkus: [{ sku: 'SKU-A', unit: '件' }]
  });

  assert.equal(view.reorder[0].imageUrl, '');
  assert.equal(view.reorder[0].unit, '件');
});

test('沒有缺貨時三個清單都是空的，摘要也說沒有', () => {
  const data = dashboard([row({ gap: 0, status: '正常' })]);
  const view = buildShortageView({ dashboard: data, orderableSkus: [] });

  assert.deepEqual(view.reorder, []);
  assert.deepEqual(view.anomaly, []);
  assert.equal(view.blockedCount, 0);
  assert.match(formatShortageSummary(data), /目前沒有要叫貨的品項/);
});
