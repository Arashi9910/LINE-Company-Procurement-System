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

// 卡片把規格獨立一行顯示，所以 API 要把規格與商品名稱分開回傳。
// 不可以讓前端從「規格｜名稱」切回來：商品名稱本身可能含「｜」，切錯就顯示成別的東西。
test('規格與商品名稱分開回傳，前端不必解析字串', () => {
  const view = buildShortageView({
    dashboard: dashboard([row({ sku: 'E1EF5F', displayName: '一條魚項鍊｜預購⚡路亞釣魚項鍊 路亞 釣魚' })]),
    images: [{ sku: 'E1EF5F', variantName: '飛鼠規格', productName: '預購⚡路亞釣魚項鍊 路亞 釣魚' }],
    orderableSkus: [{ sku: 'E1EF5F', unit: '件', spec1: '一條魚項鍊', spec2: '' }]
  });

  const [item] = view.reorder;
  // SKU主檔 的蝦皮規格優先，那是採購在表上看到的字。
  assert.equal(item.spec, '一條魚項鍊');
  assert.equal(item.productName, '預購⚡路亞釣魚項鍊 路亞 釣魚');
});

test('兩個蝦皮規格要併起來，沒有規格時回空字串', () => {
  const view = buildShortageView({
    dashboard: dashboard([row({ sku: 'A' }), row({ sku: 'B' })]),
    orderableSkus: [
      { sku: 'A', unit: '件', spec1: '紅色', spec2: '大' },
      { sku: 'B', unit: '件' }
    ]
  });

  assert.equal(view.reorder.find((x) => x.sku === 'A').spec, '紅色｜大');
  assert.equal(view.reorder.find((x) => x.sku === 'B').spec, '');
});

test('沒有蝦皮規格時退回飛鼠的規格名稱', () => {
  const view = buildShortageView({
    dashboard: dashboard([row({ sku: 'A' })]),
    images: [{ sku: 'A', variantName: '飛鼠才有的規格', productName: '商品' }],
    orderableSkus: [{ sku: 'A', unit: '件' }]
  });

  assert.equal(view.reorder[0].spec, '飛鼠才有的規格');
});
