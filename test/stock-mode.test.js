import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COVER_DAYS,
  STOCK_MODE,
  classifyStockMode,
  safetyStockFromVelocity
} from '../src/services/stock-mode.js';
import { ALLOWANCE_SOURCE, buildInventoryDashboard } from '../src/services/inventory-dashboard.js';

// 這些字串都是 2026-10-30 從正式 SKU主檔 抄下來的真實商品名稱開頭。
test('classifyStockMode reads the real labels in the catalog', () => {
  const physical = [
    '現貨⚡️GD權志龍 Übermensch演場會 權志龍同款吉他撥片',
    '現貨秒發⚡️金屬可伸縮調節 可移動置物主機架',
    '【台灣現貨】荔枝紋皮革防滑桌墊 電腦桌墊',
    '隔日到貨⚡️壓克力遊戲手柄展示架 無線桌面耳機掛架',
    '【SS 現貨】骷髏頭白松石 設計感 純鋼 不掉色 項鍊',
    'HANNYA原創 現貨✨BIGBANG周邊 20週年應援'
  ];
  for (const name of physical) {
    assert.equal(classifyStockMode(name), STOCK_MODE.PHYSICAL, name);
  }

  const preorder = [
    '預購 人體工學椅 電腦椅 懶人可躺 舒服久坐',
    '預售✨Hearts2Hearts心連心應援棒收納包',
    '預購⚡床上升降折疊電腦桌 可傾斜筆電桌',
    'HANNYA原創 預售⚡️SHINee 手燈展示盒'
  ];
  for (const name of preorder) {
    assert.equal(classifyStockMode(name), STOCK_MODE.PREORDER, name);
  }
});

test('all four spellings of the mixed label stay unknown, not physical', () => {
  // 「現貨＋預購」如果被前面的「現貨」規則先吃掉，就會被當成純現貨，
  // 額度算 0、推算實際灌水。四種拼法都要先比對混合。
  for (const name of [
    '現貨＋預購✨AIMZENIX台灣總代理AX系列轉換器',
    '現貨+預購✨ 台北場 權志龍 GD周邊 Übermensch 應援棒',
    '【現貨+預售】電腦螢幕增高架 電腦顯示器置物架',
    '現貨＋預售 台北場 林俊傑周邊 JJ20 應援棒'
  ]) {
    assert.equal(classifyStockMode(name), STOCK_MODE.UNKNOWN, name);
  }
});

test('classifyStockMode only looks at the start of the name', () => {
  // 商品描述裡常常也有「現貨」「預購」，不能讓後面的字影響判斷。
  assert.equal(
    classifyStockMode('RGB螢幕機械臂 帶Type-c介面 現貨供應中'),
    STOCK_MODE.UNKNOWN
  );
  assert.equal(classifyStockMode(''), STOCK_MODE.UNKNOWN);
  assert.equal(classifyStockMode(null), STOCK_MODE.UNKNOWN);
});

test('safetyStockFromVelocity rounds up and respects the cover window', () => {
  assert.equal(DEFAULT_COVER_DAYS, 14);
  // 月售 13、留 14 天 → 13 × 14/30 = 6.07 → 7。無條件進位，寧可多留一個。
  assert.equal(safetyStockFromVelocity(13, 14), 7);
  assert.equal(safetyStockFromVelocity(30, 14), 14);
  assert.equal(safetyStockFromVelocity(1, 14), 1);
  // 完全沒動就不留（使用者：賣很慢或很差，也沒必要去採購）。
  assert.equal(safetyStockFromVelocity(0, 14), 0);
  assert.equal(safetyStockFromVelocity(13, 0), 0);
  assert.throws(() => safetyStockFromVelocity(-1, 14), /非負整數/);
  assert.throws(() => safetyStockFromVelocity(1.5, 14), /非負整數/);
  assert.throws(() => safetyStockFromVelocity(1, -1), /非負整數/);
});

function build(overrides = {}) {
  return buildInventoryDashboard({
    catalog: [
      { sku: 'PRE', displayName: '預售✨小卡展示架', stock: 10 },
      { sku: 'PHY', displayName: '現貨✨BIGBANG周邊', stock: 1 },
      { sku: 'MIX', displayName: '現貨＋預購✨轉換器', stock: 4 }
    ],
    orderQuantities: [
      { partNo: 'PRE', processing: 4, preparing: 0 },
      { partNo: 'PHY', processing: 6, preparing: 0 }
    ],
    stockModes: new Map([
      ['PRE', STOCK_MODE.PREORDER],
      ['PHY', STOCK_MODE.PHYSICAL],
      ['MIX', STOCK_MODE.UNKNOWN]
    ]),
    recentUnits: new Map([['PRE', 2], ['PHY', 13], ['MIX', 9]]),
    updatedAt: '2026-10-30 14:00:00',
    ...overrides
  });
}

test('a pure preorder SKU needs no human input at all', () => {
  const row = build().rows.find((item) => item.sku === 'PRE');

  // 手上沒有實體 → 額度 = 飛鼠 10 + 未寄 4 = 14 → 推算實際恆為 0。
  assert.equal(row.preorderAllowance, 14);
  assert.equal(row.safetyStock, 0);
  assert.equal(row.estimatedStock, 0);
  // 缺口收斂成「我欠客戶幾件還沒去訂」。
  assert.equal(row.gap, 4);
  assert.equal(row.status, '要叫貨');
  assert.equal(row.allowanceSource, ALLOWANCE_SOURCE.PREORDER);
});

test('a physical SKU is triggered by velocity, not by a preorder allowance', () => {
  const row = build().rows.find((item) => item.sku === 'PHY');

  // 月售 13、留 14 天 → 安全庫存 7；缺口 = 7 − 飛鼠 1 − 叫貨中 0 = 6。
  assert.equal(row.preorderAllowance, 0);
  assert.equal(row.safetyStock, 7);
  assert.equal(row.estimatedStock, 7);
  assert.equal(row.gap, 6);
  assert.equal(row.status, '要叫貨');
  assert.equal(row.allowanceSource, ALLOWANCE_SOURCE.PHYSICAL);
});

test('a mixed-label SKU is treated as physical, which is the safe side', () => {
  const row = build().rows.find((item) => item.sku === 'MIX');

  // 猜成預購的話，額度 = 庫存 + 未寄，缺口會變成未寄量——可能叫到已經有的貨。
  assert.equal(row.preorderAllowance, 0);
  assert.equal(row.safetyStock, 5);
  assert.equal(row.allowanceSource, ALLOWANCE_SOURCE.PHYSICAL);
});

test('the 預購額度 sheet always beats the name-derived default', () => {
  // 使用者說名稱標籤不保證 100% 正確，所以人工填的永遠贏。
  const row = build({
    preorders: [{ sku: 'PHY', preorderAllowance: 20, safetyStock: 3 }]
  }).rows.find((item) => item.sku === 'PHY');

  assert.equal(row.preorderAllowance, 20);
  assert.equal(row.safetyStock, 3);
  assert.equal(row.allowanceSource, ALLOWANCE_SOURCE.MANUAL);
  assert.equal(row.estimatedStock, 1 + 6 - 20);
  assert.equal(row.status, '異常', '推算實際為負要標異常');
});

test('the close-preorder note only shows for a hand-written allowance', () => {
  // 推導額度時推算實際恆為 0，這個數字永遠等於未寄量，跟缺口講同一件事。
  const derived = build().rows.find((item) => item.sku === 'PRE');
  assert.equal(derived.preorderCloseShortfall, null);
  assert.equal(derived.note, '');

  // 人工填的額度才有「能不能關閉預購」這個問題。
  const manual = build({
    preorders: [{ sku: 'PRE', preorderAllowance: 10, safetyStock: 0 }]
  }).rows.find((item) => item.sku === 'PRE');
  assert.equal(manual.estimatedStock, 10 + 4 - 10);
  assert.equal(manual.preorderCloseShortfall, 0);
});

test('a quiet physical SKU never asks to be reordered', () => {
  const row = build({ recentUnits: new Map([['PHY', 0]]) })
    .rows.find((item) => item.sku === 'PHY');

  assert.equal(row.safetyStock, 0);
  assert.equal(row.gap, -1);
  assert.equal(row.status, '正常');
});

test('a sold-out physical SKU with nothing else still reaches the board', () => {
  // 庫存 0、貨都寄完、沒有叫貨中、沒有人工額度——四項候選條件都不符合，
  // 但它正是最該補貨的那一種。使用者說「賣 1 件也要知道」。
  const rows = buildInventoryDashboard({
    catalog: [{ sku: 'SOLDOUT', displayName: '現貨✨賣完了', stock: 0 }],
    orderQuantities: [],
    stockModes: new Map([['SOLDOUT', STOCK_MODE.PHYSICAL]]),
    recentUnits: new Map([['SOLDOUT', 1]]),
    updatedAt: '2026-10-30 14:00:00'
  }).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].safetyStock, 1);
  assert.equal(rows[0].gap, 1);
  assert.equal(rows[0].status, '要叫貨');
});

test('a SKU with zero recent units does not get dragged onto the board', () => {
  const rows = buildInventoryDashboard({
    catalog: [{ sku: 'QUIET', displayName: '現貨✨沒人買', stock: 0 }],
    stockModes: new Map([['QUIET', STOCK_MODE.PHYSICAL]]),
    recentUnits: new Map([['QUIET', 0]]),
    updatedAt: '2026-10-30 14:00:00'
  }).rows;

  assert.deepEqual(rows, []);
});

test('without stockModes the board behaves exactly as before', () => {
  const rows = buildInventoryDashboard({
    catalog: [{ sku: 'PHY', displayName: '現貨✨某某', stock: 5 }],
    orderQuantities: [{ partNo: 'PHY', processing: 2, preparing: 0 }],
    updatedAt: '2026-10-30 14:00:00'
  }).rows;

  assert.equal(rows[0].preorderAllowance, 0);
  assert.equal(rows[0].safetyStock, 0);
  assert.equal(rows[0].gap, -5);
});
