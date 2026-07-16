import { withAuthenticatedFlyingMousePage } from './exporter.js';

export const PRODUCT_LIST_HEADERS = Object.freeze([
  '貨品編號',
  '名稱 / 規格 / GTIN',
  '庫存量',
  '儲位',
  '對應 SKU',
  '銷售商品',
  '更新時間',
  ''
]);

const DEFAULT_IMAGE = '/img/default-cover.jpg';
const VARIANT_IMAGE = /^https:\/\/img\.fslol\.com\/10371\/.+\.(?:avif|gif|jpe?g|png|webp)(?:\?.*)?$/i;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function taipeiTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function productListUrl(value) {
  const url = new URL(value);
  url.hash = '{%22pageCode%22:1,%22pageSize%22:1000,%22appendQueryObj%22:{},%22sortFields%22:[%22create_time%22],%22order%22:%22DESC%22}';
  return url.toString();
}

function parseId(href, kind) {
  const match = String(href ?? '').match(new RegExp(`/admin/${kind}/edit/(\\d+)(?:$|[?#])`));
  return match?.[1] ?? '';
}

function ensureUnique(items, field, label) {
  const seen = new Map();
  for (const [index, item] of items.entries()) {
    const value = normalizeText(item[field]);
    if (!value) throw new Error(`飛鼠貨品列表第 ${index + 1} 筆缺少${label}`);
    if (seen.has(value)) {
      throw new Error(`飛鼠貨品列表${label}重複：${value}（第 ${seen.get(value)}、${index + 1} 筆）`);
    }
    seen.set(value, index + 1);
  }
}

export function normalizeProductListRows(rawRows, { capturedAt = new Date() } = {}) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('飛鼠貨品列表沒有可同步的資料');
  }
  const timestamp = taipeiTimestamp(capturedAt);
  const items = rawRows.map((raw, index) => {
    const partId = parseId(raw.partHref, 'part');
    const sku = normalizeText(raw.sku);
    const productId = parseId(raw.productHref, 'product');
    const productCode = normalizeText(raw.productCode);
    const productName = normalizeText(raw.productName);
    const spec = normalizeText(raw.spec);
    const listImageUrl = String(raw.listImageUrl ?? '').trim();
    if (!partId || !sku || !productName || !listImageUrl) {
      throw new Error(`飛鼠貨品列表第 ${index + 1} 筆 DOM 欄位不完整`);
    }
    if ((productId && !productCode) || (!productId && productCode)) {
      throw new Error(`飛鼠貨品 ${sku} 的銷售商品連結不完整`);
    }
    const mainImageUrl = productCode
      ? `https://img.fslol.com/pic/ss-select/${encodeURIComponent(productCode)}/cover.jpg`
      : '';
    const variantImageUrl = VARIANT_IMAGE.test(listImageUrl) ? listImageUrl : '';
    const isDefault = listImageUrl === DEFAULT_IMAGE || /\/img\/default-cover\.jpg(?:\?.*)?$/i.test(listImageUrl);
    return Object.freeze({
      partId,
      sku,
      productId,
      productCode,
      productName,
      spec,
      mainImageUrl,
      variantImageUrl,
      listImageUrl,
      imageType: variantImageUrl ? '規格圖' : (isDefault ? '預設圖' : '商品首圖'),
      imageStatus: isDefault ? '待補圖片' : (mainImageUrl ? '正常' : '待補主圖'),
      bindingStatus: productId ? '已綁定銷售商品' : '未綁定銷售商品',
      source: '飛鼠貨品列表',
      capturedAt: timestamp
    });
  });
  ensureUnique(items, 'partId', '貨品 ID');
  ensureUnique(items, 'sku', ' SKU');
  return Object.freeze(items);
}

export function validateImageCatalogCoverage(imageItems, sourceItems) {
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    throw new Error('官方 Excel 沒有可供圖片同步核對的 SKU');
  }
  const sourceSkus = new Set();
  for (const item of sourceItems) {
    const sku = normalizeText(item.partNumber);
    if (!sku) throw new Error('官方 Excel 含有空白 SKU');
    if (sourceSkus.has(sku)) throw new Error(`官方 Excel SKU 重複：${sku}`);
    sourceSkus.add(sku);
  }
  const imageSkus = new Set(imageItems.map((item) => normalizeText(item.sku)));
  const missingInPage = [...sourceSkus].filter((sku) => !imageSkus.has(sku));
  const missingInExcel = [...imageSkus].filter((sku) => !sourceSkus.has(sku));
  if (missingInPage.length || missingInExcel.length || imageItems.length !== sourceItems.length) {
    throw new Error(
      `飛鼠圖片列表與官方 Excel SKU 不一致：頁面缺 ${missingInPage.length}、Excel 缺 ${missingInExcel.length}`
    );
  }
  return Object.freeze({ sourceRows: sourceItems.length, imageRows: imageItems.length });
}

async function captureRows(page, config, timeoutMs) {
  await page.goto(productListUrl(config.productListUrl), {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });
  const pathname = new URL(page.url()).pathname;
  if (pathname !== '/admin/part/list/*') {
    throw new Error(`飛鼠貨品列表導向非預期路徑：${pathname}`);
  }
  const heading = page.locator('h1,h2,h3').filter({ hasText: '庫存管理 > 貨品列表' });
  await heading.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  if (await heading.count() !== 1) throw new Error('飛鼠貨品列表標題不符合預期');

  const table = page.locator('table.table-striped');
  await table.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  if (await table.count() !== 1) throw new Error('飛鼠貨品列表資料表數量不符合預期');
  const headers = (await table.locator('thead th').allTextContents()).map(normalizeText);
  if (
    headers.length !== PRODUCT_LIST_HEADERS.length ||
    headers.some((header, index) => header !== PRODUCT_LIST_HEADERS[index])
  ) {
    throw new Error(`飛鼠貨品列表表頭已變更：${headers.join('｜')}`);
  }

  const rows = table.locator('tbody tr');
  await rows.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  return rows.evaluateAll((elements) => elements.map((row) => {
    const cells = Array.from(row.querySelectorAll(':scope > td'));
    const partLink = cells[0]?.querySelector('a[href*="/admin/part/edit/"]');
    const productLink = cells[5]?.querySelector('a[href*="/admin/product/edit/"]');
    const details = cells[1]?.querySelector('div[style*="padding-left"]') ?? cells[1];
    const name = details?.querySelector('b');
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const productName = normalize(name?.textContent);
    const detailsText = normalize(details?.textContent);
    const spec = detailsText.startsWith(productName)
      ? normalize(detailsText.slice(productName.length))
      : '';
    return {
      partHref: partLink?.getAttribute('href') ?? '',
      sku: normalize(partLink?.textContent),
      productHref: productLink?.getAttribute('href') ?? '',
      productCode: normalize(productLink?.textContent),
      productName,
      spec,
      listImageUrl: cells[1]?.querySelector('img')?.getAttribute('src') ?? ''
    };
  }));
}

export async function captureFlyingMouseProductList({
  config,
  sourceItems,
  headless = true,
  timeoutMs = 45_000,
  now = () => new Date(),
  launch
}) {
  const items = await withAuthenticatedFlyingMousePage({
    config,
    headless,
    timeoutMs,
    ...(launch ? { launch } : {})
  }, async (page) => normalizeProductListRows(
    await captureRows(page, config, timeoutMs),
    { capturedAt: now() }
  ));
  const coverage = validateImageCatalogCoverage(items, sourceItems);
  return Object.freeze({
    metadata: Object.freeze({
      source: '飛鼠貨品列表',
      rowCount: items.length,
      pageSize: 1000,
      ...coverage
    }),
    items
  });
}
