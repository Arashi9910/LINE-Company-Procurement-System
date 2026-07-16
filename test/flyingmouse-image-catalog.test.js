import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  captureFlyingMouseProductList,
  normalizeProductListRows,
  validateImageCatalogCoverage
} from '../src/flyingmouse/image-catalog.js';

function raw(overrides = {}) {
  return {
    partHref: '/admin/part/edit/927',
    sku: 'SKU-A',
    productHref: '/admin/product/edit/206',
    productCode: '926404525493',
    productName: '測試商品',
    spec: '藍色 / 大',
    listImageUrl: 'https://img.fslol.com/10371/b/example.jpg',
    ...overrides
  };
}

test('normalizes variant, main, and default FlyingMouse image rows', () => {
  const rows = normalizeProductListRows([
    raw(),
    raw({
      partHref: '/admin/part/edit/912',
      sku: 'SKU-B',
      productHref: '/admin/product/edit/55',
      productCode: '918853915097',
      listImageUrl: 'https://img.fslol.com/pic/ss-select/918853915097/cover.jpg'
    }),
    raw({
      partHref: '/admin/part/edit/1',
      sku: 'SKU-C',
      productHref: '',
      productCode: '',
      listImageUrl: '/img/default-cover.jpg'
    })
  ], { capturedAt: new Date('2026-07-15T12:34:56.000Z') });

  assert.equal(rows[0].partId, '927');
  assert.equal(rows[0].imageType, '規格圖');
  assert.equal(rows[0].variantImageUrl, rows[0].listImageUrl);
  assert.equal(rows[0].mainImageUrl, 'https://img.fslol.com/pic/ss-select/926404525493/cover.jpg');
  assert.equal(rows[0].capturedAt, '2026-07-15 20:34:56');
  assert.equal(rows[1].imageType, '商品首圖');
  assert.equal(rows[1].variantImageUrl, '');
  assert.equal(rows[2].imageType, '預設圖');
  assert.equal(rows[2].imageStatus, '待補圖片');
  assert.equal(rows[0].bindingStatus, '已綁定銷售商品');
  assert.equal(rows[2].bindingStatus, '未綁定銷售商品');
});

test('keeps a variant image but marks an unbound product as missing its main image', () => {
  const [row] = normalizeProductListRows([
    raw({ productHref: '', productCode: '' })
  ]);
  assert.equal(row.variantImageUrl, row.listImageUrl);
  assert.equal(row.imageStatus, '待補主圖');
  assert.equal(row.bindingStatus, '未綁定銷售商品');
});

test('rejects duplicate image keys and incomplete product binding', () => {
  assert.throws(() => normalizeProductListRows([
    raw(),
    raw({ partHref: '/admin/part/edit/927', sku: 'SKU-B' })
  ]), /貨品 ID重複/);
  assert.throws(() => normalizeProductListRows([
    raw({ productHref: '', productCode: '926404525493' })
  ]), /銷售商品連結不完整/);
});

test('requires the DOM and official Excel to have the exact same SKU set', () => {
  const images = normalizeProductListRows([raw()]);
  assert.deepEqual(
    validateImageCatalogCoverage(images, [{ partNumber: 'SKU-A' }]),
    { sourceRows: 1, imageRows: 1 }
  );
  assert.throws(
    () => validateImageCatalogCoverage(images, [{ partNumber: 'SKU-B' }]),
    /SKU 不一致/
  );
});

test('captures a real FlyingMouse-style list whose page title is an h3', async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const authenticated = request.headers.cookie?.includes('auth=1');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/login-success') {
      response.writeHead(302, { Location: '/admin/dashboard', 'Set-Cookie': 'auth=1; Path=/; HttpOnly' });
      response.end();
      return;
    }
    if (!authenticated && url.pathname.startsWith('/admin/')) {
      response.writeHead(302, { Location: '/login' });
      response.end();
      return;
    }
    if (url.pathname === '/login') {
      response.end(`<!doctype html><form>
        <input name="username"><input name="password" type="password">
        <button type="button" onclick="location.href='/login-success'">登入</button>
      </form>`);
      return;
    }
    if (url.pathname === '/admin/dashboard') {
      response.end('<a href="/admin/dashboard">管理首頁</a>');
      return;
    }
    if (url.pathname === '/admin/part/list/*') {
      response.end(`<!doctype html><h3>庫存管理 &gt; 貨品列表</h3>
        <table class="table table-striped">
          <thead><tr>${[
            '貨品編號', '名稱 / 規格 / GTIN', '庫存量', '儲位',
            '對應 SKU', '銷售商品', '更新時間', ''
          ].map((header) => `<th>${header}</th>`).join('')}</tr></thead>
          <tbody><tr>
            <td><a href="/admin/part/edit/927">SKU-A</a></td>
            <td><img src="https://img.fslol.com/10371/a/example.jpg"><div style="padding-left:84px"><div><b>測試商品</b></div>藍色<br></div></td>
            <td>3</td><td></td><td><a href="/admin/item/edit/927">SKU-A</a></td>
            <td><a href="/admin/product/edit/206">926404525493</a></td><td></td><td></td>
          </tr></tbody>
        </table>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const result = await captureFlyingMouseProductList({
    config: {
      adminUrl: `${origin}/admin/dashboard`,
      productListUrl: `${origin}/admin/part/list/*`,
      username: 'tester',
      password: 'secret'
    },
    sourceItems: [{ partNumber: 'SKU-A' }],
    now: () => new Date('2026-07-15T12:34:56.000Z')
  });

  assert.equal(result.metadata.rowCount, 1);
  assert.equal(result.items[0].partId, '927');
  assert.equal(result.items[0].spec, '藍色');
});
