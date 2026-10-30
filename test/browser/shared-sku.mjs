import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../../src/app.js';

const bindings = ['漸層版', '透明版'].map((name, i) => ({ productId: String(i + 1), productCode: `P-${i}`, productName: name, variantName: i ? '三入裝' : '雛菊積木收納盒', mainImageUrl: 'https://example.com/main.svg', variantImageUrl: `https://example.com/${i}.svg` }));
const repository = {
  checkHealth: async () => ({}),
  getAuthorization: async () => ({ enabled: true, role: '管理者' }),
  listAvailableSkus: async () => [{ sku: 'HA-GD-068', displayName: '展示盒', productName: '漸層版' }],
  listOpenRequests: async () => [],
  listProductImages: async () => [{ sku: 'HA-GD-068', productBindings: bindings }]
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: '選擇 透明版 的規格' }).click();
  await page.getByRole('button', { name: '三入裝 增加數量' }).click();
  await page.getByRole('button', { name: '關閉規格選擇' }).click();
  await page.getByRole('button', { name: '選擇 漸層版 的規格' }).click();
  assert.equal(await page.locator('.variant-row input').inputValue(), '1');
  await page.getByRole('button', { name: '雛菊積木收納盒 增加數量' }).click();
  await page.getByRole('button', { name: '關閉規格選擇' }).click();
  await page.getByRole('button', { name: '選擇 透明版 的規格' }).click();
  assert.equal(await page.locator('.variant-row input').inputValue(), '2');
  assert.equal(await page.locator('.cart-row').count(), 1);
  assert.match(await page.locator('#cart-summary').innerText(), /共 2 件/);
  assert.match(await page.locator('.variant-row img').getAttribute('src'), /1.svg$/);
  assert.deepEqual(errors, []);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/shared-sku-mobile.png', fullPage: true });
  console.log('PASS: both product groups share one cart quantity and show their own variant image');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
