import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductListRows, normalizeProductDetail, mergeProductDetails } from '../src/flyingmouse/image-catalog.js';
import { syncProductImages, PRODUCT_IMAGE_HEADERS } from '../src/flyingmouse/sheets-operational.js';
import { SheetsRepository } from '../src/sheets/repository.js';
import { listSearchableSkus } from '../src/services/requests.js';
import { groupCatalog, filterCatalog, cartTotals } from '../public/catalog.js';

function sharedItem() {
  const [item] = normalizeProductListRows([{
    partHref: '/admin/part/edit/20', sku: 'HA-GD-068',
    productHref: '/admin/product/edit/6', productCode: 'HA-GD',
    productLinks: [{ href: '/admin/product/edit/6', code: 'HA-GD' }, { href: '/admin/product/edit/41', code: '000041' }],
    productName: '漸層版', spec: '雛菊積木收納盒', listImageUrl: 'https://img.fslol.com/10371/a/old.jpg'
  }]);
  const details = [['6', 'HA-GD', '漸層版', '雛菊積木收納盒'], ['41', '000041', '透明版', '三入裝']].map(([id, code, name, specY]) => normalizeProductDetail({ code: 0, product: {
    id, code, name, spec: [{ sku: item.sku, specY, item_cover: { url: `https://img.fslol.com/10371/a/${id}.jpg` } }]
  } }, id));
  return { item, details };
}

test('shared SKU survives capture, sheet sync, API and both catalog groups without duplicating stock identity', async () => {
  const { item, details } = sharedItem();
  assert.throws(() => mergeProductDetails([item], details.slice(0, 1)), /綁定不完整/);
  const [merged] = mergeProductDetails([item], details);
  let columns = 15;
  let rows = [PRODUCT_IMAGE_HEADERS.slice(0, 15)];
  let structuralWrites = 0;
  const sheets = { spreadsheets: {
    async get() { return { data: { sheets: [{ properties: { sheetId: 1, title: '商品圖片對照', gridProperties: { rowCount: 10, columnCount: columns } } }] } }; },
    async batchUpdate({ requestBody }) { structuralWrites++; columns += requestBody.requests[0].appendDimension.length; return { data: {} }; },
    values: {
      async batchGet() { return { data: { valueRanges: [{ values: rows }, { values: [['SKU'], [item.sku]] }] } }; },
      async batchUpdate({ requestBody }) {
        for (const entry of requestBody.data) {
          if (entry.range.endsWith('P1')) rows[0][15] = entry.values[0][0];
          else rows[1] = entry.values[0];
        }
        return { data: {} };
      },
      async get() { return { data: { values: rows.slice(1) } }; }
    }
  } };
  await syncProductImages({ sheets, spreadsheetId: 'test', imageItems: [merged], dryRun: true });
  assert.equal(structuralWrites, 0);
  assert.equal(rows.length, 1);
  await syncProductImages({ sheets, spreadsheetId: 'test', imageItems: [merged] });
  assert.equal(columns, 16);
  assert.equal(rows.length, 2);
  assert.equal((await syncProductImages({ sheets, spreadsheetId: 'test', imageItems: [merged] })).unchanged, 1);
  assert.equal(structuralWrites, 1);
  const repository = new SheetsRepository({ sheets, spreadsheetId: 'test' });
  const catalog = await listSearchableSkus({
    listAvailableSkus: async () => [{ sku: item.sku, stock: 8 }],
    listOpenRequests: async () => [{ sku: item.sku }],
    listProductImages: () => repository.listProductImages()
  });
  assert.equal(catalog.length, 1);
  const groups = groupCatalog(catalog);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.items[0].variantName), ['雛菊積木收納盒', '三入裝']);
  assert.equal(filterCatalog(groups, '三入裝')[0].productCode, '000041');
  assert.equal(groups[1].items[0].variantImageUrl, 'https://img.fslol.com/10371/a/41.jpg');
  const cart = new Map();
  for (const group of groups) cart.set(group.items[0].sku, { quantity: 3 });
  assert.deepEqual(cartTotals(cart.values()), { variants: 1, quantity: 3 });
  assert.ok(groups.every(g => g.items[0].stock === 8 && g.openCount === 1));
});

test('repository falls back to the legacy 15-column sheet before migration', async () => {
  const ranges = [];
  const repository = new SheetsRepository({ spreadsheetId: 'test', sheets: { spreadsheets: { values: {
    async get({ range }) {
      ranges.push(range);
      if (range.endsWith(':P')) throw Object.assign(new Error('out of bounds'), { code: 400 });
      return { data: { values: [['20', 'HA-GD-068', '6', 'HA-GD', '漸層版']] } };
    }
  } } } });
  assert.equal((await repository.listProductImages())[0].sku, 'HA-GD-068');
  assert.deepEqual(ranges, ["'商品圖片對照'!A2:P", "'商品圖片對照'!A2:O"]);
});
