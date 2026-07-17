import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cartTotals,
  filterCatalog,
  groupCatalog,
  selectableCatalogItems,
  variantLabel,
  visibleVariants
} from '../public/catalog.js';

const items = [
  {
    sku: 'SKU-RED', productCode: 'SALE-1', productName: '旅行收納袋', variantName: '紅色',
    displayName: '旅行收納袋－紅色', mainImageUrl: 'https://img.example/main.jpg',
    variantImageUrl: 'https://img.example/red.jpg', openCount: 2
  },
  {
    sku: 'SKU-BLUE', productCode: 'SALE-1', productName: '旅行收納袋', spec1: '藍色',
    displayName: '旅行收納袋－藍色', variantImageUrl: 'javascript:alert(1)', openCount: 0
  },
  {
    sku: 'SKU-CUP', productCode: '', productName: '隨行杯', variantName: '', spec1: '500ml',
    displayName: '隨行杯 500ml', listImageUrl: 'https://img.example/cup.jpg', openCount: 1
  }
];

test('groupCatalog groups variants by product code and keeps safe image fallbacks', () => {
  const groups = groupCatalog(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].openCount, 2);
  assert.deepEqual(groups[0].imageUrls, [
    'https://img.example/main.jpg',
    'https://img.example/red.jpg'
  ]);
  assert.equal(groups[1].key, 'name:隨行杯');
});

test('filterCatalog finds a group through SKU without hiding sibling variants', () => {
  const groups = groupCatalog(items);
  const matches = filterCatalog(groups, 'SKU-BLUE');
  assert.equal(matches.length, 1);
  assert.deepEqual(visibleVariants(matches[0]).map((item) => item.sku), ['SKU-RED', 'SKU-BLUE']);
});

test('variantLabel and cartTotals provide stable UI values', () => {
  assert.equal(variantLabel(items[0]), '紅色');
  assert.equal(variantLabel(items[1]), '藍色');
  assert.deepEqual(cartTotals([{ quantity: 2 }, { quantity: 5 }]), { variants: 2, quantity: 7 });
});

test('selectableCatalogItems excludes SKUs already present in an order', () => {
  const result = selectableCatalogItems(items, new Set(['SKU-RED', 'SKU-CUP']));
  assert.deepEqual(result.map((item) => item.sku), ['SKU-BLUE']);
});

