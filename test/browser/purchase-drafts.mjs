import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../../src/app.js';
import { purchaseFixture } from '../helpers/purchase-fixture.js';

const f = purchaseFixture();
let pushes = 0;
const app = createApp({ config: { purchaseDraftsEnabled: true, liffId: 'local-test' }, repository: f.repository,
  identityVerifier: { verify: async () => ({ userId: 'boss', displayName: '老闆' }) },
  messenger: { pushOrderConfirmed: async () => { pushes += 1; } } });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  await context.route('https://static.line-scdn.net/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.liff = {
    init: async () => {}, isLoggedIn: () => true, getIDToken: () => 'boss',
    getDecodedIDToken: () => ({ exp: Math.floor(Date.now()/1000)+3600 }), getProfile: async () => ({ displayName: '老闆' }), isInClient: () => false
  };` }));
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.locator('#purchase-open').click();
  await page.locator('input[value="RQ-1"]').check();
  await page.locator('input[value="RQ-2"]').check();
  await page.getByRole('button', { name: '將勾選需求合併成草稿' }).click();
  await page.locator('#purchase-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cart .quantity-input').first().inputValue(), '5');
  await page.locator('#note').fill('手機驗收草稿');
  await page.locator('#purchase-date').fill('2026-10-02');
  await page.locator('#cart .quantity-input').first().fill('8');
  await page.locator('#cart .quantity-input').first().blur();
  await page.locator('#purchase-save').click();
  await page.getByText('草稿已儲存，關閉 LINE 後可再開啟繼續', { exact: true }).waitFor();
  assert.equal(pushes, 0);
  await page.close();
  const reopened = await context.newPage();
  reopened.on('pageerror', error => errors.push(error.message));
  reopened.on('dialog', dialog => dialog.accept());
  await reopened.goto(base);
  await reopened.locator('#purchase-open').click();
  await reopened.getByRole('button', { name: /手機驗收草稿/ }).click();
  await reopened.locator('#purchase-editor').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('#cart .quantity-input').first().inputValue(), '8');
  assert.equal(await reopened.locator('#note').inputValue(), '手機驗收草稿');
  f.cells['SKU主檔'][1][7] = '商品 A 已更新';
  f.cells['SKU主檔'][2][9] = '否';
  f.cells['SKU主檔'].push(['C', '新品 C', '', '', '', '', '', '新品 C', '', '是']);
  await reopened.locator('#purchase-refresh').click();
  await reopened.getByText('商品清單已更新，已選數量與備註保留', { exact: true }).waitFor();
  assert.equal(await reopened.locator('#cart .quantity-input').first().inputValue(), '8');
  await reopened.getByText('商品已停用或不存在：請移除並重新選擇，才可正式送出', { exact: true }).waitFor();
  await reopened.locator('#cart .cart-row').last().getByRole('button', { name: '移除', exact: true }).click();
  await reopened.locator('#search').fill('新品');
  await reopened.locator('#results button').first().click();
  await reopened.locator('#variant-items .quantity-input').fill('2');
  await reopened.locator('#variant-items .quantity-input').blur();
  await reopened.locator('#variant-done').click();
  await reopened.locator('#purchase-save').click();
  await reopened.getByText('草稿已儲存，關閉 LINE 後可再開啟繼續', { exact: true }).waitFor();
  assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mkdir('artifacts/purchase-drafts', { recursive: true });
  await reopened.screenshot({ path: 'artifacts/purchase-drafts/mobile-draft.png', fullPage: true });
  await reopened.locator('#submit').click();
  await reopened.locator('#status').filter({ hasText: '已建立採購單' }).waitFor();
  assert.equal(pushes, 1);
  assert.equal(f.cells['補貨追蹤'][1][6], '已轉單');
  assert.deepEqual(f.cells['補貨追蹤'].slice(4).map(row => [row[13], row[7]]), [['A', 8], ['C', 2]]);
  f.cells['SKU主檔'][2][9] = '是';
  f.source('RQ-3', 'B', 2);
  await reopened.goto(`${base}/?mode=order&requestId=RQ-3`);
  await reopened.locator('.workflow-quantity').fill('9');
  await reopened.locator('#workflow-date').fill('2026-10-03');
  await reopened.locator('#purchase-create').click();
  await reopened.locator('#purchase-editor').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('#cart .quantity-input').inputValue(), '9');
  assert.equal(await reopened.locator('#purchase-date').inputValue(), '2026-10-03');
  await reopened.locator('#note').fill('儲存失敗後重試');
  f.failNext();
  await reopened.locator('#purchase-save').click();
  await reopened.locator('#status').filter({ hasText: '系統暫時無法處理' }).waitFor();
  assert.match(await reopened.locator('#purchase-save-status').textContent(), /尚未儲存/);
  assert.equal(await reopened.locator('#cart .quantity-input').inputValue(), '9');
  await reopened.locator('#purchase-save').click();
  await reopened.getByText('草稿已儲存，關閉 LINE 後可再開啟繼續', { exact: true }).waitFor();
  assert.equal(pushes, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile merge, save, close/reopen, catalog refresh, unavailable SKU, add new SKU, submit, edited order conversion, failed save retry and notification');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
