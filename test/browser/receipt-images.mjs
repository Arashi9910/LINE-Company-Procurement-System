import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../../src/app.js';

const items = ['規格圖', '主圖替補', '缺圖'].map((name, index) => ({
  sku: `SKU-${index}`, displayName: `控制器｜${name}`, status: '已下單',
  orderedQuantity: 5, receivedQuantity: 1, outstandingQuantity: 4, unit: '件'
}));
const repository = {
  checkHealth: async () => ({}),
  getAuthorization: async () => ({ enabled: true, role: '到貨確認' }),
  getRequest: async () => ({ requestId: 'RQ-preview', applicant: '測試人員', items }),
  listProductImages: async () => [
    { sku: 'SKU-0', variantImageUrl: 'https://example.com/variant.svg' },
    { sku: 'SKU-1', variantImageUrl: 'https://example.com/missing.svg', mainImageUrl: 'https://example.com/main.svg' }
  ]
};
const app = createApp({ config: { liffId: 'local-test' }, repository,
  identityVerifier: { verify: async () => ({ userId: 'test' }) }, messenger: {} });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.route('https://static.line-scdn.net/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.liff = {
    init: async () => {}, isLoggedIn: () => true, getIDToken: () => 'test',
    getDecodedIDToken: () => ({ exp: Math.floor(Date.now()/1000)+3600 }), getProfile: async () => ({ displayName: '測試人員' })
  };` }));
  await context.route('https://example.com/**', route => route.request().url().includes('missing')
    ? route.fulfill({ status: 404, body: '' })
    : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#e8f5e9"/><rect x="50" y="70" width="140" height="100" rx="16" fill="#324047"/><circle cx="120" cy="120" r="25" fill="#85d5a0"/></svg>' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=receipt&requestId=RQ-preview`);
  const buttons = page.locator('.receipt-image-button');
  await buttons.nth(0).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.receipt-image img').length === 2
    && [...document.querySelectorAll('.receipt-image img')].every(img => img.complete && img.naturalWidth > 0));
  assert.equal(await buttons.count(), 3);
  assert.equal(await buttons.nth(2).isDisabled(), true);
  assert.match(await buttons.nth(1).locator('img').getAttribute('src'), /main.svg$/);
  await page.locator('.workflow-quantity').first().fill('2');
  await buttons.first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '關閉圖片' }).click();
  assert.equal(await page.locator('.workflow-quantity').first().inputValue(), '2');
  await buttons.first().click();
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/receipt-images-mobile.png', fullPage: true });
  console.log('PASS: mobile thumbnails, fallback, missing images, zoom, Escape, quantity preservation; no receipt submitted');
  items[0].status = '已完成';
  items[1].status = '取消';
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=detail&requestId=RQ-preview`);
  await buttons.first().waitFor();
  assert.equal(await buttons.count(), 3);
  assert.equal(await page.locator('.workflow-quantity').count(), 0);
  assert.equal(await page.locator('#workflow-submit').isVisible(), false);
  await buttons.first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '關閉圖片' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'artifacts/detail-images-mobile.png', fullPage: true });
  console.log('PASS: read-only details include completed/cancelled items, zoom, and no receiving controls');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
