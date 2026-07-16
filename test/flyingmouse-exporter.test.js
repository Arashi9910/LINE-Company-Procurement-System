import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportFlyingMouseWorkbook, isOfficialFlyingMouseDownloadName } from '../src/flyingmouse/exporter.js';

function page(body) {
  return `<!doctype html><html lang="zh-TW"><body>${body}</body></html>`;
}

function sendHtml(response, body) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(page(body));
}

async function startFakeFlyingMouse(t) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const authenticated = request.headers.cookie?.includes('auth=1');
    if (url.pathname === '/login-success') {
      response.writeHead(302, { Location: '/admin/dashboard', 'Set-Cookie': 'auth=1; Path=/; HttpOnly' });
      response.end();
      return;
    }
    if (url.pathname === '/login' || (!authenticated && url.pathname.startsWith('/admin/'))) {
      if (url.pathname !== '/login') {
        response.writeHead(302, { Location: '/login' });
        response.end();
        return;
      }
      sendHtml(response, `
        <form>
          <label>帳號 <input name="username" autocomplete="username"></label>
          <label>密碼 <input name="password" type="password"></label>
          <button type="button" onclick="setTimeout(() => location.href='/login-success', 150)">登入</button>
        </form>
      `);
      return;
    }
    if (url.pathname === '/admin/dashboard') {
      sendHtml(response, '<a href="/admin/dashboard">商店總覽</a><h1>商店總覽</h1>');
      return;
    }
    if (url.pathname === '/admin/part/list/*') {
      sendHtml(response, `
        <main id="app"></main>
        <script>
          setTimeout(() => {
            document.querySelector('#app').innerHTML = [
              '<h1>庫存管理 &gt; 貨品列表</h1>',
              '<button onclick="document.querySelector(\\'#menu\\').hidden=false">匯出</button>',
              '<a id="menu" hidden href="/export.xlsx">貨品資料 Excel 匯出</a>'
            ].join('');
          }, 150);
        </script>
      `);
      return;
    }
    if (url.pathname === '/export.xlsx') {
      response.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="ss-select_Part-List_2026-07-15.xlsx"'
      });
      response.end(Buffer.from('fake-xlsx'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('exportFlyingMouseWorkbook logs in and saves only the official download', async (t) => {
  const origin = await startFakeFlyingMouse(t);
  const directory = await mkdtemp(join(tmpdir(), 'flyingmouse-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await exportFlyingMouseWorkbook({
    config: {
      adminUrl: `${origin}/admin/dashboard`,
      productListUrl: `${origin}/admin/part/list/*`,
      username: 'tester',
      password: 'secret'
    },
    downloadDir: directory,
    now: () => new Date('2026-07-15T10:20:30.000Z')
  });

  assert.match(result, /ss-select_Part-List_2026-07-15_20260715T102030Z\.xlsx$/);
  assert.equal((await readFile(result, 'utf8')), 'fake-xlsx');
});

test('isOfficialFlyingMouseDownloadName rejects unrelated files', () => {
  assert.equal(isOfficialFlyingMouseDownloadName('ss-select_Part-List_2026-07-15.xlsx'), true);
  assert.equal(isOfficialFlyingMouseDownloadName('inventory.csv'), false);
  assert.equal(isOfficialFlyingMouseDownloadName('Product-SKU_2026-07-15.xlsx'), false);
});
