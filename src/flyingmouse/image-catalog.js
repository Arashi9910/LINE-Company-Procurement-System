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
const PRODUCT_LIST_PAGE_SIZE = 1000;
const MAX_PRODUCT_LIST_PAGES = 100;
const PRODUCT_DETAIL_CONCURRENCY = 8;

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

function productListUrl(value, pageCode) {
  const url = new URL(value);
  url.hash = `{%22pageCode%22:${pageCode},%22pageSize%22:${PRODUCT_LIST_PAGE_SIZE},%22appendQueryObj%22:{},%22sortFields%22:[%22create_time%22],%22order%22:%22DESC%22}`;
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

function imageFields({ mainImageUrl, listImageUrl, variantImageUrl }) {
  const resolvedVariantImageUrl = variantImageUrl === undefined
    ? (VARIANT_IMAGE.test(listImageUrl) ? listImageUrl : '')
    : variantImageUrl;
  const isDefault = listImageUrl === DEFAULT_IMAGE || /\/img\/default-cover\.jpg(?:\?.*)?$/i.test(listImageUrl);
  return Object.freeze({
    variantImageUrl: resolvedVariantImageUrl,
    listImageUrl,
    imageType: resolvedVariantImageUrl ? '規格圖' : (isDefault ? '預設圖' : '商品首圖'),
    imageStatus: isDefault ? '待補圖片' : (mainImageUrl ? '正常' : '待補主圖')
  });
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
    const productBindings = (raw.productLinks ?? (raw.productHref ? [{ href: raw.productHref, code: raw.productCode }] : []))
      .map((link) => ({ productId: parseId(link.href, 'product'), productCode: normalizeText(link.code) }));
    if (productBindings.some((binding) => !binding.productId || !binding.productCode)) {
      throw new Error(`飛鼠貨品 ${sku} 的銷售商品連結不完整`);
    }
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
    return Object.freeze({
      partId,
      sku,
      productId,
      productCode,
      productBindings,
      productName,
      spec,
      sourceSpec: spec,
      sourceImageUrl: listImageUrl,
      mainImageUrl,
      ...imageFields({ mainImageUrl, listImageUrl }),
      bindingStatus: productId ? '已綁定銷售商品' : '未綁定銷售商品',
      source: '飛鼠貨品列表',
      capturedAt: timestamp
    });
  });
  ensureUnique(items, 'partId', '貨品 ID');
  ensureUnique(items, 'sku', ' SKU');
  return Object.freeze(items);
}

export function normalizeProductDetail(payload, expectedProductId) {
  const productId = normalizeText(expectedProductId);
  const product = payload?.product;
  if (Number(payload?.code) !== 0 || !product || typeof product !== 'object') {
    throw new Error(`飛鼠銷售商品 ${productId} API 回傳失敗`);
  }
  if (normalizeText(product.id) !== productId) {
    throw new Error(`飛鼠銷售商品 ${productId} API 回傳錯誤商品`);
  }
  const productCode = normalizeText(product.code);
  const productName = normalizeText(product.name);
  if (!productCode || !productName || !Array.isArray(product.spec) || product.spec.length === 0) {
    throw new Error(`飛鼠銷售商品 ${productId} API 欄位不完整`);
  }
  const mainImageUrl = `https://img.fslol.com/pic/ss-select/${encodeURIComponent(productCode)}/cover.jpg`;
  const returnedMainImageUrl = String(product.coverUrl ?? '').trim();
  if (returnedMainImageUrl && returnedMainImageUrl !== mainImageUrl) {
    throw new Error(`飛鼠銷售商品 ${productId} 的商品首圖網址不符合預期`);
  }

  const specs = product.spec.map((raw, index) => {
    const sku = normalizeText(raw?.sku);
    if (!sku) throw new Error(`飛鼠銷售商品 ${productId} 第 ${index + 1} 個規格缺少 SKU`);
    const spec = [raw?.specY, raw?.specX].map(normalizeText).filter(Boolean).join(' / ');
    const itemImageUrl = String(raw?.item_cover?.url ?? '').trim();
    const variantImageUrl = itemImageUrl === mainImageUrl ? '' : itemImageUrl;
    if (variantImageUrl && !VARIANT_IMAGE.test(variantImageUrl)) {
      throw new Error(`飛鼠銷售商品 ${productId} SKU ${sku} 的規格圖網址不符合預期`);
    }
    return Object.freeze({ sku, spec, variantImageUrl });
  });
  ensureUnique(specs, 'sku', `銷售商品 ${productId} 規格 SKU`);
  return Object.freeze({
    productId,
    productCode,
    productName,
    mainImageUrl,
    specs: Object.freeze(specs)
  });
}

export function mergeProductDetails(items, productDetails) {
  const detailsById = new Map();
  for (const detail of productDetails ?? []) {
    if (detailsById.has(detail.productId)) {
      throw new Error(`飛鼠銷售商品 ID 重複：${detail.productId}`);
    }
    detailsById.set(detail.productId, detail);
  }

  return Object.freeze(items.map((item) => {
    if (!item.productId) return item;
    const detail = detailsById.get(item.productId);
    if (!detail) throw new Error(`飛鼠貨品 ${item.sku} 缺少銷售商品 ${item.productId} 資料`);
    if (detail.productCode !== item.productCode) {
      throw new Error(`飛鼠貨品 ${item.sku} 的銷售商品編號不一致`);
    }
    if (detail.mainImageUrl !== item.mainImageUrl) {
      throw new Error(`飛鼠貨品 ${item.sku} 的商品首圖網址不一致`);
    }
    const detailSpec = detail.specs.find((candidate) => candidate.sku === item.sku);
    if (!detailSpec) {
      throw new Error(`飛鼠銷售商品 ${item.productId} 找不到 SKU ${item.sku}`);
    }
    const productBindings = (item.productBindings ?? [item]).map((binding) => {
      const boundDetail = detailsById.get(binding.productId);
      const boundSpec = boundDetail?.specs.find((candidate) => candidate.sku === item.sku);
      if (!boundSpec || boundDetail.productCode !== binding.productCode) {
        throw new Error(`飛鼠貨品 ${item.sku} 的銷售商品 ${binding.productId} 綁定不完整`);
      }
      return {
        productId: boundDetail.productId,
        productCode: boundDetail.productCode,
        productName: boundDetail.productName,
        variantName: boundSpec.spec || item.spec,
        mainImageUrl: boundDetail.mainImageUrl,
        variantImageUrl: boundSpec.variantImageUrl
      };
    });
    return Object.freeze({
      ...item,
      productBindings,
      productName: detail.productName,
      spec: detailSpec.spec || item.spec,
      ...imageFields({
        mainImageUrl: item.mainImageUrl,
        listImageUrl: item.listImageUrl,
        variantImageUrl: detailSpec.variantImageUrl
      })
    });
  }));
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

async function capturePageRows(page, config, timeoutMs, pageCode) {
  await page.goto(productListUrl(config.productListUrl, pageCode), {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });
  // A hash-only navigation can leave the previous page rendered. A reload makes
  // the FlyingMouse app apply the requested page before we inspect the table.
  if (pageCode > 1) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }
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
    const productLinks = Array.from(cells[5]?.querySelectorAll('a[href*="/admin/product/edit/"]') ?? [])
      .map((link) => ({ href: link.getAttribute('href'), code: link.textContent }));
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
      productLinks,
      productCode: normalize(productLink?.textContent),
      productName,
      spec,
      listImageUrl: cells[1]?.querySelector('img')?.getAttribute('src') ?? ''
    };
  }));
}

async function captureAllRows(page, config, timeoutMs) {
  const captured = [];
  const seenSkus = new Set();
  for (let pageCode = 1; pageCode <= MAX_PRODUCT_LIST_PAGES; pageCode += 1) {
    const pageRows = await capturePageRows(page, config, timeoutMs, pageCode);
    if (pageRows.length === 0) {
      return Object.freeze({ rows: captured, pageCount: pageCode - 1 });
    }
    for (const row of pageRows) {
      const sku = normalizeText(row.sku);
      if (sku && seenSkus.has(sku)) {
        throw new Error(`飛鼠貨品列表分頁重複 SKU：${sku}`);
      }
      if (sku) seenSkus.add(sku);
    }
    captured.push(...pageRows);
    if (pageRows.length < PRODUCT_LIST_PAGE_SIZE) {
      return Object.freeze({ rows: captured, pageCount: pageCode });
    }
  }
  throw new Error(`飛鼠貨品列表超過 ${MAX_PRODUCT_LIST_PAGES} 頁，停止同步`);
}

async function concurrentMap(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

async function captureProductDetails(page, config, items, timeoutMs) {
  const productIds = [...new Set(items.flatMap((item) => (item.productBindings ?? [item]).map((binding) => binding.productId)).filter(Boolean))];
  return concurrentMap(productIds, PRODUCT_DETAIL_CONCURRENCY, async (productId) => {
    const url = new URL(`/api/admin/product/${encodeURIComponent(productId)}`, config.adminUrl);
    const response = await page.request.get(url.toString(), {
      timeout: timeoutMs,
      failOnStatusCode: false,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!response.ok()) {
      throw new Error(`飛鼠銷售商品 ${productId} API 回傳 HTTP ${response.status()}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`飛鼠銷售商品 ${productId} API 回傳格式錯誤`);
    }
    return normalizeProductDetail(payload, productId);
  });
}

export async function captureFlyingMouseProductList({
  config,
  sourceItems,
  headless = true,
  timeoutMs = 45_000,
  now = () => new Date(),
  launch
}) {
  const captured = await withAuthenticatedFlyingMousePage({
    config,
    headless,
    timeoutMs,
    ...(launch ? { launch } : {})
  }, async (page) => {
    const pages = await captureAllRows(page, config, timeoutMs);
    const listItems = normalizeProductListRows(pages.rows, { capturedAt: now() });
    const productDetails = await captureProductDetails(page, config, listItems, timeoutMs);
    return Object.freeze({
      items: mergeProductDetails(listItems, productDetails),
      pageCount: pages.pageCount,
      productCount: productDetails.length
    });
  });
  const { items } = captured;
  const coverage = validateImageCatalogCoverage(items, sourceItems);
  return Object.freeze({
    metadata: Object.freeze({
      source: '飛鼠貨品列表',
      rowCount: items.length,
      pageSize: PRODUCT_LIST_PAGE_SIZE,
      pageCount: captured.pageCount,
      productCount: captured.productCount,
      ...coverage
    }),
    items
  });
}
